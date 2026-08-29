#!/usr/bin/env python3
"""Recompute a persisted neural-arena gate and verify checkpoint byte hashes."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl.alphazero.evaluation import (  # noqa: E402
    ArenaGateConfig,
    D13_FORMAL_MIN_GRADIENT_STEPS,
    D13_FORMAL_MIN_SELF_PLAY_GAMES,
    D13_FORMAL_MODEL_KIND,
    D13_NEURAL_AGENT_CLASS,
    evaluate_arena_gate,
)
from lifeline_rl.alphazero.checkpoint import load_checkpoint  # noqa: E402
from lifeline_rl.alphazero.network import (  # noqa: E402
    NetworkConfig,
    build_policy_value_network,
)
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer  # noqa: E402


def _sha256_text(value: Any, name: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value.lower())
    ):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return value.lower()


def _verify_checkpoint(
    metadata: Any,
    slot: str,
    *,
    evidence_tier: str,
    gate_kind: str,
) -> dict[str, Any] | None:
    if not isinstance(metadata, Mapping):
        return None
    class_name = metadata.get("class")
    if class_name != D13_NEURAL_AGENT_CLASS:
        return None
    config = metadata.get("config")
    if not isinstance(config, Mapping):
        raise ValueError(f"agent {slot} neural metadata has no config")
    checkpoint = config.get("checkpoint")
    if not isinstance(checkpoint, Mapping):
        raise ValueError(f"agent {slot} neural metadata has no checkpoint identity")
    path = Path(str(checkpoint.get("path", "")))
    expected_sha256 = _sha256_text(
        checkpoint.get("sha256"), f"agent {slot} checkpoint sha256"
    )
    expected_config_hash = _sha256_text(
        checkpoint.get("config_hash"), f"agent {slot} checkpoint config_hash"
    )
    expected_source_hash = _sha256_text(
        checkpoint.get("source_hash"), f"agent {slot} checkpoint source_hash"
    )
    if not path.is_file():
        raise FileNotFoundError(f"agent {slot} checkpoint is unavailable: {path}")
    if evidence_tier == "formal":
        current_source_hash = AlphaZeroTrainer.current_source_hash()
        if expected_source_hash != current_source_hash:
            raise ValueError(
                f"agent {slot} checkpoint source is not the current frozen source"
            )
    payload = load_checkpoint(
        path,
        model=None,
        expected_config_hash=expected_config_hash,
        expected_source_hash=expected_source_hash,
        strict_source=True,
        map_location="cpu",
        restore_global_rng=False,
        restore_local_rng=False,
    )
    observed_sha256 = str(payload["manifest"].get("sha256", "")).lower()
    if observed_sha256 != expected_sha256:
        raise ValueError(
            f"agent {slot} checkpoint digest mismatch: expected {expected_sha256}, "
            f"got {observed_sha256}"
        )
    payload_config = payload.get("config")
    if not isinstance(payload_config, Mapping):
        raise ValueError(f"agent {slot} checkpoint payload has no config")
    expected_model_kind = config.get("model_kind")
    payload_model_kind = payload_config.get("model_kind")
    legacy = config.get("legacy_architecture")
    if payload_model_kind is None and legacy is None:
        raise ValueError(f"agent {slot} checkpoint payload has no model_kind")
    if payload_model_kind is not None and payload_model_kind != expected_model_kind:
        raise ValueError(f"agent {slot} checkpoint model_kind mismatch")
    payload_metadata = payload.get("metadata")
    if not isinstance(payload_metadata, Mapping):
        raise ValueError(f"agent {slot} checkpoint payload has no metadata")
    metadata_model_kind = payload_metadata.get("model_kind")
    if metadata_model_kind is not None and metadata_model_kind != expected_model_kind:
        raise ValueError(f"agent {slot} checkpoint metadata model_kind mismatch")
    metadata_parameter_count = payload_metadata.get("parameter_count")
    if (
        metadata_parameter_count is not None
        and metadata_parameter_count != config.get("parameter_count")
    ):
        raise ValueError(f"agent {slot} checkpoint metadata parameter_count mismatch")

    counters = payload.get("counters")
    if not isinstance(counters, Mapping):
        raise ValueError(f"agent {slot} checkpoint payload has no counters")
    verified_counters: dict[str, int | None] = {}
    for name in ("iteration", "games_completed", "gradient_steps"):
        payload_value = counters.get(name)
        expected_value = checkpoint.get(name)
        if payload_value is None and expected_value is None and evidence_tier != "formal":
            verified_counters[name] = None
            continue
        if (
            isinstance(payload_value, bool)
            or not isinstance(payload_value, int)
            or payload_value < 0
            or expected_value != payload_value
        ):
            raise ValueError(f"agent {slot} checkpoint counter {name!r} mismatch")
        verified_counters[name] = payload_value

    if evidence_tier == "formal":
        trainer_state = payload.get("trainer_state")
        trainer_counters = (
            trainer_state.get("counters")
            if isinstance(trainer_state, Mapping)
            else None
        )
        if (
            not isinstance(trainer_state, Mapping)
            or trainer_state.get("schema_version")
            != AlphaZeroTrainer.STATE_SCHEMA_VERSION
            or not isinstance(trainer_counters, Mapping)
        ):
            raise ValueError(f"agent {slot} checkpoint trainer counters are missing")
        if any(
            isinstance(trainer_counters.get(name), bool)
            or not isinstance(trainer_counters.get(name), int)
            or trainer_counters.get(name) != counters.get(name)
            for name in ("iteration", "games_completed", "gradient_steps")
        ):
            raise ValueError(f"agent {slot} checkpoint trainer counters mismatch")

    if evidence_tier == "formal":
        if gate_kind == "beat_random" and expected_model_kind != D13_FORMAL_MODEL_KIND:
            raise ValueError(
                f"agent {slot} formal checkpoint must be {D13_FORMAL_MODEL_KIND}"
            )
        model = build_policy_value_network(
            str(expected_model_kind),
            NetworkConfig(
                hidden_channels=int(payload_config["hidden_channels"]),
                message_passing_layers=int(payload_config["message_passing_layers"]),
            ),
        )
        load_checkpoint(
            path,
            model=model,
            expected_config_hash=expected_config_hash,
            expected_source_hash=expected_source_hash,
            strict_source=True,
            map_location="cpu",
            restore_global_rng=False,
            restore_local_rng=False,
        )
        expected_parameter_count = config.get("parameter_count")
        if expected_parameter_count != model.parameter_count:
            raise ValueError(f"agent {slot} checkpoint parameter_count mismatch")
        if gate_kind == "beat_random" and (
            verified_counters["games_completed"] is None
            or verified_counters["games_completed"]
            < D13_FORMAL_MIN_SELF_PLAY_GAMES
            or verified_counters["gradient_steps"] is None
            or verified_counters["gradient_steps"] < D13_FORMAL_MIN_GRADIENT_STEPS
        ):
            raise ValueError(f"agent {slot} checkpoint is not D13-training-ready")
    return {
        "path": str(path.resolve()),
        "sha256": expected_sha256,
        "config_hash": expected_config_hash,
        "source_hash": expected_source_hash,
        "model_kind": expected_model_kind,
        **verified_counters,
    }


def verify_neural_arena_directory(
    result_directory: str | Path,
    *,
    skip_checkpoint_files: bool = False,
) -> dict[str, Any]:
    """Recompute an arena decision and strictly bind neural checkpoint bytes."""

    root = Path(result_directory).resolve()
    saved_gate = json.loads((root / "gate.json").read_text(encoding="utf-8"))
    gate_config = ArenaGateConfig.from_dict(saved_gate["config"])
    if gate_config.evidence_tier == "formal" and skip_checkpoint_files:
        raise ValueError("formal arena verification cannot skip checkpoint files")
    summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    games = [
        json.loads(line)
        for line in (root / "games.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    recomputed = evaluate_arena_gate(summary, games, gate_config)
    if recomputed != saved_gate:
        raise ValueError("gate.json does not match the recomputed arena decision")

    identities: dict[str, dict[str, Any]] = {}
    if not skip_checkpoint_files:
        for slot in ("A", "B"):
            identity = _verify_checkpoint(
                summary.get(f"agent_{slot.lower()}_metadata"),
                slot,
                evidence_tier=gate_config.evidence_tier,
                gate_kind=gate_config.gate_kind,
            )
            if identity is not None:
                identities[slot] = identity
    if gate_config.evidence_tier == "formal":
        expected_slots = {"A", "B"} if gate_config.gate_kind == "promote_champion" else {"A"}
        if set(identities) != expected_slots:
            raise ValueError("formal arena checkpoint identities are incomplete")
    return {
        "status": "PASS",
        "evidence_tier": gate_config.evidence_tier,
        "gate_kind": gate_config.gate_kind,
        "games_replayed": len(games),
        "gate_passed": saved_gate["passed"],
        "claim_eligible": saved_gate["claim_eligible"],
        "checkpoint_files_verified": len(identities),
        "checkpoint_file_verification_skipped": skip_checkpoint_files,
        "checkpoint_identities": identities,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("result_directory", type=Path)
    parser.add_argument(
        "--skip-checkpoint-files",
        action="store_true",
        help=(
            "verify portable exploratory artifacts when checkpoint files are offline; "
            "forbidden for formal evidence"
        ),
    )
    args = parser.parse_args(argv)
    result = verify_neural_arena_directory(
        args.result_directory,
        skip_checkpoint_files=args.skip_checkpoint_files,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
