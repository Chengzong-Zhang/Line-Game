"""Resumable masked Double-DQN self-play baseline for LIFELINE.

The game alternates the acting player.  Q values are therefore always from the
current actor's perspective and the bootstrap has a negative sign: after one
move, the next state's value belongs to the opponent.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import tempfile
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import torch
from torch import Tensor, nn

from ..core import PLAYER_STATES, LifelineGame, Player, PointState


MAX_GRID_SIZE = LifelineGame.MAX_GRID_SIZE
MAX_POINTS = MAX_GRID_SIZE * (MAX_GRID_SIZE + 1) // 2
ACTION_COUNT = MAX_POINTS + 1
FEATURES_PER_POINT = 7  # empty, own node/line, enemy node/line, normalised x/y
STATE_DIMENSION = MAX_POINTS * FEATURES_PER_POINT + 2  # board side and skip count


@dataclass(frozen=True)
class DQNConfig:
    seed: int = 20260921
    board_sizes: tuple[int, ...] = (5, 7, 9)
    episodes: int = 2_000
    max_plies: int = 256
    replay_capacity: int = 50_000
    batch_size: int = 128
    warmup_transitions: int = 1_000
    updates_per_episode: int = 4
    learning_rate: float = 3e-4
    gamma: float = 0.99
    epsilon_start: float = 1.0
    epsilon_end: float = 0.05
    epsilon_decay_episodes: int = 1_500
    target_sync_episodes: int = 100
    checkpoint_every_episodes: int = 100
    hidden_channels: int = 512

    def __post_init__(self) -> None:
        if not self.board_sizes or any(size not in range(5, 16) for size in self.board_sizes):
            raise ValueError("board_sizes must be unique values in [5, 15]")
        if len(set(self.board_sizes)) != len(self.board_sizes):
            raise ValueError("board_sizes must not contain duplicates")
        positive = {
            "episodes": self.episodes,
            "max_plies": self.max_plies,
            "replay_capacity": self.replay_capacity,
            "batch_size": self.batch_size,
            "warmup_transitions": self.warmup_transitions,
            "updates_per_episode": self.updates_per_episode,
            "epsilon_decay_episodes": self.epsilon_decay_episodes,
            "target_sync_episodes": self.target_sync_episodes,
            "checkpoint_every_episodes": self.checkpoint_every_episodes,
            "hidden_channels": self.hidden_channels,
        }
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in positive.values()):
            raise ValueError("DQN integer hyperparameters must be positive")
        if not math.isfinite(self.learning_rate) or self.learning_rate <= 0:
            raise ValueError("learning_rate must be finite and positive")
        if not 0 < self.gamma <= 1:
            raise ValueError("gamma must be in (0, 1]")
        if not 0 <= self.epsilon_end <= self.epsilon_start <= 1:
            raise ValueError("epsilon values must satisfy 0 <= end <= start <= 1")

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["board_sizes"] = list(self.board_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DQNConfig":
        normalized = dict(payload)
        normalized["board_sizes"] = tuple(int(size) for size in normalized["board_sizes"])
        return cls(**normalized)

    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


class MaskedQNetwork(nn.Module):
    def __init__(self, hidden_channels: int) -> None:
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(STATE_DIMENSION, hidden_channels), nn.ReLU(),
            nn.Linear(hidden_channels, hidden_channels), nn.ReLU(),
            nn.Linear(hidden_channels, ACTION_COUNT),
        )

    def forward(self, states: Tensor) -> Tensor:
        return self.layers(states)


def encode_game(game: LifelineGame) -> tuple[Tensor, Tensor]:
    """Return a fixed-width actor-relative state and its legal action mask."""

    state = torch.zeros(STATE_DIMENSION, dtype=torch.float32)
    mask = torch.zeros(ACTION_COUNT, dtype=torch.bool)
    own_node, own_line = (int(value) for value in PLAYER_STATES[game.current_player])
    enemy_node, enemy_line = (int(value) for value in PLAYER_STATES[game.opponent(game.current_player)])
    scale = max(1, game.grid_size - 1)
    for index, ((x, y), cell) in enumerate(zip(game.valid_positions, game.grid, strict=True)):
        offset = index * FEATURES_PER_POINT
        state[offset + ({int(PointState.EMPTY): 0, own_node: 1, own_line: 2, enemy_node: 3, enemy_line: 4}[int(cell)])] = 1.0
        state[offset + 5] = x / scale
        state[offset + 6] = y / scale
    state[-2] = game.grid_size / MAX_GRID_SIZE
    state[-1] = min(game.consecutive_skips, 2) / 2
    if not game.game_over:
        for point in game.legal_moves():
            mask[game.point_to_index[point]] = True
        mask[game.num_points] = True  # PASS occupies the native final action slot.
    return state, mask


class DQNTrainer:
    """A checkpointed Double-DQN trainer with deterministic local resume."""

    STATE_SCHEMA_VERSION = 1

    def __init__(self, config: DQNConfig, output_directory: str | Path, *, device: str = "cpu") -> None:
        self.config = config
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.device = torch.device(device)
        self.rng = random.Random(config.seed)
        torch.manual_seed(config.seed)
        if self.device.type == "cuda":
            torch.cuda.manual_seed_all(config.seed)
        self.online = MaskedQNetwork(config.hidden_channels).to(self.device)
        self.target = MaskedQNetwork(config.hidden_channels).to(self.device)
        self.target.load_state_dict(self.online.state_dict())
        self.target.eval()
        self.optimizer = torch.optim.AdamW(self.online.parameters(), lr=config.learning_rate)
        self.replay: deque[tuple[Tensor, Tensor, int, float, Tensor, Tensor, bool]] = deque(maxlen=config.replay_capacity)
        self.episode = 0
        self.environment_steps = 0

    @property
    def checkpoint_directory(self) -> Path:
        return self.output_directory / "checkpoints"

    def epsilon(self) -> float:
        progress = min(1.0, self.episode / self.config.epsilon_decay_episodes)
        return self.config.epsilon_start + progress * (self.config.epsilon_end - self.config.epsilon_start)

    @staticmethod
    def _masked_argmax(values: Tensor, masks: Tensor) -> Tensor:
        return values.masked_fill(~masks, torch.finfo(values.dtype).min).argmax(dim=1)

    def select_action(self, state: Tensor, mask: Tensor, *, explore: bool) -> int:
        legal = torch.nonzero(mask, as_tuple=False).flatten().tolist()
        if not legal:
            raise RuntimeError("attempted to act from a terminal LIFELINE state")
        if explore and self.rng.random() < self.epsilon():
            return self.rng.choice(legal)
        with torch.no_grad():
            values = self.online(state.unsqueeze(0).to(self.device))
            return int(self._masked_argmax(values, mask.unsqueeze(0).to(self.device))[0].cpu())

    @staticmethod
    def _apply_native_action(game: LifelineGame, action: int) -> None:
        if action == game.num_points:
            result = game.skip_turn()
        elif 0 <= action < game.num_points:
            result = game.play_move(game.valid_positions[action])
        else:
            raise RuntimeError(f"DQN selected action {action} outside the native action range")
        if not result.success:
            raise RuntimeError(f"DQN selected an illegal action {action}: {result.reason}")

    def collect_episode(self) -> dict[str, Any]:
        grid_size = self.rng.choice(self.config.board_sizes)
        game = LifelineGame(grid_size, start_player=self.rng.choice((Player.BLACK, Player.WHITE)), superko_mode="enforce")
        transitions = 0
        truncated = True
        for _ in range(self.config.max_plies):
            state, mask = encode_game(game)
            actor = game.current_player
            action = self.select_action(state, mask, explore=True)
            self._apply_native_action(game, action)
            next_state, next_mask = encode_game(game)
            done = game.game_over
            reward = game.rewards()[actor] if done else 0.0
            self.replay.append((state, mask, action, reward, next_state, next_mask, done))
            transitions += 1
            self.environment_steps += 1
            if done:
                truncated = False
                break
        return {"grid_size": grid_size, "transitions": transitions, "truncated": truncated, "epsilon": self.epsilon()}

    def update(self) -> float | None:
        if len(self.replay) < max(self.config.warmup_transitions, self.config.batch_size):
            return None
        samples = self.rng.sample(list(self.replay), self.config.batch_size)
        states = torch.stack([sample[0] for sample in samples]).to(self.device)
        actions = torch.tensor([sample[2] for sample in samples], dtype=torch.long, device=self.device)
        rewards = torch.tensor([sample[3] for sample in samples], dtype=torch.float32, device=self.device)
        next_states = torch.stack([sample[4] for sample in samples]).to(self.device)
        next_masks = torch.stack([sample[5] for sample in samples]).to(self.device)
        done = torch.tensor([sample[6] for sample in samples], dtype=torch.float32, device=self.device)
        predicted = self.online(states).gather(1, actions.unsqueeze(1)).squeeze(1)
        with torch.no_grad():
            next_online = self._masked_argmax(self.online(next_states), next_masks)
            next_values = self.target(next_states).gather(1, next_online.unsqueeze(1)).squeeze(1)
            target = rewards - self.config.gamma * (1.0 - done) * next_values
        loss = nn.functional.smooth_l1_loss(predicted, target)
        if not torch.isfinite(loss):
            raise FloatingPointError("non-finite DQN loss")
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(self.online.parameters(), 5.0)
        self.optimizer.step()
        return float(loss.detach().cpu())

    def run_episode(self) -> dict[str, Any]:
        episode_metrics = self.collect_episode()
        losses = [loss for _ in range(self.config.updates_per_episode) if (loss := self.update()) is not None]
        self.episode += 1
        if self.episode % self.config.target_sync_episodes == 0:
            self.target.load_state_dict(self.online.state_dict())
        metrics = {
            "schema_version": 1,
            "episode": self.episode,
            "environment_steps": self.environment_steps,
            "replay_size": len(self.replay),
            "mean_loss": None if not losses else sum(losses) / len(losses),
            **episode_metrics,
        }
        self._append_metrics(metrics)
        return metrics

    def _append_metrics(self, payload: dict[str, Any]) -> None:
        path = self.output_directory / "metrics.jsonl"
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def save(self) -> Path:
        self.checkpoint_directory.mkdir(parents=True, exist_ok=True)
        path = self.checkpoint_directory / f"episode_{self.episode:06d}.pt"
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            torch.save({
                "schema_version": self.STATE_SCHEMA_VERSION,
                "config": self.config.to_dict(),
                "config_hash": self.config.fingerprint(),
                "episode": self.episode,
                "environment_steps": self.environment_steps,
                "online": self.online.state_dict(),
                "target": self.target.state_dict(),
                "optimizer": self.optimizer.state_dict(),
                "replay": list(self.replay),
                "python_rng": self.rng.getstate(),
                "torch_rng": torch.get_rng_state(),
                "cuda_rng": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
            }, temporary)
            with temporary.open("r+b") as handle:
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            latest = {"schema_version": 1, "checkpoint": path.name, "sha256": digest, "episode": self.episode}
            latest_path = self.checkpoint_directory / "latest.json"
            latest_descriptor, latest_temporary_name = tempfile.mkstemp(prefix=".latest.", suffix=".tmp", dir=path.parent)
            os.close(latest_descriptor)
            latest_temporary = Path(latest_temporary_name)
            with latest_temporary.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(latest, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(latest_temporary, latest_path)
            return path
        finally:
            temporary.unlink(missing_ok=True)

    def resume(self, checkpoint: str | Path) -> None:
        candidate = Path(checkpoint)
        if candidate.is_dir():
            manifest = json.loads((candidate / "latest.json").read_text(encoding="utf-8"))
            candidate = candidate / manifest["checkpoint"]
            if hashlib.sha256(candidate.read_bytes()).hexdigest() != manifest["sha256"]:
                raise RuntimeError("DQN checkpoint hash mismatch")
        payload = torch.load(candidate, map_location=self.device, weights_only=False)
        if payload.get("schema_version") != self.STATE_SCHEMA_VERSION or payload.get("config_hash") != self.config.fingerprint():
            raise RuntimeError("DQN checkpoint schema or config mismatch")
        self.online.load_state_dict(payload["online"])
        self.target.load_state_dict(payload["target"])
        self.optimizer.load_state_dict(payload["optimizer"])
        restored_replay = payload["replay"]
        if not isinstance(restored_replay, list):
            raise RuntimeError("DQN checkpoint has an invalid replay buffer")
        self.replay = deque(
            [
                (
                    state.detach().cpu(),
                    mask.detach().cpu(),
                    int(action),
                    float(reward),
                    next_state.detach().cpu(),
                    next_mask.detach().cpu(),
                    bool(done),
                )
                for state, mask, action, reward, next_state, next_mask, done in restored_replay
            ],
            maxlen=self.config.replay_capacity,
        )
        self.episode = int(payload["episode"])
        self.environment_steps = int(payload["environment_steps"])
        self.rng.setstate(payload["python_rng"])
        torch_rng = payload["torch_rng"]
        if not isinstance(torch_rng, Tensor):
            raise RuntimeError("DQN checkpoint has an invalid CPU Torch RNG state")
        torch.set_rng_state(torch_rng.detach().cpu())
        if self.device.type == "cuda" and payload.get("cuda_rng") is not None:
            cuda_rng = payload["cuda_rng"]
            if not isinstance(cuda_rng, list) or not all(isinstance(state, Tensor) for state in cuda_rng):
                raise RuntimeError("DQN checkpoint has an invalid CUDA RNG state")
            torch.cuda.set_rng_state_all([state.detach().cpu() for state in cuda_rng])

    def run(self, *, additional_episodes: int | None = None) -> Iterable[dict[str, Any]]:
        target = self.config.episodes if additional_episodes is None else self.episode + additional_episodes
        while self.episode < target:
            metrics = self.run_episode()
            if self.episode % self.config.checkpoint_every_episodes == 0:
                self.save()
            yield metrics
        if self.episode:
            self.save()
