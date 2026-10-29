"""Hash-bound collector code exchange; retain the same live SQLite database.

Run only against the reviewed site manifest. Preflight uses an SQLite backup
and synthetic fixtures; rollback switches code and never restores old rows.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time
import urllib.request

helper = Path(__file__).with_name("activate_profile_service_live.py")
if not helper.exists():
    helper = Path(__file__).resolve().parents[2] / "wechat/tools/activate_profile_service_live.py"
spec = importlib.util.spec_from_file_location("collector_release_base", helper)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require = base.require
_unit_properties = base.unit_properties


def unit_properties(unit):
    props = _unit_properties(unit)
    props.setdefault("EnvironmentFiles", "")
    return props


base.unit_properties = unit_properties
LIVE = Path("/home/ubuntu/line-game/.deploy-artifacts/collector-v2-current-sync-20261023-r2/service")
UNIT = "lifeline-training-contributions.service"


def transact(adapter):
    adapter.acquire()
    stopped = changed = release = False
    try:
        adapter.prepare(); adapter.preflight(); adapter.before_stop()
        stopped = True
        adapter.stop(); adapter.snapshot()
        changed = True
        adapter.replace("candidate"); adapter.start(); adapter.verify("candidate")
        release = True
        return {"status": "ACTIVATED_COLLECTOR_UNIFIED_RELEASE", "databaseRestored": False}
    except BaseException:
        if not stopped:
            release = True
            raise
        try:
            adapter.stop()
            if changed:
                adapter.replace("baseline")
            adapter.start(); adapter.verify("baseline")
            release = True
        except BaseException:
            raise base.GateError("COLLECTOR_RECOVERY_UNCONFIRMED_KEEP_LOCK") from None
        raise base.GateError("COLLECTOR_FAILED_ORIGINAL_CODE_RECOVERED") from None
    finally:
        if release:
            adapter.release()


class Adapter:
    def __init__(self, doc, bundle, run_dir):
        require(sys.platform == "linux" and os.geteuid() == 0, "LINUX_ROOT_REQUIRED")
        self.doc, self.site = doc, doc["site"]
        self.site["properties"].setdefault("EnvironmentFiles", "")
        require(doc.get("kind") == "collector-unified-release-v1", "MANIFEST_KIND")
        require(self.site["unit"] == UNIT and self.site["liveRoot"] == str(LIVE), "SITE_IDENTITY")
        self.live, self.bundle = base.safe_path(LIVE), base.safe_path(bundle)
        self.database = base.safe_path(self.site["database"]["path"])
        require(str(self.database) == "/home/ubuntu/line-game-data/training-contributions-v1/contributions.sqlite3", "DATABASE_IDENTITY")
        self.run_dir = base.safe_path(run_dir, exists=False)
        require(not self.run_dir.exists() and self.run_dir.parent.parent == LIVE.parent.parent, "NEW_RUN_REQUIRED")
        for role in ("baseline", "candidate"):
            require(isinstance(doc[role], dict) and len(doc[role]) >= 9, "RUNTIME_INCOMPLETE")
            for name, digest in doc[role].items():
                require(isinstance(name, str) and not name.startswith("/") and "\\" not in name and ":" not in name
                        and all(p not in ("", ".", "..") for p in name.split("/"))
                        and re.fullmatch(r"[a-f0-9]{64}", digest), "INVALID_ENTRY")
        require(base.tree(self.live) == doc["baseline"], "BASELINE_DRIFT")
        require(base.tree(self.bundle / "service") == doc["candidate"], "CANDIDATE_DRIFT")
        self.props = base.unit_properties(UNIT)
        require(all(self.props[k] == self.site["properties"][k] for k in base.STATIC_PROPERTIES), "UNIT_DRIFT")
        self.original = self.capture()
        self.environment = base.relevant_environment(base.process_environment(self.original["pid"]))
        require(str(Path(self.environment["LIFELINE_CONTRIBUTIONS_DIR"]) / "contributions.sqlite3") == str(self.database), "DATABASE_ENVIRONMENT")
        self.check_database()
        base.create_run_directory(self.run_dir, 1000)
        self.lock = LIVE.parent.parent / ".collector-unified-release.lock"
        self.staged = self.run_dir / "staged-runtime"
        self.switched = False

    def capture(self):
        props = base.unit_properties(UNIT)
        require(props["ActiveState"] == "active" and props["SubState"] == "running", "COLLECTOR_NOT_RUNNING")
        result = base.process_identity(int(props["MainPID"]))
        require(result["uid"] == 1000 and result["cwd"] == str(self.live / "web/backend"), "PROCESS_IDENTITY")
        return result

    def check_database(self):
        info = base.regular(self.database)
        require((info.st_dev, info.st_ino) == (self.site["database"]["device"], self.site["database"]["inode"]), "DATABASE_REPLACED")

    def acquire(self):
        self.fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self.lock_id = os.fstat(self.fd)
        os.write(self.fd, json.dumps({"pid": os.getpid(), "run": str(self.run_dir)}).encode())
        os.fsync(self.fd)

    def guard(self):
        info = base.regular(self.lock)
        require((info.st_dev, info.st_ino) == (self.lock_id.st_dev, self.lock_id.st_ino), "LOCK_REPLACED")
        self.check_database()
        props = base.unit_properties(UNIT)
        for k in base.STATIC_PROPERTIES:
            require(props[k] == self.props[k] or (k == "ControlGroup" and not props[k] and props["MainPID"] == "0"), "UNIT_CHANGED")
        require(all(base.sha(base.safe_path(p).read_bytes()) == digest for p, digest in self.site["unitFiles"].items()), "UNIT_FILE_CHANGED")

    def release(self):
        self.guard(); os.close(self.fd); self.lock.unlink(); base.fsync_directory(self.lock.parent)

    def prepare(self):
        self.guard()
        require(base.tree(self.bundle / "service") == self.doc["candidate"], "CANDIDATE_DRIFT")
        shutil.copytree(self.bundle / "service", self.staged)
        for directory, _, names in os.walk(self.staged):
            os.chown(directory, 0, 1000); os.chmod(directory, 0o750)
            for name in names:
                os.chown(Path(directory) / name, 0, 1000); os.chmod(Path(directory) / name, 0o640)
        require(base.tree(self.staged) == self.doc["candidate"], "STAGING_DRIFT")

    def preflight(self):
        probe = self.bundle / "collector-probe.py"
        require(base.sha(probe.read_bytes()) == self.doc["probeSha256"], "PROBE_DRIFT")
        for name, digest in self.doc["fixtureHashes"].items():
            require(re.fullmatch(r"v[1234]\.json", name) and base.sha((self.bundle / "fixtures" / name).read_bytes()) == digest, "FIXTURE_DRIFT")
        temp = self.run_dir / "probe-data"
        temp.mkdir(); os.chown(temp, 1000, 1000); os.chmod(temp, 0o700)
        copy = temp / "migration.sqlite3"
        query = "import sqlite3,sys;from pathlib import Path;s=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()"
        base.command([self.site["python"], "-B", "-c", query, str(self.database), str(copy)], user=(1000, 1000))
        os.chown(copy, 1000, 1000); os.chmod(copy, 0o600)
        raw = base.command([self.site["python"], "-B", str(probe), "--service-root", str(self.staged),
                            "--fixtures", str(self.bundle / "fixtures"), "--data", str(temp), "--node", self.site["node"],
                            "--version", str(max(self.doc["supportedVersions"]))],
                           user=(1000, 1000), env={**base.SYSTEM_ENV, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=120)
        result = json.loads(raw)
        require(result.get("status") == "PASS_COLLECTOR_MIGRATION_AND_FIXTURES", "PROBE_FAILED")
        require(base.tree(self.staged) == self.doc["candidate"], "PROBE_CHANGED_SOURCE")
        (self.run_dir / "preflight.json").write_text(json.dumps(result, indent=2))

    def before_stop(self):
        self.guard()
        require(self.capture() == self.original, "PROCESS_DRIFT")
        require(base.tree(self.live) == self.doc["baseline"] and base.tree(self.staged) == self.doc["candidate"], "RUNTIME_DRIFT")
        require(base.relevant_environment(base.process_environment(self.original["pid"])) == self.environment, "ENVIRONMENT_DRIFT")
        scan = base.writer_scan(self.database, self.live / "web/backend", self.props["ControlGroup"])
        require(all("service-control-group" in p["reasons"] for p in scan["writers"]), "EXTERNAL_DATABASE_WRITER")

    def stop(self):
        self.guard(); base.command(["systemctl", "stop", UNIT], timeout=35)
        props = base.unit_properties(UNIT)
        require(props["MainPID"] == "0" and props["ActiveState"] in ("inactive", "failed"), "NOT_STOPPED")
        require(not base.writer_scan(self.database, self.live / "web/backend", self.props["ControlGroup"])["writers"], "DATABASE_WRITERS_NOT_STOPPED")

    def snapshot(self):
        directory = self.run_dir / "private-snapshot"
        directory.mkdir(); os.chown(directory, 1000, 1000); os.chmod(directory, 0o700)
        target = directory / "quiescent-database.sqlite3"
        query = "import sqlite3,sys;from pathlib import Path;s=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d=sqlite3.connect(sys.argv[2]);s.backup(d);assert d.execute('PRAGMA quick_check').fetchall()==[('ok',)];d.close();s.close()"
        base.command([self.site["python"], "-B", "-c", query, str(self.database), str(target)], user=(1000, 1000))
        os.chmod(target, 0o600)

    def replace(self, role):
        self.guard()
        require(base.unit_properties(UNIT)["MainPID"] == "0", "STOP_BEFORE_EXCHANGE")
        live, staged = base.tree(self.live), base.tree(self.staged)
        if live == self.doc[role]:
            return
        other = "baseline" if role == "candidate" else "candidate"
        require(live == self.doc[other] and staged == self.doc[role], "EXCHANGE_DRIFT")
        base.exchange(self.live, self.staged)

    def start(self):
        self.guard(); base.command(["systemctl", "start", UNIT], timeout=35)

    def verify(self, role):
        expected = self.doc["supportedVersions" if role == "candidate" else "baselineSupportedVersions"]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(20):
            try:
                with opener.open("http://127.0.0.1:8005/api/training/contributions/status", timeout=3) as response:
                    data = json.load(response)
                require(data.get("enabled") is True and data.get("supported_versions") == expected, "CAPABILITY_HEALTH")
                current = self.capture()
                require(base.relevant_environment(base.process_environment(current["pid"])) == self.environment, "ENVIRONMENT_CHANGED")
                self.guard()
                require(base.tree(self.live) == self.doc[role], "LIVE_DRIFT")
                return
            except (OSError, ValueError):
                time.sleep(.3)
        raise base.GateError("COLLECTOR_HEALTH_FAILED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("manifest", "bundle", "run-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    require(args.check_only or args.execute, "EXECUTE_REQUIRED")
    raw = args.manifest.read_bytes()
    require(base.sha(raw) == args.manifest_sha256, "MANIFEST_HASH")
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    adapter = Adapter(json.loads(raw), args.bundle, args.run_dir)
    result = {"status": "STARTING"}
    try:
        if args.check_only:
            adapter.acquire()
            try:
                adapter.prepare(); adapter.preflight(); adapter.before_stop()
                result = {"status": "PASS_COLLECTOR_PREFLIGHT_NO_LIVE_CHANGE"}
            finally:
                adapter.release()
        else:
            result = transact(adapter)
        result.update(databaseRestored=False, manifestSha256=args.manifest_sha256,
                      previousRuntime=str(adapter.staged), supportedVersions=adapter.doc["supportedVersions"])
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
