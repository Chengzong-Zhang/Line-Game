#!/usr/bin/env python3
"""Recompute and persist the D13 Topology-GNN learning-health gate."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lifeline_rl.alphazero.learning_health import (  # noqa: E402
    LearningHealthConfig,
    evaluate_learning_health,
    write_learning_health_report,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--tier", choices=("smoke", "pilot", "formal"), default="formal"
    )
    parser.add_argument(
        "--allow-source-mismatch",
        action="store_true",
        help="intentional migration only; makes the report non-strict",
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    gate = (
        LearningHealthConfig()
        if args.tier == "formal"
        else LearningHealthConfig.exploratory(args.tier)
    )
    report = evaluate_learning_health(
        args.checkpoint,
        gate,
        strict_source=not args.allow_source_mismatch,
    )
    if args.output is not None:
        write_learning_health_report(report, args.output, overwrite=args.overwrite)
    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
