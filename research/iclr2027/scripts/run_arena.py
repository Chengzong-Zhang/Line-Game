"""Run one color-balanced matchup between any frozen baseline agents."""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import AGENT_KINDS, make_agent, run_matchup, write_matchup  # noqa: E402


def git_metadata() -> dict[str, object]:
    repository = ROOT.parents[1]
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repository, text=True,
        encoding="utf-8", errors="replace", capture_output=True, check=False,
    )
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=repository, text=True,
        encoding="utf-8", errors="replace", capture_output=True, check=False,
    )
    return {
        "commit": revision.stdout.strip() if revision.returncode == 0 else None,
        "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
    }


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")


def unique_output_directory(output_root: Path, stem: str) -> Path:
    """Return a timestamped, currently-unused result directory."""

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    base = output_root / f"{timestamp}_{_slug(stem)}"
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = Path(f"{base}_{suffix}")
        suffix += 1
    return candidate


def _artifact_paths(output: Path) -> dict[str, str]:
    return {
        key: str((output / filename).resolve())
        for key, filename in {
            "summary": "summary.json", "games": "games.jsonl", "csv": "games.csv"
        }.items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a replayable, strictly color-balanced LIFELINE arena matchup."
    )
    parser.add_argument("--agent-a", choices=AGENT_KINDS, default="mcts")
    parser.add_argument("--agent-b", choices=AGENT_KINDS, default="random")
    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--superko-mode", choices=("enforce", "observe"), default="enforce")
    parser.add_argument("--games", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--max-plies", type=int, default=120)
    parser.add_argument("--minimax-move-cap", type=int, default=20)
    parser.add_argument("--mcts-simulations", type=int, default=64)
    parser.add_argument("--mcts-rollout-depth", type=int, default=80)
    parser.add_argument("--mcts-exploration", type=float, default=2**0.5)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--output-root", type=Path, default=ROOT / "results" / "arena",
        help="parent used for an automatic unique output directory",
    )
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    if args.no_write and args.output_dir is not None:
        parser.error("--no-write and --output-dir are mutually exclusive")
    if args.no_write and args.overwrite:
        parser.error("--no-write and --overwrite are mutually exclusive")

    factory_options = {
        "minimax_move_cap": args.minimax_move_cap,
        "mcts_simulations": args.mcts_simulations,
        "mcts_rollout_depth": args.mcts_rollout_depth,
        "mcts_exploration": args.mcts_exploration,
    }
    agent_a = make_agent(args.agent_a, **factory_options)
    agent_b = make_agent(args.agent_b, **factory_options)
    result = run_matchup(
        agent_a, agent_b, games=args.games, grid_size=args.grid_size,
        base_seed=args.seed, max_plies=args.max_plies,
        superko_mode=args.superko_mode,
    )
    result.summary["agent_kinds"] = {"A": args.agent_a, "B": args.agent_b}
    result.summary["runtime"] = {"python": sys.version, "platform": platform.platform()}
    result.summary["git"] = git_metadata()

    if not args.no_write:
        stem = (
            f"{args.agent_a}_vs_{args.agent_b}_n{args.grid_size}_g{args.games}_"
            f"seed{args.seed}_superko-{args.superko_mode}"
        )
        output = args.output_dir or unique_output_directory(args.output_root, stem)
        result.summary["run_id"] = output.name
        result.summary["artifacts"] = _artifact_paths(output)
        write_matchup(result, output, overwrite=args.overwrite)
    print(json.dumps(result.summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
