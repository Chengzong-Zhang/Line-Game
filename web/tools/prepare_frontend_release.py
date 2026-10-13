"""Freeze a complete Web runtime and a hash-bound atomic deployment overlay."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


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
    imports = re.compile(r"(['\"])((?:\./|\.\./)[^'\"\r\n]+?\.js)(?:\?v=[^'\"\r\n]*)?\1")
    for source in frontend.glob("*.js"):
        text = source.read_text(encoding="utf-8")
        text = imports.sub(lambda match: f"{match[1]}{match[2]}?v={args.asset_version}{match[1]}", text)
        if source.name == "main.js":
            text = re.sub(r'const APP_ASSET_VERSION = "[^"]+";', f'const APP_ASSET_VERSION = "{args.asset_version}";', text)
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
    for path in sorted(frontend.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(frontend).as_posix()
        if name.startswith("tests/") or name == "smoke-test.html" or any(part.startswith(".") for part in path.relative_to(frontend).parts):
            continue
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
