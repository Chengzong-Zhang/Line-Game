#!/usr/bin/env python3
"""Train compact GAIL-style and conditional-GAN policies from greedy experts.

These are engineering baselines for the browser showcase.  The generated
checkpoints retain the generator policy and the training metadata; they are
not used as evidence for the AlphaZero research claims.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lifeline_rl.agents.greedy import GreedyAgent
from lifeline_rl.agents.base import apply_action
from lifeline_rl.core import LifelineGame, Player
from lifeline_rl.model_free.dqn import ACTION_COUNT, STATE_DIMENSION, encode_game
from lifeline_rl.model_free.ppo import ActorCritic


def collect_expert(config: argparse.Namespace) -> tuple[torch.Tensor, torch.Tensor]:
    rng = random.Random(config.seed)
    expert = GreedyAgent()
    states: list[torch.Tensor] = []
    actions: list[int] = []
    while len(states) < config.samples:
        size = rng.choice(tuple(range(5, 16)))
        game = LifelineGame(size, start_player=rng.choice((Player.BLACK, Player.WHITE)), superko_mode="enforce")
        for _ in range(config.max_plies):
            state, mask = encode_game(game)
            selected = expert.select_action(game, rng)
            action = game.num_points if selected is None else game.point_to_index[selected]
            if not bool(mask[action]):
                raise RuntimeError(f"expert selected illegal action {action}")
            states.append(state); actions.append(action)
            apply_action(game, selected, source="Greedy expert")
            if game.game_over or len(states) >= config.samples:
                break
    return torch.stack(states), torch.tensor(actions, dtype=torch.long)


class Discriminator(nn.Module):
    def __init__(self, hidden: int) -> None:
        super().__init__()
        self.net = nn.Sequential(nn.Linear(STATE_DIMENSION + ACTION_COUNT, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 1))

    def forward(self, states: torch.Tensor, actions: torch.Tensor) -> torch.Tensor:
        one_hot = torch.zeros((states.shape[0], ACTION_COUNT), device=states.device)
        return self.net(torch.cat((states, one_hot.scatter_(1, actions[:, None], 1.0)), dim=1)).squeeze(1)


def train(kind: str, config: argparse.Namespace, states: torch.Tensor, expert_actions: torch.Tensor, output: Path) -> None:
    torch.manual_seed(config.seed + (0 if kind == "gail" else 1))
    generator = ActorCritic(config.hidden).to(config.device)
    discriminator = Discriminator(config.hidden // 2).to(config.device)
    generator_optimizer = torch.optim.Adam(generator.parameters(), lr=config.learning_rate)
    discriminator_optimizer = torch.optim.Adam(discriminator.parameters(), lr=config.learning_rate)
    states = states.to(config.device); expert_actions = expert_actions.to(config.device)
    bce = nn.BCEWithLogitsLoss()
    for epoch in range(config.epochs):
        permutation = torch.randperm(states.shape[0], device=config.device)
        for start in range(0, states.shape[0], config.batch_size):
            index = permutation[start:start + config.batch_size]
            batch_states = states[index]; batch_expert = expert_actions[index]
            with torch.no_grad():
                sampled = torch.distributions.Categorical(logits=generator(batch_states)[0]).sample()
            expert_logits = discriminator(batch_states, batch_expert)
            policy_logits = discriminator(batch_states, sampled)
            d_loss = bce(expert_logits, torch.ones_like(expert_logits)) + bce(policy_logits, torch.zeros_like(policy_logits))
            discriminator_optimizer.zero_grad(set_to_none=True); d_loss.backward(); discriminator_optimizer.step()
            logits, _ = generator(batch_states)
            probs = torch.softmax(logits, dim=1)
            action_grid = torch.arange(ACTION_COUNT, device=config.device).expand(batch_states.shape[0], -1).reshape(-1)
            repeated_states = batch_states[:, None, :].expand(-1, ACTION_COUNT, -1).reshape(-1, STATE_DIMENSION)
            rewards = torch.sigmoid(-discriminator(repeated_states, action_grid)).reshape(batch_states.shape[0], ACTION_COUNT)
            g_loss = -(probs * torch.log(rewards.clamp_min(1e-6))).sum(dim=1).mean()
            generator_optimizer.zero_grad(set_to_none=True); g_loss.backward(); nn.utils.clip_grad_norm_(generator.parameters(), 1.0); generator_optimizer.step()
    output.mkdir(parents=True, exist_ok=True)
    torch.save({"schema_version": 1, "algorithm": kind, "seed": config.seed, "trained_board_sizes": list(range(5, 16)), "samples": int(states.shape[0]), "epochs": config.epochs, "generator": generator.state_dict(), "discriminator": discriminator.state_dict()}, output / "generator.pt")
    (output / "training_summary.json").write_text(json.dumps({"status": "complete", "algorithm": kind, "trained_board_sizes": list(range(5, 16)), "samples": int(states.shape[0]), "epochs": config.epochs}, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=12000)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--hidden", type=int, default=512)
    parser.add_argument("--max-plies", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=20260921)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if args.samples < 1 or args.epochs < 1: parser.error("samples and epochs must be positive")
    states, actions = collect_expert(args)
    for kind in ("gail", "gan"):
        train(kind, args, states, actions, args.output_root / f"{kind}_all_sizes_seed20260921_v1")


if __name__ == "__main__":
    main()
