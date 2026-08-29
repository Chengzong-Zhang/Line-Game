"""Single-process deterministic AlphaZero training loop for D9--D10."""

from __future__ import annotations

import json
import math
import os
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import fmean
from typing import Any, Mapping

try:
    import torch
    from torch import nn
except ImportError as exc:  # pragma: no cover - core-only environment
    raise ImportError(
        "AlphaZero training requires PyTorch; install the 'train' optional extra"
    ) from exc

from .config import AlphaZeroConfig
from .checkpoint import compute_source_hash, load_checkpoint, save_checkpoint
from .network import (
    NetworkConfig,
    TorchPolicyValueEvaluator,
    build_policy_value_network,
    collate_positions,
    observation_mode_for_model,
)
from .puct import PUCTConfig, PUCTSearch
from .replay import ReplayBuffer
from .self_play import SelfPlayConfig, play_self_play_game


@dataclass
class TrainingCounters:
    iteration: int = 0
    games_attempted: int = 0
    games_completed: int = 0
    games_truncated: int = 0
    environment_steps: int = 0
    gradient_steps: int = 0
    examples_seen: int = 0
    next_game_id: int = 0

    def to_dict(self) -> dict[str, int]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TrainingCounters":
        expected = set(cls.__dataclass_fields__)
        if set(data) != expected:
            raise ValueError("trainer counter keys do not match the current schema")
        values = {key: int(data[key]) for key in expected}
        if any(value < 0 for value in values.values()):
            raise ValueError("trainer counters must be non-negative")
        return cls(**values)


def seed_everything(seed: int) -> None:
    """Seed every RNG used by the single-process baseline."""

    random.seed(seed)
    try:
        import numpy as np
    except ImportError:  # pragma: no cover - torch installations normally include NumPy
        np = None
    if np is not None:
        np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


class AlphaZeroTrainer:
    """Own model, optimizer, replay, RNG, counters, and safe-point artifacts."""

    STATE_SCHEMA_VERSION = 1

    def __init__(
        self,
        config: AlphaZeroConfig,
        output_directory: str | Path,
        *,
        device: str | torch.device = "cpu",
        initialize_seed: bool = True,
    ):
        self.config = config
        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.device = torch.device(device)
        if initialize_seed:
            seed_everything(config.seed)
        self.self_play_rng = random.Random(config.seed ^ 0xA17E_2027)
        expected_observation = observation_mode_for_model(config.model_kind)
        if config.observation_mode != expected_observation:
            raise ValueError(
                f"model_kind {config.model_kind!r} requires observation_mode "
                f"{expected_observation!r}"
            )
        self.model = build_policy_value_network(
            config.model_kind,
            NetworkConfig(
                hidden_channels=config.hidden_channels,
                message_passing_layers=config.message_passing_layers,
            ),
        ).to(self.device)
        self.optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=config.learning_rate,
            weight_decay=config.weight_decay,
        )
        self.scheduler = None
        self.scaler = None
        self.replay_buffer = ReplayBuffer(
            capacity=config.replay_capacity,
            seed=config.seed ^ 0xB0FF_E123,
        )
        evaluator = TorchPolicyValueEvaluator(
            self.model,
            config.observation_mode,
            self.device,
        )
        self.searcher = PUCTSearch(
            evaluator,
            PUCTConfig(
                simulations=config.puct_simulations,
                c_puct=config.c_puct,
                dirichlet_alpha=config.dirichlet_alpha,
                dirichlet_epsilon=config.dirichlet_epsilon,
            ),
        )
        self.counters = TrainingCounters()

    @property
    def games_log_path(self) -> Path:
        return self.output_directory / "self_play_games.jsonl"

    @property
    def metrics_path(self) -> Path:
        return self.output_directory / "metrics.jsonl"

    @staticmethod
    def _append_jsonl(
        path: Path,
        payload: Mapping[str, Any],
        *,
        unique_key: str,
    ) -> None:
        """Append once, making a deterministic replay after a crash idempotent."""

        path.parent.mkdir(parents=True, exist_ok=True)
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        if path.is_file():
            with path.open("r", encoding="utf-8") as existing:
                for line_number, line in enumerate(existing, start=1):
                    if not line.strip():
                        continue
                    try:
                        prior = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise RuntimeError(
                            f"corrupt JSONL at {path}:{line_number}"
                        ) from exc
                    if prior.get(unique_key) == payload.get(unique_key):
                        if json.dumps(prior, sort_keys=True, ensure_ascii=False) != canonical:
                            raise RuntimeError(
                                f"non-deterministic duplicate {unique_key}="
                                f"{payload.get(unique_key)!r} in {path}"
                            )
                        return
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(canonical + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def state_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.STATE_SCHEMA_VERSION,
            "counters": self.counters.to_dict(),
            "self_play_rng_state": self.self_play_rng.getstate(),
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        if state.get("schema_version") != self.STATE_SCHEMA_VERSION:
            raise ValueError("unsupported trainer-state schema")
        self.counters = TrainingCounters.from_dict(state["counters"])
        self.self_play_rng.setstate(state["self_play_rng_state"])

    def resume_config(self) -> dict[str, Any]:
        """Return the scientific config, excluding allowed operational overrides."""

        return json.loads(self.config.canonical_json(resume_critical=True))

    @staticmethod
    def source_files() -> tuple[Path, ...]:
        research_root = Path(__file__).resolve().parents[2]
        files = list((research_root / "lifeline_rl").rglob("*.py"))
        files.append(research_root / "pyproject.toml")
        cli = research_root / "scripts" / "train_alphazero.py"
        if cli.is_file():
            files.append(cli)
        return tuple(sorted(set(files)))

    @classmethod
    def current_source_hash(cls) -> str:
        research_root = Path(__file__).resolve().parents[2]
        return compute_source_hash(cls.source_files(), root=research_root)

    def save(self, path: str | Path | None = None) -> dict[str, Any]:
        checkpoint_path = (
            Path(path)
            if path is not None
            else self.output_directory
            / "checkpoints"
            / f"checkpoint_{self.counters.iteration:06d}.pt"
        )
        return save_checkpoint(
            checkpoint_path,
            model=self.model,
            optimizer=self.optimizer,
            scheduler=self.scheduler,
            scaler=self.scaler,
            buffer=self.replay_buffer,
            trainer_state=self.state_dict(),
            counters=self.counters.to_dict(),
            local_rngs={"self_play": self.self_play_rng},
            config=self.resume_config(),
            source_hash=self.current_source_hash(),
            metadata={
                "safe_point": "between_complete_games_after_optimizer_step",
                "model_kind": self.config.model_kind,
                "observation_mode": self.config.observation_mode,
                "network_config": {
                    "hidden_channels": self.config.hidden_channels,
                    "message_passing_layers": self.config.message_passing_layers,
                },
                "parameter_count": self.model.parameter_count,
                "torch_version": torch.__version__,
            },
        )

    def resume(
        self,
        path: str | Path,
        *,
        strict_source: bool = True,
    ) -> dict[str, Any]:
        payload = load_checkpoint(
            path,
            model=self.model,
            optimizer=self.optimizer,
            scheduler=self.scheduler,
            scaler=self.scaler,
            buffer=self.replay_buffer,
            local_rngs={"self_play": self.self_play_rng},
            expected_config=self.resume_config(),
            expected_source_hash=self.current_source_hash(),
            strict_source=strict_source,
            map_location=self.device,
        )
        self.load_state_dict(payload["trainer_state"])
        if payload["counters"] != self.counters.to_dict():
            raise RuntimeError("checkpoint trainer counters disagree with the outer counters")
        return payload

    def train_batch(self) -> dict[str, float]:
        experiences = self.replay_buffer.sample(self.config.batch_size)
        batch = collate_positions(
            experiences,
            self.config.observation_mode,
            device=self.device,
        )
        if batch.policy_targets is None or batch.value_targets is None:
            raise RuntimeError("training batch is missing targets")
        self.model.train()
        logits, values = self.model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )
        log_probabilities = torch.log_softmax(logits, dim=1)
        policy_loss = -(batch.policy_targets * log_probabilities).sum(dim=1).mean()
        value_loss = torch.mean((values - batch.value_targets) ** 2)
        total_loss = policy_loss + value_loss
        if not bool(torch.isfinite(total_loss)):
            raise FloatingPointError("non-finite AlphaZero loss")

        self.optimizer.zero_grad(set_to_none=True)
        total_loss.backward()
        for parameter in self.model.parameters():
            if parameter.grad is not None and not bool(torch.isfinite(parameter.grad).all()):
                raise FloatingPointError("non-finite AlphaZero gradient")
        gradient_norm = nn.utils.clip_grad_norm_(
            self.model.parameters(), self.config.gradient_clip_norm
        )
        if not math.isfinite(float(gradient_norm)):
            raise FloatingPointError("non-finite AlphaZero gradient norm")
        self.optimizer.step()
        self.counters.gradient_steps += 1
        self.counters.examples_seen += len(experiences)
        return {
            "loss": float(total_loss.detach().cpu()),
            "policy_loss": float(policy_loss.detach().cpu()),
            "value_loss": float(value_loss.detach().cpu()),
            "gradient_norm": float(gradient_norm),
        }

    def _self_play_config(self, grid_size: int) -> SelfPlayConfig:
        return SelfPlayConfig(
            grid_size=grid_size,
            max_plies=self.config.max_plies,
            temperature_moves=self.config.temperature_moves,
            initial_temperature=self.config.initial_temperature,
            final_temperature=self.config.final_temperature,
            observation_mode=self.config.observation_mode,
            superko_mode=self.config.superko_mode,
        )

    @staticmethod
    def _result_payload(result: Any) -> dict[str, Any]:
        if hasattr(result, "to_dict"):
            payload = result.to_dict()
            if isinstance(payload, dict):
                payload.setdefault("terminated", not bool(payload.get("truncated", False)))
                return payload
        actions = list(getattr(result, "actions", getattr(result, "action_log", ())))
        return {
            "schema_version": 1,
            "game_index": getattr(result, "game_index", None),
            "seed": getattr(result, "seed", None),
            "grid_size": getattr(result, "grid_size", None),
            "actions": actions,
            "terminated": bool(getattr(result, "terminated", False)),
            "truncated": bool(getattr(result, "truncated", False)),
            "winner": getattr(result, "winner", None),
            "final_state_fingerprint": getattr(result, "final_state_fingerprint", None),
        }

    def run_iteration(self) -> dict[str, Any]:
        """Run complete games, then optimizer updates, ending at a safe checkpoint point."""

        iteration_index = self.counters.iteration
        completed_this_iteration = 0
        truncated_this_iteration = 0
        total_added_before = self.replay_buffer.total_added

        for _ in range(self.config.games_per_iteration):
            game_index = self.counters.next_game_id
            game_seed = self.self_play_rng.getrandbits(63)
            grid_size = self.self_play_rng.choice(self.config.board_sizes)
            result = play_self_play_game(
                self.searcher,
                self._self_play_config(grid_size),
                game_seed,
                game_index=game_index,
                replay_buffer=self.replay_buffer,
            )
            payload = self._result_payload(result)
            payload["iteration"] = iteration_index
            self._append_jsonl(
                self.games_log_path,
                payload,
                unique_key="game_index",
            )
            actions = payload.get("actions", ())
            self.counters.environment_steps += len(actions)
            self.counters.games_attempted += 1
            self.counters.next_game_id += 1
            if payload.get("terminated"):
                self.counters.games_completed += 1
                completed_this_iteration += 1
            else:
                self.counters.games_truncated += 1
                truncated_this_iteration += 1

        updates: list[dict[str, float]] = []
        if len(self.replay_buffer) >= self.config.batch_size:
            for _ in range(self.config.training_steps_per_iteration):
                updates.append(self.train_batch())
        if self.scheduler is not None:
            self.scheduler.step()
        self.counters.iteration += 1

        metrics: dict[str, Any] = {
            "schema_version": 1,
            "iteration": self.counters.iteration,
            "games_completed": completed_this_iteration,
            "games_truncated": truncated_this_iteration,
            "experiences_added": self.replay_buffer.total_added - total_added_before,
            "buffer_size": len(self.replay_buffer),
            "gradient_steps_this_iteration": len(updates),
            "model_kind": self.config.model_kind,
            "observation_mode": self.config.observation_mode,
            "parameter_count": self.model.parameter_count,
            "counters": self.counters.to_dict(),
        }
        for key in ("loss", "policy_loss", "value_loss", "gradient_norm"):
            metrics[key] = fmean(update[key] for update in updates) if updates else None
        self._append_jsonl(self.metrics_path, metrics, unique_key="iteration")
        return metrics
