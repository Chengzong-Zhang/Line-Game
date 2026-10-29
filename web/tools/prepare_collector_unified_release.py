"""Freeze a collector runtime, migration probe, synthetic fixtures and rollback."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory(root):
    return {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file()}


def prepare(baseline_path, output):
    baseline = json.loads(baseline_path.read_text(encoding="utf-8-sig"))
    output.mkdir(parents=True, exist_ok=False)
    service = output / "service"
    prior = output / "baseline-runtime"
    source_hashes = {}
    for name, expected in baseline["files"].items():
        assert ".." not in Path(name).parts and not Path(name).is_absolute()
        content = base64.b64decode(baseline["contents"][name], validate=True)
        assert digest(content) == expected
        for root in (service, prior):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

    def copy(source, name):
        assert source.is_file() and not source.is_symlink()
        content = source.read_bytes()
        source_hashes[source.relative_to(ROOT).as_posix()] = digest(content)
        target = service / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    for name in ("contribution_asgi.py", "training_contributions.py"):
        copy(ROOT / "web/web后端" / name, "web/backend/" + name)
    for name in ("validate_contribution.mjs", "training_contribution_schema.mjs"):
        copy(ROOT / "web/tools" / name, "web/tools/" + name)
    copy(ROOT / "web/package.json", "web/package.json")
    frontend = ROOT / "web/web前端"
    for file in sorted(frontend.rglob("*")):
        relative = file.relative_to(frontend)
        if file.is_file() and relative.parts[0] != "tests" and file.suffix in (".js", ".mjs", ".json", ".f32"):
            copy(file, "web/web前端/" + relative.as_posix())
    probe = ROOT / "working/docs/verification/unified-release-20261029/collector-probe.py"
    shutil.copyfile(probe, output / "collector-probe.py")
    fixtures = output / "fixtures"
    fixtures.mkdir()
    specs = [
        ("create-training-fixture.mjs", None),
        ("create-training-v2-fixture.mjs", {"playerCount": 3, "startingPointMode": "random", "undoUsedCount": 1, "profile": "three-player-policy-v2"}),
        ("create-training-v3-fixture.mjs", {"playerCount": 15, "boardShape": "triangle", "gridSize": 15, "startingPointMode": "random", "undoUsedCount": 1, "profile": "multiplayer-hard-v1"}),
    ]
    for i, (name, options) in enumerate(specs, 1):
        args = ["node", str(frontend / "tests/fixtures" / name)]
        if options:
            args.append(json.dumps(options))
        content = subprocess.check_output(args, cwd=ROOT, timeout=60)
        value = json.loads(content)
        assert value["version"] == i
        (fixtures / f"v{i}.json").write_bytes(content)
    for name, expected in source_hashes.items():
        assert digest((ROOT / name).read_bytes()) == expected, "Concurrent source change: " + name
    assert inventory(prior) == baseline["files"]
    manifest = {"kind": "collector-unified-release-v1", "site": baseline["site"],
                "baseline": baseline["files"], "candidate": inventory(service),
                "baselineSupportedVersions": [1, 2], "supportedVersions": [1, 2, 3],
                "probeSha256": digest((output / "collector-probe.py").read_bytes()),
                "fixtureHashes": inventory(fixtures), "sourceHashes": source_hashes}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    rollback = output / "rollback-bundle"
    rollback.mkdir()
    shutil.copytree(prior, rollback / "service")
    shutil.copytree(fixtures, rollback / "fixtures")
    shutil.copyfile(probe, rollback / "collector-probe.py")
    reverse = {**manifest, "baseline": manifest["candidate"], "candidate": manifest["baseline"],
               "baselineSupportedVersions": [1, 2, 3], "supportedVersions": [1, 2]}
    (rollback / "manifest.json").write_text(json.dumps(reverse, indent=2, ensure_ascii=False), encoding="utf-8")
    result = {"status": "FROZEN_NOT_DEPLOYED", "runtimeFiles": len(manifest["candidate"]),
              "manifestSha256": digest((output / "manifest.json").read_bytes()),
              "rollbackManifestSha256": digest((rollback / "manifest.json").read_bytes()),
              "containsProductionData": False}
    (output / "preparation.json").write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.baseline, args.output)))
