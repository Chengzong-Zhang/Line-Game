from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "web/tools/deploy_replay_collection_v3_20261026.py"
spec = importlib.util.spec_from_file_location("replay_collection_v3_deploy", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReplayCollectionV3DeploymentTests(unittest.TestCase):
    def test_path_and_cache_rendering_are_bounded(self):
        self.assertTrue(module.safe_member("web/backend/server.py"))
        for value in ("", "/root", "../escape", "a/../b", r"a\b"):
            self.assertFalse(module.safe_member(value))
        main = module.render_frontend("main.js", b'''const APP_ASSET_VERSION = "old";\nimport "./OnlineApp.js?v=old";\n''').decode()
        self.assertIn(f'const APP_ASSET_VERSION = "{module.ASSET_VERSION}";', main)
        self.assertIn(f'./OnlineApp.js?v={module.ASSET_VERSION}', main)
        index = module.render_frontend("index.html", b'''<link href="styles.css?v=old"><script src="main.js?v=old"></script>''').decode()
        self.assertIn(f"styles.css?v={module.ASSET_VERSION}", index)
        self.assertIn(f"main.js?v={module.ASSET_VERSION}", index)

    def test_prepare_freezes_collector_fixtures_and_frontend_overlay(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-v3-deploy-test-") as directory:
            output = Path(directory) / module.RELEASE_ID
            release = module.prepare(output)
            self.assertEqual(release["fixtureVersions"], [1, 2, 2, 3, 3, 3])
            self.assertEqual(module.load_local_release(output), release)
            predecessor = json.loads((ROOT / "docs/verification/latest-moves-20261025/web-release-manifest.json")
                                     .read_text(encoding="utf-8"))
            self.assertEqual(release["authoritativeReplayPredecessorHashes"], {
                frontend_name: predecessor["files"][frontend_name]
                for frontend_name in module.AUTHORITATIVE_REPLAY_PREDECESSOR_FILES.values()
            })
            with zipfile.ZipFile(output / "collector.zip") as bundle:
                manifest = json.loads(bundle.read("collector-manifest.json"))
                self.assertEqual(manifest, release["collectorManifest"])
                self.assertEqual(set(bundle.namelist()), {"collector-manifest.json"} |
                                 {"service/" + name for name in manifest["files"]})
            with zipfile.ZipFile(output / "frontend-overlay.zip") as bundle:
                self.assertEqual(set(bundle.namelist()), set(module.OVERLAY_FILES) | {"release-manifest.json"})
                manifest = json.loads(bundle.read("release-manifest.json"))
                self.assertEqual(manifest["release_id"], module.FRONTEND_RELEASE_ID)
                self.assertEqual(manifest["predecessor_release_id"], module.PREDECESSOR_RELEASE_ID)
                self.assertEqual(set(manifest["overlay_files"]), set(module.OVERLAY_FILES))
                for name in module.OVERLAY_FILES:
                    self.assertEqual(module.sha_bytes(bundle.read(name)), manifest["files"][name])
            self.assertFalse(any(output.glob("*.sqlite*")))

    def test_prepare_gate_rejects_authoritative_replay_source_drift(self):
        predecessor = json.loads((ROOT / "docs/verification/latest-moves-20261025/web-release-manifest.json")
                                 .read_text(encoding="utf-8"))
        rows = {destination: (ROOT / source).read_bytes()
                for destination, source in module.COLLECTOR_FILES.items()}
        verified = module.authoritative_replay_gate(rows, predecessor)
        self.assertEqual(set(verified), set(module.AUTHORITATIVE_REPLAY_PREDECESSOR_FILES.values()))
        drifted = dict(rows)
        engine = "web/web\u524d\u7aef/GameEngine.js"
        drifted[engine] += b"\n// injected drift\n"
        with self.assertRaisesRegex(RuntimeError, "authoritative replay source drift: GameEngine.js"):
            module.authoritative_replay_gate(drifted, predecessor)
        engine_path = (ROOT / module.COLLECTOR_FILES[engine]).resolve()
        original_read_bytes = Path.read_bytes

        def drifted_read_bytes(path):
            raw = original_read_bytes(path)
            return raw + b"\n// injected drift\n" if path.resolve() == engine_path else raw

        with tempfile.TemporaryDirectory(prefix="lifeline-v3-drift-gate-") as directory, \
                patch.object(Path, "read_bytes", new=drifted_read_bytes):
            with self.assertRaisesRegex(RuntimeError, "authoritative replay source drift: GameEngine.js"):
                module.prepare(Path(directory) / module.RELEASE_ID)

    def test_running_node_is_explicit_and_frozen_into_dropin(self):
        with self.assertRaisesRegex(RuntimeError, "does not expose LIFELINE_NODE"):
            module.resolve_running_node({"PATH": os.environ.get("PATH", "")})
        node = module.resolve_running_node({"LIFELINE_NODE": sys.executable,
                                            "PATH": os.environ.get("PATH", "")})
        self.assertEqual(node, Path(sys.executable).resolve())
        with tempfile.TemporaryDirectory(prefix="lifeline-v3-dropin-test-") as directory:
            service = Path(directory) / "service"
            raw = module.collector_dropin(service, {"python": sys.executable, "node": str(node)})
        self.assertIn(f'Environment="LIFELINE_NODE={node}"\n'.encode(), raw)
        self.assertNotIn(b"LIFELINE_NODE=node", raw)

    def test_pre_dropin_failure_restarts_the_frozen_predecessor(self):
        state = {"collector": {}}
        configuration = {"MainPID": "0", "ActiveState": "inactive"}
        with patch.object(module, "unit_configuration", return_value=configuration), \
                patch.object(module, "systemctl") as systemctl, \
                patch.object(module, "wait_status", return_value={"enabled": True, "supported_versions": [1, 2]}) as wait:
            result = module.rollback_collector(Path("unused"), state)
        systemctl.assert_called_once_with("start", module.UNIT)
        wait.assert_called_once_with([1, 2])
        self.assertEqual(result["supported_versions"], [1, 2])

    def test_database_snapshot_is_read_only_and_counts_all_protocol_tables(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-v3-db-test-") as directory:
            database = Path(directory) / "contributions.sqlite3"
            connection = sqlite3.connect(database)
            try:
                for name in ("inbox", "inbox_v2", "inbox_v3"):
                    connection.execute(f"create table {name}(game_id text primary key, document text, received_at integer)")
                connection.execute("insert into inbox values ('a','{}',1)")
                connection.execute("insert into inbox_v2 values ('b','{}',2)")
                connection.commit()
            finally:
                connection.close()
            before = database.read_bytes()
            snapshot = module.database_snapshot(database)
            self.assertEqual(snapshot["counts"], {"inbox": 1, "inbox_v2": 1, "inbox_v3": 0})
            self.assertEqual(database.read_bytes(), before)

    def test_transfer_compiles_bootstrap_without_network_in_mock(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-v3-transfer-test-") as directory:
            output = Path(directory) / module.RELEASE_ID
            module.prepare(output)
            completed = type("Completed", (), {"returncode": 0})()
            with patch.object(module.subprocess, "run", return_value=completed) as invoked:
                module.transfer(output, "ubuntu@example.invalid", False)
            command = invoked.call_args.args[0]
            self.assertEqual(command[0], "ssh")
            self.assertIn("ubuntu@example.invalid", command)
            self.assertGreater(len(invoked.call_args.kwargs["input"]), 1000)

    def test_every_failure_after_stop_restores_predecessor_service_and_dropin(self):
        failure_points = ("stop", "show-after-stop", "journal", "backup", "migrate", "publish-before",
                          "publish-after", "daemon-reload", "start", "health")
        for failure_point in failure_points:
            with self.subTest(failure_point=failure_point), \
                    tempfile.TemporaryDirectory(prefix="lifeline-v3-recovery-test-") as directory:
                target = Path(directory)
                release_dir = target / module.RELEASE_ID
                release_dir.mkdir()
                service = release_dir / "service"
                service.mkdir()
                dropin = target / "systemd" / "91-replay-collection-v3.conf"
                dropin.parent.mkdir()
                active = {"value": True}
                injected = {"value": False}
                calls = []
                waits = []
                old_dropins = "/etc/systemd/system/lifeline-training-contributions.service.d/90-current.conf"
                before_configuration = {
                    "WorkingDirectory": "/collector-v2-current-sync-20261023-r2/web/backend",
                    "MainPID": "111",
                    "ActiveState": "active",
                    "SubState": "running",
                    "User": "ubuntu",
                    "FragmentPath": "/etc/systemd/system/lifeline-training-contributions.service",
                    "DropInPaths": old_dropins,
                }
                identity = {
                    "pid": 111,
                    "cwd": before_configuration["WorkingDirectory"],
                    "python": sys.executable,
                    "node": sys.executable,
                    "nodeSource": "running-service-environment:LIFELINE_NODE",
                    "database": {"path": str(target / "contributions.sqlite3"),
                                 "device": 7, "inode": 9,
                                 "counts": {"inbox": 4, "inbox_v2": 5}},
                    "serviceUid": 1000,
                }

                def configuration():
                    return {**before_configuration,
                            "MainPID": "111" if active["value"] else "0",
                            "ActiveState": "active" if active["value"] else "inactive",
                            "SubState": "running" if active["value"] else "dead",
                            "DropInPaths": old_dropins + ((" " + str(dropin)) if dropin.exists() else "")}

                def fake_systemctl(*arguments):
                    calls.append(arguments)
                    operation = arguments[0]
                    if operation == "stop":
                        active["value"] = False
                        if failure_point == "stop" and not injected["value"]:
                            injected["value"] = True
                            raise RuntimeError("injected stop ambiguity")
                        return b""
                    if operation == "show":
                        if failure_point == "show-after-stop" and not active["value"] and not injected["value"]:
                            injected["value"] = True
                            raise RuntimeError("injected post-stop status failure")
                        return b"111\n" if active["value"] else b"0\n"
                    if operation == "daemon-reload":
                        if failure_point == "daemon-reload" and dropin.exists() and not injected["value"]:
                            injected["value"] = True
                            raise RuntimeError("injected daemon-reload failure")
                        return b""
                    if operation == "start":
                        if failure_point == "start" and dropin.exists() and not injected["value"]:
                            injected["value"] = True
                            raise RuntimeError("injected v3 start failure")
                        active["value"] = True
                        return b""
                    raise AssertionError(arguments)

                def fake_wait(versions, timeout=15):
                    waits.append(versions)
                    if failure_point == "health" and versions == [1, 2, 3] and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected v3 health failure")
                    return {"enabled": True, "supported_versions": versions}

                real_save_atomic = module.save_atomic

                def fake_save_atomic(path, value):
                    if failure_point == "journal" and value.get("status") == "COLLECTOR_STOPPED" \
                            and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected journal failure")
                    return real_save_atomic(path, value)

                real_replace = os.replace
                pending = dropin.with_name(f".{dropin.name}.{module.RELEASE_ID}.pending")

                def fake_replace(source, destination):
                    is_publication = Path(source) == pending and Path(destination) == dropin
                    if is_publication and failure_point == "publish-before" and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected failure before final drop-in rename")
                    result = real_replace(source, destination)
                    if is_publication and failure_point == "publish-after" and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected failure after final drop-in rename")
                    return result

                def fake_backup(*_arguments):
                    if failure_point == "backup" and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected backup failure")
                    return {"path": str(release_dir / "before.sqlite3"), "sha256": "a" * 64, "bytes": 10}

                def fake_migrate(*_arguments):
                    if failure_point == "migrate" and not injected["value"]:
                        injected["value"] = True
                        raise RuntimeError("injected migration failure")
                    return {"status": "APPEND_ONLY_INBOX_V3_READY",
                            "counts": {"inbox": 4, "inbox_v2": 5, "inbox_v3": 0}}

                with ExitStack() as stack:
                    stack.enter_context(patch.object(module.sys, "platform", "linux"))
                    stack.enter_context(patch.object(module.os, "geteuid", return_value=0, create=True))
                    stack.enter_context(patch.object(module, "DROPIN", dropin))
                    stack.enter_context(patch.object(module, "extract_release", return_value=service))
                    stack.enter_context(patch.object(module, "unit_configuration", side_effect=configuration))
                    stack.enter_context(patch.object(module, "local_status", return_value={
                        "enabled": True, "supported_versions": [1, 2]}))
                    stack.enter_context(patch.object(module, "process_identity", return_value=identity))
                    stack.enter_context(patch.object(module, "run", return_value=b""))
                    stack.enter_context(patch.object(module, "synthetic_preflight", return_value={"status": "PASS"}))
                    stack.enter_context(patch.object(module, "stage_frontends", return_value=(
                        {"before": {}, "candidates": {}}, {})))
                    stack.enter_context(patch.object(module, "database_snapshot", return_value=identity["database"]))
                    stack.enter_context(patch.object(module, "backup_database", side_effect=fake_backup))
                    stack.enter_context(patch.object(module, "migrate_database", side_effect=fake_migrate))
                    stack.enter_context(patch.object(module, "rollback_frontends"))
                    stack.enter_context(patch.object(module, "systemctl", side_effect=fake_systemctl))
                    stack.enter_context(patch.object(module, "wait_status", side_effect=fake_wait))
                    stack.enter_context(patch.object(module, "save_atomic", side_effect=fake_save_atomic))
                    stack.enter_context(patch.object(module.os, "replace", side_effect=fake_replace))
                    with self.assertRaises(RuntimeError):
                        module.activate(release_dir, {})

                self.assertTrue(injected["value"])
                self.assertTrue(active["value"])
                self.assertFalse(os.path.lexists(dropin))
                self.assertFalse(os.path.lexists(pending))
                self.assertIn([1, 2], waits)
                receipt = json.loads((release_dir / "deployment.json").read_text(encoding="utf-8"))
                self.assertEqual(receipt["status"], "RECOVERED_PREDECESSOR")
                self.assertEqual(receipt["recoveryFailures"], [])


if __name__ == "__main__":
    unittest.main()
