"""Replay-bound learning-health gate for the D13 Topology-GNN milestone.

This is an engineering gate, not a held-out performance claim.  It verifies
that a strictly validated checkpoint contains a trained Topology-GNN whose
finite policy/value loss on its retained self-play replay is lower than the
deterministically reconstructed initialization.  Generalization is evaluated
separately in the color-balanced arena.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import torch

from .checkpoint import load_checkpoint
from .config import AlphaZeroConfig
from .network import NetworkConfig, build_policy_value_network, collate_positions
from .replay import Experience, ReplayBuffer
from .trainer import AlphaZeroTrainer, TrainingCounters


LEARNING_HEALTH_SCHEMA = "lifeline-alphazero-learning-health"
LEARNING_HEALTH_VERSION = 1


@dataclass(frozen=True)
class LearningHealthConfig:
    """Pre-registered thresholds for an in-replay optimizer health check."""

    evidence_tier: str = "formal"
    minimum_games_completed: int = 100
    minimum_gradient_steps: int = 200
    minimum_replay_samples: int = 32
    minimum_relative_loss_improvement: float = 0.01
    maximum_samples: int = 4096
    evaluation_batch_size: int = 128
    require_topology_gnn: bool = True

    def __post_init__(self) -> None:
        if self.evidence_tier not in {"smoke", "pilot", "formal"}:
            raise ValueError("evidence_tier must be smoke, pilot, or formal")
        for name in (
            "minimum_games_completed",
            "minimum_gradient_steps",
            "minimum_replay_samples",
            "maximum_samples",
            "evaluation_batch_size",
        ):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.maximum_samples < self.minimum_replay_samples:
            raise ValueError("maximum_samples cannot be smaller than minimum_replay_samples")
        improvement = self.minimum_relative_loss_improvement
        if (
            isinstance(improvement, bool)
            or not isinstance(improvement, (int, float))
            or not math.isfinite(improvement)
            or not 0.0 <= improvement < 1.0
        ):
            raise ValueError("minimum_relative_loss_improvement must be in [0, 1)")
        if not isinstance(self.require_topology_gnn, bool):
            raise TypeError("require_topology_gnn must be a boolean")
        if self.evidence_tier == "formal":
            # Formal evidence is meaningful only with the frozen, preregistered
            # protocol.  Callers needing smaller thresholds must explicitly use
            # the smoke or pilot tier rather than relabeling an exploratory gate.
            frozen = {
                "minimum_games_completed": 100,
                "minimum_gradient_steps": 200,
                "minimum_replay_samples": 32,
                "minimum_relative_loss_improvement": 0.01,
                "maximum_samples": 4096,
                "evaluation_batch_size": 128,
                "require_topology_gnn": True,
            }
            changed = [
                name for name, expected in frozen.items()
                if getattr(self, name) != expected
            ]
            if changed:
                raise ValueError(
                    "formal learning-health protocol is frozen; changed fields: "
                    + ", ".join(changed)
                )

    @classmethod
    def exploratory(cls, evidence_tier: str = "smoke") -> "LearningHealthConfig":
        if evidence_tier not in {"smoke", "pilot"}:
            raise ValueError("exploratory learning health must be smoke or pilot")
        return cls(
            evidence_tier=evidence_tier,
            minimum_games_completed=1,
            minimum_gradient_steps=1,
            minimum_replay_samples=2,
            minimum_relative_loss_improvement=0.0,
            maximum_samples=256,
            evaluation_batch_size=64,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _checkpoint_config(payload: Mapping[str, Any]) -> AlphaZeroConfig:
    raw = payload.get("config")
    if not isinstance(raw, Mapping):
        raise ValueError("checkpoint config must be a mapping")
    return AlphaZeroConfig.from_dict(raw)


def _retained_experiences(
    payload: Mapping[str, Any], config: AlphaZeroConfig
) -> tuple[Experience, ...]:
    state = payload.get("buffer_state_dict")
    if not isinstance(state, Mapping):
        raise ValueError("checkpoint does not contain replay-buffer state")
    # Reuse the replay loader so capacity, total_added, RNG state, and every
    # serialized Experience are validated instead of trusting pickle objects.
    replay = ReplayBuffer.from_state_dict(state)
    if replay.capacity != config.replay_capacity:
        raise ValueError("checkpoint replay capacity disagrees with its config")
    experiences = replay.samples
    for index, experience in enumerate(experiences):
        if experience.observation_mode != config.observation_mode:
            raise ValueError(
                f"replay sample {index} observation mode disagrees with its config"
            )
        if experience.grid_size not in config.board_sizes:
            raise ValueError(
                f"replay sample {index} board size disagrees with its config"
            )
    return experiences


def _validated_counters(payload: Mapping[str, Any]) -> TrainingCounters:
    outer = payload.get("counters")
    trainer_state = payload.get("trainer_state")
    if not isinstance(outer, Mapping):
        raise ValueError("checkpoint counters must be a mapping")
    if not isinstance(trainer_state, Mapping):
        raise ValueError("checkpoint trainer state must be a mapping")
    if trainer_state.get("schema_version") != AlphaZeroTrainer.STATE_SCHEMA_VERSION:
        raise ValueError("checkpoint trainer-state schema is unsupported")
    inner = trainer_state.get("counters")
    if not isinstance(inner, Mapping):
        raise ValueError("checkpoint trainer state does not contain counters")
    expected = set(TrainingCounters.__dataclass_fields__)
    for label, values in (("outer", outer), ("trainer-state", inner)):
        if set(values) != expected:
            raise ValueError(f"checkpoint {label} counter keys are invalid")
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in values.values()
        ):
            raise ValueError(
                f"checkpoint {label} counters must be non-negative integers"
            )
    outer_counters = TrainingCounters.from_dict(outer)
    inner_counters = TrainingCounters.from_dict(inner)
    if outer_counters != inner_counters:
        raise ValueError("checkpoint outer and trainer-state counters disagree")
    return outer_counters


def _evenly_spaced_samples(
    experiences: Sequence[Experience], maximum_samples: int
) -> tuple[Experience, ...]:
    if len(experiences) <= maximum_samples:
        return tuple(experiences)
    if maximum_samples == 1:
        return (experiences[len(experiences) // 2],)
    # Stable coverage of the entire FIFO window avoids a favorable random sample.
    denominator = maximum_samples - 1
    indices = [
        round(index * (len(experiences) - 1) / denominator)
        for index in range(maximum_samples)
    ]
    return tuple(experiences[index] for index in indices)


def _losses(
    model: torch.nn.Module,
    experiences: Sequence[Experience],
    observation_mode: str,
    batch_size: int,
) -> dict[str, float]:
    totals = {"policy_loss": 0.0, "value_loss": 0.0}
    model.eval()
    with torch.no_grad():
        for start in range(0, len(experiences), batch_size):
            rows = experiences[start : start + batch_size]
            batch = collate_positions(rows, observation_mode, device="cpu")
            if batch.policy_targets is None or batch.value_targets is None:
                raise RuntimeError("replay batch is missing policy/value targets")
            logits, values = model(
                batch.node_features,
                batch.adjacency,
                batch.node_mask,
                batch.legal_action_mask,
            )
            policy = -(
                batch.policy_targets * torch.log_softmax(logits, dim=1)
            ).sum(dim=1)
            value = (values - batch.value_targets).square()
            if not bool(torch.isfinite(policy).all() and torch.isfinite(value).all()):
                raise FloatingPointError("non-finite replay loss")
            totals["policy_loss"] += float(policy.sum())
            totals["value_loss"] += float(value.sum())
    count = len(experiences)
    result = {key: value / count for key, value in totals.items()}
    result["total_loss"] = result["policy_loss"] + result["value_loss"]
    return result


def _parameter_diagnostics(
    initial_model: torch.nn.Module,
    final_model: torch.nn.Module,
) -> tuple[bool, float]:
    """Check finite model state and trainable-parameter displacement.

    Integer and boolean buffers are valid model state (for example, a batch
    counter) but cannot be subtracted like floating-point parameters.  They are
    therefore checked structurally by strict state loading and excluded from
    the optimizer displacement calculation.
    """

    parameters_finite = True
    for value in final_model.state_dict().values():
        if torch.is_tensor(value) and (value.is_floating_point() or value.is_complex()):
            parameters_finite = parameters_finite and bool(torch.isfinite(value).all())

    initial_parameters = dict(initial_model.named_parameters())
    final_parameters = dict(final_model.named_parameters())
    if initial_parameters.keys() != final_parameters.keys():
        raise RuntimeError("initial and final model parameter names disagree")
    delta_squared = 0.0
    for name, final_value in final_parameters.items():
        initial_value = initial_parameters[name]
        if final_value.shape != initial_value.shape or final_value.dtype != initial_value.dtype:
            raise RuntimeError(f"initial and final parameter {name!r} disagree")
        if not (final_value.is_floating_point() or final_value.is_complex()):
            continue
        difference = final_value.detach().cpu() - initial_value.detach().cpu()
        delta_squared += float(difference.abs().double().square().sum())
    return parameters_finite, math.sqrt(delta_squared)


def _checkpoint_metadata_checks(
    payload: Mapping[str, Any],
    config: AlphaZeroConfig,
    final_model: torch.nn.Module,
) -> dict[str, bool]:
    metadata = payload.get("metadata")
    if not isinstance(metadata, Mapping):
        return {"checkpoint_metadata": False, "initialization_runtime": False}
    expected_network = {
        "hidden_channels": config.hidden_channels,
        "message_passing_layers": config.message_passing_layers,
    }
    return {
        "checkpoint_metadata": (
            metadata.get("safe_point")
            == "between_complete_games_after_optimizer_step"
            and metadata.get("model_kind") == config.model_kind
            and metadata.get("observation_mode") == config.observation_mode
            and metadata.get("network_config") == expected_network
            and metadata.get("parameter_count") == final_model.parameter_count
        ),
        # PyTorch owns parameter initialization.  Source equality alone cannot
        # establish that a seed reconstructs identical weights across versions.
        "initialization_runtime": metadata.get("torch_version") == torch.__version__,
    }


def evaluate_learning_health(
    checkpoint: str | Path,
    gate: LearningHealthConfig | None = None,
    *,
    strict_source: bool = True,
) -> dict[str, Any]:
    """Validate a checkpoint and recompute the D13 learning-health decision."""

    gate = gate or LearningHealthConfig()
    current_source_hash = AlphaZeroTrainer.current_source_hash()
    payload = load_checkpoint(
        checkpoint,
        model=None,
        expected_source_hash=current_source_hash if strict_source else None,
        strict_source=strict_source,
        map_location="cpu",
        restore_global_rng=False,
        restore_local_rng=False,
    )
    config = _checkpoint_config(payload)
    network_config = NetworkConfig(
        config.hidden_channels,
        config.message_passing_layers,
    )
    final_model = build_policy_value_network(config.model_kind, network_config)
    load_checkpoint(
        checkpoint,
        model=final_model,
        expected_source_hash=current_source_hash if strict_source else None,
        strict_source=strict_source,
        map_location="cpu",
        restore_global_rng=False,
        restore_local_rng=False,
    )
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(config.seed)
        initial_model = build_policy_value_network(config.model_kind, network_config)

    experiences = _retained_experiences(payload, config)
    selected = _evenly_spaced_samples(experiences, gate.maximum_samples)
    counters = _validated_counters(payload)
    games_completed = counters.games_completed
    gradient_steps = counters.gradient_steps

    initial_losses = _losses(
        initial_model,
        selected,
        config.observation_mode,
        gate.evaluation_batch_size,
    ) if selected else None
    final_losses = _losses(
        final_model,
        selected,
        config.observation_mode,
        gate.evaluation_batch_size,
    ) if selected else None

    parameters_finite, parameter_delta_l2 = _parameter_diagnostics(
        initial_model, final_model
    )

    relative_improvement = None
    if initial_losses is not None and final_losses is not None:
        denominator = max(initial_losses["total_loss"], torch.finfo(torch.float64).eps)
        relative_improvement = (
            initial_losses["total_loss"] - final_losses["total_loss"]
        ) / denominator

    checks = {
        **_checkpoint_metadata_checks(payload, config, final_model),
        "strict_source_verified": strict_source or gate.evidence_tier != "formal",
        "topology_model": (
            config.model_kind == "topology_gnn" or not gate.require_topology_gnn
        ),
        "games_completed": games_completed >= gate.minimum_games_completed,
        "gradient_steps": gradient_steps >= gate.minimum_gradient_steps,
        "replay_samples": len(experiences) >= gate.minimum_replay_samples,
        "parameters_finite": parameters_finite,
        "parameters_changed": parameter_delta_l2 > 0.0,
        "losses_finite": (
            initial_losses is not None
            and final_losses is not None
            and all(math.isfinite(value) for value in (*initial_losses.values(), *final_losses.values()))
        ),
        "replay_loss_improved": (
            relative_improvement is not None
            and relative_improvement >= gate.minimum_relative_loss_improvement
        ),
    }
    passed = all(checks.values())
    return {
        "schema": {"name": LEARNING_HEALTH_SCHEMA, "version": LEARNING_HEALTH_VERSION},
        "evidence_tier": gate.evidence_tier,
        "passed": passed,
        "claim_eligible": (
            passed and gate.evidence_tier == "formal" and strict_source
        ),
        "config": gate.to_dict(),
        "checks": checks,
        "observed": {
            "model_kind": config.model_kind,
            "observation_mode": config.observation_mode,
            "parameter_count": final_model.parameter_count,
            "parameter_delta_l2": parameter_delta_l2,
            "games_completed": games_completed,
            "gradient_steps": gradient_steps,
            "replay_samples_retained": len(experiences),
            "replay_samples_evaluated": len(selected),
            "initial_losses": initial_losses,
            "final_losses": final_losses,
            "relative_total_loss_improvement": relative_improvement,
        },
        "checkpoint": {
            "path": payload["checkpoint_path"],
            "sha256": payload["manifest"]["sha256"],
            "source_hash": payload["source_hash"],
            "strict_source_verified": strict_source,
        },
        "scope_note": (
            "In-replay optimizer health only; arena results are required for "
            "strength or generalization claims."
        ),
    }


def write_learning_health_report(
    report: Mapping[str, Any], path: str | Path, *, overwrite: bool = False
) -> Path:
    destination = Path(path)
    if destination.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite learning-health report: {destination}")
    if report.get("schema") != {
        "name": LEARNING_HEALTH_SCHEMA,
        "version": LEARNING_HEALTH_VERSION,
    }:
        raise ValueError("unsupported learning-health report schema")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(report, handle, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination


__all__ = [
    "LEARNING_HEALTH_SCHEMA",
    "LEARNING_HEALTH_VERSION",
    "LearningHealthConfig",
    "evaluate_learning_health",
    "write_learning_health_report",
]
