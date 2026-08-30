#!/usr/bin/env python3
"""Frozen-manifest expansion for the D17--D19 LIFELINE-RL extension.

This module deliberately does not execute games.  It validates the frozen
protocol, materialises D16-v2 opening prefixes, and writes an immutable task
bundle containing both task-level and game-level manifests.  The executor in
``d17_d19_runner.py`` treats those manifests as the only scheduling authority.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import random
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
RUNNER_PATH = RESEARCH_ROOT / "scripts" / "d17_d19_runner.py"
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

SCHEMA_NAME = "lifeline-d17-d19-experiment-manifest"
SCHEMA_VERSION = 1
MATERIALIZED_SCHEMA_NAME = "lifeline-d17-d19-materialized-manifest"
TASK_SCHEMA_NAME = "lifeline-d17-d19-task"
GAME_MANIFEST_SCHEMA_NAME = "lifeline-d17-d19-game-manifest"
BUNDLE_SCHEMA_NAME = "lifeline-d17-d19-task-bundle"

BUNDLE_EXPERIMENT_ID = "d17_d19_lifeline_extension_20260829_v1"
GEN_SIZE_EXPERIMENT_ID = "d17_gen_size_zero_shot_formal_v1"
D16_V2_EXPERIMENT_ID = "d18_d16_v2_diverse_openings_formal_v1"
D16_V2_ARM = "d16-v2"
P1_EXPERIMENT_ID = "d19_logic_edge_archmatched_smoke_v1"

TRAINING_SEEDS = (20260825, 20260826, 20260827, 20260828, 20260829)
MODEL_KINDS = ("padded_cnn", "grid_gnn", "topology_gnn")
GEN_MODEL_KINDS = ("grid_gnn", "topology_gnn")
TRAINED_SIZES = (5, 7, 9)
GEN_EVAL_SIZES = (10, 12)
D16_V2_EVAL_SIZES = (5, 7, 9)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ProtocolError(ValueError):
    """Raised when a proposed formal schedule is not exactly auditable."""


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_hash(manifest: Mapping[str, Any]) -> str:
    return canonical_sha256(manifest)


def opening_prefix_hash(actions: Sequence[int]) -> str:
    """Canonical hash frozen jointly with the independent verifier."""

    normalized = [int(action) for action in actions]
    return hashlib.sha256(canonical_json(normalized).encode("utf-8")).hexdigest()


def opening_state_hash(game: Any) -> str:
    """Hash the full serialized state, including logical edges and history."""

    return hashlib.sha256(game.canonical_state_json().encode("utf-8")).hexdigest()


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{label} must be a JSON object")
    return value


def _sequence(value: object, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise ProtocolError(f"{label} must be a JSON array")
    return value


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ProtocolError(f"{label} must be a positive integer")
    return value


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ProtocolError(f"{label} must be a non-negative integer")
    return value


def _sha(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise ProtocolError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _first(mapping: Mapping[str, Any], names: Iterable[str], default: Any = None) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    return default


def resolve_manifest_path(value: str | Path, *, manifest_path: str | Path) -> Path:
    """Resolve a frozen path without depending on the invocation directory."""

    raw = Path(value)
    if raw.is_absolute():
        return raw.resolve()
    manifest_parent = Path(manifest_path).resolve().parent
    candidates = (
        manifest_parent / raw,
        REPO_ROOT / raw,
        RESEARCH_ROOT / raw,
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    # Preserve a deterministic expected location in error messages.
    return (REPO_ROOT / raw).resolve()


def _read_json(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read JSON manifest {source}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError("manifest must be a JSON object")
    return payload


def load_manifest(path: str | Path) -> dict[str, Any]:
    payload = _read_json(path)
    validate_manifest(payload, manifest_path=path)
    return payload


def _checkpoint_entries(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = _sequence(manifest.get("checkpoints"), "checkpoints")
    return [dict(_mapping(item, f"checkpoints[{index}]")) for index, item in enumerate(raw)]


def _arm(manifest: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    return _mapping(manifest.get(name), name)


def _arm_experiment_id(arm: Mapping[str, Any], expected: str, label: str) -> None:
    observed = _first(arm, ("experiment_id", "id"))
    if observed != expected:
        raise ProtocolError(f"{label}.experiment_id must be {expected!r}")


def _model_kinds(arm: Mapping[str, Any], default: Sequence[str]) -> tuple[str, ...]:
    value = _first(arm, ("model_kinds", "checkpoint_model_kinds", "representations"), default)
    return tuple(str(item) for item in _sequence(value, "model kinds"))


def _eval_sizes(arm: Mapping[str, Any], default: Sequence[int]) -> tuple[int, ...]:
    value = _first(arm, ("eval_sizes", "test_sizes", "board_sizes"), default)
    return tuple(int(item) for item in _sequence(value, "eval sizes"))


def _opponents(gen_size: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = _first(gen_size, ("opponents", "search_opponents"))
    if raw is None:
        return [
            {"id": "random", "agent_kind": "random", "config": {}},
            {
                "id": "uct_mcts_16",
                "agent_kind": "mcts",
                "config": {
                    "simulations": 16,
                    "rollout_depth": 80,
                    "exploration": 2.0**0.5,
                },
            },
        ]
    opponents: list[dict[str, Any]] = []
    for index, item in enumerate(_sequence(raw, "gen_size.opponents")):
        if isinstance(item, str):
            if item == "random":
                opponents.append({"id": item, "agent_kind": "random", "config": {}})
            elif item in {"uct_mcts_16", "mcts_16", "uct-16"}:
                opponents.append(
                    {
                        "id": "uct_mcts_16",
                        "agent_kind": "mcts",
                        "config": {
                            "simulations": 16,
                            "rollout_depth": 80,
                            "exploration": 2.0**0.5,
                        },
                    }
                )
            else:
                raise ProtocolError(f"unknown GEN-SIZE opponent {item!r}")
            continue
        entry = dict(_mapping(item, f"gen_size.opponents[{index}]"))
        identifier = str(_first(entry, ("id", "opponent_id", "name"), ""))
        kind = str(_first(entry, ("agent_kind", "kind"), ""))
        config = dict(_mapping(entry.get("config", {}), "opponent config"))
        if identifier == "random":
            if kind not in {"", "random"} or config:
                raise ProtocolError("Random opponent must use the frozen empty config")
            kind = "random"
        elif identifier in {"uct_mcts_16", "mcts_16", "uct-16"}:
            identifier = "uct_mcts_16"
            if kind not in {"", "mcts"}:
                raise ProtocolError("UCT-MCTS-16 opponent must use agent_kind=mcts")
            kind = "mcts"
            config = {
                "simulations": int(config.get("simulations", 16)),
                "rollout_depth": int(config.get("rollout_depth", 80)),
                "exploration": float(config.get("exploration", 2.0**0.5)),
            }
            if config["simulations"] != 16:
                raise ProtocolError("UCT-MCTS-16 simulations must equal 16")
        else:
            raise ProtocolError(f"unknown GEN-SIZE opponent id {identifier!r}")
        opponents.append({"id": identifier, "agent_kind": kind, "config": config})
    if {item["id"] for item in opponents} != {"random", "uct_mcts_16"}:
        raise ProtocolError("GEN-SIZE opponents must be exactly Random and UCT-MCTS-16")
    return opponents


def _policy_seed_blocks(arm: Mapping[str, Any], *, expected: int = 16) -> list[dict[str, int | str]]:
    raw = _first(arm, ("policy_seed_blocks", "policy_seeds", "policy_seed_plan"))
    blocks: list[dict[str, int | str]] = []
    if isinstance(raw, Mapping):
        raw_mapping = raw
        raw = _first(raw_mapping, ("blocks", "values", "seeds"))
        if raw is None:
            count = int(_first(raw_mapping, ("count", "blocks_count"), expected))
            base = int(_first(raw_mapping, ("base_seed", "seed"), 2026082900))
            raw = [base + index for index in range(count)]
    if raw is None:
        derivation = _mapping(arm.get("policy_seed_derivation", {}), "policy seed derivation")
        count = int(_first(derivation, ("count", "blocks"), expected))
        base = int(_first(derivation, ("base_seed", "seed"), 2026082900))
        raw = [base + index for index in range(count)]
    for index, item in enumerate(_sequence(raw, "policy seed blocks")):
        if isinstance(item, Mapping):
            first = _first(item, ("policy_seed_a", "seed_a", "seed_low", "a"))
            second = _first(item, ("policy_seed_b", "seed_b", "seed_high", "b"))
            if first is None or second is None:
                seed = _first(item, ("seed", "base_seed"))
                if seed is None:
                    raise ProtocolError(f"policy seed block {index} lacks two seeds")
                first, second = int(seed) * 2 + 1, int(seed) * 2 + 2
            block_id = str(
                _first(
                    item,
                    ("block_id", "policy_seed_block", "cluster_id", "id"),
                    f"ps{index:02d}",
                )
            )
        elif isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)):
            if len(item) != 2:
                raise ProtocolError("policy seed pair must contain exactly two integers")
            first, second = int(item[0]), int(item[1])
            block_id = f"ps{index:02d}"
        else:
            seed = int(item)
            first, second = seed * 2 + 1, seed * 2 + 2
            block_id = f"ps{index:02d}"
        blocks.append(
            {
                "block_id": block_id,
                "seed_a": _non_negative_int(int(first), f"policy block {index}.seed_a"),
                "seed_b": _non_negative_int(int(second), f"policy block {index}.seed_b"),
            }
        )
    if len(blocks) != expected:
        raise ProtocolError(f"policy seed plan must contain exactly {expected} blocks")
    ids = [str(item["block_id"]) for item in blocks]
    if len(ids) != len(set(ids)):
        raise ProtocolError("policy seed block ids must be unique")
    return blocks


def _model_pairs(d16_v2: Mapping[str, Any]) -> list[tuple[str, str]]:
    raw = _first(d16_v2, ("model_pairs", "representation_pairs"))
    if raw is None:
        raw = [
            ["padded_cnn", "grid_gnn"],
            ["padded_cnn", "topology_gnn"],
            ["grid_gnn", "topology_gnn"],
        ]
    pairs: list[tuple[str, str]] = []
    for index, item in enumerate(_sequence(raw, "d16_v2.model_pairs")):
        if isinstance(item, str):
            normalized = item.replace("-vs-", ":").replace("_vs_", ":").replace(" vs ", ":")
            parts = normalized.split(":")
        elif isinstance(item, Mapping):
            parts = [
                str(
                    _first(
                        item,
                        ("model_a", "agent_a_model_kind", "representation_a", "a"),
                        "",
                    )
                ),
                str(
                    _first(
                        item,
                        ("model_b", "agent_b_model_kind", "representation_b", "b"),
                        "",
                    )
                ),
            ]
        else:
            parts = [str(value) for value in _sequence(item, f"model pair {index}")]
        if len(parts) != 2 or parts[0] not in MODEL_KINDS or parts[1] not in MODEL_KINDS:
            raise ProtocolError(f"invalid D16-v2 model pair at index {index}")
        if parts[0] == parts[1]:
            raise ProtocolError("D16-v2 model pairs must contain distinct models")
        pairs.append((parts[0], parts[1]))
    expected = {tuple(sorted(pair)) for pair in ((MODEL_KINDS[0], MODEL_KINDS[1]), (MODEL_KINDS[0], MODEL_KINDS[2]), (MODEL_KINDS[1], MODEL_KINDS[2]))}
    if {tuple(sorted(pair)) for pair in pairs} != expected or len(pairs) != 3:
        raise ProtocolError("D16-v2 must contain all three representation pairs exactly once")
    return pairs


def _d16_policy_blocks_by_opening(
    d16_v2: Mapping[str, Any], openings: Sequence[Mapping[str, Any]]
) -> dict[str, dict[str, int | str]]:
    """Bind the two frozen slot seeds to each materialized opening."""

    raw = _first(d16_v2, ("policy_seed_plan_by_opening",))
    if raw is None:
        compact = _policy_seed_blocks(d16_v2, expected=16)
        return {
            str(opening["opening_id"]): dict(compact[index % len(compact)])
            for index, opening in enumerate(openings)
        }
    result: dict[str, dict[str, int | str]] = {}
    for index, item in enumerate(
        _sequence(raw, "d16_v2.policy_seed_plan_by_opening")
    ):
        entry = _mapping(item, f"d16_v2.policy_seed_plan_by_opening[{index}]")
        opening_id = str(_first(entry, ("opening_id", "id"), ""))
        cluster_id = str(
            _first(entry, ("cluster_id", "opening_cluster"), opening_id)
        )
        first = _first(entry, ("seed_low", "seed_a", "policy_seed_a"))
        second = _first(entry, ("seed_high", "seed_b", "policy_seed_b"))
        if not opening_id or first is None or second is None:
            raise ProtocolError("D16-v2 opening policy plan entry is incomplete")
        assignments = _first(entry, ("assignments",))
        if assignments is not None:
            declared = [
                (
                    int(_first(_mapping(value, "policy assignment"), ("agent_a_seed", "policy_seed_a"))),
                    int(_first(_mapping(value, "policy assignment"), ("agent_b_seed", "policy_seed_b"))),
                )
                for value in _sequence(assignments, "policy assignments")
            ]
            if declared != [(int(first), int(second)), (int(second), int(first))]:
                raise ProtocolError(
                    f"D16-v2 opening {opening_id} policy assignments are not crossed"
                )
        if opening_id in result:
            raise ProtocolError("D16-v2 policy plan contains duplicate opening ids")
        result[opening_id] = {
            "block_id": cluster_id,
            "seed_a": _non_negative_int(int(first), "D16-v2 seed_low"),
            "seed_b": _non_negative_int(int(second), "D16-v2 seed_high"),
        }
    opening_ids = {str(opening["opening_id"]) for opening in openings}
    if set(result) != opening_ids:
        missing = sorted(opening_ids - set(result))[:5]
        extra = sorted(set(result) - opening_ids)[:5]
        raise ProtocolError(
            f"D16-v2 policy/opening ids disagree; missing={missing}, extra={extra}"
        )
    return result


def validate_manifest(
    manifest: Mapping[str, Any], *, manifest_path: str | Path | None = None
) -> dict[str, Any]:
    """Validate hard P0 invariants without asserting that any task has run."""

    if manifest.get("schema_name") != SCHEMA_NAME:
        raise ProtocolError(f"schema_name must be {SCHEMA_NAME!r}")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ProtocolError(f"schema_version must be {SCHEMA_VERSION}")
    if manifest.get("experiment_id") != BUNDLE_EXPERIMENT_ID:
        raise ProtocolError(f"experiment_id must be {BUNDLE_EXPERIMENT_ID!r}")
    status = manifest.get("status")
    if status not in {"frozen_not_run", "frozen"}:
        raise ProtocolError("formal manifest status must be frozen_not_run or frozen")

    protocol_path = manifest.get("protocol_path")
    protocol_sha256 = manifest.get("protocol_sha256")
    if not isinstance(protocol_path, str) or not protocol_path:
        raise ProtocolError("protocol_path must identify the frozen D17--D19 protocol")
    _sha(protocol_sha256, "protocol_sha256")
    source_hashes = _mapping(manifest.get("source_hashes"), "source_hashes")
    if source_hashes.get(protocol_path) != protocol_sha256:
        raise ProtocolError("source_hashes must bind protocol_path to protocol_sha256")
    for source_path, digest in source_hashes.items():
        if not isinstance(source_path, str) or not source_path:
            raise ProtocolError("source_hashes paths must be non-empty strings")
        _sha(digest, f"source_hashes[{source_path!r}]")
    if manifest_path is not None:
        resolved_protocol = resolve_manifest_path(
            protocol_path, manifest_path=manifest_path
        )
        if not resolved_protocol.is_file():
            raise ProtocolError(f"frozen protocol is missing: {resolved_protocol}")
        if sha256_file(resolved_protocol) != protocol_sha256:
            raise ProtocolError("frozen D17--D19 protocol SHA-256 mismatch")

    dry_run = _mapping(manifest.get("dry_run"), "dry_run")
    if (
        dry_run.get("exact_checkpoint_binding_checks") != 15
        or dry_run.get("gen_size_model_size_cells") != 20
        or dry_run.get("gen_size_state_fixtures_per_cell") != 3
        or dry_run.get("gen_size_forward_checks") != 60
        or dry_run.get("d16_v2_model_size_cells") != 45
        or dry_run.get("d16_v2_opening_fixtures_per_cell") != 3
        or dry_run.get("d16_v2_opening_fixture_cluster_indices") != [0, 15, 31]
        or dry_run.get("d16_v2_forward_checks") != 135
        or dry_run.get("total_forward_checks") != 195
    ):
        raise ProtocolError("dry-run matrix must freeze 65 cells and 195 fixture checks")
    gen_fixtures = _sequence(
        dry_run.get("gen_size_state_fixtures"),
        "dry_run.gen_size_state_fixtures",
    )
    if len(gen_fixtures) != 6:
        raise ProtocolError("GEN-SIZE dry-run must freeze six explicit state fixtures")
    fixture_ids: set[str] = set()
    fixtures_per_size = {10: 0, 12: 0}
    for index, raw_fixture in enumerate(gen_fixtures):
        fixture = _mapping(raw_fixture, f"dry_run.gen_size_state_fixtures[{index}]")
        fixture_id = str(fixture.get("fixture_id", ""))
        size = fixture.get("eval_size")
        actions = _sequence(
            fixture.get("opening_actions"),
            f"dry_run.gen_size_state_fixtures[{index}].opening_actions",
        )
        if not fixture_id or fixture_id in fixture_ids:
            raise ProtocolError("GEN-SIZE dry-run fixture IDs must be unique")
        if size not in fixtures_per_size:
            raise ProtocolError("GEN-SIZE dry-run fixtures must use n=10 or n=12")
        if any(isinstance(action, bool) or not isinstance(action, int) or action < 0 for action in actions):
            raise ProtocolError("GEN-SIZE dry-run actions must be non-negative integers")
        if opening_prefix_hash(actions) != fixture.get("opening_prefix_hash"):
            raise ProtocolError("GEN-SIZE dry-run fixture prefix SHA-256 mismatch")
        _sha(fixture.get("opening_state_hash"), "GEN-SIZE fixture state hash")
        fixture_ids.add(fixture_id)
        fixtures_per_size[int(size)] += 1
    if fixtures_per_size != {10: 3, 12: 3}:
        raise ProtocolError("GEN-SIZE dry-run must freeze three fixtures for each target size")

    checkpoints = _checkpoint_entries(manifest)
    if len(checkpoints) != 15:
        raise ProtocolError("exactly 15 frozen D14--D16 final checkpoints are required")
    identities: set[tuple[str, int]] = set()
    ids: set[str] = set()
    for index, checkpoint in enumerate(checkpoints):
        label = f"checkpoints[{index}]"
        checkpoint_id = str(checkpoint.get("checkpoint_id", ""))
        model_kind = str(checkpoint.get("model_kind", ""))
        training_seed = checkpoint.get("training_seed")
        if not checkpoint_id:
            raise ProtocolError(f"{label}.checkpoint_id must be non-empty")
        if model_kind not in MODEL_KINDS:
            raise ProtocolError(f"{label}.model_kind is invalid")
        if training_seed not in TRAINING_SEEDS:
            raise ProtocolError(f"{label}.training_seed is not a frozen training seed")
        if tuple(checkpoint.get("trained_board_sizes", ())) != TRAINED_SIZES:
            raise ProtocolError(f"{label}.trained_board_sizes must be [5, 7, 9]")
        if checkpoint.get("gradient_steps") != 200:
            raise ProtocolError(f"{label}.gradient_steps must equal final step 200")
        _sha(checkpoint.get("sha256"), f"{label}.sha256")
        _sha(checkpoint.get("config_hash"), f"{label}.config_hash")
        _sha(checkpoint.get("config_file_sha256"), f"{label}.config_file_sha256")
        _sha(checkpoint.get("source_hash"), f"{label}.source_hash")
        _sha(checkpoint.get("source_receipt_sha256"), f"{label}.source_receipt_sha256")
        if not isinstance(checkpoint.get("path"), str) or not checkpoint["path"]:
            raise ProtocolError(f"{label}.path must be non-empty")
        if not isinstance(checkpoint.get("config_path"), str) or not checkpoint["config_path"]:
            raise ProtocolError(f"{label}.config_path must be non-empty")
        if not isinstance(checkpoint.get("source_receipt_path"), str) or not checkpoint[
            "source_receipt_path"
        ]:
            raise ProtocolError(f"{label}.source_receipt_path must be non-empty")
        identity = (model_kind, int(training_seed))
        if checkpoint_id in ids or identity in identities:
            raise ProtocolError("checkpoint ids and model_kind/training_seed keys must be unique")
        ids.add(checkpoint_id)
        identities.add(identity)
    if identities != {(model, seed) for model in MODEL_KINDS for seed in TRAINING_SEEDS}:
        raise ProtocolError("checkpoint matrix must cover three models by five training seeds")

    gen_size = _arm(manifest, "gen_size")
    _arm_experiment_id(gen_size, GEN_SIZE_EXPERIMENT_ID, "gen_size")
    if gen_size.get("enabled", True) is not True:
        raise ProtocolError("GEN-SIZE P0 arm must be enabled")
    if _model_kinds(gen_size, GEN_MODEL_KINDS) != GEN_MODEL_KINDS:
        raise ProtocolError("GEN-SIZE must use Grid-GNN and Topology-GNN only")
    if _eval_sizes(gen_size, GEN_EVAL_SIZES) != GEN_EVAL_SIZES:
        raise ProtocolError("GEN-SIZE eval sizes must be exactly [10, 12]")
    _opponents(gen_size)
    _policy_seed_blocks(gen_size, expected=16)
    if int(_first(gen_size, ("games_per_task", "games_per_cell"), 64)) != 64:
        raise ProtocolError("GEN-SIZE must schedule exactly 64 games per task")
    if int(_first(gen_size, ("max_plies",), 256)) != 256:
        raise ProtocolError("GEN-SIZE max_plies must equal 256")
    if int(
        _first(
            gen_size,
            (
                "min_unique_trajectories_per_task",
                "minimum_unique_trajectories_per_task",
                "min_unique_trajectories",
            ),
            48,
        )
    ) != 48:
        raise ProtocolError("GEN-SIZE unique-trajectory gate must equal 48 per task")
    if gen_size.get("fine_tune", gen_size.get("finetune", False)) not in {False, None}:
        raise ProtocolError("GEN-SIZE forbids fine-tuning")

    d16_v2 = _arm(manifest, "d16_v2")
    _arm_experiment_id(d16_v2, D16_V2_EXPERIMENT_ID, "d16_v2")
    if _first(d16_v2, ("experiment_arm", "arm", "name"), D16_V2_ARM) != D16_V2_ARM:
        raise ProtocolError("D16-v2 arm must be named exactly 'd16-v2'")
    if d16_v2.get("enabled", True) is not True:
        raise ProtocolError("D16-v2 P0 arm must be enabled")
    if _eval_sizes(d16_v2, D16_V2_EVAL_SIZES) != D16_V2_EVAL_SIZES:
        raise ProtocolError("D16-v2 sizes must be exactly [5, 7, 9]")
    _model_pairs(d16_v2)
    d16_policy_plan = _first(d16_v2, ("policy_seed_plan_by_opening",))
    if d16_policy_plan is None:
        # A compact 16-block plan is accepted for generated manifests; the
        # frozen protocol uses a stronger explicit 96-opening plan.
        _policy_seed_blocks(d16_v2, expected=16)
    elif len(_sequence(d16_policy_plan, "d16_v2.policy_seed_plan_by_opening")) != 96:
        raise ProtocolError("D16-v2 explicit policy seed plan must contain 96 openings")
    if int(_first(d16_v2, ("games_per_task", "games_per_cell"), 128)) != 128:
        raise ProtocolError("D16-v2 must schedule exactly 128 games per task")
    if int(_first(d16_v2, ("opening_clusters_per_task", "opening_clusters_per_size"), 32)) != 32:
        raise ProtocolError("D16-v2 must use exactly 32 opening clusters per task")
    if int(
        _first(
            d16_v2,
            (
                "min_unique_trajectories_per_task",
                "minimum_unique_full_trajectories_per_task",
                "min_unique_full_trajectories",
            ),
            64,
        )
    ) != 64:
        raise ProtocolError("D16-v2 full-trajectory gate must equal 64 per task")
    if int(
        _first(
            d16_v2,
            (
                "min_unique_continuations_per_task",
                "minimum_unique_continuations_per_task",
                "min_prefix_stripped_trajectories",
            ),
            32,
        )
    ) != 32:
        raise ProtocolError("D16-v2 continuation-trajectory gate must equal 32 per task")
    if int(
        _first(
            d16_v2,
            (
                "min_diverse_opening_clusters",
                "minimum_clusters_with_two_unique_continuations_per_task",
                "min_clusters_with_two_continuations",
            ),
            24,
        )
    ) != 24:
        raise ProtocolError("D16-v2 cluster diversity gate must equal 24 of 32")

    p1 = _arm(manifest, "p1")
    _arm_experiment_id(p1, P1_EXPERIMENT_ID, "p1")
    if _first(p1, ("default_enabled", "enabled"), False) is not False:
        raise ProtocolError("P1 architecture smoke must be disabled by default")
    forbidden = {"ppo", "a2c", "dqn", "trpo"}
    algorithms = {
        str(item).lower()
        for item in _sequence(
            _first(
                p1,
                ("forbidden_algorithms", "prohibited_algorithms"),
                sorted(forbidden),
            ),
            "p1.prohibited_algorithms",
        )
    }
    if not forbidden.issubset(algorithms):
        raise ProtocolError("P1 gate must explicitly forbid PPO/A2C/DQN/TRPO")

    if manifest_path is not None:
        # Resolve here only to detect malformed path types.  File/hash checks are
        # intentionally part of exact dry-run, not schema loading.
        for checkpoint in checkpoints:
            resolve_manifest_path(checkpoint["path"], manifest_path=manifest_path)
            resolve_manifest_path(checkpoint["config_path"], manifest_path=manifest_path)
            resolve_manifest_path(
                checkpoint["source_receipt_path"], manifest_path=manifest_path
            )

    return {
        "experiment_id": BUNDLE_EXPERIMENT_ID,
        "checkpoints": len(checkpoints),
        "gen_size_tasks": 40,
        "d16_v2_tasks": 45,
        "formal_tasks": 85,
        "formal_games": 8320,
        "p1_enabled": False,
    }


def _opening_entries_from_manifest(d16_v2: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = _first(d16_v2, ("opening_prefixes", "openings", "opening_manifest"))
    if raw is None:
        return []
    entries: list[dict[str, Any]] = []
    if isinstance(raw, Mapping):
        if "path" in raw:
            path = resolve_manifest_path(
                str(raw["path"]),
                manifest_path=RESEARCH_ROOT / "configs" / "d17_d19_formal_manifest.json",
            )
            if not path.is_file():
                raise ProtocolError(f"referenced opening manifest is missing: {path}")
            expected_sha = _sha(raw.get("sha256"), "d16_v2.opening_manifest.sha256")
            if sha256_file(path) != expected_sha:
                raise ProtocolError("referenced opening manifest SHA-256 mismatch")
            payload = _read_json(path)
            expected_schema = raw.get(
                "schema_name", "lifeline-d17-d19-openings-manifest"
            )
            if payload.get("schema_name") != expected_schema or payload.get(
                "schema_version"
            ) != 1:
                raise ProtocolError("referenced opening manifest schema mismatch")
            raw_entries = _sequence(payload.get("openings"), "opening manifest.openings")
            declared_count = int(raw.get("cluster_count", len(raw_entries)))
            if len(raw_entries) != declared_count:
                raise ProtocolError("referenced opening manifest count mismatch")
            return [dict(_mapping(item, "opening manifest entry")) for item in raw_entries]
        for raw_size, values in raw.items():
            for value in _sequence(values, f"opening prefixes n{raw_size}"):
                entry = dict(_mapping(value, "opening prefix"))
                entry.setdefault("eval_size", int(raw_size))
                entries.append(entry)
    else:
        entries = [dict(_mapping(item, "opening prefix")) for item in _sequence(raw, "opening prefixes")]
    return entries


def _generation_config(d16_v2: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(
        _first(d16_v2, ("opening_generation", "opening_distribution", "opening_sampler"), {}),
        "d16_v2 opening generation",
    )


def _derived_seed(namespace: str, *, size: int, plies: int, index: int) -> int:
    payload = f"{namespace}|n={size}|plies={plies}|index={index}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") & ((1 << 63) - 1)


def _apply_action_index(game: Any, action_index: int) -> None:
    if action_index == game.num_points:
        result = game.skip_turn()
    elif 0 <= action_index < game.num_points:
        result = game.play_move(game.valid_positions[action_index])
    else:
        raise ProtocolError(f"opening action index {action_index} is outside the action space")
    if not result.success:
        raise ProtocolError(f"opening action {action_index} is illegal: {result.reason}")


def _normalise_opening(entry: Mapping[str, Any], *, expected_size: int | None = None) -> dict[str, Any]:
    from lifeline_rl import LifelineGame

    size = int(_first(entry, ("eval_size", "grid_size", "size"), expected_size))
    if expected_size is not None and size != expected_size:
        raise ProtocolError("opening prefix size does not match its registry key")
    cluster = str(_first(entry, ("opening_cluster", "cluster_id", "cluster"), ""))
    opening_id = str(_first(entry, ("opening_id", "id"), cluster))
    seed = int(_first(entry, ("opening_seed", "seed"), 0))
    actions_raw = _first(
        entry, ("opening_actions", "prefix_actions", "action_prefix", "actions")
    )
    actions = [int(value) for value in _sequence(actions_raw, f"opening {opening_id}.actions")]
    if not cluster or not opening_id:
        raise ProtocolError("opening_cluster and opening_id must be non-empty")
    game = LifelineGame(size, superko_mode="enforce")
    for action in actions:
        if game.game_over:
            raise ProtocolError(f"opening {opening_id} becomes terminal before its prefix ends")
        _apply_action_index(game, action)
    if game.game_over:
        raise ProtocolError(f"opening {opening_id} is terminal and cannot seed an evaluation")
    observed_prefix_hash = opening_prefix_hash(actions)
    observed_state_hash = opening_state_hash(game)
    declared_prefix_hash = _first(entry, ("opening_prefix_hash", "prefix_hash"))
    declared_state_hash = _first(entry, ("opening_state_hash", "state_hash"))
    if declared_prefix_hash is not None and declared_prefix_hash != observed_prefix_hash:
        raise ProtocolError(f"opening {opening_id} prefix hash mismatch")
    if declared_state_hash is not None and declared_state_hash != observed_state_hash:
        raise ProtocolError(f"opening {opening_id} state hash mismatch")
    return {
        "eval_size": size,
        "opening_cluster": cluster,
        "opening_id": opening_id,
        "opening_seed": seed,
        "opening_actions": actions,
        "opening_prefix_hash": observed_prefix_hash,
        "opening_state_hash": observed_state_hash,
        "prefix_plies": len(actions),
        "opening_state": game.serialize_state(),
    }


def _sample_opening(
    *, size: int, target_plies: int, seed: int, opening_id: str, cluster: str, max_attempts: int
) -> dict[str, Any]:
    """Frozen SHA-derived rejection sampler using only legal point actions."""

    from lifeline_rl import LifelineGame

    rng = random.Random(seed)
    for _attempt in range(max_attempts):
        game = LifelineGame(size, superko_mode="enforce")
        actions: list[int] = []
        rejected = False
        for _ply in range(target_plies):
            if game.game_over:
                rejected = True
                break
            legal = [game.point_to_index[point] for point in game.legal_moves()]
            if not legal:
                rejected = True
                break
            action = legal[rng.randrange(len(legal))]
            _apply_action_index(game, action)
            actions.append(action)
        if rejected or game.game_over or len(actions) != target_plies:
            continue
        return _normalise_opening(
            {
                "eval_size": size,
                "opening_cluster": cluster,
                "opening_id": opening_id,
                "opening_seed": seed,
                "opening_actions": actions,
            }
        )
    raise ProtocolError(
        f"rejection sampler exhausted {max_attempts} attempts for {opening_id}"
    )


def materialize_openings(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the exact 96-prefix D16-v2 registry used by every model pair."""

    validate_manifest(manifest)
    d16_v2 = _arm(manifest, "d16_v2")
    explicit = _opening_entries_from_manifest(d16_v2)
    if explicit:
        openings = [_normalise_opening(entry) for entry in explicit]
    else:
        config = _generation_config(d16_v2)
        lengths = tuple(
            int(value)
            for value in _sequence(
                _first(config, ("prefix_target_plies", "prefix_plies", "prefix_lengths"), [2, 4, 6, 8]),
                "opening prefix target plies",
            )
        )
        if lengths != (2, 4, 6, 8):
            raise ProtocolError("D16-v2 prefix target plies must be [2, 4, 6, 8]")
        per_length = int(_first(config, ("clusters_per_prefix_length", "clusters_per_length"), 8))
        if per_length != 8:
            raise ProtocolError("D16-v2 requires 8 clusters at each prefix length")
        namespace = str(
            _first(
                config,
                ("seed_namespace", "namespace", "sampler_seed"),
                "d18_d16_v2_openings_sha256_v1",
            )
        )
        max_attempts = int(_first(config, ("max_rejection_attempts", "max_attempts"), 10000))
        explicit_seeds = _first(config, ("cluster_seeds", "opening_seeds"))
        seed_map: dict[tuple[int, int, int], int] = {}
        if explicit_seeds is not None:
            for item in _sequence(explicit_seeds, "opening cluster seeds"):
                data = _mapping(item, "opening cluster seed")
                key = (
                    int(_first(data, ("eval_size", "size"))),
                    int(_first(data, ("prefix_plies", "target_plies"))),
                    int(_first(data, ("cluster_index", "index"))),
                )
                seed_map[key] = int(_first(data, ("opening_seed", "seed")))
        openings = []
        for size in D16_V2_EVAL_SIZES:
            for target in lengths:
                for index in range(per_length):
                    seed = seed_map.get(
                        (size, target, index),
                        _derived_seed(namespace, size=size, plies=target, index=index),
                    )
                    cluster = f"n{size}.p{target}.c{index:02d}"
                    openings.append(
                        _sample_opening(
                            size=size,
                            target_plies=target,
                            seed=seed,
                            opening_id=cluster,
                            cluster=cluster,
                            max_attempts=max_attempts,
                        )
                    )
    if len(openings) != 96:
        raise ProtocolError("D16-v2 opening registry must contain 32 clusters for each of 3 sizes")
    by_size: dict[int, list[dict[str, Any]]] = {size: [] for size in D16_V2_EVAL_SIZES}
    for opening in openings:
        size = int(opening["eval_size"])
        if size not in by_size:
            raise ProtocolError(f"opening registry contains unexpected size {size}")
        by_size[size].append(opening)
    for size, entries in by_size.items():
        if len(entries) != 32:
            raise ProtocolError(f"D16-v2 size {size} must have exactly 32 opening clusters")
        clusters = [entry["opening_cluster"] for entry in entries]
        ids = [entry["opening_id"] for entry in entries]
        prefix_hashes = [entry["opening_prefix_hash"] for entry in entries]
        state_hashes = [entry["opening_state_hash"] for entry in entries]
        if any(len(values) != len(set(values)) for values in (clusters, ids, prefix_hashes, state_hashes)):
            raise ProtocolError(f"D16-v2 size {size} opening clusters/states must be unique")
        lengths = [int(entry["prefix_plies"]) for entry in entries]
        if {length: lengths.count(length) for length in set(lengths)} != {2: 8, 4: 8, 6: 8, 8: 8}:
            raise ProtocolError(f"D16-v2 size {size} opening length distribution is not 8x[2,4,6,8]")
    return sorted(
        openings,
        key=lambda item: (int(item["eval_size"]), int(item["prefix_plies"]), str(item["opening_id"])),
    )


def materialize_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Create the immutable derived manifest with explicit legal openings."""

    validate_manifest(manifest)
    materialized = copy.deepcopy(dict(manifest))
    d16_v2 = dict(_arm(materialized, "d16_v2"))
    d16_v2["opening_prefixes"] = materialize_openings(manifest)
    # A derived manifest never carries an executable sampler ambiguity.
    d16_v2.pop("openings", None)
    d16_v2.pop("opening_manifest", None)
    materialized["d16_v2"] = d16_v2
    materialized["materialized_schema"] = {
        "name": MATERIALIZED_SCHEMA_NAME,
        "version": SCHEMA_VERSION,
        "source_manifest_sha256": manifest_hash(manifest),
    }
    return materialized


def _checkpoint_index(manifest: Mapping[str, Any]) -> dict[tuple[str, int], dict[str, Any]]:
    return {
        (str(item["model_kind"]), int(item["training_seed"])): item
        for item in _checkpoint_entries(manifest)
    }


def _checkpoint_binding(checkpoint: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "checkpoint_id": checkpoint["checkpoint_id"],
        "model_kind": checkpoint["model_kind"],
        "training_seed": checkpoint["training_seed"],
        "trained_board_sizes": checkpoint["trained_board_sizes"],
        "gradient_steps": checkpoint["gradient_steps"],
        "path": checkpoint["path"],
        "sha256": checkpoint["sha256"],
        "config_path": checkpoint["config_path"],
        "config_hash": checkpoint["config_hash"],
        "config_file_sha256": checkpoint["config_file_sha256"],
        "source_hash": checkpoint["source_hash"],
        "source_receipt_path": checkpoint["source_receipt_path"],
        "source_receipt_sha256": checkpoint["source_receipt_sha256"],
    }


def _standard_opening(size: int) -> dict[str, Any]:
    from lifeline_rl import LifelineGame

    game = LifelineGame(size, superko_mode="enforce")
    actions: list[int] = []
    return {
        "eval_size": size,
        "opening_cluster": f"n{size}.standard_start",
        "opening_id": f"n{size}.standard_start",
        "opening_seed": 0,
        "opening_actions": actions,
        "opening_prefix_hash": opening_prefix_hash(actions),
        "opening_state_hash": opening_state_hash(game),
        "prefix_plies": 0,
        "opening_state": game.serialize_state(),
    }


def _pair_plan(
    *,
    task_id: str,
    openings: Sequence[Mapping[str, Any]],
    policy_blocks: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Two crossed slot-seed assignments, each followed by an A/B color swap."""

    plan: list[dict[str, Any]] = []
    # GEN-SIZE uses one standard opening and all 16 seed blocks.  D16-v2 uses
    # 32 openings and the matching-index seed block, giving two pairs/cluster.
    if len(openings) == 1:
        opening_blocks = [(openings[0], block) for block in policy_blocks]
    elif len(openings) == len(policy_blocks):
        opening_blocks = list(zip(openings, policy_blocks))
    elif len(openings) == len(policy_blocks) * 2:
        opening_blocks = [
            (opening, policy_blocks[index % len(policy_blocks)])
            for index, opening in enumerate(openings)
        ]
    else:
        raise ProtocolError("opening/policy schedule cannot form the frozen crossed plan")
    pair_index = 0
    for opening, block in opening_blocks:
        seed_a = int(block["seed_a"])
        seed_b = int(block["seed_b"])
        for assignment, (policy_a, policy_b) in enumerate(((seed_a, seed_b), (seed_b, seed_a))):
            pair_id = f"{opening['opening_id']}.{block['block_id']}.x{assignment}"
            game_plan: list[dict[str, Any]] = []
            for color_swap in (0, 1):
                game_index = pair_index * 2 + color_swap
                black_slot, white_slot = (
                    ("A", "B") if color_swap == 0 else ("B", "A")
                )
                black_policy_seed = policy_a if black_slot == "A" else policy_b
                white_policy_seed = policy_a if white_slot == "A" else policy_b
                game_plan.append(
                    {
                        "task_id": task_id,
                        "game_id": f"{task_id}.g{game_index:04d}",
                        "game_index": game_index,
                        "pair_id": pair_id,
                        "pair_index": pair_index,
                        "pair_member": color_swap,
                        "pair_color_orientation": color_swap,
                        "color_swap": color_swap,
                        "black_slot": black_slot,
                        "white_slot": white_slot,
                        "policy_seed_block": block["block_id"],
                        "policy_seed_a": policy_a,
                        "policy_seed_b": policy_b,
                        "policy_seed_assignment": assignment,
                        "black_policy_seed": black_policy_seed,
                        "white_policy_seed": white_policy_seed,
                    }
                )
            plan.append(
                {
                    "pair_index": pair_index,
                    "pair_id": pair_id,
                    "opening_cluster": opening["opening_cluster"],
                    "opening_id": opening["opening_id"],
                    "opening_seed": opening["opening_seed"],
                    "opening_actions": list(opening["opening_actions"]),
                    "opening_prefix_hash": opening["opening_prefix_hash"],
                    "opening_state_hash": opening["opening_state_hash"],
                    "prefix_plies": opening["prefix_plies"],
                    "policy_seed_block": block["block_id"],
                    "policy_seed_a": policy_a,
                    "policy_seed_b": policy_b,
                    "policy_seed_assignment": assignment,
                    "color_swaps": [0, 1],
                    "game_ids": [game["game_id"] for game in game_plan],
                    "game_plan": game_plan,
                    "games": 2,
                }
            )
            pair_index += 1
    return plan


def generate_tasks(materialized_manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Expand exactly 40 GEN-SIZE and 45 D16-v2 task cells."""

    validate_manifest(materialized_manifest)
    source_manifest_sha = _mapping(
        materialized_manifest.get("materialized_schema"), "materialized_schema"
    ).get("source_manifest_sha256")
    _sha(source_manifest_sha, "materialized source manifest hash")
    materialized_sha = manifest_hash(materialized_manifest)
    checkpoint_index = _checkpoint_index(materialized_manifest)
    source_hashes = dict(_mapping(materialized_manifest.get("source_hashes", {}), "source_hashes"))
    runner_sha256 = sha256_file(RUNNER_PATH)
    _sha(runner_sha256, "current D17--D19 runner hash")
    evidence_tier = str(materialized_manifest.get("evidence_tier", "formal"))
    if evidence_tier != "formal":
        raise ProtocolError("D17--D18 task bundle must use evidence_tier=formal")

    common = {
        "schema_name": TASK_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "bundle_experiment_id": BUNDLE_EXPERIMENT_ID,
        "evidence_tier": evidence_tier,
        "manifest_sha256": source_manifest_sha,
        "materialized_manifest_sha256": materialized_sha,
        "protocol_sha256": materialized_manifest["protocol_sha256"],
        "runner_sha256": runner_sha256,
        "source_hashes": source_hashes,
        "superko_mode": "enforce",
        "max_plies": 256,
    }
    tasks: list[dict[str, Any]] = []

    gen_size = _arm(materialized_manifest, "gen_size")
    gen_blocks = _policy_seed_blocks(gen_size, expected=16)
    for model_kind in GEN_MODEL_KINDS:
        for training_seed in TRAINING_SEEDS:
            checkpoint = checkpoint_index[(model_kind, training_seed)]
            binding = _checkpoint_binding(checkpoint)
            for size in GEN_EVAL_SIZES:
                standard = _standard_opening(size)
                for opponent in _opponents(gen_size):
                    task_id = (
                        f"d17.gen_size.n{size}.{model_kind}.seed{training_seed}."
                        f"vs.{opponent['id']}"
                    )
                    pair_plan = _pair_plan(
                        task_id=task_id,
                        openings=[standard],
                        policy_blocks=gen_blocks,
                    )
                    tasks.append(
                        {
                            **common,
                            "task_id": task_id,
                            "experiment_id": GEN_SIZE_EXPERIMENT_ID,
                            "experiment_arm": "GEN-SIZE",
                            "evaluation_kind": "gen_size",
                            "inference_group_id": (
                                f"gen_size.{model_kind}.n{size}.vs.{opponent['id']}"
                            ),
                            "training_seed": training_seed,
                            "checkpoint_id": binding["checkpoint_id"],
                            "checkpoint_sha256": binding["sha256"],
                            "config_hash": binding["config_hash"],
                            "source_hash": binding["source_hash"],
                            "eval_size": size,
                            "opponent": opponent["id"],
                            "model_pair": None,
                            "agent_specs": {
                                "A": {"kind": "learned_checkpoint", **binding},
                                "B": {"kind": "search_baseline", **opponent},
                            },
                            "checkpoint_bindings": {"A": binding, "B": None},
                            "opening_cluster": standard["opening_cluster"],
                            "opening_id": standard["opening_id"],
                            "opening_actions": [],
                            "opening_prefix_hash": standard["opening_prefix_hash"],
                            "opening_state_hash": standard["opening_state_hash"],
                            "pair_plan": pair_plan,
                            "games": 64,
                            "color_balance": "paired_swap_same_opening_and_slot_policy_seeds",
                            "no_fine_tuning": True,
                            "formal_gates": {
                                "min_unique_trajectories": 48,
                                "max_truncated_games": 0,
                            },
                        }
                    )

    d16_v2 = _arm(materialized_manifest, "d16_v2")
    openings = [
        _normalise_opening(item)
        for item in _sequence(d16_v2.get("opening_prefixes"), "materialized D16-v2 openings")
    ]
    by_size = {
        size: [opening for opening in openings if int(opening["eval_size"]) == size]
        for size in D16_V2_EVAL_SIZES
    }
    d16_policy_by_opening = _d16_policy_blocks_by_opening(d16_v2, openings)
    for model_a, model_b in _model_pairs(d16_v2):
        for training_seed in TRAINING_SEEDS:
            binding_a = _checkpoint_binding(checkpoint_index[(model_a, training_seed)])
            binding_b = _checkpoint_binding(checkpoint_index[(model_b, training_seed)])
            for size in D16_V2_EVAL_SIZES:
                task_id = (
                    f"d18.d16-v2.n{size}.seed{training_seed}."
                    f"{model_a}.vs.{model_b}"
                )
                size_blocks = [
                    d16_policy_by_opening[str(opening["opening_id"])]
                    for opening in by_size[size]
                ]
                pair_plan = _pair_plan(
                    task_id=task_id,
                    openings=by_size[size],
                    policy_blocks=size_blocks,
                )
                tasks.append(
                    {
                        **common,
                        "task_id": task_id,
                            "experiment_id": D16_V2_EXPERIMENT_ID,
                            "experiment_arm": D16_V2_ARM,
                            "evaluation_kind": "d16_v2",
                            "inference_group_id": (
                                f"d16-v2.{model_a}_vs_{model_b}.n{size}"
                            ),
                        "training_seed": training_seed,
                        "checkpoint_id": [binding_a["checkpoint_id"], binding_b["checkpoint_id"]],
                        "checkpoint_sha256": [binding_a["sha256"], binding_b["sha256"]],
                        "config_hash": [binding_a["config_hash"], binding_b["config_hash"]],
                        "source_hash": [binding_a["source_hash"], binding_b["source_hash"]],
                        "eval_size": size,
                        "opponent": None,
                        "model_pair": [model_a, model_b],
                        "agent_specs": {
                            "A": {"kind": "learned_checkpoint", **binding_a},
                            "B": {"kind": "learned_checkpoint", **binding_b},
                        },
                        "checkpoint_bindings": {"A": binding_a, "B": binding_b},
                        "opening_cluster": "pair_plan:32_clusters",
                        "opening_id": "pair_plan:32_openings",
                        "opening_actions": [],
                        "opening_prefix_hash": None,
                        "opening_state_hash": None,
                        "pair_plan": pair_plan,
                        "games": 128,
                        "color_balance": "paired_swap_same_opening_and_slot_policy_seeds",
                        "formal_gates": {
                            "min_unique_trajectories": 64,
                            "min_unique_prefix_stripped_continuations": 32,
                            "min_clusters_with_two_continuations": 24,
                            "opening_clusters": 32,
                            "max_truncated_games": 0,
                        },
                    }
                )

    if len(tasks) != 85:
        raise ProtocolError(f"formal task expansion produced {len(tasks)} tasks, expected 85")
    ids = [task["task_id"] for task in tasks]
    if len(ids) != len(set(ids)):
        raise ProtocolError("formal task expansion produced duplicate task ids")
    if sum(int(task["games"]) for task in tasks) != 8320:
        raise ProtocolError("formal task expansion must contain exactly 8,320 games")
    return tasks


def generate_game_manifest(tasks: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Flatten task pair plans so every formal game's randomness is pre-bound."""

    games: list[dict[str, Any]] = []
    for task in tasks:
        task_game_index = 0
        plan = _sequence(task.get("pair_plan"), f"{task['task_id']}.pair_plan")
        for pair in plan:
            pair_data = _mapping(pair, "pair plan entry")
            pair_index = int(pair_data["pair_index"])
            if pair_index != task_game_index // 2:
                raise ProtocolError(f"{task['task_id']}: pair indices are not contiguous")
            game_plan = _sequence(
                pair_data.get("game_plan"), f"{task['task_id']}.pair_plan.game_plan"
            )
            game_ids = _sequence(
                pair_data.get("game_ids"), f"{task['task_id']}.pair_plan.game_ids"
            )
            if len(game_plan) != 2 or len(game_ids) != 2:
                raise ProtocolError(
                    f"{task['task_id']}: every pair must bind exactly two planned games"
                )
            for pair_member, raw_game_binding in enumerate(game_plan):
                game_binding = _mapping(raw_game_binding, "pair game binding")
                color_swap = pair_member
                black_slot, white_slot = (
                    ("A", "B") if color_swap == 0 else ("B", "A")
                )
                black_policy_seed = int(
                    pair_data["policy_seed_a"]
                    if black_slot == "A"
                    else pair_data["policy_seed_b"]
                )
                white_policy_seed = int(
                    pair_data["policy_seed_a"]
                    if white_slot == "A"
                    else pair_data["policy_seed_b"]
                )
                game_id = f"{task['task_id']}.g{task_game_index:04d}"
                expected_binding = {
                    "task_id": task["task_id"],
                    "game_id": game_id,
                    "game_index": task_game_index,
                    "pair_id": pair_data["pair_id"],
                    "pair_index": pair_index,
                    "pair_member": pair_member,
                    "pair_color_orientation": pair_member,
                    "color_swap": color_swap,
                    "black_slot": black_slot,
                    "white_slot": white_slot,
                    "policy_seed_block": pair_data["policy_seed_block"],
                    "policy_seed_a": pair_data["policy_seed_a"],
                    "policy_seed_b": pair_data["policy_seed_b"],
                    "policy_seed_assignment": pair_data["policy_seed_assignment"],
                    "black_policy_seed": black_policy_seed,
                    "white_policy_seed": white_policy_seed,
                }
                for field, expected in expected_binding.items():
                    if game_binding.get(field) != expected:
                        raise ProtocolError(
                            f"{task['task_id']}: pair-plan game binding mismatch for {field}"
                        )
                if game_ids[pair_member] != game_id:
                    raise ProtocolError(
                        f"{task['task_id']}: pair-plan game_ids disagree with game_plan"
                    )
                games.append(
                    {
                        "schema_name": GAME_MANIFEST_SCHEMA_NAME,
                        "schema_version": SCHEMA_VERSION,
                        "bundle_experiment_id": task["bundle_experiment_id"],
                        "experiment_id": task["experiment_id"],
                        "experiment_arm": task["experiment_arm"],
                        "evidence_tier": task["evidence_tier"],
                        "manifest_sha256": task["manifest_sha256"],
                        "materialized_manifest_sha256": task["materialized_manifest_sha256"],
                        "protocol_sha256": task["protocol_sha256"],
                        "runner_sha256": task["runner_sha256"],
                        "task_id": task["task_id"],
                        "evaluation_kind": task["evaluation_kind"],
                        "inference_group_id": task["inference_group_id"],
                        "game_id": game_binding["game_id"],
                        "game_index": game_binding["game_index"],
                        "pair_id": game_binding["pair_id"],
                        "pair_index": game_binding["pair_index"],
                        "pair_member": game_binding["pair_member"],
                        "pair_color_orientation": game_binding["pair_color_orientation"],
                        "color_swap": game_binding["color_swap"],
                        "black_slot": game_binding["black_slot"],
                        "white_slot": game_binding["white_slot"],
                        "training_seed": task["training_seed"],
                        "checkpoint_id": task["checkpoint_id"],
                        "checkpoint_sha256": task["checkpoint_sha256"],
                        "config_hash": task["config_hash"],
                        "source_hash": task["source_hash"],
                        "checkpoint_bindings": task["checkpoint_bindings"],
                        "eval_size": task["eval_size"],
                        "opponent": task["opponent"],
                        "model_pair": task["model_pair"],
                        "opening_cluster": pair_data["opening_cluster"],
                        "opening_id": pair_data["opening_id"],
                        "opening_seed": pair_data["opening_seed"],
                        "opening_actions": list(pair_data["opening_actions"]),
                        "opening_prefix_hash": pair_data["opening_prefix_hash"],
                        "opening_state_hash": pair_data["opening_state_hash"],
                        "prefix_plies": pair_data["prefix_plies"],
                        "policy_seed_block": game_binding["policy_seed_block"],
                        "policy_seed_a": game_binding["policy_seed_a"],
                        "policy_seed_b": game_binding["policy_seed_b"],
                        "policy_seed_assignment": game_binding["policy_seed_assignment"],
                        "black_policy_seed": game_binding["black_policy_seed"],
                        "white_policy_seed": game_binding["white_policy_seed"],
                        "games": 2,
                        "task_games": task["games"],
                        "max_plies": task["max_plies"],
                        "superko_mode": task["superko_mode"],
                        "source_hashes": task["source_hashes"],
                    }
                )
                task_game_index += 1
        if task_game_index != int(task["games"]):
            raise ProtocolError(
                f"{task['task_id']}: pair plan expands to {task_game_index} games, "
                f"expected {task['games']}"
            )
    if len(games) != 8320:
        raise ProtocolError(f"game manifest has {len(games)} rows, expected 8,320")
    ids = [game["game_id"] for game in games]
    if len(ids) != len(set(ids)):
        raise ProtocolError("game manifest contains duplicate game ids")
    return games


def _atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def _jsonl_text(rows: Sequence[Mapping[str, Any]]) -> str:
    return "".join(canonical_json(row) + "\n" for row in rows)


def write_task_bundle(
    manifest: Mapping[str, Any], output_directory: str | Path
) -> dict[str, Any]:
    """Create a new immutable bundle and refuse every overwrite attempt."""

    validate_manifest(manifest)
    output = Path(output_directory)
    if output.exists():
        raise ProtocolError(f"refusing to reuse existing bundle directory: {output}")
    output.mkdir(parents=True, exist_ok=False)
    materialized = materialize_manifest(manifest)
    tasks = generate_tasks(materialized)
    games = generate_game_manifest(tasks)

    manifest_path = output / "manifest_snapshot.json"
    materialized_path = output / "materialized_manifest_snapshot.json"
    tasks_path = output / "tasks.jsonl"
    games_path = output / "game_manifest.jsonl"
    _atomic_text(manifest_path, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    _atomic_text(materialized_path, json.dumps(materialized, indent=2, ensure_ascii=False) + "\n")
    _atomic_text(tasks_path, _jsonl_text(tasks))
    _atomic_text(games_path, _jsonl_text(games))
    summary = {
        "schema_name": BUNDLE_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": BUNDLE_EXPERIMENT_ID,
        "status": "materialized_not_run",
        "manifest_sha256": manifest_hash(manifest),
        "materialized_manifest_sha256": manifest_hash(materialized),
        "tasks": len(tasks),
        "gen_size_tasks": sum(task["evaluation_kind"] == "gen_size" for task in tasks),
        "d16_v2_tasks": sum(task["evaluation_kind"] == "d16_v2" for task in tasks),
        "games": len(games),
        "artifacts": {
            "manifest_snapshot": str(manifest_path.resolve()),
            "manifest_snapshot_sha256": sha256_file(manifest_path),
            "materialized_manifest_snapshot": str(materialized_path.resolve()),
            "materialized_manifest_snapshot_sha256": sha256_file(materialized_path),
            "tasks": str(tasks_path.resolve()),
            "tasks_sha256": sha256_file(tasks_path),
            "game_manifest": str(games_path.resolve()),
            "game_manifest_sha256": sha256_file(games_path),
        },
        "p1_generated": False,
    }
    summary_path = output / "bundle_summary.json"
    _atomic_text(summary_path, json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    return summary


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ProtocolError(f"cannot read JSONL {path}: {exc}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            raise ProtocolError(f"blank JSONL row at {path}:{line_number}")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ProtocolError(f"invalid JSONL row at {path}:{line_number}") from exc
        if not isinstance(value, dict):
            raise ProtocolError(f"JSONL row must be an object at {path}:{line_number}")
        records.append(value)
    return records


def load_task_bundle(
    manifest: Mapping[str, Any], bundle_directory: str | Path
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Deeply prove that a persisted bundle is the deterministic expansion."""

    validate_manifest(manifest)
    bundle = Path(bundle_directory)
    required = {
        "snapshot": bundle / "manifest_snapshot.json",
        "materialized": bundle / "materialized_manifest_snapshot.json",
        "tasks": bundle / "tasks.jsonl",
        "games": bundle / "game_manifest.jsonl",
        "summary": bundle / "bundle_summary.json",
    }
    for path in required.values():
        if not path.is_file():
            raise ProtocolError(f"task bundle artifact is missing: {path}")
    snapshot = _read_json(required["snapshot"])
    if canonical_json(snapshot) != canonical_json(manifest):
        raise ProtocolError("bundle manifest_snapshot differs from the supplied manifest")
    materialized = _read_json(required["materialized"])
    expected_materialized = materialize_manifest(manifest)
    if canonical_json(materialized) != canonical_json(expected_materialized):
        raise ProtocolError("materialized manifest is stale or was edited")
    tasks = load_jsonl(required["tasks"])
    games = load_jsonl(required["games"])
    expected_tasks = generate_tasks(materialized)
    expected_games = generate_game_manifest(expected_tasks)
    if canonical_json(tasks) != canonical_json(expected_tasks):
        raise ProtocolError("task manifest is stale, modified, or reordered")
    if canonical_json(games) != canonical_json(expected_games):
        raise ProtocolError("game manifest is stale, modified, or reordered")
    summary = _read_json(required["summary"])
    if (
        summary.get("manifest_sha256") != manifest_hash(manifest)
        or summary.get("materialized_manifest_sha256") != manifest_hash(materialized)
        or summary.get("tasks") != 85
        or summary.get("games") != 8320
    ):
        raise ProtocolError("bundle summary does not bind the exact formal matrix")
    return materialized, tasks, games


__all__ = [
    "BUNDLE_EXPERIMENT_ID",
    "D16_V2_ARM",
    "D16_V2_EXPERIMENT_ID",
    "GEN_SIZE_EXPERIMENT_ID",
    "P1_EXPERIMENT_ID",
    "ProtocolError",
    "canonical_json",
    "canonical_sha256",
    "generate_game_manifest",
    "generate_tasks",
    "load_manifest",
    "load_task_bundle",
    "manifest_hash",
    "materialize_manifest",
    "materialize_openings",
    "opening_prefix_hash",
    "opening_state_hash",
    "resolve_manifest_path",
    "sha256_file",
    "validate_manifest",
    "write_task_bundle",
]
