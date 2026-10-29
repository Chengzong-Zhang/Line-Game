"""Bounded Linux activation of the isolated, pinned WeChat profile service.

Requires root, a reviewed non-secret site description, and an intact frozen
bundle. Secrets are held only in memory from the running service's /proc entry.
Neither the legacy website nor either database is replaced. A stopped SQLite
snapshot is retained for disaster investigation, never used for code rollback.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.request

PINS = {
    "baseline": "664120bbce1a7f254fba5f65d638975d5aef455a2daf35eadac0f10e6466d1a6",
    "candidate": "415a082441e5027df900099d45440fa7a83633493c87adbff3377a92d8a576bb",
    "rollback": "08a3d0dccf19956d228610b516f190103d7d93753f21d8448d9b3aec6e6847a4",
}
STATIC_PROPERTIES = ("WorkingDirectory", "User", "Group", "ControlGroup", "FragmentPath",
                     "DropInPaths", "KillMode", "Type", "Restart", "EnvironmentFiles")
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


class GateError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise GateError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(value, *, exists=True):
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts, "ABSOLUTE_NORMAL_PATH_REQUIRED")
    for item in (path, *path.parents):
        require(not item.is_symlink(), "SYMLINK_PATH_REJECTED")
    return path.resolve(strict=exists)


def regular(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "NONREGULAR_OR_HARDLINK_FILE")
    return info


def tree(root):
    root = safe_path(root)
    require(root.is_dir(), "TREE_NOT_DIRECTORY")
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            require(not (Path(directory) / name).is_symlink(), "SYMLINK_TREE_REJECTED")
        for name in files:
            path = Path(directory) / name
            regular(path)
            result[path.relative_to(root).as_posix()] = sha(path.read_bytes())
    return result


def bundle_inventory(bundle):
    result = {}
    for role, pinned in PINS.items():
        manifest = safe_path(bundle / "manifests" / (role + ".json"))
        regular(manifest)
        data = manifest.read_bytes()
        require(sha(data) == pinned, "PINNED_MANIFEST_MISMATCH")
        data = json.loads(data)
        entries = ({name: value["sha256"] for name, value in data["service"].items()}
                   if role == "baseline" else {value["path"]: value["sha256"] for value in data["files"]}
                   if role == "candidate" else data["files"])
        require(len(entries) == (51 if role == "candidate" else 31), "PINNED_FILE_COUNT_MISMATCH")
        for name, digest in entries.items():
            require(isinstance(name, str) and not PurePosixPath(name).is_absolute()
                    and not any(p in ("", ".", "..") for p in name.split("/"))
                    and "\\" not in name and ":" not in name and re.fullmatch("[a-f0-9]{64}", digest),
                    "INVALID_MANIFEST_ENTRY")
        result[role] = entries
        if role != "baseline":
            require(tree(bundle / role) == entries, "BUNDLE_TREE_DRIFT")
    return result


def command(args, *, timeout=30, env=None, user=None, cwd=None, input_data=None):
    options = {"stdin": subprocess.DEVNULL if input_data is None else subprocess.PIPE}
    if user is not None:
        options.update(user=user[0], group=user[1], extra_groups=[])
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=SYSTEM_ENV if env is None else env, cwd=cwd,
                                   start_new_session=True, **options)
    except OSError as error:
        raise GateError("COMMAND_UNAVAILABLE_OR_TIMED_OUT") from error
    try:
        stdout, _ = process.communicate(input_data, timeout=timeout)
    except BaseException:
        # A killed Node/preflight parent must not leave its descendants running.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                process.communicate(timeout=2)
                break
            except subprocess.TimeoutExpired:
                continue
        # The immediate child may exit on TERM while a grandchild ignores it.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise GateError("COMMAND_INTERRUPTED_OR_TIMED_OUT") from None
    require(process.returncode == 0 and len(stdout) < 1048576, "COMMAND_FAILED")
    return stdout


def unit_properties(unit):
    properties = (*STATIC_PROPERTIES, "MainPID", "ActiveState", "SubState")
    # Empty fields such as ControlGroup must remain explicit for inactive units.
    raw = command(["systemctl", "show", unit, "--no-pager", "--all", "--property=" + ",".join(properties)])
    return dict(line.split("=", 1) for line in raw.decode().splitlines() if "=" in line)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def exchange(left, right):
    """Linux directory exchange: both old and new complete trees remain present."""
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    require(function is not None, "ATOMIC_EXCHANGE_UNAVAILABLE")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        raise GateError("ATOMIC_EXCHANGE_FAILED")
    for parent in {Path(left).parent, Path(right).parent}:
        fsync_directory(parent)


def process_environment(pid):
    raw = Path(f"/proc/{pid}/environ").read_bytes()
    return dict(item.decode("utf-8", "surrogateescape").split("=", 1)
                for item in raw.split(b"\0") if b"=" in item)


def relevant_environment(environment):
    return {key: value for key, value in environment.items()
            if key.startswith(("WECHAT_", "LIFELINE_")) or key in
            ("LINE_GAME_DB_PATH", "JWT_SECRET_KEY", "PATH", "PYTHONDONTWRITEBYTECODE")}


def process_identity(pid):
    path = Path(f"/proc/{pid}")
    stat_parts = (path / "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "startTime": stat_parts[19], "uid": path.stat().st_uid,
            "cwd": str((path / "cwd").resolve(strict=True)),
            "argv": (path / "cmdline").read_bytes().split(b"\0")[:-1]}


def create_run_directory(path, gid):
    path.mkdir(mode=0o750)
    os.chown(path, 0, gid)
    # systemd-run may intentionally use UMask=0077. mkdir's requested mode is
    # filtered by that mask, so explicitly grant only the service group's rx.
    os.chmod(path, 0o750)


def descriptor_writable(proc, descriptor, observed, target):
    """Confirm a matching /proc descriptor's access mode without opening it.

    Security scanners can retain read-only database descriptors. Only a proven
    O_RDONLY descriptor may be excluded; missing, malformed or racing evidence
    fails closed. Service membership/configuration reasons remain independent.
    """
    try:
        raw = (proc / "fdinfo" / descriptor.name).read_text()
    except FileNotFoundError:
        # A descriptor that disappeared is an ordinary /proc race. A still-live
        # descriptor without fdinfo does not establish read-only access.
        descriptor.stat()
        raise GateError("PROCESS_FD_ACCESS_UNCONFIRMED") from None
    fields = {}
    for line in raw.splitlines():
        if ":" in line:
            name, value = line.split(":", 1)
            require(name not in fields, "PROCESS_FD_ACCESS_UNCONFIRMED")
            fields[name] = value.strip()
    flags, inode = fields.get("flags", ""), fields.get("ino", "")
    require(re.fullmatch(r"[0-7]+", flags) is not None
            and re.fullmatch(r"[0-9]+", inode) is not None,
            "PROCESS_FD_ACCESS_UNCONFIRMED")
    current = descriptor.stat()
    require((current.st_dev, current.st_ino) == (observed.st_dev, observed.st_ino)
            and int(inode) == current.st_ino
            and os.readlink(descriptor).removesuffix(" (deleted)") == target,
            "PROCESS_FD_IDENTITY_CHANGED")
    # fdinfo is Linux data even when regression-tested on Windows: Linux's
    # O_ACCMODE is 03, with RDONLY=0, WRONLY=1 and RDWR=2.
    mode = int(flags, 8) & 0o3
    require(mode in (0, 1, 2), "PROCESS_FD_ACCESS_UNCONFIRMED")
    return mode != 0


def writer_scan(database, live_root, control_group):
    """Fail closed on unreadable non-racing process evidence; never emit secrets."""
    db_info = database.stat()
    identity = (db_info.st_dev, db_info.st_ino)
    paths = {str(database) + suffix for suffix in ("", "-wal", "-shm", "-journal")}
    found, scanned = [], 0
    for proc in Path("/proc").iterdir():
        if not proc.name.isdecimal() or int(proc.name) == os.getpid():
            continue
        reasons = set()
        try:
            cgroup = (proc / "cgroup").read_text()
            if any((entry := line.split(":", 2)[-1]) == control_group
                   or entry.startswith(control_group + "/") for line in cgroup.splitlines()):
                reasons.add("service-control-group")
            environment = process_environment(int(proc.name))
            if environment.get("WECHAT_DB_PATH") == str(database):
                reasons.add("configured-database-writer")
            try:
                if (proc / "cwd").resolve(strict=True) == live_root:
                    reasons.add("service-working-directory")
            except FileNotFoundError:
                pass
            for fd in (proc / "fd").iterdir():
                try:
                    info = fd.stat()
                    target = os.readlink(fd).removesuffix(" (deleted)")
                    if ((info.st_dev, info.st_ino) == identity or target in paths) and descriptor_writable(proc, fd, info, target):
                        reasons.add("database-or-sidecar-open")
                except FileNotFoundError:
                    continue
            scanned += 1
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise GateError("PROCESS_SCAN_PERMISSION_DENIED") from error
        if reasons:
            found.append({"pid": int(proc.name), "reasons": sorted(reasons)})
    return {"scanned": scanned, "writers": found}


class LiveAdapter:
    def __init__(self, site, bundle, run_dir):
        require(sys.platform == "linux" and os.geteuid() == 0, "LINUX_ROOT_REQUIRED")
        require(site.get("schemaVersion") == 1, "UNSUPPORTED_SITE_SCHEMA")
        self.site, self.bundle = site, safe_path(bundle)
        self.live = safe_path(site["liveRoot"])
        self.database = safe_path(site["database"]["path"])
        self.legacy = safe_path(site["legacyDatabase"]["path"])
        self.run_dir = safe_path(run_dir, exists=False)
        require(not self.run_dir.exists() and self.run_dir.parent.is_dir(), "RUN_DIRECTORY_MUST_BE_NEW")
        require(self.live.parent.parent == self.bundle.parent.parent == self.run_dir.parent.parent,
                "ISOLATED_SERVICE_SIBLINGS_REQUIRED")
        for path in (self.live, self.bundle, self.run_dir):
            require(path not in self.database.parents and path not in self.legacy.parents,
                    "DATABASE_INSIDE_SERVICE_TREE")
        require(self.database != self.legacy, "DATABASES_MUST_BE_SEPARATE")
        require(site["unit"] == "lifeline-wechat.service" and site["user"] == "ubuntu"
                and site["uid"] == site["gid"] == 1000, "UNREVIEWED_SERVICE_IDENTITY")
        require(site["healthUrl"] == "http://127.0.0.1:8006/api/wechat/status", "UNREVIEWED_HEALTH_ENDPOINT")
        require(set(site["baselineExtras"]) == {"service-manifest.json"}, "UNREVIEWED_BASELINE_EXTRA")
        require(set(site["unitProperties"]) == set(STATIC_PROPERTIES), "INCOMPLETE_UNIT_PROPERTIES")
        require(site["unitProperties"]["KillMode"] == "control-group", "CONTROL_GROUP_STOP_REQUIRED")
        self.files = bundle_inventory(self.bundle)
        self.files["baseline"] = {**self.files["baseline"], **site["baselineExtras"]}
        self.check_database()
        self.verify_unit()
        require(tree(self.live) == self.files["baseline"], "LIVE_BASELINE_DRIFT")
        self.unit = unit_properties(site["unit"])
        self.original = self.capture_running(self.unit)
        self.environment = process_environment(self.original["pid"])
        self.check_environment(self.environment)
        create_run_directory(self.run_dir, site["gid"])
        self.journal = self.run_dir / "journal.jsonl"
        self.journal.touch(mode=0o600, exist_ok=False)
        self.recovering = False
        self.journal_incomplete = False
        self.prepared = {}
        self.lock = self.live.parent / ".wechat-profile-activation.lock"

    def check_database(self):
        for path, key in ((self.database, "database"), (self.legacy, "legacyDatabase")):
            info = regular(safe_path(path))
            require((info.st_dev, info.st_ino) == (self.site[key]["device"], self.site[key]["inode"]),
                    "WECHAT_DATABASE_IDENTITY_CHANGED" if key == "database" else "LEGACY_DATABASE_IDENTITY_CHANGED")

    def verify_unit(self):
        properties = unit_properties(self.site["unit"])
        # systemd clears ControlGroup after the unit becomes inactive; the
        # observed original cgroup remains the path scanned for leftover PIDs.
        require(all(properties.get(key) == value or
                    (key == "ControlGroup" and properties.get(key) == ""
                     and properties.get("ActiveState") in ("inactive", "failed")
                     and properties.get("MainPID") == "0")
                    for key, value in self.site["unitProperties"].items()),
                "UNIT_PROPERTIES_DRIFT")
        expected_files = {properties["FragmentPath"], *properties["DropInPaths"].split()}
        require(set(self.site["unitFiles"]) == expected_files, "UNIT_FILE_SET_DRIFT")
        for name, digest in self.site["unitFiles"].items():
            path = safe_path(name)
            regular(path)
            require(sha(path.read_bytes()) == digest, "UNIT_FILE_DRIFT")

    def capture_running(self, properties):
        require(properties["ActiveState"] == "active" and properties["SubState"] == "running",
                "SERVICE_NOT_RUNNING")
        result = process_identity(int(properties["MainPID"]))
        require(result["uid"] == self.site["uid"] and result["cwd"] == str(self.live)
                and result["argv"] and os.fsdecode(result["argv"][0]) == self.site["python"],
                "RUNNING_PROCESS_IDENTITY_MISMATCH")
        return result

    def check_environment(self, environment):
        for key, value in {"WECHAT_ONLINE_ENABLED": "1", "WECHAT_APP_ID": "wxf986ac5d7e8bb8a0",
                           "WECHAT_WEB_AUTH_MODE": "password", "WECHAT_DB_PATH": str(self.database),
                           "LINE_GAME_DB_PATH": str(self.legacy), "LIFELINE_NODE": self.site["node"]}.items():
            require(environment.get(key) == value, "PROCESS_CONFIGURATION_MISMATCH")
        require(environment.get("PYTHONDONTWRITEBYTECODE") == "1", "BYTECODE_DISABLED_REQUIRED")
        require(len(environment.get("WECHAT_JWT_SECRET", "")) >= 32
                and bool(environment.get("WECHAT_APP_SECRET")), "REQUIRED_CREDENTIAL_UNAVAILABLE")

    def event(self, name, **safe_details):
        try:
            with self.journal.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"event": name, "time": int(time.time()), **safe_details}) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError:
            self.journal_incomplete = True
            if not self.recovering:
                raise

    def prepare(self):
        require(self.run_dir.stat().st_dev == self.live.stat().st_dev, "DIFFERENT_FILESYSTEM")
        for role in ("candidate", "rollback"):
            destination = self.run_dir / role
            shutil.copytree(self.bundle / role, destination)
            for directory, dirs, files in os.walk(destination):
                os.chown(directory, 0, self.site["gid"])
                os.chmod(directory, 0o750)
                for name in files:
                    path = Path(directory) / name
                    os.chown(path, 0, self.site["gid"])
                    os.chmod(path, 0o640)
            require(tree(destination) == self.files[role], "STAGED_TREE_DRIFT")
            self.prepared[role] = destination
        left, right = self.run_dir / "exchange-probe-left", self.run_dir / "exchange-probe-right"
        left.mkdir(); right.mkdir()
        (left / "left").write_bytes(b"left")
        (right / "right").write_bytes(b"right")
        exchange(left, right)
        require((left / "right").read_bytes() == b"right" and (right / "left").read_bytes() == b"left",
                "EXCHANGE_PROBE_FAILED")
        exchange(left, right)
        self.event("ATOMIC_EXCHANGE_AND_STAGING_PASSED")

    def preflight(self):
        """Pinned checker runs as the actual service user in its actual venv."""
        stage = self.prepared["candidate"]
        path = stage / "wechat/tools/check_service_config.py"
        source = path.read_bytes()
        require(sha(source) == self.files["candidate"]["wechat/tools/check_service_config.py"], "CHECKER_DRIFT")
        # The exact hash-checked bytes are supplied over stdin, not reread after
        # checking. __name__ avoids the module's CLI and only emits its safe JSON.
        wrapper = ("import sys,json; p=sys.argv[1]; ns={'__file__':p,'__name__':'_preflight'}; "
                   "exec(compile(sys.stdin.buffer.read(),p,'exec'),ns); "
                   "print(json.dumps(ns['check_service_config']()))")
        raw = command([self.site["python"], "-B", "-c", wrapper, str(path)],
                      input_data=source, env=self.environment, user=(self.site["uid"], self.site["gid"]),
                      cwd=stage, timeout=45)
        result = json.loads(raw)
        # A live WAL is not a failed dependency. Its consistent validation takes
        # place under the stopped-writer snapshot; all other issues block stop.
        issues = result.get("issues", [])
        allowed = {("WECHAT_DB_PATH", "DATABASE_NEEDS_QUIESCENT_SNAPSHOT")}
        # The pinned checker's contract contains only fixed issue/check codes,
        # never credentials or database rows. Retain it even on failed preflight.
        self.event("ACTUAL_SERVICE_PREFLIGHT_RESULT", status=result.get("status"),
                   checks=result.get("checks", {}), issues=issues)
        require(all((item.get("field"), item.get("code")) in allowed for item in issues), "PREFLIGHT_FAILED")
        require(result.get("checks", {}).get("profileImages") == "PASS_PILLOW_PNG_JPEG_SYNTHETIC_PROBE"
                and result.get("checks", {}).get("rules") == "PASS_FIXED_POSITION_DEPENDENCY_PROBE", "PREFLIGHT_INCOMPLETE")
        self.event("ACTUAL_SERVICE_PREFLIGHT_PASSED", databaseDeferred=bool(issues))

    def before_stop(self):
        self.verify_unit()
        self.check_database()
        require(tree(self.live) == self.files["baseline"], "LIVE_BASELINE_DRIFT")
        properties = unit_properties(self.site["unit"])
        current = self.capture_running(properties)
        require(current == self.original, "RUNNING_PROCESS_CHANGED")
        require(relevant_environment(process_environment(current["pid"])) == relevant_environment(self.environment),
                "PROCESS_ENVIRONMENT_CHANGED")
        bundle_inventory(self.bundle)
        scan = writer_scan(self.database, self.live, self.site["unitProperties"]["ControlGroup"])
        require(any(item["pid"] == current["pid"] for item in scan["writers"])
                and all("service-control-group" in item["reasons"] for item in scan["writers"]),
                "EXTERNAL_DATABASE_WRITER_PRESENT")
        self.event("CURRENT_WRITER_INVENTORY_PASSED", writers=scan["writers"], processCount=scan["scanned"])

    def stop(self):
        self.event("STOP_UNIT_VERIFY_BEGIN")
        self.verify_unit()
        # systemctl's own TimeoutStopSec=20s is bounded by the outer timeout.
        self.event("STOP_COMMAND_BEGIN")
        command(["systemctl", "stop", self.site["unit"]], timeout=35)
        self.event("STOP_COMMAND_COMPLETE")
        self.assert_quiescent()
        self.event("ALL_WRITERS_STOPPED")

    def assert_quiescent(self):
        self.event("QUIESCENCE_DATABASE_IDENTITY_BEGIN")
        self.check_database()
        for _ in range(2):
            props = unit_properties(self.site["unit"])
            self.event("QUIESCENCE_UNIT_STATE", mainPid=props.get("MainPID"), activeState=props.get("ActiveState"))
            require(props["MainPID"] == "0" and props["ActiveState"] in ("inactive", "failed"),
                    "SERVICE_NOT_STOPPED")
            self.event("QUIESCENCE_WRITER_SCAN_BEGIN")
            scan = writer_scan(self.database, self.live, self.site["unitProperties"]["ControlGroup"])
            self.event("QUIESCENCE_WRITER_SCAN_RESULT", processCount=scan["scanned"], writers=scan["writers"])
            require(not scan["writers"], "DATABASE_WRITER_STILL_PRESENT")
            time.sleep(0.15)
        self.event("QUIESCENCE_CHECK_PASSED", processCount=scan["scanned"])

    def snapshot(self):
        self.assert_quiescent()
        require(tree(self.live) == self.files["baseline"], "BASELINE_DRIFT_AFTER_STOP")
        path = self.prepared["candidate"] / "wechat/tools/maintain_store.py"
        source = path.read_bytes()
        require(sha(source) == self.files["candidate"]["wechat/tools/maintain_store.py"], "SNAPSHOT_TOOL_DRIFT")
        wrapper = ("import sys,json; p=sys.argv[1]; ns={'__file__':p,'__name__':'_snapshot'}; "
                   "exec(compile(sys.stdin.buffer.read(),p,'exec'),ns); "
                   "print(json.dumps(ns['copy_store'](sys.argv[2],sys.argv[3])))")
        backup_dir = self.run_dir / "database-backup"
        backup_dir.mkdir(mode=0o700)
        os.chown(backup_dir, self.site["uid"], self.site["gid"])
        backup = backup_dir / "before.sqlite3"
        # Even a mode=ro SQLite source may create WAL shared-memory sidecars.
        # All SQLite access therefore runs as the service user, never as root.
        raw = command([self.site["python"], "-B", "-c", wrapper, str(path), str(self.database),
                       str(backup)], input_data=source, timeout=45,
                      user=(self.site["uid"], self.site["gid"]))
        regular(backup)
        os.chown(backup, 0, 0)
        os.chmod(backup, 0o600)
        os.chown(backup_dir, 0, 0)
        os.chmod(backup_dir, 0o700)
        receipt = json.loads(raw)
        require(receipt.get("status") == "PASS_STANDALONE_BACKUP", "SNAPSHOT_NOT_CONFIRMED")
        require(sha(backup.read_bytes()) == receipt["sha256"], "SNAPSHOT_HASH_MISMATCH")
        self.check_database()
        self.event("QUIESCENT_SNAPSHOT_COMPLETE", snapshotSha256=receipt["sha256"], bytes=receipt["bytes"])

    def switch(self, role, expected):
        self.event("SWITCH_UNIT_VERIFY_BEGIN", role=role)
        self.verify_unit()
        self.event("SWITCH_QUIESCENCE_BEGIN", role=role)
        self.assert_quiescent()
        require(tree(self.live) == expected, "UNOWNED_LIVE_TREE_DRIFT")
        require(tree(self.prepared[role]) == self.files[role], "STAGED_TREE_DRIFT")
        self.event("SWITCH_INTENT", role=role)
        exchange(self.live, self.prepared[role])
        require(tree(self.live) == self.files[role], "PUBLISHED_TREE_MISMATCH")
        self.event("TREE_PUBLISHED", role=role)

    def start(self, role):
        self.verify_unit()
        self.check_database()
        require(tree(self.live) == self.files[role], "TREE_DRIFT_BEFORE_START")
        command(["systemctl", "start", self.site["unit"]], timeout=35)
        current = None
        for _ in range(15):
            try:
                current = self.capture_running(unit_properties(self.site["unit"]))
                break
            except (GateError, FileNotFoundError, ProcessLookupError):
                time.sleep(0.2)
        require(current is not None, "RESTART_PROCESS_NOT_OBSERVED")
        require(current["argv"] == self.original["argv"], "RESTART_ARGV_CHANGED")
        environment = process_environment(current["pid"])
        require(relevant_environment(environment) == relevant_environment(self.environment), "RESTART_ENVIRONMENT_CHANGED")
        self.event("SERVICE_STARTED", role=role, pid=current["pid"])

    def health(self, role):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(8):
            self.check_database()
            try:
                with opener.open(self.site["healthUrl"], timeout=3) as response:
                    data = response.read(8193)
                    require(len(data) <= 8192, "HEALTH_RESPONSE_TOO_LARGE")
                    result = json.loads(data)
                if (result.get("enabled") is True and result.get("webLogin") is True
                        and result.get("webAuthMode") == "password"
                        and (role != "candidate" or result.get("accountProfile") is True)):
                    self.check_database()
                    self.verify_unit()
                    require(tree(self.live) == self.files[role], "LIVE_TREE_DRIFT_AFTER_START")
                    # Read the live WAL-aware SQLite snapshot without mutating
                    # rows or recreating a missing database.
                    probe = ("import sqlite3,json,sys; from pathlib import Path; "
                             "db=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=3); "
                             "db.execute('PRAGMA query_only=ON'); db.execute('BEGIN'); "
                             "v=db.execute('PRAGMA user_version').fetchone()[0]; "
                             "ok=db.execute('PRAGMA quick_check').fetchall()==[('ok',)]; db.close(); "
                             "print(json.dumps({'version':v,'integrity':ok}))")
                    schema = json.loads(command([self.site["python"], "-B", "-c", probe, str(self.database)],
                                                user=(self.site["uid"], self.site["gid"]), timeout=10))
                    require(schema["version"] == 3 if role != "baseline" else schema["version"] in (1, 2),
                            "LIVE_SCHEMA_MISMATCH")
                    require(schema["integrity"] is True, "LIVE_DATABASE_INTEGRITY_FAILED")
                    self.check_database()
                    self.event("HEALTH_PASSED", role=role, accountProfile=result.get("accountProfile") is True)
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        raise GateError("HEALTH_FAILED")

    def acquire(self):
        self.lock_fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(self.lock_fd, json.dumps({"pid": os.getpid(), "runDirectory": str(self.run_dir)}).encode())
        os.fsync(self.lock_fd)
        fsync_directory(self.lock.parent)

    def release(self):
        os.close(self.lock_fd)
        self.lock.unlink()
        fsync_directory(self.lock.parent)


def transact(adapter):
    """Exception-safe transaction; uncertain recovery retains its durable lock."""
    adapter.acquire()
    stopped, switch_attempted, finished = False, False, False
    try:
        adapter.prepare()
        adapter.preflight()
        adapter.before_stop()
        stopped = True  # stop may raise after systemd already stopped the service.
        adapter.stop()
        adapter.snapshot()
        switch_attempted = True
        adapter.switch("candidate", adapter.files["baseline"])
        adapter.start("candidate")
        adapter.health("candidate")
        adapter.event("ACTIVATION_COMPLETE_SAME_DATABASE")
        finished = True
        return {"status": "ACTIVATED_PROFILE_SERVICE", "databaseRestored": False,
                "frontendModified": False, "accountProfile": True}
    except BaseException as error:
        adapter.recovering = True
        adapter.event("ACTIVATION_FAILURE", failureType=type(error).__name__,
                      code=str(error) if isinstance(error, GateError) else "NON_GATE_OPERATION_FAILED")
        if not stopped:
            finished = True
            raise
        try:
            adapter.stop()
            current = tree(adapter.live)
            require(current in adapter.files.values(), "UNOWNED_LIVE_TREE_DRIFT")
            role = "rollback" if switch_attempted else "baseline"
            if switch_attempted:
                adapter.switch("rollback", current)
            else:
                require(current == adapter.files["baseline"], "PRE_SWITCH_TREE_DRIFT")
            adapter.start(role)
            adapter.health(role)
            adapter.event("RECOVERED_SAME_DATABASE", role=role)
            finished = True
            return {"status": "RECOVERED_" + role.upper(), "databaseRestored": False,
                    "failureType": type(error).__name__, "journalIncomplete": adapter.journal_incomplete}
        except BaseException as recovery_error:
            adapter.event("RECOVERY_BLOCKED", failureType=type(recovery_error).__name__,
                          code=str(recovery_error) if isinstance(recovery_error, GateError) else "NON_GATE_OPERATION_FAILED")
            raise GateError("RECOVERY_BLOCKED_KEEP_LATEST_DATABASE_LOCK_AND_JOURNAL") from recovery_error
    finally:
        if finished:
            adapter.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight", "activate"))
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    require(args.command != "activate" or args.execute, "ACTIVATE_REQUIRES_EXECUTE")
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, interrupted)
    adapter = LiveAdapter(json.loads(safe_path(args.site).read_text()), args.bundle, args.run_dir)
    if args.command == "preflight":
        adapter.acquire()
        try:
            adapter.prepare(); adapter.preflight(); adapter.before_stop()
            result = {"status": "PREFLIGHT_PASSED_NO_LIVE_CHANGE", "serviceStopped": False,
                      "databaseMigrated": False, "frontendModified": False}
        finally:
            adapter.release()
    else:
        result = transact(adapter)
    result["journalIncomplete"] = adapter.journal_incomplete
    print(json.dumps(result))
    return 0 if result["status"] in ("ACTIVATED_PROFILE_SERVICE", "PREFLIGHT_PASSED_NO_LIVE_CHANGE") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"status": "ACTIVATION_NOT_CONFIRMED", "errorType": type(error).__name__,
                          "code": str(error) if isinstance(error, GateError) else "LOCAL_OPERATION_FAILED"}))
        raise SystemExit(1) from None
