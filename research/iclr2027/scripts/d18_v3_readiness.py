#!/usr/bin/env python3
"""Run the D18-v3 hash/readiness gate without loading models or playing games."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_runner as runner  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=runner.DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--skip-checkpoint-file-hashes",
        action="store_true",
        help="use only for fast source self-tests; full readiness hashes all 45 bindings",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = runner.readiness_report(
            manifest_path=args.manifest,
            verify_checkpoints=not args.skip_checkpoint_file_hashes,
        )
        if report.get("formal_games_executed") != 0:
            raise runner.PreparationError("readiness did not remain at zero formal games")
        if report.get("model_forward_calls") != 0:
            raise runner.PreparationError("readiness attempted model inference")
        if any(
            int(report.get(field, -1)) != 0
            for field in ("gpu_actions", "external_actions", "paid_actions", "autodl_actions")
        ):
            raise runner.PreparationError("readiness attempted a prohibited external action")
        runner._write_optional_report(args.output, report)
    except (runner.PreparationError, runner.openings_v3.PreparationError) as exc:
        print(
            runner.canonical_json(
                {
                    "error": str(exc),
                    "formal_games_executed": 0,
                    "paid_actions": 0,
                    "status": "failed",
                }
            )
        )
        return 2
    print(runner.canonical_json(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
