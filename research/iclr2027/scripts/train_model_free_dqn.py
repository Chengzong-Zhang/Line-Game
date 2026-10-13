#!/usr/bin/env python3
"""Run or resume the isolated masked Double-DQN LIFELINE baseline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import torch

from lifeline_rl.model_free import DQNConfig, DQNTrainer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--episodes", type=int, default=2_000)
    parser.add_argument("--resume", type=Path)
    parser.add_argument(
        "--additional-episodes",
        type=int,
        help="run this many more episodes after a verified resume checkpoint",
    )
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument(
        "--board-sizes",
        default="5,7,9,11,13,15",
        help="comma-separated side lengths in [5, 15]",
    )
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if args.additional_episodes is not None and args.resume is None:
        parser.error("--additional-episodes requires --resume")
    if args.additional_episodes is not None and args.additional_episodes < 1:
        parser.error("--additional-episodes must be positive")
    try:
        board_sizes = tuple(sorted({int(value.strip()) for value in args.board_sizes.split(",") if value.strip()}))
    except ValueError as exc:
        parser.error(f"--board-sizes must be comma-separated integers: {exc}")
    if not board_sizes or any(size not in range(5, 16) for size in board_sizes):
        parser.error("--board-sizes must contain at least one side length in [5, 15]")
    config = DQNConfig(
        episodes=8 if args.smoke else args.episodes,
        board_sizes=(5,) if args.smoke else board_sizes,
        max_plies=48 if args.smoke else 256,
        replay_capacity=256 if args.smoke else 50_000,
        batch_size=8 if args.smoke else 128,
        warmup_transitions=16 if args.smoke else 1_000,
        updates_per_episode=1 if args.smoke else 4,
        target_sync_episodes=4 if args.smoke else 100,
        checkpoint_every_episodes=4 if args.smoke else 100,
        hidden_channels=64 if args.smoke else 512,
    )
    trainer = DQNTrainer(config, args.output_dir, device=args.device)
    if args.resume:
        trainer.resume(args.resume)
    for metrics in trainer.run(additional_episodes=args.additional_episodes):
        print(json.dumps(metrics, sort_keys=True), flush=True)
    print(json.dumps({"status": "complete", "episode": trainer.episode, "checkpoint": str(trainer.checkpoint_directory / "latest.json")}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
