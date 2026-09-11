#!/usr/bin/env python3
"""Independent, fail-closed verifier for D19-v2 formal evidence.

The verifier is intentionally independent of both the D19 runner and the
feature-contract implementation.  It authenticates the frozen source closure,
checks the complete four-arm/five-seed evaluation matrix, replays every
persisted game through the pure-Python rules core, and reconstructs the
pre-registered factorial contrasts.  It never trains, loads a checkpoint into
an accelerator, contacts a network, or treats pooled games as inferential
units.  Checkpoint inspection, when formal evidence is supplied, is a
CPU-only ``weights_only`` state-dict contract check.

The input schema is deliberately small and explicit.  ``task_manifest`` is a
JSONL list of 120 evaluation tasks (4 arms x 5 seeds x 3 sizes x 2 opponents),
``game_manifest`` is a JSONL list of 24,000 game records (100 color-swapped
pairs per task), and ``receipts`` is a JSONL ledger whose rows point to
hash-bound per-task receipt JSON files.  A task binds one final 200-step
checkpoint and every game contains a pre-action legal-mask trace.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
RESEARCH_ROOT = SCRIPT_DIR.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
DEFAULT_PROTOCOL = RESEARCH_ROOT / "D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md"
DEFAULT_RUNNER = SCRIPT_DIR / "d19_v2_formal_runner.py"

SCHEMA_VERSION = 1
EXPERIMENT_ID = "d19_v2_logical_edges_x_compact_history_candidate_v1"
MANIFEST_SCHEMA = "lifeline-d19-v2-matched-history-ablation-manifest"
REPORT_SCHEMA = "lifeline-d19-v2-independent-evidence-verification"
NUMERIC_SCHEMA = "lifeline-d19-v2-canonical-numeric"
TASK_SCHEMA = "lifeline-d19-v2-evaluation-task"
GAME_SCHEMA = "lifeline-d19-v2-game-schedule"
RECEIPT_SCHEMA = "lifeline-d19-v2-task-receipt"
METADATA_SCHEMA = "lifeline-d19-v2-execution-metadata"
SUMMARY_SCHEMA = "lifeline-d19-v2-execution-summary"

ARMS = (
    ("edge0_history0", False, False),
    ("edge1_history0", True, False),
    ("edge0_history1", False, True),
    ("edge1_history1", True, True),
)
ARM_FEATURES = {row[0]: (row[1], row[2]) for row in ARMS}
TRAINING_SEEDS = (20260825, 20260826, 20260827, 20260828, 20260829)
EVAL_SIZES = (9, 10, 12)
OPPONENTS = ("random", "uct_mcts_16")
GAMES_PER_TASK = 200
PAIRS_PER_TASK = 100
EXPECTED_TRAINING_TASKS = 20
EXPECTED_EVALUATION_TASKS = 120
EXPECTED_EVALUATION_GAMES = 24_000
EXPECTED_CHECKPOINTS = 20
MAX_PLIES = 256
EXPECTED_GRADIENT_STEPS = 200


def _build_expected_model_state_dict_shapes() -> dict[str, tuple[int, ...]]:
    """Return the independent, exact D19-v2 model state-dict shape contract."""

    hidden = 64
    input_width = 12
    shapes: dict[str, tuple[int, ...]] = {
        "input_projection.weight": (hidden, input_width),
        "input_projection.bias": (hidden,),
    }
    for block_index in range(3):
        prefix = f"blocks.{block_index}"
        shapes.update(
            {
                f"{prefix}.self_projection.weight": (hidden, hidden),
                f"{prefix}.self_projection.bias": (hidden,),
                f"{prefix}.normalization.weight": (hidden,),
                f"{prefix}.normalization.bias": (hidden,),
            }
        )
        for relation_index in range(3):
            shapes[
                f"{prefix}.relation_projections.{relation_index}.weight"
            ] = (hidden, hidden)
    for head in ("point_policy", "pass_policy", "value_head"):
        shapes.update(
            {
                f"{head}.0.weight": (hidden, hidden),
                f"{head}.0.bias": (hidden,),
                f"{head}.2.weight": (1, hidden),
                f"{head}.2.bias": (1,),
            }
        )
    return dict(sorted(shapes.items()))


# This contract is deliberately duplicated here instead of importing the
# implementation under test.  A source/model change must therefore update
# this verifier's explicit contract before any formal artifact can pass.
EXPECTED_MODEL_STATE_DICT_SHAPES = _build_expected_model_state_dict_shapes()
EXPECTED_STATE_DICT_PARAMETER_COUNT = sum(
    math.prod(shape) for shape in EXPECTED_MODEL_STATE_DICT_SHAPES.values()
)
if EXPECTED_STATE_DICT_PARAMETER_COUNT != 63_235:  # pragma: no cover - module invariant
    raise RuntimeError("internal D19-v2 state-dict contract count is inconsistent")

GATE_NAMES = (
    "manifest_protocol_identity",
    "source_hashes",
    "runner_verifier_hashes",
    "task_coverage",
    "checkpoint_bindings",
    "game_schedule_coverage",
    "paired_schedule",
    "receipts_and_counts",
    "replayed_games",
    "zero_truncations",
    "legal_mask_feature_contract",
    "canonical_numeric_match",
    "factorial_contrasts",
    "statistical_unit",
)


class VerificationError(ValueError):
    """Raised when the evidence cannot be safely accepted."""


def _reject_constant(value: str) -> None:
    raise VerificationError(f"non-finite JSON constant is forbidden: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def _finite(value: Any, *, label: str = "value") -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise VerificationError(f"{label} is non-finite")
    if isinstance(value, Mapping):
        for key, nested in value.items():
            _finite(nested, label=f"{label}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _finite(nested, label=f"{label}[{index}]")


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except VerificationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"JSON root must be an object: {path}")
    _finite(value, label=str(path))
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise VerificationError(f"cannot read JSONL {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(lines, 1):
        if not line.strip():
            raise VerificationError(f"blank JSONL line at {path}:{index}")
        try:
            value = json.loads(
                line,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            )
        except VerificationError:
            raise
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise VerificationError(f"invalid JSONL at {path}:{index}: {exc}") from exc
        if not isinstance(value, dict):
            raise VerificationError(f"JSONL row is not an object at {path}:{index}")
        _finite(value, label=f"{path}:{index}")
        rows.append(value)
    return rows


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise VerificationError(f"value is not finite canonical JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest().upper()


def _regular_file(path: Path, *, label: str) -> Path:
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_file() or resolved.is_symlink():
        raise VerificationError(f"{label} is not a regular non-symlink file: {path}")
    return resolved


def sha256_file(path: Path) -> str:
    target = _regular_file(path, label="hash target")
    digest = hashlib.sha256()
    try:
        with target.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise VerificationError(f"cannot hash {target}: {exc}") from exc
    return digest.hexdigest().upper()


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdefABCDEF" for c in value)


def _repo_path(raw: Any, *, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise VerificationError(f"{label} must be a non-empty repository-relative path")
    candidate = Path(raw)
    if not candidate.is_absolute() and any(part in {"", ".", ".."} for part in candidate.parts):
        raise VerificationError(f"{label} must be a clean repository-relative path")
    resolved = candidate.resolve() if candidate.is_absolute() else (REPO_ROOT / candidate).resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise VerificationError(f"{label} escapes repository: {raw!r}") from exc
    return _regular_file(resolved, label=label)


def _run_path(run_root: Path, raw: Any, *, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise VerificationError(f"{label} must be a non-empty run-relative path")
    candidate = Path(raw)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise VerificationError(f"{label} must be a clean run-relative path")
    resolved = (run_root / candidate).resolve()
    try:
        resolved.relative_to(run_root.resolve())
    except ValueError as exc:
        raise VerificationError(f"{label} escapes run root") from exc
    return _regular_file(resolved, label=label)


def _int(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise VerificationError(f"{label} must be an integer >= {minimum}")
    return value


def _str(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise VerificationError(f"{label} must be a non-empty string")
    return value


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise VerificationError(f"{label} must be an object")
    return value


def _sequence(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise VerificationError(f"{label} must be an array")
    return value


def _same(left: Any, right: Any, *, label: str) -> None:
    if left != right:
        raise VerificationError(f"{label} differs: observed={left!r}, expected={right!r}")


def _validate_checkpoint_state_dict(
    checkpoint_path: Path, *, label: str
) -> dict[str, Any]:
    """Load one checkpoint on CPU and enforce the exact model state contract."""

    try:
        import torch
    except ImportError as exc:  # pragma: no cover - depends on the verifier env
        raise VerificationError(
            f"{label}: PyTorch is required for checkpoint state-dict verification"
        ) from exc

    try:
        # Do not fall back to unrestricted pickle deserialization.  A formal
        # checkpoint that cannot be read by the safe loader is rejected.
        payload = torch.load(
            checkpoint_path,
            map_location="cpu",
            weights_only=True,
        )
    except Exception as exc:
        raise VerificationError(
            f"{label}: checkpoint could not be safely loaded on CPU"
        ) from exc
    if not isinstance(payload, Mapping):
        raise VerificationError(f"{label}: checkpoint payload must be an object")
    state_dict = payload.get("model_state_dict")
    if not isinstance(state_dict, Mapping):
        raise VerificationError(
            f"{label}: checkpoint model_state_dict is missing or not an object"
        )

    expected_names = set(EXPECTED_MODEL_STATE_DICT_SHAPES)
    observed_names = set(state_dict)
    if any(not isinstance(name, str) for name in observed_names):
        raise VerificationError(f"{label}: state-dict keys must be strings")
    if observed_names != expected_names:
        missing = sorted(expected_names - observed_names)
        unexpected = sorted(observed_names - expected_names)
        raise VerificationError(
            f"{label}: state-dict keys mismatch; "
            f"missing={missing!r}, unexpected={unexpected!r}"
        )

    observed_shapes: dict[str, list[int]] = {}
    observed_parameter_count = 0
    is_tensor = getattr(torch, "is_tensor", None)
    if not callable(is_tensor):
        raise VerificationError(f"{label}: PyTorch tensor predicate is unavailable")
    for name, expected_shape in EXPECTED_MODEL_STATE_DICT_SHAPES.items():
        tensor = state_dict[name]
        if not is_tensor(tensor):
            raise VerificationError(f"{label}: state-dict entry {name!r} is not a tensor")
        device = getattr(tensor, "device", None)
        device_type = getattr(device, "type", None)
        if device_type != "cpu":
            raise VerificationError(
                f"{label}: state-dict entry {name!r} is not on CPU"
            )
        try:
            shape = tuple(int(dimension) for dimension in tensor.shape)
            number_of_elements = int(tensor.numel())
        except (AttributeError, TypeError, ValueError, RuntimeError) as exc:
            raise VerificationError(
                f"{label}: state-dict entry {name!r} has no valid shape/count"
            ) from exc
        if shape != expected_shape:
            raise VerificationError(
                f"{label}: state-dict shape mismatch for {name!r}; "
                f"observed={shape!r}, expected={expected_shape!r}"
            )
        if number_of_elements != math.prod(shape):
            raise VerificationError(
                f"{label}: state-dict entry {name!r} shape/numel mismatch"
            )
        observed_shapes[name] = list(shape)
        observed_parameter_count += number_of_elements

    if observed_parameter_count != EXPECTED_STATE_DICT_PARAMETER_COUNT:
        raise VerificationError(
            f"{label}: state-dict parameter count mismatch; "
            f"observed={observed_parameter_count}, "
            f"expected={EXPECTED_STATE_DICT_PARAMETER_COUNT}"
        )
    return {
        "parameter_count": observed_parameter_count,
        "state_dict_entry_count": len(observed_names),
        "state_dict_shapes": observed_shapes,
    }


def _source_hashes(manifest: Mapping[str, Any]) -> dict[str, str]:
    rows = _sequence(manifest.get("source_bindings"), "manifest.source_bindings")
    observed: dict[str, str] = {}
    for index, row in enumerate(rows):
        binding = _mapping(row, f"source_bindings[{index}]")
        if set(binding) != {"path", "sha256"}:
            raise VerificationError(f"source_bindings[{index}] has unexpected fields")
        path = _str(binding.get("path"), f"source_bindings[{index}].path")
        digest = binding.get("sha256")
        if path in observed or not _valid_sha256(digest):
            raise VerificationError(f"invalid or duplicate source binding: {path}")
        actual = sha256_file(_repo_path(path, label=f"source_bindings[{index}].path"))
        if actual != str(digest).upper():
            raise VerificationError(f"source hash drift: {path}")
        observed[path] = actual
    if not observed:
        raise VerificationError("manifest source closure is empty")
    return dict(sorted(observed.items()))


def _feature_contract(arm_id: str) -> dict[str, Any]:
    logical, history = ARM_FEATURES[arm_id]
    return {
        "base_node_feature_width": 11,
        "compact_history_feature_width": 1,
        "node_feature_width": 12,
        "relation_count": 3,
        "relation_channels": ["physical", "own_logical", "opponent_logical"],
        "logical_edges_enabled": logical,
        "compact_history_enabled": history,
        "compact_history_id": "immediate_superko_membership_plane_v1",
        "legal_mask_replaced": False,
        "pass_history_feature": 0,
        "history_source": "complete_pre_action_GameSnapshot",
    }


def _validate_manifest(manifest: Mapping[str, Any], *, protocol_sha: str) -> dict[str, Any]:
    _same(manifest.get("schema_name"), MANIFEST_SCHEMA, label="manifest schema")
    _same(manifest.get("schema_version"), SCHEMA_VERSION, label="manifest schema version")
    _same(manifest.get("experiment_id"), EXPERIMENT_ID, label="manifest experiment")
    _same(manifest.get("protocol_id"), "d19_v2_matched_history_ablation_protocol_20260901_v1", label="manifest protocol id")
    if manifest.get("status") == "preflight_only_not_authorized":
        raise VerificationError("preflight-only manifest cannot authenticate formal evidence")
    if manifest.get("status") not in {"formal_execution_complete", "formal_result_candidate"}:
        raise VerificationError("manifest status is not an accepted formal-evidence status")
    relationship = _mapping(manifest.get("relationship_to_frozen_d19_v1"), "manifest.relationship")
    if relationship.get("frozen_gate_status") != "CLOSED" or relationship.get("supersedes_frozen_protocol") is not False or relationship.get("imports_old_result") is not False:
        raise VerificationError("D19-v2 may not reuse or supersede frozen D19-v1")
    execution = _mapping(manifest.get("execution_boundary"), "manifest.execution_boundary")
    for key in ("training_authorized", "evaluation_authorized", "formal_result_exists"):
        if execution.get(key) is not True:
            raise VerificationError(f"manifest execution boundary {key} is not true")
    if execution.get("old_d19_result_reuse_allowed") is not False:
        raise VerificationError("old D19 result reuse is not allowed")
    arms = _sequence(manifest.get("arms"), "manifest.arms")
    observed: dict[str, tuple[bool, bool]] = {}
    for row in arms:
        arm = _mapping(row, "manifest.arm")
        arm_id = _str(arm.get("id"), "manifest.arm.id")
        if arm_id in observed or arm_id not in ARM_FEATURES:
            raise VerificationError("manifest arms are not the exact D19-v2 factorial")
        logical = arm.get("logical_edges_enabled")
        history = arm.get("compact_history_enabled")
        if type(logical) is not bool or type(history) is not bool:
            raise VerificationError("manifest arm feature gates must be strict booleans")
        observed[arm_id] = (logical, history)
    if observed != ARM_FEATURES:
        raise VerificationError("manifest arms do not cover the exact four-arm factorial")
    backbone = _mapping(manifest.get("matched_backbone"), "manifest.matched_backbone")
    expected_backbone = {
        "base_node_feature_width": 11,
        "compact_history_feature_width": 1,
        "input_node_feature_width": 12,
        "relation_count": 3,
        "hidden_channels": 64,
        "message_passing_layers": 3,
        "trainable_parameter_count_each_arm": 63235,
        "parameter_count_rule": "EXACT_EQUAL_OR_REJECT",
        "state_dict_shape_rule": "EXACT_EQUAL_OR_REJECT",
    }
    for key, expected in expected_backbone.items():
        _same(backbone.get(key), expected, label=f"manifest.matched_backbone.{key}")
    seed_schedule = _mapping(manifest.get("shared_seed_schedule"), "manifest.seed_schedule")
    _same(seed_schedule.get("training_seeds"), list(TRAINING_SEEDS), label="training seeds")
    _same(seed_schedule.get("paired_across_arms"), True, label="paired seed schedule")
    budget = _mapping(manifest.get("shared_budget"), "manifest.shared_budget")
    _same(budget.get("max_plies"), MAX_PLIES, label="max plies")
    _same(budget.get("superko_mode"), "enforce", label="Superko mode")
    evaluation = _mapping(manifest.get("shared_evaluation_schedule"), "manifest.evaluation")
    _same(evaluation.get("eval_sizes"), list(EVAL_SIZES), label="evaluation sizes")
    _same(evaluation.get("opponents"), list(OPPONENTS), label="opponents")
    _same(evaluation.get("games_per_arm_seed_size_opponent"), GAMES_PER_TASK, label="games per task")
    _same(evaluation.get("paired_color_pairs"), PAIRS_PER_TASK, label="paired color pairs")
    _same(evaluation.get("primary_statistical_unit"), "training_seed", label="primary statistical unit")
    _same(evaluation.get("pooled_games_are_independent"), False, label="pooled-game independence")
    contrasts = _mapping(manifest.get("factorial_contrasts"), "manifest.factorial_contrasts")
    expected_contrasts = {
        "logical_at_history0": "edge1_history0 - edge0_history0",
        "logical_at_history1": "edge1_history1 - edge0_history1",
        "history_at_edge0": "edge0_history1 - edge0_history0",
        "history_at_edge1": "edge1_history1 - edge1_history0",
        "interaction": "edge1_history1 - edge1_history0 - edge0_history1 + edge0_history0",
    }
    for key, expected in expected_contrasts.items():
        _same(contrasts.get(key), expected, label=f"factorial contrast {key}")
    return {"source_hashes": _source_hashes(manifest), "protocol_sha256": protocol_sha}


def _hash_binding(value: Mapping[str, Any], *, label: str, expected: Mapping[str, str]) -> None:
    for field, digest in expected.items():
        observed = value.get(field)
        if not _valid_sha256(observed) or str(observed).upper() != digest:
            raise VerificationError(f"{label}.{field} hash binding drifted")


def _validate_task(task: Mapping[str, Any], *, manifest_sha: str, protocol_sha: str, runner_sha: str, verifier_sha: str, run_root: Path, checkpoints: dict[tuple[str, int], dict[str, Any]]) -> tuple[str, int, int, str, str]:
    task_id = _str(task.get("task_id"), "task.task_id")
    if task.get("schema_name") != TASK_SCHEMA or task.get("schema_version") != SCHEMA_VERSION or task.get("experiment_id") != EXPERIMENT_ID or task.get("task_kind") != "evaluation":
        raise VerificationError(f"{task_id}: task identity/schema mismatch")
    arm = _str(task.get("arm_id"), f"{task_id}.arm_id")
    if arm not in ARM_FEATURES:
        raise VerificationError(f"{task_id}: unknown arm")
    seed = _int(task.get("training_seed"), f"{task_id}.training_seed")
    size = _int(task.get("eval_size"), f"{task_id}.eval_size")
    opponent = _str(task.get("opponent"), f"{task_id}.opponent")
    if seed not in TRAINING_SEEDS or size not in EVAL_SIZES or opponent not in OPPONENTS:
        raise VerificationError(f"{task_id}: task is outside the frozen evaluation matrix")
    _same(task.get("games"), GAMES_PER_TASK, label=f"{task_id}.games")
    _same(task.get("paired_color_pairs"), PAIRS_PER_TASK, label=f"{task_id}.paired_color_pairs")
    _same(task.get("max_plies"), MAX_PLIES, label=f"{task_id}.max_plies")
    _same(task.get("superko_mode"), "enforce", label=f"{task_id}.superko_mode")
    _hash_binding(task, label=task_id, expected={"manifest_sha256": manifest_sha, "protocol_sha256": protocol_sha, "runner_sha256": runner_sha, "verifier_sha256": verifier_sha})
    _same(task.get("feature_contract"), _feature_contract(arm), label=f"{task_id}.feature_contract")
    checkpoint = _mapping(task.get("checkpoint"), f"{task_id}.checkpoint")
    checkpoint_id = _str(checkpoint.get("checkpoint_id"), f"{task_id}.checkpoint_id")
    checkpoint_path = _run_path(run_root, checkpoint.get("path"), label=f"{task_id}.checkpoint.path")
    checkpoint_sha = checkpoint.get("sha256")
    if checkpoint_path.stat().st_size <= 0 or not _valid_sha256(checkpoint_sha) or sha256_file(checkpoint_path) != str(checkpoint_sha).upper():
        raise VerificationError(f"{task_id}: checkpoint hash mismatch")
    _same(checkpoint.get("gradient_steps"), EXPECTED_GRADIENT_STEPS, label=f"{task_id}.checkpoint.gradient_steps")
    _same(checkpoint.get("trained_board_sizes"), [5, 7, 9], label=f"{task_id}.checkpoint.trained_board_sizes")
    key = (arm, seed)
    binding = {
        "checkpoint_id": checkpoint_id,
        "path": str(checkpoint.get("path")),
        "sha256": str(checkpoint_sha).upper(),
    }
    previous = checkpoints.get(key)
    if previous is not None:
        if any(previous.get(field) != value for field, value in binding.items()):
            raise VerificationError(
                f"{task_id}: checkpoint binding differs within arm/seed"
            )
    else:
        state_contract = _validate_checkpoint_state_dict(
            checkpoint_path, label=f"{task_id}.checkpoint"
        )
        checkpoints[key] = {
            **binding,
            "state_dict_parameter_count": state_contract["parameter_count"],
            "state_dict_entry_count": state_contract["state_dict_entry_count"],
        }
    return task_id, seed, size, opponent, arm


def _expected_task_id(arm: str, seed: int, size: int, opponent: str) -> str:
    return f"eval.{arm}.seed{seed}.n{size}.vs.{opponent}"


def _expected_mask(game: Any) -> list[bool]:
    if game.game_over:
        return [False] * (game.num_points + 1)
    legal = set(game.legal_moves())
    return [point in legal for point in game.valid_positions] + [True]


def _normalize_action(value: Any, label: str) -> tuple[int, int] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, int) for v in value):
        raise VerificationError(f"{label} is not a point or PASS")
    return (value[0], value[1])


def _audit_game(record: Mapping[str, Any], schedule: Mapping[str, Any], *, task: Mapping[str, Any]) -> dict[str, Any]:
    game_id = _str(record.get("game_id"), "game.game_id")
    if record.get("schema_name") != GAME_SCHEMA or record.get("schema_version") != SCHEMA_VERSION:
        raise VerificationError(f"{game_id}: game schema mismatch")
    for key in ("task_id", "arm_id", "training_seed", "eval_size", "opponent", "pair_id", "pair_member", "black_slot", "white_slot"):
        _same(record.get(key), schedule.get(key), label=f"{game_id}.{key}")
    _same(record.get("task_id"), task.get("task_id"), label=f"{game_id}.task_id")
    _same(record.get("feature_contract"), task.get("feature_contract"), label=f"{game_id}.feature_contract")
    if record.get("truncated") is not False or record.get("complete") is not True:
        raise VerificationError(f"{game_id}: truncated/incomplete game")
    actions = _sequence(record.get("actions"), f"{game_id}.actions")
    trace = _sequence(record.get("decision_trace"), f"{game_id}.decision_trace")
    if len(actions) != len(trace) or not actions or len(actions) > MAX_PLIES:
        raise VerificationError(f"{game_id}: invalid action/trace length")
    opening_actions = _sequence(schedule.get("opening_actions"), f"{game_id}.opening_actions")
    if len(opening_actions) > len(actions):
        raise VerificationError(f"{game_id}: opening prefix is longer than the action trace")
    for prefix_index, (opening, action) in enumerate(zip(opening_actions, actions)):
        if _normalize_action(opening, f"{game_id}.opening_actions[{prefix_index}]") != _normalize_action(action, f"{game_id}.actions[{prefix_index}]"):
            raise VerificationError(f"{game_id}: action trace does not begin with the scheduled opening")
    game = __import_core_game(int(task["eval_size"]), str(task["superko_mode"]))
    for ply, (raw_action, raw_trace) in enumerate(zip(actions, trace)):
        row = _mapping(raw_trace, f"{game_id}.decision_trace[{ply}]")
        _same(row.get("ply"), ply, label=f"{game_id}.trace.ply")
        _same(row.get("actor"), game.current_player.value, label=f"{game_id}.trace.actor")
        _same(_normalize_action(row.get("action"), f"{game_id}.trace.action"), _normalize_action(raw_action, f"{game_id}.action"), label=f"{game_id}.trace.action")
        observed_mask = _sequence(row.get("legal_action_mask"), f"{game_id}.trace.legal_action_mask")
        if len(observed_mask) != game.num_points + 1 or any(type(value) is not bool for value in observed_mask):
            raise VerificationError(f"{game_id}: legal mask is not a strict boolean vector")
        _same(observed_mask, _expected_mask(game), label=f"{game_id}.legal_action_mask")
        action = _normalize_action(raw_action, f"{game_id}.action")
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise VerificationError(f"{game_id}: replay rejected action at ply {ply}: {result.reason}")
    if record.get("plies") != len(actions) or record.get("final_state_hash") != game.state_fingerprint():
        raise VerificationError(f"{game_id}: replay summary/hash mismatch")
    winner = game.winner()
    winner_value = winner.value if hasattr(winner, "value") else winner
    _same(record.get("winner"), winner_value, label=f"{game_id}.winner")
    black_slot = record.get("black_slot")
    if winner_value == "DRAW":
        outcome = "DRAW"
    elif winner_value == ("BLACK" if black_slot == "A" else "WHITE"):
        outcome = "WIN"
    else:
        outcome = "LOSS"
    _same(record.get("outcome"), outcome, label=f"{game_id}.outcome")
    duration = record.get("duration_seconds")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(float(duration)) or duration < 0:
        raise VerificationError(f"{game_id}: invalid duration")
    return {"game_id": game_id, "task_id": task["task_id"], "arm_id": task["arm_id"], "training_seed": int(task["training_seed"]), "eval_size": int(task["eval_size"]), "opponent": task["opponent"], "pair_id": record["pair_id"], "pair_member": int(record["pair_member"]), "outcome": outcome, "score": {"WIN": 1.0, "DRAW": 0.5, "LOSS": 0.0}[outcome]}


def __import_core_game(size: int, superko: str) -> Any:
    # Kept in a function so static manifest/hash checks happen before the core
    # is imported by a caller using the public helpers.
    from lifeline_rl import LifelineGame

    return LifelineGame(size, superko_mode=superko)


def _validate_schedule(record: Mapping[str, Any], *, task: Mapping[str, Any], manifest_sha: str, protocol_sha: str, runner_sha: str, verifier_sha: str) -> None:
    game_id = _str(record.get("game_id"), "game_manifest.game_id")
    if record.get("schema_name") != GAME_SCHEMA or record.get("schema_version") != SCHEMA_VERSION:
        raise VerificationError(f"{game_id}: schedule schema mismatch")
    _same(record.get("task_id"), task.get("task_id"), label=f"{game_id}.task_id")
    _same(record.get("arm_id"), task.get("arm_id"), label=f"{game_id}.arm_id")
    _same(record.get("training_seed"), task.get("training_seed"), label=f"{game_id}.training_seed")
    _same(record.get("eval_size"), task.get("eval_size"), label=f"{game_id}.eval_size")
    _same(record.get("opponent"), task.get("opponent"), label=f"{game_id}.opponent")
    _hash_binding(record, label=game_id, expected={"manifest_sha256": manifest_sha, "protocol_sha256": protocol_sha, "runner_sha256": runner_sha, "verifier_sha256": verifier_sha})
    _same(record.get("feature_contract"), task.get("feature_contract"), label=f"{game_id}.feature_contract")
    _int(record.get("game_index"), f"{game_id}.game_index")
    pair_member = record.get("pair_member")
    if pair_member not in (0, 1):
        raise VerificationError(f"{game_id}: pair_member must be 0 or 1")
    if record.get("black_slot") not in ("A", "B") or record.get("white_slot") not in ("A", "B") or record.get("black_slot") == record.get("white_slot"):
        raise VerificationError(f"{game_id}: invalid color slots")
    if record.get("pair_member") == 0 and (record.get("black_slot"), record.get("white_slot")) != ("A", "B"):
        raise VerificationError(f"{game_id}: pair member 0 is not A-black")
    if record.get("pair_member") == 1 and (record.get("black_slot"), record.get("white_slot")) != ("B", "A"):
        raise VerificationError(f"{game_id}: pair member 1 is not the color swap")
    if not isinstance(record.get("opening_actions"), list):
        raise VerificationError(f"{game_id}: paired schedule fields are incomplete")
    for field in ("policy_seed_a", "policy_seed_b", "opponent_seed"):
        _int(record.get(field), f"{game_id}.{field}")
    if record["policy_seed_a"] == record["policy_seed_b"]:
        raise VerificationError(f"{game_id}: paired policy seeds must differ")
    for action_index, action in enumerate(record["opening_actions"]):
        _normalize_action(action, f"{game_id}.opening_actions[{action_index}]")
    schedule_fields = (
        "task_id", "game_index", "arm_id", "training_seed", "eval_size",
        "opponent", "pair_id", "pair_member", "black_slot", "white_slot",
        "opening_actions", "policy_seed_a", "policy_seed_b", "opponent_seed",
    )
    schedule_payload = {field: record.get(field) for field in schedule_fields}
    declared_schedule_sha = record.get("schedule_sha256")
    if not _valid_sha256(declared_schedule_sha) or str(declared_schedule_sha).upper() != canonical_sha256(schedule_payload):
        raise VerificationError(f"{game_id}: schedule SHA-256 mismatch")


def _compare_schedules(records: Sequence[Mapping[str, Any]]) -> None:
    by_key: dict[tuple[int, int, str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for row in records:
        by_key[(int(row["training_seed"]), int(row["eval_size"]), str(row["opponent"]), int(row["game_index"]) // 2)].append(row)
    expected_per_key = len(ARMS)
    for key, rows in by_key.items():
        if len(rows) != expected_per_key or len({str(row["arm_id"]) for row in rows}) != expected_per_key:
            raise VerificationError(f"paired schedule {key!r} is missing or duplicated across arms")
        signature = lambda row: (row.get("pair_id"), row.get("opening_actions"), row.get("policy_seed_a"), row.get("policy_seed_b"), row.get("opponent_seed"), row.get("pair_member"), row.get("black_slot"), row.get("white_slot"))
        if len({canonical_json(signature(row)) for row in rows}) != 1:
            raise VerificationError(f"paired schedule {key!r} differs across arms")


def _receipt_counts(audited: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    outcomes = Counter(str(row["outcome"]) for row in audited)
    return {"games_requested": len(audited), "games_completed": len(audited), "truncated_games": 0, "a_wins": outcomes["WIN"], "a_losses": outcomes["LOSS"], "draws": outcomes["DRAW"]}


def _t_interval(values: Sequence[float]) -> list[float]:
    if len(values) != 5:
        raise VerificationError("Student-t interval requires exactly five seed units")
    mean = statistics.fmean(values)
    margin = 2.776 * statistics.stdev(values) / math.sqrt(5)
    return [mean - margin, mean + margin]


def _aggregate(audited: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    by_cell: dict[tuple[str, int, int, str], list[Mapping[str, Any]]] = defaultdict(list)
    for row in audited:
        by_cell[(str(row["arm_id"]), int(row["training_seed"]), int(row["eval_size"]), str(row["opponent"]))].append(row)
    rows: list[dict[str, Any]] = []
    contrasts_by_stratum: dict[tuple[int, str], dict[str, list[float]]] = defaultdict(dict)
    for size in EVAL_SIZES:
        for opponent in OPPONENTS:
            seed_scores: dict[str, dict[int, float]] = {arm: {} for arm, _, _ in ARMS}
            for arm, _, _ in ARMS:
                for seed in TRAINING_SEEDS:
                    games = by_cell.get((arm, seed, size, opponent), [])
                    if len(games) != GAMES_PER_TASK:
                        raise VerificationError(f"aggregate cell {arm}/{seed}/{size}/{opponent} does not contain exactly 200 games")
                    seed_scores[arm][seed] = statistics.fmean(float(game["score"]) for game in games)
            arm_means = {arm: statistics.fmean(seed_scores[arm].values()) for arm, _, _ in ARMS}
            contrast_values = {
                "logical_at_history0": [seed_scores["edge1_history0"][s] - seed_scores["edge0_history0"][s] for s in TRAINING_SEEDS],
                "logical_at_history1": [seed_scores["edge1_history1"][s] - seed_scores["edge0_history1"][s] for s in TRAINING_SEEDS],
                "history_at_edge0": [seed_scores["edge0_history1"][s] - seed_scores["edge0_history0"][s] for s in TRAINING_SEEDS],
                "history_at_edge1": [seed_scores["edge1_history1"][s] - seed_scores["edge1_history0"][s] for s in TRAINING_SEEDS],
                "interaction": [seed_scores["edge1_history1"][s] - seed_scores["edge1_history0"][s] - seed_scores["edge0_history1"][s] + seed_scores["edge0_history0"][s] for s in TRAINING_SEEDS],
            }
            for name, values in contrast_values.items():
                contrasts_by_stratum[(size, opponent)][name] = values
            rows.append({
                "eval_size": size,
                "opponent": opponent,
                "primary_statistical_unit": "training_seed",
                "training_seed_units": 5,
                "games_completed": sum(len(by_cell[(arm, seed, size, opponent)]) for arm, _, _ in ARMS for seed in TRAINING_SEEDS),
                "arm_seed_means": {arm: [{"training_seed": seed, "score": seed_scores[arm][seed], "games": GAMES_PER_TASK} for seed in TRAINING_SEEDS] for arm, _, _ in ARMS},
                "arm_means_equal_weighted_over_seeds": arm_means,
                "pooled_games_are_independent": False,
                "pooled_game_score_descriptive_only": {arm: statistics.fmean(seed_scores[arm].values()) for arm, _, _ in ARMS},
                "factorial_contrasts": {name: {"seed_values": values, "estimate": statistics.fmean(values), "ci95": _t_interval(values), "degrees_of_freedom": 4} for name, values in contrast_values.items()},
            })
    return {"schema_name": NUMERIC_SCHEMA, "schema_version": SCHEMA_VERSION, "experiment_id": EXPERIMENT_ID, "primary_statistical_unit": "training_seed", "pooled_games_are_independent": False, "comparison_rows": rows}


def _numeric_equal(left: Any, right: Any, *, path: str = "$") -> None:
    if type(left) is not type(right):
        raise VerificationError(f"canonical numeric mismatch at {path}: type differs")
    if isinstance(left, Mapping):
        if set(left) != set(right):
            raise VerificationError(f"canonical numeric mismatch at {path}: keys differ")
        for key in left:
            _numeric_equal(left[key], right[key], path=f"{path}.{key}")
    elif isinstance(left, list):
        if len(left) != len(right):
            raise VerificationError(f"canonical numeric mismatch at {path}: length differs")
        for index, (a, b) in enumerate(zip(left, right)):
            _numeric_equal(a, b, path=f"{path}[{index}]")
    elif left != right:
        raise VerificationError(f"canonical numeric mismatch at {path}: {left!r} != {right!r}")


def verify_evidence(*, manifest_path: Path, protocol_path: Path = DEFAULT_PROTOCOL, task_manifest_path: Path, game_manifest_path: Path, receipts_path: Path, execution_metadata_path: Path, execution_summary_path: Path, runner_path: Path = DEFAULT_RUNNER, canonical_numeric_path: Path | None = None, canonical_numeric_sha256: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    gates = {name: False for name in GATE_NAMES}
    manifest_path = _regular_file(manifest_path.resolve(), label="manifest")
    protocol_path = _repo_path(str(protocol_path), label="protocol")
    runner_path = _repo_path(str(runner_path), label="runner")
    task_manifest_path = _regular_file(task_manifest_path.resolve(), label="task manifest")
    game_manifest_path = _regular_file(game_manifest_path.resolve(), label="game manifest")
    receipts_path = _regular_file(receipts_path.resolve(), label="receipt ledger")
    execution_metadata_path = _regular_file(execution_metadata_path.resolve(), label="execution metadata")
    execution_summary_path = _regular_file(execution_summary_path.resolve(), label="execution summary")
    run_root = receipts_path.parent
    manifest = load_json(manifest_path)
    manifest_sha = sha256_file(manifest_path)
    protocol_sha = sha256_file(protocol_path)
    runner_sha = sha256_file(runner_path)
    verifier_sha = sha256_file(SCRIPT_PATH)
    manifest_summary = _validate_manifest(manifest, protocol_sha=protocol_sha)
    gates["manifest_protocol_identity"] = True
    metadata = load_json(execution_metadata_path)
    if metadata.get("schema_name") != METADATA_SCHEMA or metadata.get("schema_version") != SCHEMA_VERSION or metadata.get("experiment_id") != EXPERIMENT_ID:
        raise VerificationError("execution metadata schema/experiment mismatch")
    _hash_binding(metadata, label="execution_metadata", expected={"manifest_sha256": manifest_sha, "protocol_sha256": protocol_sha, "runner_sha256": runner_sha, "verifier_sha256": verifier_sha, "task_manifest_sha256": sha256_file(task_manifest_path), "game_manifest_sha256": sha256_file(game_manifest_path), "receipts_sha256": sha256_file(receipts_path)})
    if metadata.get("source_hashes") != manifest_summary["source_hashes"]:
        raise VerificationError("execution metadata source closure differs from manifest/current bytes")
    gates["source_hashes"] = True
    gates["runner_verifier_hashes"] = True
    tasks = load_jsonl(task_manifest_path)
    task_by_id: dict[str, dict[str, Any]] = {}
    checkpoints: dict[tuple[str, int], dict[str, Any]] = {}
    for task in tasks:
        task_id, _, _, _, _ = _validate_task(task, manifest_sha=manifest_sha, protocol_sha=protocol_sha, runner_sha=runner_sha, verifier_sha=verifier_sha, run_root=run_root, checkpoints=checkpoints)
        if task_id in task_by_id:
            raise VerificationError(f"duplicate task id: {task_id}")
        task_by_id[task_id] = dict(task)
    expected_ids = {_expected_task_id(arm, seed, size, opponent) for arm, _, _ in ARMS for seed in TRAINING_SEEDS for size in EVAL_SIZES for opponent in OPPONENTS}
    if len(tasks) != EXPECTED_EVALUATION_TASKS or set(task_by_id) != expected_ids or len(checkpoints) != EXPECTED_CHECKPOINTS:
        raise VerificationError("task/checkpoint coverage is incomplete or duplicated")
    gates["task_coverage"] = True
    gates["checkpoint_bindings"] = True
    games = load_jsonl(game_manifest_path)
    schedules_by_id: dict[str, dict[str, Any]] = {}
    for record in games:
        game_id = _str(record.get("game_id"), "game_manifest.game_id")
        if game_id in schedules_by_id:
            raise VerificationError(f"duplicate game id: {game_id}")
        task = task_by_id.get(str(record.get("task_id")))
        if task is None:
            raise VerificationError(f"game {game_id}: unknown task")
        _validate_schedule(record, task=task, manifest_sha=manifest_sha, protocol_sha=protocol_sha, runner_sha=runner_sha, verifier_sha=verifier_sha)
        schedules_by_id[game_id] = dict(record)
    if len(games) != EXPECTED_EVALUATION_GAMES:
        raise VerificationError("game manifest does not contain exactly 24,000 games")
    _compare_schedules(games)
    gates["game_schedule_coverage"] = True
    gates["paired_schedule"] = True
    receipts_ledger = load_jsonl(receipts_path)
    if len(receipts_ledger) != EXPECTED_EVALUATION_TASKS:
        raise VerificationError("receipt ledger task count differs from 120")
    receipt_ids: set[str] = set()
    audited: list[dict[str, Any]] = []
    for index, ledger in enumerate(receipts_ledger):
        task_id = _str(ledger.get("task_id"), f"receipt_ledger[{index}].task_id")
        if task_id in receipt_ids or task_id not in task_by_id:
            raise VerificationError(f"receipt ledger duplicate/unknown task: {task_id}")
        receipt_ids.add(task_id)
        receipt_file = _run_path(run_root, ledger.get("receipt_path"), label=f"receipt_ledger[{index}].receipt_path")
        receipt_sha = ledger.get("receipt_sha256")
        if not _valid_sha256(receipt_sha) or sha256_file(receipt_file) != str(receipt_sha).upper():
            raise VerificationError(f"{task_id}: receipt artifact hash mismatch")
        receipt = load_json(receipt_file)
        if receipt.get("schema_name") != RECEIPT_SCHEMA or receipt.get("task_id") != task_id:
            raise VerificationError(f"{task_id}: receipt schema/id mismatch")
        task = task_by_id[task_id]
        _hash_binding(receipt, label=task_id, expected={"manifest_sha256": manifest_sha, "protocol_sha256": protocol_sha, "runner_sha256": runner_sha, "verifier_sha256": verifier_sha, "game_manifest_sha256": sha256_file(game_manifest_path)})
        task_games = [row for row in games if row.get("task_id") == task_id]
        if len(task_games) != GAMES_PER_TASK:
            raise VerificationError(f"{task_id}: game count differs from 200")
        if {row.get("game_index") for row in task_games} != set(range(GAMES_PER_TASK)):
            raise VerificationError(f"{task_id}: game indices are missing, duplicated, or out of range")
        task_audited: list[dict[str, Any]] = []
        by_pair: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for row in task_games:
            audited_row = _audit_game(row, schedules_by_id[row["game_id"]], task=task)
            task_audited.append(audited_row)
            by_pair[str(row["pair_id"])].append(row)
        if len(by_pair) != PAIRS_PER_TASK or any(len(pair_rows) != 2 for pair_rows in by_pair.values()):
            raise VerificationError(f"{task_id}: paired game coverage differs")
        counts = _receipt_counts(task_audited)
        for key, value in counts.items():
            _same(receipt.get(key), value, label=f"{task_id}.receipt.{key}")
        _same(receipt.get("games_path"), game_manifest_path.name, label=f"{task_id}.receipt.games_path")
        _same(receipt.get("games_sha256"), sha256_file(game_manifest_path), label=f"{task_id}.receipt.games_sha256")
        audited.extend(task_audited)
    if receipt_ids != set(task_by_id):
        raise VerificationError("receipt ledger does not cover every task exactly once")
    gates["receipts_and_counts"] = True
    gates["replayed_games"] = len(audited) == EXPECTED_EVALUATION_GAMES
    gates["zero_truncations"] = all(row["outcome"] != "TRUNCATED" for row in audited)
    gates["legal_mask_feature_contract"] = True
    numeric_core = _aggregate(audited)
    gates["factorial_contrasts"] = True
    if numeric_core.get("primary_statistical_unit") != "training_seed" or numeric_core.get("pooled_games_are_independent") is not False:
        raise VerificationError("numeric aggregate uses pooled games as an inferential unit")
    gates["statistical_unit"] = True
    summary = load_json(execution_summary_path)
    if summary.get("schema_name") != SUMMARY_SCHEMA or summary.get("schema_version") != SCHEMA_VERSION or summary.get("experiment_id") != EXPERIMENT_ID:
        raise VerificationError("execution summary schema mismatch")
    _hash_binding(summary, label="execution_summary", expected={"manifest_sha256": manifest_sha, "protocol_sha256": protocol_sha, "runner_sha256": runner_sha, "verifier_sha256": verifier_sha, "task_manifest_sha256": sha256_file(task_manifest_path), "game_manifest_sha256": sha256_file(game_manifest_path), "receipts_sha256": sha256_file(receipts_path)})
    _same(summary.get("evaluation_tasks"), EXPECTED_EVALUATION_TASKS, label="summary.evaluation_tasks")
    _same(summary.get("evaluation_games"), EXPECTED_EVALUATION_GAMES, label="summary.evaluation_games")
    _same(summary.get("training_tasks"), EXPECTED_TRAINING_TASKS, label="summary.training_tasks")
    _same(summary.get("checkpoint_count"), EXPECTED_CHECKPOINTS, label="summary.checkpoint_count")
    _same(summary.get("complete_tasks"), EXPECTED_EVALUATION_TASKS, label="summary.complete_tasks")
    _same(summary.get("missing_tasks"), 0, label="summary.missing_tasks")
    _same(summary.get("failed_tasks"), 0, label="summary.failed_tasks")
    _same(summary.get("truncated_games"), 0, label="summary.truncated_games")
    _same(summary.get("formal_ready"), False, label="summary.formal_ready")
    _same(summary.get("primary_statistical_unit"), "training_seed", label="summary.primary_statistical_unit")
    if canonical_numeric_path is None or canonical_numeric_sha256 is None:
        raise VerificationError("canonical numeric artifact and declared hash are required")
    canonical_file = _run_path(run_root, canonical_numeric_path.name if canonical_numeric_path.parent == run_root else str(canonical_numeric_path), label="canonical numeric")
    if not _valid_sha256(canonical_numeric_sha256) or sha256_file(canonical_file) != str(canonical_numeric_sha256).upper() or summary.get("canonical_numeric_sha256") != str(canonical_numeric_sha256).upper():
        raise VerificationError("canonical numeric artifact hash is not bound")
    canonical = load_json(canonical_file)
    _numeric_equal(numeric_core, canonical)
    gates["canonical_numeric_match"] = True
    report = {"schema_name": REPORT_SCHEMA, "schema_version": SCHEMA_VERSION, "status": "PASS", "formal_ready": True, "experiment_id": EXPERIMENT_ID, "verifier_sha256": verifier_sha, "gates": gates, "issues": [], "task_count": len(tasks), "game_count": len(audited), "checkpoint_count": len(checkpoints), "numeric_sha256": canonical_sha256(numeric_core)}
    return report, numeric_core


def failure_report(exc: BaseException) -> dict[str, Any]:
    return {"schema_name": REPORT_SCHEMA, "schema_version": SCHEMA_VERSION, "status": "FAIL_CLOSED", "formal_ready": False, "experiment_id": EXPERIMENT_ID, "verifier_sha256": sha256_file(SCRIPT_PATH), "gates": {name: False for name in GATE_NAMES}, "issues": [f"{type(exc).__name__}: {exc}"]}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--protocol", type=Path, default=DEFAULT_PROTOCOL)
    parser.add_argument("--task-manifest", type=Path, required=True)
    parser.add_argument("--game-manifest", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--execution-metadata", type=Path, required=True)
    parser.add_argument("--execution-summary", type=Path, required=True)
    parser.add_argument("--runner", type=Path, default=DEFAULT_RUNNER)
    parser.add_argument("--canonical-numeric", type=Path, required=True)
    parser.add_argument("--canonical-sha256", required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    return parser


def _write_new(path: Path, payload: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise VerificationError(f"refusing to overwrite output: {path}")
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report, _ = verify_evidence(manifest_path=args.manifest, protocol_path=args.protocol, task_manifest_path=args.task_manifest, game_manifest_path=args.game_manifest, receipts_path=args.receipts, execution_metadata_path=args.execution_metadata, execution_summary_path=args.execution_summary, runner_path=args.runner, canonical_numeric_path=args.canonical_numeric, canonical_numeric_sha256=args.canonical_sha256)
    except Exception as exc:
        report = failure_report(exc)
    try:
        _write_new(args.report_output, report)
    except Exception as exc:
        report = failure_report(exc)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report.get("formal_ready") is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
