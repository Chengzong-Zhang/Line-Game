"""Build a read-only, hash-bound Web multiplayer overlay from current bytes.

The ZIP contains repository-relative web/... paths; its manifest stays beside
the ZIP so it can record the complete archive hash without a circular digest.
No cache stamping, Git changes, service access or source rewriting occurs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


SCHEMA = {"name": "lifeline-multiplayer-release", "version": 1}
FRONTEND = Path("web/web前端")
BACKEND_FILES = (
    "web/web后端/server.py",
    "web/web后端/online_bots.py",
    "web/web后端/training_contributions.py",
    "web/web后端/contribution_asgi.py",
)
TOOL_FILES = (
    "web/tools/online_bot_bridge.mjs",
    "web/tools/validate_contribution.mjs",
)
FROZEN_SOURCES = (
    "web/web前端/GameEngine.js",
    "web/web前端/AIEngine.js",
    "web/web前端/ThreePlayerAI.js",
    "web/tools/train-three-player-ai.mjs",
)
SAFE_FRONTEND_SUFFIXES = frozenset({
    ".js", ".mjs", ".html", ".css", ".json", ".f32", ".png", ".jpg",
    ".jpeg", ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".md", ".tex",
})
SECRET_SUFFIXES = frozenset({
    ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
})
PRIVATE_KEY = re.compile(rb"-----BEGIN [A-Z0-9 ]{0,80}PRIVATE KEY(?: BLOCK)?-----")
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_BYTES = 256 * 1024 * 1024


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args], cwd=root, text=True, encoding="utf-8", errors="strict",
        stderr=subprocess.PIPE,
    ).strip()


def checked_file(root: Path, relative: Path) -> Path:
    path = root / relative
    # A symlink or junction must not smuggle external files into an overlay.
    for candidate in (path, *path.parents):
        if candidate == root:
            break
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError(f"Linked runtime path is forbidden: {relative.as_posix()}")
    if not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError(f"Missing or outside-repository runtime file: {relative.as_posix()}")
    return path


def reject_sensitive_name(relative: Path) -> None:
    for part in relative.parts:
        name = part.lower()
        if (name == ".env" or name.startswith(".env.") or name in {"id_rsa", "id_ed25519", "id_dsa"}
                or Path(name).suffix in SECRET_SUFFIXES
                or re.search(r"(?:^|[._-])(?:secrets?|credentials?|private[-_]?keys?)(?:$|[._-])", name)):
            raise ValueError(f"Sensitive runtime path is forbidden: {relative.as_posix()}")


def read_safe(root: Path, relative: Path) -> bytes:
    reject_sensitive_name(relative)
    path = checked_file(root, relative)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Unexpectedly large runtime file: {relative.as_posix()}")
    data = path.read_bytes()
    if PRIVATE_KEY.search(data):
        # Never include the matched bytes or the file contents in the error.
        raise ValueError(f"Private-key material detected in: {relative.as_posix()}")
    return data


def extract_defaults(root: Path) -> dict:
    registry = read_safe(root, FRONTEND / "ThreePlayerModels.js").decode("utf-8-sig")
    selection = read_safe(root, FRONTEND / "LocalAIModes.js").decode("utf-8-sig")
    default_match = re.search(r'DEFAULT_THREE_PLAYER_MODEL_ID\s*=\s*[\'"]([^\'"]+)', registry)
    hash_match = re.search(r"THREE_PLAYER_MODEL_HASHES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)", registry)
    if not default_match or not hash_match:
        raise ValueError("Cannot verify three-player model registry/default.")
    registered = dict(re.findall(r'[\'"](three-player-policy-v\d+)[\'"]\s*:\s*[\'"]([a-f0-9]{64})[\'"]', hash_match.group(1)))
    if default_match.group(1) != "three-player-policy-v1" or set(registered) != {"three-player-policy-v1", "three-player-policy-v2"}:
        raise ValueError("Release requires the existing v1 default and registered v1/v2 models only.")
    for strategy, expected in (("three-player", "three-player-policy-v1"), ("hex-player", "hex-player-policy-v1")):
        match = re.search(r'choice\s*===\s*[\'"]' + strategy + r'[\'"][^\n]+modelId:\s*[\'"]([^\'"]+)', selection)
        if not match or match.group(1) != expected:
            raise ValueError(f"Unexpected existing default for {strategy}; source was not modified.")
    for identifier, digest in registered.items():
        raw = read_safe(root, FRONTEND / "assets/research-ai" / f"{identifier}.json")
        if sha(raw) != digest or json.loads(raw).get("id") != identifier:
            raise ValueError(f"Registered model hash/identity mismatch: {identifier}")
    hex_raw = read_safe(root, FRONTEND / "assets/research-ai/hex-player-policy-v1.json")
    if json.loads(hex_raw).get("id") != "hex-player-policy-v1":
        raise ValueError("Hexagon model identity mismatch.")
    return {
        "three_player_model": default_match.group(1),
        "hex_player_model": "hex-player-policy-v1",
        "registered_three_player_models": registered,
        "hex_player_model_sha256": sha(hex_raw),
        "defaults_modified": False,
    }


def prepare_release(root: Path, output: Path, release_id: str) -> dict:
    root = root.resolve(strict=True)
    output = output.resolve()
    if output.exists():
        raise ValueError("Output directory must not already exist.")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}", release_id):
        raise ValueError("Invalid release id.")
    if output == root or output.is_relative_to(root / FRONTEND):
        raise ValueError("Output may not be inside the frontend source tree.")
    defaults = extract_defaults(root)
    frozen_before = {name: sha(read_safe(root, Path(name))) for name in FROZEN_SOURCES}
    frontend_bytes: dict[str, bytes] = {}
    excluded = []
    for path in sorted((root / FRONTEND).rglob("*")):
        relative = path.relative_to(root)
        local = path.relative_to(root / FRONTEND)
        reject_sensitive_name(relative)
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError(f"Linked runtime path is forbidden: {relative.as_posix()}")
        if not path.is_file():
            continue
        reason = None
        if "tests" in local.parts:
            reason = "test-only"
        elif path.name.startswith("smoke-test"):
            reason = "smoke-test-only"
        elif path.name.endswith(".training-receipt.json"):
            reason = "training-receipt-not-runtime"
        elif (re.fullmatch(r"three-player-policy-v\d+\.json", path.name)
              and path.stem not in defaults["registered_three_player_models"]):
            reason = "model-not-registered"
        if reason:
            excluded.append({"path": relative.as_posix(), "reason": reason})
            continue
        if any(part.startswith(".") for part in local.parts) or path.suffix.lower() not in SAFE_FRONTEND_SUFFIXES:
            raise ValueError(f"Unexpected runtime file: {relative.as_posix()}")
        frontend_bytes[relative.as_posix()] = read_safe(root, relative)
    other_bytes = {name: read_safe(root, Path(name)) for name in (*BACKEND_FILES, *TOOL_FILES)}
    all_bytes = {**frontend_bytes, **other_bytes}
    if extract_defaults(root) != defaults:
        raise ValueError("Model defaults changed while freezing inputs; retry with a new build.")
    source_bytes = sum(map(len, all_bytes.values()))
    if source_bytes > MAX_SOURCE_BYTES:
        raise ValueError("Unexpectedly large release; inspect assets before packaging.")
    source_state = {
        "head": git(root, "rev-parse", "HEAD"),
        "branch": git(root, "branch", "--show-current"),
        "workspace_dirty": bool(git(root, "status", "--porcelain", "--untracked-files=normal")),
    }
    # Build only after every path/model/security preflight passes. Re-read all
    # input hashes after writing, so concurrent source changes fail the build.
    output.mkdir(parents=True, exist_ok=False)
    archive = output / "multiplayer-overlay.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, data in sorted(all_bytes.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, data)
    for name, data in all_bytes.items():
        if sha(read_safe(root, Path(name))) != sha(data):
            raise ValueError(f"Source changed during packaging: {name}; incomplete build must not deploy.")
    frozen_after = {name: sha(read_safe(root, Path(name))) for name in FROZEN_SOURCES}
    if frozen_after != frozen_before:
        raise ValueError("Frozen source changed during packaging; incomplete build must not deploy.")
    if extract_defaults(root) != defaults:
        raise ValueError("Model defaults changed during packaging; incomplete build must not deploy.")
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None or set(bundle.namelist()) != set(all_bytes):
            raise ValueError("Archive verification failed.")
        for name, data in all_bytes.items():
            if bundle.read(name) != data:
                raise ValueError(f"Archive content mismatch: {name}")
    entry = lambda name: {"sha256": sha(all_bytes[name]), "bytes": len(all_bytes[name])}
    manifest = {
        "schema": SCHEMA, "status": "BUILT-AND-VERIFIED", "release_id": release_id,
        "deployment_scope": "complete-frontend-plus-explicit-backend-and-tools-overlay",
        "archive_path_layout": "repository-relative web/...; manifest is a sidecar",
        "git": source_state, "defaults": defaults,
        "frontend_files": {name: entry(name) for name in sorted(frontend_bytes)},
        "backend_files": {name: entry(name) for name in BACKEND_FILES},
        "tool_files": {name: entry(name) for name in TOOL_FILES},
        "excluded_files": excluded,
        "excluded_policy": ["frontend tests/**", "smoke-test*", "*.training-receipt.json", "unregistered three-player models"],
        "preserved_server_files": "all paths outside the explicit overlay, including environment, credentials, databases and TLS files",
        "frozen_source_sha256_before": frozen_before,
        "frozen_source_sha256_after": frozen_after,
        "source_mutated": False, "source_bytes": source_bytes, "file_count": len(all_bytes),
        "archive": {"name": archive.name, "sha256": sha(archive.read_bytes()), "bytes": archive.stat().st_size},
    }
    (output / "release-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new local output directory (must not exist)")
    parser.add_argument("--release-id", required=True)
    args = parser.parse_args()
    manifest = prepare_release(Path(__file__).resolve().parents[2], args.output, args.release_id)
    print(json.dumps({"status": manifest["status"], "release_id": manifest["release_id"],
                      "file_count": manifest["file_count"], "archive": manifest["archive"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
