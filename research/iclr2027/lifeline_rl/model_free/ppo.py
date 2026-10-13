"""Small, resumable masked PPO baseline for alternating-player LIFELINE."""

from __future__ import annotations

import hashlib
import json
import os
import random
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch
from torch import Tensor, nn

from ..core import LifelineGame, Player
from .dqn import ACTION_COUNT, STATE_DIMENSION, encode_game


@dataclass(frozen=True)
class PPOConfig:
    seed: int = 20260921
    board_sizes: tuple[int, ...] = tuple(range(5, 16))
    episodes: int = 2000
    max_plies: int = 256
    hidden_channels: int = 512
    learning_rate: float = 3e-4
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_ratio: float = 0.2
    update_epochs: int = 4

    def __post_init__(self) -> None:
        if not self.board_sizes or any(n not in range(5, 16) for n in self.board_sizes):
            raise ValueError("board_sizes must be in [5, 15]")
        if any(v < 1 for v in (self.episodes, self.max_plies, self.hidden_channels, self.update_epochs)):
            raise ValueError("PPO integer options must be positive")

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["board_sizes"] = list(self.board_sizes)
        return result

    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class ActorCritic(nn.Module):
    def __init__(self, hidden_channels: int) -> None:
        super().__init__()
        self.body = nn.Sequential(nn.Linear(STATE_DIMENSION, hidden_channels), nn.Tanh(), nn.Linear(hidden_channels, hidden_channels), nn.Tanh())
        self.policy = nn.Linear(hidden_channels, ACTION_COUNT)
        self.value = nn.Linear(hidden_channels, 1)

    def forward(self, states: Tensor) -> tuple[Tensor, Tensor]:
        h = self.body(states)
        return self.policy(h), self.value(h).squeeze(-1)


class PPOTrainer:
    STATE_SCHEMA_VERSION = 1

    def __init__(self, config: PPOConfig, output_directory: str | Path, *, device: str = "cpu") -> None:
        self.config = config
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.checkpoint_directory = self.output_directory / "checkpoints"
        self.device = torch.device(device)
        self.rng = random.Random(config.seed)
        torch.manual_seed(config.seed)
        if self.device.type == "cuda":
            torch.cuda.manual_seed_all(config.seed)
        self.model = ActorCritic(config.hidden_channels).to(self.device)
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=config.learning_rate)
        self.episode = 0
        self.environment_steps = 0

    def _action(self, state: Tensor, mask: Tensor, *, explore: bool = True) -> tuple[int, Tensor, Tensor]:
        with torch.set_grad_enabled(explore):
            logits, value = self.model(state.unsqueeze(0).to(self.device))
            logits = logits.masked_fill(~mask.unsqueeze(0).to(self.device), torch.finfo(logits.dtype).min)
            distribution = torch.distributions.Categorical(logits=logits)
            action = distribution.sample() if explore else distribution.probs.argmax(dim=1)
            return int(action.item()), distribution.log_prob(action).squeeze(0), value.squeeze(0)

    @staticmethod
    def _apply(game: LifelineGame, action: int) -> None:
        result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
        if not result.success:
            raise RuntimeError(f"PPO selected illegal action {action}: {result.reason}")

    def run_episode(self) -> dict[str, Any]:
        size = self.rng.choice(self.config.board_sizes)
        game = LifelineGame(size, start_player=self.rng.choice((Player.BLACK, Player.WHITE)), superko_mode="enforce")
        states: list[Tensor] = []; masks: list[Tensor] = []; actions: list[int] = []
        old_logp: list[Tensor] = []; values: list[Tensor] = []; rewards: list[float] = []
        done = False
        for _ in range(self.config.max_plies):
            state, mask = encode_game(game)
            action, logp, value = self._action(state, mask)
            actor = game.current_player
            self._apply(game, action)
            reward = float(game.rewards()[actor]) if game.game_over else 0.0
            states.append(state); masks.append(mask); actions.append(action); old_logp.append(logp.detach()); values.append(value.detach()); rewards.append(reward)
            self.environment_steps += 1
            if game.game_over:
                done = True
                break
        state_batch = torch.stack(states).to(self.device)
        mask_batch = torch.stack(masks).to(self.device)
        action_batch = torch.tensor(actions, dtype=torch.long, device=self.device)
        old_logp_batch = torch.stack(old_logp).to(self.device)
        value_batch = torch.stack(values).to(self.device)
        returns = torch.zeros(len(rewards), dtype=torch.float32, device=self.device)
        advantages = torch.zeros_like(returns)
        next_value = torch.tensor(0.0, device=self.device)
        next_advantage = torch.tensor(0.0, device=self.device)
        for index in range(len(rewards) - 1, -1, -1):
            delta = rewards[index] - self.config.gamma * next_value - value_batch[index]
            advantages[index] = delta - self.config.gamma * self.config.gae_lambda * next_advantage
            returns[index] = advantages[index] + value_batch[index]
            next_value, next_advantage = value_batch[index], advantages[index]
        advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)
        losses: list[float] = []
        for _ in range(self.config.update_epochs):
            logits, values_now = self.model(state_batch)
            logits = logits.masked_fill(~mask_batch, torch.finfo(logits.dtype).min)
            dist = torch.distributions.Categorical(logits=logits)
            logp = dist.log_prob(action_batch)
            ratio = (logp - old_logp_batch).exp()
            policy_loss = -torch.minimum(ratio * advantages, ratio.clamp(1 - self.config.clip_ratio, 1 + self.config.clip_ratio) * advantages).mean()
            value_loss = 0.5 * (values_now - returns).square().mean()
            entropy = dist.entropy().mean()
            loss = policy_loss + value_loss * 0.5 - entropy * 0.01
            if not torch.isfinite(loss):
                raise FloatingPointError("non-finite PPO loss")
            self.optimizer.zero_grad(set_to_none=True); loss.backward(); nn.utils.clip_grad_norm_(self.model.parameters(), 1.0); self.optimizer.step()
            losses.append(float(loss.detach().cpu()))
        self.episode += 1
        metrics = {"schema_version": 1, "episode": self.episode, "environment_steps": self.environment_steps, "grid_size": size, "transitions": len(rewards), "truncated": not done, "mean_loss": sum(losses) / len(losses)}
        with (self.output_directory / "metrics.jsonl").open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(metrics, sort_keys=True) + "\n"); handle.flush(); os.fsync(handle.fileno())
        return metrics

    def save(self) -> Path:
        self.checkpoint_directory.mkdir(parents=True, exist_ok=True)
        path = self.checkpoint_directory / f"episode_{self.episode:06d}.pt"
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=self.checkpoint_directory); os.close(fd)
        temporary = Path(tmp_name)
        try:
            torch.save({"schema_version": self.STATE_SCHEMA_VERSION, "config": self.config.to_dict(), "config_hash": self.config.fingerprint(), "episode": self.episode, "environment_steps": self.environment_steps, "model": self.model.state_dict(), "optimizer": self.optimizer.state_dict(), "python_rng": self.rng.getstate(), "torch_rng": torch.get_rng_state(), "cuda_rng": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None}, temporary)
            os.replace(temporary, path)
            latest = {"schema_version": 1, "checkpoint": path.name, "episode": self.episode, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            latest_path = self.checkpoint_directory / "latest.json"
            latest_path.write_text(json.dumps(latest, sort_keys=True) + "\n", encoding="utf-8")
            return path
        finally:
            temporary.unlink(missing_ok=True)

    def run(self) -> None:
        while self.episode < self.config.episodes:
            self.run_episode()
            if self.episode % 100 == 0 or self.episode == self.config.episodes:
                self.save()
