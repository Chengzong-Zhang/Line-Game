"""Compare or install the repository-maintained LIFELINE skill only."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Copy reviewed skill files; default only compares")
    parser.add_argument("--destination", type=Path, default=Path.home() / ".codex/skills/lifeline-dev")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    source = repo / "working/skills/lifeline-dev"
    target = args.destination.resolve()
    if target.name != "lifeline-dev" or source.resolve() == target:
        parser.error("Destination must be a separate lifeline-dev skill directory")
    if "name: lifeline-dev" not in (source / "SKILL.md").read_text(encoding="utf-8"):
        parser.error("Source does not identify the lifeline-dev skill")
    files = sorted(p for p in source.rglob("*") if p.is_file())
    if any(p.is_symlink() or p.suffix not in {".md", ".yaml"} for p in files):
        parser.error("Unexpected source file; review the maintained skill before installing")
    changed = [p for p in files if sha256(p) != sha256(target / p.relative_to(source))]
    receipt = {
        "mode": "installed" if args.install else "comparison",
        "source": str(source),
        "destination": str(target),
        "fileCount": len(files),
        "changed": [str(p.relative_to(source)) for p in changed],
        "files": [],
    }
    backup = repo / "working/tmp/alignment-20261031/skill-before-install"
    for path in files:
        relative = path.relative_to(source)
        destination = target / relative
        before = sha256(destination)
        if args.install and path in changed:
            if destination.is_file():
                previous = backup / before / relative
                if previous.exists() and sha256(previous) != before:
                    parser.error(f"Existing backup differs; preserve it and review {relative}")
                previous.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(destination, previous)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        after = sha256(destination)
        receipt["files"].append({"path": relative.as_posix(), "before": before, "source": sha256(path), "installed": after})
        if args.install and after != sha256(path):
            raise RuntimeError(f"Installed content differs: {relative}")
    if args.install:
        output = repo / "working/docs/maintenance/alignment-20261031/skill-install.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Installed and hash-verified {len(files)} files; receipt: {output}")
    else:
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
