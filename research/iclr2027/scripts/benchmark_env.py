"""Measure dependency-free environment throughput on random legal play."""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineEnv  # noqa: E402


def benchmark(size: int, transitions: int, seed: int) -> tuple[float, int]:
    rng = random.Random(seed)
    env = LifelineEnv(size, observation_mode="physical")
    completed = 0
    episodes = 0
    start = time.perf_counter()
    while completed < transitions:
        env.reset(seed=seed + episodes)
        episodes += 1
        while not env.game.game_over and completed < transitions:
            mask = env.legal_action_mask()
            legal = [action for action, allowed in enumerate(mask[:-1]) if allowed]
            action = rng.choice(legal) if legal else env.pass_action
            env.step(action)
            completed += 1
            if completed % 97 == 0 and not env.game.game_over:
                env.step(env.pass_action)
                completed += 1
    elapsed = time.perf_counter() - start
    return completed / elapsed, episodes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", type=int, nargs="+", default=[5, 7, 9, 10, 12, 15])
    parser.add_argument("--transitions", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260825)
    args = parser.parse_args()

    print("grid_size,transitions_per_second,episodes")
    for size in args.sizes:
        rate, episodes = benchmark(size, args.transitions, args.seed + size)
        print(f"{size},{rate:.2f},{episodes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
