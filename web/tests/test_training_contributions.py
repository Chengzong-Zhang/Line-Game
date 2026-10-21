import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("training_contributions", ROOT / "web/web后端/training_contributions.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class ContributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = subprocess.check_output(["node", str(ROOT / "web/web前端/tests/fixtures/create-training-fixture.mjs")])
        cls.payload = json.loads(raw)
        fixture = str(ROOT / "web/web前端/tests/fixtures/create-three-player-training-fixture.mjs")
        cls.three_player_payloads = {
            count: json.loads(subprocess.check_output(["node", fixture, str(count)]))
            for count in (1, 2)
        }
        cls.three_player_legacy = json.loads(subprocess.check_output(["node", fixture, "2", "territory-v1"]))
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.store = module.ContributionStore(self.temporary.name)
        app = FastAPI(); app.include_router(module.create_router(self.store)); self.client = TestClient(app)
    def tearDown(self): self.temporary.cleanup()
    def test_restart_and_dedup(self):
        first = self.client.post("/api/training/contributions", json=self.payload)
        self.assertEqual(first.status_code, 200); self.assertEqual(first.json()["status"], "awaiting_review")
        second = module.ContributionStore(self.temporary.name).accept(self.payload)
        self.assertEqual(second["game_id"], first.json()["game_id"]); self.assertEqual(second["status"], "duplicate")
        with self.store.connect() as db: self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 1)
    def test_no_consent_private_or_forged_payload(self):
        for payload in [{**self.payload, "consent": False}, {**self.payload, "account": "PRIVATE"}, {**self.payload, "context": {**self.payload["context"], "deviceId": "PRIVATE"}}]:
            self.assertEqual(self.client.post("/api/training/contributions", json=payload).status_code, 422)
        bad = json.loads(json.dumps(self.payload)); bad["replay"]["terminal"]["winner"] = "BLACK" if bad["replay"]["terminal"]["winner"] != "BLACK" else "WHITE"
        self.assertEqual(self.client.post("/api/training/contributions", json=bad).status_code, 422)
        with self.store.connect() as db: self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 0)
    def test_bounds_origin_and_disabled(self):
        self.assertEqual(self.client.post("/api/training/contributions", json=self.payload, headers={"Origin": "https://foreign.example"}).status_code, 403)
        self.assertEqual(self.client.post("/api/training/contributions", content=b"a" * 512001, headers={"Content-Type": "application/json"}).status_code, 413)
        with self.assertRaises(OverflowError): module.ContributionStore(self.temporary.name, maximum_bytes=1).accept(self.payload)
    def test_export_contains_no_extra_fields(self):
        self.store.accept(self.payload); target = Path(self.temporary.name) / "export"
        self.assertEqual(self.store.export(target), 1)
        record = json.loads(next(target.glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(set(record), {"game_id", "replay", "engine_sources", "context", "consent_policy", "status"})
        self.assertEqual(record["status"], "awaiting_review")
        with self.assertRaises(FileExistsError): self.store.export(target)
    def test_disabled_does_not_collect(self):
        with patch.dict(module.os.environ, {}, clear=True):
            app = FastAPI(); app.include_router(module.create_router())
            with TestClient(app) as client:
                self.assertFalse(client.get("/api/training/contributions/status").json()["enabled"])
                self.assertEqual(client.post("/api/training/contributions", json=self.payload).status_code, 503)
    def test_complete_three_player_ai_games_are_received_with_actor_labels(self):
        for count, payload in self.three_player_payloads.items():
            with self.subTest(ai_count=count):
                store = module.ContributionStore(Path(self.temporary.name) / str(count))
                app = FastAPI(); app.include_router(module.create_router(store))
                with TestClient(app) as client:
                    self.assertIsNotNone(payload["replay"]["terminal"])
                    self.assertGreaterEqual(len(payload["replay"]["actions"]), 6)
                    response = client.post("/api/training/contributions", json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["status"], "awaiting_review")
                with store.connect() as db:
                    stored = json.loads(db.execute("SELECT document FROM inbox").fetchone()[0])
                self.assertEqual(stored["context"]["actors"], payload["context"]["actors"])
                self.assertEqual(sum(actor["kind"] == "ai" for actor in stored["context"]["actors"].values()), count)
                self.assertEqual(stored["replay"]["terminal"], payload["replay"]["terminal"])
    def test_three_player_strategy_rejects_wrong_model_player_count_and_rules(self):
        source = self.three_player_payloads[2]
        wrong_model = json.loads(json.dumps(source))
        wrong_model["context"]["actors"]["WHITE"]["modelId"] = "other-model"
        missing_model = json.loads(json.dumps(source))
        del missing_model["context"]["actors"]["WHITE"]["modelId"]
        wrong_strategy = json.loads(json.dumps(source))
        wrong_strategy["context"]["actors"]["WHITE"]["strategy"] = "model-free"
        wrong_count = json.loads(json.dumps(self.payload))
        wrong_count["context"]["actors"]["WHITE"] = {
            "kind": "ai", "strategy": "three-player", "modelId": module.THREE_PLAYER_MODEL_ID,
        }
        for payload in (wrong_model, missing_model, wrong_strategy, wrong_count, self.three_player_legacy):
            self.assertEqual(self.client.post("/api/training/contributions", json=payload).status_code, 422)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox").fetchone()[0], 0)
    def test_three_player_versions_preserve_identity_and_require_matching_strategy(self):
        for model_id in module.THREE_PLAYER_MODEL_IDS:
            context = json.loads(json.dumps(self.three_player_payloads[2]["context"]))
            context["actors"]["WHITE"]["modelId"] = model_id
            self.assertEqual(module.normalize_context(context)["actors"]["WHITE"]["modelId"], model_id)
            context["actors"]["WHITE"]["strategy"] = "model-free"
            with self.assertRaises(ValueError):
                module.normalize_context(context)
if __name__ == "__main__": unittest.main()
