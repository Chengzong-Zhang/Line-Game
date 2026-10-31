"""Synthetic /proc access-mode regressions; no production process changes."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "writer_scan_activation", ROOT / "wechat/tools/activate_profile_service_live.py")
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)


class WriterScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "current.sqlite3"
        self.database.write_bytes(b"synthetic database")
        self.proc = self.root / "proc/876543"
        (self.proc / "fd").mkdir(parents=True)
        (self.proc / "fdinfo").mkdir()
        (self.proc / "cgroup").write_text("0::/external\n")
        self.descriptor = self.proc / "fd/7"
        os.link(self.database, self.descriptor)
        self.info = self.proc / "fdinfo/7"
        self.flags("0100000")
        self.environment = {}
        original_path = Path
        def map_proc(value):
            return self.root / "proc" if value == "/proc" else original_path(value)
        self.addCleanup(patch.stopall)
        patch.object(live, "Path", side_effect=map_proc).start()
        patch.object(live, "process_environment", side_effect=lambda _pid: self.environment).start()
        patch.object(live.os, "readlink", return_value=str(self.database)).start()

    def flags(self, value):
        self.info.write_text(f"pos:\t0\nflags:\t{value}\nmnt_id:\t1\nino:\t{self.database.stat().st_ino}\n")

    def scan(self):
        return live.writer_scan(self.database, self.root / "service", "/lifeline.service")

    def test_proven_read_only_security_scanner_is_not_a_writer(self):
        self.assertEqual(self.scan(), {"scanned": 1, "writers": []})

    def test_read_write_descriptor_is_still_a_writer(self):
        self.flags("0100002")
        self.assertEqual(self.scan()["writers"], [
            {"pid": 876543, "reasons": ["database-or-sidecar-open"]}])

    def test_write_only_descriptor_is_still_a_writer(self):
        self.flags("0100001")
        self.assertEqual(len(self.scan()["writers"]), 1)

    def test_read_only_descriptor_does_not_ignore_service_membership(self):
        (self.proc / "cgroup").write_text("0::/lifeline.service/child\n")
        self.assertEqual(self.scan()["writers"][0]["reasons"], ["service-control-group"])

    def test_read_only_descriptor_does_not_ignore_database_configuration(self):
        self.environment["WECHAT_DB_PATH"] = str(self.database)
        self.assertEqual(self.scan()["writers"][0]["reasons"], ["configured-database-writer"])

    def test_missing_flags_fail_closed(self):
        self.info.write_text(f"ino:\t{self.database.stat().st_ino}\n")
        with self.assertRaisesRegex(live.GateError, "PROCESS_FD_ACCESS_UNCONFIRMED"):
            self.scan()

    def test_invalid_or_ambiguous_flags_fail_closed(self):
        for flags in ("0100008", "-1", "0100003", "0100000\nflags:\t0100002"):
            with self.subTest(flags=flags):
                self.flags(flags)
                with self.assertRaisesRegex(live.GateError, "PROCESS_FD_ACCESS_UNCONFIRMED"):
                    self.scan()

    def test_still_open_descriptor_without_fdinfo_fails_closed(self):
        self.info.unlink()
        with self.assertRaisesRegex(live.GateError, "PROCESS_FD_ACCESS_UNCONFIRMED"):
            self.scan()

    def test_changed_descriptor_inode_fails_closed(self):
        self.info.write_text("flags:\t0100000\nino:\t0\n")
        with self.assertRaisesRegex(live.GateError, "PROCESS_FD_IDENTITY_CHANGED"):
            self.scan()

    def test_unreadable_fdinfo_fails_closed(self):
        original_read = Path.read_text
        def deny_info(path, *args, **kwargs):
            if path == self.info:
                raise PermissionError("synthetic access denied")
            return original_read(path, *args, **kwargs)
        with patch.object(Path, "read_text", deny_info):
            with self.assertRaisesRegex(live.GateError, "PROCESS_SCAN_PERMISSION_DENIED"):
                self.scan()


if __name__ == "__main__":
    unittest.main()
