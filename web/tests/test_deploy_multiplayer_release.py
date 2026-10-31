"""Local fault-injection checks; never contact deployment hosts or services."""

import importlib.util
from pathlib import Path
import sys
import types
from unittest.mock import Mock, call, patch
from urllib.error import URLError

import pytest


@pytest.fixture
def deploy(monkeypatch):
    script = Path(__file__).resolve().parents[1] / "tools" / "deploy_multiplayer_release.py"
    spec = importlib.util.spec_from_file_location("multiplayer_deploy_under_test", script)
    module = importlib.util.module_from_spec(spec)
    # fcntl is only used by the Linux command-line entrypoint, not these helpers.
    with patch.dict(sys.modules, {"fcntl": types.ModuleType("fcntl")}):
        spec.loader.exec_module(module)

    def forbidden(*args, **kwargs):
        raise AssertionError("A deployment test attempted an external operation")

    monkeypatch.setattr(module.subprocess, "run", forbidden)
    monkeypatch.setattr(module.urllib.request, "urlopen", forbidden)
    return module


def test_rollback_keeps_restoring_after_first_service_command_fails(deploy, monkeypatch, tmp_path):
    root = tmp_path / "root"
    release = root / ".release"
    stage = release / "candidate"
    unit = tmp_path / "systemd" / deploy.GAME_UNIT
    dropin = unit.parent / "collector.conf"
    unit.parent.mkdir()
    unit.touch()
    dropin.touch()
    for name, value in {"ROOT": root, "RELEASE": release, "STAGE": stage,
                        "GAME_UNIT_PATH": unit, "DROPIN": dropin}.items():
        monkeypatch.setattr(deploy, name, value)

    old_name, new_name = "web/backend/old.py", "web/backend/new.py"
    added = root / new_name
    added.parent.mkdir(parents=True)
    added.write_text("new deployment file", encoding="utf-8")
    state = {"services_installed": True, "files_replaced": [old_name, new_name],
             "frontend_swapped": True, "old_stopped": True, "stop_requested": True,
             "collector_stopped": True}
    prepared = {"old_files": {old_name: "prior-hash", new_name: None}, "old_pid": 123}
    commands = []

    def run(args):
        commands.append(args)
        if len(commands) == 1:
            raise RuntimeError("injected service-stop failure")
        return b""

    monkeypatch.setattr(deploy, "run", run)
    copy = Mock()
    exchange = Mock()
    health = Mock()
    collector = Mock()
    monkeypatch.setattr(deploy, "atomic_copy", copy)
    monkeypatch.setattr(deploy, "exchange", exchange)
    monkeypatch.setattr(deploy, "wait_health", health)
    monkeypatch.setattr(deploy, "wait_collector", collector)

    with pytest.raises(RuntimeError, match="Rollback steps require inspection: RuntimeError$"):
        deploy.rollback(state, prepared)

    assert commands[0] == ["sudo", "-n", "systemctl", "stop", deploy.COLLECTOR_UNIT]
    assert not added.exists()
    copy.assert_called_once_with(release / "rollback" / old_name, root / old_name)
    exchange.assert_called_once_with(root / "web/web前端", stage / "web/web前端")
    assert ["sudo", "-n", "rm", "--", unit] in commands
    assert ["sudo", "-n", "rm", "--", dropin] in commands
    restarts = [args for args in commands if args[:3] == ["sudo", "-n", "systemd-run"]]
    assert len(restarts) == 1
    assert "server:app" in restarts[0]
    assert "--setenv=LINE_GAME_DB_PATH=" + str(deploy.DATABASES[0]) in restarts[0]
    assert ["sudo", "-n", "systemctl", "start", deploy.COLLECTOR_UNIT] in commands
    health.assert_called_once_with(8000)
    collector.assert_called_once_with(8005)


@pytest.mark.parametrize("still_running", [False, True])
def test_rollback_recovers_exit_before_stop_journal_update(deploy, monkeypatch, still_running):
    state = {"services_installed": False, "files_replaced": [], "frontend_swapped": False,
             "old_stopped": False, "stop_requested": True, "collector_stopped": False}
    run = Mock(return_value=b"")
    running = Mock(return_value=still_running)
    health = Mock()
    monkeypatch.setattr(deploy, "run", run)
    monkeypatch.setattr(deploy, "process_running", running)
    monkeypatch.setattr(deploy, "wait_health", health)

    deploy.rollback(state, {"old_pid": 123, "old_files": {}})

    running.assert_called_once_with(123)
    health.assert_called_once_with(8000)
    if still_running:
        run.assert_not_called()
    else:
        run.assert_called_once()
        assert run.call_args.args[0][:3] == ["sudo", "-n", "systemd-run"]


def test_wait_health_recovers_from_transient_failure(deploy, monkeypatch):
    expected = {"status": "ok", "filter_ready": True}
    health = Mock(side_effect=[URLError("temporarily unavailable"), expected])
    clock = types.SimpleNamespace(monotonic=Mock(side_effect=[0, 1]), sleep=Mock())
    monkeypatch.setattr(deploy, "health", health)
    monkeypatch.setattr(deploy, "time", clock)

    assert deploy.wait_health(8000) == expected
    assert health.call_args_list == [call(8000), call(8000)]
    clock.sleep.assert_called_once_with(.5)


def test_wait_collector_retries_transport_and_not_ready_responses(deploy, monkeypatch):
    expected = {"enabled": True, "consent_policy": "anonymous-replay-training-v1"}
    read = Mock(side_effect=[URLError("temporarily unavailable"), {"enabled": False}, expected])
    clock = types.SimpleNamespace(monotonic=Mock(side_effect=[0, 1, 2]), sleep=Mock())
    monkeypatch.setattr(deploy, "read_json", read)
    monkeypatch.setattr(deploy, "time", clock)

    assert deploy.wait_collector(8005) == expected
    assert read.call_args_list == [call("http://127.0.0.1:8005/api/training/contributions/status")] * 3
    assert clock.sleep.call_args_list == [call(.5), call(.5)]


@pytest.mark.parametrize("waiter,dependency", [("wait_health", "health"), ("wait_collector", "read_json")])
def test_readiness_wait_stops_at_deadline(deploy, monkeypatch, waiter, dependency):
    failure = URLError("still unavailable")
    check = Mock(side_effect=failure)
    clock = types.SimpleNamespace(monotonic=Mock(side_effect=[0, 30]), sleep=Mock())
    monkeypatch.setattr(deploy, dependency, check)
    monkeypatch.setattr(deploy, "time", clock)

    with pytest.raises(URLError) as result:
        getattr(deploy, waiter)(8000)

    assert result.value is failure
    check.assert_called_once()
    clock.sleep.assert_not_called()


@pytest.mark.parametrize("state,expected", [("Z", False), ("S", True), ("R", True)])
def test_process_running_distinguishes_zombies(deploy, monkeypatch, state, expected):
    read = Mock(return_value=f"123 (worker name) {state} 1 2 3")
    monkeypatch.setattr(deploy.Path, "read_text", read)

    assert deploy.process_running(123) is expected
    read.assert_called_once()


def test_process_running_returns_false_for_missing_process(deploy, monkeypatch):
    monkeypatch.setattr(deploy.Path, "read_text", Mock(side_effect=FileNotFoundError))
    assert deploy.process_running(123) is False
