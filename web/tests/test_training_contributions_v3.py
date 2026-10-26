"""Synthetic protocol-v3 inbox tests. No public requests or training runs."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "training_contributions_v3_under_test", ROOT / "web/web后端/training_contributions.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(script, options=None):
    command = ["node", str(ROOT / f"web/web前端/tests/fixtures/{script}")]
    if options is not None:
        command.append(json.dumps(options))
    return json.loads(subprocess.check_output(command))


class ContributionV3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v1 = fixture("create-training-fixture.mjs")
        cls.v2 = fixture("create-training-v2-fixture.mjs", {
            "playerCount": 3, "startingPointMode": "random", "undoUsedCount": 1,
            "profile": "three-player-policy-v2",
        })
        cls.v3_pass = fixture("create-training-v3-fixture.mjs", {
            "playerCount": 15, "boardShape": "triangle", "gridSize": 15, "startingPointMode": "random",
            "undoUsedCount": 1, "profile": "multiplayer-hard-v1",
        })
        cls.v3_resign = fixture("create-training-v3-fixture.mjs", {
            "playerCount": 7, "boardShape": "hexagon", "gridSize": 15, "startingPointMode": "custom",
            "terminalMode": "resign",
        })

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = module.ContributionStore(self.temporary.name)
        app = FastAPI()
        app.include_router(module.create_router(self.store))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_status_advertises_independent_protocol_and_rule_capabilities(self):
        response = self.client.get("/api/training/contributions/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["supported_versions"], [1, 2, 3])
        self.assertEqual(data["consent_policy"], "anonymous-replay-training-v1")
        self.assertEqual(data["consent_policies"], {
            "1": "anonymous-replay-training-v1",
            "2": "anonymous-replay-training-v2",
            "3": "anonymous-replay-training-v3",
        })
        self.assertEqual(data["supported_rules_versions"], {
            "2": ["territory-v2"], "3": ["territory-v3"],
        })
        self.assertEqual(data["max_actions"], {"1": 512, "2": 3000, "3": 3000})
        self.assertEqual(data["destination"], "awaiting_review")

    def test_v1_v2_v3_tables_and_exports_remain_isolated(self):
        receipts = [self.store.accept(payload) for payload in (self.v1, self.v2, self.v3_pass)]
        self.assertEqual([receipt["status"] for receipt in receipts], ["awaiting_review"] * 3)
        # Frozen production-v2 baseline receipts: protocol v3 must not change
        # either historical namespace or canonical gameplay identity.
        self.assertEqual(receipts[0]["game_id"], "efb1338e9524cdce1901cd833b557632fcf3b8d1dacdce2bc809c9ecccbc20c1")
        self.assertEqual(receipts[1]["game_id"], "225e4328596c1a055df01317ab1354689e4dd897e2eaf7c4adebddf2884d8c2d")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v2").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v3").fetchone()[0], 1)
        legacy = Path(self.temporary.name) / "legacy"
        v2 = Path(self.temporary.name) / "v2"
        v3 = Path(self.temporary.name) / "v3"
        self.assertEqual(self.store.export(legacy), 1)
        self.assertEqual(self.store.export(v2, version=2), 1)
        self.assertEqual(self.store.export(v3, version=3), 1)
        self.assertNotIn("protocol_version", json.loads(next(legacy.glob("*.json")).read_text(encoding="utf-8")))
        self.assertEqual(json.loads(next(v2.glob("*.json")).read_text(encoding="utf-8"))["protocol_version"], 2)
        self.assertEqual(json.loads(next(v3.glob("*.json")).read_text(encoding="utf-8"))["protocol_version"], 3)

    def test_existing_v1_v2_database_is_extended_without_rewriting_rows(self):
        self.store.accept(self.v1)
        self.store.accept(self.v2)
        with self.store.connect() as db:
            before = {
                table: db.execute(f"SELECT game_id, document, received_at FROM {table}").fetchall()
                for table in ("inbox", "inbox_v2")
            }
        restarted = module.ContributionStore(self.temporary.name)
        restarted.accept(self.v3_resign)
        with restarted.connect() as db:
            after = {
                table: db.execute(f"SELECT game_id, document, received_at FROM {table}").fetchall()
                for table in ("inbox", "inbox_v2")
            }
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v3").fetchone()[0], 1)
        self.assertEqual(after, before)

    def test_pass_resign_full_terminal_state_and_dedup(self):
        for payload, reason, action_type in (
            (self.v3_pass, "all_remaining_players_skipped", "skip"),
            (self.v3_resign, "resignation", "resign"),
        ):
            with self.subTest(reason=reason):
                receipt = self.store.accept(payload)
                self.assertEqual(receipt["status"], "awaiting_review")
                duplicate = module.ContributionStore(self.temporary.name).accept(payload)
                self.assertEqual(duplicate, {"game_id": receipt["game_id"], "status": "duplicate"})
                with self.store.connect() as db:
                    raw = db.execute("SELECT document FROM inbox_v3 WHERE game_id=?", (receipt["game_id"],)).fetchone()[0]
                record = json.loads(raw)
                self.assertEqual(record["protocol_version"], 3)
                self.assertEqual(record["consent_policy"], "anonymous-replay-training-v3")
                self.assertEqual(record["replay"]["rulesVersion"], "territory-v3")
                self.assertEqual(record["replay"]["terminal"]["reason"], reason)
                self.assertIn(action_type, {action["type"] for action in record["replay"]["actions"]})
                self.assertEqual(record["replay"]["terminal"]["finalStateHash"],
                                 record["replay"]["integrity"]["finalStateHash"])

    def test_private_or_forged_v3_payloads_are_rejected_without_storage(self):
        payload = self.v3_resign
        candidates = [
            {**payload, "openid": "PRIVATE"},
            {**payload, "consent": False},
            {**payload, "version": True},
            {**payload, "context": {**payload["context"], "deviceId": "PRIVATE"}},
            {**payload, "context": {**payload["context"], "actors": {
                **payload["context"]["actors"], "BLACK": {"kind": "human", "name": "PRIVATE"},
            }}},
        ]
        forged = copy.deepcopy(payload)
        forged["replay"]["terminal"]["winner"] = "FAKE"
        candidates.append(forged)
        for candidate in candidates:
            self.assertEqual(self.client.post("/api/training/contributions", json=candidate).status_code, 422)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v3").fetchone()[0], 0)

    def test_v3_context_conflict_is_not_reported_as_duplicate(self):
        payload = copy.deepcopy(self.v3_pass)
        self.store.accept(payload)
        payload["context"]["undo"] = {"enabled": False, "maxCount": 3, "usedCount": 0}
        with self.assertRaisesRegex(ValueError, "Conflicting gameplay metadata"):
            self.store.accept(payload)

    def test_storage_bound_is_shared_across_all_protocol_inboxes(self):
        self.store.accept(self.v1)
        self.store.accept(self.v2)
        with self.store.connect() as db:
            used = sum(db.execute(
                f"SELECT COALESCE(SUM(length(CAST(document AS BLOB))),0) FROM {table}"
            ).fetchone()[0] for table in ("inbox", "inbox_v2", "inbox_v3"))
        constrained = module.ContributionStore(self.temporary.name, maximum_bytes=used + 1)
        with self.assertRaises(OverflowError):
            constrained.accept(self.v3_resign)


if __name__ == "__main__":
    unittest.main()
