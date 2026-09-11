#!/usr/bin/env python3
"""Place D20's large raw artifacts on AutoDL work storage before execution."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence


SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
SOURCE_REPO = RESEARCH_ROOT.parents[1]


class EntryError(RuntimeError):
    pass


def _ignore(directory: str, names: list[str]) -> set[str]:
    excluded = {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
        "local_artifacts",
        "node_modules",
    }
    return {name for name in names if name in excluded or name.startswith(".codex-") or name.startswith(".tmp-")}


def run(*, calibration_workers: int, run_label: str, export_summary: Path) -> int:
    work_raw = os.environ.get("AUTODL_WORK_DIR")
    if not work_raw:
        raise EntryError("AUTODL_WORK_DIR is required")
    work_root = Path(work_raw).resolve()
    copied_repo = work_root / "d20_submission_code"
    if copied_repo.exists() or copied_repo.is_symlink():
        raise EntryError("refusing to overwrite the AutoDL D20 worktree")
    if calibration_workers < 1:
        raise EntryError("calibration_workers must be positive")
    shutil.copytree(SOURCE_REPO, copied_repo, ignore=_ignore)
    command = [
        sys.executable,
        "-B",
        str(copied_repo / "research" / "iclr2027" / "scripts" / "run_d20_submission_experiments.py"),
        "--calibration-root",
        f"local_artifacts/d20_strong_opponent_calibration/{run_label}",
        "--d20-root",
        f"local_artifacts/d20_matched_ablation/{run_label}",
        "--export-summary",
        str(export_summary),
        "--calibration-workers",
        str(calibration_workers),
    ]
    completed = subprocess.run(command, cwd=copied_repo, check=False)
    return completed.returncode


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--calibration-workers", type=int, default=8)
    result.add_argument("--run-label", required=True)
    result.add_argument("--export-summary", type=Path, required=True)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return run(
            calibration_workers=args.calibration_workers,
            run_label=args.run_label,
            export_summary=args.export_summary,
        )
    except Exception as exc:
        print(f"FAIL_CLOSED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
