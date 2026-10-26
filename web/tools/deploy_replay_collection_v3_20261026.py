"""Prepare and atomically activate the replay-collection v3 release.

The local ``prepare`` command creates a hash-bound, self-contained release
directory.  Copy that directory to ``/home/ubuntu/line-game/.deploy-artifacts``
and run this same file from the copied directory as root with ``activate``.

Synthetic replays are accepted only against a temporary inbox during the
preflight.  The production SQLite database is backed up while the collector is
stopped, extended append-only with ``inbox_v3``, and never replaced.  The two
production frontend trees are exchanged atomically and retain complete
rollback trees.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

if sys.platform == "linux":
    import fcntl


RELEASE_ID = "replay-collection-v3-20261026-r1"
FRONTEND_RELEASE_ID = "web-replay-collection-v3-20261026-r1"
ASSET_VERSION = "20261026-replayv3"
PREDECESSOR_RELEASE_ID = "web-latest-moves-20261025-r1"
ROOT = Path("/home/ubuntu/line-game")
UNIT = "lifeline-training-contributions.service"
DROPIN = Path(f"/etc/systemd/system/{UNIT}.d/91-replay-collection-v3.conf")
OVERLAY_FILES = frozenset({"TrainingContribution.js", "OnlineApp.js", "main.js", "index.html"})
COLLECTOR_FILES = {
    "web/backend/training_contributions.py": "web/web\u540e\u7aef/training_contributions.py",
    "web/backend/contribution_asgi.py": "web/web\u540e\u7aef/contribution_asgi.py",
    "web/tools/validate_contribution.mjs": "web/tools/validate_contribution.mjs",
    "web/tools/training_contribution_schema.mjs": "web/tools/training_contribution_schema.mjs",
    "web/web\u524d\u7aef/GameEngine.js": "web/web\u524d\u7aef/GameEngine.js",
    "web/web\u524d\u7aef/ReplayCodec.js": "web/web\u524d\u7aef/ReplayCodec.js",
    "web/web\u524d\u7aef/StartingPoints.js": "web/web\u524d\u7aef/StartingPoints.js",
    "web/web\u524d\u7aef/ResearchAI.js": "web/web\u524d\u7aef/ResearchAI.js",
}
AUTHORITATIVE_REPLAY_PREDECESSOR_FILES = {
    "web/web\u524d\u7aef/GameEngine.js": "GameEngine.js",
    "web/web\u524d\u7aef/ReplayCodec.js": "ReplayCodec.js",
    "web/web\u524d\u7aef/StartingPoints.js": "StartingPoints.js",
    "web/web\u524d\u7aef/ResearchAI.js": "ResearchAI.js",
}
EXPECTED_POLICIES = {
    "1": "anonymous-replay-training-v1",
    "2": "anonymous-replay-training-v2",
    "3": "anonymous-replay-training-v3",
}


def sha_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def save_new(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def save_atomic(path: Path, value: object) -> None:
    pending = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.pending")
    try:
        with pending.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def zip_write(bundle: zipfile.ZipFile, name: str, raw: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=(2026, 10, 26, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    bundle.writestr(info, raw)


def run(args: list[object], *, cwd: Path | None = None, timeout: int = 120,
        input_bytes: bytes | None = None, user: int | None = None) -> bytes:
    options = {}
    if user is not None:
        options = {"user": user, "group": user, "extra_groups": []}
    result = subprocess.run([str(item) for item in args], cwd=cwd, input=input_bytes,
                            capture_output=True, timeout=timeout, **options)
    if result.returncode:
        tail = result.stderr.decode("utf-8", errors="replace")[-1800:]
        raise RuntimeError(f"command failed: {Path(str(args[0])).name}: {tail}")
    return result.stdout


def safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and "\\" not in name \
        and all(part not in ("", ".", "..") for part in path.parts)


def tree(path: Path) -> str:
    if not path.is_dir() or path.is_symlink():
        raise RuntimeError(f"expected real directory: {path}")
    digest = hashlib.sha256()
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise RuntimeError(f"symlink rejected: {file}")
        if file.is_file():
            label = file.relative_to(path).as_posix().encode()
            digest.update(len(label).to_bytes(8, "big"))
            digest.update(label)
            digest.update(bytes.fromhex(sha(file)))
    return digest.hexdigest()


def render_frontend(name: str, raw: bytes) -> bytes:
    text = raw.decode("utf-8")
    if name.endswith((".js", ".mjs")):
        imports = re.compile(r"(['\"])((?:\./|\.\./)[^'\"\r\n]+?\.js)(?:\?v=[^'\"\r\n]*)?\1")
        text = imports.sub(lambda match: f"{match[1]}{match[2]}?v={ASSET_VERSION}{match[1]}", text)
    if name == "main.js":
        text, count = re.subn(r'const APP_ASSET_VERSION = "[^"]+";',
                              f'const APP_ASSET_VERSION = "{ASSET_VERSION}";', text)
        if count != 1:
            raise RuntimeError("main.js asset version marker changed")
    if name == "index.html":
        text, count = re.subn(r"(styles\.css|main\.js)\?v=[^\"\s]+",
                              lambda match: f"{match[1]}?v={ASSET_VERSION}", text)
        if count != 2:
            raise RuntimeError("index.html cache pins changed")
    return text.replace("\r\n", "\n").encode("utf-8")


def authoritative_replay_gate(collector_rows: dict[str, bytes], predecessor: dict) -> dict[str, str]:
    """Bind the collector's replay engine to the installed frontend predecessor."""
    frontend_files = predecessor.get("files")
    if not isinstance(frontend_files, dict):
        raise RuntimeError("frontend predecessor has no resource inventory")
    verified = {}
    for collector_name, frontend_name in AUTHORITATIVE_REPLAY_PREDECESSOR_FILES.items():
        expected = frontend_files.get(frontend_name)
        if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
            raise RuntimeError("frontend predecessor replay hash missing: " + frontend_name)
        raw = collector_rows.get(collector_name)
        if raw is None or sha_bytes(raw) != expected:
            raise RuntimeError("authoritative replay source drift: " + frontend_name)
        verified[frontend_name] = expected
    return verified


def fixture(repo: Path, script: str, options: dict | None = None) -> dict:
    command = ["node", str(repo / "web/web\u524d\u7aef/tests/fixtures" / script)]
    if options is not None:
        command.append(json.dumps(options, separators=(",", ":")))
    return json.loads(run(command, cwd=repo, timeout=180))


def prepare(output: Path) -> dict:
    repo = Path(__file__).resolve().parents[2]
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture_names = ("create-training-fixture.mjs", "create-training-v2-fixture.mjs",
                     "create-training-v3-fixture.mjs")
    watched = {repo / source for source in COLLECTOR_FILES.values()} \
        | {repo / "web/web\u524d\u7aef" / name for name in OVERLAY_FILES} \
        | {repo / "web/web\u524d\u7aef/tests/fixtures" / name for name in fixture_names} \
        | {repo / "docs/verification/latest-moves-20261025/web-release-manifest.json", Path(__file__).resolve()}
    source_hashes = {str(path.relative_to(repo)).replace("\\", "/"): sha(path) for path in sorted(watched)}
    git_state = run(["git", "status", "--porcelain"], cwd=repo)
    script_raw = Path(__file__).read_bytes()
    (output / "activate.py").write_bytes(script_raw)

    predecessor_path = repo / "docs/verification/latest-moves-20261025/web-release-manifest.json"
    predecessor_raw = predecessor_path.read_bytes()
    predecessor = json.loads(predecessor_raw)
    if predecessor.get("release_id") != PREDECESSOR_RELEASE_ID:
        raise RuntimeError("unexpected frontend predecessor")
    if not OVERLAY_FILES.issubset(predecessor.get("files", {})):
        raise RuntimeError("frontend predecessor inventory changed")

    collector_rows: dict[str, bytes] = {}
    for destination, source in COLLECTOR_FILES.items():
        collector_rows[destination] = (repo / source).read_bytes()
    collector_rows["web/package.json"] = b'{"type":"module"}\n'
    authoritative_replay_hashes = authoritative_replay_gate(collector_rows, predecessor)
    collector_manifest = {"releaseId": RELEASE_ID,
                          "files": {name: sha_bytes(raw) for name, raw in collector_rows.items()}}
    collector_archive = output / "collector.zip"
    with zipfile.ZipFile(collector_archive, "x", zipfile.ZIP_DEFLATED) as bundle:
        zip_write(bundle, "collector-manifest.json", json.dumps(collector_manifest, ensure_ascii=True, indent=2).encode())
        for name, raw in collector_rows.items():
            zip_write(bundle, "service/" + name, raw)

    fixtures = [
        fixture(repo, "create-training-fixture.mjs"),
        fixture(repo, "create-training-v2-fixture.mjs", {"playerCount": 3, "startingPointMode": "random",
                                                           "profile": "three-player-policy-v2"}),
        fixture(repo, "create-training-v2-fixture.mjs", {"playerCount": 6, "boardShape": "hexagon",
                                                           "startingPointMode": "custom",
                                                           "profile": "multiplayer-hard-v1"}),
        fixture(repo, "create-training-v3-fixture.mjs", {"playerCount": 2, "terminalMode": "pass"}),
        fixture(repo, "create-training-v3-fixture.mjs", {"playerCount": 6, "boardShape": "hexagon",
                                                           "startingPointMode": "custom", "terminalMode": "resign",
                                                           "profile": "multiplayer-hard-v1"}),
        fixture(repo, "create-training-v3-fixture.mjs", {"playerCount": 15, "boardShape": "hexagon",
                                                           "startingPointMode": "random", "terminalMode": "pass",
                                                           "profile": "multiplayer-hard-v1"}),
    ]
    fixtures_raw = json.dumps(fixtures, ensure_ascii=True, separators=(",", ":")).encode()
    (output / "synthetic-fixtures.json").write_bytes(fixtures_raw)

    overlay = {name: render_frontend(name, (repo / "web/web\u524d\u7aef" / name).read_bytes())
               for name in sorted(OVERLAY_FILES)}
    frontend_files = dict(predecessor["files"])
    frontend_files.update({name: sha_bytes(raw) for name, raw in overlay.items()})
    commit = run(["git", "rev-parse", "HEAD"], cwd=repo).decode().strip()
    frontend_manifest = {
        **{key: value for key, value in predecessor.items()
           if key not in {"release_id", "asset_version", "commit", "workspace_dirty", "deployment_scope", "files",
                          "predecessor_release_id"}},
        "release_id": FRONTEND_RELEASE_ID,
        "asset_version": ASSET_VERSION,
        "commit": commit,
        "workspace_dirty": bool(git_state.strip()),
        "deployment_scope": "replay-contribution-v3-client-overlay-both-frontends",
        "files": frontend_files,
        "predecessor_release_id": PREDECESSOR_RELEASE_ID,
        "predecessor_manifest_sha256": sha_bytes(predecessor_raw),
        "overlay_files": {name: sha_bytes(raw) for name, raw in overlay.items()},
    }
    frontend_manifest_raw = json.dumps(frontend_manifest, ensure_ascii=False, indent=2).encode()
    frontend_archive = output / "frontend-overlay.zip"
    with zipfile.ZipFile(frontend_archive, "x", zipfile.ZIP_DEFLATED) as bundle:
        zip_write(bundle, "release-manifest.json", frontend_manifest_raw)
        for name, raw in overlay.items():
            zip_write(bundle, name, raw)

    after_hashes = {str(path.relative_to(repo)).replace("\\", "/"): sha(path) for path in sorted(watched)}
    if after_hashes != source_hashes or run(["git", "status", "--porcelain"], cwd=repo) != git_state:
        raise RuntimeError("release source changed during preparation")

    release = {
        "schemaVersion": 1,
        "releaseId": RELEASE_ID,
        "frontendReleaseId": FRONTEND_RELEASE_ID,
        "assetVersion": ASSET_VERSION,
        "sourceCommit": commit,
        "sourceWorkspaceDirty": bool(git_state.strip()),
        "files": {
            "activate.py": sha_bytes(script_raw),
            "collector.zip": sha(collector_archive),
            "synthetic-fixtures.json": sha_bytes(fixtures_raw),
            "frontend-overlay.zip": sha(frontend_archive),
        },
        "collectorManifest": collector_manifest,
        "authoritativeReplayPredecessorHashes": authoritative_replay_hashes,
        "frontendManifestSha256": sha_bytes(frontend_manifest_raw),
        "predecessorManifestSha256": sha_bytes(predecessor_raw),
        "fixtureVersions": [item["version"] for item in fixtures],
        "sourceFiles": source_hashes,
        "productionRequestsDuringPrepare": 0,
    }
    save_new(output / "release.json", release)
    print(json.dumps({"status": "PREPARED_NOT_DEPLOYED", "releaseDirectory": str(output),
                      "files": release["files"], "fixtureVersions": release["fixtureVersions"]}))
    return release


def frontends(root: Path) -> dict[str, Path]:
    artifacts = root / ".deploy-artifacts"
    return {
        "site": root / "web/web\u524d\u7aef",
        "wechat": artifacts / "wechat-service-20261021/release/web/web\u524d\u7aef",
    }


def resource_check(frontend: Path, manifest: dict) -> None:
    files = manifest.get("files")
    if not isinstance(files, dict) or not files or not all(safe_member(name) for name in files):
        raise RuntimeError("invalid frontend resource manifest")
    for name, expected in files.items():
        file = frontend.joinpath(*PurePosixPath(name).parts)
        if file.is_symlink() or not file.is_file() or sha(file) != expected:
            raise RuntimeError("frontend resource mismatch: " + name)


def exchange(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, str(left).encode(), -100, str(right).encode(), 2):
        raise OSError(ctypes.get_errno(), "atomic directory exchange failed")


def systemctl(*arguments: str) -> bytes:
    return run(["systemctl", *arguments], timeout=60)


def unit_configuration() -> dict[str, str]:
    properties = ("WorkingDirectory", "MainPID", "ActiveState", "SubState", "User", "FragmentPath", "DropInPaths")
    return {name: systemctl("show", UNIT, "-p", name, "--value").decode().strip() for name in properties}


def selected_environment(pid: int) -> dict[str, str]:
    allowed = {b"LIFELINE_CONTRIBUTIONS_DIR", b"LIFELINE_NODE", b"PATH"}
    raw = (Path("/proc") / str(pid) / "environ").read_bytes()
    return {key.decode(): value.decode() for item in raw.split(b"\0")
            for key, separator, value in [item.partition(b"=")] if separator and key in allowed}


def resolve_running_node(environment: dict[str, str]) -> Path:
    """Resolve the exact Node executable advertised by the running collector."""
    node_value = environment.get("LIFELINE_NODE")
    if not node_value:
        raise RuntimeError("running collector does not expose LIFELINE_NODE")
    candidate = Path(node_value)
    if not candidate.is_absolute():
        found = shutil.which(node_value, path=environment.get("PATH"))
        if not found:
            raise RuntimeError("running collector LIFELINE_NODE is not resolvable")
        candidate = Path(found)
    node = candidate.resolve(strict=True)
    if not node.is_file() or not os.access(node, os.X_OK):
        raise RuntimeError("running collector LIFELINE_NODE is not executable")
    return node


def local_status() -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8005/api/training/contributions/status", timeout=8) as response:
        return json.load(response)


def wait_status(versions: list[int], timeout: float = 15) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = local_status()
            if value.get("enabled") is True and value.get("supported_versions") == versions:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise RuntimeError("collector health not confirmed")


def database_snapshot(database: Path) -> dict:
    info = database.stat()
    if not stat.S_ISREG(info.st_mode) or database.is_symlink():
        raise RuntimeError("collector database is not a regular file")
    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        if connection.execute("pragma quick_check").fetchall() != [("ok",)]:
            raise RuntimeError("collector database integrity failed")
        tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
        counts = {name: connection.execute(f"select count(*) from {name}").fetchone()[0]
                  for name in ("inbox", "inbox_v2", "inbox_v3") if name in tables}
    finally:
        connection.close()
    return {"path": str(database.resolve()), "device": info.st_dev, "inode": info.st_ino, "counts": counts}


def process_identity(configuration: dict[str, str]) -> dict:
    pid = int(configuration["MainPID"])
    if pid <= 0 or configuration["ActiveState"] != "active" or configuration["SubState"] != "running":
        raise RuntimeError("collector is not running")
    proc = Path("/proc") / str(pid)
    environment = selected_environment(pid)
    data = Path(environment["LIFELINE_CONTRIBUTIONS_DIR"]).resolve(strict=True)
    database = data / "contributions.sqlite3"
    command = [part.decode() for part in (proc / "cmdline").read_bytes().split(b"\0") if part]
    python = Path(command[0]).resolve(strict=True)
    node = resolve_running_node(environment)
    return {"pid": pid, "cwd": str((proc / "cwd").resolve()), "python": str(python), "node": str(node),
            "nodeSource": "running-service-environment:LIFELINE_NODE",
            "database": database_snapshot(database), "serviceUid": int(run(["id", "-u", configuration["User"]]).strip())}


def extract_release(release_dir: Path, release: dict) -> Path:
    service = release_dir / "service"
    if service.exists():
        for name, expected in release["collectorManifest"]["files"].items():
            if sha(service.joinpath(*PurePosixPath(name).parts)) != expected:
                raise RuntimeError("existing staged collector mismatch")
        return service
    with zipfile.ZipFile(release_dir / "collector.zip") as bundle:
        expected_names = {"collector-manifest.json", *{"service/" + name for name in release["collectorManifest"]["files"]}}
        if set(bundle.namelist()) != expected_names:
            raise RuntimeError("collector archive inventory mismatch")
        manifest = json.loads(bundle.read("collector-manifest.json"))
        if manifest != release["collectorManifest"]:
            raise RuntimeError("collector manifest mismatch")
        service.mkdir()
        for name, expected in manifest["files"].items():
            raw = bundle.read("service/" + name)
            if sha_bytes(raw) != expected or not safe_member(name):
                raise RuntimeError("collector file mismatch: " + name)
            target = service.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(raw)
    return service


def synthetic_preflight(identity: dict, service: Path, fixtures: Path) -> dict:
    code = r'''
import json,sys,tempfile,sqlite3
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from training_contributions import ContributionStore
payloads=json.loads(Path(sys.argv[3]).read_text())
with tempfile.TemporaryDirectory(prefix='lifeline-v3-preflight-') as target:
    first=ContributionStore(target,node=sys.argv[2])
    accepted=[first.accept(item) for item in payloads]
    second=ContributionStore(target,node=sys.argv[2])
    repeated=[second.accept(item) for item in payloads]
    assert all(row['status']=='awaiting_review' for row in accepted)
    assert all(row['status']=='duplicate' for row in repeated)
    with second.connect() as db:
        counts={name:db.execute('select count(*) from '+name).fetchone()[0]
                for name in ('inbox','inbox_v2','inbox_v3')}
        assert db.execute('pragma quick_check').fetchall()==[('ok',)]
expected={1:0,2:0,3:0}
for item in payloads: expected[item['version']]+=1
assert counts=={'inbox':expected[1],'inbox_v2':expected[2],'inbox_v3':expected[3]}
print(json.dumps({'status':'PASS_ISOLATED_V1_V2_V3_RESTART_DEDUP','counts':counts,'fixtures':len(payloads)}))
'''
    output = run([identity["python"], "-B", "-c", code, service / "web/backend", identity["node"], fixtures],
                 timeout=180, user=identity["serviceUid"])
    return json.loads(output)


def stage_frontends(release_dir: Path, release: dict) -> tuple[dict, dict]:
    live = frontends(ROOT)
    predecessor_raw = None
    before = {}
    for name, frontend in live.items():
        raw = (frontend / "release-manifest.json").read_bytes()
        manifest = json.loads(raw)
        if manifest.get("release_id") != PREDECESSOR_RELEASE_ID or sha_bytes(raw) != release["predecessorManifestSha256"]:
            raise RuntimeError("production frontend predecessor changed: " + name)
        resource_check(frontend, manifest)
        predecessor_raw = raw if predecessor_raw is None else predecessor_raw
        if raw != predecessor_raw:
            raise RuntimeError("production frontend manifests differ")
        before[name] = {"tree": tree(frontend), "manifest": sha_bytes(raw)}
    with zipfile.ZipFile(release_dir / "frontend-overlay.zip") as bundle:
        if set(bundle.namelist()) != set(OVERLAY_FILES) | {"release-manifest.json"}:
            raise RuntimeError("frontend overlay inventory mismatch")
        manifest_raw = bundle.read("release-manifest.json")
        if sha_bytes(manifest_raw) != release["frontendManifestSha256"]:
            raise RuntimeError("frontend manifest hash mismatch")
        manifest = json.loads(manifest_raw)
        if manifest.get("release_id") != FRONTEND_RELEASE_ID or manifest.get("asset_version") != ASSET_VERSION:
            raise RuntimeError("frontend release identity mismatch")
        predecessor = json.loads(predecessor_raw)
        if set(manifest["files"]) != set(predecessor["files"]):
            raise RuntimeError("frontend resource set changed")
        if any(manifest["files"][name] != expected for name, expected in predecessor["files"].items()
               if name not in OVERLAY_FILES):
            raise RuntimeError("frontend overlay changed an unrelated resource")
        for name in OVERLAY_FILES:
            if sha_bytes(bundle.read(name)) != manifest["files"][name]:
                raise RuntimeError("frontend overlay hash mismatch: " + name)
        candidates = {}
        for name, frontend in live.items():
            candidate = release_dir / ("candidate-" + name)
            if candidate.exists():
                raise RuntimeError("stale frontend candidate exists")
            shutil.copytree(frontend, candidate)
            if tree(candidate) != before[name]["tree"]:
                raise RuntimeError("frontend changed while copying")
            for relative in OVERLAY_FILES:
                (candidate / relative).write_bytes(bundle.read(relative))
            (candidate / "release-manifest.json").write_bytes(manifest_raw)
            owner = frontend.stat()
            for directory, _, files in os.walk(candidate):
                os.chown(directory, owner.st_uid, owner.st_gid)
                for file in files:
                    os.chown(Path(directory) / file, owner.st_uid, owner.st_gid)
            resource_check(candidate, manifest)
            candidates[name] = {"path": str(candidate), "tree": tree(candidate)}
        if len({row["tree"] for row in candidates.values()}) != 1:
            raise RuntimeError("frontend candidates differ")
    return {"before": before, "candidates": candidates}, manifest


def collector_dropin(service: Path, identity: dict) -> bytes:
    node = str(Path(identity["node"]).resolve(strict=True))
    if any(character in node for character in ('\n', '\r', '\0', '"')):
        raise RuntimeError("unsafe LIFELINE_NODE path")
    content = (f"[Service]\nWorkingDirectory={service / 'web/backend'}\nExecStart=\n"
               f"ExecStart={identity['python']} -B -m uvicorn contribution_asgi:app --host 127.0.0.1 --port 8005 "
               "--proxy-headers --forwarded-allow-ips=127.0.0.1 --no-access-log\n"
               "Environment=PYTHONDONTWRITEBYTECODE=1\n"
               f'Environment="LIFELINE_NODE={node}"\n')
    return content.encode()


def dropin_pending_path() -> Path:
    return DROPIN.with_name(f".{DROPIN.name}.{RELEASE_ID}.pending")


def write_dropin(content: bytes, pending: Path) -> str:
    if pending != dropin_pending_path() or pending.parent != DROPIN.parent:
        raise RuntimeError("unexpected collector drop-in pending path")
    if os.path.lexists(DROPIN):
        raise RuntimeError("v3 collector drop-in already exists")
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(pending):
        raise RuntimeError("stale collector drop-in pending file exists")
    with pending.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(pending, 0o644)
    if os.path.lexists(DROPIN):
        raise RuntimeError("v3 collector drop-in appeared during publication")
    # The fully flushed file becomes visible to systemd in one same-directory
    # rename.  A failure before this point leaves only the transaction-specific
    # pending path for recovery to quarantine.
    os.replace(pending, DROPIN)
    if hasattr(os, "O_DIRECTORY"):
        directory = os.open(DROPIN.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    return sha_bytes(content)


def backup_database(identity: dict, release_dir: Path) -> dict:
    database = Path(identity["database"]["path"])
    backup = release_dir / "before.sqlite3"
    code = ("import sqlite3,sys; a=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); "
            "b=sqlite3.connect(sys.argv[2]); a.backup(b); "
            "assert b.execute('pragma quick_check').fetchall()==[('ok',)]; b.close(); a.close()")
    run([identity["python"], "-B", "-c", code, str(database), str(backup)],
        user=identity["serviceUid"], timeout=120)
    os.chmod(backup, 0o600)
    return {"path": str(backup), "sha256": sha(backup), "bytes": backup.stat().st_size}


def migrate_database(identity: dict, service: Path) -> dict:
    code = r'''
import json,sys
sys.path.insert(0,sys.argv[1])
from training_contributions import ContributionStore
store=ContributionStore(sys.argv[2],node=sys.argv[3])
with store.connect() as db:
 assert db.execute('pragma quick_check').fetchall()==[('ok',)]
 counts={name:db.execute('select count(*) from '+name).fetchone()[0]
         for name in ('inbox','inbox_v2','inbox_v3')}
print(json.dumps({'status':'APPEND_ONLY_INBOX_V3_READY','counts':counts}))
'''
    database = Path(identity["database"]["path"])
    output = run([identity["python"], "-B", "-c", code, service / "web/backend",
                  database.parent, identity["node"]], user=identity["serviceUid"], timeout=120)
    return json.loads(output)


def public_verify(manifest: dict) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 100
    targets = {name: manifest["files"][name] for name in OVERLAY_FILES}
    def fetch(path: str) -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("public verification deadline")
        url = "https://lifelinegame.cn/" + urllib.parse.quote(path, safe="/")
        request = urllib.request.Request(url + ("?v=" + ASSET_VERSION if path else ""),
                                         headers={"Cache-Control": "no-cache"})
        with opener.open(request, timeout=min(15, remaining)) as response:
            return response.read()
    def check(item: tuple[str, str]) -> tuple[str, int]:
        name, expected = item
        raw = fetch(name)
        if sha_bytes(raw) != expected:
            raise RuntimeError("public frontend mismatch: " + name)
        return name, len(raw)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = dict(pool.map(check, targets.items()))
    status = json.loads(fetch("api/training/contributions/status"))
    if status.get("supported_versions") != [1, 2, 3] or status.get("consent_policies") != EXPECTED_POLICIES:
        raise RuntimeError("public collector v3 capability mismatch")
    return {"status": "PASS_PUBLIC_OVERLAY_HASHES_AND_COLLECTOR_V3", "files": rows,
            "supportedVersions": status["supported_versions"]}


def rollback_frontends(release_dir: Path, state: dict) -> None:
    for name, frontend in reversed(list(frontends(ROOT).items())):
        rollback = release_dir / ("rollback-" + name)
        interrupted = Path(state["frontend"]["candidates"][name]["path"])
        expected_old = state["frontend"]["before"][name]["tree"]
        candidate_tree = state["frontend"]["candidates"][name]["tree"]
        if tree(frontend) == expected_old:
            continue
        predecessor = rollback if rollback.exists() else interrupted
        if tree(frontend) != candidate_tree or not predecessor.exists() or tree(predecessor) != expected_old:
            raise RuntimeError("frontend rollback identity mismatch: " + name)
        exchange(frontend, predecessor)
        if predecessor == interrupted:
            predecessor.rename(rollback)


def rollback_collector(release_dir: Path, state: dict) -> dict:
    expected = state.get("collector", {}).get("dropinSha256")
    if not expected:
        configuration = unit_configuration()
        if configuration["MainPID"] == "0" or configuration["ActiveState"] != "active":
            systemctl("start", UNIT)
        return wait_status([1, 2])
    pending_value = state.get("collector", {}).get("dropinPendingPath")
    pending = Path(pending_value) if pending_value else None
    if pending is not None:
        if pending != dropin_pending_path() or pending.parent != DROPIN.parent:
            raise RuntimeError("collector rollback pending path mismatch")
        if os.path.lexists(pending):
            pending_archive = release_dir / "rollback-91-replay-collection-v3.pending"
            if pending_archive.exists():
                raise RuntimeError("collector rollback pending archive already exists")
            os.replace(pending, pending_archive)
    configuration = unit_configuration()
    if os.path.lexists(DROPIN):
        if DROPIN.is_symlink() or not DROPIN.is_file() or sha(DROPIN) != expected:
            raise RuntimeError("collector rollback drop-in identity mismatch")
        if configuration["MainPID"] != "0" and configuration["ActiveState"] == "active":
            systemctl("stop", UNIT)
        configuration = {**configuration, "MainPID": "0", "ActiveState": "inactive"}
    archive = release_dir / "rollback-91-replay-collection-v3.conf"
    if DROPIN.exists():
        if archive.exists():
            raise RuntimeError("collector rollback archive already exists")
        os.rename(DROPIN, archive)
    elif archive.exists() and sha(archive) != expected:
        raise RuntimeError("collector rollback archive identity mismatch")
    # Reload even when publication failed before the file appeared: stop or
    # daemon-reload may have succeeded remotely before its caller saw an error.
    systemctl("daemon-reload")
    if configuration["MainPID"] != "0" and configuration["ActiveState"] == "active":
        systemctl("stop", UNIT)
    systemctl("start", UNIT)
    status = wait_status([1, 2])
    before_configuration = state.get("collector", {}).get("beforeConfiguration")
    before_identity = state.get("collector", {}).get("beforeIdentity")
    if before_configuration:
        after_configuration = unit_configuration()
        for name in ("WorkingDirectory", "User", "FragmentPath", "DropInPaths"):
            if after_configuration.get(name) != before_configuration.get(name):
                raise RuntimeError("collector predecessor configuration not restored: " + name)
        if before_identity:
            after_identity = process_identity(after_configuration)
            for name in ("cwd", "python", "node"):
                if after_identity.get(name) != before_identity.get(name):
                    raise RuntimeError("collector predecessor process not restored: " + name)
            before_database = before_identity.get("database", {})
            after_database = after_identity.get("database", {})
            for name in ("device", "inode"):
                if after_database.get(name) != before_database.get(name):
                    raise RuntimeError("collector predecessor database not preserved: " + name)
    return status


def load_release(release_dir: Path) -> dict:
    release_dir = release_dir.resolve(strict=True)
    expected_parent = (ROOT / ".deploy-artifacts").resolve(strict=True)
    if release_dir.parent != expected_parent or release_dir.name != RELEASE_ID:
        raise RuntimeError("unexpected release directory")
    release = json.loads((release_dir / "release.json").read_text(encoding="utf-8"))
    if release.get("releaseId") != RELEASE_ID or release.get("schemaVersion") != 1:
        raise RuntimeError("release identity mismatch")
    for name, expected in release["files"].items():
        if sha(release_dir / name) != expected:
            raise RuntimeError("release artifact mismatch: " + name)
    if sha(Path(__file__).resolve()) != release["files"]["activate.py"]:
        raise RuntimeError("activation script identity mismatch")
    return release


def load_local_release(release_dir: Path) -> dict:
    release_dir = release_dir.resolve(strict=True)
    release = json.loads((release_dir / "release.json").read_text(encoding="utf-8"))
    if release.get("schemaVersion") != 1 or release.get("releaseId") != RELEASE_ID:
        raise RuntimeError("local release identity mismatch")
    if set(release.get("files", {})) != {"activate.py", "collector.zip", "synthetic-fixtures.json",
                                                "frontend-overlay.zip"}:
        raise RuntimeError("local release inventory mismatch")
    for name, expected in release["files"].items():
        if sha(release_dir / name) != expected:
            raise RuntimeError("local release artifact mismatch: " + name)
    return release


def transfer(release_dir: Path, host: str, activate_after_transfer: bool) -> None:
    """Stage the exact prepared release over one interactive SSH connection."""
    release_dir = release_dir.resolve(strict=True)
    release = load_local_release(release_dir)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.write(release_dir / "release.json", "release.json")
        for name in sorted(release["files"]):
            bundle.write(release_dir / name, name)
    encoded = base64.b64encode(stream.getvalue())
    bootstrap = f'''
import base64,hashlib,io,json,pathlib,subprocess,sys,zipfile
release_id={RELEASE_ID!r}
activate={activate_after_transfer!r}
raw=base64.b64decode(sys.stdin.buffer.read(),validate=True)
with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
 names=set(bundle.namelist())
 if 'release.json' not in names: raise RuntimeError('missing release descriptor')
 release=json.loads(bundle.read('release.json'))
 if release.get('schemaVersion')!=1 or release.get('releaseId')!=release_id: raise RuntimeError('release identity mismatch')
 expected=set(release.get('files',{{}}))|{{'release.json'}}
 if names!=expected: raise RuntimeError('release transfer inventory mismatch')
 for name,digest in release['files'].items():
  if hashlib.sha256(bundle.read(name)).hexdigest()!=digest: raise RuntimeError('release transfer hash mismatch: '+name)
 root=pathlib.Path('/home/ubuntu/line-game').resolve(strict=True)
 artifacts=(root/'.deploy-artifacts').resolve(strict=True)
 target=artifacts/release_id
 if target.exists():
  if not target.is_dir() or target.is_symlink(): raise RuntimeError('existing release target is unsafe')
  current=json.loads((target/'release.json').read_text())
  if current!=release: raise RuntimeError('existing release descriptor differs')
  for name,digest in release['files'].items():
   if hashlib.sha256((target/name).read_bytes()).hexdigest()!=digest: raise RuntimeError('existing staged file differs: '+name)
  status='ALREADY_STAGED_EXACT_RELEASE'
 else:
  target.mkdir(mode=0o700)
  for name in sorted(expected):
   destination=target/name
   with destination.open('xb') as handle: handle.write(bundle.read(name))
  status='STAGED_EXACT_RELEASE'
 print(json.dumps({{'status':status,'releaseDirectory':str(target)}}),flush=True)
 if activate:
  subprocess.run(['sudo','-n','/usr/bin/python3','-B',str(target/'activate.py'),'activate','--release-dir',str(target)],check=True)
'''
    compile(bootstrap, "remote-transfer-bootstrap.py", "exec")
    bootstrap_encoded = base64.b64encode(bootstrap.encode()).decode()
    remote = ("python3 -c \"import base64;exec(compile(base64.b64decode('" + bootstrap_encoded
              + "'),'<release-transfer>','exec'))\"")
    print(f"Staging {RELEASE_ID} on {host}; enter the existing SSH password only in this terminal.", flush=True)
    result = subprocess.run(["ssh", "-o", "BatchMode=no", "-o", "StrictHostKeyChecking=yes",
                             "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
                             "-o", "ServerAliveCountMax=4", host, remote], input=encoded)
    if result.returncode:
        raise SystemExit(result.returncode)


def verify_active(release_dir: Path, release: dict, state: dict) -> dict:
    status = wait_status([1, 2, 3])
    if status.get("consent_policies") != EXPECTED_POLICIES:
        raise RuntimeError("collector policy mismatch")
    configuration = unit_configuration()
    identity = process_identity(configuration)
    if Path(identity["cwd"]) != release_dir / "service/web/backend":
        raise RuntimeError("collector does not run from this release")
    if not DROPIN.exists() or sha(DROPIN) != state["collector"]["dropinSha256"]:
        raise RuntimeError("collector drop-in mismatch")
    manifest = json.loads(zipfile.ZipFile(release_dir / "frontend-overlay.zip").read("release-manifest.json"))
    for frontend in frontends(ROOT).values():
        if sha(frontend / "release-manifest.json") != release["frontendManifestSha256"]:
            raise RuntimeError("installed frontend manifest mismatch")
        resource_check(frontend, manifest)
    return {"status": "PASS_ACTIVE_COLLECTOR_V3_AND_BOTH_FRONTENDS",
            "collector": status, "database": identity["database"]}


def activate(release_dir: Path, release: dict) -> dict:
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("production activation requires Linux root")
    receipt = release_dir / "deployment.json"
    if receipt.exists():
        state = json.loads(receipt.read_text(encoding="utf-8"))
        if state.get("status") == "ACTIVATED_AND_PUBLIC_VERIFIED":
            state["repeatVerify"] = verify_active(release_dir, release, state)
            return state
        raise RuntimeError("deployment receipt exists; inspect it and use verify/rollback")
    service = extract_release(release_dir, release)
    configuration = unit_configuration()
    if configuration["User"] != "ubuntu":
        raise RuntimeError("unexpected collector service user")
    before_status = local_status()
    if before_status.get("supported_versions") != [1, 2]:
        raise RuntimeError("collector predecessor changed")
    identity = process_identity(configuration)
    for name in ("validate_contribution.mjs", "training_contribution_schema.mjs"):
        run([identity["node"], "--check", service / "web/tools" / name], user=identity["serviceUid"])
    if "collector-v2-current-sync-20261023-r2" not in identity["cwd"]:
        raise RuntimeError("collector predecessor package changed")
    preflight = synthetic_preflight(identity, service, release_dir / "synthetic-fixtures.json")
    staged_frontend, frontend_manifest = stage_frontends(release_dir, release)
    dropin_content = collector_dropin(service, identity)
    dropin_pending = dropin_pending_path()
    if os.path.lexists(DROPIN) or os.path.lexists(dropin_pending):
        raise RuntimeError("v3 collector drop-in path is not clean before activation")
    state = {"schemaVersion": 1, "releaseId": RELEASE_ID, "status": "PREFLIGHT_OK",
             "startedAtUtcEpoch": time.time(), "collector": {"beforeStatus": before_status,
             "beforeConfiguration": configuration, "beforeIdentity": identity, "synthetic": preflight,
             "dropinBefore": {"exists": False}, "dropinSha256": sha_bytes(dropin_content),
             "dropinPendingPath": str(dropin_pending)},
             "frontend": staged_frontend,
             "databaseRestored": False, "swappedFrontends": []}
    save_atomic(receipt, state)
    collector_transition_started = False
    try:
        # From this assignment onward every exception takes the predecessor
        # restoration path, including a stop call whose result is ambiguous.
        collector_transition_started = True
        systemctl("stop", UNIT)
        if systemctl("show", UNIT, "-p", "MainPID", "--value").strip() != b"0":
            raise RuntimeError("collector did not stop")
        state["status"] = "COLLECTOR_STOPPED"
        save_atomic(receipt, state)
        quiescent = database_snapshot(Path(identity["database"]["path"]))
        if (quiescent["device"], quiescent["inode"]) != \
                (identity["database"]["device"], identity["database"]["inode"]):
            raise RuntimeError("collector database identity changed before backup")
        state["collector"]["quiescentDatabase"] = quiescent
        state["collector"]["backup"] = backup_database(identity, release_dir)
        state["collector"]["migration"] = migrate_database(identity, service)
        state["status"] = "DATABASE_BACKED_UP_AND_V3_TABLE_READY"
        save_atomic(receipt, state)
        if write_dropin(dropin_content, dropin_pending) != state["collector"]["dropinSha256"]:
            raise RuntimeError("published collector drop-in hash mismatch")
        state["status"] = "V3_DROPIN_WRITTEN"
        save_atomic(receipt, state)
        systemctl("daemon-reload")
        systemctl("start", UNIT)
        state["collector"]["afterStatus"] = wait_status([1, 2, 3])
        after_configuration = unit_configuration()
        after_identity = process_identity(after_configuration)
        if (after_identity["database"]["device"], after_identity["database"]["inode"]) != \
                (identity["database"]["device"], identity["database"]["inode"]):
            raise RuntimeError("collector database identity changed")
        baseline_counts = state["collector"]["migration"]["counts"]
        after_counts = after_identity["database"]["counts"]
        if any(after_counts.get(table, -1) < baseline_counts[table]
               for table in ("inbox", "inbox_v2", "inbox_v3")):
            raise RuntimeError("collector rows disappeared during activation")
        state["collector"]["rowsAcceptedDuringActivation"] = {
            table: after_counts[table] - baseline_counts[table]
            for table in ("inbox", "inbox_v2", "inbox_v3")
        }
        if Path(after_identity["cwd"]) != service / "web/backend":
            raise RuntimeError("collector working directory mismatch")
        state["collector"]["afterIdentity"] = after_identity
        state["status"] = "COLLECTOR_V3_ACTIVE"
        save_atomic(receipt, state)
        for name, frontend in frontends(ROOT).items():
            candidate = Path(state["frontend"]["candidates"][name]["path"])
            exchange(frontend, candidate)
            rollback = release_dir / ("rollback-" + name)
            candidate.rename(rollback)
            state["swappedFrontends"].append(name)
            save_atomic(receipt, state)
        state["public"] = public_verify(frontend_manifest)
        state["status"] = "ACTIVATED_AND_PUBLIC_VERIFIED"
        state["finishedAtUtcEpoch"] = time.time()
        save_atomic(receipt, state)
        return state
    except BaseException as error:
        state["error"] = type(error).__name__ + ": " + str(error)
        state["status"] = "RECOVERY_RUNNING"
        failures = []
        journal_failures = []
        try:
            save_atomic(receipt, state)
        except BaseException as journal_error:
            journal_failures.append("recovery-start:" + str(journal_error))
        try:
            rollback_frontends(release_dir, state)
        except BaseException as rollback_error:
            failures.append("frontends:" + str(rollback_error))
        if collector_transition_started:
            try:
                state["collector"]["rollbackStatus"] = rollback_collector(release_dir, state)
            except BaseException as rollback_error:
                failures.append("collector:" + str(rollback_error))
        state["recoveryFailures"] = failures
        state["recoveryJournalFailures"] = journal_failures
        state["status"] = "RECOVERED_PREDECESSOR" if not failures else "RECOVERY_REQUIRES_ATTENTION"
        state["finishedAtUtcEpoch"] = time.time()
        try:
            save_atomic(receipt, state)
        except BaseException as journal_error:
            journal_failures.append("recovery-finish:" + str(journal_error))
        raise


def rollback(release_dir: Path, release: dict) -> dict:
    receipt = release_dir / "deployment.json"
    state = json.loads(receipt.read_text(encoding="utf-8"))
    if state.get("status") in {"ROLLED_BACK_PREDECESSOR_DATA_PRESERVED", "RECOVERED_PREDECESSOR"}:
        raise RuntimeError("deployment is not in a rollbackable state")
    failures = []
    try:
        rollback_frontends(release_dir, state)
    except BaseException as error:
        failures.append("frontends:" + str(error))
    try:
        state["collector"]["rollbackStatus"] = rollback_collector(release_dir, state)
    except BaseException as error:
        failures.append("collector:" + str(error))
    state["recoveryFailures"] = failures
    state["status"] = "ROLLED_BACK_PREDECESSOR_DATA_PRESERVED" if not failures else "RECOVERY_REQUIRES_ATTENTION"
    state["finishedAtUtcEpoch"] = time.time()
    save_atomic(receipt, state)
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "transfer", "activate", "verify", "rollback"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--host", default="ubuntu@81.70.240.251")
    parser.add_argument("--activate-after-transfer", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        if args.output is None:
            parser.error("--output is required for prepare")
        prepare(args.output)
        return
    if args.command == "transfer":
        if args.release_dir is None:
            parser.error("--release-dir is required for transfer")
        transfer(args.release_dir, args.host, args.activate_after_transfer)
        return
    if args.release_dir is None:
        parser.error("--release-dir is required")
    release_dir = args.release_dir.resolve(strict=True)
    release = load_release(release_dir)
    artifacts = ROOT / ".deploy-artifacts"
    with (artifacts / "unified-release.lock").open("a") as unified, \
            (artifacts / "frontend-release.lock").open("a") as frontend:
        fcntl.flock(unified, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(frontend, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "activate":
            result = activate(release_dir, release)
        elif args.command == "rollback":
            result = rollback(release_dir, release)
        else:
            state = json.loads((release_dir / "deployment.json").read_text(encoding="utf-8"))
            result = verify_active(release_dir, release, state)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
