"""Extend the reviewed legacy transaction to the complete topology bridge.

Only the four named source files are replaced. The database and service unit
stay in place; a code rollback never restores an older database snapshot.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import sys

spec = importlib.util.spec_from_file_location("legacy_release", Path(__file__).with_name("activate_legacy_release.py"))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
base, require = legacy.base, legacy.require
_unit_properties = base.unit_properties


def unit_properties(unit):
    props = _unit_properties(unit)
    # systemd omits this optional property even with --all when none is set.
    props.setdefault("EnvironmentFiles", "")
    return props


base.unit_properties = unit_properties
legacy.TARGETS = (
    "web/web后端/server.py", "web/tools/online_bot_bridge.mjs",
    "web/web后端/board_validation.py", "web/tools/online_bot_runtime.mjs",
)


class Adapter(legacy.Adapter):
    def check_payload(self):
        for name in legacy.TARGETS:
            expected = self.doc["files"][name]["sha256"]
            require(base.sha((self.payload / name).read_bytes()) == expected, "CANDIDATE_PAYLOAD_DRIFT")
            pending = self.pending["candidate"][name]
            if pending.exists():
                require(base.sha(pending.read_bytes()) == expected, "CANDIDATE_STAGING_DRIFT")
        require(base.tree(self.frontend) == self.doc["frontendFiles"], "FRONTEND_CANDIDATE_DRIFT")

    def prepare(self):
        super().prepare()
        self.check_payload()
        for name in legacy.TARGETS[2:]:
            target = self.stage.parent / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.payload / name, target)
            os.chown(target, 0, 1000)
            os.chmod(target, 0o640)
        rollback = self.run_dir / "rollback-payload"
        files = {}
        for name in legacy.TARGETS:
            target = rollback / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.before[name])
            files[name] = {"beforeSha256": self.doc["files"][name]["sha256"],
                           "sha256": self.doc["files"][name]["beforeSha256"]}
        probe_name = self.doc["probe"]["path"]
        require(probe_name == "legacy-probe.py", "PROBE_NAME")
        baseline_probe = self.doc["baselineProbe"]
        require(baseline_probe["path"] == "legacy-baseline-probe.py"
                and base.sha((self.payload / baseline_probe["path"]).read_bytes()) == baseline_probe["sha256"], "BASELINE_PROBE_DRIFT")
        shutil.copyfile(self.payload / baseline_probe["path"], rollback / probe_name)
        shutil.copyfile(self.payload / probe_name, rollback / "legacy-baseline-probe.py")
        self.rollback_doc = {"files": files, "probe": {"path": probe_name, "sha256": baseline_probe["sha256"]},
                             "baselineProbe": {"path": "legacy-baseline-probe.py", "sha256": self.doc["probe"]["sha256"]},
                             "frontendFiles": self.doc["frontendFiles"]}
        (self.run_dir / "rollback-manifest.json").write_text(json.dumps(self.rollback_doc, indent=2))
        self.snapshot_done = False

    def before_stop(self):
        super().before_stop()
        self.check_payload()
        require(base.tree(legacy.LIVE / "web/web前端") == self.live_front_hashes, "LIVE_FRONTEND_CHANGED_AFTER_PROBE")
        scan = base.writer_scan(self.database, legacy.BACK, self.props["ControlGroup"])
        require(all("service-control-group" in p["reasons"] for p in scan["writers"]), "EXTERNAL_DATABASE_WRITER")

    def preflight(self):
        super().preflight()
        # Candidate API must serve clients using the current live module graph
        # during the interval before the independent frontend exchange.
        live_front = legacy.LIVE / "web/web前端"
        live_hashes = base.tree(live_front)
        self.live_front_hashes = live_hashes
        staged_front = self.stage / "web前端"
        new_front = self.run_dir / "new-frontend-for-probe"
        staged_front.rename(new_front)
        original_probe = self.doc["probe"]
        try:
            shutil.copytree(live_front, staged_front)
            require(base.tree(staged_front) == live_hashes and base.tree(live_front) == live_hashes, "LIVE_FRONTEND_DRIFT")
            self.doc["probe"] = self.doc["baselineProbe"]
            super().preflight()
        finally:
            self.doc["probe"] = original_probe
            # Both directories were created under this new run only.
            require(staged_front.resolve().is_relative_to(self.run_dir), "PROBE_CLEANUP_PATH")
            shutil.rmtree(staged_front)
            new_front.rename(staged_front)

    def replace(self, role):
        if role == "candidate":
            self.check_payload()
        self.guard()
        require(base.unit_properties(legacy.UNIT)["MainPID"] == "0", "STOP_LEGACY_BEFORE_REPLACE")
        for name in legacy.TARGETS:
            current = legacy.LIVE / name
            pins = self.doc["files"][name]
            require(base.sha(current.read_bytes()) in (pins["beforeSha256"], pins["sha256"]), "UNOWNED_SOURCE_DRIFT")
            expected = pins["sha256"] if role == "candidate" else pins["beforeSha256"]
            if base.sha(current.read_bytes()) != expected:
                pending = self.pending[role][name]
                require(base.sha(pending.read_bytes()) == expected, "STAGING_HASH_MISMATCH")
                os.replace(pending, current); base.fsync_directory(current.parent)

    def stop(self):
        super().stop()
        require(not base.writer_scan(self.database, legacy.BACK, self.props["ControlGroup"])["writers"], "DATABASE_WRITERS_NOT_STOPPED")
        if not self.snapshot_done:
            self.snapshot_done = True
            # sqlite backup incorporates committed WAL pages, unlike copying
            # the main file. This private artifact is never used by rollback.
            directory = self.run_dir / "private-snapshot"
            directory.mkdir(); os.chown(directory, 1000, 1000); os.chmod(directory, 0o700)
            backup = directory / "quiescent-database.sqlite3"
            query = "import sqlite3,sys;from pathlib import Path;s=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d=sqlite3.connect(sys.argv[2]);s.backup(d);assert d.execute('PRAGMA quick_check').fetchall()==[('ok',)];d.close();s.close()"
            base.command([self.python, "-B", "-c", query, str(self.database), str(backup)], user=(1000, 1000))
            os.chmod(backup, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--frontend", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    require(args.check_only or args.execute, "EXECUTE_REQUIRED")
    raw = args.manifest.read_bytes()
    require(base.sha(raw) == args.manifest_sha256, "LEGACY_MANIFEST_HASH_MISMATCH")
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    adapter = Adapter(json.loads(raw), args.payload, args.run_dir, args.frontend, args.node)
    result = {"status": "STARTING", "databaseRestored": False}
    try:
        if args.check_only:
            adapter.acquire()
            try:
                adapter.prepare(); adapter.preflight(); adapter.before_stop()
                result = {"status": "PASS_LEGACY_RELEASE_PREFLIGHT", "liveChanged": False}
            finally:
                adapter.release()
        else:
            result = legacy.transact(adapter)
            result["status"] = "ACTIVATED_LEGACY_UNIFIED_RELEASE"
        result.update(databaseRestored=False, changedFiles=list(legacy.TARGETS),
                      manifestSha256=args.manifest_sha256,
                      rollbackManifestSha256=base.sha((adapter.run_dir / "rollback-manifest.json").read_bytes()),
                      rollbackPayload=str(adapter.run_dir / "rollback-payload"))
    except BaseException as error:
        result = {"status": "FAILED_INSPECT_TRANSACTION", "errorType": type(error).__name__,
                  "errorCode": str(error) if isinstance(error, base.GateError) else "DETAILS_OMITTED",
                  "databaseRestored": False}
        raise
    finally:
        (adapter.run_dir / "activation.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
