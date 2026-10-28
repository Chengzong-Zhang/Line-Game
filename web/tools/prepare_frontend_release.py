"""Freeze a complete Web runtime and a hash-bound atomic deployment overlay."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
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


def stamp_module_urls(text, asset_version):
    def replace(match):
        return f"{match['quote']}{match['path']}?v={asset_version}{match['quote']}"

    return MODULE_URL.sub(replace, text)


def validate_module_closure(frontend, paths, text_by_path, asset_version):
    """Reject release graphs that can load a stale or absent local module.

    The same literal URL pattern is used for module imports, dynamic imports,
    and module Worker URLs.  This intentionally also covers generated .mjs
    bundles, which used to retain stale dynamic-import cache tokens.
    """
    root = frontend.resolve()
    manifest_names = {path.relative_to(frontend).as_posix() for path in paths}
    expected_query = f"?v={asset_version}"
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
            if match["query"] != expected_query:
                problems.append(f"{path.relative_to(frontend)} has stale module token {relative}{match['query'] or ''}")
    if problems:
        raise RuntimeError("Frontend module closure failed:\n- " + "\n- ".join(problems))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stamp-only", action="store_true")
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--asset-version", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    frontend = root / "web/web前端"
    # One version per module graph prevents a cached earlier dependency from
    # silently losing a feature while the new application entry point loads.
    # Do this recursively, including generated .mjs Worker bundles.
    paths = runtime_paths(frontend)
    source_texts = {
        path: stamp_module_urls(path.read_text(encoding="utf-8"), args.asset_version)
        for path in paths
        if path.suffix.lower() in {".js", ".mjs"}
    }
    main_source = frontend / "main.js"
    source_texts[main_source] = re.sub(
        r'const APP_ASSET_VERSION = "[^"]+";',
        f'const APP_ASSET_VERSION = "{args.asset_version}";',
        source_texts[main_source],
    )
    validate_module_closure(frontend, paths, source_texts, args.asset_version)
    for source, text in source_texts.items():
        source.write_text(text, encoding="utf-8", newline="\n")
    index = frontend / "index.html"
    text = index.read_text(encoding="utf-8")
    text = re.sub(r'(styles\.css|main\.js)\?v=[^"\s]+', lambda match: f"{match[1]}?v={args.asset_version}", text)
    index.write_text(text, encoding="utf-8", newline="\n")
    if args.stamp_only:
        print("Runtime version stamped")
        return
    if args.output is None:
        parser.error("--output is required when building a bundle")
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
