"""Freeze a complete Web runtime and a hash-bound atomic deployment overlay."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import shutil
import tempfile
import zipfile


# Keep this deliberately limited to JavaScript module URLs.  Asset fetches may
# have their own cache and integrity policies, while a stale ES module is able
# to reintroduce an incompatible runtime graph after a new entry module loads.
MODULE_URL = re.compile(
    r"(?P<quote>['\"`])(?P<path>(?:\./|\.\./)[^'\"`\r\n?#]+?\.(?:js|mjs))"
    r"(?P<query>\?[^'\"`\r\n#]*)?(?P=quote)"
)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def is_runtime_file(frontend, path):
    relative = path.relative_to(frontend)
    return (
        path.is_file()
        and not relative.as_posix().startswith("tests/")
        and relative.name != "smoke-test.html"
        and not any(part.startswith(".") for part in relative.parts)
    )


def runtime_paths(frontend):
    return [path for path in sorted(frontend.rglob("*")) if is_runtime_file(frontend, path)]


# These URLs define import.meta.url-equivalent bases for bundled model loaders;
# they are not imports or requests and changing them changes the frozen bundle.
WORKER_ASSET_BASES = frozenset({
    "./ThreePlayerAI.js", "./ThreePlayerModels.js", "./ThreePlayerRuntime.js", "./HexPlayerAI.js",
})
FROZEN_PREDECESSOR_SHA256 = '376e599578f59e2dc96b625749f694173a596e2621969a03076f5425ed5579f5'
FROZEN_RELEASE_ID = 'web-topology-fix-20261030-r2'
FROZEN_MODULE_VERSION = '20261029-unified-r1'


def is_worker_asset_base(text, match):
    return (match["path"] in WORKER_ASSET_BASES and match["query"] is None
            and re.search(r"\bnew\s+URL\(\s*$", text[:match.start()]) is not None
            and re.match(r"\s*,\s*self\.location\.href\s*\)\s*\.href\b", text[match.end():]) is not None)


def stamp_module_urls(text, asset_version, *, source_path=None, immutable_versions=None):
    def replace(match):
        if is_worker_asset_base(text, match):
            return match.group(0)
        version = (immutable_versions or {}).get((source_path.parent / match['path']).resolve(), asset_version) if source_path else asset_version
        return f"{match['quote']}{match['path']}?v={version}{match['quote']}"

    return MODULE_URL.sub(replace, text)


def validate_module_closure(frontend, paths, text_by_path, asset_version, immutable_versions=None):
    """Reject release graphs that can load a stale or absent local module.

    The same literal URL pattern is used for module imports, dynamic imports,
    and module Worker URLs.  This intentionally also covers generated .mjs
    bundles, which used to retain stale dynamic-import cache tokens.
    """
    root = frontend.resolve()
    manifest_names = {path.relative_to(frontend).as_posix() for path in paths}
    problems = []
    for path, text in text_by_path.items():
        for match in MODULE_URL.finditer(text):
            relative = match["path"]
            target = (path.parent / relative).resolve()
            try:
                name = target.relative_to(root).as_posix()
            except ValueError:
                problems.append(f"{path.relative_to(frontend)} escapes runtime root via {relative}")
                continue
            if not target.is_file():
                problems.append(f"{path.relative_to(frontend)} references missing module {relative}")
            elif name not in manifest_names:
                problems.append(f"{path.relative_to(frontend)} references excluded module {name}")
            expected_query = f"?v={(immutable_versions or {}).get(target, asset_version)}"
            if not is_worker_asset_base(text, match) and match["query"] != expected_query:
                problems.append(f"{path.relative_to(frontend)} has stale module token {relative}{match['query'] or ''}")
    if problems:
        raise RuntimeError("Frontend module closure failed:\n- " + "\n- ".join(problems))


def immutable_worker_closure(frontend, predecessor):
    """Retain a previously published Worker and its *entire* unchanged graph.

    No stale-token exemption is granted to a changed file. Every transitive
    module is checked against the predecessor's public runtime SHA-256, while
    the usual bundle/source manifest checks continue to pin the Worker itself.
    """
    if not isinstance(predecessor.get('asset_version'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{4,100}', predecessor['asset_version']):
        raise RuntimeError('Invalid predecessor asset version')
    manifest = json.loads((frontend / 'MultiplayerHardAIWorker.bundle.manifest.json').read_text(encoding='utf-8'))
    todo = ['MultiplayerHardAIWorker.bundle.mjs', *manifest['sourceHashes']]
    immutable = {}
    while todo:
        name = todo.pop()
        if name in immutable:
            continue
        path = (frontend / name).resolve()
        if path.relative_to(frontend.resolve()).as_posix() != name:
            raise RuntimeError('Invalid immutable module path')
        expected = predecessor['files'].get(name)
        if not expected or not path.is_file() or sha(path.read_bytes()) != expected:
            raise RuntimeError('Immutable Worker dependency changed: ' + name)
        immutable[name] = expected
        text = path.read_text(encoding='utf-8')
        for match in MODULE_URL.finditer(text):
            target = (path.parent / match['path']).resolve()
            todo.append(target.relative_to(frontend.resolve()).as_posix())
    return immutable


def validate_hard_worker(frontend, proposed_texts):
    """Fail before any write if the frozen worker or its source graph drifts."""
    bundle = frontend / "MultiplayerHardAIWorker.bundle.mjs"
    manifest_path = frontend / "MultiplayerHardAIWorker.bundle.manifest.json"
    if not bundle.is_file() or not manifest_path.is_file():
        raise RuntimeError("Hard Worker bundle and manifest are required")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "lifeline-application-hard-worker-bundle-v1":
        raise RuntimeError("Invalid Hard Worker manifest schema")
    sources = manifest.get("sourceHashes")
    if not isinstance(sources, dict) or not sources:
        raise RuntimeError("Hard Worker manifest has no source identities")
    candidates = {bundle: manifest.get("bundleSha256")}
    for name, digest in sources.items():
        if not isinstance(name, str) or Path(name).name != name or not name.endswith(".js"):
            raise RuntimeError("Invalid Hard Worker source path")
        candidates[frontend / name] = digest
    for path, digest in candidates.items():
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise RuntimeError(f"Invalid Hard Worker hash for {path.name}")
        if not path.is_file() or sha(path.read_bytes()) != digest:
            raise RuntimeError(f"Hard Worker input drift: {path.name}")
        if path in proposed_texts and sha(proposed_texts[path].encode("utf-8")) != digest:
            raise RuntimeError(f"Stamp would change frozen Hard Worker input: {path.name}")


def stage_frozen_worker(frontend, snapshot, predecessor, predecessor_hash):
    if predecessor_hash != FROZEN_PREDECESSOR_SHA256 or predecessor.get('release_id') != FROZEN_RELEASE_ID:
        raise RuntimeError('Unexpected frozen Worker predecessor')
    if sha((snapshot / 'predecessor-release-manifest.json').read_bytes()) != predecessor_hash:
        raise RuntimeError('Frozen snapshot predecessor differs from supplied predecessor')
    worker_manifest = 'MultiplayerHardAIWorker.bundle.manifest.json'
    if sha((snapshot / worker_manifest).read_bytes()) != predecessor['files'][worker_manifest]:
        raise RuntimeError('Frozen Worker manifest drift')
    if sha((frontend / worker_manifest).read_bytes()) != predecessor['files'][worker_manifest]:
        raise RuntimeError('Legacy root Worker manifest drift')
    validate_hard_worker(snapshot, {})
    immutable = immutable_worker_closure(snapshot, predecessor)
    if immutable != predecessor['immutable_worker_dependencies']:
        raise RuntimeError('Frozen Worker transitive closure differs from predecessor')
    target = frontend / 'frozen-workers' / FROZEN_RELEASE_ID
    shutil.copytree(snapshot, target, dirs_exist_ok=True)
    for name, expected in predecessor['files'].items():
        if not name.startswith('assets/research-ai/'):
            continue
        source = frontend / name
        if not source.is_file() or sha(source.read_bytes()) != expected:
            raise RuntimeError('Frozen Worker asset drift: ' + name)
        destination = target / name
        if destination.exists() and (not destination.is_file() or sha(destination.read_bytes()) != expected):
            raise RuntimeError('Frozen snapshot asset drift: ' + name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    versions = {(target / name).resolve(): FROZEN_MODULE_VERSION for name in immutable}
    legacy_bundle = frontend / 'MultiplayerHardAIWorker.bundle.mjs'
    if sha(legacy_bundle.read_bytes()) != predecessor['files']['MultiplayerHardAIWorker.bundle.mjs']:
        raise RuntimeError('Legacy root Worker bundle drift')
    versions[legacy_bundle.resolve()] = FROZEN_MODULE_VERSION
    return immutable, versions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stamp-only", action="store_true")
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--asset-version", required=True)
    parser.add_argument("--predecessor-manifest", type=Path)
    parser.add_argument("--predecessor-sha256")
    parser.add_argument("--frozen-worker-snapshot", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    frontend = root / "web/web前端"
    snapshot_mode = args.frozen_worker_snapshot is not None
    if (frontend / 'frozen-workers' / FROZEN_RELEASE_ID).is_dir() and not snapshot_mode:
        raise RuntimeError('Frozen Worker snapshot requires --frozen-worker-snapshot and predecessor validation')
    temporary = None
    if snapshot_mode:
        if args.stamp_only or args.predecessor_manifest is None:
            parser.error('--frozen-worker-snapshot requires a predecessor and a packaged output')
        # Build in isolation: concurrent application changes must never be stamped in place.
        temporary = tempfile.TemporaryDirectory(prefix='lifeline-web-release-')
        staged = Path(temporary.name) / 'frontend'
        shutil.copytree(frontend, staged, ignore=shutil.ignore_patterns('tests', '__pycache__'))
        frontend = staged
    # One version per module graph prevents a cached earlier dependency from
    # silently losing a feature while the new application entry point loads.
    # Do this recursively, including generated .mjs Worker bundles.
    paths = runtime_paths(frontend)
    immutable, immutable_versions, predecessor_hash = {}, {}, None
    if args.predecessor_manifest is not None:
        raw = args.predecessor_manifest.read_bytes()
        if not args.predecessor_sha256 or sha(raw) != args.predecessor_sha256:
            raise RuntimeError('Predecessor manifest SHA-256 mismatch')
        predecessor_hash = sha(raw)
        predecessor = json.loads(raw.decode('utf-8-sig'))
        if snapshot_mode:
            snapshot = args.frozen_worker_snapshot.resolve(strict=True)
            # These are the actual tokens in the immutable published graph,
            # which predate the predecessor release's application token.
            immutable, immutable_versions = stage_frozen_worker(frontend, snapshot, predecessor, predecessor_hash)
            paths = runtime_paths(frontend)
        else:
            validate_hard_worker(frontend, {})
            immutable = immutable_worker_closure(frontend, predecessor)
            immutable_versions = {(frontend / name).resolve(): predecessor['asset_version'] for name in immutable}
    elif args.predecessor_sha256:
        parser.error('--predecessor-sha256 requires --predecessor-manifest')
    source_texts = {
        path: path.read_bytes().decode('utf-8') if path.resolve() in immutable_versions else
            stamp_module_urls(path.read_bytes().decode("utf-8"), args.asset_version, source_path=path, immutable_versions=immutable_versions)
        for path in paths
        if path.suffix.lower() in {".js", ".mjs"}
    }
    main_source = frontend / "main.js"
    source_texts[main_source] = re.sub(
        r'const APP_ASSET_VERSION = "[^"]+";',
        f'const APP_ASSET_VERSION = "{args.asset_version}";',
        source_texts[main_source],
    )
    # Root legacy bundle remains byte-identical for old URLs, but its dynamic
    # imports resolve to the mutable root graph. New clients use the isolated
    # snapshot; no claim of cache isolation is made for old loaded pages.
    checked_texts = {p: text for p, text in source_texts.items()
                     if not (snapshot_mode and p == frontend / 'MultiplayerHardAIWorker.bundle.mjs')}
    validate_module_closure(frontend, paths, checked_texts, args.asset_version, immutable_versions)
    if not args.stamp_only:
        if args.output is None:
            parser.error("--output is required when building a bundle")
        if args.output.resolve().exists():
            raise FileExistsError("Release output must not already exist")
        if not snapshot_mode:
            validate_hard_worker(frontend, source_texts)
    index = frontend / "index.html"
    text = index.read_bytes().decode("utf-8")
    text = re.sub(r'(styles\.css|main\.js)\?v=[^"\s]+', lambda match: f"{match[1]}?v={args.asset_version}", text)
    for source, stamped in source_texts.items():
        raw = stamped.encode("utf-8")
        if source.read_bytes() != raw:
            source.write_bytes(raw)
    if index.read_bytes() != text.encode("utf-8"):
        index.write_bytes(text.encode("utf-8"))
    if args.stamp_only:
        print("Runtime version stamped")
        return
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for path in paths:
        name = path.relative_to(frontend).as_posix()
        if path.suffix.lower() not in {".js", ".mjs", ".html", ".css", ".json", ".f32", ".png", ".jpg", ".jpeg", ".md", ".tex"}:
            raise ValueError(f"Unexpected runtime file: {name}")
        files[name] = sha(path.read_bytes())
    manifest = {
        "release_id": args.release_id,
        "asset_version": args.asset_version,
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, encoding="utf-8").strip(),
        "workspace_dirty": bool(subprocess.check_output(["git", "status", "--porcelain", "--", "web/web前端"], cwd=root, text=True, encoding="utf-8").strip()),
        "deployment_scope": "complete-current-web-frontend-runtime",
        "files": files,
        "source_bytes": sum((frontend / name).stat().st_size for name in files),
        "deleted_files": [],
        "preserved_server_files": ["all files outside this overlay"],
        "immutable_worker_dependencies": immutable,
        "predecessor_manifest_sha256": predecessor_hash,
        "frozen_worker_snapshot": predecessor['release_id'] if snapshot_mode else None,
        "legacy_root_worker_graph_isolated": False if snapshot_mode else None,
    }
    raw_manifest = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    (output / "release-manifest.json").write_bytes(raw_manifest)
    archive = output / "frontend-overlay.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("release-manifest.json", raw_manifest)
        for name in files:
            bundle.write(frontend / name, name)
    receipt = {"release_id": args.release_id, "asset_version": args.asset_version, "archive_sha256": sha(archive.read_bytes()),
               "archive_bytes": archive.stat().st_size, "overlay_file_count": len(files), "source_bytes": manifest["source_bytes"]}
    (output / "bundle-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
