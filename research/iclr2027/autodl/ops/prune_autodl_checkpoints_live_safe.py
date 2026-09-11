#!/usr/bin/env python3
"""Prune finalized AutoDL checkpoints without touching in-flight temp files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SeedPlan:
    seed_root: Path
    retained: tuple[Path, ...]
    deleted: tuple[Path, ...]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_latest(seed_root: Path, verify_sha256: bool) -> Path:
    checkpoint_root = seed_root / "checkpoints"
    latest_path = checkpoint_root / "latest.json"
    if not latest_path.is_file():
        raise FileNotFoundError(f"missing latest.json: {latest_path}")
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    referenced = checkpoint_root / str(latest["checkpoint"])
    if not referenced.is_file():
        raise FileNotFoundError(f"missing referenced checkpoint: {referenced}")
    if referenced.stat().st_size != int(latest["size_bytes"]):
        raise ValueError(f"size mismatch for {referenced}")
    if verify_sha256 and _sha256(referenced) != str(latest["sha256"]):
        raise ValueError(f"sha256 mismatch for {referenced}")
    return referenced


def _plan_seed(seed_root: Path, keep: int, verify_sha256: bool) -> SeedPlan:
    checkpoint_root = seed_root / "checkpoints"
    referenced = _read_latest(seed_root, verify_sha256)
    # The pattern deliberately excludes atomic-save files such as
    # .checkpoint_000225.pt.<random>.tmp. They belong to the active writer.
    checkpoints = sorted(
        checkpoint_root.glob("checkpoint_*.pt"),
        key=lambda path: int(path.stem.rsplit("_", 1)[-1]),
    )
    retained = {referenced}
    fallbacks = [path for path in checkpoints if path != referenced]
    retained.update(fallbacks[-max(0, keep - 1) :])
    deleted = tuple(path for path in checkpoints if path not in retained)
    return SeedPlan(seed_root, tuple(sorted(retained)), deleted)


def _plan(roots: list[Path], keep: int, verify_sha256: bool) -> list[SeedPlan]:
    seed_roots = sorted(
        seed_root
        for root in roots
        for seed_root in root.glob("seed_*")
        if seed_root.is_dir()
    )
    return [_plan_seed(seed_root, keep, verify_sha256) for seed_root in seed_roots]


def _apply(plans: list[SeedPlan], verify_sha256: bool) -> tuple[int, int]:
    deleted_files = 0
    deleted_bytes = 0
    for plan in plans:
        current_latest = _read_latest(plan.seed_root, verify_sha256)
        for path in plan.deleted:
            if path == current_latest:
                raise RuntimeError(f"refusing to delete current latest: {path}")
            size = path.stat().st_size
            path.unlink()
            deleted_files += 1
            deleted_bytes += size
    return deleted_files, deleted_bytes


def _report(
    plans: list[SeedPlan],
    *,
    status: str,
    deleted_files: int,
    deleted_bytes: int,
    keep: int,
    verify_sha256: bool,
) -> dict[str, object]:
    return {
        "status": status,
        "seed_count": len(plans),
        "retained_files": sum(len(plan.retained) for plan in plans),
        "planned_deleted_files": sum(len(plan.deleted) for plan in plans),
        "deleted_files": deleted_files,
        "deleted_bytes": deleted_bytes,
        "keep_per_seed": keep,
        "verified_sha256": verify_sha256,
        "timestamp": time.time(),
    }


def _stop_parent(pid_file: Path) -> None:
    pid = int(pid_file.read_text(encoding="utf-8").strip())
    os.kill(pid, signal.SIGTERM)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--keep", type=int, default=2)
    parser.add_argument("--verify-sha256", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--daemon-interval-seconds", type=int)
    parser.add_argument("--stop-pid-file", type=Path)
    parser.add_argument("--max-disk-use-percent", type=float, default=60.0)
    args = parser.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be at least 1")
    if args.daemon_interval_seconds is not None and args.daemon_interval_seconds < 30:
        raise SystemExit("--daemon-interval-seconds must be at least 30")
    while True:
        try:
            plans = _plan(args.roots, args.keep, args.verify_sha256)
            planned = sum(len(plan.deleted) for plan in plans)
            deleted_files = 0
            deleted_bytes = 0
            if args.apply and planned:
                deleted_files, deleted_bytes = _apply(plans, args.verify_sha256)
            disk = shutil.disk_usage(args.roots[0])
            disk_use = 100.0 * disk.used / disk.total
            report = _report(
                plans,
                status="applied" if args.apply else "dry_run",
                deleted_files=deleted_files,
                deleted_bytes=deleted_bytes,
                keep=args.keep,
                verify_sha256=args.verify_sha256,
            )
            report["disk_use_percent"] = disk_use
            print(json.dumps(report, sort_keys=True), flush=True)
            if disk_use > args.max_disk_use_percent:
                raise RuntimeError(
                    f"disk use {disk_use:.2f}% exceeds {args.max_disk_use_percent:.2f}%"
                )
        except BaseException as exc:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                        "timestamp": time.time(),
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            if args.stop_pid_file is not None:
                _stop_parent(args.stop_pid_file)
            return 1
        if args.daemon_interval_seconds is None:
            return 0
        time.sleep(args.daemon_interval_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
