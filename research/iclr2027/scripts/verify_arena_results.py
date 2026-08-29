"""Replay every JSONL game and cross-check the arena summary counts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import replay_game_record  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("result_directory", type=Path)
    args = parser.parse_args()

    summary_path = args.result_directory / "summary.json"
    games_path = args.result_directory / "games.jsonl"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    records = [
        json.loads(line)
        for line in games_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if len(records) != int(summary["games_requested"]):
        raise ValueError("games.jsonl count does not match summary.json")

    a_wins = a_losses = draws = truncated = 0
    for record in records:
        replay_game_record(record)
        if record["truncated"]:
            truncated += 1
        elif record["winner"] == "DRAW":
            draws += 1
        else:
            a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
            if record["winner"] == a_color:
                a_wins += 1
            else:
                a_losses += 1

    observed = {
        "a_wins": a_wins,
        "a_losses": a_losses,
        "draws": draws,
        "truncated_games": truncated,
    }
    expected = {key: int(summary[key]) for key in observed}
    if observed != expected:
        raise ValueError(f"summary mismatch: observed={observed}, expected={expected}")
    print(f"PASS: replayed {len(records)} games and matched summary counts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
