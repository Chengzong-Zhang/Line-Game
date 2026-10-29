"""Fault injection for release ordering; these tests never invoke systemctl."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "web/tools" / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


collector = module("activate_collector_unified_release")
legacy = module("activate_legacy_unified_release")


class Fake:
    def __init__(self, failure=None, recovery_failure=False):
        self.failure, self.recovery_failure = failure, recovery_failure
        self.events = []
        self.failed = False

    def __getattr__(self, name):
        def call(*args):
            event = name + (":" + args[0] if args else "")
            self.events.append(event)
            if (event == self.failure and not self.failed) or (event == "verify:baseline" and self.recovery_failure):
                self.failed = True
                raise RuntimeError("injected")
        return call


class ReleaseTransactions(unittest.TestCase):
    def test_collector_success_stops_before_snapshot_and_exchange(self):
        adapter = Fake()
        result = collector.transact(adapter)
        self.assertFalse(result["databaseRestored"])
        self.assertEqual(adapter.events, ["acquire", "prepare", "preflight", "before_stop", "stop", "snapshot",
                                          "replace:candidate", "start", "verify:candidate", "release"])

    def test_failures_before_stop_never_replace(self):
        for fn in (collector.transact, legacy.legacy.transact):
            for failure in ("prepare", "preflight", "before_stop"):
                with self.subTest(fn=fn, failure=failure):
                    adapter = Fake(failure)
                    with self.assertRaises(RuntimeError):
                        fn(adapter)
                    self.assertNotIn("replace:candidate", adapter.events)
                    self.assertNotIn("stop", adapter.events)
                    self.assertEqual(adapter.events[-1], "release")

    def test_post_stop_failures_restore_code_with_no_database_restore(self):
        for fn in (collector.transact, legacy.legacy.transact):
            for failure in ("stop", "replace:candidate", "start", "verify:candidate"):
                with self.subTest(fn=fn, failure=failure):
                    adapter = Fake(failure)
                    with self.assertRaises(ValueError):
                        fn(adapter)
                    self.assertIn("verify:baseline", adapter.events)
                    self.assertEqual(adapter.events[-1], "release")
                    self.assertFalse(any("database" in event for event in adapter.events))

    def test_snapshot_failure_recovers_without_exchanging_code(self):
        adapter = Fake("snapshot")
        with self.assertRaises(ValueError):
            collector.transact(adapter)
        self.assertNotIn("replace:candidate", adapter.events)
        self.assertNotIn("replace:baseline", adapter.events)
        self.assertIn("verify:baseline", adapter.events)

    def test_recovery_failure_keeps_lock(self):
        for fn in (collector.transact, legacy.legacy.transact):
            adapter = Fake("verify:candidate", recovery_failure=True)
            with self.assertRaisesRegex(ValueError, "KEEP_LOCK"):
                fn(adapter)
            self.assertNotIn("release", adapter.events)


if __name__ == "__main__":
    unittest.main()
