"""Resumable discrete SAC baseline for the alternating-player game."""

from __future__ import annotations

import hashlib
import json
import os
import random
import tempfile
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch
from torch import Tensor, nn

from ..core import LifelineGame, Player
from .dqn import ACTION_COUNT, STATE_DIMENSION, encode_game


@dataclass(frozen=True)
class SACConfig:
    seed: int = 20260921
    board_sizes: tuple[int, ...] = tuple(range(5, 16))
    episodes: int = 2000
    max_plies: int = 256
    replay_capacity: int = 50000
    batch_size: int = 128
    warmup_transitions: int = 1000
    updates_per_episode: int = 4
    hidden_channels: int = 512
    learning_rate: float = 3e-4
    gamma: float = 0.99
    alpha: float = 0.05
    target_tau: float = 0.01

    def __post_init__(self) -> None:
        if not self.board_sizes or any(n not in range(5, 16) for n in self.board_sizes):
            raise ValueError("board_sizes must be in [5, 15]")
        if any(v < 1 for v in (self.episodes, self.max_plies, self.replay_capacity, self.batch_size, self.warmup_transitions, self.updates_per_episode, self.hidden_channels)):
            raise ValueError("SAC integer options must be positive")

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self); result["board_sizes"] = list(self.board_sizes); return result

    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class QNetwork(nn.Module):
    def __init__(self, hidden_channels: int) -> None:
        super().__init__()
        self.body = nn.Sequential(nn.Linear(STATE_DIMENSION, hidden_channels), nn.ReLU(), nn.Linear(hidden_channels, hidden_channels), nn.ReLU())
        self.head = nn.Linear(hidden_channels, ACTION_COUNT)

    def forward(self, states: Tensor) -> Tensor:
        return self.head(self.body(states))


class PolicyNetwork(nn.Module):
    def __init__(self, hidden_channels: int) -> None:
        super().__init__()
        self.body = nn.Sequential(nn.Linear(STATE_DIMENSION, hidden_channels), nn.ReLU(), nn.Linear(hidden_channels, hidden_channels), nn.ReLU())
        self.head = nn.Linear(hidden_channels, ACTION_COUNT)

    def forward(self, states: Tensor) -> Tensor:
        return self.head(self.body(states))


class SACTrainer:
    STATE_SCHEMA_VERSION = 1

    def __init__(self, config: SACConfig, output_directory: str | Path, *, device: str = "cpu") -> None:
        self.config = config; self.output_directory = Path(output_directory); self.output_directory.mkdir(parents=True, exist_ok=True)
        self.checkpoint_directory = self.output_directory / "checkpoints"; self.device = torch.device(device)
        self.rng = random.Random(config.seed); torch.manual_seed(config.seed)
        if self.device.type == "cuda": torch.cuda.manual_seed_all(config.seed)
        self.policy = PolicyNetwork(config.hidden_channels).to(self.device)
        self.q1 = QNetwork(config.hidden_channels).to(self.device); self.q2 = QNetwork(config.hidden_channels).to(self.device)
        self.tq1 = QNetwork(config.hidden_channels).to(self.device); self.tq2 = QNetwork(config.hidden_channels).to(self.device)
        self.tq1.load_state_dict(self.q1.state_dict()); self.tq2.load_state_dict(self.q2.state_dict())
        self.policy_optimizer = torch.optim.Adam(self.policy.parameters(), lr=config.learning_rate)
        self.q_optimizer = torch.optim.Adam(list(self.q1.parameters()) + list(self.q2.parameters()), lr=config.learning_rate)
        self.replay: deque[tuple[Tensor, Tensor, int, float, Tensor, Tensor, bool]] = deque(maxlen=config.replay_capacity)
        self.episode = 0; self.environment_steps = 0

    @staticmethod
    def _apply(game: LifelineGame, action: int) -> None:
        result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
        if not result.success: raise RuntimeError(f"SAC selected illegal action {action}: {result.reason}")

    def select_action(self, state: Tensor, mask: Tensor) -> int:
        with torch.no_grad():
            logits = self.policy(state.unsqueeze(0).to(self.device)).masked_fill(~mask.unsqueeze(0).to(self.device), torch.finfo(torch.float32).min)
            return int(torch.distributions.Categorical(logits=logits).sample().item())

    def update(self) -> tuple[float, float] | None:
        if len(self.replay) < max(self.config.batch_size, self.config.warmup_transitions): return None
        batch = self.rng.sample(list(self.replay), self.config.batch_size)
        states = torch.stack([x[0] for x in batch]).to(self.device); masks = torch.stack([x[1] for x in batch]).to(self.device)
        actions = torch.tensor([x[2] for x in batch], dtype=torch.long, device=self.device); rewards = torch.tensor([x[3] for x in batch], dtype=torch.float32, device=self.device)
        next_states = torch.stack([x[4] for x in batch]).to(self.device); next_masks = torch.stack([x[5] for x in batch]).to(self.device); done = torch.tensor([x[6] for x in batch], dtype=torch.float32, device=self.device)
        with torch.no_grad():
            next_logits = self.policy(next_states).masked_fill(~next_masks, torch.finfo(torch.float32).min)
            next_probs = torch.softmax(next_logits, dim=1); next_logp = torch.log(next_probs.clamp_min(1e-8))
            next_value = (next_probs * (torch.minimum(self.tq1(next_states), self.tq2(next_states)) - self.config.alpha * next_logp)).sum(dim=1)
            target = rewards - self.config.gamma * (1.0 - done) * next_value
        q1_pred = self.q1(states).gather(1, actions[:, None]).squeeze(1); q2_pred = self.q2(states).gather(1, actions[:, None]).squeeze(1)
        q_loss = 0.5 * ((q1_pred - target).square().mean() + (q2_pred - target).square().mean())
        if not torch.isfinite(q_loss): raise FloatingPointError("non-finite SAC Q loss")
        self.q_optimizer.zero_grad(set_to_none=True); q_loss.backward(); nn.utils.clip_grad_norm_(list(self.q1.parameters()) + list(self.q2.parameters()), 5.0); self.q_optimizer.step()
        logits = self.policy(states).masked_fill(~masks, torch.finfo(torch.float32).min); probs = torch.softmax(logits, dim=1); logp = torch.log(probs.clamp_min(1e-8))
        policy_loss = (probs * (self.config.alpha * logp - torch.minimum(self.q1(states).detach(), self.q2(states).detach())).masked_fill(~masks, 0.0)).sum(dim=1).mean()
        self.policy_optimizer.zero_grad(set_to_none=True); policy_loss.backward(); self.policy_optimizer.step()
        with torch.no_grad():
            for target_net, online_net in ((self.tq1, self.q1), (self.tq2, self.q2)):
                for target_param, online_param in zip(target_net.parameters(), online_net.parameters()): target_param.mul_(1 - self.config.target_tau).add_(online_param, alpha=self.config.target_tau)
        return float(q_loss.detach().cpu()), float(policy_loss.detach().cpu())

    def run_episode(self) -> dict[str, Any]:
        size = self.rng.choice(self.config.board_sizes); game = LifelineGame(size, start_player=self.rng.choice((Player.BLACK, Player.WHITE)), superko_mode="enforce")
        transitions = 0; truncated = True
        for _ in range(self.config.max_plies):
            state, mask = encode_game(game); actor = game.current_player; action = self.select_action(state, mask); self._apply(game, action); next_state, next_mask = encode_game(game)
            done = game.game_over; reward = float(game.rewards()[actor]) if done else 0.0
            self.replay.append((state, mask, action, reward, next_state, next_mask, done)); self.environment_steps += 1; transitions += 1
            if done: truncated = False; break
        losses = [x for _ in range(self.config.updates_per_episode) if (x := self.update()) is not None]; self.episode += 1
        metrics = {"schema_version": 1, "episode": self.episode, "environment_steps": self.environment_steps, "replay_size": len(self.replay), "grid_size": size, "transitions": transitions, "truncated": truncated, "q_loss": None if not losses else sum(x[0] for x in losses) / len(losses), "policy_loss": None if not losses else sum(x[1] for x in losses) / len(losses)}
        with (self.output_directory / "metrics.jsonl").open("a", encoding="utf-8", newline="\n") as handle: handle.write(json.dumps(metrics, sort_keys=True) + "\n"); handle.flush(); os.fsync(handle.fileno())
        return metrics

    def save(self) -> Path:
        self.checkpoint_directory.mkdir(parents=True, exist_ok=True); path = self.checkpoint_directory / f"episode_{self.episode:06d}.pt"; fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=self.checkpoint_directory); os.close(fd); temporary = Path(tmp_name)
        try:
            torch.save({"schema_version": self.STATE_SCHEMA_VERSION, "config": self.config.to_dict(), "config_hash": self.config.fingerprint(), "episode": self.episode, "environment_steps": self.environment_steps, "policy": self.policy.state_dict(), "q1": self.q1.state_dict(), "q2": self.q2.state_dict(), "tq1": self.tq1.state_dict(), "tq2": self.tq2.state_dict(), "policy_optimizer": self.policy_optimizer.state_dict(), "q_optimizer": self.q_optimizer.state_dict(), "replay": list(self.replay), "python_rng": self.rng.getstate(), "torch_rng": torch.get_rng_state()}, temporary); os.replace(temporary, path); latest = {"schema_version": 1, "checkpoint": path.name, "episode": self.episode, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}; (self.checkpoint_directory / "latest.json").write_text(json.dumps(latest, sort_keys=True) + "\n", encoding="utf-8"); return path
        finally: temporary.unlink(missing_ok=True)
