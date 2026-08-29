"""Versioned, JSON-serializable configuration for AlphaZero training."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Mapping


MODEL_KIND_TO_OBSERVATION = {
    "padded_cnn": "grid_graph",
    "grid_gnn": "grid_graph",
    "topology_gnn": "topology",
}


@dataclass(frozen=True)
class AlphaZeroConfig:
    schema_version: int = 1
    seed: int = 20260825
    observation_mode: str = "grid_graph"
    # ``None`` is a backwards-compatible migration path for the frozen D9--D10
    # configs: GridGraph maps to grid_gnn and Topology maps to topology_gnn.
    model_kind: str | None = None
    board_sizes: tuple[int, ...] = (5, 7, 9)
    iterations: int = 1
    games_per_iteration: int = 1
    puct_simulations: int = 64
    c_puct: float = 1.5
    dirichlet_alpha: float = 0.3
    dirichlet_epsilon: float = 0.25
    max_plies: int = 256
    temperature_moves: int = 20
    initial_temperature: float = 1.0
    final_temperature: float = 0.1
    replay_capacity: int = 50_000
    batch_size: int = 64
    training_steps_per_iteration: int = 10
    learning_rate: float = 1e-3
    weight_decay: float = 1e-4
    gradient_clip_norm: float = 5.0
    hidden_channels: int = 64
    message_passing_layers: int = 3
    checkpoint_every: int = 1
    superko_mode: str = "enforce"

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("unsupported AlphaZero config schema")
        if self.observation_mode not in {"grid_graph", "topology"}:
            raise ValueError("observation_mode must be grid_graph or topology")
        if self.model_kind is None:
            inferred = (
                "topology_gnn"
                if self.observation_mode == "topology"
                else "grid_gnn"
            )
            object.__setattr__(self, "model_kind", inferred)
        if self.model_kind not in MODEL_KIND_TO_OBSERVATION:
            raise ValueError(
                "model_kind must be padded_cnn, grid_gnn, or topology_gnn"
            )
        expected_observation = MODEL_KIND_TO_OBSERVATION[self.model_kind]
        if self.observation_mode != expected_observation:
            raise ValueError(
                f"model_kind {self.model_kind!r} requires observation_mode "
                f"{expected_observation!r}"
            )
        if not self.board_sizes or any(size not in range(5, 16) for size in self.board_sizes):
            raise ValueError("board_sizes must contain values from 5 through 15")
        if len(set(self.board_sizes)) != len(self.board_sizes):
            raise ValueError("board_sizes must not contain duplicates")
        integer_positive = {
            "iterations": self.iterations,
            "games_per_iteration": self.games_per_iteration,
            "puct_simulations": self.puct_simulations,
            "max_plies": self.max_plies,
            "replay_capacity": self.replay_capacity,
            "batch_size": self.batch_size,
            "hidden_channels": self.hidden_channels,
            "message_passing_layers": self.message_passing_layers,
            "checkpoint_every": self.checkpoint_every,
        }
        for name, value in integer_positive.items():
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.training_steps_per_iteration < 0:
            raise ValueError("training_steps_per_iteration must be non-negative")
        if not 0 <= self.temperature_moves:
            raise ValueError("temperature_moves must be non-negative")
        finite_positive = {
            "c_puct": self.c_puct,
            "dirichlet_alpha": self.dirichlet_alpha,
            "initial_temperature": self.initial_temperature,
            "learning_rate": self.learning_rate,
            "gradient_clip_norm": self.gradient_clip_norm,
        }
        for name, value in finite_positive.items():
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if not math.isfinite(self.final_temperature) or self.final_temperature < 0:
            raise ValueError("final_temperature must be finite and non-negative")
        if not 0 <= self.dirichlet_epsilon <= 1:
            raise ValueError("dirichlet_epsilon must be in [0, 1]")
        if not math.isfinite(self.weight_decay) or self.weight_decay < 0:
            raise ValueError("weight_decay must be finite and non-negative")
        if self.superko_mode not in {"enforce", "observe"}:
            raise ValueError("superko_mode must be enforce or observe")

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["board_sizes"] = list(self.board_sizes)
        return payload

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AlphaZeroConfig":
        expected = set(cls.__dataclass_fields__)
        unknown = set(data) - expected
        if unknown:
            raise ValueError(f"unknown AlphaZero config keys: {sorted(unknown)}")
        payload = dict(data)
        if "board_sizes" in payload:
            payload["board_sizes"] = tuple(int(size) for size in payload["board_sizes"])
        return cls(**payload)

    @classmethod
    def load(cls, path: str | Path) -> "AlphaZeroConfig":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("AlphaZero config must be a JSON object")
        return cls.from_dict(data)

    def canonical_json(self, *, resume_critical: bool = False) -> str:
        payload = self.to_dict()
        if resume_critical:
            # These fields control only when execution stops or emits a safe-point
            # checkpoint. Extending a run must not change its scientific protocol.
            payload.pop("iterations")
            payload.pop("checkpoint_every")
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))

    def fingerprint(self, *, resume_critical: bool = False) -> str:
        return hashlib.sha256(
            self.canonical_json(resume_critical=resume_critical).encode("utf-8")
        ).hexdigest()

    def with_overrides(self, **changes: Any) -> "AlphaZeroConfig":
        return replace(self, **changes)

    def smoke(self) -> "AlphaZeroConfig":
        """Small end-to-end configuration; artifacts remain labelled smoke."""

        return replace(
            self,
            board_sizes=(5,),
            iterations=1,
            games_per_iteration=1,
            puct_simulations=4,
            max_plies=96,
            temperature_moves=96,
            initial_temperature=1.0,
            final_temperature=1.0,
            replay_capacity=256,
            batch_size=2,
            training_steps_per_iteration=1,
            hidden_channels=16,
            message_passing_layers=1,
            checkpoint_every=1,
        )
