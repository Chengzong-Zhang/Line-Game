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
R6_MANIFEST_SHA256 = "be66a221143f501ecb6b20869c333558d0c6279b96c89ba36a9ccdc9060d03d7"
R6_PREFIX = "ranked-predecessor-r6"
METADATA = "service-manifest.json"
ARTIFACTS_ROOT = Path("/home/ubuntu/line-game/.deploy-artifacts")


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
    path = base.safe_path(path)
    base.regular(path)
    raw = path.read_bytes()
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
    predecessor = base.safe_path(path.parent / "service" / R6_PREFIX / "release-manifest.json")
    base.regular(predecessor)
    raw_predecessor = predecessor.read_bytes()
    require(base.sha(raw_predecessor) == R6_MANIFEST_SHA256, "R6_MANIFEST_DRIFT")
    r6 = json.loads(raw_predecessor)
    require(r6.get("schemaVersion") == 1 and r6.get("kind") == "wechat-complete-runtime-release"
            and r6.get("releaseId") == "wechat-service-all-20261029-r6"
            and isinstance(r6.get("candidate"), dict) and len(r6["candidate"]) == 266, "R6_MANIFEST_SCHEMA")
    require(doc["baseline"] == r6["candidate"], "R6_BASELINE_INVENTORY_DRIFT")
    require(doc["candidate"].get(R6_PREFIX + "/release-manifest.json") == R6_MANIFEST_SHA256,
            "R6_MANIFEST_NOT_IN_CANDIDATE")
    nested = {name[len(R6_PREFIX + "/service/"):]: digest for name, digest in doc["candidate"].items()
              if name.startswith(R6_PREFIX + "/service/")}
    require(nested == r6["candidate"], "R6_PREDECESSOR_INVENTORY_DRIFT")
    expected_nested = {R6_PREFIX + "/release-manifest.json", *(R6_PREFIX + "/service/" + name for name in nested)}
    require({name for name in doc["candidate"] if name.startswith(R6_PREFIX + "/")} == expected_nested,
            "R6_PREDECESSOR_EXTRA_FILES")
    require(base.tree(path.parent / "service" / R6_PREFIX / "service") == r6["candidate"],
            "R6_PREDECESSOR_TREE_DRIFT")
    require(doc["site"].get("database", {}).get("path") == "/var/lib/lifeline-wechat/wechat.sqlite3"
            and doc["site"]["database"].get("device") == 64514
            and doc["site"]["database"].get("inode") == 1053174, "DATABASE_IDENTITY_PIN")
    require(doc["site"] == r6.get("site"), "R6_SITE_DRIFT")
    retained_metadata(doc)
    return doc


def require_health_capabilities(result, role):
    require(result.get("enabled") is True and result.get("accountProfile") is True
            and result.get("webLogin") is True and result.get("webAuthMode") == "password", "CAPABILITY_HEALTH")
    if role == "candidate":
        require(result.get("rulesVersion") == "territory-v3"
                and result.get("supportedRulesVersions") == ["territory-v2", "territory-v3", "surface-v1"]
                and result.get("topologyProtocols") == ["board-topology-v1"]
                and result.get("boardHashSchema") == "board-hash-v1"
                and result.get("rootRulesVersions") == ["root-v1", "root-v2"]
                and result.get("roomSettings") is True and result.get("undoVoting") is True, "RULES_CAPABILITY_HEALTH")
    else:
        require_health_capabilities(result, "candidate")



# Runs as the service user against the same database, emitting counts only.
# No room, player, account, action, or exception details leave the subprocess.
ROLLBACK_SCAN_SOURCE = r"""
import json, sqlite3, sys, time
from pathlib import Path

R6 = '4d36330909bacc0f2e69657da168b01194a617536d8589048b45c26de013ab6a'
# document is consumed only inside SQLite. This query returns one aggregate
# row; it never projects a room document, account, player, or action value.
query = '''
WITH classified AS (
 SELECT
  CASE WHEN json_valid(document) = 0 OR typeof(expires) != 'integer' THEN 1
       WHEN json_type(document) != 'object'
         OR COALESCE(json_type(document,'$.status'),'missing') != 'text'
         OR json_extract(document,'$.status') NOT IN ('waiting','playing','finished','closed')
         OR COALESCE(json_type(document,'$.settings'),'missing') != 'object'
         OR COALESCE(json_type(document,'$.state'),'missing') != 'object'
         OR COALESCE(json_type(document,'$.expiresAt'),'missing') != 'integer'
         OR json_extract(document,'$.expiresAt') != expires
         OR (json_type(document,'$.pendingSettings') IS NOT NULL
             AND COALESCE(json_type(document,'$.pendingSettings'),'missing') NOT IN ('null','object'))
         OR COALESCE(json_type(document,'$.settings.playerCount'),'missing') != 'integer'
         OR json_extract(document,'$.settings.playerCount') NOT BETWEEN 2 AND 15
         OR COALESCE(json_type(document,'$.settings.rulesVersion'),'missing') != 'text'
         OR json_extract(document,'$.settings.rulesVersion') NOT IN ('territory-v2','territory-v3','surface-v1')
         OR COALESCE(json_type(document,'$.state.currentPlayer'),'missing') != 'text'
         OR length(json_extract(document,'$.state.currentPlayer')) = 0
         OR COALESCE(json_type(document,'$.state.stateHash'),'missing') != 'text'
         OR length(json_extract(document,'$.state.stateHash')) = 0
         OR COALESCE(json_type(document,'$.state.gameOver'),'missing') NOT IN ('true','false')
         OR COALESCE(json_type(document,'$.players'),'missing') != 'object'
         OR NOT EXISTS (SELECT 1 FROM json_each(document,'$.players'))
         OR COALESCE(json_type(document,'$.actions'),'missing') != 'array'
         OR COALESCE(json_type(document,'$.seq'),'missing') != 'integer'
         OR json_extract(document,'$.seq') < 0
         OR COALESCE(json_type(document,'$.matchId'),'missing') != 'text'
         OR length(json_extract(document,'$.matchId')) = 0
         OR (json_type(document,'$.rankedAI') IS NOT NULL
             AND COALESCE(json_type(document,'$.rankedAI'),'missing') NOT IN ('text','true','false'))
         OR (json_type(document,'$.rankedAI') = 'text' AND length(json_extract(document,'$.rankedAI')) = 0)
         OR (COALESCE(json_extract(document,'$.rankedAI'),0) != 0
             AND COALESCE(json_type(document,'$.rankedContext'),'missing') != 'object')
         OR (COALESCE(json_extract(document,'$.rankedAI'),0) = 0
             AND json_type(document,'$.rankedContext') IS NOT NULL)
         OR (json_type(document,'$.rankedContext') = 'object'
             AND (COALESCE(json_type(document,'$.rankedContext.runtime'),'missing') != 'text'
                  OR length(json_extract(document,'$.rankedContext.runtime')) != 64
                  OR json_extract(document,'$.rankedContext.runtime') GLOB '*[^0-9a-f]*'))
         OR EXISTS (SELECT 1 FROM json_tree(document) WHERE key IS NOT NULL
                    GROUP BY parent, key HAVING count(*) > 1)
       THEN 1 ELSE 0 END AS bad,
  CASE WHEN json_valid(document) THEN json_extract(document,'$.status') ELSE NULL END AS status,
  CASE WHEN json_valid(document) THEN json_type(document,'$.rankedContext') ELSE NULL END AS context_type,
  CASE WHEN json_valid(document) THEN json_extract(document,'$.rankedContext.runtime') ELSE NULL END AS runtime,
  CASE WHEN json_valid(document) THEN EXISTS (SELECT 1 FROM json_tree(document) WHERE key = 'turnOrder') ELSE 0 END AS has_order
 FROM wx_rooms
 WHERE typeof(expires) != 'integer' OR expires > ?
)
SELECT
 COALESCE(SUM(CASE WHEN bad=0 AND status IN ('waiting','playing') AND context_type IS NULL THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN bad=0 AND status IN ('waiting','playing') AND context_type='object' AND runtime=? THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN bad=0 AND has_order THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN bad=0 AND context_type='object' AND runtime != ? THEN 1 ELSE 0 END),0),
 COALESCE(SUM(bad),0)
FROM classified
'''
db = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True, timeout=5)
try:
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    if db.execute('PRAGMA user_version').fetchone()[0] != 6:
        raise ValueError('schema')
    counts = db.execute(query, (int(time.time()), R6, R6)).fetchone()
finally:
    db.close()
keys = ('activeOrdinary','activeRankedR6','turnOrderRooms','otherRuntimeRooms','unknownRooms')
print(json.dumps(dict(zip(keys, counts)), sort_keys=True))
"""


def require_r6_rollback_safe(adapter):
    adapter.assert_quiescent()
    raw = base.command([adapter.site["python"], "-B", "-c", ROLLBACK_SCAN_SOURCE, str(adapter.database)],
                       user=(adapter.site["uid"], adapter.site["gid"]), timeout=120)
    result = json.loads(raw)
    keys = {"activeOrdinary", "activeRankedR6", "turnOrderRooms", "otherRuntimeRooms", "unknownRooms"}
    require(isinstance(result, dict) and set(result) == keys
            and all(type(value) is int and value >= 0 for value in result.values()), "ROLLBACK_SCAN_INVALID")
    adapter.assert_quiescent()
    adapter.event("R6_ROLLBACK_ROOM_AGGREGATE", **result)
    require(not (result["turnOrderRooms"] or result["otherRuntimeRooms"] or result["unknownRooms"]),
            "R6_ROLLBACK_INCOMPATIBLE_OR_UNKNOWN_ROOMS")


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
        require(base.sha((self.bundle / "rollback-probe.py").read_bytes()) == self.doc.get("rollbackProbeSha256"), "ROLLBACK_PROBE_DRIFT")
        require(base.sha((self.bundle / "rehearsal.py").read_bytes()) == self.doc.get("rehearsalSha256"), "REHEARSAL_DRIFT")

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
        query = "import sqlite3,sys,json;from pathlib import Path;d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d.execute('PRAGMA query_only=ON');d.execute('BEGIN');print(json.dumps({'schema':d.execute('PRAGMA user_version').fetchone()[0],'ok':d.execute('PRAGMA quick_check').fetchall()==[('ok',)]}));d.close()"
        schema = json.loads(base.command([self.site["python"], "-B", "-c", query, str(self.database)],
                                         user=(self.site["uid"], self.site["gid"])))
        require(schema == {"schema": 6, "ok": True}, "BASELINE_SCHEMA_HEALTH")
        rehearsal_source = (self.bundle / "rehearsal.py").read_bytes()
        require(base.sha(rehearsal_source) == self.doc.get("rehearsalSha256"), "REHEARSAL_DRIFT")
        rehearsal = self.run_dir / "rehearsal.py"
        rehearsal.write_bytes(rehearsal_source)
        os.chown(rehearsal, 0, self.site["gid"]); os.chmod(rehearsal, 0o640)
        private = self.run_dir / "private-preflight"
        private.mkdir(mode=0o700); os.chown(private, self.site["uid"], self.site["gid"]); os.chmod(private, 0o700)
        env = {key: value for key, value in self.environment.items() if key.upper() in ("PATH", "LANG", "LC_ALL", "TZ")}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        raw = base.command([self.site["python"], "-B", str(rehearsal),
                            "--candidate", str(self.prepared["candidate"]), "--rollback", str(self.prepared["rollback"]),
                            "--workdir", str(private)], env=env, user=(self.site["uid"], self.site["gid"]), timeout=120)
        require(json.loads(raw) == {"status":"PASS_SCHEMA6_SYNTHETIC_BOTH_REVISIONS", "schema":6}, "REHEARSAL_FAILED")
        private.rmdir()
        self.event("SCHEMA6_SYNTHETIC_BOTH_REVISIONS_PASSED")
        stage = self.prepared["candidate"]
        probe_source = (self.bundle / ("rollback-probe.py" if getattr(self, "rollback_operation", False) else "probe.py")).read_bytes()
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

    def snapshot(self):
        """Verify the stopped original database in place; make no DB copy."""
        self.assert_quiescent()
        require(base.tree(self.live) == self.files["baseline"], "BASELINE_DRIFT_AFTER_STOP")
        query = ("import sqlite3,sys,json;from pathlib import Path;"
                 "d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);"
                 "d.execute('PRAGMA query_only=ON');d.execute('BEGIN');"
                 "v=d.execute('PRAGMA user_version').fetchone()[0];"
                 "ok=d.execute('PRAGMA quick_check').fetchall()==[('ok',)];d.close();"
                 "print(json.dumps({'schema':v,'ok':ok}))")
        raw = base.command([self.site["python"], "-B", "-c", query, str(self.database)],
                           user=(self.site["uid"], self.site["gid"]), timeout=120)
        require(json.loads(raw) == {"schema": 6, "ok": True}, "DATABASE_READ_ONLY_CHECK_FAILED")
        self.assert_quiescent()
        self.event("QUIESCENT_DATABASE_READ_ONLY_VERIFIED", schema=6, copied=False)

    def switch(self, role, expected):
        # A failed activation can already have served new games before health
        # failed; an automatic switch to r6 is subject to the same room gate.
        if role == "rollback" and getattr(self, "recovering", False):
            if expected == self.files["baseline"] and base.tree(self.live) == expected:
                # A manual rollback gate failed before exchange. The live tree
                # is already the new release; avoid any redundant exchange.
                require(base.tree(self.prepared["rollback"]) == expected, "STAGED_TREE_DRIFT")
                self.event("RECOVERY_EXCHANGE_NOT_NEEDED")
                return
            require_r6_rollback_safe(self)
        super().switch(role, expected)

    def health(self, role):
        # Both current baseline and candidate must preserve the schema-6 database.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(12):
            try:
                with opener.open(self.site["healthUrl"], timeout=3) as response:
                    result = json.loads(response.read(8193))
                expected_role = ("baseline" if role == "candidate" else "candidate") if getattr(self, "rollback_operation", False) else role
                require_health_capabilities(result, expected_role)
                self.check_database(); self.verify_unit()
                require(base.tree(self.live) == self.files[role], "LIVE_RUNTIME_DRIFT")
                query = "import sqlite3,sys,json;from pathlib import Path;d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);d.execute('PRAGMA query_only=ON');d.execute('BEGIN');print(json.dumps({'schema':d.execute('PRAGMA user_version').fetchone()[0],'ok':d.execute('PRAGMA quick_check').fetchall()==[('ok',)]}));d.close()"
                schema = json.loads(base.command([self.site["python"], "-B", "-c", query, str(self.database)], user=(self.site["uid"], self.site["gid"])))
                require(schema == {"schema": 6, "ok": True}, "DATABASE_HEALTH")
                self.event("HEALTH_PASSED", role=role, rulesVersion=result["rulesVersion"])
                return
            except (OSError, ValueError):
                time.sleep(0.5)
        raise GateError("HEALTH_FAILED")


class RollbackAdapter(ReleaseAdapter):
    """Transactionally restore the captured old code while retaining the live DB."""
    def __init__(self, doc, bundle, run_dir, previous_run):
        self.rollback_operation = True
        self.previous_run = base.safe_path(previous_run)
        require(self.previous_run.parent == ARTIFACTS_ROOT, "PREVIOUS_RUN_LOCATION")
        receipt = json.loads((self.previous_run / "activation.json").read_text())
        require(receipt.get("status") == "ACTIVATED_SERVICE_RELEASE"
                and receipt.get("releaseId") == doc["releaseId"]
                and receipt.get("databaseRestored") is False, "PREVIOUS_ACTIVATION_NOT_CONFIRMED")
        self.prior_tree = self.previous_run / "rollback"
        require(base.tree(self.prior_tree) == doc["baseline"], "PRIOR_ROLLBACK_TREE_DRIFT")
        require(re.fullmatch(r"[a-f0-9]{64}", doc.get("rollbackProbeSha256", "")) is not None,
                "ROLLBACK_PROBE_MISSING")
        swapped = dict(doc)
        swapped["baseline"], swapped["candidate"] = doc["candidate"], doc["baseline"]
        swapped["probeSha256"] = doc["rollbackProbeSha256"]
        super().__init__(swapped, bundle, run_dir)

    def snapshot(self):
        super().snapshot()
        # This happens before transact marks an exchange as attempted.
        require_r6_rollback_safe(self)

    def switch(self, role, expected):
        if role == "candidate":
            # Repeat after snapshot, at the last quiescent boundary.
            require_r6_rollback_safe(self)
        super().switch(role, expected)

    def verify_bundle(self):
        require(base.tree(self.prior_tree) == self.files["candidate"], "PRIOR_ROLLBACK_TREE_DRIFT")
        require(base.sha((self.bundle / "rollback-probe.py").read_bytes()) == self.doc["probeSha256"],
                "ROLLBACK_PROBE_DRIFT")
        require(base.sha((self.bundle / "rehearsal.py").read_bytes()) == self.doc.get("rehearsalSha256"), "REHEARSAL_DRIFT")

    def stage_role(self, role, destination):
        require(role in ("candidate", "rollback"), "INVALID_STAGE_ROLE")
        shutil.copytree(self.prior_tree if role == "candidate" else self.live, destination)
        require(base.tree(destination) == self.files[role], "STAGED_TREE_DRIFT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight", "activate", "rollback"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--previous-run", type=Path)
    args = parser.parse_args()
    require(args.command == "preflight" or args.execute, "EXECUTE_REQUIRED")
    require(args.command != "rollback" or args.previous_run is not None, "PREVIOUS_RUN_REQUIRED")
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda _sig, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
    doc = load_manifest(args.manifest, args.expected_sha256)
    adapter = (RollbackAdapter(doc, args.bundle, args.run_dir, args.previous_run) if args.command == "rollback"
               else ReleaseAdapter(doc, args.bundle, args.run_dir))
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
            result["status"] = "ROLLED_BACK_SERVICE_RELEASE" if args.command == "rollback" else "ACTIVATED_SERVICE_RELEASE"
    result.update(releaseId=adapter.doc["releaseId"], databaseRestored=False, runtimeFiles=len(adapter.files["candidate"]))
    (adapter.run_dir / "activation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return 0 if result["status"] in ("ACTIVATED_SERVICE_RELEASE", "ROLLED_BACK_SERVICE_RELEASE", "PREFLIGHT_PASSED_NO_LIVE_CHANGE") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"status": "SERVICE_RELEASE_NOT_CONFIRMED", "code": str(error) if isinstance(error, GateError) else "OPERATION_FAILED", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
