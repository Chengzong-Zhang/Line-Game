"""Rebuild the isolated mobile source candidate from versioned inputs.

The shared Web input defaults to this checkout; model resources are explicitly
supplied separately. This prepares source only and does not install, sign, or
publish. Its hash checks fail closed if any source or model byte changed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "working" / "docs" / "maintenance" / "alignment-20261031"
HOST = ROOT / "working" / "platform-hosts" / "mobile"
INVENTORY = DOCS / "mobile-shared-web-inventory.json"
OVERLAY = DOCS / "mobile-shared-web-overlay.patch"
OVERLAY_HASHES = DOCS / "mobile-shared-web-overlay-hashes.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked(root, name, sha):
    path = root / name
    if not path.is_file() or path.is_symlink() or digest(path) != sha:
        raise RuntimeError(f"Missing, linked, or changed input: {name}")
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--web-root", type=Path, default=ROOT,
                        help="checkout with the verified shared Web source (default: this repository)")
    parser.add_argument("--resources", type=Path, required=True,
                        help="local root containing the separately supplied model resources")
    parser.add_argument("--destination", type=Path, required=True,
                        help="new empty path inside this repository")
    parser.add_argument("--node-modules", type=Path,
                        help="optional existing offline dependencies; copied but not certified by this tool")
    args = parser.parse_args()
    web = args.web_root.resolve(strict=True)
    resources = args.resources.resolve(strict=True)
    dest = args.destination.resolve()
    if dest == ROOT or not dest.is_relative_to(ROOT) or dest.exists():
        raise RuntimeError("Destination must be a new directory inside the repository.")
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    host = json.loads((HOST / "HOST-SNAPSHOT.json").read_text(encoding="utf-8"))
    hashes = json.loads(OVERLAY_HASHES.read_text(encoding="utf-8"))
    actual_host = {p.relative_to(HOST).as_posix() for p in HOST.rglob("*")
                   if p.is_file() and p.name != "HOST-SNAPSHOT.json"}
    if actual_host != set(host["files"]):
        raise RuntimeError("The versioned mobile host file set differs from its receipt.")
    for name, entry in host["files"].items():
        checked(HOST, name, entry["sha256"])
    for name, entry in inventory["shared_files"].items():
        checked(web, name, entry["sha256"])
    for name, entry in inventory["external_resources"].items():
        checked(resources, name, entry["sha256"])
    for name, entry in hashes.items():
        if entry["base_sha256"] is None and (web / name).exists():
            raise RuntimeError(f"Overlay expects an absent shared file: {name}")
        if entry["base_sha256"] is not None:
            checked(web, name, entry["base_sha256"])
    dest.mkdir(parents=True)
    for names, source in ((inventory["shared_files"], web), (inventory["external_resources"], resources)):
        for name in names:
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
    for name, entry in inventory["line_endings"].items():
        path = dest / name
        lines = path.read_bytes().replace(b"\r\n", b"\n").splitlines(keepends=True)
        crlf = set(entry["crlf_lines"])
        path.write_bytes(b"".join(line[:-1] + b"\r\n" if index in crlf and line.endswith(b"\n") else line
                                  for index, line in enumerate(lines, 1)))
        checked(dest, name, entry["candidate_sha256"])
    for name in host["files"]:
        if name.startswith("evidence/"):
            target = dest / name.removeprefix("evidence/")
        else:
            target = dest / "mobile" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(HOST / name, target)
    (dest / "mobile" / "local_artifacts").mkdir(parents=True, exist_ok=True)
    relative = dest.relative_to(ROOT).as_posix()
    command = ["git", "apply", "--ignore-space-change", "--ignore-whitespace",
               f"--directory={relative}", str(OVERLAY)]
    subprocess.run(command[:2] + ["--check"] + command[2:], cwd=ROOT, check=True)
    subprocess.run(command, cwd=ROOT, check=True)
    for name, entry in hashes.items():
        checked(dest, name, entry["candidate_sha256"])
    expected = set(inventory["shared_files"]) | set(inventory["external_resources"]) | set(hashes)
    expected.update(name.removeprefix("evidence/") if name.startswith("evidence/")
                    else f"mobile/{name}" for name in host["files"])
    actual = {p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()}
    if actual != expected:
        raise RuntimeError(f"Prepared source file set differs: missing={len(expected - actual)}, extra={len(actual - expected)}")
    sync = json.loads((dest / "mobile/config/aligned-sync-manifest.json").read_text(encoding="utf-8"))
    adaptations = {entry["path"]: entry["mobile_sha256"] for entry in sync["mobile_adaptations"]}
    for name, source_hash in sync["source_files"].items():
        checked(dest / "web/web前端", name, adaptations.get(name, source_hash))
    if args.node_modules:
        shutil.copytree(args.node_modules.resolve(strict=True), dest / "mobile" / "node_modules", symlinks=False)
    print(json.dumps({"status": "PREPARED_SOURCE_ONLY", "destination": str(dest),
                      "shared_files": len(inventory["shared_files"]),
                      "external_resources": len(inventory["external_resources"]),
                      "mobile_host_files": len(host["files"]),
                      "mobile_web_overlay_files": len(hashes),
                      "native_or_device_acceptance": "NOT_RUN"}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Preparation failed: {exc}", file=sys.stderr)
        sys.exit(1)
