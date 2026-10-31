"""Production transaction fault tests; no systemd/remote/production writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("live_profile_activation", ROOT / "wechat/tools/activate_profile_service_live.py")
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)


class Fake:
    """Low-level machine effects are simulated; real SQLite proves retention."""
    def __init__(self, root):
        self.live = root / "live"
        self.live.mkdir()
        (self.live / "version").write_text("baseline")
        self.files = {role: {"version": hashlib.sha256(role.encode()).hexdigest()}
                      for role in ("baseline", "candidate", "rollback")}
        self.database = root / "current.sqlite3"
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE moves (n INTEGER)")
            db.execute("INSERT INTO moves VALUES (1)")
            db.execute("PRAGMA user_version=2")
        self.inode = self.database.stat().st_ino
        self.running = True
        self.events = []
        self.recovering = self.journal_incomplete = False
        self.fault = None
        self.lock = root / "lock"
        self.journal = root / "journal.jsonl"

    event = live.LiveAdapter.event

    def acquire(self):
        self.lock.touch(exist_ok=False)

    def release(self):
        self.lock.unlink()

    def step(self, name):
        self.events.append(name)
        if self.fault == name:
            self.fault = None
            raise RuntimeError("synthetic fault")

    def prepare(self):
        self.step("prepare")

    def preflight(self):
        self.step("preflight")

    def before_stop(self):
        self.step("before-stop")

    def stop(self):
        self.running = False
        self.step("stop")

    def snapshot(self):
        self.step("snapshot")
        assert not self.running
        with sqlite3.connect(self.database) as source, sqlite3.connect(self.database.parent / "snapshot.sqlite3") as target:
            source.backup(target)

    def switch(self, role, expected):
        assert not self.running and live.tree(self.live) == expected
        self.step("switch-before-" + role)
        (self.live / "version").write_text(role)
        self.step("switch-after-" + role)

    def start(self, role):
        assert live.tree(self.live) == self.files[role]
        assert self.database.stat().st_ino == self.inode
        self.running = True
        self.step("start-" + role)

    def health(self, role):
        assert self.running
        if role != "baseline":
            with sqlite3.connect(self.database) as db:
                db.execute("PRAGMA user_version=3")
                if role == "candidate":
                    db.execute("INSERT INTO moves VALUES (2)")
                    db.execute("CREATE TABLE profiles (name TEXT)")
                    db.execute("INSERT INTO profiles VALUES ('latest')")
        self.step("health-" + role)


def test_success_orders_quiescent_backup_before_new_schema(tmp_path):
    adapter = Fake(tmp_path)
    result = live.transact(adapter)
    assert result["status"] == "ACTIVATED_PROFILE_SERVICE"
    assert adapter.events == ["prepare", "preflight", "before-stop", "stop", "snapshot", "switch-before-candidate",
                              "switch-after-candidate", "start-candidate", "health-candidate"]
    with sqlite3.connect(adapter.database) as db, sqlite3.connect(tmp_path / "snapshot.sqlite3") as backup:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert backup.execute("PRAGMA user_version").fetchone()[0] == 2
    assert not adapter.lock.exists() and adapter.running


@pytest.mark.parametrize("fault", ["prepare", "preflight", "before-stop"])
def test_preflight_failures_never_stop_running_service(tmp_path, fault):
    adapter = Fake(tmp_path)
    adapter.fault = fault
    with pytest.raises(RuntimeError):
        live.transact(adapter)
    assert adapter.running and "stop" not in adapter.events and not adapter.lock.exists()


@pytest.mark.parametrize("fault", ["stop", "snapshot"])
def test_pre_switch_failure_restarts_baseline(tmp_path, fault):
    adapter = Fake(tmp_path)
    adapter.fault = fault
    result = live.transact(adapter)
    assert result["status"] == "RECOVERED_BASELINE" and adapter.running
    assert live.tree(adapter.live) == adapter.files["baseline"]
    assert not any("candidate" in event for event in adapter.events)


@pytest.mark.parametrize("fault", ["switch-before-candidate", "switch-after-candidate", "start-candidate", "health-candidate"])
def test_switch_attempt_always_uses_schema3_rollback(tmp_path, fault):
    adapter = Fake(tmp_path)
    adapter.fault = fault
    result = live.transact(adapter)
    assert result["status"] == "RECOVERED_ROLLBACK" and result["databaseRestored"] is False
    assert adapter.running and not adapter.lock.exists()
    assert adapter.database.stat().st_ino == adapter.inode
    assert live.tree(adapter.live) == adapter.files["rollback"]
    with sqlite3.connect(adapter.database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        if fault == "health-candidate":
            assert db.execute("SELECT n FROM moves").fetchall() == [(1,), (2,)]
            assert db.execute("SELECT name FROM profiles").fetchone() == ("latest",)


def test_unowned_tree_drift_leaves_stopped_and_keeps_lock(tmp_path):
    adapter = Fake(tmp_path)
    def health(_role):
        (adapter.live / "unowned").write_text("preserve")
        raise RuntimeError("drift")
    adapter.health = health
    with pytest.raises(live.GateError, match="RECOVERY_BLOCKED"):
        live.transact(adapter)
    assert not adapter.running and adapter.lock.exists()
    assert (adapter.live / "unowned").read_text() == "preserve"


def test_journal_failure_does_not_prevent_same_db_recovery(tmp_path, monkeypatch):
    adapter = Fake(tmp_path)
    original = Path.open
    fail = False
    old_health = adapter.health
    def health(role):
        nonlocal fail
        old_health(role)
        if role == "candidate":
            fail = True
            raise RuntimeError("health fault")
    def open_path(path, *args, **kwargs):
        if path == adapter.journal and fail:
            raise OSError("disk full")
        return original(path, *args, **kwargs)
    adapter.health = health
    monkeypatch.setattr(Path, "open", open_path)
    result = live.transact(adapter)
    assert result["status"] == "RECOVERED_ROLLBACK" and result["journalIncomplete"]
    assert adapter.running and not adapter.lock.exists()


def test_unit_empty_control_group_allowed_only_when_fully_stopped(tmp_path, monkeypatch):
    unitfile = tmp_path / "unit.service"
    unitfile.write_text("synthetic")
    adapter = object.__new__(live.LiveAdapter)
    expected = {name: "synthetic" for name in live.STATIC_PROPERTIES}
    expected.update(FragmentPath=str(unitfile), DropInPaths="", ControlGroup="/system.slice/test")
    adapter.site = {"unit": "test", "unitProperties": expected,
                    "unitFiles": {str(unitfile): live.sha(unitfile.read_bytes())}}
    actual = {**expected, "ControlGroup": "", "MainPID": "0", "ActiveState": "inactive"}
    monkeypatch.setattr(live, "unit_properties", lambda _name: actual)
    adapter.verify_unit()
    actual["MainPID"] = "123"
    with pytest.raises(live.GateError, match="UNIT_PROPERTIES_DRIFT"):
        adapter.verify_unit()
    actual.update(MainPID="0", ControlGroup="/unexpected")
    with pytest.raises(live.GateError, match="UNIT_PROPERTIES_DRIFT"):
        adapter.verify_unit()


def test_systemctl_requests_empty_fields_and_parser_keeps_them(monkeypatch):
    arguments = []
    def invoke(args, **_kwargs):
        arguments.append(args)
        return b"MainPID=0\nActiveState=inactive\nControlGroup=\nDropInPaths=\n"
    monkeypatch.setattr(live, "command", invoke)
    props = live.unit_properties("synthetic.service")
    assert "--all" in arguments[0]
    assert props["ControlGroup"] == props["DropInPaths"] == ""
    assert props["MainPID"] == "0"


def test_failure_journal_keeps_fixed_gate_codes_without_raw_exception_text(tmp_path):
    adapter = Fake(tmp_path)
    def fail_preflight():
        raise live.GateError("PREFLIGHT_FAILED")
    adapter.preflight = fail_preflight
    with pytest.raises(live.GateError):
        live.transact(adapter)
    entries = [json.loads(line) for line in adapter.journal.read_text().splitlines()]
    assert entries[-1]["code"] == "PREFLIGHT_FAILED"
    other = tmp_path / "second"
    other.mkdir()
    adapter = Fake(other)
    def fail_unexpected():
        raise RuntimeError("untrusted exception detail")
    adapter.preflight = fail_unexpected
    with pytest.raises(RuntimeError):
        live.transact(adapter)
    raw = adapter.journal.read_text()
    assert "untrusted exception detail" not in raw
    assert json.loads(raw.splitlines()[-1])["code"] == "NON_GATE_OPERATION_FAILED"


def test_quiescence_reports_safe_writer_reason_before_refusing(tmp_path, monkeypatch):
    adapter = object.__new__(live.LiveAdapter)
    adapter.database, adapter.live = tmp_path / "db", tmp_path / "service"
    adapter.site = {"unit": "synthetic.service", "unitProperties": {"ControlGroup": "/synthetic"}}
    adapter.check_database = lambda: None
    events = []
    adapter.event = lambda name, **details: events.append((name, details))
    monkeypatch.setattr(live, "unit_properties", lambda _unit: {"MainPID": "0", "ActiveState": "inactive"})
    writer = {"pid": 123, "reasons": ["database-or-sidecar-open"]}
    monkeypatch.setattr(live, "writer_scan", lambda *_args: {"scanned": 5, "writers": [writer]})
    with pytest.raises(live.GateError, match="DATABASE_WRITER_STILL_PRESENT"):
        adapter.assert_quiescent()
    assert events[-1] == ("QUIESCENCE_WRITER_SCAN_RESULT", {"processCount": 5, "writers": [writer]})


def test_command_timeout_kills_descendant_group_even_if_parent_exits(monkeypatch):
    process = Mock(pid=777)
    process.communicate.side_effect = [subprocess.TimeoutExpired("synthetic", 1), (b"", None)]
    monkeypatch.setattr(live.subprocess, "Popen", Mock(return_value=process))
    killed = []
    monkeypatch.setattr(live.os, "killpg", lambda pid, sig: killed.append((pid, sig)), raising=False)
    # Windows has no SIGKILL; this tests the Linux branch without launching it.
    monkeypatch.setattr(live.signal, "SIGKILL", 9, raising=False)
    with pytest.raises(live.GateError, match="TIMED_OUT"):
        live.command(["synthetic"], timeout=1)
    assert killed == [(777, live.signal.SIGTERM), (777, 9)]
    assert live.subprocess.Popen.call_args.kwargs["start_new_session"] is True


def test_existing_deployment_lock_is_never_removed(tmp_path):
    adapter = Fake(tmp_path)
    adapter.lock.write_text("prior hard interruption")
    with pytest.raises(FileExistsError):
        live.transact(adapter)
    assert adapter.lock.read_text() == "prior hard interruption" and adapter.events == []


def test_relevant_environment_ignores_new_invocation_id_but_keeps_credentials():
    first = {"WECHAT_JWT_SECRET": "synthetic", "INVOCATION_ID": "one", "PATH": "synthetic-path"}
    second = {**first, "INVOCATION_ID": "two"}
    assert live.relevant_environment(first) == live.relevant_environment(second)
    second["WECHAT_JWT_SECRET"] = "changed"
    assert live.relevant_environment(first) != live.relevant_environment(second)


def test_frozen_bundle_is_accepted_and_extra_file_rejected(tmp_path):
    bundle = Path(os.environ.get("LIFELINE_ACTIVATION_TEST_BUNDLE",
                                 ROOT / "local_artifacts/wechat-profile-production-20261022/service-bundle-reconnection-v3"))
    files = live.bundle_inventory(bundle)
    assert {role: len(items) for role, items in files.items()} == {"baseline": 31, "candidate": 51, "rollback": 31}
    target = tmp_path / "extra"
    target.mkdir()
    (target / "legitimate").write_text("value")
    (target / "unexpected").write_text("preserve")
    assert set(live.tree(target)) == {"legitimate", "unexpected"}


def test_snapshot_sqlite_runs_as_service_user_then_backup_becomes_private(tmp_path, monkeypatch):
    adapter = object.__new__(live.LiveAdapter)
    adapter.run_dir = tmp_path
    adapter.live = tmp_path / "live"
    adapter.live.mkdir()
    adapter.database = tmp_path / "database.sqlite3"
    adapter.database.write_bytes(b"current untouched")
    stage = tmp_path / "candidate"
    tool = stage / "wechat/tools/maintain_store.py"
    tool.parent.mkdir(parents=True)
    tool.write_bytes(b"synthetic pinned source")
    adapter.prepared = {"candidate": stage}
    adapter.files = {"baseline": {}, "candidate": {"wechat/tools/maintain_store.py": live.sha(tool.read_bytes())}}
    adapter.site = {"python": "actual-service-python", "uid": 1000, "gid": 1000}
    adapter.assert_quiescent = adapter.check_database = lambda: None
    adapter.event = lambda *_a, **_k: None
    ownership = []
    monkeypatch.setattr(live.os, "chown", lambda p, uid, gid: ownership.append((Path(p), uid, gid)), raising=False)
    def invoke(args, **kwargs):
        assert kwargs["user"] == (1000, 1000)
        assert kwargs["input_data"] == tool.read_bytes() and kwargs["timeout"] == 45
        target = Path(args[-1])
        target.write_bytes(b"consistent snapshot")
        return json.dumps({"status": "PASS_STANDALONE_BACKUP", "bytes": target.stat().st_size,
                           "sha256": live.sha(target.read_bytes())}).encode()
    monkeypatch.setattr(live, "command", invoke)
    adapter.snapshot()
    backup = tmp_path / "database-backup/before.sqlite3"
    assert (backup, 0, 0) in ownership and (backup.parent, 0, 0) in ownership
    assert adapter.database.read_bytes() == b"current untouched"


def test_live_health_sqlite_probe_also_runs_as_service_user(tmp_path, monkeypatch):
    adapter = object.__new__(live.LiveAdapter)
    adapter.live = tmp_path / "live"
    adapter.live.mkdir()
    adapter.files = {"candidate": {}}
    adapter.database = tmp_path / "database.sqlite3"
    adapter.site = {"python": "actual-service-python", "uid": 1000, "gid": 1000,
                    "healthUrl": "http://127.0.0.1:8006/api/wechat/status"}
    adapter.check_database = adapter.verify_unit = lambda: None
    adapter.event = lambda *_a, **_k: None
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=None)
    response.read.return_value = json.dumps({"enabled": True, "webLogin": True,
                                           "webAuthMode": "password", "accountProfile": True}).encode()
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(live.urllib.request, "build_opener", lambda *_a: opener)
    calls = []
    def invoke(args, **kwargs):
        calls.append((args, kwargs))
        assert kwargs["user"] == (1000, 1000) and kwargs["timeout"] == 10
        assert "mode=ro" in args[3]
        return b'{"version":3,"integrity":true}'
    monkeypatch.setattr(live, "command", invoke)
    adapter.health("candidate")
    assert len(calls) == 1


@pytest.mark.skipif(sys.platform != "linux", reason="Linux umask/group traversal semantics")
def test_supervisor_private_umask_still_allows_service_group_to_traverse(tmp_path, monkeypatch):
    target = tmp_path / "private-run"
    ownership = []
    monkeypatch.setattr(live.os, "chown", lambda path, uid, gid: ownership.append((path, uid, gid)))
    old_mask = os.umask(0o077)
    try:
        live.create_run_directory(target, 1000)
    finally:
        os.umask(old_mask)
    assert stat.S_IMODE(target.stat().st_mode) == 0o750
    assert ownership == [(target, 0, 1000)]
    assert target.stat().st_mode & stat.S_IRGRP
    assert target.stat().st_mode & stat.S_IXGRP
    assert not target.stat().st_mode & stat.S_IWGRP
    assert not target.stat().st_mode & stat.S_IRWXO
