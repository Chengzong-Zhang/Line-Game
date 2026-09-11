#!/usr/bin/env python3
"""Auditable, fail-closed entry point for the D19-v2 candidate.

The checked-in D19-v2 manifest is deliberately ``preflight_only_not_authorized``.
This runner therefore has two useful, non-training operations:

``--plan``
    Validate the frozen inputs and print the deterministic schedule digest.

``--prepare OUTPUT_ROOT``
    Write a new, immutable ``prepared_not_run`` bundle containing the schedule,
    execution metadata, zero-count receipt, summary, and an empty canonical
    numeric interface.  This is preparation evidence, not a formal result.

``--run-formal --authorization JSON``
    Validate every action-time binding and then refuse the current candidate
    before any output directory is created.  A future manifest revision must
    be separately reviewed; this file never rewrites the manifest's status.

No operation in this module contacts a network, AutoDL, a paid provider, or a
GPU.  The runtime API names are recorded and source-bound so that a separately
authorized executor can be reviewed against the existing trainer, self-play,
replay, and checkpoint components without silently substituting an unrelated
implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = SCRIPT_PATH.parents[3]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:  # Support both ``python scripts/file.py`` and package-style test imports.
    import d19_v2_matched_history_contract as contract  # type: ignore # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - selected by package imports
    from scripts import d19_v2_matched_history_contract as contract  # type: ignore # noqa: E402


SCHEMA_VERSION = 1
RUN_SCHEMA_NAME = "lifeline-d19-v2-formal-run"
TASK_SCHEMA_NAME = "lifeline-d19-v2-task-schedule"
GAME_SCHEMA_NAME = "lifeline-d19-v2-game-schedule"
UPDATE_SCHEMA_NAME = "lifeline-d19-v2-update-schedule"
RECEIPT_SCHEMA_NAME = "lifeline-d19-v2-execution-receipt"
SUMMARY_SCHEMA_NAME = "lifeline-d19-v2-execution-summary"
NUMERIC_SCHEMA_NAME = "lifeline-d19-v2-canonical-numeric"
ARTIFACT_MANIFEST_SCHEMA_NAME = "lifeline-d19-v2-artifact-manifest"

AUTH_SCHEMA_NAME = "lifeline-d19-v2-action-time-authorization"
AUTH_SCHEMA_VERSION = 1
AUTH_STATUS = "action_time_authorized"
MANIFEST_STATUS = "preflight_only_not_authorized"
DEFAULT_MANIFEST = (
    RESEARCH_ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
)
RUNNER_RELATIVE = "research/iclr2027/scripts/d19_v2_formal_runner.py"
PROTOCOL_RELATIVE = "research/iclr2027/D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md"
RESULTS_ROOT = (RESEARCH_ROOT / "results").resolve()
DEVICE_PATTERN = re.compile(r"^cpu$")
SCHEDULE_DOMAIN = "d19-v2-counter-based-schedule-v1"
EMPTY_OPENING_ID = "empty_prefix_v1"

AUTH_FIELDS = {
    "schema_name",
    "schema_version",
    "status",
    "experiment_id",
    "protocol_id",
    "manifest_sha256",
    "protocol_sha256",
    "runner_sha256",
    "source_hashes",
    "device",
    "execution_environment",
    "output_root",
    "budget",
    "stop_policy",
}

STOP_POLICY = {
    "fail_closed": True,
    "stop_on_first_error": True,
    "stop_on_counter_mismatch": True,
    "stop_on_missing_seed": True,
    "allow_network": False,
    "allow_autodl": False,
    "allow_paid_resources": False,
}

ZERO_EXECUTION_COUNTS = {
    "training_steps": 0,
    "optimizer_steps": 0,
    "self_play_games": 0,
    "evaluation_games": 0,
    "checkpoints": 0,
    "formal_results": 0,
    "gpu_operations": 0,
    "network_requests": 0,
}

RUNTIME_API_BINDINGS = {
    "trainer": {
        "path": "research/iclr2027/lifeline_rl/alphazero/trainer.py",
        "apis": ["AlphaZeroTrainer", "TrainingCounters", "seed_everything"],
    },
    "self_play": {
        "path": "research/iclr2027/lifeline_rl/alphazero/self_play.py",
        "apis": ["SelfPlayConfig", "SelfPlayResult", "play_self_play_game"],
    },
    "replay": {
        "path": "research/iclr2027/lifeline_rl/alphazero/replay.py",
        "apis": ["Experience", "ReplayBuffer"],
    },
    "checkpoint": {
        "path": "research/iclr2027/lifeline_rl/alphazero/checkpoint.py",
        "apis": ["load_checkpoint", "save_checkpoint"],
    },
    "search": {
        "path": "research/iclr2027/lifeline_rl/alphazero/puct.py",
        "apis": ["PUCTConfig", "PUCTSearch"],
    },
    "config": {
        "path": "research/iclr2027/lifeline_rl/alphazero/config.py",
        "apis": ["AlphaZeroConfig"],
    },
    "network": {
        "path": "research/iclr2027/lifeline_rl/alphazero/network.py",
        "apis": ["TorchPolicyValueEvaluator", "collate_positions"],
    },
}


class RunnerError(RuntimeError):
    """A D19-v2 source, schedule, authorization, or artifact invariant failed."""


class FormalExecutionNotImplemented(NotImplementedError):
    """The reviewed formal training/evaluation executor is not in this patch."""


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise RunnerError(f"value is not finite canonical JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest().upper()


def _duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RunnerError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_duplicate_object,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, RunnerError) as exc:
        raise RunnerError(f"cannot read {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise RunnerError(f"{label} must be a JSON object: {path}")
    return value


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RunnerError(f"cannot read {label}: {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise RunnerError(f"blank JSONL row in {label}: {line_number}")
        try:
            value = json.loads(line, object_pairs_hook=_duplicate_object)
        except (json.JSONDecodeError, RunnerError) as exc:
            raise RunnerError(f"invalid JSONL row in {label}: {line_number}") from exc
        if not isinstance(value, dict):
            raise RunnerError(f"JSONL row is not an object in {label}: {line_number}")
        rows.append(value)
    return rows


def _jsonl_text(rows: Iterable[Mapping[str, Any]]) -> str:
    return "".join(canonical_json(dict(row)) + "\n" for row in rows)


def sha256_file(path: str | Path) -> str:
    target = Path(path)
    if not target.is_file() or target.is_symlink():
        raise RunnerError(f"hash target is not a regular file: {target}")
    digest = hashlib.sha256()
    try:
        with target.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise RunnerError(f"cannot hash {target}: {exc}") from exc
    return digest.hexdigest().upper()


def _repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise RunnerError(f"path is outside the repository: {path}") from exc


def _relative_repo_path(raw: object, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise RunnerError(f"{label} must be a non-empty repository-relative path")
    candidate = Path(raw)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise RunnerError(f"{label} must not be absolute or escape the repository")
    resolved = (REPO_ROOT / candidate).resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise RunnerError(f"{label} escapes the repository: {raw!r}") from exc
    return resolved


def _manifest_path(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    _repo_relative(resolved)
    if not resolved.is_file() or resolved.is_symlink():
        raise RunnerError(f"manifest is not a regular file: {resolved}")
    return resolved


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )


def _strict_non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RunnerError(f"{label} must be a non-negative integer")
    return value


def _expected_budget(manifest: Mapping[str, Any]) -> dict[str, int]:
    raw = manifest.get("planned_totals_not_authorized")
    if not isinstance(raw, Mapping):
        raise RunnerError("manifest planned_totals_not_authorized must be an object")
    expected = {
        field: _strict_non_negative_int(raw.get(field), f"budget.{field}")
        for field in (
            "training_tasks",
            "self_play_games",
            "gradient_steps",
            "evaluation_tasks",
            "evaluation_games",
        )
    }
    if dict(raw) != expected:
        raise RunnerError("manifest planned budget contains unknown or missing fields")
    return expected


def load_and_validate_manifest(path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    """Validate the immutable candidate and re-check its source bytes."""

    manifest_path = _manifest_path(path)
    try:
        manifest = contract.load_manifest(manifest_path, verify_source_bindings=True)
    except (OSError, ValueError, TypeError, contract.ContractError) as exc:
        raise RunnerError(f"D19-v2 manifest validation failed: {exc}") from exc
    if manifest.get("status") != MANIFEST_STATUS:
        raise RunnerError(
            "D19-v2 manifest status must remain "
            f"{MANIFEST_STATUS!r}; observed {manifest.get('status')!r}"
        )
    boundary = manifest.get("execution_boundary")
    if not isinstance(boundary, Mapping):
        raise RunnerError("manifest execution_boundary must be an object")
    for field in (
        "training_authorized",
        "evaluation_authorized",
        "gpu_authorized",
        "formal_result_exists",
        "old_d19_result_reuse_allowed",
        "preflight_may_train",
        "preflight_may_step_optimizer",
        "preflight_may_run_self_play",
        "preflight_may_make_network_requests",
    ):
        if boundary.get(field) is not False:
            raise RunnerError(f"manifest execution boundary is open at {field}")
    _expected_budget(manifest)
    return manifest


def _runtime_source_paths(manifest: Mapping[str, Any]) -> set[str]:
    bindings = manifest.get("source_bindings")
    if not isinstance(bindings, list):
        raise RunnerError("manifest source_bindings must be a list")
    paths: set[str] = set()
    for row in bindings:
        if not isinstance(row, Mapping) or not isinstance(row.get("path"), str):
            raise RunnerError("manifest source binding row is malformed")
        paths.add(row["path"])
    paths.add(RUNNER_RELATIVE)
    paths.update(item["path"] for item in RUNTIME_API_BINDINGS.values())
    return paths


def bound_source_hashes(manifest: Mapping[str, Any]) -> dict[str, str]:
    """Hash the manifest source closure plus every runtime API used by D19."""

    result: dict[str, str] = {}
    for relative in sorted(_runtime_source_paths(manifest)):
        result[relative] = sha256_file(_relative_repo_path(relative, "source hash path"))
    return result


def _validate_output_root(raw: object) -> tuple[str, Path]:
    resolved = _relative_repo_path(raw, "output_root")
    if resolved == REPO_ROOT.resolve() or resolved == RESEARCH_ROOT.resolve():
        raise RunnerError("output_root is too broad")
    try:
        resolved.relative_to(RESULTS_ROOT)
    except ValueError as exc:
        raise RunnerError(
            "output_root must be a repository-relative child of research/iclr2027/results"
        ) from exc
    if resolved == RESULTS_ROOT:
        raise RunnerError("output_root may not be the results root")
    if resolved in {RESULTS_ROOT / "formal", RESULTS_ROOT / "validation"}:
        raise RunnerError("output_root may not be a shared formal or validation root")
    cursor = resolved
    while cursor != RESULTS_ROOT:
        if cursor.exists() and cursor.is_symlink():
            raise RunnerError(f"output_root contains a symlink: {cursor}")
        cursor = cursor.parent
    return _repo_relative(resolved), resolved


def _derive_seed(domain: str, *components: object) -> int:
    """Derive a stable positive 63-bit seed without using arm_id."""

    payload = {"domain": domain, "schedule_domain": SCHEDULE_DOMAIN, "components": components}
    raw = hashlib.sha256(canonical_json(payload).encode("utf-8")).digest()
    value = int.from_bytes(raw[:8], "big") & ((1 << 63) - 1)
    return value or 1


def _row_with_hash(row: Mapping[str, Any]) -> dict[str, Any]:
    value = dict(row)
    value["row_sha256"] = canonical_sha256(value)
    return value


def _hash_rows(rows: Sequence[Mapping[str, Any]]) -> str:
    return hashlib.sha256(_jsonl_text(rows).encode("utf-8")).hexdigest().upper()


def _arm_rows(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    arms = manifest.get("arms")
    if not isinstance(arms, list):
        raise RunnerError("manifest arms must be a list")
    expected_ids = list(contract.ARM_FEATURES)
    result: list[dict[str, Any]] = []
    observed_ids: list[str] = []
    for row in arms:
        if not isinstance(row, Mapping):
            raise RunnerError("manifest arm row is malformed")
        arm_id = row.get("id")
        if not isinstance(arm_id, str):
            raise RunnerError("manifest arm id is not a string")
        observed_ids.append(arm_id)
        result.append(dict(row))
    if observed_ids != expected_ids:
        raise RunnerError("manifest arm order differs from the frozen 2x2 order")
    return result


def _training_parameters(manifest: Mapping[str, Any]) -> tuple[list[int], list[int], int, int, int, int, int]:
    seeds = manifest["shared_seed_schedule"]["training_seeds"]
    budget = manifest["shared_budget"]
    if seeds != [20260825, 20260826, 20260827, 20260828, 20260829]:
        raise RunnerError("training seeds differ from the frozen schedule")
    sizes = budget["train_sizes"]
    if sizes != [5, 7, 9]:
        raise RunnerError("training sizes differ from the frozen schedule")
    return (
        list(seeds),
        list(sizes),
        int(budget["iterations"]),
        int(budget["games_per_iteration"]),
        int(budget["training_steps_per_iteration"]),
        int(budget["self_play_games_per_arm_seed"]),
        int(budget["gradient_steps_per_arm_seed"]),
    )


def generate_schedule(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Create the complete counter-based training/evaluation schedule.

    Every seed shared across arms is derived without ``arm_id``.  This
    function performs no model construction and no game execution.
    """

    try:
        contract.validate_manifest(manifest, verify_source_bindings=False)
    except (ValueError, TypeError, contract.ContractError) as exc:
        raise RunnerError(f"schedule manifest validation failed: {exc}") from exc
    (
        seeds,
        sizes,
        iterations,
        games_per_iteration,
        steps_per_iteration,
        games_per_task,
        steps_per_task,
    ) = _training_parameters(manifest)
    evaluation = manifest["shared_evaluation_schedule"]
    eval_sizes = list(evaluation["eval_sizes"])
    opponents = list(evaluation["opponents"])
    games_per_eval = int(evaluation["games_per_arm_seed_size_opponent"])
    pairs_per_eval = int(evaluation["paired_color_pairs"])
    if games_per_eval != pairs_per_eval * 2:
        raise RunnerError("evaluation game/pair budget is inconsistent")

    training_tasks: list[dict[str, Any]] = []
    training_games: list[dict[str, Any]] = []
    training_updates: list[dict[str, Any]] = []
    evaluation_tasks: list[dict[str, Any]] = []
    evaluation_games: list[dict[str, Any]] = []

    for task_index, arm in enumerate(_arm_rows(manifest)):
        arm_id = str(arm["id"])
        edge_enabled = bool(arm["logical_edges_enabled"])
        history_enabled = bool(arm["compact_history_enabled"])
        for seed_index, training_seed in enumerate(seeds):
            task_id = f"train/{arm_id}/seed-{training_seed}"
            games = [
                _row_with_hash(
                    {
                        "schema_name": GAME_SCHEMA_NAME,
                        "schema_version": SCHEMA_VERSION,
                        "phase": "training",
                        "task_id": task_id,
                        "arm_id": arm_id,
                        "training_seed": training_seed,
                        "game_index": game_index,
                        "iteration": game_index // games_per_iteration,
                        "game_in_iteration": game_index % games_per_iteration,
                        "grid_size": sizes[
                            _derive_seed("train-grid-size", training_seed, game_index)
                            % len(sizes)
                        ],
                        "game_seed": _derive_seed("train-game", training_seed, game_index),
                        "arm_id_in_seed_derivation": False,
                    }
                )
                for game_index in range(games_per_task)
            ]
            updates = [
                _row_with_hash(
                    {
                        "schema_name": UPDATE_SCHEMA_NAME,
                        "schema_version": SCHEMA_VERSION,
                        "phase": "training",
                        "task_id": task_id,
                        "arm_id": arm_id,
                        "training_seed": training_seed,
                        "iteration": update_index // steps_per_iteration,
                        "update_in_iteration": update_index % steps_per_iteration,
                        "update_index": update_index,
                        "replay_draw_seed": _derive_seed(
                            "replay-draw", training_seed, update_index
                        ),
                        "arm_id_in_seed_derivation": False,
                    }
                )
                for update_index in range(steps_per_task)
            ]
            training_tasks.append(
                _row_with_hash(
                    {
                        "schema_name": TASK_SCHEMA_NAME,
                        "schema_version": SCHEMA_VERSION,
                        "phase": "training",
                        "task_index": task_index * len(seeds) + seed_index,
                        "task_id": task_id,
                        "arm_id": arm_id,
                        "logical_edges_enabled": edge_enabled,
                        "compact_history_enabled": history_enabled,
                        "training_seed": training_seed,
                        "initialization_seed": _derive_seed("initialization", training_seed),
                        "iterations": iterations,
                        "games_per_iteration": games_per_iteration,
                        "self_play_games": games_per_task,
                        "training_steps_per_iteration": steps_per_iteration,
                        "gradient_steps": steps_per_task,
                        "game_schedule_sha256": _hash_rows(games),
                        "update_schedule_sha256": _hash_rows(updates),
                        "status": "planned_not_run",
                    }
                )
            )
            training_games.extend(games)
            training_updates.extend(updates)

    eval_task_index = 0
    for arm in _arm_rows(manifest):
        arm_id = str(arm["id"])
        for training_seed in seeds:
            for eval_size in eval_sizes:
                for opponent in opponents:
                    task_id = f"eval/{arm_id}/seed-{training_seed}/size-{eval_size}/{opponent}"
                    matched_group_id = f"eval/seed-{training_seed}/size-{eval_size}/{opponent}"
                    games = []
                    for game_index in range(games_per_eval):
                        pair_index = game_index // 2
                        pair_member = game_index % 2
                        games.append(
                            _row_with_hash(
                                {
                                    "schema_name": GAME_SCHEMA_NAME,
                                    "schema_version": SCHEMA_VERSION,
                                    "phase": "evaluation",
                                    "task_id": task_id,
                                    "matched_group_id": matched_group_id,
                                    "arm_id": arm_id,
                                    "training_seed": training_seed,
                                    "eval_size": eval_size,
                                    "opponent": opponent,
                                    "game_index": game_index,
                                    "pair_index": pair_index,
                                    "pair_member": pair_member,
                                    "color": "BLACK" if pair_member == 0 else "WHITE",
                                    "opening_id": EMPTY_OPENING_ID,
                                    "opening_actions": [],
                                    "opening_prefix_sha256": canonical_sha256([]),
                                    "game_seed": _derive_seed(
                                        "evaluation-game",
                                        training_seed,
                                        eval_size,
                                        opponent,
                                        pair_index,
                                        pair_member,
                                    ),
                                    "policy_seed": _derive_seed(
                                        "evaluation-policy",
                                        training_seed,
                                        eval_size,
                                        opponent,
                                        pair_index,
                                        pair_member,
                                    ),
                                    "opponent_seed": _derive_seed(
                                        "evaluation-opponent",
                                        training_seed,
                                        eval_size,
                                        opponent,
                                        pair_index,
                                        pair_member,
                                    ),
                                    "arm_id_in_seed_derivation": False,
                                }
                            )
                        )
                    evaluation_tasks.append(
                        _row_with_hash(
                            {
                                "schema_name": TASK_SCHEMA_NAME,
                                "schema_version": SCHEMA_VERSION,
                                "phase": "evaluation",
                                "task_index": eval_task_index,
                                "task_id": task_id,
                                "matched_group_id": matched_group_id,
                                "arm_id": arm_id,
                                "training_seed": training_seed,
                                "eval_size": eval_size,
                                "opponent": opponent,
                                "games": games_per_eval,
                                "paired_color_pairs": pairs_per_eval,
                                "checkpoint_step": 200,
                                "fine_tuning": False,
                                "game_schedule_sha256": _hash_rows(games),
                                "status": "planned_not_run",
                            }
                        )
                    )
                    evaluation_games.extend(games)
                    eval_task_index += 1

    rows = {
        "training_tasks": training_tasks,
        "training_games": training_games,
        "training_updates": training_updates,
        "evaluation_tasks": evaluation_tasks,
        "evaluation_games": evaluation_games,
    }
    hashes = {name: _hash_rows(value) for name, value in rows.items()}
    schedule_hash = canonical_sha256(
        {
            "schedule_domain": SCHEDULE_DOMAIN,
            "row_hashes": hashes,
            "counts": {name: len(value) for name, value in rows.items()},
        }
    )
    return {
        "schema_name": "lifeline-d19-v2-complete-schedule",
        "schema_version": SCHEMA_VERSION,
        "schedule_domain": SCHEDULE_DOMAIN,
        "schedule_sha256": schedule_hash,
        "counts": {name: len(value) for name, value in rows.items()},
        "row_hashes": hashes,
        **rows,
    }


def _schedule_summary(schedule: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schedule_sha256": schedule["schedule_sha256"],
        "counts": dict(schedule["counts"]),
        "row_hashes": dict(schedule["row_hashes"]),
    }


def _runtime_bindings_with_hashes() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, binding in RUNTIME_API_BINDINGS.items():
        path = _relative_repo_path(binding["path"], f"runtime API path {name}")
        result[name] = {
            "path": binding["path"],
            "sha256": sha256_file(path),
            "apis": list(binding["apis"]),
        }
    return result


def _zero_numeric_interface(manifest: Mapping[str, Any], schedule: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema_name": NUMERIC_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "ABSENT_NOT_RUN",
        "experiment_id": manifest["experiment_id"],
        "schedule_sha256": schedule["schedule_sha256"],
        "primary_statistical_unit": "training_seed",
        "records": [],
        "result_numbers_present": False,
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
    }


def _prepare_payloads(manifest_path: Path, manifest: Mapping[str, Any], schedule: Mapping[str, Any]) -> dict[str, bytes]:
    manifest_sha = sha256_file(manifest_path)
    protocol_sha = sha256_file(_relative_repo_path(PROTOCOL_RELATIVE, "protocol path"))
    runner_sha = sha256_file(SCRIPT_PATH)
    source_hashes = bound_source_hashes(manifest)
    schedule_summary = _schedule_summary(schedule)
    metadata = {
        "schema_name": RUN_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "prepared_not_run",
        "experiment_id": manifest["experiment_id"],
        "protocol_id": manifest["protocol_id"],
        "manifest_path": _repo_relative(manifest_path),
        "manifest_sha256": manifest_sha,
        "protocol_path": PROTOCOL_RELATIVE,
        "protocol_sha256": protocol_sha,
        "runner_path": RUNNER_RELATIVE,
        "runner_sha256": runner_sha,
        "source_hashes": source_hashes,
        "runtime_api_bindings": _runtime_bindings_with_hashes(),
        "schedule": schedule_summary,
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "network_enabled": False,
        "autodl_enabled": False,
        "paid_resources_enabled": False,
        "formal_result_status": "ABSENT",
    }
    receipt = {
        "schema_name": RECEIPT_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "NOT_RUN",
        "experiment_id": manifest["experiment_id"],
        "schedule_sha256": schedule["schedule_sha256"],
        "manifest_sha256": manifest_sha,
        "protocol_sha256": protocol_sha,
        "runner_sha256": runner_sha,
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "formal_result_status": "ABSENT",
        "reason": "preflight-only manifest; no formal execution was authorized",
    }
    summary = {
        "schema_name": SUMMARY_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "PREPARED_NOT_RUN",
        "experiment_id": manifest["experiment_id"],
        "schedule": schedule_summary,
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "claim_boundary": {
            "formal_result_status": "ABSENT",
            "learning_effect_claimed": False,
            "topology_history_superiority_claimed": False,
            "old_d19_gate_opened": False,
        },
    }
    numeric = _zero_numeric_interface(manifest, schedule)
    rows = {
        "training_tasks.jsonl": _jsonl_text(schedule["training_tasks"]).encode("utf-8"),
        "training_games.jsonl": _jsonl_text(schedule["training_games"]).encode("utf-8"),
        "training_updates.jsonl": _jsonl_text(schedule["training_updates"]).encode("utf-8"),
        "evaluation_tasks.jsonl": _jsonl_text(schedule["evaluation_tasks"]).encode("utf-8"),
        "evaluation_games.jsonl": _jsonl_text(schedule["evaluation_games"]).encode("utf-8"),
        "execution_metadata.json": (canonical_json(metadata) + "\n").encode("utf-8"),
        "result_receipts.jsonl": (canonical_json(receipt) + "\n").encode("utf-8"),
        "execution_summary.json": (canonical_json(summary) + "\n").encode("utf-8"),
        "canonical_numeric.json": (canonical_json(numeric) + "\n").encode("utf-8"),
    }
    artifact_manifest = {
        "schema_name": ARTIFACT_MANIFEST_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "prepared_not_run",
        "experiment_id": manifest["experiment_id"],
        "files": {
            name: {
                "sha256": hashlib.sha256(content).hexdigest().upper(),
                "bytes": len(content),
            }
            for name, content in sorted(rows.items())
        },
    }
    rows["artifact_manifest.json"] = (canonical_json(artifact_manifest) + "\n").encode("utf-8")
    return rows


def _write_bytes(path: Path, content: bytes) -> None:
    if path.exists() or path.is_symlink():
        raise RunnerError(f"refusing to overwrite immutable artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def prepare_run(*, manifest_path: str | Path = DEFAULT_MANIFEST, output_root: str | Path) -> dict[str, Any]:
    """Write a new zero-execution preparation bundle under a validated root."""

    manifest_file = _manifest_path(manifest_path)
    manifest = load_and_validate_manifest(manifest_file)
    output_relative, output_directory = _validate_output_root(str(output_root))
    if output_directory.exists() or output_directory.is_symlink():
        raise RunnerError(f"refusing to overwrite existing output_root: {output_directory}")
    schedule = generate_schedule(manifest)
    payloads = _prepare_payloads(manifest_file, manifest, schedule)
    parent = output_directory.parent
    parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output_directory.name}.", dir=parent))
    try:
        for name, content in payloads.items():
            _write_bytes(temporary / name, content)
        os.replace(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {
        "schema_name": RUN_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "PREPARED_NOT_RUN",
        "output_root": output_relative,
        "schedule_sha256": schedule["schedule_sha256"],
        "file_count": len(payloads),
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "formal_result_status": "ABSENT",
    }


def _validate_prepared_run_directory(
    path: Path,
    manifest: Mapping[str, Any],
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    if not path.is_dir() or path.is_symlink():
        raise RunnerError(f"prepared run root is not a regular directory: {path}")
    expected = {
        "artifact_manifest.json",
        "canonical_numeric.json",
        "evaluation_games.jsonl",
        "evaluation_tasks.jsonl",
        "execution_metadata.json",
        "execution_summary.json",
        "result_receipts.jsonl",
        "training_games.jsonl",
        "training_tasks.jsonl",
        "training_updates.jsonl",
    }
    observed = {item.name for item in path.iterdir()}
    if observed != expected:
        raise RunnerError(f"prepared run file closure differs: {sorted(observed)}")
    artifact_manifest = _read_json(path / "artifact_manifest.json", "artifact manifest")
    if artifact_manifest.get("schema_name") != ARTIFACT_MANIFEST_SCHEMA_NAME:
        raise RunnerError("prepared artifact manifest schema mismatch")
    files = artifact_manifest.get("files")
    if not isinstance(files, Mapping) or set(files) != expected - {"artifact_manifest.json"}:
        raise RunnerError("prepared artifact manifest file set differs")
    for name, row in files.items():
        if not isinstance(row, Mapping) or not _valid_sha256(row.get("sha256")):
            raise RunnerError(f"prepared artifact hash is malformed: {name}")
        target = path / name
        if sha256_file(target) != str(row["sha256"]).upper() or target.stat().st_size != row.get("bytes"):
            raise RunnerError(f"prepared artifact hash or size differs: {name}")
    schedule = generate_schedule(manifest)
    schedule_files = {
        "training_tasks.jsonl": "training_tasks",
        "training_games.jsonl": "training_games",
        "training_updates.jsonl": "training_updates",
        "evaluation_tasks.jsonl": "evaluation_tasks",
        "evaluation_games.jsonl": "evaluation_games",
    }
    for filename, key in schedule_files.items():
        observed_rows = _read_jsonl(path / filename, filename)
        if observed_rows != schedule[key]:
            raise RunnerError(f"prepared {filename} differs from the frozen schedule")
    metadata = _read_json(path / "execution_metadata.json", "execution metadata")
    prepared_schedule = metadata.get("schedule")
    schedule_hash = (
        prepared_schedule.get("schedule_sha256")
        if isinstance(prepared_schedule, Mapping)
        else None
    )
    if not isinstance(schedule_hash, str) or not _valid_sha256(schedule_hash):
        raise RunnerError("prepared metadata lacks schedule binding")
    expected_schedule = generate_schedule(manifest)
    if schedule_hash != expected_schedule["schedule_sha256"]:
        raise RunnerError("prepared metadata schedule binding differs")
    if (
        prepared_schedule.get("counts") != expected_schedule["counts"]
        or prepared_schedule.get("row_hashes") != expected_schedule["row_hashes"]
    ):
        raise RunnerError("prepared metadata schedule summary differs")
    expected_source_hashes = bound_source_hashes(manifest)
    if metadata.get("source_hashes") != expected_source_hashes:
        raise RunnerError("prepared metadata source closure differs")
    manifest_file = _manifest_path(manifest_path)
    if metadata.get("manifest_sha256") != sha256_file(manifest_file):
        raise RunnerError("prepared metadata manifest hash is not current")
    if metadata.get("protocol_sha256") != sha256_file(
        _relative_repo_path(PROTOCOL_RELATIVE, "protocol path")
    ) or metadata.get("runner_sha256") != sha256_file(SCRIPT_PATH):
        raise RunnerError("prepared metadata source binding is stale")
    numeric = _read_json(path / "canonical_numeric.json", "canonical numeric interface")
    if numeric.get("status") != "ABSENT_NOT_RUN" or numeric.get("records") != []:
        raise RunnerError("prepared canonical numeric interface contains results")
    if numeric.get("execution_counts") != ZERO_EXECUTION_COUNTS:
        raise RunnerError("prepared canonical numeric counts are non-zero")
    if metadata.get("execution_counts") != ZERO_EXECUTION_COUNTS:
        raise RunnerError("prepared execution metadata counts are non-zero")
    if manifest.get("experiment_id") != metadata.get("experiment_id"):
        raise RunnerError("prepared metadata experiment binding differs")
    receipt_rows = _read_jsonl(path / "result_receipts.jsonl", "result receipts")
    if len(receipt_rows) != 1:
        raise RunnerError("prepared receipt ledger must contain exactly one NOT_RUN receipt")
    receipt = receipt_rows[0]
    for field in ("experiment_id", "schedule_sha256", "manifest_sha256", "protocol_sha256", "runner_sha256"):
        if receipt.get(field) != metadata.get(field) and not (
            field == "schedule_sha256" and receipt.get(field) == schedule_hash
        ):
            raise RunnerError(f"prepared receipt binding differs at {field}")
    if receipt.get("status") != "NOT_RUN" or receipt.get("execution_counts") != ZERO_EXECUTION_COUNTS:
        raise RunnerError("prepared receipt is not a zero-count NOT_RUN receipt")
    summary = _read_json(path / "execution_summary.json", "execution summary")
    if (
        summary.get("status") != "PREPARED_NOT_RUN"
        or summary.get("experiment_id") != metadata.get("experiment_id")
        or summary.get("schedule") != metadata.get("schedule")
        or summary.get("execution_counts") != ZERO_EXECUTION_COUNTS
    ):
        raise RunnerError("prepared execution summary binding differs")
    if numeric.get("schedule_sha256") != schedule_hash:
        raise RunnerError("prepared canonical numeric schedule binding differs")
    return {
        "status": "PASS",
        "schedule_sha256": schedule_hash,
        "file_count": len(expected),
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "formal_result_status": "ABSENT",
    }


def _validate_authorization_fields(
    authorization_path: str | Path,
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    manifest_file = _manifest_path(manifest_path)
    manifest = load_and_validate_manifest(manifest_file)
    authorization_file = Path(authorization_path).resolve()
    if not authorization_file.is_file() or authorization_file.is_symlink():
        raise RunnerError(f"authorization is not a regular file: {authorization_file}")
    authorization = _read_json(authorization_file, "authorization")
    if set(authorization) != AUTH_FIELDS:
        raise RunnerError(
            "authorization fields differ from the strict schema: "
            f"expected {sorted(AUTH_FIELDS)}, observed {sorted(authorization)}"
        )
    if authorization.get("schema_name") != AUTH_SCHEMA_NAME:
        raise RunnerError("authorization schema_name is invalid")
    if authorization.get("schema_version") != AUTH_SCHEMA_VERSION:
        raise RunnerError("authorization schema_version is invalid")
    if authorization.get("status") != AUTH_STATUS:
        raise RunnerError("authorization status is not action_time_authorized")
    if authorization.get("experiment_id") != manifest["experiment_id"]:
        raise RunnerError("authorization experiment_id does not match manifest")
    if authorization.get("protocol_id") != manifest["protocol_id"]:
        raise RunnerError("authorization protocol_id does not match manifest")
    expected_hashes = {
        "manifest_sha256": sha256_file(manifest_file),
        "protocol_sha256": sha256_file(_relative_repo_path(PROTOCOL_RELATIVE, "protocol path")),
        "runner_sha256": sha256_file(SCRIPT_PATH),
    }
    for field, expected in expected_hashes.items():
        observed = authorization.get(field)
        if not _valid_sha256(observed) or str(observed).upper() != expected:
            raise RunnerError(f"authorization {field} does not match current bytes")
    observed_sources = authorization.get("source_hashes")
    if not isinstance(observed_sources, Mapping):
        raise RunnerError("authorization.source_hashes must be an object")
    normalized_sources = {
        str(path): str(digest).upper() for path, digest in observed_sources.items()
    }
    expected_sources = bound_source_hashes(manifest)
    if normalized_sources != expected_sources:
        raise RunnerError("authorization source_hashes do not match current source closure")
    if not isinstance(authorization.get("device"), str) or DEVICE_PATTERN.fullmatch(authorization["device"]) is None:
        raise RunnerError("authorization.device must be exactly 'cpu'; GPU is disabled")
    if authorization.get("execution_environment") != "local":
        raise RunnerError("authorization.execution_environment must be 'local'")
    output_relative, output_directory = _validate_output_root(authorization.get("output_root"))
    budget = authorization.get("budget")
    if not isinstance(budget, Mapping) or dict(budget) != _expected_budget(manifest):
        raise RunnerError("authorization budget does not exactly match manifest plan")
    if authorization.get("stop_policy") != STOP_POLICY:
        raise RunnerError("authorization stop_policy is not the fail-closed policy")
    return {
        "manifest": manifest,
        "manifest_path": manifest_file,
        "authorization": authorization,
        "output_root": output_relative,
        "output_directory": output_directory,
        "source_hashes": expected_sources,
    }


def validate_authorization(
    authorization_path: str | Path,
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    """Validate an authorization document, then reject the current candidate."""

    validated = _validate_authorization_fields(
        authorization_path, manifest_path=manifest_path
    )
    del validated
    raise RunnerError(
        "formal execution is refused: manifest remains "
        f"{MANIFEST_STATUS}; authorization cannot rewrite it"
    )


def run_formal(
    *,
    authorization_path: str | Path,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> None:
    """Validate the formal gate, then retain an explicit NOT_IMPLEMENTED stop."""

    _validate_authorization_fields(
        authorization_path, manifest_path=manifest_path
    )
    raise FormalExecutionNotImplemented(
        "D19-v2 formal executor is not implemented; no training, self-play, "
        "evaluation, checkpoint, or formal result can be produced"
    )


def run_cpu_smoke(*, manifest_path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    """Run the smallest local tensor hook without training or result production."""

    manifest_file = _manifest_path(manifest_path)
    manifest = load_and_validate_manifest(manifest_file)
    try:
        import torch
        from lifeline_rl import LifelineGame
    except ImportError as exc:  # pragma: no cover - depends on the local install
        schedule = generate_schedule(manifest)
        return {
            "schema_name": "lifeline-d19-v2-cpu-smoke",
            "schema_version": SCHEMA_VERSION,
            "status": "SKIPPED_DEPENDENCY",
            "reason": f"CPU tensor smoke requires PyTorch: {exc}",
            "experiment_id": manifest["experiment_id"],
            "device": "cpu",
            "schedule_sha256": schedule["schedule_sha256"],
            "tensor_forward_executed": False,
            "execution_counts": dict(ZERO_EXECUTION_COUNTS),
            "formal_result_status": "ABSENT",
            "network_enabled": False,
            "autodl_enabled": False,
            "paid_resources_enabled": False,
            "manifest_sha256": sha256_file(manifest_file),
            "runner_sha256": sha256_file(SCRIPT_PATH),
        }

    games = [LifelineGame(size, superko_mode="enforce") for size in (5, 7, 9)]
    models = {
        arm_id: contract.instantiate_matched_model(202608250019)
        for arm_id in contract.ARM_FEATURES
    }
    state_hashes = {
        arm_id: contract.model_state_sha256(model)
        for arm_id, model in models.items()
    }
    if len(set(state_hashes.values())) != 1:
        raise RunnerError("CPU smoke found non-identical matched initialization bytes")
    parameter_counts = {
        arm_id: model.parameter_count for arm_id, model in models.items()
    }
    if set(parameter_counts.values()) != {contract.EXPECTED_TRAINABLE_PARAMETERS}:
        raise RunnerError("CPU smoke found an exact parameter-count mismatch")
    output_shapes: dict[str, dict[str, list[int]]] = {}
    with torch.no_grad():
        for arm_id, (logical_enabled, history_enabled) in contract.ARM_FEATURES.items():
            batch = contract.build_arm_batch(
                games,
                logical_edges_enabled=logical_enabled,
                compact_history_enabled=history_enabled,
            )
            logits, value = models[arm_id](
                batch.node_features,
                batch.adjacency,
                batch.node_mask,
                batch.legal_action_mask,
            )
            if not bool(torch.isfinite(logits).all()) or not bool(torch.isfinite(value).all()):
                raise RunnerError(f"CPU smoke produced non-finite output for {arm_id}")
            output_shapes[arm_id] = {
                "logits": list(logits.shape),
                "value": list(value.shape),
            }
    return {
        "schema_name": "lifeline-d19-v2-cpu-smoke",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "device": "cpu",
        "batch_sizes": [5, 7, 9],
        "parameter_counts": parameter_counts,
        "initial_state_sha256": next(iter(state_hashes.values())),
        "output_shapes": output_shapes,
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "formal_result_status": "ABSENT",
        "network_enabled": False,
        "autodl_enabled": False,
        "paid_resources_enabled": False,
        "manifest_sha256": sha256_file(manifest_file),
        "runner_sha256": sha256_file(SCRIPT_PATH),
    }


def build_plan(*, manifest_path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    """Return a read-only plan with the full schedule's canonical digest."""

    manifest_file = _manifest_path(manifest_path)
    manifest = load_and_validate_manifest(manifest_file)
    schedule = generate_schedule(manifest)
    return {
        "schema_name": "lifeline-d19-v2-static-plan",
        "schema_version": SCHEMA_VERSION,
        "status": "FAIL_CLOSED",
        "execution_permitted": False,
        "reason": "manifest is preflight_only_not_authorized; formal execution is refused",
        "manifest_path": _repo_relative(manifest_file),
        "manifest_sha256": sha256_file(manifest_file),
        "protocol_sha256": sha256_file(_relative_repo_path(PROTOCOL_RELATIVE, "protocol path")),
        "runner_sha256": sha256_file(SCRIPT_PATH),
        "experiment_id": manifest["experiment_id"],
        "planned_budget": _expected_budget(manifest),
        "schedule": _schedule_summary(schedule),
        "runtime_api_bindings": _runtime_bindings_with_hashes(),
        "execution_counts": dict(ZERO_EXECUTION_COUNTS),
        "formal_result_status": "ABSENT",
        "network_enabled": False,
        "autodl_enabled": False,
        "paid_resources_enabled": False,
        "side_effects": [],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--plan", action="store_true", help="validate and print a read-only plan")
    modes.add_argument("--smoke", action="store_true", help="run the CPU tensor smoke hook only")
    modes.add_argument("--prepare", action="store_true", help="write a zero-execution preparation bundle")
    modes.add_argument("--validate-prepared", type=Path, metavar="ROOT", help="validate an existing prepared bundle")
    modes.add_argument("--validate-authorization", type=Path, metavar="JSON", help="validate and reject an action-time authorization")
    modes.add_argument("--run-formal", action="store_true", help="run the formal gate; current manifest always refuses")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-root", type=Path, help="repository-relative named child of research/iclr2027/results")
    parser.add_argument("--authorization", type=Path, help="action-time authorization JSON")
    return parser


def _print_json(payload: Mapping[str, Any]) -> None:
    print(json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, indent=2))


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.smoke:
            payload = run_cpu_smoke(manifest_path=args.manifest)
            _print_json(payload)
            return 0 if payload.get("status") == "PASS" else 2
        if args.prepare:
            if args.output_root is None:
                raise RunnerError("--prepare requires --output-root")
            _print_json(prepare_run(manifest_path=args.manifest, output_root=args.output_root))
            return 0
        if args.validate_prepared is not None:
            manifest = load_and_validate_manifest(args.manifest)
            _print_json(
                _validate_prepared_run_directory(
                    args.validate_prepared.resolve(),
                    manifest,
                    manifest_path=args.manifest,
                )
            )
            return 0
        if args.validate_authorization is not None:
            validate_authorization(args.validate_authorization, manifest_path=args.manifest)
        if args.run_formal:
            if args.authorization is None:
                raise RunnerError("--run-formal requires --authorization")
            run_formal(authorization_path=args.authorization, manifest_path=args.manifest)
        _print_json(build_plan(manifest_path=args.manifest))
        return 2
    except FormalExecutionNotImplemented as exc:
        _print_json({"status": "NOT_IMPLEMENTED", "error": str(exc)})
        return 3
    except (RunnerError, contract.ContractError) as exc:
        _print_json({"status": "FAIL_CLOSED", "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
