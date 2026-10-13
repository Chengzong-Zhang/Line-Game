#!/usr/bin/env python3
"""Run the resumable masked PPO baseline across LIFELINE side lengths."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import torch

from lifeline_rl.model_free.ppo import PPOConfig, PPOTrainer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--episodes", type=int, default=2000)
    parser.add_argument("--board-sizes", default=",".join(str(n) for n in range(5, 16)))
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    try:
        sizes = tuple(sorted({int(x.strip()) for x in args.board_sizes.split(",") if x.strip()}))
    except ValueError as exc:
        parser.error(f"invalid --board-sizes: {exc}")
    if not sizes or any(n not in range(5, 16) for n in sizes):
        parser.error("--board-sizes must contain side lengths in [5, 15]")
    config = PPOConfig(
        board_sizes=(5,) if args.smoke else sizes,
        episodes=8 if args.smoke else args.episodes,
        max_plies=48 if args.smoke else 256,
        hidden_channels=64 if args.smoke else 512,
        update_epochs=1 if args.smoke else 4,
    )
    trainer = PPOTrainer(config, args.output_dir, device=args.device)
    for _ in range(config.episodes):
        metrics = trainer.run_episode()
        if trainer.episode % 100 == 0 or trainer.episode == config.episodes:
            trainer.save()
        print(json.dumps(metrics, sort_keys=True), flush=True)
    print(json.dumps({"status": "complete", "episode": trainer.episode, "checkpoint": str(trainer.checkpoint_directory / "latest.json")}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
