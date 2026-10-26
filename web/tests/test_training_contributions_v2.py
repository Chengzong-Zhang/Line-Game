"""Frozen protocol-v2 compatibility tests. Synthetic local inboxes only."""
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("training_contributions_v2_under_test", ROOT / "web/web后端/training_contributions.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(options):
    return json.loads(subprocess.check_output([
        "node", str(ROOT / "web/web前端/tests/fixtures/create-training-v2-fixture.mjs"), json.dumps(options),
    ]))


class ContributionV2CompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payloads = [fixture({
            "playerCount": count,
            "startingPointMode": "random" if count % 2 else "custom",
            "undoUsedCount": 2,
            "profile": "three-player-policy-v2" if count == 3 else None,
        }) for count in range(2, 7)]
        cls.v1 = json.loads(subprocess.check_output([
            "node", str(ROOT / "web/web前端/tests/fixtures/create-training-fixture.mjs"),
        ]))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = module.ContributionStore(self.temporary.name)
        app = FastAPI()
        app.include_router(module.create_router(self.store))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_frozen_v2_capability_remains_advertised(self):
        data = self.client.get("/api/training/contributions/status").json()
        self.assertEqual(data["supported_versions"], [1, 2, 3])
        self.assertEqual(data["consent_policy"], "anonymous-replay-training-v1")
        self.assertEqual(data["consent_policies"]["2"], "anonymous-replay-training-v2")
        self.assertEqual(data["supported_rules_versions"]["2"], ["territory-v2"])

    def test_existing_web_v1_three_player_ai_remains_compatible(self):
        payload = copy.deepcopy(self.payloads[1])
        payload["version"] = 1
        payload["consent_policy"] = "anonymous-replay-training-v1"
        del payload["context"]["undo"]
        payload["context"]["actors"]["WHITE"] = {
            "kind": "ai", "strategy": "three-player", "modelId": "three-player-policy-v2",
        }
        response = self.client.post("/api/training/contributions", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v2").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v3").fetchone()[0], 0)
        bad = copy.deepcopy(payload)
        bad["context"]["actors"]["WHITE"]["strategy"] = "minimax"
        self.assertEqual(self.client.post("/api/training/contributions", json=bad).status_code, 422)

    def test_every_frozen_v2_player_count_and_undo_stays_in_v2(self):
        for payload in self.payloads:
            response = self.client.post("/api/training/contributions", json=payload)
            self.assertEqual(response.status_code, 200, response.text)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 0)
            rows = db.execute("SELECT document FROM inbox_v2").fetchall()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_v3").fetchone()[0], 0)
        self.assertEqual(len(rows), 5)
        for (raw,) in rows:
            record = json.loads(raw)
            self.assertEqual(record["protocol_version"], 2)
            self.assertEqual(record["context"]["undo"]["usedCount"], 2)
            self.assertEqual(record["consent_policy"], "anonymous-replay-training-v2")
            self.assertEqual(set(record), {
                "game_id", "replay", "engine_sources", "protocol_version", "context", "consent_policy", "status",
            })

    def test_frozen_v2_restart_concurrency_and_context_conflict(self):
        payload = self.payloads[0]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: module.ContributionStore(self.temporary.name).accept(payload), range(2)))
        self.assertEqual(sorted(result["status"] for result in results), ["awaiting_review", "duplicate"])
        self.assertEqual(results[0]["game_id"], results[1]["game_id"])
        conflict = copy.deepcopy(payload)
        conflict["context"]["undo"] = {"enabled": False, "maxCount": 3, "usedCount": 0}
        with self.assertRaisesRegex(ValueError, "Conflicting gameplay metadata"):
            self.store.accept(conflict)

    def test_default_export_still_excludes_v2_and_v3(self):
        self.store.accept(self.v1)
        self.store.accept(self.payloads[0])
        default = Path(self.temporary.name) / "legacy-export"
        newer = Path(self.temporary.name) / "explicit-v2-export"
        self.assertEqual(self.store.export(default), 1)
        self.assertEqual(self.store.export(newer, version=2), 1)
        self.assertNotIn("protocol_version", json.loads(next(default.glob("*.json")).read_text(encoding="utf-8")))
        self.assertEqual(json.loads(next(newer.glob("*.json")).read_text(encoding="utf-8"))["protocol_version"], 2)
        with self.assertRaises(ValueError):
            self.store.export(Path(self.temporary.name) / "invalid-export", version=4)

    def test_frozen_v2_privacy_profiles_and_forgery_rejections(self):
        payload = self.payloads[0]
        candidates = [
            {**payload, "openid": "PRIVATE"},
            {**payload, "consent": False},
            {**payload, "version": True},
            {**payload, "context": {**payload["context"], "account": "PRIVATE"}},
            {**payload, "context": {**payload["context"], "actors": {
                "BLACK": {"kind": "human", "name": "PRIVATE"}, "WHITE": {"kind": "human"},
            }}},
            {**payload, "context": {**payload["context"], "undo": {
                "enabled": False, "maxCount": 3, "usedCount": 2,
            }}},
        ]
        for candidate in candidates:
            self.assertEqual(self.client.post("/api/training/contributions", json=candidate).status_code, 422)
        wrong_profile = copy.deepcopy(self.payloads[0])
        wrong_profile["context"]["actors"]["WHITE"] = {"kind": "ai", "profile": "hex-player-policy-v1"}
        self.assertEqual(self.client.post("/api/training/contributions", json=wrong_profile).status_code, 422)
        forged = copy.deepcopy(self.payloads[4])
        forged["replay"]["terminal"]["winner"] = "FAKE"
        self.assertEqual(self.client.post("/api/training/contributions", json=forged).status_code, 422)


if __name__ == "__main__":
    unittest.main()
