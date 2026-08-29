#!/usr/bin/env python3
"""Create a small immutable AutoDL upload tree without copying formal results."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
INCLUDE = (
    Path("lifeline_rl"),
    Path("lifeline_rl_autodl"),
    Path("scripts/autodl_game_gpu.py"),
    Path("scripts/run_autodl_main_training.py"),
    Path("scripts/train_alphazero.py"),
    Path("configs/autodl_game_gpu_v2.json"),
    Path("configs/autodl_main_v3.json"),
    Path("state_aliasing/pairs_v1.json"),
    Path("pyproject.toml"),
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stage only the source and tiny fixtures required by AutoDL"
    )
    parser.add_argument("destination", type=Path)
    return parser


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_files(source: Path) -> tuple[Path, ...]:
    if source.is_file():
        return (source,)
    return tuple(
        path
        for path in sorted(source.rglob("*"))
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
    )


def main() -> int:
    args = _parser().parse_args()
    destination = args.destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit(f"refusing non-empty stage destination: {destination}")
    destination.mkdir(parents=True, exist_ok=True)

    copied: list[dict[str, object]] = []
    for relative in INCLUDE:
        source = RESEARCH_ROOT / relative
        if not source.exists():
            raise SystemExit(f"required source is missing: {source}")
        for file_source in _source_files(source):
            file_relative = file_source.relative_to(RESEARCH_ROOT)
            file_destination = destination / file_relative
            file_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file_source, file_destination)
            copied.append(
                {
                    "path": file_relative.as_posix(),
                    "bytes": file_destination.stat().st_size,
                    "sha256": _sha256(file_destination),
                }
            )

    manifest = {
        "schema_version": 1,
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        ),
        "source_root": str(RESEARCH_ROOT),
        "destination": str(destination),
        "file_count": len(copied),
        "total_bytes": sum(int(item["bytes"]) for item in copied),
        "files": copied,
    }
    manifest_path = destination / "STAGE_MANIFEST.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
