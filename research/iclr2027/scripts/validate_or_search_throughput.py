"""Repeat the end-to-end environment benchmark on an identical workload."""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from benchmark_env import benchmark  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", type=int, nargs="+", default=[5, 7, 9, 10, 12, 15])
    parser.add_argument("--transitions", type=int, default=300)
    parser.add_argument("--warmup-transitions", type=int, default=30)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.transitions <= 0 or args.warmup_transitions < 0 or args.repeats <= 0:
        parser.error("transitions and repeats must be positive; warmup must be non-negative")

    configurations: list[dict[str, object]] = []
    for size in args.sizes:
        workload_seed = args.seed + size
        if args.warmup_transitions:
            benchmark(size, args.warmup_transitions, workload_seed)
        rates: list[float] = []
        episode_counts: list[int] = []
        for _ in range(args.repeats):
            rate, episodes = benchmark(size, args.transitions, workload_seed)
            rates.append(rate)
            episode_counts.append(episodes)
        if len(set(episode_counts)) != 1:
            raise AssertionError("identical seeds produced different episode counts")
        configurations.append(
            {
                "grid_size": size,
                "workload_seed": workload_seed,
                "requested_transitions_per_repeat": args.transitions,
                "episodes_per_repeat": episode_counts[0],
                "rates_transitions_per_second": [round(rate, 4) for rate in rates],
                "median_transitions_per_second": round(statistics.median(rates), 4),
                "mean_transitions_per_second": round(statistics.fmean(rates), 4),
                "population_stdev": round(statistics.pstdev(rates), 4),
                "minimum_transitions_per_second": round(min(rates), 4),
                "maximum_transitions_per_second": round(max(rates), 4),
            }
        )

    report = {
        "schema_version": 1,
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "python": sys.version,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "benchmark_contract": {
            "environment": "LifelineEnv",
            "observation_mode": "physical (alias of grid)",
            "action_selection": "seeded uniform random legal point action",
            "pass_injection": "every 97th counted transition when non-terminal",
            "timed_scope": "reset, legal mask, step, observation, and terminal scoring",
            "warmup_transitions_per_size": args.warmup_transitions,
            "repeats": args.repeats,
        },
        "configurations": configurations,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
