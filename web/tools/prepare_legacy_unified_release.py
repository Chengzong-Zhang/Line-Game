"""Prepare a source-pinned legacy bridge probe; no remote or live operations."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(baseline, output):
    before = json.loads(baseline.read_text(encoding="utf-8-sig"))
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for name, digest in before.items():
        source = ROOT / name
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        files[name] = {"beforeSha256": digest, "sha256": sha(target)}
    frontend = output / "frontend"
    frontend.mkdir()
    source_front = ROOT / "web/web前端"
    frontend_files = {}
    for source in sorted(source_front.rglob("*")):
        relative = source.relative_to(source_front)
        if source.is_file() and relative.parts[0] != "tests" and source.suffix in (".js", ".mjs", ".json", ".f32", ".html", ".css", ".md", ".png", ".jpg", ".jpeg", ".tex"):
            target = frontend / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            frontend_files[relative.as_posix()] = sha(target)
    for name, expected in frontend_files.items():
        assert sha(source_front / name) == expected, "Concurrent frontend mutation: " + name
    for name, expected in files.items():
        assert sha(ROOT / name) == expected["sha256"], "Concurrent backend mutation"
    for name in ("legacy-probe.py", "legacy-baseline-probe.py"):
        shutil.copyfile(ROOT / "working/docs/verification/unified-release-20261029" / name, output / name)
    manifest = {"files": files, "frontendFiles": frontend_files,
                "probe": {"path": "legacy-probe.py", "sha256": sha(output / "legacy-probe.py")},
                "baselineProbe": {"path": "legacy-baseline-probe.py", "sha256": sha(output / "legacy-baseline-probe.py")}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    for name in ("activate_legacy_release.py", "activate_legacy_unified_release.py"):
        shutil.copyfile(ROOT / "web/tools" / name, output / name)
    shutil.copyfile(ROOT / "wechat/tools/activate_profile_service_live.py", output / "activate_profile_service_live.py")
    return {"status": "FROZEN_NOT_DEPLOYED", "files": len(files), "frontendFiles": len(frontend_files), "manifestSha256": sha(output / "manifest.json")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.baseline, args.output)))
