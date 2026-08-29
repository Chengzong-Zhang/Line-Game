"""Frozen checkpoint inference agent for the color-balanced arena.

This module intentionally lives outside :mod:`lifeline_rl.agents`: importing
the dependency-free environment and search baselines must not make PyTorch a
mandatory dependency.  ``NeuralPUCTAgent.from_checkpoint`` validates the
manifest, canonical training config, model representation, source identity,
and state-dict shape before exposing the ordinary arena ``Agent`` interface.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping

try:
    import torch
    from torch import nn
except ImportError as exc:  # pragma: no cover - core-only installations
    raise ImportError(
        "Neural arena evaluation requires PyTorch; install the 'train' extra"
    ) from exc

from ..agents.base import Action
from ..core import LifelineGame
from .checkpoint import (
    CheckpointConfigError,
    CheckpointError,
    CheckpointSourceError,
    load_checkpoint,
)
from .config import AlphaZeroConfig
from .network import (
    MODEL_KINDS,
    NetworkConfig,
    PolicyValueNetwork,
    TorchPolicyValueEvaluator,
    build_policy_value_network,
    observation_mode_for_model,
)
from .puct import PUCTConfig, PUCTSearch, SearchResult


class NeuralAgentCheckpointError(CheckpointError):
    """A checkpoint cannot be used as the requested frozen arena agent."""


class CheckpointRepresentationError(NeuralAgentCheckpointError):
    """The saved and requested model/observation protocols disagree."""


@dataclass(frozen=True)
class NeuralPUCTSearchConfig:
    """Evaluation-only PUCT settings; root noise is deliberately unavailable."""

    simulations: int = 64
    c_puct: float = 1.5
    temperature: float = 0.0

    def __post_init__(self) -> None:
        if (
            isinstance(self.simulations, bool)
            or not isinstance(self.simulations, int)
            or self.simulations < 1
        ):
            raise ValueError("simulations must be a positive integer")
        if not math.isfinite(self.c_puct) or self.c_puct < 0.0:
            raise ValueError("c_puct must be finite and non-negative")
        if not math.isfinite(self.temperature) or self.temperature < 0.0:
            raise ValueError("temperature must be finite and non-negative")


def _valid_sha256(value: str) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower())
    )


@dataclass(frozen=True)
class CheckpointIdentity:
    """Immutable checkpoint provenance retained in every arena summary."""

    path: str
    sha256: str
    config_hash: str
    source_hash: str
    created_at_utc: str | None
    iteration: int | None
    games_completed: int | None
    gradient_steps: int | None

    def __post_init__(self) -> None:
        if not self.path:
            raise ValueError("checkpoint path must be non-empty")
        for name, value in (
            ("sha256", self.sha256),
            ("config_hash", self.config_hash),
            ("source_hash", self.source_hash),
        ):
            if not _valid_sha256(value):
                raise ValueError(f"checkpoint {name} must be a SHA-256 digest")
        for name, value in (
            ("iteration", self.iteration),
            ("games_completed", self.games_completed),
            ("gradient_steps", self.gradient_steps),
        ):
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise ValueError(f"checkpoint {name} must be None or non-negative")


@dataclass(frozen=True)
class NeuralAgentMetadata:
    """Dataclass-shaped metadata automatically serialized by the arena."""

    schema_version: int
    label: str
    model_kind: str
    observation_mode: str
    network_config: NetworkConfig
    trained_board_sizes: tuple[int, ...]
    train_superko_mode: str
    parameter_count: int
    device: str
    checkpoint: CheckpointIdentity
    search: NeuralPUCTSearchConfig
    allow_superko_mode_override: bool = False
    legacy_architecture: str | None = None

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("unsupported neural-agent metadata schema")
        if not self.label:
            raise ValueError("neural-agent label must be non-empty")
        if self.model_kind not in MODEL_KINDS:
            raise ValueError(f"model_kind must be one of {MODEL_KINDS}")
        expected_observation = observation_mode_for_model(self.model_kind)
        if self.observation_mode != expected_observation:
            raise ValueError(
                f"model_kind {self.model_kind!r} requires observation_mode "
                f"{expected_observation!r}"
            )
        if not self.trained_board_sizes:
            raise ValueError("trained_board_sizes must not be empty")
        if self.train_superko_mode not in {"enforce", "observe"}:
            raise ValueError("train_superko_mode must be enforce or observe")
        if not isinstance(self.allow_superko_mode_override, bool):
            raise TypeError("allow_superko_mode_override must be a boolean")
        if self.parameter_count < 1:
            raise ValueError("parameter_count must be positive")

    @property
    def superko_mode(self) -> str:
        """Backward-compatible alias for the explicitly named training rule."""

        return self.train_superko_mode


def _checkpoint_and_run_directory(path: Path) -> tuple[Path, Path]:
    resolved = path.resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"checkpoint path does not exist: {resolved}")

    if resolved.is_dir() and (resolved / "latest.json").is_file():
        checkpoint_target = resolved
    elif resolved.is_dir() and (resolved / "checkpoints" / "latest.json").is_file():
        checkpoint_target = resolved / "checkpoints"
    elif resolved.is_file():
        checkpoint_target = resolved
    else:
        raise FileNotFoundError(
            f"checkpoint manifest not found below supplied path: {resolved}"
        )

    checkpoint_directory = (
        checkpoint_target if checkpoint_target.is_dir() else checkpoint_target.parent
    )
    run_directory = (
        checkpoint_directory.parent
        if checkpoint_directory.name == "checkpoints"
        else checkpoint_directory
    )
    return checkpoint_target, run_directory


def _read_config(
    path: Path,
) -> tuple[AlphaZeroConfig, dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise NeuralAgentCheckpointError(f"cannot read training config: {path}") from exc
    if not isinstance(raw, dict):
        raise NeuralAgentCheckpointError("training config must be a JSON object")
    try:
        config = AlphaZeroConfig.from_dict(raw)
    except (TypeError, ValueError) as exc:
        raise NeuralAgentCheckpointError("training config is invalid") from exc
    return config, raw


def _resume_config_from_raw(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Match the exact config shape used at save time, including legacy runs."""

    config = dict(raw)
    config.pop("iterations", None)
    config.pop("checkpoint_every", None)
    return config


def _counter(payload: Mapping[str, Any], name: str) -> int | None:
    counters = payload.get("counters")
    if not isinstance(counters, Mapping) or name not in counters:
        return None
    value = counters[name]
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise NeuralAgentCheckpointError(f"checkpoint counter {name!r} is invalid")
    return value


class NeuralPUCTAgent:
    """A read-only learned policy implementing the ordinary arena Agent API."""

    def __init__(
        self,
        model: nn.Module,
        metadata: NeuralAgentMetadata,
    ) -> None:
        model_kind = getattr(model, "model_kind", None)
        if metadata.legacy_architecture is None and model_kind != metadata.model_kind:
            raise CheckpointRepresentationError(
                f"model reports kind {model_kind!r}, metadata requires "
                f"{metadata.model_kind!r}"
            )
        model_observation = getattr(model, "observation_mode", None)
        if (
            metadata.legacy_architecture is None
            and model_observation != metadata.observation_mode
        ):
            raise CheckpointRepresentationError(
                f"model reports observation {model_observation!r}, metadata requires "
                f"{metadata.observation_mode!r}"
            )
        observed_parameters = sum(parameter.numel() for parameter in model.parameters())
        if observed_parameters != metadata.parameter_count:
            raise CheckpointRepresentationError(
                "model parameter count disagrees with checkpoint metadata"
            )

        self.model = model
        self.config = metadata
        self.device = torch.device(metadata.device)
        self.model.to(self.device)
        self.model.eval()
        evaluator = TorchPolicyValueEvaluator(
            self.model,
            metadata.observation_mode,
            self.device,
        )
        self._searcher = PUCTSearch(
            evaluator,
            PUCTConfig(
                simulations=metadata.search.simulations,
                c_puct=metadata.search.c_puct,
                # Arena evaluation never applies root noise.  Epsilon is zero
                # as an additional invariant even if PUCT is called incorrectly.
                dirichlet_alpha=0.3,
                dirichlet_epsilon=0.0,
            ),
        )
        self._last_diagnostics: dict[str, object] = {}

    @property
    def name(self) -> str:
        return self.config.label

    @property
    def checkpoint_identity(self) -> CheckpointIdentity:
        return self.config.checkpoint

    def search(self, game: LifelineGame, rng: random.Random) -> SearchResult:
        if game.game_over:
            raise RuntimeError("cannot run NeuralPUCTAgent on a terminal state")
        if (
            game.superko_mode != self.config.train_superko_mode
            and not self.config.allow_superko_mode_override
        ):
            raise CheckpointRepresentationError(
                "checkpoint was trained with Superko mode "
                f"{self.config.train_superko_mode!r}, arena uses "
                f"{game.superko_mode!r}; pass allow_superko_mode_override=True "
                "only for an explicit fixed-weight rules ablation"
            )
        return self._searcher.search(
            game,
            rng,
            temperature=self.config.search.temperature,
            add_root_noise=False,
        )

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        result = self.search(game, rng)
        action = result.action
        selected_visits = result.visits[action]
        self._last_diagnostics = {
            "algorithm": "neural_puct",
            "model_kind": self.config.model_kind,
            "checkpoint_sha256": self.config.checkpoint.sha256,
            "train_superko_mode": self.config.train_superko_mode,
            "eval_superko_mode": game.superko_mode,
            "superko_mode_override": (
                game.superko_mode != self.config.train_superko_mode
            ),
            "allow_superko_mode_override": (
                self.config.allow_superko_mode_override
            ),
            "simulations": result.simulations,
            "temperature": result.temperature,
            "root_player": result.root_player.value,
            "selected_action": action,
            "selected_visits": selected_visits,
            "selected_prior": result.priors[action],
            "selected_q": result.q_values[action],
            "root_visits": list(result.visits),
            "root_priors": list(result.priors),
            "root_q_values": list(result.q_values),
            "root_visit_sum": sum(result.visits),
        }
        return None if action == game.num_points else game.valid_positions[action]

    def diagnostics(self) -> dict[str, object]:
        return dict(self._last_diagnostics)

    @classmethod
    def from_checkpoint(
        cls,
        path: str | Path,
        *,
        config_path: str | Path | None = None,
        device: str | torch.device = "cpu",
        search_config: NeuralPUCTSearchConfig | None = None,
        label: str | None = None,
        expected_model_kind: str | None = None,
        expected_observation_mode: str | None = None,
        expected_config_hash: str | None = None,
        expected_source_hash: str | None = None,
        strict_source: bool = True,
        allow_superko_mode_override: bool = False,
    ) -> "NeuralPUCTAgent":
        """Build and validate a frozen neural agent without restoring RNG state.

        ``path`` may be a run directory, its ``checkpoints`` directory,
        ``latest.json``, or the exact checkpoint named by that manifest.  A
        separate ``config_path`` is needed only when ``resolved_config.json``
        is not present in the inferred run directory.
        """

        if not isinstance(allow_superko_mode_override, bool):
            raise TypeError("allow_superko_mode_override must be a boolean")
        checkpoint_target, run_directory = _checkpoint_and_run_directory(Path(path))
        resolved_config_path = (
            Path(config_path).resolve()
            if config_path is not None
            else run_directory / "resolved_config.json"
        )
        if not resolved_config_path.is_file():
            raise FileNotFoundError(
                "resolved training config not found; pass config_path explicitly: "
                f"{resolved_config_path}"
            )
        config, raw_config = _read_config(resolved_config_path)
        model_kind = str(config.model_kind)
        observation_mode = config.observation_mode
        if expected_model_kind is not None and model_kind != expected_model_kind:
            raise CheckpointRepresentationError(
                f"checkpoint model_kind is {model_kind!r}, expected "
                f"{expected_model_kind!r}"
            )
        if (
            expected_observation_mode is not None
            and observation_mode != expected_observation_mode
        ):
            raise CheckpointRepresentationError(
                f"checkpoint observation_mode is {observation_mode!r}, expected "
                f"{expected_observation_mode!r}"
            )
        if observation_mode_for_model(model_kind) != observation_mode:
            raise CheckpointRepresentationError(
                "checkpoint model kind and observation mode are incompatible"
            )

        network_config = NetworkConfig(
            hidden_channels=config.hidden_channels,
            message_passing_layers=config.message_passing_layers,
        )
        legacy_architecture: str | None = None
        # Network constructors initialize parameters from Torch's global CPU
        # generator.  Loading a frozen checkpoint must be observational with
        # respect to the caller's RNG stream, so restore that stream immediately
        # after construction (successful or otherwise).
        cpu_rng_state = torch.get_rng_state()
        try:
            if raw_config.get("model_kind") is None:
                # D9--D10 used one three-relation architecture for both observation
                # modes; GridGraph zeroed relations 1 and 2 in the encoder.  Using
                # the new one-relation GridGNN here would not match that state dict.
                model = PolicyValueNetwork(network_config)
                legacy_architecture = "d9_d10_three_relation_gnn_v0"
            else:
                model = build_policy_value_network(model_kind, network_config)
        finally:
            torch.set_rng_state(cpu_rng_state)

        if strict_source and expected_source_hash is None:
            # Imported lazily to keep the class independently testable and to
            # avoid loading the training stack during ordinary module import.
            from .trainer import AlphaZeroTrainer

            expected_source_hash = AlphaZeroTrainer.current_source_hash()

        payload = load_checkpoint(
            checkpoint_target,
            model=model,
            expected_config=_resume_config_from_raw(raw_config),
            expected_config_hash=expected_config_hash,
            expected_source_hash=expected_source_hash,
            strict_source=strict_source,
            map_location=torch.device(device),
            restore_global_rng=False,
            restore_local_rng=False,
            strict_model=True,
        )

        saved_config = payload.get("config")
        if not isinstance(saved_config, Mapping):
            raise CheckpointConfigError("checkpoint config must be a mapping")
        saved_kind = saved_config.get("model_kind")
        if saved_kind is not None and saved_kind != model_kind:
            raise CheckpointRepresentationError(
                "checkpoint payload model_kind disagrees with resolved config"
            )
        saved_observation = saved_config.get("observation_mode")
        if saved_observation != observation_mode:
            raise CheckpointRepresentationError(
                "checkpoint payload observation_mode disagrees with resolved config"
            )

        saved_metadata = payload.get("metadata")
        if not isinstance(saved_metadata, Mapping):
            raise NeuralAgentCheckpointError("checkpoint metadata must be a mapping")
        metadata_kind = saved_metadata.get("model_kind")
        if metadata_kind is not None and metadata_kind != model_kind:
            raise CheckpointRepresentationError(
                "checkpoint metadata model_kind disagrees with resolved config"
            )
        metadata_observation = saved_metadata.get("observation_mode")
        if metadata_observation is not None and metadata_observation != observation_mode:
            raise CheckpointRepresentationError(
                "checkpoint metadata observation_mode disagrees with resolved config"
            )

        parameter_count = sum(parameter.numel() for parameter in model.parameters())
        saved_parameter_count = saved_metadata.get("parameter_count")
        if saved_parameter_count is not None and saved_parameter_count != parameter_count:
            raise CheckpointRepresentationError(
                "checkpoint metadata parameter_count disagrees with constructed model"
            )

        manifest = payload.get("manifest")
        if not isinstance(manifest, Mapping):
            raise NeuralAgentCheckpointError("checkpoint manifest is missing")
        identity = CheckpointIdentity(
            path=str(Path(payload["checkpoint_path"]).resolve()),
            sha256=str(manifest.get("sha256", "")),
            config_hash=str(payload.get("config_hash", "")),
            source_hash=str(payload.get("source_hash", "")),
            created_at_utc=(
                None
                if payload.get("created_at_utc") is None
                else str(payload["created_at_utc"])
            ),
            iteration=_counter(payload, "iteration"),
            games_completed=_counter(payload, "games_completed"),
            gradient_steps=_counter(payload, "gradient_steps"),
        )
        selected_search_config = search_config or NeuralPUCTSearchConfig(
            simulations=config.puct_simulations,
            c_puct=config.c_puct,
            temperature=0.0,
        )
        selected_label = label or f"alphazero-{model_kind}-{identity.sha256[:12]}"
        metadata = NeuralAgentMetadata(
            schema_version=1,
            label=selected_label,
            model_kind=model_kind,
            observation_mode=observation_mode,
            network_config=network_config,
            trained_board_sizes=tuple(config.board_sizes),
            train_superko_mode=config.superko_mode,
            parameter_count=parameter_count,
            device=str(torch.device(device)),
            checkpoint=identity,
            search=selected_search_config,
            allow_superko_mode_override=allow_superko_mode_override,
            legacy_architecture=legacy_architecture,
        )
        return cls(model, metadata)

    def metadata_dict(self) -> dict[str, Any]:
        """Explicit helper for tools that do not use arena dataclass discovery."""

        return asdict(self.config)


__all__ = [
    "CheckpointIdentity",
    "CheckpointRepresentationError",
    "NeuralAgentCheckpointError",
    "NeuralAgentMetadata",
    "NeuralPUCTAgent",
    "NeuralPUCTSearchConfig",
]
