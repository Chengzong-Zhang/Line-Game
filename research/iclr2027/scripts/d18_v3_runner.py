#!/usr/bin/env python3
"""Freeze and verify the D18-v3 preparation bundle without formal games.

The command surface deliberately contains no formal execution command.  It can
freeze the prospective manifest, materialize task/game schedules, hash frozen
inputs, and prove that readiness/dry-run executed zero arena games.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
REPO_ROOT = SCRIPT_PATH.parents[3]
RESEARCH_ROOT = REPO_ROOT / "research" / "iclr2027"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import d18_v3_generate_openings as openings_v3  # noqa: E402


SCHEMA_NAME = "lifeline-d18-v3-formal-manifest"
SCHEMA_VERSION = 1
TASK_SCHEMA_NAME = "lifeline-d18-v3-task"
GAME_SCHEDULE_SCHEMA_NAME = "lifeline-d18-v3-game-schedule"
BUNDLE_SCHEMA_NAME = "lifeline-d18-v3-task-bundle"
EXPERIMENT_ID = openings_v3.EXPERIMENT_ID
EXPERIMENT_ARM = openings_v3.EXPERIMENT_ARM
PROTOCOL_ID = openings_v3.PROTOCOL_ID
TRAINING_SEEDS = (20260825, 20260826, 20260827, 20260828, 20260829)
MODEL_KINDS = ("padded_cnn", "grid_gnn", "topology_gnn")
MODEL_PAIRS = (
    ("padded_cnn", "grid_gnn"),
    ("padded_cnn", "topology_gnn"),
    ("grid_gnn", "topology_gnn"),
)
SIZES = openings_v3.SIZES
EXPECTED_TASKS = 45
EXPECTED_GAMES_PER_TASK = 128
EXPECTED_PAIRS_PER_TASK = 64
EXPECTED_GAMES = EXPECTED_TASKS * EXPECTED_GAMES_PER_TASK
POLICY_SEED_NAMESPACE = "lifeline-d18-v3-policy-seeds-20260830-v1"
BOOTSTRAP_SEED = 202608299902
DEFAULT_PROTOCOL = RESEARCH_ROOT / "D18_V3_PROTOCOL.md"
DEFAULT_OPENINGS = RESEARCH_ROOT / "configs" / "d18_v3_paired_openings_manifest.json"
DEFAULT_V1_FORMAL = RESEARCH_ROOT / "configs" / "d17_d19_formal_manifest.json"
DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d18_v3_formal_manifest_v2.json"
DEFAULT_READINESS = SCRIPT_DIR / "d18_v3_readiness.py"
DEFAULT_SELFTEST = SCRIPT_DIR / "d18_v3_selftest.py"
DEFAULT_TEST = RESEARCH_ROOT / "tests" / "test_d18_v3_preparation.py"


class PreparationError(RuntimeError):
    """The frozen v3 preparation contract is violated."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PreparationError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"cannot read strict JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PreparationError(f"JSON root must be an object: {path}")
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                raise PreparationError(f"blank JSONL line at {path}:{line_number}")
            value = json.loads(line, object_pairs_hook=_unique_object)
            if not isinstance(value, dict):
                raise PreparationError(f"JSONL row is not an object at {path}:{line_number}")
            rows.append(value)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"cannot read strict JSONL {path}: {exc}") from exc
    return rows


def parse_json_object(text: str, *, label: str) -> dict[str, Any]:
    """Parse one strict JSON object without touching the filesystem."""
    try:
        value = json.loads(text, object_pairs_hook=_unique_object)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"cannot parse strict JSON {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise PreparationError(f"JSON root must be an object: {label}")
    return value


def parse_jsonl_objects(text: str, *, label: str) -> list[dict[str, Any]]:
    """Parse strict JSONL rows without creating a temporary directory."""
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            raise PreparationError(f"blank JSONL line at {label}:{line_number}")
        try:
            value = json.loads(line, object_pairs_hook=_unique_object)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise PreparationError(
                f"cannot parse strict JSONL {label}:{line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise PreparationError(
                f"JSONL row is not an object at {label}:{line_number}"
            )
        rows.append(value)
    return rows


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + "\n"


def jsonl_text(rows: Iterable[Mapping[str, Any]]) -> str:
    return "".join(canonical_json(dict(row)) + "\n" for row in rows)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise PreparationError(f"cannot hash {path}: {exc}") from exc
    return digest.hexdigest()


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError as exc:
        raise PreparationError(f"path escapes repository root: {resolved}") from exc


def resolve_repo_path(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise PreparationError(f"path escapes repository root: {resolved}") from exc
    return resolved


def deep_copy_json(value: Any) -> Any:
    return json.loads(canonical_json(value))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PreparationError(message)


def _source_paths(
    *, protocol_path: Path, opening_path: Path, v1_formal_path: Path
) -> tuple[Path, ...]:
    fixed_sources = (
        protocol_path,
        opening_path,
        # ``validate_formal_manifest`` regenerates the paired-opening manifest
        # through ``d18_v3_generate_openings.validate_manifest``.  That path
        # reads the frozen v1 opening registry at runtime, so the registry must
        # be hash-bound and copied into every AutoDL stage as well.
        openings_v3.DEFAULT_V1_OPENINGS,
        openings_v3.SCRIPT_PATH,
        SCRIPT_PATH,
        DEFAULT_READINESS,
        DEFAULT_SELFTEST,
        DEFAULT_TEST,
        v1_formal_path,
        RESEARCH_ROOT / "D14_D16_EXPERIMENT_PROTOCOL.md",
        RESEARCH_ROOT / "configs" / "d14_d16_formal_manifest.json",
        RESEARCH_ROOT / "results" / "formal" / "d14_d16" / "run_v1" / "result_receipts.jsonl",
        RESEARCH_ROOT / "results" / "formal" / "d14_d16" / "aggregate_v1" / "aggregate.json",
    )
    # Source identity is rechecked during formal execution.  Consume the
    # trainer's own source-file definition so the stage cannot silently omit a
    # conditional source such as ``scripts/train_alphazero.py`` and then
    # compute a different source hash remotely.
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    source_identity_files = AlphaZeroTrainer.source_files()
    _require(bool(source_identity_files), "training source identity is empty")
    return fixed_sources + source_identity_files


def _validate_checkpoint_registry(rows: Any) -> list[dict[str, Any]]:
    _require(isinstance(rows, list), "v1 checkpoint registry must be a list")
    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    required_fields = {
        "checkpoint_id",
        "model_kind",
        "training_seed",
        "trained_board_sizes",
        "gradient_steps",
        "path",
        "sha256",
        "config_path",
        "config_hash",
        "config_file_sha256",
        "source_hash",
        "source_receipt_path",
        "source_receipt_sha256",
    }
    for index, raw in enumerate(rows):
        _require(isinstance(raw, dict), f"checkpoints[{index}] must be an object")
        if raw.get("model_kind") not in MODEL_KINDS:
            continue
        _require(required_fields <= set(raw), f"checkpoints[{index}] missing fields")
        kind = str(raw["model_kind"])
        seed = int(raw["training_seed"])
        _require(seed in TRAINING_SEEDS, f"unexpected checkpoint seed {seed}")
        _require(int(raw["gradient_steps"]) == 200, "checkpoint must be gradient_steps=200")
        _require(list(raw["trained_board_sizes"]) == [5, 7, 9], "checkpoint train sizes changed")
        key = (kind, seed)
        _require(key not in seen, f"duplicate checkpoint binding {key}")
        seen.add(key)
        selected.append(deep_copy_json(raw))
    expected = {(kind, seed) for kind in MODEL_KINDS for seed in TRAINING_SEEDS}
    _require(seen == expected, "v3 requires exactly 15 frozen representation checkpoints")
    selected.sort(key=lambda row: (MODEL_KINDS.index(row["model_kind"]), row["training_seed"]))
    return selected


def _bind_checkpoint_latest_manifests(
    rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    bound: list[dict[str, Any]] = []
    for raw in rows:
        row = deep_copy_json(raw)
        checkpoint_path = resolve_repo_path(str(row["path"]))
        latest_path = checkpoint_path.with_name("latest.json")
        latest = load_json(latest_path)
        _require(
            latest.get("schema")
            == {"name": "lifeline-alphazero-latest", "version": 1},
            f"checkpoint latest schema mismatch: {latest_path}",
        )
        _require(
            latest.get("checkpoint") == checkpoint_path.name,
            f"checkpoint latest target mismatch: {latest_path}",
        )
        _require(
            latest.get("sha256") == row["sha256"],
            f"checkpoint latest digest mismatch: {latest_path}",
        )
        _require(
            latest.get("size_bytes") == checkpoint_path.stat().st_size,
            f"checkpoint latest size mismatch: {latest_path}",
        )
        _require(
            latest.get("config_hash") == row["config_hash"],
            f"checkpoint latest config mismatch: {latest_path}",
        )
        _require(
            latest.get("source_hash") == row["source_hash"],
            f"checkpoint latest source mismatch: {latest_path}",
        )
        _require(
            latest.get("checkpoint_schema_version") == 1,
            f"checkpoint latest payload schema mismatch: {latest_path}",
        )
        row["latest_manifest_path"] = repo_relative(latest_path)
        row["latest_manifest_sha256"] = sha256_file(latest_path)
        bound.append(row)
    return bound


def build_formal_manifest(
    *, protocol_path: Path, opening_path: Path, v1_formal_path: Path
) -> dict[str, Any]:
    protocol_path = resolve_repo_path(protocol_path)
    opening_path = resolve_repo_path(opening_path)
    v1_formal_path = resolve_repo_path(v1_formal_path)
    opening_manifest = openings_v3.load_json(opening_path)
    openings_v3.validate_manifest(
        opening_manifest,
        generator_path=openings_v3.SCRIPT_PATH,
        v1_path=openings_v3.DEFAULT_V1_OPENINGS,
    )
    v1_formal = load_json(v1_formal_path)
    checkpoints = _bind_checkpoint_latest_manifests(
        _validate_checkpoint_registry(v1_formal.get("checkpoints"))
    )
    source_paths = (
        *_source_paths(
            protocol_path=protocol_path,
            opening_path=opening_path,
            v1_formal_path=v1_formal_path,
        ),
        *(resolve_repo_path(row["latest_manifest_path"]) for row in checkpoints),
    )
    for path in source_paths:
        _require(path.is_file(), f"bound source file is missing: {path}")
    source_hashes = {repo_relative(path): sha256_file(path) for path in source_paths}
    return {
        "checkpoint_selection": {
            "checkpoint_count": 15,
            "gradient_steps": 200,
            "matched_training_seed_within_task": True,
            "model_kinds": list(MODEL_KINDS),
            "no_checkpoint_selection_from_v1_outcomes": True,
            "no_finetuning_or_conversion": True,
            "source_manifest_path": repo_relative(v1_formal_path),
            "source_manifest_sha256": sha256_file(v1_formal_path),
        },
        "checkpoints": checkpoints,
        "evidence_tier": "formal_prospective_not_run",
        "experiment_arm": EXPERIMENT_ARM,
        "experiment_id": EXPERIMENT_ID,
        "formal_gates": {
            "all_games_replayable": True,
            "failed_tasks_allowed": 0,
            "formal_ready_before_execution": False,
            "minimum_clusters_with_two_continuations_per_task": 24,
            "minimum_unique_continuations_per_task": 32,
            "minimum_unique_full_trajectories_per_task": 64,
            "missing_tasks_allowed": 0,
            "positive_claim_forbidden_on_any_failure": True,
            "truncated_games_allowed": 0,
        },
        "frozen_date": "2026-08-30",
        "game_rules": {
            "max_plies": 256,
            "start_player": "BLACK",
            "superko_mode": "enforce",
            "truncations_allowed": 0,
        },
        "immutable_output_policy": {
            "may_read_d14_d16": True,
            "may_read_v1_opening_hashes_for_disjointness": True,
            "may_write_d14_d16": False,
            "may_write_d17_d19_v1": False,
            "new_run_id_required": True,
            "refuse_nonempty_bundle_or_run_directory": True,
        },
        "model_pairs": [
            {"agent_a_model_kind": left, "agent_b_model_kind": right}
            for left, right in MODEL_PAIRS
        ],
        "opening_design": {
            "opening_count": openings_v3.EXPECTED_OPENINGS,
            "opening_manifest_path": repo_relative(opening_path),
            "opening_manifest_sha256": sha256_file(opening_path),
            "openings_per_size": openings_v3.OPENINGS_PER_SIZE,
            "prefix_depths": list(openings_v3.PREFIX_DEPTHS),
            "strata_per_depth": openings_v3.STRATA_PER_DEPTH,
            "strata_per_size": openings_v3.STRATA_PER_SIZE,
            "variants_per_stratum": openings_v3.VARIANTS_PER_STRATUM,
            "v1_openings_disjoint_required": True,
        },
        "output_root": "research/iclr2027/results/formal/d18_v3",
        "paired_color_swap": {
            "agent_seed_follows_agent_not_color": True,
            "games_per_opening_variant": 2,
            "games_per_stratum": 4,
            "one_color_pair_per_opening_variant": True,
            "variant_0_assignment": "A=low,B=high",
            "variant_1_assignment": "A=high,B=low",
        },
        "protocol_id": PROTOCOL_ID,
        "protocol_path": repo_relative(protocol_path),
        "protocol_sha256": sha256_file(protocol_path),
        "schema_name": SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "search": {
            "add_root_noise": False,
            "c_puct": 1.5,
            "simulations": 16,
            "temperature": 0.0,
        },
        "sizes": list(SIZES),
        "source_hashes": source_hashes,
        "statistics": {
            "bootstrap_replicates": 20_000,
            "bootstrap_seed": BOOTSTRAP_SEED,
            "cluster_mean_games": 4,
            "paired_model_difference_required": True,
            "pooled_game_interval": "descriptive_only",
            "primary_interval": "two-way crossed training-seed x opening-stratum percentile bootstrap",
            "primary_unit": "training_seed_x_opening_stratum",
            "secondary_interval": "Student t interval across five training-seed means",
            "secondary_interval_degrees_of_freedom": 4,
            "strata_per_training_seed": 32,
        },
        "status": "frozen_zero_formal_games",
        "task_contract": {
            "color_pairs_per_task": EXPECTED_PAIRS_PER_TASK,
            "games_per_task": EXPECTED_GAMES_PER_TASK,
            "model_pair_count": len(MODEL_PAIRS),
            "task_count": EXPECTED_TASKS,
            "total_games": EXPECTED_GAMES,
            "training_seed_count": len(TRAINING_SEEDS),
        },
        "training_seeds": list(TRAINING_SEEDS),
        "zero_execution": {
            "autodl_actions": 0,
            "external_actions": 0,
            "formal_execution_command_available": False,
            "formal_games_executed": 0,
            "gpu_actions": 0,
            "model_forward_calls": 0,
            "paid_actions": 0,
            "readiness_may_hash_but_not_load_checkpoints": True,
        },
    }


def validate_formal_manifest(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    protocol_path: Path | None = None,
    opening_path: Path | None = None,
    v1_formal_path: Path | None = None,
) -> dict[str, Any]:
    declared_protocol = resolve_repo_path(
        protocol_path or str(manifest.get("protocol_path", ""))
    )
    opening_design = manifest.get("opening_design")
    _require(isinstance(opening_design, dict), "opening_design is missing")
    declared_openings = resolve_repo_path(
        opening_path or str(opening_design.get("opening_manifest_path", ""))
    )
    checkpoint_selection = manifest.get("checkpoint_selection")
    _require(isinstance(checkpoint_selection, dict), "checkpoint_selection is missing")
    declared_v1 = resolve_repo_path(
        v1_formal_path or str(checkpoint_selection.get("source_manifest_path", ""))
    )
    expected = build_formal_manifest(
        protocol_path=declared_protocol,
        opening_path=declared_openings,
        v1_formal_path=declared_v1,
    )
    _require(dict(manifest) == expected, "formal manifest is not the exact frozen regeneration")
    return {
        "formal_games_executed": 0,
        "manifest_path": repo_relative(resolve_repo_path(manifest_path)),
        "manifest_sha256": sha256_file(resolve_repo_path(manifest_path)),
        "status": "passed",
    }


def _policy_seed_pair(*, size: int, stratum: int) -> tuple[int, int]:
    seeds: list[int] = []
    for label in ("low", "high"):
        payload = (
            f"{POLICY_SEED_NAMESPACE}|n={size}|stratum={stratum}|{label}"
        ).encode("utf-8")
        seeds.append(int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") & ((1 << 63) - 1))
    _require(seeds[0] != seeds[1], "derived A/B policy seeds collide")
    return seeds[0], seeds[1]


def _checkpoint_map(manifest: Mapping[str, Any]) -> dict[tuple[str, int], dict[str, Any]]:
    rows = _validate_checkpoint_registry(manifest.get("checkpoints"))
    return {(str(row["model_kind"]), int(row["training_seed"])): row for row in rows}


def _opening_map(opening_manifest: Mapping[str, Any]) -> dict[int, list[dict[str, Any]]]:
    rows = opening_manifest.get("openings")
    _require(isinstance(rows, list), "opening manifest rows missing")
    by_size: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for raw in rows:
        _require(isinstance(raw, dict), "opening row must be an object")
        by_size[int(raw["eval_size"])].append(deep_copy_json(raw))
    for size in SIZES:
        by_size[size].sort(key=lambda row: (row["stratum_index"], row["variant_index"]))
        _require(len(by_size[size]) == openings_v3.OPENINGS_PER_SIZE, "opening count per size mismatch")
    return dict(by_size)


def materialize_bundle(
    *, manifest: Mapping[str, Any], manifest_path: Path
) -> dict[str, Any]:
    validate_formal_manifest(manifest, manifest_path=manifest_path)
    opening_path = resolve_repo_path(manifest["opening_design"]["opening_manifest_path"])
    opening_manifest = openings_v3.load_json(opening_path)
    openings_v3.validate_manifest(
        opening_manifest,
        generator_path=openings_v3.SCRIPT_PATH,
        v1_path=openings_v3.DEFAULT_V1_OPENINGS,
    )
    checkpoint_by_key = _checkpoint_map(manifest)
    opening_by_size = _opening_map(opening_manifest)
    manifest_hash = sha256_file(resolve_repo_path(manifest_path))
    opening_hash = sha256_file(opening_path)
    protocol_hash = str(manifest["protocol_sha256"])
    runner_hash = sha256_file(SCRIPT_PATH)
    task_rows: list[dict[str, Any]] = []
    game_rows: list[dict[str, Any]] = []
    global_game_index = 0
    for left, right in MODEL_PAIRS:
        for training_seed in TRAINING_SEEDS:
            for size in SIZES:
                task_id = (
                    f"d18v3.n{size}.seed{training_seed}.{left}.vs.{right}"
                )
                binding_a = deep_copy_json(checkpoint_by_key[(left, training_seed)])
                binding_b = deep_copy_json(checkpoint_by_key[(right, training_seed)])
                pair_plan: list[dict[str, Any]] = []
                task_game_index = 0
                for opening in opening_by_size[size]:
                    stratum = int(opening["stratum_index"])
                    variant = int(opening["variant_index"])
                    seed_low, seed_high = _policy_seed_pair(size=size, stratum=stratum)
                    if variant == 0:
                        policy_seed_a, policy_seed_b = seed_low, seed_high
                    else:
                        policy_seed_a, policy_seed_b = seed_high, seed_low
                    pair_id = f"{task_id}.s{stratum:02d}.v{variant}"
                    game_ids = [f"{pair_id}.m0", f"{pair_id}.m1"]
                    pair = {
                        "eval_size": size,
                        "game_ids": game_ids,
                        "opening_actions": opening["opening_actions"],
                        "opening_id": opening["opening_id"],
                        "opening_prefix_hash": opening["opening_prefix_hash"],
                        "opening_state_hash": opening["opening_state_hash"],
                        "pair_id": pair_id,
                        "pair_index": len(pair_plan),
                        "policy_seed_a": policy_seed_a,
                        "policy_seed_assignment": variant,
                        "policy_seed_b": policy_seed_b,
                        "policy_seed_high": seed_high,
                        "policy_seed_low": seed_low,
                        "prefix_plies": opening["prefix_plies"],
                        "stratum_id": opening["stratum_id"],
                        "stratum_index": stratum,
                        "variant_index": variant,
                    }
                    pair_plan.append(pair)
                    for pair_member in (0, 1):
                        black_slot, white_slot = (
                            ("A", "B") if pair_member == 0 else ("B", "A")
                        )
                        black_policy_seed = (
                            policy_seed_a if black_slot == "A" else policy_seed_b
                        )
                        white_policy_seed = (
                            policy_seed_a if white_slot == "A" else policy_seed_b
                        )
                        game_rows.append(
                            {
                                "black_policy_seed": black_policy_seed,
                                "black_slot": black_slot,
                                "experiment_id": EXPERIMENT_ID,
                                "formal_manifest_sha256": manifest_hash,
                                "game_id": game_ids[pair_member],
                                "game_index": task_game_index,
                                "global_game_index": global_game_index,
                                "max_plies": 256,
                                "opening_actions": opening["opening_actions"],
                                "opening_id": opening["opening_id"],
                                "opening_prefix_hash": opening["opening_prefix_hash"],
                                "opening_state_hash": opening["opening_state_hash"],
                                "opening_stratum": opening["stratum_id"],
                                "opening_variant": variant,
                                "opening_manifest_sha256": opening_hash,
                                "pair_id": pair_id,
                                "pair_member": pair_member,
                                "policy_seed_a": policy_seed_a,
                                "policy_seed_assignment": variant,
                                "policy_seed_b": policy_seed_b,
                                "protocol_sha256": protocol_hash,
                                "runner_sha256": runner_hash,
                                "schema_name": GAME_SCHEDULE_SCHEMA_NAME,
                                "schema_version": SCHEMA_VERSION,
                                "start_player": "BLACK",
                                "stratum_index": stratum,
                                "superko_mode": "enforce",
                                "task_id": task_id,
                                "training_seed": training_seed,
                                "white_policy_seed": white_policy_seed,
                                "white_slot": white_slot,
                            }
                        )
                        task_game_index += 1
                        global_game_index += 1
                _require(len(pair_plan) == EXPECTED_PAIRS_PER_TASK, "pair plan count mismatch")
                _require(task_game_index == EXPECTED_GAMES_PER_TASK, "task game count mismatch")
                task_rows.append(
                    {
                        "agent_bindings": {"A": binding_a, "B": binding_b},
                        "color_pairs": EXPECTED_PAIRS_PER_TASK,
                        "eval_size": size,
                        "evidence_tier": "formal_prospective_not_run",
                        "experiment_arm": EXPERIMENT_ARM,
                        "experiment_id": EXPERIMENT_ID,
                        "formal_gates": {
                            "max_truncated_games": 0,
                            "min_clusters_with_two_continuations": 24,
                            "min_unique_prefix_stripped_continuations": 32,
                            "min_unique_trajectories": 64,
                            "opening_strata": 32,
                        },
                        "formal_manifest_sha256": manifest_hash,
                        "games": EXPECTED_GAMES_PER_TASK,
                        "inference_group_id": f"d16-v3.{left}_vs_{right}.n{size}",
                        "max_plies": 256,
                        "model_pair": [left, right],
                        "opening_manifest_sha256": opening_hash,
                        "opening_strata": 32,
                        "pair_plan": pair_plan,
                        "protocol_sha256": protocol_hash,
                        "runner_sha256": runner_hash,
                        "schema_name": TASK_SCHEMA_NAME,
                        "schema_version": SCHEMA_VERSION,
                        "search": deep_copy_json(manifest["search"]),
                        "start_player": "BLACK",
                        "superko_mode": "enforce",
                        "task_id": task_id,
                        "training_seed": training_seed,
                        "variants_per_stratum": 2,
                    }
                )
    _require(len(task_rows) == EXPECTED_TASKS, "formal task count mismatch")
    _require(len(game_rows) == EXPECTED_GAMES, "formal game schedule count mismatch")
    game_text = jsonl_text(game_rows)
    game_hash = sha256_text(game_text)
    for task in task_rows:
        task["game_manifest_sha256"] = game_hash
    task_text = jsonl_text(task_rows)
    task_hash = sha256_text(task_text)
    summary = {
        "bundle_schema_name": BUNDLE_SCHEMA_NAME,
        "color_pairs_per_task": EXPECTED_PAIRS_PER_TASK,
        "experiment_id": EXPERIMENT_ID,
        "formal_games_executed": 0,
        "formal_manifest_sha256": manifest_hash,
        "game_count": len(game_rows),
        "game_manifest_sha256": game_hash,
        "opening_count": openings_v3.EXPECTED_OPENINGS,
        "opening_manifest_sha256": opening_hash,
        "paid_actions": 0,
        "runner_sha256": runner_hash,
        "schema_version": SCHEMA_VERSION,
        "status": "prepared_not_run",
        "task_count": len(task_rows),
        "task_manifest_sha256": task_hash,
    }
    bundle = {
        "game_rows": game_rows,
        "game_text": game_text,
        "manifest_snapshot": deep_copy_json(manifest),
        "summary": summary,
        "task_rows": task_rows,
        "task_text": task_text,
    }
    validate_materialized_bundle(bundle)
    return bundle


def validate_materialized_bundle(bundle: Mapping[str, Any]) -> dict[str, Any]:
    tasks = bundle.get("task_rows")
    games = bundle.get("game_rows")
    _require(isinstance(tasks, list) and len(tasks) == EXPECTED_TASKS, "bundle task count mismatch")
    _require(isinstance(games, list) and len(games) == EXPECTED_GAMES, "bundle game count mismatch")
    _require(len({row["task_id"] for row in tasks}) == EXPECTED_TASKS, "task IDs not unique")
    _require(len({row["game_id"] for row in games}) == EXPECTED_GAMES, "game IDs not unique")
    _require(
        [int(row["global_game_index"]) for row in games] == list(range(EXPECTED_GAMES)),
        "global game indices are not canonical",
    )
    games_by_task: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in games:
        games_by_task[str(row["task_id"])].append(row)
        _require(row["search"] if "search" in row else True, "invalid schedule")
        _require(row["start_player"] == "BLACK", "start player changed")
        _require(row["superko_mode"] == "enforce", "Superko changed")
        _require(int(row["max_plies"]) == 256, "max plies changed")
        _require(row["black_slot"] != row["white_slot"], "color slots collide")
        if row["black_slot"] == "A":
            _require(row["black_policy_seed"] == row["policy_seed_a"], "A seed moved")
            _require(row["white_policy_seed"] == row["policy_seed_b"], "B seed moved")
        else:
            _require(row["black_policy_seed"] == row["policy_seed_b"], "B seed moved")
            _require(row["white_policy_seed"] == row["policy_seed_a"], "A seed moved")
    schedule_signatures: dict[int, set[str]] = defaultdict(set)
    for task in tasks:
        task_id = str(task["task_id"])
        rows = sorted(games_by_task[task_id], key=lambda row: int(row["game_index"]))
        _require(len(rows) == EXPECTED_GAMES_PER_TASK, f"{task_id}: game count mismatch")
        _require(len(task["pair_plan"]) == EXPECTED_PAIRS_PER_TASK, f"{task_id}: pair count mismatch")
        stratum_counts = Counter(int(row["stratum_index"]) for row in rows)
        _require(stratum_counts == Counter({index: 4 for index in range(32)}), "stratum game balance changed")
        pair_members: dict[str, set[int]] = defaultdict(set)
        for row in rows:
            pair_members[str(row["pair_id"])].add(int(row["pair_member"]))
        _require(len(pair_members) == EXPECTED_PAIRS_PER_TASK, "color pair count mismatch")
        _require(all(members == {0, 1} for members in pair_members.values()), "paired color swap incomplete")
        signature_rows = [
            {
                "opening_actions": row["opening_actions"],
                "opening_id": row["opening_id"],
                "opening_variant": row["opening_variant"],
                "pair_member": row["pair_member"],
                "policy_seed_a": row["policy_seed_a"],
                "policy_seed_b": row["policy_seed_b"],
                "stratum_index": row["stratum_index"],
            }
            for row in rows
        ]
        schedule_signatures[int(task["eval_size"])].add(
            sha256_text(canonical_json(signature_rows))
        )
        _require(task["search"] == {"add_root_noise": False, "c_puct": 1.5, "simulations": 16, "temperature": 0.0}, "search contract changed")
        _require(task["formal_gates"] == {"max_truncated_games": 0, "min_clusters_with_two_continuations": 24, "min_unique_prefix_stripped_continuations": 32, "min_unique_trajectories": 64, "opening_strata": 32}, "formal gates changed")
    _require(set(schedule_signatures) == set(SIZES), "task schedule sizes mismatch")
    _require(
        all(len(signatures) == 1 for signatures in schedule_signatures.values()),
        "tasks of the same size do not share one frozen schedule",
    )
    task_text = str(bundle["task_text"])
    game_text = str(bundle["game_text"])
    summary = bundle["summary"]
    _require(summary["task_manifest_sha256"] == sha256_text(task_text), "task hash mismatch")
    _require(summary["game_manifest_sha256"] == sha256_text(game_text), "game hash mismatch")
    _require(int(summary["formal_games_executed"]) == 0, "bundle claims formal execution")
    return {
        "color_pairs_per_task": EXPECTED_PAIRS_PER_TASK,
        "formal_games_executed": 0,
        "game_count": EXPECTED_GAMES,
        "status": "passed",
        "task_count": EXPECTED_TASKS,
    }


def atomic_write_new(path: Path, text: str) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise PreparationError(f"refusing to overwrite existing file: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            raise PreparationError(f"target appeared during atomic write: {path}")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_bundle(bundle: Mapping[str, Any], directory: Path) -> dict[str, Any]:
    directory = directory.resolve()
    if directory.exists():
        if not directory.is_dir():
            raise PreparationError(f"bundle target is not a directory: {directory}")
        if any(directory.iterdir()):
            raise PreparationError(f"refusing nonempty bundle directory: {directory}")
    else:
        directory.mkdir(parents=True)
    files = {
        "bundle_summary.json": pretty_json(bundle["summary"]),
        "game_manifest.jsonl": str(bundle["game_text"]),
        "manifest_snapshot.json": pretty_json(bundle["manifest_snapshot"]),
        "tasks.jsonl": str(bundle["task_text"]),
    }
    for name, text in files.items():
        atomic_write_new(directory / name, text)
    return validate_bundle_directory(directory)


def validate_bundle_directory(directory: Path) -> dict[str, Any]:
    directory = directory.resolve()
    expected_names = {
        "bundle_summary.json",
        "game_manifest.jsonl",
        "manifest_snapshot.json",
        "tasks.jsonl",
    }
    _require(directory.is_dir(), "bundle directory is missing")
    observed_names = {path.name for path in directory.iterdir() if path.is_file()}
    _require(observed_names == expected_names, "bundle file set mismatch")
    summary = load_json(directory / "bundle_summary.json")
    tasks = load_jsonl(directory / "tasks.jsonl")
    games = load_jsonl(directory / "game_manifest.jsonl")
    task_text = (directory / "tasks.jsonl").read_text(encoding="utf-8")
    game_text = (directory / "game_manifest.jsonl").read_text(encoding="utf-8")
    _require(sha256_text(task_text) == summary["task_manifest_sha256"], "persisted task hash mismatch")
    _require(sha256_text(game_text) == summary["game_manifest_sha256"], "persisted game hash mismatch")
    return validate_materialized_bundle(
        {
            "game_rows": games,
            "game_text": game_text,
            "manifest_snapshot": load_json(directory / "manifest_snapshot.json"),
            "summary": summary,
            "task_rows": tasks,
            "task_text": task_text,
        }
    )


def verify_checkpoint_files(manifest: Mapping[str, Any]) -> dict[str, Any]:
    rows = _validate_checkpoint_registry(manifest.get("checkpoints"))
    checked = 0
    total_bytes = 0
    for row in rows:
        bindings = (
            ("path", "sha256"),
            ("config_path", "config_file_sha256"),
            ("source_receipt_path", "source_receipt_sha256"),
            ("latest_manifest_path", "latest_manifest_sha256"),
        )
        for path_field, hash_field in bindings:
            path = resolve_repo_path(str(row[path_field]))
            _require(path.is_file(), f"checkpoint binding missing: {path}")
            observed = sha256_file(path)
            _require(observed == row[hash_field], f"checkpoint binding hash mismatch: {path}")
            checked += 1
            total_bytes += path.stat().st_size
    return {
        "checkpoint_bindings_verified": checked,
        "checkpoint_files_loaded_as_models": 0,
        "checkpoint_rows": len(rows),
        "formal_games_executed": 0,
        "hashed_bytes": total_bytes,
    }


def readiness_report(
    *, manifest_path: Path, verify_checkpoints: bool = True
) -> dict[str, Any]:
    manifest_path = resolve_repo_path(manifest_path)
    manifest = load_json(manifest_path)
    validation = validate_formal_manifest(manifest, manifest_path=manifest_path)
    bundle = materialize_bundle(manifest=manifest, manifest_path=manifest_path)
    checkpoint_report = (
        verify_checkpoint_files(manifest)
        if verify_checkpoints
        else {
            "checkpoint_bindings_verified": 0,
            "checkpoint_files_loaded_as_models": 0,
            "checkpoint_rows": 15,
            "formal_games_executed": 0,
            "hashed_bytes": 0,
        }
    )
    return {
        "autodl_actions": 0,
        "bundle_game_count": len(bundle["game_rows"]),
        "bundle_task_count": len(bundle["task_rows"]),
        **checkpoint_report,
        "external_actions": 0,
        "formal_games_executed": 0,
        "gpu_actions": 0,
        "manifest_sha256": validation["manifest_sha256"],
        "model_forward_calls": 0,
        "opening_count": openings_v3.EXPECTED_OPENINGS,
        "paid_actions": 0,
        "status": "ready_zero_execution",
    }


def dry_run_report(*, manifest_path: Path) -> dict[str, Any]:
    manifest_path = resolve_repo_path(manifest_path)
    manifest = load_json(manifest_path)
    bundle = materialize_bundle(manifest=manifest, manifest_path=manifest_path)
    summary_text = pretty_json(bundle["summary"])
    snapshot_text = pretty_json(bundle["manifest_snapshot"])
    task_text = str(bundle["task_text"])
    game_text = str(bundle["game_text"])
    roundtripped = {
        "game_rows": parse_jsonl_objects(game_text, label="game_manifest.jsonl"),
        "game_text": game_text,
        "manifest_snapshot": parse_json_object(
            snapshot_text, label="manifest_snapshot.json"
        ),
        "summary": parse_json_object(summary_text, label="bundle_summary.json"),
        "task_rows": parse_jsonl_objects(task_text, label="tasks.jsonl"),
        "task_text": task_text,
    }
    _require(
        pretty_json(roundtripped["summary"]) == summary_text,
        "bundle summary is not canonical after in-memory roundtrip",
    )
    _require(
        pretty_json(roundtripped["manifest_snapshot"]) == snapshot_text,
        "manifest snapshot is not canonical after in-memory roundtrip",
    )
    _require(
        jsonl_text(roundtripped["task_rows"]) == task_text,
        "task JSONL is not canonical after in-memory roundtrip",
    )
    _require(
        jsonl_text(roundtripped["game_rows"]) == game_text,
        "game JSONL is not canonical after in-memory roundtrip",
    )
    persisted = validate_materialized_bundle(roundtripped)
    return {
        "autodl_actions": 0,
        "bundle_roundtrip_verified": persisted["status"] == "passed",
        "color_pairs_per_task": EXPECTED_PAIRS_PER_TASK,
        "external_actions": 0,
        "formal_games_executed": 0,
        "game_count": EXPECTED_GAMES,
        "gpu_actions": 0,
        "model_forward_calls": 0,
        "opening_count": openings_v3.EXPECTED_OPENINGS,
        "paid_actions": 0,
        "status": "passed_zero_execution",
        "task_count": EXPECTED_TASKS,
    }


def freeze_manifest(
    *, output: Path, protocol_path: Path, opening_path: Path, v1_formal_path: Path
) -> dict[str, Any]:
    output = resolve_repo_path(output)
    manifest = build_formal_manifest(
        protocol_path=protocol_path,
        opening_path=opening_path,
        v1_formal_path=v1_formal_path,
    )
    atomic_write_new(output, pretty_json(manifest))
    return {
        "formal_games_executed": 0,
        "manifest_path": repo_relative(output),
        "manifest_sha256": sha256_file(output),
        "status": "frozen",
    }


def _write_optional_report(path: Path | None, report: Mapping[str, Any]) -> None:
    if path is not None:
        atomic_write_new(path, pretty_json(report))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    freeze = subparsers.add_parser("freeze-manifest", help="write a new hash-bound v3 manifest")
    freeze.add_argument("--output", type=Path, default=DEFAULT_MANIFEST)
    freeze.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    freeze.add_argument("--openings", type=Path, default=DEFAULT_OPENINGS)
    freeze.add_argument("--v1-formal", type=Path, default=DEFAULT_V1_FORMAL)

    prepare = subparsers.add_parser("prepare-bundle", help="write task/game schedules only")
    prepare.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    prepare.add_argument("--bundle-dir", type=Path, required=True)

    readiness = subparsers.add_parser("readiness", help="hash and validate frozen inputs")
    readiness.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    readiness.add_argument("--output", type=Path)
    readiness.add_argument("--skip-checkpoint-file-hashes", action="store_true")

    dry_run = subparsers.add_parser("dry-run", help="round-trip a bundle with zero games")
    dry_run.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    dry_run.add_argument("--output", type=Path)

    subparsers.add_parser("show-contract", help="print the immutable zero-execution counts")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "freeze-manifest":
            report = freeze_manifest(
                output=args.output,
                protocol_path=args.protocol,
                opening_path=args.openings,
                v1_formal_path=args.v1_formal,
            )
        elif args.command == "prepare-bundle":
            manifest_path = resolve_repo_path(args.manifest)
            manifest = load_json(manifest_path)
            bundle = materialize_bundle(manifest=manifest, manifest_path=manifest_path)
            report = write_bundle(bundle, args.bundle_dir)
            report.update({"bundle_directory": str(args.bundle_dir.resolve()), "paid_actions": 0})
        elif args.command == "readiness":
            report = readiness_report(
                manifest_path=args.manifest,
                verify_checkpoints=not args.skip_checkpoint_file_hashes,
            )
            _write_optional_report(args.output, report)
        elif args.command == "dry-run":
            report = dry_run_report(manifest_path=args.manifest)
            _write_optional_report(args.output, report)
        elif args.command == "show-contract":
            report = {
                "commands": ["freeze-manifest", "prepare-bundle", "readiness", "dry-run", "show-contract"],
                "formal_execution_command_available": False,
                "formal_games_executed": 0,
                "game_count": EXPECTED_GAMES,
                "opening_count": openings_v3.EXPECTED_OPENINGS,
                "paid_actions": 0,
                "task_count": EXPECTED_TASKS,
            }
        else:  # pragma: no cover - argparse enforces this branch away.
            raise PreparationError(f"unknown command: {args.command}")
    except (PreparationError, openings_v3.PreparationError) as exc:
        print(
            canonical_json(
                {
                    "error": str(exc),
                    "formal_games_executed": 0,
                    "paid_actions": 0,
                    "status": "failed",
                }
            )
        )
        return 2
    print(canonical_json(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
