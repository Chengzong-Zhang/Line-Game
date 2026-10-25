"""Activate a manifest-pinned complete WeChat runtime, preserving live databases.

Reuses the reviewed profile activation primitives. The actual running tree is
the rollback; neither configuration nor a historical database is installed.
"""
from __future__ import annotations

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

spec = importlib.util.spec_from_file_location("service_release_primitives", Path(__file__).with_name("activate_profile_service_live.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require, GateError = base.require, base.GateError
METADATA = "service-manifest.json"


def retained_metadata(doc):
    """Retain optional metadata only when both exact inventories require it."""
    previous = doc["baseline"].get(METADATA)
    candidate = doc["candidate"].get(METADATA)
    require((previous is None) == (candidate is None), "METADATA_PRESENCE_MISMATCH")
    require(previous == candidate, "RETAINED_METADATA_HASH_MISMATCH")
    expected = {METADATA: previous} if previous is not None else {}
    require(doc["site"].get("baselineExtras") == expected, "METADATA_SITE_MISMATCH")
    return previous


def load_manifest(path, expected):
    raw = base.safe_path(path).read_bytes()
    require(re.fullmatch(r"[a-f0-9]{64}", expected) and base.sha(raw) == expected, "MANIFEST_HASH_MISMATCH")
    doc = json.loads(raw)
    require(doc.get("schemaVersion") == 1 and doc.get("kind") == "wechat-complete-runtime-release", "MANIFEST_SCHEMA")
    require(re.fullmatch(r"wechat-service-all-[0-9]{8}-r[1-9][0-9]*", doc.get("releaseId", "")), "RELEASE_ID")
    for role in ("baseline", "candidate"):
        entries = doc[role]
        require(isinstance(entries, dict) and len(entries) >= 51, "INCOMPLETE_RUNTIME")
        for name, digest in entries.items():
            require(isinstance(name, str) and not name.startswith("/") and "\\" not in name and ":" not in name
                    and all(part not in ("", ".", "..") for part in name.split("/"))
                    and isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest), "MANIFEST_ENTRY")
    require(doc["baseline"].get("web/web后端/wechat_online.py") == "90ea2995bab5447f4ccd06c46a633d67c83c9565c0c288bb8ac4e72772e91e0c"
            and doc["baseline"].get("web/web前端/GameEngine.js") == "469b9c47377f47633589c29039ee849922ec525c17be859945209622586b8238", "BASELINE_PINS")
    retained_metadata(doc)
    return doc


class ReleaseAdapter(base.LiveAdapter):
    def __init__(self, doc, bundle, run_dir):
        require(sys.platform == "linux" and os.geteuid() == 0, "LINUX_ROOT_REQUIRED")
        self.doc, self.site = doc, doc["site"]
        self.metadata_sha256 = retained_metadata(doc)
        self.bundle = base.safe_path(bundle)
        self.live = base.safe_path(self.site["liveRoot"])
        require(str(self.live) == "/home/ubuntu/line-game/.deploy-artifacts/wechat-service-20261021/release"
                and self.site["unit"] == "lifeline-wechat.service"
                and self.site["uid"] == self.site["gid"] == 1000
                and self.site["user"] == "ubuntu", "SERVICE_IDENTITY")
        self.database = base.safe_path(self.site["database"]["path"])
        self.legacy = base.safe_path(self.site["legacyDatabase"]["path"])
        require(self.database != self.legacy and self.live not in self.database.parents and self.live not in self.legacy.parents, "DATABASE_SEPARATION")
        require(self.site["healthUrl"] == "http://127.0.0.1:8006/api/wechat/status"
                and set(self.site["unitProperties"]) == set(base.STATIC_PROPERTIES), "SITE_PROPERTIES")
        self.run_dir = base.safe_path(run_dir, exists=False)
        require(not self.run_dir.exists() and self.run_dir.parent.is_dir()
                and self.run_dir.parent == self.live.parent.parent, "NEW_SIBLING_RUN_REQUIRED")
        self.files = {"baseline": doc["baseline"], "rollback": doc["baseline"], "candidate": doc["candidate"]}
        self.check_database()
        self.verify_unit()
        require(base.tree(self.live) == self.files["baseline"], "LIVE_BASELINE_DRIFT")
        self.verify_bundle()
        self.original = self.capture_running(base.unit_properties(self.site["unit"]))
        self.environment = base.process_environment(self.original["pid"])
        self.check_environment(self.environment)
        base.create_run_directory(self.run_dir, self.site["gid"])
        self.journal = self.run_dir / "journal.jsonl"
        self.journal.touch(mode=0o600, exist_ok=False)
        self.recovering = self.journal_incomplete = False
        self.prepared = {}
        self.lock = self.live.parent / ".wechat-profile-activation.lock"

    def verify_bundle(self):
        candidate = {name: digest for name, digest in self.files["candidate"].items() if name != METADATA}
        require(base.tree(self.bundle / "service") == candidate, "BUNDLE_RUNTIME_DRIFT")
        require(base.sha((self.bundle / "probe.py").read_bytes()) == self.doc["probeSha256"], "BUNDLE_PROBE_DRIFT")

    def stage_role(self, role, destination):
        require(role in ("candidate", "rollback"), "INVALID_STAGE_ROLE")
        source = self.bundle / "service" if role == "candidate" else self.live
        shutil.copytree(source, destination)
        if role == "candidate" and self.metadata_sha256 is not None:
            metadata = (self.live / METADATA).read_bytes()
            require(base.sha(metadata) == self.metadata_sha256, "RETAINED_METADATA_DRIFT")
            (destination / METADATA).write_bytes(metadata)
        require(base.tree(destination) == self.files[role], "STAGED_TREE_DRIFT")

    def prepare(self):
        require(self.run_dir.stat().st_dev == self.live.stat().st_dev, "SAME_FILESYSTEM_REQUIRED")
        for role in ("candidate", "rollback"):
            destination = self.run_dir / role
            self.stage_role(role, destination)
            for directory, _, names in os.walk(destination):
                os.chown(directory, 0, self.site["gid"])
                os.chmod(directory, 0o750)
                for name in names:
                    path = Path(directory) / name
                    os.chown(path, 0, self.site["gid"])
                    os.chmod(path, 0o640)
            require(base.tree(destination) == self.files[role], "STAGED_TREE_DRIFT")
            self.prepared[role] = destination
        left, right = self.run_dir / "exchange-left", self.run_dir / "exchange-right"
        left.mkdir(); right.mkdir()
        (left / "left").write_bytes(b"left")
        (right / "right").write_bytes(b"right")
        base.exchange(left, right)
        require((left / "right").read_bytes() == b"right" and (right / "left").read_bytes() == b"left", "ATOMIC_EXCHANGE_PROBE")
        base.exchange(left, right)
        self.event("FULL_RUNTIME_STAGED_ROLLBACK_RETAINED")

    def preflight(self):
        super().preflight()
        stage = self.prepared["candidate"]
        probe_source = (self.bundle / "probe.py").read_bytes()
        require(base.sha(probe_source) == self.doc["probeSha256"], "PROBE_DRIFT")
        probe = self.run_dir / "probe.py"
        probe.write_bytes(probe_source)
        os.chown(probe, 0, self.site["gid"]); os.chmod(probe, 0o640)
        environment = {key: value for key, value in self.environment.items() if key.upper() in ("PATH", "LANG", "LC_ALL", "TZ")}
        environment["LIFELINE_NODE"] = self.site["node"]
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        raw = base.command([self.site["python"], "-B", str(probe), "--service-root", str(stage)],
                           env=environment, user=(self.site["uid"], self.site["gid"]), cwd=stage, timeout=120)
        result = json.loads(raw)
        require(result.get("status") == "PASS_SERVICE_RELEASE_COMPATIBILITY", "COMPATIBILITY_PROBE_FAILED")
        require(base.tree(stage) == self.files["candidate"], "PROBE_CHANGED_SOURCE")
        self.event("V2_V3_SQLITE_NODE_PROBE_PASSED", checks=result["checks"])

    def before_stop(self):
        self.verify_unit(); self.check_database(); self.verify_bundle()
        require(base.tree(self.live) == self.files["baseline"], "LIVE_BASELINE_DRIFT")
        current = self.capture_running(base.unit_properties(self.site["unit"]))
        require(current == self.original and base.relevant_environment(base.process_environment(current["pid"])) == base.relevant_environment(self.environment), "PROCESS_DRIFT")
        scan = base.writer_scan(self.database, self.live, self.site["unitProperties"]["ControlGroup"])
        require(any(item["pid"] == current["pid"] for item in scan["writers"])
                and all("service-control-group" in item["reasons"] for item in scan["writers"]), "EXTERNAL_DATABASE_WRITER")
        self.event("BASELINE_AND_WRITERS_VERIFIED")

    def health(self, role):
        # The baseline already has schema 3; the old profile upgrader assumed 1/2.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(12):
            try:
                with opener.open(self.site["healthUrl"], timeout=3) as response:
                    result = json.loads(response.read(8193))
                require(result.get("enabled") is True and result.get("accountProfile") is True
                        and result.get("webLogin") is True and result.get("webAuthMode") == "password", "CAPABILITY_HEALTH")
                if role == "candidate":
                    require(result.get("rulesVersion") == "territory-v3"
                            and result.get("supportedRulesVersions") == ["territory-v2", "territory-v3"]
                            and result.get("roomSettings") is True and result.get("undoVoting") is True, "RULES_CAPABILITY_HEALTH")
                else:
                    require(result.get("rulesVersion") == "territory-v2", "BASELINE_RULES_HEALTH")
                self.check_database(); self.verify_unit()
                require(base.tree(self.live) == self.files[role], "LIVE_RUNTIME_DRIFT")
                query = "import sqlite3,sys,json;from pathlib import Path;d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d.execute('PRAGMA query_only=ON');d.execute('BEGIN');print(json.dumps({'schema':d.execute('PRAGMA user_version').fetchone()[0],'ok':d.execute('PRAGMA quick_check').fetchall()==[('ok',)]}));d.close()"
                schema = json.loads(base.command([self.site["python"], "-B", "-c", query, str(self.database)], user=(self.site["uid"], self.site["gid"])))
                require(schema == {"schema": 3, "ok": True}, "DATABASE_HEALTH")
                self.event("HEALTH_PASSED", role=role, rulesVersion=result["rulesVersion"])
                return
            except (OSError, ValueError):
                time.sleep(0.5)
        raise GateError("HEALTH_FAILED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight", "activate"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    require(args.command != "activate" or args.execute, "EXECUTE_REQUIRED")
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda _sig, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
    adapter = ReleaseAdapter(load_manifest(args.manifest, args.expected_sha256), args.bundle, args.run_dir)
    if args.command == "preflight":
        adapter.acquire()
        try:
            adapter.prepare(); adapter.preflight(); adapter.before_stop()
            result = {"status": "PREFLIGHT_PASSED_NO_LIVE_CHANGE"}
        finally:
            adapter.release()
    else:
        result = base.transact(adapter)
        if result["status"] == "ACTIVATED_PROFILE_SERVICE":
            result["status"] = "ACTIVATED_SERVICE_RELEASE"
    result.update(releaseId=adapter.doc["releaseId"], databaseRestored=False, runtimeFiles=len(adapter.files["candidate"]))
    (adapter.run_dir / "activation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return 0 if result["status"] in ("ACTIVATED_SERVICE_RELEASE", "PREFLIGHT_PASSED_NO_LIVE_CHANGE") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"status": "SERVICE_RELEASE_NOT_CONFIRMED", "code": str(error) if isinstance(error, GateError) else "OPERATION_FAILED", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
