"""Run and replay-check the complete small non-learning baseline matrix."""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import (  # noqa: E402
    AGENT_KINDS, make_agent, replay_game_record, run_matchup, write_matchup,
)


def _git_metadata() -> dict[str, object]:
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


def _unique_run_directory(output_root: Path, stem: str) -> Path:
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
        description=(
            "Run every unordered baseline pairing, including the diagonal; "
            "each matchup is already color-balanced."
        )
    )
    parser.add_argument("--agents", nargs="+", choices=AGENT_KINDS, default=list(AGENT_KINDS))
    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--superko-mode", choices=("enforce", "observe"), default="enforce")
    parser.add_argument("--games", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--max-plies", type=int, default=80)
    parser.add_argument("--minimax-move-cap", type=int, default=20)
    parser.add_argument("--mcts-simulations", type=int, default=4)
    parser.add_argument("--mcts-rollout-depth", type=int, default=8)
    parser.add_argument("--mcts-exploration", type=float, default=2**0.5)
    parser.add_argument(
        "--output-root", type=Path,
        default=ROOT / "results" / "smoke" / "baseline_matrix",
    )
    parser.add_argument("--run-id")
    args = parser.parse_args()

    if len(set(args.agents)) != len(args.agents):
        parser.error("--agents must not contain duplicates")
    if args.games < 2 or args.games % 2:
        parser.error("--games must be an even number of at least 2")

    factory_options = {
        "minimax_move_cap": args.minimax_move_cap,
        "mcts_simulations": args.mcts_simulations,
        "mcts_rollout_depth": args.mcts_rollout_depth,
        "mcts_exploration": args.mcts_exploration,
    }
    # Validate every requested configuration before creating a run directory.
    for kind in args.agents:
        make_agent(kind, **factory_options)

    stem = args.run_id or (
        f"all_baselines_n{args.grid_size}_g{args.games}_seed{args.seed}_"
        f"superko-{args.superko_mode}"
    )
    run_directory = (
        args.output_root / _slug(args.run_id)
        if args.run_id is not None
        else _unique_run_directory(args.output_root, stem)
    )
    if run_directory.exists():
        raise FileExistsError(f"refusing to reuse matrix output directory: {run_directory}")
    run_directory.mkdir(parents=True)

    pairings = list(itertools.combinations_with_replacement(args.agents, 2))
    rows: list[dict[str, object]] = []
    matchup_summaries: list[dict[str, object]] = []
    for pair_index, (kind_a, kind_b) in enumerate(pairings):
        print(f"[{pair_index + 1}/{len(pairings)}] {kind_a} vs {kind_b}", flush=True)
        agent_a = make_agent(kind_a, **factory_options)
        agent_b = make_agent(kind_b, **factory_options)
        pair_seed = args.seed + pair_index * 100_000
        result = run_matchup(
            agent_a, agent_b, games=args.games, grid_size=args.grid_size,
            base_seed=pair_seed, max_plies=args.max_plies,
            superko_mode=args.superko_mode,
        )
        matchup_directory = run_directory / f"{pair_index:02d}_{kind_a}_vs_{kind_b}"
        result.summary["matrix_pair_index"] = pair_index
        result.summary["agent_kinds"] = {"A": kind_a, "B": kind_b}
        result.summary["artifacts"] = _artifact_paths(matchup_directory)
        write_matchup(result, matchup_directory)
        for record in result.games:
            replay_game_record(record)

        row = {
            "pair_index": pair_index,
            "agent_a_kind": kind_a,
            "agent_b_kind": kind_b,
            "agent_a": result.summary["agent_a"],
            "agent_b": result.summary["agent_b"],
            "games_requested": result.summary["games_requested"],
            "games_completed": result.summary["games_completed"],
            "truncated_games": result.summary["truncated_games"],
            "a_wins": result.summary["a_wins"],
            "a_losses": result.summary["a_losses"],
            "draws": result.summary["draws"],
            "a_score_rate": result.summary["a_score_rate"],
            "average_plies": result.summary["average_plies"],
            "total_duration_seconds": result.summary["total_duration_seconds"],
            "result_directory": str(matchup_directory.resolve()),
        }
        rows.append(row)
        matchup_summaries.append(result.summary)

    manifest = {
        "schema_version": 1,
        "run_id": run_directory.name,
        "purpose": "engineering smoke; not paper-strength evidence",
        "agents": args.agents,
        "pairing_rule": "unordered combinations with replacement; each matchup color-balanced",
        "pairings": len(pairings),
        "grid_size": args.grid_size,
        "superko_mode": args.superko_mode,
        "games_per_matchup": args.games,
        "base_seed": args.seed,
        "max_plies": args.max_plies,
        "minimax_move_cap": args.minimax_move_cap,
        "mcts": {
            "simulations": args.mcts_simulations,
            "rollout_depth": args.mcts_rollout_depth,
            "exploration": args.mcts_exploration,
        },
        "replay_verified_games": len(pairings) * args.games,
        "runtime": {"python": sys.version, "platform": platform.platform()},
        "git": _git_metadata(),
        "matchups": matchup_summaries,
    }
    manifest_path = run_directory / "matrix_summary.json"
    csv_path = run_directory / "matrix.csv"
    manifest["artifacts"] = {
        "summary": str(manifest_path.resolve()), "csv": str(csv_path.resolve())
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=tuple(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    print(json.dumps({
        "run_id": manifest["run_id"], "pairings": len(pairings),
        "replay_verified_games": manifest["replay_verified_games"],
        "artifacts": manifest["artifacts"],
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
