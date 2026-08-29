#!/usr/bin/env python3
"""Safely prune superseded AutoDL checkpoints while preserving recovery points."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SeedPlan:
    seed_root: Path
    retained: tuple[Path, ...]
    deleted: tuple[Path, ...]
    temporaries: tuple[Path, ...]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _plan_seed(seed_root: Path, keep: int, verify_sha256: bool) -> SeedPlan:
    checkpoint_root = seed_root / "checkpoints"
    latest_path = checkpoint_root / "latest.json"
    if not latest_path.is_file():
        raise FileNotFoundError(f"missing latest.json: {latest_path}")
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    referenced = checkpoint_root / str(latest["checkpoint"])
    if not referenced.is_file():
        raise FileNotFoundError(f"missing referenced checkpoint: {referenced}")
    expected_size = int(latest["size_bytes"])
    if referenced.stat().st_size != expected_size:
        raise ValueError(f"size mismatch for {referenced}")
    if verify_sha256 and _sha256(referenced) != str(latest["sha256"]):
        raise ValueError(f"sha256 mismatch for {referenced}")
    checkpoints = sorted(
        checkpoint_root.glob("checkpoint_*.pt"),
        key=lambda path: int(path.stem.rsplit("_", 1)[-1]),
    )
    retained = {referenced}
    fallbacks = [path for path in checkpoints if path != referenced]
    retained.update(fallbacks[-max(0, keep - 1) :])
    deleted = tuple(path for path in checkpoints if path not in retained)
    temporaries = tuple(checkpoint_root.glob(".*.tmp"))
    return SeedPlan(
        seed_root=seed_root,
        retained=tuple(sorted(retained)),
        deleted=deleted,
        temporaries=temporaries,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--keep", type=int, default=2)
    parser.add_argument("--verify-sha256", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--archive-root", type=Path)
    args = parser.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be at least 1")
    if args.apply and args.archive_root is not None:
        raise SystemExit("use either --apply or --archive-root, not both")
    seed_roots = sorted(
        seed_root
        for root in args.roots
        for seed_root in root.glob("seed_*")
        if seed_root.is_dir()
    )
    plans = [
        _plan_seed(seed_root, args.keep, args.verify_sha256)
        for seed_root in seed_roots
    ]
    deleted_files = sum(len(plan.deleted) + len(plan.temporaries) for plan in plans)
    deleted_bytes = sum(
        path.stat().st_size
        for plan in plans
        for path in (*plan.deleted, *plan.temporaries)
    )
    retained_files = sum(len(plan.retained) for plan in plans)
    if args.archive_root is not None:
        archive_root = args.archive_root.resolve()
        archive_root.mkdir(parents=True, exist_ok=True)
        required_bytes = deleted_bytes + 1024 * 1024 * 1024
        if shutil.disk_usage(archive_root).free < required_bytes:
            raise OSError(f"archive root lacks {required_bytes} free bytes")
        for plan in plans:
            for path in (*plan.deleted, *plan.temporaries):
                destination = (
                    archive_root
                    / plan.seed_root.parent.name
                    / plan.seed_root.name
                    / "checkpoints"
                    / path.name
                )
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), destination)
    elif args.apply:
        for plan in plans:
            for path in (*plan.deleted, *plan.temporaries):
                path.unlink()
    print(
        json.dumps(
            {
                "status": (
                    "archived"
                    if args.archive_root is not None
                    else "applied" if args.apply else "dry_run"
                ),
                "archive_root": (
                    str(args.archive_root.resolve())
                    if args.archive_root is not None
                    else None
                ),
                "seed_count": len(plans),
                "retained_files": retained_files,
                "deleted_files": deleted_files,
                "deleted_bytes": deleted_bytes,
                "keep_per_seed": args.keep,
                "verified_sha256": bool(args.verify_sha256),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
