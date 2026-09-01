#!/usr/bin/env python3
"""Audit the tracked D14--D16 accounting metadata in a clean checkout.

This verifier is intentionally narrower than ``independent_receipt_audit.py``.
It reads only the eleven explicitly declared, tracked metadata inputs below.  In
particular, paths embedded in receipts are data: they are never resolved,
stat-ed, hashed, imported, or opened.  A pass therefore establishes accounting
consistency only; it does not re-verify raw games, checkpoint bytes, logs,
trajectory replay, or training.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import stat
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = PROJECT / "configs" / "d14_d16_formal_manifest.json"
BUNDLE = PROJECT / "results" / "formal" / "d14_d16" / "task_bundle_v1"
RUN = PROJECT / "results" / "formal" / "d14_d16" / "run_v1"
AGGREGATE_DIR = PROJECT / "results" / "formal" / "d14_d16" / "aggregate_v1"
PRIOR_AUDIT = (
    PROJECT
    / "results"
    / "validation"
    / "d14_d16_independent_receipt_audit_20260831.json"
)

EXPECTED_COMPACT_SHA256 = (
    "f6276b30a3078ec95ebed100da57ff5c62c3e8b6e5f94cb6d9b19dee7bdff0db"
)
EXPECTED_COMPACT_SIZE_BYTES = 910_909
EXPECTED_PRIOR_AUDIT_SHA256 = (
    "f64c8de1a2fca86cf7681a855edfb244033b318e65e14b2add64ede27e4ef648"
)
EXPECTED_MANIFEST_SHA256 = (
    "9439c3b9b52ed13a8c489969dfbafddd59e75af2579274b7275258b693d8782f"
)
EXPECTED_RECEIPTS = 330
EXPECTED_TRAINING_TASKS = 15
EXPECTED_EVALUATION_TASKS = 315
EXPECTED_HASH_BINDINGS = 4_695
EXPECTED_EVALUATION_GAMES = 30_600
EXPECTED_SELF_PLAY_GAMES = 1_500
EXPECTED_GRADIENT_STEPS = 3_000
FLOAT_TOLERANCE = 1e-12
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
MAX_JSON_DEPTH = 64
MAX_EXACT_FLOAT_INTEGER = (1 << 53) - 1
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
INTEGER_RE = re.compile(r"^-?(?:0|[1-9][0-9]*)$")

RECEIPT_FIELDS = (
    "schema_name",
    "schema_version",
    "experiment_id",
    "task_id",
    "result_kind",
    "status",
    "evidence_tier",
    "seed",
    "representation",
    "board_sizes",
    "train_sizes",
    "eval_size",
    "checkpoint_gradient_steps",
    "self_play_games_completed",
    "gradient_steps_completed",
    "environment_steps_completed",
    "games_requested",
    "games_completed",
    "replay_verified_games",
    "truncated_games",
    "a_wins",
    "a_losses",
    "draws",
    "a_as_black_games",
    "a_as_white_games",
    "color_pairs_verified",
    "parameter_count",
    "superko_mode",
    "manifest_sha256",
)

MANIFEST_KEYS = {
    "schema_name",
    "schema_version",
    "experiment_id",
    "evidence_tier",
    "status",
    "task_scope",
    "representations",
    "train_sizes",
    "seeds",
    "training_budget",
    "evaluation",
    "search_baselines",
    "matching",
    "notes",
}
REPRESENTATION_KEYS = {
    "id",
    "observation",
    "model_family",
    "model_config",
    "expected_trainable_parameters",
}
TRAINING_BUDGET_KEYS = {
    "puct_simulations",
    "self_play_games",
    "gradient_steps",
    "max_plies",
    "replay_capacity",
    "batch_size",
    "iterations",
    "games_per_iteration",
    "training_steps_per_iteration",
    "checkpoint_every_iterations",
    "c_puct",
    "dirichlet_alpha",
    "dirichlet_epsilon",
    "temperature_moves",
    "initial_temperature",
    "final_temperature",
    "learning_rate",
    "weight_decay",
    "gradient_clip_norm",
    "terminal_reward",
    "superko_mode",
}
EVALUATION_KEYS = {
    "curve_games_per_matchup",
    "final_games_per_matchup",
    "color_balance",
    "max_plies",
    "superko_mode",
    "checkpoint_gradient_steps",
    "curve_opponent",
    "final_search_opponents",
    "representation_round_robin",
}
MATCHING_KEYS = {
    "exact_fields",
    "parameter_count_scope",
    "parameter_count_relative_tolerance",
    "wall_clock_seconds",
}
IDENTITY_KEYS = {
    "cublas_workspace_config",
    "cuda_runtime_version",
    "cudnn_version",
    "device",
    "device_name",
    "protocol_sha256",
    "runner_sha256",
    "torch_version",
    "trainer_source_hash",
}
TRAINING_RECEIPT_KEYS = {
    "board_sizes",
    "checkpoint_artifacts",
    "checkpoint_gradient_steps",
    "completed_at_utc",
    "curve_snapshots",
    "device",
    "environment_steps_completed",
    "evidence_tier",
    "execution_identity",
    "experiment_id",
    "games_log_path",
    "games_log_sha256",
    "gradient_steps_completed",
    "manifest_sha256",
    "metrics_path",
    "metrics_sha256",
    "parameter_count",
    "puct_simulations",
    "representation",
    "resolved_config_path",
    "resolved_config_sha256",
    "result_kind",
    "schema_name",
    "schema_version",
    "seed",
    "self_play_games_completed",
    "status",
    "task_id",
    "training_budget",
    "wall_clock_seconds",
}
EVALUATION_RECEIPT_KEYS = {
    "a_as_black_games",
    "a_as_white_games",
    "a_losses",
    "a_wins",
    "agent_a",
    "agent_b",
    "agent_bindings",
    "agent_specs",
    "arena_csv_path",
    "arena_csv_sha256",
    "arena_games_path",
    "arena_games_sha256",
    "arena_summary_path",
    "arena_summary_sha256",
    "checkpoint_gradient_steps",
    "color_balance",
    "color_pairs_verified",
    "completed_at_utc",
    "draws",
    "eval_size",
    "evidence_tier",
    "execution_identity",
    "experiment_id",
    "games_completed",
    "games_requested",
    "manifest_sha256",
    "max_plies",
    "replay_verified_games",
    "result_kind",
    "schema_name",
    "schema_version",
    "seed",
    "status",
    "superko_mode",
    "task_id",
    "train_sizes",
    "truncated_games",
}
SNAPSHOT_KEYS = {
    "environment_steps",
    "gradient_steps",
    "loss",
    "policy_loss",
    "self_play_games",
    "value_loss",
    "wall_clock_seconds",
}
CHECKPOINT_KEYS = {
    "checkpoint_directory",
    "checkpoint_path",
    "checkpoint_sha256",
    "checkpoint_size_bytes",
    "config_hash",
    "created_at_utc",
    "gradient_steps",
    "iteration",
    "payload_counters",
    "source_hash",
    "wall_clock_seconds",
}
COUNTER_KEYS = {
    "environment_steps",
    "examples_seen",
    "games_attempted",
    "games_completed",
    "games_truncated",
    "gradient_steps",
    "iteration",
    "next_game_id",
}
LEARNED_BINDING_KEYS = {
    "checkpoint_config_hash",
    "checkpoint_sha256",
    "checkpoint_source_hash",
    "class",
    "gradient_steps",
    "kind",
    "name",
    "parameter_count",
    "representation",
    "search",
    "training_task_id",
}
BASELINE_BINDING_KEYS = {"agent_kind", "class", "config", "kind", "name"}
LEARNED_METADATA_CONFIG_KEYS = {
    "allow_superko_mode_override",
    "checkpoint",
    "device",
    "label",
    "legacy_architecture",
    "model_kind",
    "network_config",
    "observation_mode",
    "parameter_count",
    "schema_version",
    "search",
    "train_superko_mode",
    "trained_board_sizes",
}
LEARNED_METADATA_CHECKPOINT_KEYS = {
    "config_hash",
    "created_at_utc",
    "games_completed",
    "gradient_steps",
    "iteration",
    "path",
    "sha256",
    "source_hash",
}

CSV_HEADERS = {
    "training_curve": [
        "representation",
        "train_sizes",
        "gradient_steps",
        "completed_seeds",
        "mean_self_play_games",
        "mean_environment_steps",
        "mean_loss",
        "mean_policy_loss",
        "mean_value_loss",
        "mean_wall_clock_seconds",
    ],
    "arena_learning_curve": [
        "agent_a_id",
        "eval_size",
        "checkpoint_gradient_steps",
        "agent_b_id",
        "seed_receipts",
        "completed_seed_receipts",
        "failed_seed_receipts",
        "games_completed",
        "a_wins",
        "a_losses",
        "draws",
        "a_score_rate",
        "a_score_ci95_wilson",
        "failure_reasons",
    ],
    "final_vs_search": [
        "agent_a_id",
        "eval_size",
        "agent_b_id",
        "seed_receipts",
        "completed_seed_receipts",
        "failed_seed_receipts",
        "games_completed",
        "a_wins",
        "a_losses",
        "draws",
        "a_score_rate",
        "a_score_ci95_wilson",
        "failure_reasons",
    ],
    "representation_round_robin": [
        "eval_size",
        "agent_a_id",
        "agent_b_id",
        "seed_receipts",
        "completed_seed_receipts",
        "failed_seed_receipts",
        "games_completed",
        "a_wins",
        "a_losses",
        "draws",
        "a_score_rate",
        "a_score_ci95_wilson",
        "failure_reasons",
    ],
}
CSV_INTEGER_FIELDS = {
    "gradient_steps",
    "completed_seeds",
    "eval_size",
    "checkpoint_gradient_steps",
    "seed_receipts",
    "completed_seed_receipts",
    "failed_seed_receipts",
    "games_completed",
    "a_wins",
    "a_losses",
    "draws",
}
CSV_FLOAT_FIELDS = {
    "mean_self_play_games",
    "mean_environment_steps",
    "mean_loss",
    "mean_policy_loss",
    "mean_value_loss",
    "mean_wall_clock_seconds",
    "a_score_rate",
}
CSV_JSON_FIELDS = {"train_sizes", "a_score_ci95_wilson", "failure_reasons"}
ROW_KEYS = {
    "training_curve": ("representation", "gradient_steps"),
    "arena_learning_curve": (
        "agent_a_id",
        "eval_size",
        "checkpoint_gradient_steps",
        "agent_b_id",
    ),
    "final_vs_search": ("agent_a_id", "eval_size", "agent_b_id"),
    "representation_round_robin": ("eval_size", "agent_a_id", "agent_b_id"),
}


class AuditError(RuntimeError):
    """A fail-closed tracked-metadata consistency error."""


@dataclass(frozen=True)
class AuditInputs:
    manifest: Path
    manifest_snapshot: Path
    training_tasks: Path
    evaluation_tasks: Path
    receipts: Path
    aggregate: Path
    training_curve_csv: Path
    arena_learning_curve_csv: Path
    final_vs_search_csv: Path
    representation_round_robin_csv: Path
    prior_audit: Path


def default_inputs() -> AuditInputs:
    return AuditInputs(
        manifest=MANIFEST,
        manifest_snapshot=BUNDLE / "manifest_snapshot.json",
        training_tasks=BUNDLE / "training_tasks.jsonl",
        evaluation_tasks=BUNDLE / "evaluation_tasks.jsonl",
        receipts=RUN / "result_receipts.jsonl",
        aggregate=AGGREGATE_DIR / "aggregate.json",
        training_curve_csv=AGGREGATE_DIR / "training_curve.csv",
        arena_learning_curve_csv=AGGREGATE_DIR / "arena_learning_curve.csv",
        final_vs_search_csv=AGGREGATE_DIR / "final_vs_search.csv",
        representation_round_robin_csv=(
            AGGREGATE_DIR / "representation_round_robin.csv"
        ),
        prior_audit=PRIOR_AUDIT,
    )


class TrackedReader:
    """Read only caller-declared metadata inputs and retain their byte identity."""

    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}
        self._identities: dict[tuple[int, int], str] = {}

    def read(self, label: str, path: Path) -> bytes:
        if label in self._records:
            raise AuditError(f"internal duplicate input label: {label}")
        try:
            declared = path.absolute()
            resolved = path.resolve(strict=True)
            metadata = os.lstat(declared)
        except OSError as exc:
            raise AuditError(
                f"tracked input is missing or unreadable: {label}"
            ) from exc
        attributes = getattr(metadata, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if (
            declared != resolved
            or not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or bool(attributes & reparse_flag)
            or metadata.st_size > MAX_INPUT_BYTES
        ):
            raise AuditError(
                f"tracked input must be a bounded canonical plain file: {label}"
            )

        def signature(value: os.stat_result) -> tuple[int, int, int, int, int]:
            return (
                value.st_dev,
                value.st_ino,
                stat.S_IFMT(value.st_mode),
                value.st_size,
                value.st_mtime_ns,
            )

        try:
            before = resolved.stat()
            with resolved.open("rb") as stream:
                opened_before = os.fstat(stream.fileno())
                data = stream.read(MAX_INPUT_BYTES + 1)
                opened_after = os.fstat(stream.fileno())
            after = resolved.stat()
            final_declared = os.lstat(declared)
            final_resolved = declared.resolve(strict=True)
        except OSError as exc:
            raise AuditError(f"cannot read tracked input: {label}") from exc
        final_attributes = getattr(final_declared, "st_file_attributes", 0)
        if (
            len(data) > MAX_INPUT_BYTES
            or len(data) != before.st_size
            or final_resolved != resolved
            or stat.S_ISLNK(final_declared.st_mode)
            or bool(final_attributes & reparse_flag)
            or not (
                signature(metadata)
                == signature(before)
                == signature(opened_before)
                == signature(opened_after)
                == signature(after)
                == signature(final_declared)
            )
        ):
            raise AuditError(f"tracked input changed while being read: {label}")
        identity = (opened_after.st_dev, opened_after.st_ino)
        prior_label = self._identities.get(identity)
        if prior_label is not None:
            raise AuditError(
                "tracked input labels must bind distinct plain-file identities: "
                f"{prior_label}, {label}"
            )
        if self.total_bytes + len(data) > MAX_TOTAL_INPUT_BYTES:
            raise AuditError("tracked metadata inputs exceed the total byte bound")
        self._identities[identity] = label
        self._records[label] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size_bytes": len(data),
        }
        return data

    @property
    def records(self) -> dict[str, dict[str, Any]]:
        return {key: dict(value) for key, value in sorted(self._records.items())}

    @property
    def total_bytes(self) -> int:
        return sum(int(value["size_bytes"]) for value in self._records.values())

    @property
    def distinct_files(self) -> int:
        return len(self._identities)


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number is forbidden: {value}")


def _strict_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def strict_json_bytes(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise AuditError(f"{label}: invalid UTF-8") from exc
    if text.startswith("\ufeff"):
        raise AuditError(f"{label}: UTF-8 BOM is forbidden")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_strict_pairs,
            parse_constant=_reject_constant,
        )
    except RecursionError as exc:
        raise AuditError(
            f"{label}: JSON nesting exceeds maximum depth {MAX_JSON_DEPTH}"
        ) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise AuditError(f"{label}: strict JSON parse failed: {exc}") from exc

    pending = [(value, 0)]
    while pending:
        child, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise AuditError(
                f"{label}: JSON nesting exceeds maximum depth {MAX_JSON_DEPTH}"
            )
        if isinstance(child, float) and not math.isfinite(child):
            raise AuditError(f"{label}: non-finite JSON number is forbidden")
        if isinstance(child, dict):
            pending.extend((nested, depth + 1) for nested in child.values())
        elif isinstance(child, list):
            pending.extend((nested, depth + 1) for nested in child)

    return value


def strict_jsonl_bytes(data: bytes, label: str) -> list[tuple[dict[str, Any], bytes]]:
    if not data:
        raise AuditError(f"{label}: JSONL input is empty")
    if not data.endswith(b"\n"):
        raise AuditError(f"{label}: JSONL must end with a newline")
    raw_lines = data.splitlines()
    rows: list[tuple[dict[str, Any], bytes]] = []
    for line_number, raw_line in enumerate(raw_lines, start=1):
        if not raw_line or not raw_line.strip():
            raise AuditError(f"{label}: blank JSONL line {line_number}")
        if raw_line != raw_line.strip():
            raise AuditError(f"{label}: surrounding whitespace on line {line_number}")
        value = strict_json_bytes(raw_line, f"{label} line {line_number}")
        if not isinstance(value, dict):
            raise AuditError(f"{label}: line {line_number} is not an object")
        rows.append((value, raw_line))
    return rows


def canonical_json(value: Any, *, ensure_ascii: bool = True) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=ensure_ascii,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise AuditError(
            "value cannot be represented as finite canonical JSON"
        ) from exc


def _exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AuditError(f"{label}: expected object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise AuditError(
            f"{label}: field closure mismatch; missing={missing}, extra={extra}"
        )
    return value


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise AuditError(f"{label}: expected non-empty string")
    return value


def _require_int(
    value: Any,
    label: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    if type(value) is not int:
        raise AuditError(f"{label}: expected JSON integer")
    if minimum is not None and value < minimum:
        raise AuditError(f"{label}: integer is below {minimum}")
    if maximum is not None and value > maximum:
        raise AuditError(f"{label}: integer is above {maximum}")
    return value


def _require_number(value: Any, label: str, *, minimum: float | None = None) -> float:
    if type(value) not in {int, float}:
        raise AuditError(f"{label}: expected finite JSON number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise AuditError(f"{label}: expected finite JSON number") from exc
    if not math.isfinite(number):
        raise AuditError(f"{label}: expected finite JSON number")
    if minimum is not None and number < minimum:
        raise AuditError(f"{label}: number is below {minimum}")
    return number


def _require_hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or not HEX64_RE.fullmatch(value):
        raise AuditError(f"{label}: expected lowercase SHA-256")
    return value


def _compare_exact(expected: Any, actual: Any, label: str) -> None:
    if type(expected) is not type(actual):
        raise AuditError(
            f"{label}: JSON type mismatch ({type(expected).__name__} != "
            f"{type(actual).__name__})"
        )
    if isinstance(expected, dict):
        if set(expected) != set(actual):
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            raise AuditError(
                f"{label}: field closure mismatch; missing={missing}, extra={extra}"
            )
        for key in expected:
            _compare_exact(expected[key], actual[key], f"{label}.{key}")
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            raise AuditError(f"{label}: list length mismatch")
        for index, (left, right) in enumerate(zip(expected, actual)):
            _compare_exact(left, right, f"{label}[{index}]")
    elif expected != actual:
        raise AuditError(f"{label}: value mismatch")


def _compare_numeric(expected: Any, actual: Any, label: str) -> None:
    if type(expected) is int:
        if type(actual) is not int or actual != expected:
            raise AuditError(f"{label}: exact integer mismatch")
        return
    if type(expected) is float:
        if type(actual) is not float or not math.isfinite(actual):
            raise AuditError(f"{label}: expected finite JSON float")
        if abs(expected - actual) > FLOAT_TOLERANCE:
            raise AuditError(f"{label}: float mismatch above {FLOAT_TOLERANCE}")
        return
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or set(expected) != set(actual):
            raise AuditError(f"{label}: object field closure mismatch")
        for key in expected:
            _compare_numeric(expected[key], actual[key], f"{label}.{key}")
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            raise AuditError(f"{label}: list shape mismatch")
        for index, (left, right) in enumerate(zip(expected, actual)):
            _compare_numeric(left, right, f"{label}[{index}]")
        return
    if type(expected) is not type(actual) or expected != actual:
        raise AuditError(f"{label}: value or JSON type mismatch")


def validate_manifest(manifest: Any) -> None:
    manifest = _exact_keys(manifest, MANIFEST_KEYS, "manifest")
    fixed = {
        "schema_name": "lifeline-d14-d16-experiment-manifest",
        "schema_version": 1,
        "experiment_id": "d14_d16_three_representation_formal_v1",
        "evidence_tier": "formal",
        "status": "frozen_not_run",
        "task_scope": "mixed_size_train_same_size_eval",
        "train_sizes": [5, 7, 9],
        "seeds": [20260825, 20260826, 20260827, 20260828, 20260829],
    }
    for field, expected in fixed.items():
        _compare_exact(expected, manifest[field], f"manifest.{field}")

    representations = manifest["representations"]
    if not isinstance(representations, list) or len(representations) != 3:
        raise AuditError("manifest.representations: expected three entries")
    if [
        entry.get("id") if isinstance(entry, dict) else None
        for entry in representations
    ] != [
        "padded_cnn",
        "grid_gnn",
        "topology_gnn",
    ]:
        raise AuditError("manifest.representations: frozen order or ids drifted")
    for index, entry in enumerate(representations):
        entry = _exact_keys(
            entry, REPRESENTATION_KEYS, f"manifest.representations[{index}]"
        )
        _require_string(
            entry["observation"], f"manifest.representations[{index}].observation"
        )
        _require_string(
            entry["model_family"], f"manifest.representations[{index}].model_family"
        )
        config = _exact_keys(
            entry["model_config"],
            {"hidden_channels", "message_passing_layers"},
            f"manifest.representations[{index}].model_config",
        )
        _require_int(
            config["hidden_channels"], "model_config.hidden_channels", minimum=1
        )
        _require_int(
            config["message_passing_layers"],
            "model_config.message_passing_layers",
            minimum=1,
        )
        _require_int(
            entry["expected_trainable_parameters"],
            f"manifest.representations[{index}].expected_trainable_parameters",
            minimum=1,
        )

    budget = _exact_keys(
        manifest["training_budget"], TRAINING_BUDGET_KEYS, "training_budget"
    )
    integer_budget_fields = {
        "puct_simulations",
        "self_play_games",
        "gradient_steps",
        "max_plies",
        "replay_capacity",
        "batch_size",
        "iterations",
        "games_per_iteration",
        "training_steps_per_iteration",
        "checkpoint_every_iterations",
        "temperature_moves",
    }
    for field in integer_budget_fields:
        _require_int(
            budget[field],
            f"training_budget.{field}",
            minimum=0 if field == "temperature_moves" else 1,
        )
    for field in (
        "c_puct",
        "dirichlet_alpha",
        "dirichlet_epsilon",
        "initial_temperature",
        "final_temperature",
        "learning_rate",
        "weight_decay",
        "gradient_clip_norm",
    ):
        _require_number(budget[field], f"training_budget.{field}", minimum=0.0)
    if (
        budget["terminal_reward"] != "win_draw_loss_only"
        or budget["superko_mode"] != "enforce"
    ):
        raise AuditError("training_budget: frozen reward or Superko contract drifted")
    if (
        budget["iterations"] * budget["games_per_iteration"]
        != budget["self_play_games"]
    ):
        raise AuditError("training_budget: self-play schedule does not close")
    if (
        budget["iterations"] * budget["training_steps_per_iteration"]
        != budget["gradient_steps"]
    ):
        raise AuditError("training_budget: optimizer schedule does not close")
    if budget["iterations"] % budget["checkpoint_every_iterations"]:
        raise AuditError(
            "training_budget: checkpoint schedule does not divide iterations"
        )

    evaluation = _exact_keys(manifest["evaluation"], EVALUATION_KEYS, "evaluation")
    for field in ("curve_games_per_matchup", "final_games_per_matchup", "max_plies"):
        _require_int(evaluation[field], f"evaluation.{field}", minimum=1)
    for field in ("curve_games_per_matchup", "final_games_per_matchup"):
        if evaluation[field] % 2:
            raise AuditError(f"evaluation.{field}: paired games must be even")
    if evaluation["color_balance"] != "paired_swap_same_seed":
        raise AuditError("evaluation.color_balance: frozen pairing contract drifted")
    if (
        evaluation["max_plies"] != budget["max_plies"]
        or evaluation["superko_mode"] != budget["superko_mode"]
    ):
        raise AuditError("evaluation: training/evaluation budget mismatch")
    checkpoints = evaluation["checkpoint_gradient_steps"]
    if not isinstance(checkpoints, list) or any(
        type(value) is not int for value in checkpoints
    ):
        raise AuditError("evaluation.checkpoint_gradient_steps: expected integer list")
    expected_checkpoints = [
        iteration * budget["training_steps_per_iteration"]
        for iteration in range(
            budget["checkpoint_every_iterations"],
            budget["iterations"] + 1,
            budget["checkpoint_every_iterations"],
        )
    ]
    _compare_exact(
        expected_checkpoints, checkpoints, "evaluation.checkpoint_gradient_steps"
    )
    _compare_exact(
        "uct_mcts_16", evaluation["curve_opponent"], "evaluation.curve_opponent"
    )
    _compare_exact(
        ["random", "uct_mcts_16"],
        evaluation["final_search_opponents"],
        "evaluation.final_search_opponents",
    )
    if evaluation["representation_round_robin"] is not True:
        raise AuditError("evaluation.representation_round_robin must be true")

    baselines = manifest["search_baselines"]
    if not isinstance(baselines, list) or len(baselines) != 5:
        raise AuditError("manifest.search_baselines: expected five entries")
    expected_baselines = [
        ("random", "random"),
        ("greedy", "greedy"),
        ("minimax_2_cap20", "minimax-2"),
        ("minimax_3_cap20", "minimax-3"),
        ("uct_mcts_16", "mcts"),
    ]
    for index, (entry, expected_pair) in enumerate(zip(baselines, expected_baselines)):
        entry = _exact_keys(
            entry, {"id", "agent_kind", "config"}, f"search_baselines[{index}]"
        )
        _compare_exact(expected_pair[0], entry["id"], f"search_baselines[{index}].id")
        _compare_exact(
            expected_pair[1],
            entry["agent_kind"],
            f"search_baselines[{index}].agent_kind",
        )
        if not isinstance(entry["config"], dict):
            raise AuditError(f"search_baselines[{index}].config: expected object")

    matching = _exact_keys(manifest["matching"], MATCHING_KEYS, "matching")
    if not isinstance(matching["exact_fields"], list) or any(
        not isinstance(value, str) or not value for value in matching["exact_fields"]
    ):
        raise AuditError("matching.exact_fields: expected non-empty string list")
    if len(matching["exact_fields"]) != len(set(matching["exact_fields"])):
        raise AuditError("matching.exact_fields: duplicates are forbidden")
    if matching["parameter_count_scope"] != "trainable_parameters_per_seed":
        raise AuditError("matching.parameter_count_scope drifted")
    _require_number(
        matching["parameter_count_relative_tolerance"],
        "matching.parameter_count_relative_tolerance",
        minimum=0.0,
    )
    if matching["wall_clock_seconds"] != "reported_not_matched":
        raise AuditError("matching.wall_clock_seconds drifted")
    if not isinstance(manifest["notes"], list) or any(
        not isinstance(value, str) or not value for value in manifest["notes"]
    ):
        raise AuditError("manifest.notes: expected non-empty strings")


def manifest_digest(manifest: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(manifest, ensure_ascii=True)).hexdigest()


def generate_expected_tasks(
    manifest: Mapping[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    representations = [entry["id"] for entry in manifest["representations"]]
    representation_entries = {
        entry["id"]: entry for entry in manifest["representations"]
    }
    sizes = list(manifest["train_sizes"])
    seeds = list(manifest["seeds"])
    budget = dict(manifest["training_budget"])
    evaluation = manifest["evaluation"]
    checkpoints = list(evaluation["checkpoint_gradient_steps"])
    final_step = checkpoints[-1]
    baseline_by_id = {entry["id"]: entry for entry in manifest["search_baselines"]}
    digest = manifest_digest(manifest)

    def header(task_id: str, kind: str) -> dict[str, Any]:
        return {
            "schema_name": "lifeline-d14-d16-task",
            "schema_version": 1,
            "experiment_id": manifest["experiment_id"],
            "manifest_sha256": digest,
            "evidence_tier": manifest["evidence_tier"],
            "task_id": task_id,
            "task_kind": kind,
        }

    training: list[dict[str, Any]] = []
    training_ids: dict[tuple[str, int], str] = {}
    size_slug = "-".join(str(size) for size in sizes)
    for representation in representations:
        for seed in seeds:
            task_id = f"train.mixed_n{size_slug}.{representation}.seed{seed}"
            training.append(
                {
                    **header(task_id, "training"),
                    "representation": representation,
                    "board_sizes": sizes,
                    "seed": seed,
                    "model_config": representation_entries[representation][
                        "model_config"
                    ],
                    "expected_trainable_parameters": representation_entries[
                        representation
                    ]["expected_trainable_parameters"],
                    "training_budget": budget,
                    "required_checkpoint_gradient_steps": checkpoints,
                    "output_tier": manifest["evidence_tier"],
                }
            )
            training_ids[(representation, seed)] = task_id

    def learned_agent(representation: str, seed: int, step: int) -> dict[str, Any]:
        return {
            "kind": "learned_checkpoint",
            "representation": representation,
            "training_task_id": training_ids[(representation, seed)],
            "gradient_steps": step,
            "search": {
                "simulations": budget["puct_simulations"],
                "c_puct": budget["c_puct"],
                "temperature": 0.0,
            },
        }

    evaluation_tasks: list[dict[str, Any]] = []

    def append_baseline(
        purpose: str,
        representation: str,
        size: int,
        seed: int,
        step: int,
        baseline_id: str,
        games: int,
        purposes: list[str],
    ) -> None:
        task_id = f"eval.{purpose}.n{size}.{representation}.seed{seed}.gs{step}.vs.{baseline_id}"
        baseline = baseline_by_id[baseline_id]
        evaluation_tasks.append(
            {
                **header(task_id, "evaluation"),
                "evaluation_kind": purpose,
                "purposes": purposes,
                "train_sizes": sizes,
                "eval_size": size,
                "seed": seed,
                "checkpoint_gradient_steps": step,
                "agent_a": learned_agent(representation, seed, step),
                "agent_b": {
                    "kind": "search_baseline",
                    "baseline_id": baseline_id,
                    "agent_kind": baseline["agent_kind"],
                    "config": baseline["config"],
                },
                "games": games,
                "color_balance": evaluation["color_balance"],
                "max_plies": evaluation["max_plies"],
                "superko_mode": evaluation["superko_mode"],
            }
        )

    for size in sizes:
        for representation in representations:
            for seed in seeds:
                for step in checkpoints[:-1]:
                    append_baseline(
                        "learning_curve",
                        representation,
                        size,
                        seed,
                        step,
                        evaluation["curve_opponent"],
                        evaluation["curve_games_per_matchup"],
                        ["learning_curve"],
                    )
                for baseline_id in evaluation["final_search_opponents"]:
                    purposes = ["final_vs_search"]
                    if baseline_id == evaluation["curve_opponent"]:
                        purposes.append("learning_curve")
                    append_baseline(
                        "final_vs_search",
                        representation,
                        size,
                        seed,
                        final_step,
                        baseline_id,
                        evaluation["final_games_per_matchup"],
                        purposes,
                    )

    for size in sizes:
        for seed in seeds:
            for left_index, representation_a in enumerate(representations):
                for representation_b in representations[left_index + 1 :]:
                    task_id = (
                        f"eval.representation_round_robin.n{size}.seed{seed}."
                        f"{representation_a}.vs.{representation_b}.gs{final_step}"
                    )
                    evaluation_tasks.append(
                        {
                            **header(task_id, "evaluation"),
                            "evaluation_kind": "representation_round_robin",
                            "purposes": ["representation_round_robin"],
                            "train_sizes": sizes,
                            "eval_size": size,
                            "seed": seed,
                            "checkpoint_gradient_steps": final_step,
                            "agent_a": learned_agent(
                                representation_a, seed, final_step
                            ),
                            "agent_b": learned_agent(
                                representation_b, seed, final_step
                            ),
                            "games": evaluation["final_games_per_matchup"],
                            "color_balance": evaluation["color_balance"],
                            "max_plies": evaluation["max_plies"],
                            "superko_mode": evaluation["superko_mode"],
                        }
                    )
    if (
        len(training) != EXPECTED_TRAINING_TASKS
        or len(evaluation_tasks) != EXPECTED_EVALUATION_TASKS
    ):
        raise AuditError("manifest-derived formal task counts drifted")
    return {"training": training, "evaluation": evaluation_tasks}


def _map_by_task_id(
    rows: Iterable[dict[str, Any]], label: str
) -> dict[str, dict[str, Any]]:
    mapped: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows):
        task_id = _require_string(row.get("task_id"), f"{label}[{index}].task_id")
        if task_id in mapped:
            raise AuditError(f"{label}: duplicate task_id")
        mapped[task_id] = row
    return mapped


def compare_task_bundle(
    expected: Mapping[str, Sequence[dict[str, Any]]],
    observed_training: Sequence[dict[str, Any]],
    observed_evaluation: Sequence[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    expected_training = _map_by_task_id(expected["training"], "expected training tasks")
    expected_evaluation = _map_by_task_id(
        expected["evaluation"], "expected evaluation tasks"
    )
    actual_training = _map_by_task_id(observed_training, "training task bundle")
    actual_evaluation = _map_by_task_id(observed_evaluation, "evaluation task bundle")
    for label, left, right in (
        ("training task bundle", expected_training, actual_training),
        ("evaluation task bundle", expected_evaluation, actual_evaluation),
    ):
        if set(left) != set(right):
            raise AuditError(
                f"{label}: task_id set mismatch; missing={len(set(left) - set(right))}, "
                f"extra={len(set(right) - set(left))}"
            )
        for task_id in sorted(left):
            _compare_exact(left[task_id], right[task_id], f"{label}:{task_id}")
    return {**expected_training, **expected_evaluation}


def _is_hash_binding_key(key: str) -> bool:
    lowered = key.lower()
    return "sha256" in lowered or lowered.endswith("_hash")


def _encoded_hash_path(components: Sequence[str | int]) -> str:
    return "hashpath-v1:" + json.dumps(
        list(components),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def _legacy_hash_path(components: Sequence[str | int]) -> str:
    path = "$"
    for component in components:
        path += f".{component}" if isinstance(component, str) else f"[{component}]"
    return path


def flatten_hash_bindings(value: Any) -> dict[str, str]:
    found: dict[str, str] = {}
    legacy_origins: dict[str, str] = {}

    def visit(child: Any, components: tuple[str | int, ...]) -> None:
        if isinstance(child, dict):
            for key, nested in child.items():
                nested_components = (*components, key)
                if _is_hash_binding_key(key):
                    digest = _require_hash(
                        nested, f"hash binding {_legacy_hash_path(nested_components)}"
                    )
                    encoded = _encoded_hash_path(nested_components)
                    legacy = _legacy_hash_path(nested_components)
                    previous = legacy_origins.get(legacy)
                    if previous is not None and previous != encoded:
                        raise AuditError(
                            f"lossy flattened hash-path collision: {legacy}"
                        )
                    if encoded in found:
                        raise AuditError("duplicate encoded hash-binding path")
                    legacy_origins[legacy] = encoded
                    found[encoded] = digest
                else:
                    visit(nested, nested_components)
        elif isinstance(child, list):
            for index, nested in enumerate(child):
                visit(nested, (*components, index))

    visit(value, ())
    return found


def _validate_identity(value: Any, label: str) -> dict[str, Any]:
    identity = _exact_keys(value, IDENTITY_KEYS, label)
    for field in ("protocol_sha256", "runner_sha256", "trainer_source_hash"):
        _require_hash(identity[field], f"{label}.{field}")
    for field in (
        "cublas_workspace_config",
        "cuda_runtime_version",
        "device",
        "device_name",
        "torch_version",
    ):
        _require_string(identity[field], f"{label}.{field}")
    _require_int(identity["cudnn_version"], f"{label}.cudnn_version", minimum=1)
    return identity


def _validate_common_receipt(
    receipt: dict[str, Any],
    task: Mapping[str, Any],
    expected_manifest_digest: str,
) -> tuple[dict[str, Any], int]:
    expected_common = {
        "schema_name": "lifeline-d14-d16-result",
        "schema_version": 1,
        "experiment_id": task["experiment_id"],
        "task_id": task["task_id"],
        "result_kind": task["task_kind"],
        "status": "complete",
        "evidence_tier": task["evidence_tier"],
        "manifest_sha256": expected_manifest_digest,
    }
    for field, expected in expected_common.items():
        _compare_exact(expected, receipt[field], f"{task['task_id']}.{field}")
    _require_string(receipt["completed_at_utc"], f"{task['task_id']}.completed_at_utc")
    identity = _validate_identity(
        receipt["execution_identity"], f"{task['task_id']}.execution_identity"
    )
    bindings = flatten_hash_bindings(receipt)
    return identity, len(bindings)


def _validate_training_receipt(
    receipt: dict[str, Any],
    task: Mapping[str, Any],
    expected_manifest_digest: str,
) -> dict[int, dict[str, Any]]:
    _exact_keys(receipt, TRAINING_RECEIPT_KEYS, f"training receipt {task['task_id']}")
    identity, hash_count = _validate_common_receipt(
        receipt, task, expected_manifest_digest
    )
    if hash_count != 22:
        raise AuditError(f"{task['task_id']}: expected 22 typed hash bindings")
    for field in ("representation", "board_sizes", "seed"):
        _compare_exact(task[field], receipt[field], f"{task['task_id']}.{field}")
    _compare_exact(
        task["training_budget"],
        receipt["training_budget"],
        f"{task['task_id']}.training_budget",
    )
    _compare_exact(
        task["required_checkpoint_gradient_steps"],
        receipt["checkpoint_gradient_steps"],
        f"{task['task_id']}.checkpoint_gradient_steps",
    )
    _compare_exact(
        task["expected_trainable_parameters"],
        receipt["parameter_count"],
        f"{task['task_id']}.parameter_count",
    )
    budget = task["training_budget"]
    for field, expected in (
        ("puct_simulations", budget["puct_simulations"]),
        ("self_play_games_completed", budget["self_play_games"]),
        ("gradient_steps_completed", budget["gradient_steps"]),
    ):
        _compare_exact(expected, receipt[field], f"{task['task_id']}.{field}")
    _require_int(
        receipt["environment_steps_completed"],
        f"{task['task_id']}.environment_steps_completed",
        minimum=1,
        maximum=MAX_EXACT_FLOAT_INTEGER,
    )
    _require_number(
        receipt["wall_clock_seconds"],
        f"{task['task_id']}.wall_clock_seconds",
        minimum=0.0,
    )
    _compare_exact(identity["device"], receipt["device"], f"{task['task_id']}.device")
    for field in ("resolved_config_path", "metrics_path", "games_log_path"):
        _require_string(receipt[field], f"{task['task_id']}.{field}")
    for field in ("resolved_config_sha256", "metrics_sha256", "games_log_sha256"):
        _require_hash(receipt[field], f"{task['task_id']}.{field}")

    snapshots = receipt["curve_snapshots"]
    if not isinstance(snapshots, list) or len(snapshots) != len(
        task["required_checkpoint_gradient_steps"]
    ):
        raise AuditError(f"{task['task_id']}: curve snapshot count mismatch")
    snapshots_by_step: dict[int, dict[str, Any]] = {}
    prior_environment = -1
    prior_wall_clock = -1.0
    for index, snapshot in enumerate(snapshots):
        snapshot = _exact_keys(
            snapshot, SNAPSHOT_KEYS, f"{task['task_id']}.curve_snapshots[{index}]"
        )
        step = _require_int(
            snapshot["gradient_steps"], "curve_snapshot.gradient_steps", minimum=1
        )
        expected_step = task["required_checkpoint_gradient_steps"][index]
        _compare_exact(
            expected_step,
            step,
            f"{task['task_id']}.curve_snapshots[{index}].gradient_steps",
        )
        expected_iteration = step // budget["training_steps_per_iteration"]
        expected_games = expected_iteration * budget["games_per_iteration"]
        _compare_exact(
            expected_games,
            snapshot["self_play_games"],
            f"{task['task_id']}.curve_snapshots[{index}].self_play_games",
        )
        environment = _require_int(
            snapshot["environment_steps"],
            f"{task['task_id']}.curve_snapshots[{index}].environment_steps",
            minimum=1,
            maximum=MAX_EXACT_FLOAT_INTEGER,
        )
        if environment < prior_environment:
            raise AuditError(
                f"{task['task_id']}: environment-step curve is not monotonic"
            )
        prior_environment = environment
        for field in ("loss", "policy_loss", "value_loss", "wall_clock_seconds"):
            _require_number(
                snapshot[field],
                f"{task['task_id']}.curve_snapshots[{index}].{field}",
                minimum=0.0,
            )
        wall_clock = float(snapshot["wall_clock_seconds"])
        if wall_clock < prior_wall_clock:
            raise AuditError(
                f"{task['task_id']}: checkpoint wall clock is not monotonic"
            )
        prior_wall_clock = wall_clock
        snapshots_by_step[step] = snapshot

    artifacts = receipt["checkpoint_artifacts"]
    if not isinstance(artifacts, list) or len(artifacts) != len(snapshots):
        raise AuditError(f"{task['task_id']}: checkpoint artifact count mismatch")
    artifacts_by_step: dict[int, dict[str, Any]] = {}
    checkpoint_config_hashes: set[str] = set()
    for index, artifact in enumerate(artifacts):
        artifact = _exact_keys(
            artifact,
            CHECKPOINT_KEYS,
            f"{task['task_id']}.checkpoint_artifacts[{index}]",
        )
        step = _require_int(
            artifact["gradient_steps"], "checkpoint.gradient_steps", minimum=1
        )
        _compare_exact(
            task["required_checkpoint_gradient_steps"][index],
            step,
            f"{task['task_id']}.checkpoint_artifacts[{index}].gradient_steps",
        )
        expected_iteration = step // budget["training_steps_per_iteration"]
        expected_games = expected_iteration * budget["games_per_iteration"]
        _compare_exact(
            expected_iteration,
            artifact["iteration"],
            f"{task['task_id']}.checkpoint.iteration",
        )
        for field in ("checkpoint_directory", "checkpoint_path", "created_at_utc"):
            _require_string(artifact[field], f"{task['task_id']}.checkpoint.{field}")
        _require_hash(
            artifact["checkpoint_sha256"],
            f"{task['task_id']}.checkpoint.checkpoint_sha256",
        )
        _require_hash(
            artifact["config_hash"], f"{task['task_id']}.checkpoint.config_hash"
        )
        _require_hash(
            artifact["source_hash"], f"{task['task_id']}.checkpoint.source_hash"
        )
        checkpoint_config_hashes.add(artifact["config_hash"])
        _compare_exact(
            identity["trainer_source_hash"],
            artifact["source_hash"],
            f"{task['task_id']}.checkpoint.source_hash",
        )
        _require_int(
            artifact["checkpoint_size_bytes"],
            f"{task['task_id']}.checkpoint_size_bytes",
            minimum=1,
        )
        _require_number(
            artifact["wall_clock_seconds"],
            f"{task['task_id']}.checkpoint.wall_clock_seconds",
            minimum=0.0,
        )
        counters = _exact_keys(
            artifact["payload_counters"],
            COUNTER_KEYS,
            f"{task['task_id']}.checkpoint.payload_counters",
        )
        expected_counters = {
            "examples_seen": budget["batch_size"] * step,
            "games_attempted": expected_games,
            "games_completed": expected_games,
            "games_truncated": 0,
            "gradient_steps": step,
            "iteration": expected_iteration,
            "next_game_id": expected_games,
        }
        for field, expected in expected_counters.items():
            _compare_exact(
                expected,
                counters[field],
                f"{task['task_id']}.checkpoint.payload_counters.{field}",
            )
        _compare_exact(
            snapshots_by_step[step]["environment_steps"],
            counters["environment_steps"],
            f"{task['task_id']}.checkpoint.payload_counters.environment_steps",
        )
        _compare_exact(
            snapshots_by_step[step]["wall_clock_seconds"],
            artifact["wall_clock_seconds"],
            f"{task['task_id']}.checkpoint.wall_clock_seconds",
        )
        artifacts_by_step[step] = artifact
    if len(checkpoint_config_hashes) != 1:
        raise AuditError(f"{task['task_id']}: checkpoint config hash is not stable")
    final_step = task["required_checkpoint_gradient_steps"][-1]
    _compare_exact(
        snapshots_by_step[final_step]["environment_steps"],
        receipt["environment_steps_completed"],
        f"{task['task_id']}.environment_steps_completed",
    )
    if float(receipt["wall_clock_seconds"]) < float(
        artifacts_by_step[final_step]["wall_clock_seconds"]
    ):
        raise AuditError(
            f"{task['task_id']}: final wall clock precedes final checkpoint"
        )
    return artifacts_by_step


def _expected_learned_metadata(
    spec: Mapping[str, Any],
    task: Mapping[str, Any],
    manifest: Mapping[str, Any],
    artifact: Mapping[str, Any],
    identity: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    representation = spec["representation"]
    representation_entry = next(
        entry for entry in manifest["representations"] if entry["id"] == representation
    )
    name = f"{representation}-seed{task['seed']}-gs{spec['gradient_steps']}"
    class_name = "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent"
    binding = {
        "kind": "learned_checkpoint",
        "representation": representation,
        "training_task_id": spec["training_task_id"],
        "gradient_steps": spec["gradient_steps"],
        "search": spec["search"],
        "checkpoint_sha256": artifact["checkpoint_sha256"],
        "checkpoint_config_hash": artifact["config_hash"],
        "checkpoint_source_hash": artifact["source_hash"],
        "parameter_count": representation_entry["expected_trainable_parameters"],
        "class": class_name,
        "name": name,
    }
    metadata = {
        "name": name,
        "class": class_name,
        "config": {
            "schema_version": 1,
            "model_kind": representation,
            "network_config": representation_entry["model_config"],
            "observation_mode": "topology"
            if representation == "topology_gnn"
            else "grid_graph",
            "trained_board_sizes": manifest["train_sizes"],
            "train_superko_mode": manifest["training_budget"]["superko_mode"],
            "parameter_count": representation_entry["expected_trainable_parameters"],
            "checkpoint": {
                "path": artifact["checkpoint_path"],
                "sha256": artifact["checkpoint_sha256"],
                "source_hash": artifact["source_hash"],
                "config_hash": artifact["config_hash"],
                "created_at_utc": artifact["created_at_utc"],
                "iteration": artifact["iteration"],
                "gradient_steps": artifact["gradient_steps"],
                "games_completed": artifact["payload_counters"]["games_completed"],
            },
            "search": spec["search"],
            "allow_superko_mode_override": False,
            "device": identity["device"],
            "label": name,
            "legacy_architecture": None,
        },
    }
    return binding, metadata


def _expected_baseline_metadata(
    spec: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    baseline_id = spec["baseline_id"]
    kind = spec["agent_kind"]
    if baseline_id == "random" and kind == "random" and spec["config"] == {}:
        class_name = "lifeline_rl.agents.random_agent.RandomAgent"
        name = "random"
        binding_config: Any = None
        metadata = {"name": name, "class": class_name}
    elif baseline_id == "uct_mcts_16" and kind == "mcts":
        config = spec["config"]
        _exact_keys(
            config,
            {"exploration", "rollout_depth", "simulations"},
            "MCTS baseline config",
        )
        class_name = "lifeline_rl.agents.mcts.MCTSAgent"
        name = f"uct_mcts_s{config['simulations']}_d{config['rollout_depth']}"
        binding_config = config
        metadata = {"name": name, "class": class_name, "config": config}
    else:
        raise AuditError("evaluation task contains unsupported frozen baseline")
    return (
        {
            "kind": "search_baseline",
            "agent_kind": kind,
            "class": class_name,
            "config": binding_config,
            "name": name,
        },
        metadata,
    )


def _validate_evaluation_receipt(
    receipt: dict[str, Any],
    task: Mapping[str, Any],
    manifest: Mapping[str, Any],
    expected_manifest_digest: str,
    checkpoint_index: Mapping[tuple[str, int], Mapping[str, Any]],
) -> None:
    _exact_keys(
        receipt, EVALUATION_RECEIPT_KEYS, f"evaluation receipt {task['task_id']}"
    )
    identity, hash_count = _validate_common_receipt(
        receipt, task, expected_manifest_digest
    )
    expected_hash_count = 19 if task["agent_b"]["kind"] == "learned_checkpoint" else 13
    if hash_count != expected_hash_count:
        raise AuditError(f"{task['task_id']}: typed hash-binding count mismatch")
    for field in ("train_sizes", "eval_size", "seed", "checkpoint_gradient_steps"):
        _compare_exact(task[field], receipt[field], f"{task['task_id']}.{field}")
    for field in ("max_plies", "superko_mode", "color_balance"):
        _compare_exact(task[field], receipt[field], f"{task['task_id']}.{field}")
    requested = task["games"]
    for field, expected in (
        ("games_requested", requested),
        ("games_completed", requested),
        ("replay_verified_games", requested),
        ("truncated_games", 0),
        ("a_as_black_games", requested // 2),
        ("a_as_white_games", requested // 2),
        ("color_pairs_verified", requested // 2),
    ):
        _compare_exact(expected, receipt[field], f"{task['task_id']}.{field}")
    for field in ("a_wins", "a_losses", "draws"):
        _require_int(receipt[field], f"{task['task_id']}.{field}", minimum=0)
    if receipt["a_wins"] + receipt["a_losses"] + receipt["draws"] != requested:
        raise AuditError(f"{task['task_id']}: W/D/L does not sum to completed games")
    for field in ("arena_csv_path", "arena_games_path", "arena_summary_path"):
        _require_string(receipt[field], f"{task['task_id']}.{field}")
    for field in ("arena_csv_sha256", "arena_games_sha256", "arena_summary_sha256"):
        _require_hash(receipt[field], f"{task['task_id']}.{field}")
    _compare_exact(
        {"A": task["agent_a"], "B": task["agent_b"]},
        receipt["agent_specs"],
        f"{task['task_id']}.agent_specs",
    )
    bindings = _exact_keys(
        receipt["agent_bindings"], {"A", "B"}, f"{task['task_id']}.agent_bindings"
    )

    for slot, metadata_field in (("A", "agent_a"), ("B", "agent_b")):
        spec = task["agent_a"] if slot == "A" else task["agent_b"]
        if spec["kind"] == "learned_checkpoint":
            checkpoint_key = (spec["training_task_id"], spec["gradient_steps"])
            artifact = checkpoint_index.get(checkpoint_key)
            if artifact is None:
                raise AuditError(
                    f"{task['task_id']}: referenced checkpoint metadata is absent"
                )
            expected_binding, expected_metadata = _expected_learned_metadata(
                spec, task, manifest, artifact, identity
            )
            _exact_keys(
                bindings[slot],
                LEARNED_BINDING_KEYS,
                f"{task['task_id']}.agent_bindings.{slot}",
            )
            metadata = _exact_keys(
                receipt[metadata_field],
                {"name", "class", "config"},
                f"{task['task_id']}.{metadata_field}",
            )
            config = _exact_keys(
                metadata["config"],
                LEARNED_METADATA_CONFIG_KEYS,
                f"{task['task_id']}.{metadata_field}.config",
            )
            _exact_keys(
                config["checkpoint"],
                LEARNED_METADATA_CHECKPOINT_KEYS,
                f"{task['task_id']}.{metadata_field}.config.checkpoint",
            )
        else:
            expected_binding, expected_metadata = _expected_baseline_metadata(spec)
            _exact_keys(
                bindings[slot],
                BASELINE_BINDING_KEYS,
                f"{task['task_id']}.agent_bindings.{slot}",
            )
        _compare_exact(
            expected_binding, bindings[slot], f"{task['task_id']}.agent_bindings.{slot}"
        )
        _compare_exact(
            expected_metadata,
            receipt[metadata_field],
            f"{task['task_id']}.{metadata_field}",
        )


def validate_receipts(
    receipt_rows: Sequence[dict[str, Any]],
    tasks_by_id: Mapping[str, Mapping[str, Any]],
    manifest: Mapping[str, Any],
    expected_manifest_digest: str,
) -> tuple[
    dict[str, dict[str, Any]], dict[tuple[str, int], dict[str, Any]], dict[str, Any]
]:
    receipts = _map_by_task_id(receipt_rows, "result receipts")
    if len(receipts) != EXPECTED_RECEIPTS:
        raise AuditError(
            f"result receipts: expected {EXPECTED_RECEIPTS} unique task_ids"
        )
    if set(receipts) != set(tasks_by_id):
        raise AuditError(
            "result receipts: task_id set mismatch; "
            f"missing={len(set(tasks_by_id) - set(receipts))}, "
            f"extra={len(set(receipts) - set(tasks_by_id))}"
        )
    checkpoint_index: dict[tuple[str, int], dict[str, Any]] = {}
    identity_encodings: set[bytes] = set()
    self_play_games = 0
    gradient_steps = 0
    parameter_counts: dict[str, set[int]] = defaultdict(set)
    for task_id in sorted(tasks_by_id):
        task = tasks_by_id[task_id]
        receipt = receipts[task_id]
        identity_encodings.add(
            canonical_json(receipt.get("execution_identity"), ensure_ascii=True)
        )
        if task["task_kind"] == "training":
            artifacts = _validate_training_receipt(
                receipt, task, expected_manifest_digest
            )
            for step, artifact in artifacts.items():
                checkpoint_index[(task_id, step)] = artifact
            self_play_games += receipt["self_play_games_completed"]
            gradient_steps += receipt["gradient_steps_completed"]
            parameter_counts[task["representation"]].add(receipt["parameter_count"])
    if len(identity_encodings) != 1:
        raise AuditError("result receipts: execution identity is not unique")
    for task_id in sorted(tasks_by_id):
        task = tasks_by_id[task_id]
        if task["task_kind"] == "evaluation":
            _validate_evaluation_receipt(
                receipts[task_id],
                task,
                manifest,
                expected_manifest_digest,
                checkpoint_index,
            )
    total_hashes = sum(
        len(flatten_hash_bindings(receipt)) for receipt in receipts.values()
    )
    if total_hashes != EXPECTED_HASH_BINDINGS:
        raise AuditError(
            f"result receipts: expected {EXPECTED_HASH_BINDINGS} typed hash bindings"
        )
    if (
        self_play_games != EXPECTED_SELF_PLAY_GAMES
        or gradient_steps != EXPECTED_GRADIENT_STEPS
    ):
        raise AuditError("result receipts: aggregate training budget does not close")
    return (
        receipts,
        checkpoint_index,
        {
            "self_play_games": self_play_games,
            "gradient_steps": gradient_steps,
            "parameter_counts": {
                key: sorted(values) for key, values in sorted(parameter_counts.items())
            },
            "hash_bindings": total_hashes,
        },
    )


def _score_ci95(wins: int, draws: int, games: int) -> list[float]:
    wins = _require_int(wins, "Wilson wins", minimum=0, maximum=MAX_EXACT_FLOAT_INTEGER)
    draws = _require_int(
        draws, "Wilson draws", minimum=0, maximum=MAX_EXACT_FLOAT_INTEGER
    )
    games = _require_int(
        games, "Wilson games", minimum=1, maximum=MAX_EXACT_FLOAT_INTEGER
    )
    if wins + draws > games:
        raise AuditError("Wilson wins plus draws exceed games")
    proportion = (wins + 0.5 * draws) / games
    z = 1.96
    denominator = 1.0 + z * z / games
    center = (proportion + z * z / (2.0 * games)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1.0 - proportion) / games + z * z / (4.0 * games * games)
        )
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def _agent_id(spec: Mapping[str, Any]) -> str:
    if spec["kind"] == "learned_checkpoint":
        return str(spec["representation"])
    return str(spec["baseline_id"])


def _aggregate_evaluation_rows(
    task_receipt_pairs: Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]],
    group_fields: Sequence[str],
) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = (
        defaultdict(list)
    )
    for task, receipt in task_receipt_pairs:
        key_values: list[Any] = []
        for field in group_fields:
            if field == "agent_a_id":
                key_values.append(_agent_id(task["agent_a"]))
            elif field == "agent_b_id":
                key_values.append(_agent_id(task["agent_b"]))
            else:
                key_values.append(task[field])
        groups[tuple(key_values)].append((task, receipt))
    rows: list[dict[str, Any]] = []
    for key, entries in sorted(groups.items(), key=lambda item: str(item[0])):
        wins = sum(receipt["a_wins"] for _, receipt in entries)
        losses = sum(receipt["a_losses"] for _, receipt in entries)
        draws = sum(receipt["draws"] for _, receipt in entries)
        games = wins + losses + draws
        row = dict(zip(group_fields, key))
        row.update(
            {
                "seed_receipts": len(entries),
                "completed_seed_receipts": len(entries),
                "failed_seed_receipts": 0,
                "games_completed": games,
                "a_wins": wins,
                "a_losses": losses,
                "draws": draws,
                "a_score_rate": (wins + 0.5 * draws) / games,
                "a_score_ci95_wilson": _score_ci95(wins, draws, games),
                "failure_reasons": [],
            }
        )
        rows.append(row)
    return rows


def reconstruct_aggregate(
    manifest: Mapping[str, Any],
    tasks_by_id: Mapping[str, Mapping[str, Any]],
    receipts_by_id: Mapping[str, Mapping[str, Any]],
    digest: str,
) -> tuple[dict[str, Any], dict[str, int]]:
    representation_ids = [entry["id"] for entry in manifest["representations"]]
    expected_counts = {
        entry["id"]: entry["expected_trainable_parameters"]
        for entry in manifest["representations"]
    }
    tolerance = manifest["matching"]["parameter_count_relative_tolerance"]
    parameter_groups: list[dict[str, Any]] = []
    for seed in manifest["seeds"]:
        counts = {
            representation: receipts_by_id[
                f"train.mixed_n{'-'.join(str(size) for size in manifest['train_sizes'])}."
                f"{representation}.seed{seed}"
            ]["parameter_count"]
            for representation in representation_ids
        }
        _compare_exact(expected_counts, counts, f"parameter audit seed {seed}")
        minimum = min(counts.values())
        maximum = max(counts.values())
        relative_spread = maximum / minimum - 1.0
        if relative_spread > float(tolerance) + FLOAT_TOLERANCE:
            raise AuditError(
                f"parameter audit seed {seed}: declared tolerance exceeded"
            )
        parameter_groups.append(
            {
                "seed": seed,
                "counts": counts,
                "minimum": minimum,
                "maximum": maximum,
                "relative_spread": relative_spread,
                "tolerance": tolerance,
                "pass": True,
            }
        )
    parameter_audit = {
        "schema_version": 1,
        "experiment_id": manifest["experiment_id"],
        "evidence_tier": manifest["evidence_tier"],
        "scope": manifest["matching"]["parameter_count_scope"],
        "groups": parameter_groups,
        "pass": True,
    }

    snapshot_groups: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    training_receipts = 0
    evaluation_receipts = 0
    evaluation_games = 0
    declared_replay_games = 0
    evaluation_kind_counts: Counter[str] = Counter()
    for task_id, task in tasks_by_id.items():
        receipt = receipts_by_id[task_id]
        if task["task_kind"] == "training":
            training_receipts += 1
            for snapshot in receipt["curve_snapshots"]:
                snapshot_groups[
                    (task["representation"], snapshot["gradient_steps"])
                ].append(snapshot)
        else:
            evaluation_receipts += 1
            evaluation_games += receipt["games_completed"]
            declared_replay_games += receipt["replay_verified_games"]
            evaluation_kind_counts[task["evaluation_kind"]] += 1
    if (
        evaluation_games != EXPECTED_EVALUATION_GAMES
        or declared_replay_games != EXPECTED_EVALUATION_GAMES
    ):
        raise AuditError("evaluation receipt accounting does not close to 30,600 games")

    training_curve: list[dict[str, Any]] = []
    for (representation, step), snapshots in sorted(
        snapshot_groups.items(), key=lambda item: str(item[0])
    ):
        row: dict[str, Any] = {
            "representation": representation,
            "train_sizes": list(manifest["train_sizes"]),
            "gradient_steps": step,
            "completed_seeds": len(snapshots),
        }
        for field in (
            "self_play_games",
            "environment_steps",
            "loss",
            "policy_loss",
            "value_loss",
            "wall_clock_seconds",
        ):
            row[f"mean_{field}"] = statistics.fmean(
                float(snapshot[field]) for snapshot in snapshots
            )
        training_curve.append(row)

    evaluation_pairs = [
        (task, receipts_by_id[task_id])
        for task_id, task in tasks_by_id.items()
        if task["task_kind"] == "evaluation"
    ]
    learning_pairs = [
        pair for pair in evaluation_pairs if "learning_curve" in pair[0]["purposes"]
    ]
    final_pairs = [
        pair for pair in evaluation_pairs if "final_vs_search" in pair[0]["purposes"]
    ]
    round_robin_pairs = [
        pair
        for pair in evaluation_pairs
        if "representation_round_robin" in pair[0]["purposes"]
    ]
    arena_learning_curve = _aggregate_evaluation_rows(
        learning_pairs,
        ("agent_a_id", "eval_size", "checkpoint_gradient_steps", "agent_b_id"),
    )
    final_vs_search = _aggregate_evaluation_rows(
        final_pairs, ("agent_a_id", "eval_size", "agent_b_id")
    )
    representation_round_robin = _aggregate_evaluation_rows(
        round_robin_pairs, ("eval_size", "agent_a_id", "agent_b_id")
    )
    aggregate = {
        "schema_version": 1,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": digest,
        "evidence_tier": manifest["evidence_tier"],
        "formal_ready": True,
        "status": "complete",
        "receipts": {
            "training": training_receipts,
            "evaluation": evaluation_receipts,
            "failed_training": 0,
            "failed_evaluation": 0,
        },
        "failed_runs": [],
        "parameter_audit": parameter_audit,
        "training_curve": training_curve,
        "arena_learning_curve": arena_learning_curve,
        "final_vs_search": final_vs_search,
        "representation_round_robin": representation_round_robin,
    }
    if (
        len(training_curve) != 15
        or len(arena_learning_curve) != 45
        or len(final_vs_search) != 18
        or len(representation_round_robin) != 9
    ):
        raise AuditError("independently reconstructed aggregate row counts drifted")
    return aggregate, {
        "training_receipts": training_receipts,
        "evaluation_receipts": evaluation_receipts,
        "evaluation_games": evaluation_games,
        "declared_replay_verified_games": declared_replay_games,
        "learning_curve_tasks_nonfinal": evaluation_kind_counts["learning_curve"],
        "final_vs_search_tasks": evaluation_kind_counts["final_vs_search"],
        "representation_round_robin_tasks": evaluation_kind_counts[
            "representation_round_robin"
        ],
        "learning_curve_tasks_including_final_uct_alias": len(learning_pairs),
    }


def _parse_csv_cell(value: str, field: str, label: str) -> Any:
    if field in CSV_INTEGER_FIELDS:
        if not INTEGER_RE.fullmatch(value):
            raise AuditError(f"{label}.{field}: expected canonical integer cell")
        try:
            parsed = int(value)
        except ValueError as exc:
            raise AuditError(
                f"{label}.{field}: integer cell exceeds supported range"
            ) from exc
        if abs(parsed) > MAX_EXACT_FLOAT_INTEGER:
            raise AuditError(
                f"{label}.{field}: integer cell exceeds exact numeric range"
            )
        return parsed
    if field in CSV_FLOAT_FIELDS:
        try:
            parsed = float(value)
        except ValueError as exc:
            raise AuditError(f"{label}.{field}: expected float cell") from exc
        if not math.isfinite(parsed):
            raise AuditError(f"{label}.{field}: non-finite float cell")
        return parsed
    if field in CSV_JSON_FIELDS:
        return strict_json_bytes(value.encode("utf-8"), f"{label}.{field}")
    return value


def parse_csv_bytes(data: bytes, section: str) -> list[dict[str, Any]]:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise AuditError(f"{section}.csv: invalid UTF-8") from exc
    if text.startswith("\ufeff"):
        raise AuditError(f"{section}.csv: UTF-8 BOM is forbidden")
    if not text or not text.endswith("\n"):
        raise AuditError(
            f"{section}.csv: file must be non-empty and newline terminated"
        )
    if any(not line.strip() for line in text.splitlines()):
        raise AuditError(f"{section}.csv: blank physical lines are forbidden")
    try:
        raw_rows = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as exc:
        raise AuditError(f"{section}.csv: strict CSV parse failed") from exc
    expected_header = CSV_HEADERS[section]
    if not raw_rows or raw_rows[0] != expected_header:
        raise AuditError(f"{section}.csv: exact header mismatch")
    if len(set(raw_rows[0])) != len(raw_rows[0]):
        raise AuditError(f"{section}.csv: duplicate headers are forbidden")
    parsed_rows: list[dict[str, Any]] = []
    for row_number, raw_row in enumerate(raw_rows[1:], start=2):
        if len(raw_row) != len(expected_header):
            raise AuditError(
                f"{section}.csv: column count mismatch on row {row_number}"
            )
        parsed_rows.append(
            {
                field: _parse_csv_cell(value, field, f"{section}.csv row {row_number}")
                for field, value in zip(expected_header, raw_row)
            }
        )
    return parsed_rows


def compare_rows_by_key(
    expected_rows: Sequence[Mapping[str, Any]],
    actual_rows: Sequence[Mapping[str, Any]],
    section: str,
) -> None:
    key_fields = ROW_KEYS[section]

    def keyed(
        rows: Sequence[Mapping[str, Any]], label: str
    ) -> dict[tuple[Any, ...], Mapping[str, Any]]:
        result: dict[tuple[Any, ...], Mapping[str, Any]] = {}
        for row in rows:
            key = tuple(row[field] for field in key_fields)
            if key in result:
                raise AuditError(f"{label}: duplicate aggregate row key")
            result[key] = row
        return result

    expected = keyed(expected_rows, f"expected {section}")
    actual = keyed(actual_rows, f"observed {section}")
    if set(expected) != set(actual):
        raise AuditError(f"{section}: aggregate row key set mismatch")
    for key in sorted(expected, key=str):
        _compare_numeric(expected[key], actual[key], f"{section}:{key}")


def compact_projection(
    receipt_lines: Sequence[tuple[dict[str, Any], bytes]],
) -> tuple[bytes, int, Counter[str], Counter[str]]:
    rendered: list[bytes] = []
    hash_count = 0
    kind_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    for line_number, (receipt, raw_line) in enumerate(receipt_lines, start=1):
        kind_counts[str(receipt.get("result_kind"))] += 1
        status_counts[str(receipt.get("status"))] += 1
        compact: dict[str, Any] = {
            "source_receipt_line": line_number,
            "source_receipt_sha256": hashlib.sha256(raw_line).hexdigest(),
        }
        for field in RECEIPT_FIELDS:
            if field in receipt:
                compact[field] = receipt[field]
        matchup: dict[str, Any] = {}
        for field in ("agent_a", "agent_b"):
            agent = receipt.get(field)
            if isinstance(agent, dict):
                selected = {
                    key: agent[key]
                    for key in ("name", "class")
                    if key in agent and isinstance(agent[key], str)
                }
                if selected:
                    matchup[field] = selected
        if matchup:
            compact["matchup"] = matchup
        bindings = flatten_hash_bindings(receipt)
        compact["hash_bindings"] = bindings
        hash_count += len(bindings)
        rendered.append(canonical_json(compact, ensure_ascii=False))
    data = b"\n".join(rendered) + b"\n"
    return data, hash_count, kind_counts, status_counts


def validate_prior_audit_reference(
    prior: Any,
    *,
    prior_sha256: str,
    manifest_file_sha256: str,
    manifest_canonical_sha256: str,
    aggregate_sha256: str,
    expected_prior_sha256: str | None,
) -> dict[str, Any]:
    if expected_prior_sha256 is not None and prior_sha256 != expected_prior_sha256:
        raise AuditError("prior full audit reference byte SHA-256 drifted")
    if not isinstance(prior, dict):
        raise AuditError("prior full audit reference must be an object")
    manifest = prior.get("manifest")
    tasks = prior.get("tasks_and_receipts")
    training = prior.get("training")
    comparison = prior.get("canonical_comparison")
    replay = prior.get("independent_replay_sample")
    for value, label in (
        (manifest, "prior manifest"),
        (tasks, "prior tasks_and_receipts"),
        (training, "prior training"),
        (comparison, "prior canonical_comparison"),
        (replay, "prior independent_replay_sample"),
    ):
        if not isinstance(value, dict):
            raise AuditError(f"{label}: expected object")
    expected_pairs = (
        (manifest.get("file_sha256"), manifest_file_sha256, "prior manifest file hash"),
        (
            manifest.get("snapshot_file_sha256"),
            manifest_file_sha256,
            "prior snapshot file hash",
        ),
        (
            manifest.get("canonical_sha256"),
            manifest_canonical_sha256,
            "prior manifest canonical hash",
        ),
        (tasks.get("expected_tasks"), EXPECTED_RECEIPTS, "prior expected task count"),
        (tasks.get("receipt_lines"), EXPECTED_RECEIPTS, "prior receipt count"),
        (
            training.get("self_play_games"),
            EXPECTED_SELF_PLAY_GAMES,
            "prior self-play count",
        ),
        (
            training.get("gradient_steps"),
            EXPECTED_GRADIENT_STEPS,
            "prior gradient-step count",
        ),
        (
            comparison.get("aggregate_sha256"),
            aggregate_sha256,
            "prior aggregate byte hash",
        ),
        (comparison.get("compared_rows"), 72, "prior compared aggregate rows"),
    )
    for actual, expected, label in expected_pairs:
        _compare_exact(expected, actual, label)
    prior_errors = prior.get("errors")
    return {
        "sha256": prior_sha256,
        "self_reported_ok": prior.get("ok") is True,
        "self_reported_errors_count": (
            len(prior_errors) if isinstance(prior_errors, list) else None
        ),
        "self_reported_replay_sample_games": replay.get("games_replayed"),
        "self_reported_aggregate_mismatch_counts": {
            "missing_keys": (
                len(comparison.get("missing_keys"))
                if isinstance(comparison.get("missing_keys"), list)
                else None
            ),
            "extra_keys": (
                len(comparison.get("extra_keys"))
                if isinstance(comparison.get("extra_keys"), list)
                else None
            ),
            "wdl": comparison.get("wdl_mismatches"),
            "score": comparison.get("score_mismatches"),
            "wilson": comparison.get("wilson_mismatches"),
        },
        "used_as_current_accounting_source": False,
        "used_as_current_artifact_verification": False,
    }


def _limitations() -> dict[str, Any]:
    return {
        "tracked_metadata_consistency_only": True,
        "raw_game_files_verified": False,
        "raw_game_hashes_recomputed": False,
        "checkpoint_files_verified": False,
        "checkpoint_hashes_recomputed": False,
        "training_logs_verified": False,
        "trajectory_records_opened": False,
        "trajectory_replay_performed": False,
        "models_retrained": False,
        "retraining_performed": False,
        "receipt_declared_paths_opened": 0,
        "resists_same_user_adversarial_filesystem_aba": False,
        "resists_same_user_concurrent_input_substitution": False,
        "verified_external_artifact_bytes": 0,
    }


def _audit_inputs(
    inputs: AuditInputs,
    *,
    enforce_frozen_identity: bool,
) -> dict[str, Any]:
    """Audit inputs, with an explicitly non-production unfrozen test mode."""

    expected_compact_sha256 = (
        EXPECTED_COMPACT_SHA256 if enforce_frozen_identity else None
    )
    expected_compact_size_bytes = (
        EXPECTED_COMPACT_SIZE_BYTES if enforce_frozen_identity else None
    )
    expected_prior_sha256 = (
        EXPECTED_PRIOR_AUDIT_SHA256 if enforce_frozen_identity else None
    )
    skipped_identity_pins = 0 if enforce_frozen_identity else 2
    reader = TrackedReader()
    manifest_bytes = reader.read("manifest", inputs.manifest)
    snapshot_bytes = reader.read("manifest_snapshot", inputs.manifest_snapshot)
    if manifest_bytes != snapshot_bytes:
        raise AuditError(
            "manifest snapshot is not a byte-for-byte copy of the manifest"
        )
    if hashlib.sha256(manifest_bytes).hexdigest() != EXPECTED_MANIFEST_SHA256:
        raise AuditError("frozen manifest byte SHA-256 drifted")
    training_task_bytes = reader.read("training_tasks", inputs.training_tasks)
    evaluation_task_bytes = reader.read("evaluation_tasks", inputs.evaluation_tasks)
    receipt_bytes = reader.read("result_receipts", inputs.receipts)
    aggregate_bytes = reader.read("aggregate_json", inputs.aggregate)
    csv_bytes = {
        "training_curve": reader.read("training_curve_csv", inputs.training_curve_csv),
        "arena_learning_curve": reader.read(
            "arena_learning_curve_csv", inputs.arena_learning_curve_csv
        ),
        "final_vs_search": reader.read(
            "final_vs_search_csv", inputs.final_vs_search_csv
        ),
        "representation_round_robin": reader.read(
            "representation_round_robin_csv", inputs.representation_round_robin_csv
        ),
    }
    prior_bytes = reader.read("prior_full_audit_reference", inputs.prior_audit)
    manifest = strict_json_bytes(manifest_bytes, "manifest")
    snapshot = strict_json_bytes(snapshot_bytes, "manifest snapshot")
    _compare_exact(manifest, snapshot, "manifest snapshot")
    validate_manifest(manifest)
    digest = manifest_digest(manifest)
    training_task_lines = strict_jsonl_bytes(training_task_bytes, "training tasks")
    evaluation_task_lines = strict_jsonl_bytes(
        evaluation_task_bytes, "evaluation tasks"
    )
    receipt_lines = strict_jsonl_bytes(receipt_bytes, "result receipts")
    aggregate = strict_json_bytes(aggregate_bytes, "aggregate.json")
    prior = strict_json_bytes(prior_bytes, "prior full audit reference")

    expected_tasks = generate_expected_tasks(manifest)
    tasks_by_id = compare_task_bundle(
        expected_tasks,
        [row for row, _ in training_task_lines],
        [row for row, _ in evaluation_task_lines],
    )
    receipts_by_id, _checkpoint_index, training_accounting = validate_receipts(
        [row for row, _ in receipt_lines], tasks_by_id, manifest, digest
    )
    recomputed_aggregate, evaluation_accounting = reconstruct_aggregate(
        manifest, tasks_by_id, receipts_by_id, digest
    )
    _compare_numeric(recomputed_aggregate, aggregate, "aggregate.json")
    for section, data in csv_bytes.items():
        observed_rows = parse_csv_bytes(data, section)
        compare_rows_by_key(recomputed_aggregate[section], observed_rows, section)

    compact_bytes, hash_count, kind_counts, status_counts = compact_projection(
        receipt_lines
    )
    compact_sha256 = hashlib.sha256(compact_bytes).hexdigest()
    if hash_count != EXPECTED_HASH_BINDINGS:
        raise AuditError("compact projection retained hash-binding count drifted")
    if kind_counts != {"training": 15, "evaluation": 315}:
        raise AuditError("compact projection result-kind counts drifted")
    if status_counts != {"complete": 330}:
        raise AuditError("compact projection status counts drifted")
    if (
        expected_compact_sha256 is not None
        and compact_sha256 != expected_compact_sha256
    ):
        raise AuditError("compact projection byte SHA-256 drifted")
    if (
        expected_compact_size_bytes is not None
        and len(compact_bytes) != expected_compact_size_bytes
    ):
        raise AuditError("compact projection byte size drifted")

    prior_contrast = validate_prior_audit_reference(
        prior,
        prior_sha256=reader.records["prior_full_audit_reference"]["sha256"],
        manifest_file_sha256=reader.records["manifest"]["sha256"],
        manifest_canonical_sha256=digest,
        aggregate_sha256=reader.records["aggregate_json"]["sha256"],
        expected_prior_sha256=expected_prior_sha256,
    )
    return {
        "schema_name": "lifeline-d14-d16-compact-independent-receipt-audit",
        "schema_version": 1,
        "ok": True,
        "verdict": (
            "PASS_TRACKED_METADATA_CONSISTENCY_ONLY"
            if enforce_frozen_identity
            else "PASS_UNFROZEN_TEST_MODE_ONLY"
        ),
        "skips": skipped_identity_pins,
        "internal_consistency_checks_passed": True,
        "audit_contract": {
            "explicit_tracked_metadata_inputs": len(reader.records),
            "distinct_input_files": reader.distinct_files,
            "tracked_metadata_bytes_read": reader.total_bytes,
            "receipt_join_key": "task_id",
            "integer_comparison": "exact_json_integer_type_and_value",
            "float_absolute_tolerance": FLOAT_TOLERANCE,
            "receipt_embedded_paths_are_opaque_data": True,
            "frozen_identity_enforced": enforce_frozen_identity,
            "manifest_byte_pin_enforced": True,
            "compact_projection_pins_enforced": enforce_frozen_identity,
            "prior_contrast_hash_pin_enforced": enforce_frozen_identity,
        },
        "inputs": reader.records,
        "manifest": {
            "file_sha256": reader.records["manifest"]["sha256"],
            "snapshot_file_sha256": reader.records["manifest_snapshot"]["sha256"],
            "canonical_sha256": digest,
            "byte_identical_snapshot": True,
        },
        "tasks_and_receipts": {
            "manifest_derived_training_tasks": EXPECTED_TRAINING_TASKS,
            "manifest_derived_evaluation_tasks": EXPECTED_EVALUATION_TASKS,
            "receipt_rows": EXPECTED_RECEIPTS,
            "missing_task_ids": 0,
            "extra_task_ids": 0,
            "duplicate_task_ids": 0,
            "typed_hash_bindings": hash_count,
        },
        "training_accounting": training_accounting,
        "evaluation_accounting": evaluation_accounting,
        "aggregate_accounting": {
            "training_curve_rows": len(recomputed_aggregate["training_curve"]),
            "evaluation_aggregate_rows": (
                len(recomputed_aggregate["arena_learning_curve"])
                + len(recomputed_aggregate["final_vs_search"])
                + len(recomputed_aggregate["representation_round_robin"])
            ),
            "json_rows_compared": 87,
            "csv_rows_compared": 87,
            "integer_mismatches": 0,
            "float_mismatches_above_tolerance": 0,
        },
        "compact_projection": {
            "rows": len(receipt_lines),
            "retained_hash_bindings": hash_count,
            "sha256": compact_sha256,
            "size_bytes": len(compact_bytes),
            "matches_frozen_projection_identity": (
                compact_sha256 == EXPECTED_COMPACT_SHA256
                and len(compact_bytes) == EXPECTED_COMPACT_SIZE_BYTES
            ),
        },
        "prior_full_audit_contrast": prior_contrast,
        "limitations": _limitations(),
        "errors": [],
    }


def audit_inputs(inputs: AuditInputs) -> dict[str, Any]:
    """Run the production audit with all frozen byte-identity pins enforced."""

    return _audit_inputs(inputs, enforce_frozen_identity=True)


def _failure_report(message: str) -> dict[str, Any]:
    return {
        "schema_name": "lifeline-d14-d16-compact-independent-receipt-audit",
        "schema_version": 1,
        "ok": False,
        "verdict": "FAIL_TRACKED_METADATA_CONSISTENCY",
        "skips": 0,
        "limitations": _limitations(),
        "errors": [message],
    }


def _parser() -> argparse.ArgumentParser:
    defaults = default_inputs()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=defaults.manifest)
    parser.add_argument(
        "--manifest-snapshot", type=Path, default=defaults.manifest_snapshot
    )
    parser.add_argument("--training-tasks", type=Path, default=defaults.training_tasks)
    parser.add_argument(
        "--evaluation-tasks", type=Path, default=defaults.evaluation_tasks
    )
    parser.add_argument("--receipts", type=Path, default=defaults.receipts)
    parser.add_argument("--aggregate", type=Path, default=defaults.aggregate)
    parser.add_argument(
        "--training-curve-csv", type=Path, default=defaults.training_curve_csv
    )
    parser.add_argument(
        "--arena-learning-curve-csv",
        type=Path,
        default=defaults.arena_learning_curve_csv,
    )
    parser.add_argument(
        "--final-vs-search-csv", type=Path, default=defaults.final_vs_search_csv
    )
    parser.add_argument(
        "--representation-round-robin-csv",
        type=Path,
        default=defaults.representation_round_robin_csv,
    )
    parser.add_argument("--prior-audit", type=Path, default=defaults.prior_audit)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    inputs = AuditInputs(
        manifest=args.manifest,
        manifest_snapshot=args.manifest_snapshot,
        training_tasks=args.training_tasks,
        evaluation_tasks=args.evaluation_tasks,
        receipts=args.receipts,
        aggregate=args.aggregate,
        training_curve_csv=args.training_curve_csv,
        arena_learning_curve_csv=args.arena_learning_curve_csv,
        final_vs_search_csv=args.final_vs_search_csv,
        representation_round_robin_csv=args.representation_round_robin_csv,
        prior_audit=args.prior_audit,
    )
    try:
        report = audit_inputs(inputs)
        exit_code = 0
    except AuditError as exc:
        report = _failure_report(str(exc))
        exit_code = 1
    except (OverflowError, RecursionError, ValueError) as exc:
        report = _failure_report(
            "tracked metadata exceeded safe parser or numeric bounds "
            f"({type(exc).__name__})"
        )
        exit_code = 1
    rendered = (
        json.dumps(
            report,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    )
    sys.stdout.write(rendered)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
