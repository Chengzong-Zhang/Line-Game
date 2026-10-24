"""Failure recovery model for the complete-runtime release adapter.

These are local transaction checks, not proof of Linux/systemd activation.
"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("service_release_test", ROOT / "wechat/tools/activate_service_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Adapter:
    def __init__(self, failure=None, recovery_failure=False):
        self.calls = []
        self.failure = failure
        self.recovery_failure = recovery_failure
        self.recovering = self.journal_incomplete = False
        self.files = {"baseline": {"version": "old"}, "candidate": {"version": "new"}, "rollback": {"version": "old"}}
        self.live = "synthetic-live"
        self.current = self.files["baseline"]
        self.locked = False
        self.raised = False

    def step(self, name):
        self.calls.append(name)
        if self.failure == name and not self.raised:
            self.raised = True
            raise release.GateError("INJECTED_FAILURE")

    def acquire(self):
        self.locked = True
        self.step("acquire")

    def release(self):
        self.step("release")
        self.locked = False

    def prepare(self): self.step("prepare")
    def preflight(self): self.step("preflight")
    def before_stop(self): self.step("before_stop")
    def stop(self): self.step("stop")
    def snapshot(self): self.step("snapshot")

    def switch(self, role, expected):
        assert self.current == expected
        self.current = self.files[role]
        self.step("switch_" + role)

    def start(self, role): self.step("start_" + role)

    def health(self, role):
        self.step("health_" + role)
        if self.recovering and self.recovery_failure:
            raise release.GateError("INJECTED_RECOVERY_FAILURE")

    def event(self, name, **details): self.calls.append("event:" + name)


class ReleaseTransactionTests(unittest.TestCase):
    def run_adapter(self, adapter):
        with patch.object(release.base, "tree", lambda _path: adapter.current):
            return release.base.transact(adapter)

    def test_success_uses_full_candidate_and_releases_lock(self):
        adapter = Adapter()
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "ACTIVATED_PROFILE_SERVICE")
        self.assertEqual(adapter.current, adapter.files["candidate"])
        self.assertFalse(adapter.locked)
        self.assertFalse(result["databaseRestored"])

    def test_preflight_failure_never_stops_service(self):
        adapter = Adapter("preflight")
        with self.assertRaises(release.GateError):
            self.run_adapter(adapter)
        self.assertNotIn("stop", adapter.calls)
        self.assertFalse(adapter.locked)

    def test_partial_stop_failure_restarts_unchanged_baseline(self):
        adapter = Adapter("stop")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_BASELINE")
        self.assertIn("start_baseline", adapter.calls)
        self.assertFalse(adapter.locked)

    def test_failure_after_exchange_recovers_actual_original_tree(self):
        adapter = Adapter("switch_candidate")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_ROLLBACK")
        self.assertEqual(adapter.current, adapter.files["baseline"])
        self.assertIn("health_rollback", adapter.calls)
        self.assertFalse(result["databaseRestored"])
        self.assertFalse(adapter.locked)

    def test_failed_new_health_recovers_old_code_and_keeps_database(self):
        adapter = Adapter("health_candidate")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_ROLLBACK")
        self.assertEqual(adapter.current, adapter.files["baseline"])
        self.assertFalse(result["databaseRestored"])

    def test_uncertain_recovery_retains_lock(self):
        adapter = Adapter("health_candidate", recovery_failure=True)
        with self.assertRaisesRegex(release.GateError, "RECOVERY_BLOCKED"):
            self.run_adapter(adapter)
        self.assertTrue(adapter.locked)


if __name__ == "__main__":
    unittest.main()
