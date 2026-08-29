#!/usr/bin/env python3
"""Independently replay and validate a D9--D10 AlphaZero run directory."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.config import AlphaZeroConfig


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON at {path}:{line_number}") from exc
            if not isinstance(record, dict):
                raise ValueError(f"JSONL record is not an object at {path}:{line_number}")
            records.append(record)
    return records


def _mask(game: LifelineGame) -> list[int]:
    legal = set(game.legal_moves())
    return [int(point in legal) for point in game.valid_positions] + [1]


def _replay_game(record: dict[str, Any]) -> int:
    game = LifelineGame(
        int(record["grid_size"]),
        start_player=record["start_player"],
        superko_mode=record["superko_mode"],
    )
    actions = record["actions"]
    for expected_ply, entry in enumerate(actions):
        if entry["ply"] != expected_ply:
            raise ValueError("self-play action ply sequence is not contiguous")
        if entry["actor"] != game.current_player.value:
            raise ValueError("self-play actor does not match replayed state")
        if entry["state_fingerprint"] != game.state_fingerprint():
            raise ValueError("self-play state fingerprint mismatch")
        legal_mask = _mask(game)
        if entry["legal_action_mask"] != legal_mask:
            raise ValueError("self-play legal-action mask mismatch")
        action = int(entry["action"])
        if not 0 <= action <= game.num_points or not legal_mask[action]:
            raise ValueError("self-play action is illegal")
        visits = entry["root_visits"]
        if len(visits) != game.num_points + 1 or sum(visits) != entry["simulations"]:
            raise ValueError("self-play root visits do not match simulation count")
        if any(value for value, legal_action in zip(visits, legal_mask) if not legal_action):
            raise ValueError("masked self-play action has non-zero visits")
        expected_point = None if action == game.num_points else list(game.valid_positions[action])
        if entry["point"] != expected_point:
            raise ValueError("self-play point/action mapping mismatch")
        result = (
            game.skip_turn()
            if action == game.num_points
            else game.play_move(game.valid_positions[action])
        )
        if not result.success:
            raise ValueError(f"self-play replay failed: {result.reason}")

    if record["final_state_fingerprint"] != game.state_fingerprint():
        raise ValueError("final self-play state fingerprint mismatch")
    if bool(record["terminated"]) != game.game_over:
        raise ValueError("self-play terminal flag mismatch")
    if bool(record["truncated"]) == game.game_over:
        raise ValueError("self-play truncation flag mismatch")
    if game.game_over:
        winner = game.winner()
        expected_winner = winner.value if isinstance(winner, Player) else winner
        expected_rewards = {
            player.value: game.rewards()[player] for player in (Player.BLACK, Player.WHITE)
        }
        if record["winner"] != expected_winner or record["rewards"] != expected_rewards:
            raise ValueError("self-play terminal outcome mismatch")
        if int(record["sample_count"]) != len(actions):
            raise ValueError("terminal game sample count must equal its root count")
    elif int(record["sample_count"]) != 0:
        raise ValueError("truncated game must not contribute replay samples")
    return len(actions)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--allow-source-mismatch", action="store_true")
    args = parser.parse_args()

    run_directory = args.run_directory.resolve()
    config = AlphaZeroConfig.load(run_directory / "resolved_config.json")
    games = _read_jsonl(run_directory / "self_play_games.jsonl")
    metrics = _read_jsonl(run_directory / "metrics.jsonl")
    game_ids = [int(record["game_index"]) for record in games]
    iterations = [int(record["iteration"]) for record in metrics]
    if len(game_ids) != len(set(game_ids)):
        raise ValueError("duplicate self-play game_index in JSONL")
    if len(iterations) != len(set(iterations)) or iterations != sorted(iterations):
        raise ValueError("duplicate or non-monotonic metric iterations")
    replayed_steps = sum(_replay_game(record) for record in games)

    try:
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
    except ImportError as exc:
        raise SystemExit("checkpoint verification requires the PyTorch training extra") from exc
    trainer = AlphaZeroTrainer(config, run_directory, device=args.device)
    trainer.resume(
        run_directory / "checkpoints",
        strict_source=not args.allow_source_mismatch,
    )
    counters = trainer.counters.to_dict()
    if not metrics or metrics[-1]["counters"] != counters:
        raise ValueError("last metrics counters do not match the latest checkpoint")
    if counters["environment_steps"] != replayed_steps:
        raise ValueError("checkpoint environment-step counter does not match action logs")
    if counters["games_attempted"] != len(games):
        raise ValueError("checkpoint game counter does not match action logs")
    if trainer.replay_buffer.total_added != sum(
        int(record["sample_count"]) for record in games
    ):
        raise ValueError("checkpoint replay total_added does not match terminal logs")

    summary = {
        "status": "verified",
        "run_directory": str(run_directory),
        "games_replayed": len(games),
        "environment_steps_replayed": replayed_steps,
        "metrics_records": len(metrics),
        "checkpoint_iteration": counters["iteration"],
        "gradient_steps": counters["gradient_steps"],
        "model_kind": config.model_kind,
        "observation_mode": config.observation_mode,
        "parameter_count": trainer.model.parameter_count,
        "buffer_size": len(trainer.replay_buffer),
        "buffer_total_added": trainer.replay_buffer.total_added,
        "source_hash": trainer.current_source_hash(),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
