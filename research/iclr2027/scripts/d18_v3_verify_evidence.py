#!/usr/bin/env python3
"""Independent fail-closed verifier for the D18-v3 formal experiment.

This module deliberately does not import either D18-v3 runner.  It starts from
the frozen manifests, execution metadata, receipt ledger, and persisted game
artifacts.  It independently checks identities, replays every game, recomputes
the three diversity gates, and reconstructs the frozen statistical interface.

The verifier may produce an independent numeric artifact without making the
experiment formal-ready.  ``formal_ready`` additionally requires a separately
produced canonical numeric artifact whose declared hash and numeric core match
the independent reconstruction exactly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import statistics
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
REPO_ROOT = SCRIPT_PATH.parents[3]
RESEARCH_ROOT = REPO_ROOT / "research" / "iclr2027"
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, replay_game_record  # noqa: E402


SCHEMA_VERSION = 1
REPORT_SCHEMA = "lifeline-d18-v3-independent-verification"
NUMERIC_SCHEMA = "lifeline-d18-v3-independent-numeric"
MANIFEST_SCHEMA = "lifeline-d18-v3-formal-manifest"
TASK_SCHEMA = "lifeline-d18-v3-task"
GAME_SCHEDULE_SCHEMA = "lifeline-d18-v3-game-schedule"
RUN_SCHEMA = "lifeline-d18-v3-formal-run"
GAME_SCHEMA = "lifeline-d18-v3-formal-game"
PAIR_SCHEMA = "lifeline-d18-v3-formal-pair"
RECEIPT_SCHEMA = "lifeline-d18-v3-formal-task-receipt"
EXPERIMENT_ID = "d18_d16_v3_paired_openings_formal_v1"
EXPERIMENT_ARM = "d16-v3-paired-openings"
EXPECTED_TASKS = 45
EXPECTED_GAMES = 5_760
GAMES_PER_TASK = 128
PAIRS_PER_TASK = 64
STRATA_PER_TASK = 32
VARIANTS_PER_STRATUM = 2
TRAINING_SEEDS = (20260825, 20260826, 20260827, 20260828, 20260829)
SIZES = (5, 7, 9)
MODEL_PAIRS = (
    ("padded_cnn", "grid_gnn"),
    ("padded_cnn", "topology_gnn"),
    ("grid_gnn", "topology_gnn"),
)
MODEL_KINDS = ("padded_cnn", "grid_gnn", "topology_gnn")
FORMAL_GATES = {
    "max_truncated_games": 0,
    "min_clusters_with_two_continuations": 24,
    "min_unique_prefix_stripped_continuations": 32,
    "min_unique_trajectories": 64,
    "opening_strata": 32,
}
SEARCH = {
    "add_root_noise": False,
    "c_puct": 1.5,
    "simulations": 16,
    "temperature": 0.0,
}
BOOTSTRAP_REPLICATES = 20_000
BOOTSTRAP_SEED = 202608299902
POLICY_SEED_NAMESPACE = "lifeline-d18-v3-policy-seeds-20260830-v1"
DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d18_v3_formal_manifest_v2.json"
DEFAULT_FORMAL_RUNNER = SCRIPT_DIR / "d18_v3_formal_runner.py"
DEFAULT_PREPARATION_RUNNER = SCRIPT_DIR / "d18_v3_runner.py"
THROUGHPUT_PROFILE_SCHEMA = "lifeline-d18-v3-gpu-smoke"
THROUGHPUT_PROFILE_ARTIFACT_NAME = "throughput_profile.json"
RUN_ROOT_ALLOWED_ENTRY_NAMES = frozenset(
    {
        ".d18_v3_formal_writer.lock",
        THROUGHPUT_PROFILE_ARTIFACT_NAME,
        "execution_metadata.json",
        "tasks",
        "result_receipts.jsonl",
        "canonical_numeric.json",
        "execution_summary.json",
    }
)
EXPORT_ROOT_FILE_NAMES = frozenset(
    {
        THROUGHPUT_PROFILE_ARTIFACT_NAME,
        "execution_metadata.json",
        "result_receipts.jsonl",
        "canonical_numeric.json",
        "execution_summary.json",
    }
)
POLICY_MAX_DELIVERY_BYTES = 512 * 1024 * 1024
WORKER_RUN_METADATA_RESERVE_BYTES = 64 * 1024 * 1024
MAX_EXPORT_BYTES = POLICY_MAX_DELIVERY_BYTES - WORKER_RUN_METADATA_RESERVE_BYTES
EXPORT_MANIFEST_RESERVE_BYTES = 4 * 1024 * 1024
SCALAR_LANE_COUNT = 12
SCALAR_LANE_EXECUTION_MODE = "production_equivalent_scalar_puct_lanes"
GPU_SMOKE_CASE_COUNT = len(MODEL_PAIRS) * len(SIZES)
GPU_SMOKE_MIN_TOTAL_SECONDS = 15.0
GPU_SMOKE_MAX_TOTAL_SECONDS = 27.0
INFERENCE_BATCH_SIZE = 1
INFERENCE_DTYPE = "float32"
MAX_RUNTIME_SECONDS = 11_520
FORMAL_GAMEPLAY_BUDGET_SECONDS = 8_640
FORMAL_NON_GAMEPLAY_RESERVE_FRACTION = 0.25
MAX_AGGREGATE_LANE_MEMORY_BYTES = 30 * 1024**3
MIN_DEVICE_MEMORY_BYTES = 31 * 1024**3
MIN_DEVICE_FREE_HEADROOM_BYTES = 4 * 1024**3
EXPECTED_TORCH_VERSION = "2.8.0"
EXPECTED_CUDA_RUNTIME_VERSION = "12.8"

THROUGHPUT_PROFILE_IDENTITY_FIELDS = (
    "throughput_profile_sha256",
    "throughput_profile_artifact_path",
    "throughput_profile_schema_name",
    "throughput_profile_schema_version",
    "throughput_profile_formal_manifest_sha256",
    "throughput_profile_formal_runner_sha256",
    "scalar_lane_count",
    "scalar_lane_execution_mode",
    "inference_batch_size",
    "inference_dtype",
    "amp_enabled",
)

EXECUTION_FREEZE_FIELDS = (
    "schema_name",
    "schema_version",
    "experiment_id",
    "formal_manifest_sha256",
    "protocol_sha256",
    "preparation_runner_sha256",
    "formal_runner_sha256",
    "verifier_sha256",
    "execution_source_hashes",
    "bundle_summary_sha256",
    "task_manifest_sha256",
    "game_manifest_sha256",
    "manifest_snapshot_sha256",
    "python_version",
    "torch_version",
    "cuda_runtime_version",
    "cudnn_version",
    "device",
    "device_name",
    "formal_source_hash",
    *THROUGHPUT_PROFILE_IDENTITY_FIELDS,
)

GATE_NAMES = (
    "manifest_identity",
    "manifest_source_hashes",
    "opening_registry_bound",
    "task_manifest_complete",
    "game_manifest_complete",
    "dual_runner_hashes_bound",
    "verifier_source_bound",
    "execution_metadata_bound",
    "throughput_profile_verified",
    "receipt_ledger_complete",
    "artifact_paths_confined",
    "artifact_hashes_verified",
    "pair_artifacts_complete",
    "all_games_replayed",
    "zero_truncations",
    "receipt_counts_recomputed",
    "stratum_balance",
    "all_task_diversity_gates",
    "statistics_contract",
    "execution_summary_consistent",
    "canonical_numeric_hash_verified",
    "canonical_numeric_match",
)


class VerificationError(RuntimeError):
    """A required independent-evidence invariant failed."""


def _reject_constant(value: str) -> None:
    raise VerificationError(f"non-finite JSON number is forbidden: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


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
        raise VerificationError(f"cannot read strict JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"JSON root must be an object: {path}")
    return value


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise VerificationError(f"cannot read JSONL {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise VerificationError(f"blank JSONL row at {path}:{line_number}")
        try:
            value = json.loads(
                line,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            )
        except VerificationError:
            raise
        except json.JSONDecodeError as exc:
            raise VerificationError(
                f"cannot read strict JSONL {path}:{line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise VerificationError(f"JSONL row is not an object at {path}:{line_number}")
        rows.append(value)
    return rows


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
        raise VerificationError(f"value is not canonical finite JSON: {exc}") from exc


def pretty_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        ) + "\n"
    except (TypeError, ValueError) as exc:
        raise VerificationError(f"value is not finite JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise VerificationError(f"cannot hash {path}: {exc}") from exc
    return digest.hexdigest()


def _atomic_write_new(path: Path, text: str) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise VerificationError(f"refusing to overwrite verifier output: {path}")
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
            raise VerificationError(f"verifier output appeared concurrently: {path}")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise VerificationError(f"{label} must be an object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise VerificationError(f"{label} must be an array")
    return value


def _integer(value: Any, label: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise VerificationError(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        raise VerificationError(f"{label} must be >= {minimum}")
    return value


def _finite_number(value: Any, label: str, *, minimum: float | None = None) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        raise VerificationError(f"{label} must be finite")
    result = float(value)
    if minimum is not None and result < minimum:
        raise VerificationError(f"{label} must be >= {minimum}")
    return result


def _valid_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _apply_action_index(game: LifelineGame, action_index: int, label: str) -> None:
    if action_index > game.num_points:
        raise VerificationError(
            f"{label}: action exceeds PASS index {game.num_points}"
        )
    action = (
        None
        if action_index == game.num_points
        else game.valid_positions[action_index]
    )
    result = game.skip_turn() if action is None else game.play_move(action)
    if not result.success:
        raise VerificationError(f"{label}: illegal replay action: {result.reason}")


def _throughput_opening_game(
    schedule: Mapping[str, Any], *, size: int, superko_mode: str
) -> tuple[LifelineGame, int]:
    actions = [
        _integer(value, f"throughput.opening_actions[{index}]", minimum=0)
        for index, value in enumerate(
            _sequence(schedule.get("opening_actions"), "throughput.opening_actions")
        )
    ]
    _require(
        _valid_sha256(schedule.get("opening_prefix_hash"))
        and schedule.get("opening_prefix_hash") == canonical_sha256(actions),
        "throughput selected opening prefix hash differs",
    )
    game = LifelineGame(size, superko_mode=superko_mode)
    for index, action_index in enumerate(actions):
        _require(
            not game.game_over,
            "throughput selected opening continues after a terminal state",
        )
        _apply_action_index(game, action_index, f"throughput.opening_actions[{index}]")
    _require(
        not game.game_over
        and _valid_sha256(schedule.get("opening_state_hash"))
        and game.state_fingerprint() == schedule.get("opening_state_hash"),
        "throughput selected opening state hash differs",
    )
    return game, len(actions)


def _repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise VerificationError(f"path escapes repository root: {path}") from exc


def _resolve_repo_path(raw: str | Path) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = REPO_ROOT / path
    path = path.resolve()
    _repo_relative(path)
    return path


def _resolve_artifact(task_directory: Path, raw: Any, *, label: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise VerificationError(f"{label} must be a non-empty relative path")
    candidate = Path(raw)
    if candidate.is_absolute() or candidate.anchor:
        raise VerificationError(f"{label} must be relocation-safe and relative")
    normalized = raw.replace("\\", "/")
    if normalized.startswith("/") or any(part in {"", ".", ".."} for part in normalized.split("/")):
        raise VerificationError(f"{label} contains an unsafe path component")
    unresolved = task_directory / Path(*normalized.split("/"))
    if unresolved.is_symlink():
        raise VerificationError(f"{label} must not be a symlink")
    resolved = unresolved.resolve()
    try:
        resolved.relative_to(task_directory.resolve())
    except ValueError as exc:
        raise VerificationError(f"{label} escapes its task directory") from exc
    return resolved


def _slug(value: str) -> str:
    safe = "".join(character if character.isalnum() or character in "._-" else "-" for character in value)
    return safe[:180].strip("-") or "task"


def _task_directory(run_root: Path, task_id: str) -> Path:
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return run_root / "tasks" / f"{_slug(task_id)}__{digest}"


def _validate_run_root_entries(run_root: Path) -> None:
    for entry in run_root.iterdir():
        _require(
            entry.name in RUN_ROOT_ALLOWED_ENTRY_NAMES and not entry.is_symlink(),
            f"formal run root contains an unknown or unsafe entry: {entry.name}",
        )
        if entry.name == "tasks":
            _require(entry.is_dir(), "formal run tasks entry is not a real directory")
        else:
            _require(
                entry.is_file(),
                f"formal run root entry is not a real file: {entry.name}",
            )


def _export_payload_paths(tasks: Sequence[Mapping[str, Any]]) -> set[Path]:
    expected = {Path(name) for name in EXPORT_ROOT_FILE_NAMES}
    for task in tasks:
        task_root = Path("tasks") / _task_directory(
            Path("."), str(task["task_id"])
        ).name
        expected.update(
            {
                task_root / "games.jsonl",
                task_root / "receipt.json",
                task_root / "summary.json",
            }
        )
        expected.update(
            task_root / "pairs" / f"pair_{index:04d}.json"
            for index in range(PAIRS_PER_TASK)
        )
    return expected


def _export_directories(paths: set[Path]) -> set[Path]:
    directories: set[Path] = set()
    for path in paths:
        parent = path.parent
        while parent != Path("."):
            directories.add(parent)
            parent = parent.parent
    return directories


def _validate_export_root_entries(
    export_root: Path, tasks: Sequence[Mapping[str, Any]]
) -> None:
    """Verify the exact delivered closure and every export-manifest binding."""

    manifest_path = export_root / "export_manifest.json"
    _require(
        manifest_path.is_file() and not manifest_path.is_symlink(),
        "formal export manifest is missing or unsafe",
    )
    expected_payload = _export_payload_paths(tasks)
    expected_files = expected_payload | {Path("export_manifest.json")}
    expected_directories = _export_directories(expected_payload)
    observed_files: set[Path] = set()
    observed_directories: set[Path] = set()
    for path in sorted(export_root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(export_root)
        _require(
            not path.is_symlink(),
            f"formal export contains a symlink: {relative.as_posix()}",
        )
        if path.is_dir():
            observed_directories.add(relative)
        else:
            _require(
                path.is_file(),
                f"formal export contains a special file: {relative.as_posix()}",
            )
            observed_files.add(relative)
    _require(
        observed_files == expected_files,
        "formal export file closure differs",
    )
    _require(
        observed_directories == expected_directories,
        "formal export directory closure differs",
    )

    manifest = load_json(manifest_path)
    _require(
        manifest.get("schema_name") == "lifeline-d18-v3-export-manifest"
        and manifest.get("schema_version") == SCHEMA_VERSION
        and manifest.get("experiment_id") == EXPERIMENT_ID,
        "formal export manifest identity differs",
    )
    rows = manifest.get("files")
    _require(isinstance(rows, list), "formal export manifest files must be a list")
    row_paths: list[Path] = []
    total_bytes = 0
    for row in rows:
        _require(isinstance(row, dict), "formal export manifest row must be an object")
        raw_path = row.get("path")
        _require(
            isinstance(raw_path, str)
            and raw_path
            and "\\" not in raw_path
            and Path(raw_path).as_posix() == raw_path
            and not Path(raw_path).is_absolute()
            and ".." not in Path(raw_path).parts,
            "formal export manifest contains an unsafe path",
        )
        relative = Path(raw_path)
        expected_bytes = row.get("bytes")
        expected_sha256 = row.get("sha256")
        _require(
            relative in expected_payload
            and isinstance(expected_bytes, int)
            and not isinstance(expected_bytes, bool)
            and expected_bytes >= 0
            and _valid_sha256(expected_sha256),
            f"formal export manifest row differs: {raw_path}",
        )
        artifact = export_root / relative
        _require(
            artifact.stat().st_size == expected_bytes
            and sha256_file(artifact) == expected_sha256,
            f"formal export artifact hash or size differs: {raw_path}",
        )
        row_paths.append(relative)
        total_bytes += expected_bytes
    _require(
        row_paths == sorted(expected_payload, key=lambda path: path.as_posix()),
        "formal export manifest path order or coverage differs",
    )
    _require(
        manifest.get("file_count") == len(expected_payload)
        and manifest.get("total_bytes") == total_bytes
        and manifest.get("max_export_bytes") == MAX_EXPORT_BYTES
        and manifest.get("export_manifest_reserve_bytes")
        == EXPORT_MANIFEST_RESERVE_BYTES
        and manifest.get("projected_upper_bound_bytes")
        == total_bytes + EXPORT_MANIFEST_RESERVE_BYTES
        and total_bytes + EXPORT_MANIFEST_RESERVE_BYTES <= MAX_EXPORT_BYTES
        and manifest.get("worker_run_metadata_reserve_bytes")
        == WORKER_RUN_METADATA_RESERVE_BYTES
        and manifest.get("policy_max_delivery_bytes")
        == POLICY_MAX_DELIVERY_BYTES
        and manifest.get("projected_worker_delivery_upper_bound_bytes")
        == total_bytes
        + EXPORT_MANIFEST_RESERVE_BYTES
        + WORKER_RUN_METADATA_RESERVE_BYTES
        and total_bytes
        + EXPORT_MANIFEST_RESERVE_BYTES
        + WORKER_RUN_METADATA_RESERVE_BYTES
        <= POLICY_MAX_DELIVERY_BYTES
        and manifest_path.stat().st_size <= EXPORT_MANIFEST_RESERVE_BYTES,
        "formal export manifest count or byte budget differs",
    )


def _validate_evidence_root_entries(
    run_root: Path, tasks: Sequence[Mapping[str, Any]]
) -> None:
    if (run_root / "export_manifest.json").exists():
        _validate_export_root_entries(run_root, tasks)
    else:
        _validate_run_root_entries(run_root)


def _validate_pair_directory_entries(pair_directory: Path) -> None:
    _require(
        pair_directory.is_dir() and not pair_directory.is_symlink(),
        "pair artifact directory is missing or unsafe",
    )
    entries = list(pair_directory.iterdir())
    _require(
        all(path.is_file() and not path.is_symlink() for path in entries),
        "pair artifact directory contains an unsafe entry",
    )
    _require(
        {path.name for path in entries}
        == {f"pair_{index:04d}.json" for index in range(PAIRS_PER_TASK)},
        "pair artifact directory contains missing/extra files",
    )


def _policy_seed_pair(*, size: int, stratum: int) -> tuple[int, int]:
    values: list[int] = []
    for label in ("low", "high"):
        payload = f"{POLICY_SEED_NAMESPACE}|n={size}|stratum={stratum}|{label}".encode(
            "utf-8"
        )
        values.append(
            int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")
            & ((1 << 63) - 1)
        )
    _require(values[0] != values[1], "derived low/high policy seeds collide")
    return values[0], values[1]


def _validate_manifest(
    manifest: Mapping[str, Any], manifest_path: Path
) -> tuple[dict[str, dict[str, Any]], str, str]:
    _require(manifest.get("schema_name") == MANIFEST_SCHEMA, "formal manifest schema mismatch")
    _require(manifest.get("schema_version") == SCHEMA_VERSION, "formal manifest version mismatch")
    _require(manifest.get("experiment_id") == EXPERIMENT_ID, "formal experiment ID mismatch")
    _require(manifest.get("experiment_arm") == EXPERIMENT_ARM, "formal experiment arm mismatch")
    _require(manifest.get("status") == "frozen_zero_formal_games", "manifest is not frozen zero-execution evidence")
    _require(manifest.get("training_seeds") == list(TRAINING_SEEDS), "formal training seeds changed")
    _require(manifest.get("sizes") == list(SIZES), "formal evaluation sizes changed")
    _require(
        manifest.get("model_pairs")
        == [
            {"agent_a_model_kind": left, "agent_b_model_kind": right}
            for left, right in MODEL_PAIRS
        ],
        "formal model-pair ordering changed",
    )
    _require(manifest.get("search") == SEARCH, "frozen PUCT search contract changed")
    _require(
        manifest.get("game_rules")
        == {
            "max_plies": 256,
            "start_player": "BLACK",
            "superko_mode": "enforce",
            "truncations_allowed": 0,
        },
        "frozen game rules changed",
    )
    _require(
        manifest.get("formal_gates")
        == {
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
        "formal manifest gates changed",
    )
    statistics_contract = _mapping(manifest.get("statistics"), "manifest.statistics")
    _require(
        statistics_contract.get("bootstrap_replicates") == BOOTSTRAP_REPLICATES
        and statistics_contract.get("bootstrap_seed") == BOOTSTRAP_SEED
        and statistics_contract.get("cluster_mean_games") == 4
        and statistics_contract.get("primary_unit") == "training_seed_x_opening_stratum"
        and statistics_contract.get("secondary_interval_degrees_of_freedom") == 4
        and statistics_contract.get("strata_per_training_seed") == STRATA_PER_TASK,
        "frozen statistical contract changed",
    )
    source_hashes = _mapping(manifest.get("source_hashes"), "manifest.source_hashes")
    _require(bool(source_hashes), "formal manifest source hash closure is empty")
    for raw_path, digest in source_hashes.items():
        _require(isinstance(raw_path, str) and _valid_sha256(digest), "invalid manifest source binding")
        path = _resolve_repo_path(raw_path)
        _require(path.is_file(), f"bound manifest source is missing: {raw_path}")
        _require(sha256_file(path) == digest, f"bound manifest source hash changed: {raw_path}")

    protocol_path = _resolve_repo_path(str(manifest.get("protocol_path", "")))
    protocol_sha = str(manifest.get("protocol_sha256", ""))
    _require(_valid_sha256(protocol_sha), "manifest protocol hash is invalid")
    _require(protocol_path.is_file() and sha256_file(protocol_path) == protocol_sha, "protocol file/hash binding failed")
    _require(source_hashes.get(_repo_relative(protocol_path)) == protocol_sha, "protocol absent from source closure")

    opening_design = _mapping(manifest.get("opening_design"), "manifest.opening_design")
    opening_path = _resolve_repo_path(str(opening_design.get("opening_manifest_path", "")))
    opening_sha = str(opening_design.get("opening_manifest_sha256", ""))
    _require(opening_path.is_file() and _valid_sha256(opening_sha), "opening manifest binding is invalid")
    _require(sha256_file(opening_path) == opening_sha, "opening manifest hash mismatch")
    opening_manifest = load_json(opening_path)
    openings = _sequence(opening_manifest.get("openings"), "opening manifest openings")
    _require(len(openings) == 192, "opening registry must contain exactly 192 rows")
    by_id: dict[str, dict[str, Any]] = {}
    prefix_hashes: set[str] = set()
    state_hashes: set[str] = set()
    cell_counts: Counter[tuple[int, int]] = Counter()
    for index, raw in enumerate(openings):
        row = dict(_mapping(raw, f"openings[{index}]"))
        opening_id = str(row.get("opening_id", ""))
        _require(opening_id and opening_id not in by_id, "duplicate/empty opening ID")
        _require(row.get("eval_size") in SIZES, f"{opening_id}: invalid opening size")
        stratum = _integer(row.get("stratum_index"), f"{opening_id}.stratum_index", minimum=0)
        variant = _integer(row.get("variant_index"), f"{opening_id}.variant_index", minimum=0)
        _require(stratum < STRATA_PER_TASK and variant < VARIANTS_PER_STRATUM, f"{opening_id}: invalid stratum/variant")
        _require(row.get("prefix_plies") in (2, 4, 6, 8), f"{opening_id}: invalid prefix depth")
        _require(len(_sequence(row.get("opening_actions"), f"{opening_id}.opening_actions")) == row["prefix_plies"], f"{opening_id}: opening length mismatch")
        _require(row.get("pass_free") is True and row.get("nonterminal") is True, f"{opening_id}: opening legality flags fail")
        _require(row.get("legal_point_actions_only") is True and row.get("no_auto_skip") is True, f"{opening_id}: opening rule flags fail")
        prefix_hash = str(row.get("opening_prefix_hash", ""))
        state_hash = str(row.get("opening_state_hash", ""))
        _require(_valid_sha256(prefix_hash) and prefix_hash not in prefix_hashes, f"{opening_id}: prefix hash invalid/duplicate")
        _require(_valid_sha256(state_hash) and state_hash not in state_hashes, f"{opening_id}: state hash invalid/duplicate")
        prefix_hashes.add(prefix_hash)
        state_hashes.add(state_hash)
        cell_counts[(int(row["eval_size"]), stratum)] += 1
        by_id[opening_id] = row
    _require(
        cell_counts == Counter({(size, stratum): 2 for size in SIZES for stratum in range(STRATA_PER_TASK)}),
        "opening registry must contain two variants per size/stratum",
    )
    return by_id, protocol_sha, opening_sha


def _checkpoint_binding(binding: Mapping[str, Any], *, kind: str, seed: int, label: str) -> None:
    required = (
        "checkpoint_id",
        "model_kind",
        "training_seed",
        "gradient_steps",
        "trained_board_sizes",
        "path",
        "sha256",
        "config_path",
        "config_file_sha256",
        "config_hash",
        "source_hash",
        "source_receipt_path",
        "source_receipt_sha256",
    )
    for field in required:
        _require(field in binding, f"{label}: checkpoint binding missing {field}")
    _require(binding["model_kind"] == kind and binding["training_seed"] == seed, f"{label}: checkpoint cell mismatch")
    _require(binding["gradient_steps"] == 200 and binding["trained_board_sizes"] == [5, 7, 9], f"{label}: checkpoint training identity changed")
    for field in ("sha256", "config_file_sha256", "config_hash", "source_hash", "source_receipt_sha256"):
        _require(_valid_sha256(binding[field]), f"{label}: invalid {field}")
    for path_field, hash_field in (
        ("path", "sha256"),
        ("config_path", "config_file_sha256"),
        ("source_receipt_path", "source_receipt_sha256"),
    ):
        path = _resolve_repo_path(str(binding[path_field]))
        _require(path.is_file() and sha256_file(path) == binding[hash_field], f"{label}: {path_field} hash mismatch")


def _manifest_checkpoint_map(
    manifest: Mapping[str, Any],
) -> dict[tuple[str, int], dict[str, Any]]:
    rows = _sequence(manifest.get("checkpoints"), "manifest.checkpoints")
    _require(len(rows) == 15, "formal manifest must bind exactly 15 checkpoints")
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for index, raw in enumerate(rows):
        row = dict(_mapping(raw, f"manifest.checkpoints[{index}]"))
        kind = str(row.get("model_kind", ""))
        seed = _integer(row.get("training_seed"), f"manifest.checkpoints[{index}].training_seed")
        _require(kind in MODEL_KINDS and seed in TRAINING_SEEDS, "unexpected checkpoint registry cell")
        key = (kind, seed)
        _require(key not in result, f"duplicate checkpoint registry cell: {key}")
        _checkpoint_binding(row, kind=kind, seed=seed, label=f"manifest.checkpoints[{index}]")
        result[key] = row
    _require(
        set(result) == {(kind, seed) for kind in MODEL_KINDS for seed in TRAINING_SEEDS},
        "checkpoint registry does not cover the exact 3x5 matrix",
    )
    return result


def _validate_tasks(
    tasks: Sequence[Mapping[str, Any]],
    *,
    formal_manifest_sha: str,
    game_manifest_sha: str,
    protocol_sha: str,
    opening_manifest_sha: str,
    preparation_runner_sha: str,
    checkpoint_registry: Mapping[tuple[str, int], Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    _require(len(tasks) == EXPECTED_TASKS, "task manifest does not contain exactly 45 rows")
    expected_cells = {
        (pair, seed, size)
        for pair in MODEL_PAIRS
        for seed in TRAINING_SEEDS
        for size in SIZES
    }
    observed_cells: set[tuple[tuple[str, str], int, int]] = set()
    by_id: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(tasks):
        task = dict(_mapping(raw, f"tasks[{index}]"))
        task_id = str(task.get("task_id", ""))
        _require(task_id and task_id not in by_id, "duplicate/empty task ID")
        _require(task.get("schema_name") == TASK_SCHEMA and task.get("schema_version") == SCHEMA_VERSION, f"{task_id}: task schema mismatch")
        _require(task.get("experiment_id") == EXPERIMENT_ID and task.get("experiment_arm") == EXPERIMENT_ARM, f"{task_id}: experiment identity mismatch")
        _require(task.get("evidence_tier") == "formal_prospective_not_run", f"{task_id}: evidence tier changed")
        seed = _integer(task.get("training_seed"), f"{task_id}.training_seed")
        size = _integer(task.get("eval_size"), f"{task_id}.eval_size")
        pair_raw = _sequence(task.get("model_pair"), f"{task_id}.model_pair")
        _require(len(pair_raw) == 2, f"{task_id}: model pair must have two members")
        pair = (str(pair_raw[0]), str(pair_raw[1]))
        _require((pair, seed, size) in expected_cells, f"{task_id}: unexpected task matrix cell")
        _require((pair, seed, size) not in observed_cells, f"{task_id}: duplicate task matrix cell")
        expected_id = f"d18v3.n{size}.seed{seed}.{pair[0]}.vs.{pair[1]}"
        _require(task_id == expected_id, f"{task_id}: non-canonical task ID")
        observed_cells.add((pair, seed, size))
        _require(task.get("formal_manifest_sha256") == formal_manifest_sha, f"{task_id}: formal manifest hash mismatch")
        _require(task.get("protocol_sha256") == protocol_sha, f"{task_id}: protocol hash mismatch")
        _require(task.get("opening_manifest_sha256") == opening_manifest_sha, f"{task_id}: opening manifest hash mismatch")
        _require(task.get("runner_sha256") == preparation_runner_sha, f"{task_id}: preparation runner hash mismatch")
        _require(task.get("game_manifest_sha256") == game_manifest_sha, f"{task_id}: game manifest hash mismatch")
        _require(task.get("games") == GAMES_PER_TASK and task.get("color_pairs") == PAIRS_PER_TASK, f"{task_id}: task count contract changed")
        _require(task.get("opening_strata") == STRATA_PER_TASK and task.get("variants_per_stratum") == VARIANTS_PER_STRATUM, f"{task_id}: stratum contract changed")
        _require(task.get("formal_gates") == FORMAL_GATES, f"{task_id}: task diversity thresholds changed")
        _require(task.get("search") == SEARCH, f"{task_id}: task search contract changed")
        _require(task.get("max_plies") == 256 and task.get("superko_mode") == "enforce" and task.get("start_player") == "BLACK", f"{task_id}: task game rules changed")
        _require(task.get("inference_group_id") == f"d16-v3.{pair[0]}_vs_{pair[1]}.n{size}", f"{task_id}: inference group mismatch")
        bindings = _mapping(task.get("agent_bindings"), f"{task_id}.agent_bindings")
        _require(set(bindings) == {"A", "B"}, f"{task_id}: agent slots changed")
        binding_a = dict(_mapping(bindings["A"], f"{task_id}.A"))
        binding_b = dict(_mapping(bindings["B"], f"{task_id}.B"))
        _require(binding_a == checkpoint_registry[(pair[0], seed)], f"{task_id}: A checkpoint differs from registry")
        _require(binding_b == checkpoint_registry[(pair[1], seed)], f"{task_id}: B checkpoint differs from registry")
        pair_plan = _sequence(task.get("pair_plan"), f"{task_id}.pair_plan")
        _require(len(pair_plan) == PAIRS_PER_TASK, f"{task_id}: pair plan count is not 64")
        by_id[task_id] = task
    _require(observed_cells == expected_cells, "task manifest does not cover the exact frozen matrix")
    return by_id


def _validate_games(
    raw_games: Sequence[Mapping[str, Any]],
    tasks_by_id: Mapping[str, Mapping[str, Any]],
    openings_by_id: Mapping[str, Mapping[str, Any]],
    *,
    formal_manifest_sha: str,
    opening_manifest_sha: str,
    preparation_runner_sha: str,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    _require(len(raw_games) == EXPECTED_GAMES, "game manifest does not contain exactly 5,760 rows")
    _require(len({str(row.get("game_id", "")) for row in raw_games}) == EXPECTED_GAMES, "game IDs are not unique")
    _require(
        [row.get("global_game_index") for row in raw_games] == list(range(EXPECTED_GAMES)),
        "global game indices are not canonical",
    )
    grouped_raw: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in raw_games:
        grouped_raw[str(row.get("task_id", ""))].append(row)
    _require(set(grouped_raw) == set(tasks_by_id), "game manifest task IDs differ from task manifest")

    grouped_bound: dict[str, list[dict[str, Any]]] = {}
    by_game_id: dict[str, dict[str, Any]] = {}
    schedule_signatures: dict[int, set[str]] = defaultdict(set)
    for task_id, task in tasks_by_id.items():
        rows = grouped_raw[task_id]
        _require(len(rows) == GAMES_PER_TASK, f"{task_id}: frozen game count is not 128")
        pair_plans = _sequence(task["pair_plan"], f"{task_id}.pair_plan")
        plans: dict[str, Mapping[str, Any]] = {}
        for raw_plan in pair_plans:
            plan = _mapping(raw_plan, f"{task_id}.pair_plan")
            pair_id = str(plan.get("pair_id", ""))
            _require(pair_id and pair_id not in plans, f"{task_id}: duplicate pair plan")
            plans[pair_id] = plan
        bound: list[dict[str, Any]] = []
        stratum_counts: Counter[int] = Counter()
        variant_members: dict[tuple[int, int], set[int]] = defaultdict(set)
        signature_rows: list[dict[str, Any]] = []
        for raw_row in rows:
            row = dict(_mapping(raw_row, f"{task_id}.game"))
            game_id = str(row.get("game_id", ""))
            _require(row.get("schema_name") == GAME_SCHEDULE_SCHEMA and row.get("schema_version") == SCHEMA_VERSION, f"{game_id}: game schedule schema mismatch")
            _require(row.get("experiment_id") == EXPERIMENT_ID, f"{game_id}: experiment ID mismatch")
            _require(row.get("formal_manifest_sha256") == formal_manifest_sha, f"{game_id}: formal manifest hash mismatch")
            _require(row.get("opening_manifest_sha256") == opening_manifest_sha, f"{game_id}: opening manifest hash mismatch")
            _require(row.get("runner_sha256") == preparation_runner_sha, f"{game_id}: preparation runner hash mismatch")
            _require(row.get("protocol_sha256") == task.get("protocol_sha256"), f"{game_id}: protocol hash mismatch")
            pair_id = str(row.get("pair_id", ""))
            _require(pair_id in plans, f"{game_id}: game has no pair plan")
            plan = plans[pair_id]
            member = _integer(row.get("pair_member"), f"{game_id}.pair_member", minimum=0)
            _require(member in (0, 1), f"{game_id}: pair member is not 0/1")
            _require(row.get("game_id") == plan["game_ids"][member], f"{game_id}: pair plan game ID mismatch")
            comparisons = {
                "opening_actions": plan["opening_actions"],
                "opening_id": plan["opening_id"],
                "opening_prefix_hash": plan["opening_prefix_hash"],
                "opening_state_hash": plan["opening_state_hash"],
                "opening_stratum": plan["stratum_id"],
                "opening_variant": plan["variant_index"],
                "policy_seed_a": plan["policy_seed_a"],
                "policy_seed_assignment": plan["policy_seed_assignment"],
                "policy_seed_b": plan["policy_seed_b"],
                "stratum_index": plan["stratum_index"],
            }
            for field, expected in comparisons.items():
                _require(row.get(field) == expected, f"{game_id}: task/game join changed {field}")
            size = int(task["eval_size"])
            stratum = int(row["stratum_index"])
            variant = int(row["opening_variant"])
            opening = openings_by_id.get(str(row["opening_id"]))
            _require(opening is not None, f"{game_id}: opening absent from frozen registry")
            for field, expected in {
                "eval_size": size,
                "stratum_index": stratum,
                "variant_index": variant,
                "stratum_id": row["opening_stratum"],
                "opening_actions": row["opening_actions"],
                "opening_prefix_hash": row["opening_prefix_hash"],
                "opening_state_hash": row["opening_state_hash"],
            }.items():
                _require(opening.get(field) == expected, f"{game_id}: opening registry mismatch for {field}")
            low, high = _policy_seed_pair(size=size, stratum=stratum)
            expected_a, expected_b = (low, high) if variant == 0 else (high, low)
            _require(plan.get("policy_seed_low") == low and plan.get("policy_seed_high") == high, f"{game_id}: low/high seed derivation changed")
            _require(row.get("policy_seed_a") == expected_a and row.get("policy_seed_b") == expected_b, f"{game_id}: crossed A/B seed assignment changed")
            expected_slots = ("A", "B") if member == 0 else ("B", "A")
            _require((row.get("black_slot"), row.get("white_slot")) == expected_slots, f"{game_id}: color swap changed")
            expected_black_seed = expected_a if expected_slots[0] == "A" else expected_b
            expected_white_seed = expected_a if expected_slots[1] == "A" else expected_b
            _require(row.get("black_policy_seed") == expected_black_seed and row.get("white_policy_seed") == expected_white_seed, f"{game_id}: policy seed moved with color")
            _require(row.get("max_plies") == 256 and row.get("superko_mode") == "enforce" and row.get("start_player") == "BLACK", f"{game_id}: game rules changed")
            bounded = dict(row)
            bounded["eval_size"] = size
            bounded["pair_index"] = int(plan["pair_index"])
            bounded["frozen_game_schedule_sha256"] = canonical_sha256(row)
            bound.append(bounded)
            by_game_id[game_id] = bounded
            stratum_counts[stratum] += 1
            variant_members[(stratum, variant)].add(member)
            signature_rows.append(
                {
                    "opening_actions": row["opening_actions"],
                    "opening_id": row["opening_id"],
                    "opening_variant": variant,
                    "pair_member": member,
                    "policy_seed_a": expected_a,
                    "policy_seed_b": expected_b,
                    "stratum_index": stratum,
                }
            )
        bound.sort(key=lambda item: int(item["game_index"]))
        _require([row["game_index"] for row in bound] == list(range(GAMES_PER_TASK)), f"{task_id}: task game indices changed")
        _require(stratum_counts == Counter({index: 4 for index in range(STRATA_PER_TASK)}), f"{task_id}: stratum balance changed")
        _require(variant_members == {(s, v): {0, 1} for s in range(STRATA_PER_TASK) for v in range(VARIANTS_PER_STRATUM)}, f"{task_id}: variant/color schedule incomplete")
        schedule_signatures[int(task["eval_size"])].add(canonical_sha256(signature_rows))
        grouped_bound[task_id] = bound
    _require(set(schedule_signatures) == set(SIZES) and all(len(values) == 1 for values in schedule_signatures.values()), "tasks of one size do not share the same opening/seed/color schedule")
    return grouped_bound, by_game_id


def _validate_execution_metadata(
    metadata: Mapping[str, Any],
    *,
    formal_manifest_sha: str,
    task_manifest_sha: str,
    game_manifest_sha: str,
    protocol_sha: str,
    preparation_runner_path: Path,
    formal_runner_path: Path,
) -> tuple[str, str, bool]:
    _require(metadata.get("schema_name") == RUN_SCHEMA and metadata.get("schema_version") == SCHEMA_VERSION, "execution metadata schema mismatch")
    _require(metadata.get("experiment_id") == EXPERIMENT_ID, "execution metadata experiment mismatch")
    _require(metadata.get("formal_manifest_sha256") == formal_manifest_sha, "execution metadata manifest hash mismatch")
    _require(metadata.get("protocol_sha256") == protocol_sha, "execution metadata protocol hash mismatch")
    preparation_sha = sha256_file(preparation_runner_path)
    formal_sha = sha256_file(formal_runner_path)
    verifier_sha = sha256_file(SCRIPT_PATH)
    _require(metadata.get("preparation_runner_sha256") == preparation_sha, "execution metadata preparation-runner mismatch")
    _require(metadata.get("formal_runner_sha256") == formal_sha, "execution metadata formal-runner mismatch")
    _require(metadata.get("verifier_sha256") == verifier_sha, "execution metadata verifier mismatch")
    _require(metadata.get("task_manifest_sha256") == task_manifest_sha, "execution metadata task-manifest mismatch")
    _require(metadata.get("game_manifest_sha256") == game_manifest_sha, "execution metadata game-manifest mismatch")
    _require(_valid_sha256(metadata.get("bundle_summary_sha256")) and _valid_sha256(metadata.get("manifest_snapshot_sha256")), "execution metadata bundle hashes are missing")
    _require(_valid_sha256(metadata.get("formal_source_hash")), "execution metadata formal source hash is invalid")
    _require(
        _valid_sha256(metadata.get("throughput_profile_sha256")),
        "execution metadata throughput-profile hash is invalid",
    )
    _require(
        metadata.get("throughput_profile_artifact_path")
        == THROUGHPUT_PROFILE_ARTIFACT_NAME,
        "execution metadata throughput-profile artifact path is not canonical",
    )
    _require(
        metadata.get("throughput_profile_schema_name") == THROUGHPUT_PROFILE_SCHEMA,
        "execution metadata throughput-profile schema mismatch",
    )
    _require(
        _integer(
            metadata.get("throughput_profile_schema_version"),
            "execution_metadata.throughput_profile_schema_version",
        )
        == SCHEMA_VERSION,
        "execution metadata throughput-profile version mismatch",
    )
    _require(
        metadata.get("throughput_profile_formal_manifest_sha256")
        == formal_manifest_sha,
        "execution metadata throughput-profile manifest binding mismatch",
    )
    _require(
        metadata.get("throughput_profile_formal_runner_sha256") == formal_sha,
        "execution metadata throughput-profile runner binding mismatch",
    )
    _require(
        _integer(metadata.get("scalar_lane_count"), "execution_metadata.scalar_lane_count")
        == SCALAR_LANE_COUNT,
        "execution metadata scalar lane count mismatch",
    )
    _require(
        metadata.get("scalar_lane_execution_mode") == SCALAR_LANE_EXECUTION_MODE,
        "execution metadata scalar lane execution mode mismatch",
    )
    _require(
        _integer(
            metadata.get("inference_batch_size"),
            "execution_metadata.inference_batch_size",
        )
        == INFERENCE_BATCH_SIZE,
        "execution metadata inference batch size mismatch",
    )
    _require(
        metadata.get("inference_dtype") == INFERENCE_DTYPE,
        "execution metadata inference dtype mismatch",
    )
    _require(
        metadata.get("amp_enabled") is False,
        "execution metadata must bind AMP disabled",
    )
    freeze_core: dict[str, Any] = {}
    for field in EXECUTION_FREEZE_FIELDS:
        _require(field in metadata, f"execution metadata freeze core is missing {field}")
        freeze_core[field] = metadata[field]
    _require(
        metadata.get("execution_freeze_sha256") == canonical_sha256(freeze_core),
        "execution metadata freeze hash mismatch",
    )
    source_hashes = _mapping(metadata.get("execution_source_hashes"), "execution_metadata.execution_source_hashes")
    _require(bool(source_hashes), "execution source closure is empty")
    for raw_path, digest in source_hashes.items():
        _require(isinstance(raw_path, str) and _valid_sha256(digest), "invalid execution source binding")
        source = _resolve_repo_path(raw_path)
        _require(source.is_file() and sha256_file(source) == digest, f"execution source hash changed: {raw_path}")
    _require(source_hashes.get(_repo_relative(preparation_runner_path)) == preparation_sha, "preparation runner absent from execution source closure")
    _require(source_hashes.get(_repo_relative(formal_runner_path)) == formal_sha, "formal runner absent from execution source closure")
    verifier_bound = source_hashes.get(_repo_relative(SCRIPT_PATH)) == verifier_sha
    return preparation_sha, formal_sha, verifier_bound


def _validate_throughput_profile_evidence(
    profile_path: Path,
    *,
    metadata: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]],
    grouped_schedules: Mapping[str, Sequence[Mapping[str, Any]]],
    checkpoint_registry: Mapping[tuple[str, int], Mapping[str, Any]],
    formal_manifest_sha: str,
    formal_runner_sha: str,
) -> dict[str, Any]:
    """Independently validate the nine-case, persistent-worker GPU receipt.

    Each smoke lane is bound to the frozen member-zero game schedule selected
    by the first pair plan.  Color slots belong to that concrete game row, not
    to the two-member pair plan whose members intentionally swap colors.
    """

    profile_path = profile_path.resolve()
    _require(
        profile_path.name == THROUGHPUT_PROFILE_ARTIFACT_NAME
        and profile_path.is_file()
        and not profile_path.is_symlink(),
        "throughput profile evidence is missing, unsafe, or non-canonical",
    )
    _require(
        sha256_file(profile_path) == metadata.get("throughput_profile_sha256"),
        "throughput profile evidence hash differs from execution metadata",
    )
    profile = load_json(profile_path)
    expected = {
        "schema_name": THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": formal_manifest_sha,
        "formal_runner_sha256": formal_runner_sha,
        "preparation_runner_sha256": metadata.get("preparation_runner_sha256"),
        "formal_games_executed": 0,
        "frozen_checkpoint_models": True,
        "device": "cuda",
        "inference_only": True,
        "training_mode": False,
        "amp_enabled": False,
        "batch_calibration_performed": False,
        "selected_batch_size": 1,
        "inference_batch_size": 1,
        "inference_dtype": "float32",
        "scalar_lane_count": SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": SCALAR_LANE_EXECUTION_MODE,
        "production_equivalent_mode": True,
        "optimizer_steps": 0,
        "backward_calls": 0,
        "formal_numeric_path_match": True,
        "puct_simulations": SEARCH["simulations"],
        "temperature": SEARCH["temperature"],
        "root_noise": SEARCH["add_root_noise"],
        "data_supply": "registered_d18_v3_task_binding_and_opening_clone",
        "formal_game_count": EXPECTED_GAMES,
        "formal_runtime_seconds": MAX_RUNTIME_SECONDS,
        "formal_gameplay_budget_seconds": FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "non_gameplay_reserve_fraction": FORMAL_NON_GAMEPLAY_RESERVE_FRACTION,
        "aggregate_peak_memory_limit_bytes": MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "minimum_device_memory_bytes": MIN_DEVICE_MEMORY_BYTES,
        "minimum_device_free_headroom_bytes": MIN_DEVICE_FREE_HEADROOM_BYTES,
        "resident_checkpoint_count_per_worker": 15,
        "resident_integrity_check_mode": (
            "final_case_all_checkpoints_against_preload_cuda_clones"
        ),
        "resident_integrity_worker_count": SCALAR_LANE_COUNT,
    }
    for field, expected_value in expected.items():
        _require(
            profile.get(field) == expected_value,
            f"throughput profile evidence mismatch for {field}",
        )
    _require(
        "rtx 5090" in str(profile.get("device_name", "")).lower(),
        "throughput profile evidence is not from RTX 5090",
    )
    _require(
        str(profile.get("torch_version", "")).split("+", 1)[0]
        == EXPECTED_TORCH_VERSION
        and profile.get("cuda_runtime_version") == EXPECTED_CUDA_RUNTIME_VERSION,
        "throughput profile environment versions differ",
    )

    max_plies = max(
        _integer(task.get("max_plies"), "task.max_plies", minimum=1)
        for task in tasks
    )
    worst_case_decisions = sum(
        _integer(task.get("games"), "task.games", minimum=1)
        * _integer(task.get("max_plies"), "task.max_plies", minimum=1)
        for task in tasks
    )
    _require(
        profile.get("formal_max_plies") == max_plies
        and profile.get("worst_case_puct_decisions") == worst_case_decisions,
        "throughput profile worst-case load differs from frozen tasks",
    )
    requested = _finite_number(
        profile.get("requested_sustained_seconds"),
        "throughput.requested_sustained_seconds",
        minimum=GPU_SMOKE_MIN_TOTAL_SECONDS,
    )
    _require(
        requested <= GPU_SMOKE_MAX_TOTAL_SECONDS,
        "throughput profile requested duration gate failed",
    )
    requested_case = _finite_number(
        profile.get("requested_case_seconds"),
        "throughput.requested_case_seconds",
        minimum=GPU_SMOKE_MIN_TOTAL_SECONDS / GPU_SMOKE_CASE_COUNT,
    )
    _require(
        math.isclose(
            requested_case,
            requested / GPU_SMOKE_CASE_COUNT,
            rel_tol=1e-12,
            abs_tol=1e-12,
        ),
        "throughput profile case duration does not partition the total request",
    )
    total = _finite_number(profile.get("total_seconds"), "throughput.total_seconds")
    duration = _finite_number(
        profile.get("duration_seconds"), "throughput.duration_seconds"
    )
    sustained_total = _finite_number(
        profile.get("sustained_seconds"), "throughput.sustained_seconds"
    )
    setup_total = _finite_number(
        profile.get("setup_seconds"), "throughput.setup_seconds", minimum=0.0
    )
    _require(
        math.isclose(duration, total, rel_tol=1e-12, abs_tol=1e-12)
        and GPU_SMOKE_MIN_TOTAL_SECONDS <= total <= GPU_SMOKE_MAX_TOTAL_SECONDS
        and GPU_SMOKE_MIN_TOTAL_SECONDS <= sustained_total <= total
        and math.isclose(
            setup_total, total - sustained_total, rel_tol=1e-12, abs_tol=1e-9
        ),
        "throughput profile total/setup duration gate failed",
    )

    registry_by_id: dict[str, Mapping[str, Any]] = {}
    for (kind, seed), binding in checkpoint_registry.items():
        checkpoint_id = str(binding.get("checkpoint_id", ""))
        _require(
            kind in MODEL_KINDS
            and seed in TRAINING_SEEDS
            and checkpoint_id
            and checkpoint_id not in registry_by_id
            and binding.get("model_kind") == kind
            and binding.get("training_seed") == seed,
            "throughput checkpoint registry is invalid",
        )
        registry_by_id[checkpoint_id] = binding
    _require(
        len(registry_by_id) == len(MODEL_KINDS) * len(TRAINING_SEEDS),
        "throughput checkpoint registry is incomplete",
    )

    task_groups: dict[tuple[tuple[str, str], int], list[Mapping[str, Any]]] = (
        defaultdict(list)
    )
    for task in tasks:
        key = (
            tuple(str(value) for value in _sequence(task.get("model_pair"), "task.model_pair")),
            _integer(task.get("eval_size"), "task.eval_size"),
        )
        task_groups[key].append(task)
    expected_cases = [
        (pair, size) for pair in MODEL_PAIRS for size in SIZES
    ]
    _require(
        set(task_groups) == set(expected_cases),
        "throughput frozen task case coverage differs",
    )
    ordered_tasks = {
        key: sorted(
            rows,
            key=lambda row: (
                _integer(row.get("training_seed"), "task.seed"),
                str(row.get("task_id", "")),
            ),
        )
        for key, rows in task_groups.items()
    }
    task_ids = {str(task.get("task_id", "")) for task in tasks}
    _require(
        set(grouped_schedules) == task_ids,
        "throughput frozen game schedules do not cover the exact task set",
    )
    selected_schedules: dict[str, Mapping[str, Any]] = {}
    for task in tasks:
        task_id = str(task.get("task_id", ""))
        pair_plans = _sequence(task.get("pair_plan"), f"{task_id}.pair_plan")
        _require(bool(pair_plans), f"{task_id}: pair plan is empty")
        first_plan = _mapping(pair_plans[0], f"{task_id}.pair_plan[0]")
        game_ids = _sequence(
            first_plan.get("game_ids"), f"{task_id}.pair_plan[0].game_ids"
        )
        _require(
            len(game_ids) == 2,
            f"{task_id}: first pair plan does not contain two game IDs",
        )
        selected_game_id = str(game_ids[0])
        matches: list[Mapping[str, Any]] = []
        for schedule_index, raw_schedule in enumerate(
            _sequence(grouped_schedules.get(task_id), f"{task_id}.schedules")
        ):
            schedule = _mapping(
                raw_schedule, f"{task_id}.schedules[{schedule_index}]"
            )
            if str(schedule.get("game_id", "")) == selected_game_id:
                matches.append(schedule)
        _require(
            len(matches) == 1,
            f"{task_id}: selected smoke game schedule is missing or duplicated",
        )
        selected_schedule = matches[0]
        _require(
            selected_schedule.get("task_id") == task_id
            and selected_schedule.get("pair_id") == first_plan.get("pair_id")
            and _integer(
                selected_schedule.get("pair_member"),
                f"{task_id}.selected_schedule.pair_member",
                minimum=0,
            )
            == 0
            and _valid_sha256(
                selected_schedule.get("frozen_game_schedule_sha256")
            )
            and {
                selected_schedule.get("black_slot"),
                selected_schedule.get("white_slot"),
            }
            == {"A", "B"},
            f"{task_id}: selected smoke game schedule binding differs",
        )
        selected_schedules[task_id] = selected_schedule

    preload_rows = _sequence(
        profile.get("resident_cache_preload_results"),
        "throughput.resident_cache_preload_results",
    )
    _require(
        len(preload_rows) == SCALAR_LANE_COUNT,
        "throughput preload evidence does not contain twelve workers",
    )
    preload_pids: set[int] = set()
    memory_by_pid: dict[int, dict[str, int]] = {}
    device_totals: set[int] = set()
    expected_checkpoint_ids = set(registry_by_id)
    for index, raw_preload in enumerate(preload_rows):
        preload = _mapping(raw_preload, f"throughput.preload[{index}]")
        _require(
            preload.get("lane_index") == index,
            "throughput preload lane order differs",
        )
        pid = _integer(preload.get("worker_pid"), "preload.worker_pid", minimum=1)
        preload_pids.add(pid)
        checkpoint_ids = [
            str(value)
            for value in _sequence(
                preload.get("checkpoint_ids"), "preload.checkpoint_ids"
            )
        ]
        _require(
            preload.get("checkpoint_count") == 15
            and len(checkpoint_ids) == 15
            and len(set(checkpoint_ids)) == 15
            and set(checkpoint_ids) == expected_checkpoint_ids,
            "throughput preload did not bind all fifteen checkpoints",
        )
        baseline_checkpoint_ids = [
            str(value)
            for value in _sequence(
                preload.get("device_baseline_checkpoint_ids"),
                "preload.device_baseline_checkpoint_ids",
            )
        ]
        _require(
            preload.get("device_baseline_checkpoint_count") == 15
            and baseline_checkpoint_ids == checkpoint_ids
            and _integer(
                preload.get("device_baseline_tensor_count"),
                "preload.device_baseline_tensor_count",
                minimum=15,
            )
            >= 15
            and preload.get("device_baseline_storage") == "immutable_cuda_clone",
            "throughput preload device baseline differs",
        )
        allocated = _integer(
            preload.get("max_memory_allocated_bytes"),
            "preload.max_memory_allocated_bytes",
            minimum=1,
        )
        reserved = _integer(
            preload.get("max_memory_reserved_bytes"),
            "preload.max_memory_reserved_bytes",
            minimum=allocated,
        )
        total_memory = _integer(
            preload.get("device_total_memory_bytes"),
            "preload.device_total_memory_bytes",
            minimum=MIN_DEVICE_MEMORY_BYTES,
        )
        free_memory = _integer(
            preload.get("device_free_memory_bytes"),
            "preload.device_free_memory_bytes",
            minimum=0,
        )
        _require(
            reserved <= total_memory and free_memory <= total_memory,
            "throughput preload memory telemetry is invalid",
        )
        memory_by_pid[pid] = {
            "max_memory_allocated_bytes": allocated,
            "max_memory_reserved_bytes": reserved,
        }
        device_totals.add(total_memory)
    _require(
        len(preload_pids) == SCALAR_LANE_COUNT,
        "throughput preload worker processes are not distinct",
    )

    lanes = _sequence(profile.get("lane_results"), "throughput.lane_results")
    _require(
        len(lanes) == GPU_SMOKE_CASE_COUNT * SCALAR_LANE_COUNT,
        "throughput profile does not contain nine complete twelve-lane cases",
    )
    decisions = 0
    forwards = 0
    utilization: list[float] = []
    case_sustained: dict[int, list[float]] = defaultdict(list)
    case_decision_timings: dict[int, list[float]] = defaultdict(list)
    observed_kinds: set[str] = set()
    observed_kind_sizes: set[tuple[str, int]] = set()
    observed_pairs: set[tuple[str, str]] = set()
    observed_sizes: set[int] = set()
    observed_pair_sizes: set[tuple[tuple[str, str], int]] = set()
    opening_ids: dict[str, set[str]] = {str(size): set() for size in SIZES}
    resident_integrity_results: list[Mapping[str, Any]] = []

    for flat_index, raw_lane in enumerate(lanes):
        lane = _mapping(raw_lane, f"throughput.lane[{flat_index}]")
        case_index = flat_index // SCALAR_LANE_COUNT
        lane_index = flat_index % SCALAR_LANE_COUNT
        pair, size = expected_cases[case_index]
        selected = ordered_tasks[(pair, size)][
            lane_index % len(ordered_tasks[(pair, size)])
        ]
        _require(
            lane.get("case_index") == case_index
            and lane.get("lane_index") == lane_index
            and tuple(str(value) for value in _sequence(lane.get("model_pair"), "lane.model_pair")) == pair
            and lane.get("eval_size") == size
            and lane.get("coverage_case_id") == f"{pair[0]}_vs_{pair[1]}.n{size}"
            and lane.get("task_id") == selected.get("task_id")
            and lane.get("training_seed") == selected.get("training_seed"),
            "throughput lane case/task binding differs",
        )
        selected_task_id = str(selected.get("task_id", ""))
        selected_schedule = selected_schedules[selected_task_id]
        _require(
            lane.get("opening_id") == selected_schedule.get("opening_id"),
            "throughput lane opening differs from selected task schedule",
        )
        superko_mode = str(selected.get("superko_mode", "enforce"))
        max_plies = _integer(selected.get("max_plies"), "task.max_plies", minimum=1)
        opening_game, opening_plies = _throughput_opening_game(
            selected_schedule, size=size, superko_mode=superko_mode
        )
        _require(
            lane.get("game_id") == selected_schedule.get("game_id")
            and lane.get("pair_id") == selected_schedule.get("pair_id")
            and _integer(
                lane.get("pair_member"),
                f"throughput.lane[{flat_index}].pair_member",
                minimum=0,
            )
            == 0
            and lane.get("frozen_game_schedule_sha256")
            == selected_schedule.get("frozen_game_schedule_sha256")
            and lane.get("black_slot") == selected_schedule.get("black_slot")
            and lane.get("white_slot") == selected_schedule.get("white_slot")
            and {lane.get("black_slot"), lane.get("white_slot")} == {"A", "B"},
            "throughput lane frozen game schedule binding differs",
        )
        agents = _sequence(lane.get("agents"), "lane.agents")
        _require(
            len(agents) == 2
            and lane.get("agent_slots_exercised") == ["A", "B"]
            and lane.get("warmup_puct_decisions") == 2,
            "throughput lane did not exercise both formal agents",
        )
        resident_integrity = lane.get("resident_integrity")
        if case_index == GPU_SMOKE_CASE_COUNT - 1:
            resident_integrity_results.append(
                _mapping(resident_integrity, "lane.resident_integrity")
            )
        else:
            _require(
                resident_integrity is None,
                "throughput lane performed resident integrity before the final case",
            )
        task_bindings = _mapping(selected.get("agent_bindings"), "task.agent_bindings")
        for agent_index, slot in enumerate(("A", "B")):
            agent = _mapping(agents[agent_index], f"lane.agents[{agent_index}]")
            binding = _mapping(task_bindings.get(slot), f"task.agent_bindings.{slot}")
            expected_kind = pair[agent_index]
            checkpoint_id = str(agent.get("checkpoint_id", ""))
            manifest_binding = registry_by_id.get(checkpoint_id)
            _require(
                agent.get("agent_slot") == slot
                and agent.get("model_kind") == expected_kind
                and checkpoint_id == binding.get("checkpoint_id")
                and manifest_binding is not None
                and manifest_binding.get("model_kind") == expected_kind
                and manifest_binding.get("training_seed") == lane.get("training_seed"),
                "throughput lane checkpoint/model/slot binding differs from the formal manifest",
            )
            observed_kinds.add(expected_kind)
            observed_kind_sizes.add((expected_kind, size))

        lane_decisions = _integer(
            lane.get("puct_decisions"), "lane.puct_decisions", minimum=2
        )
        lane_forwards = _integer(
            lane.get("model_forward_calls"), "lane.model_forward_calls", minimum=2
        )
        per_agent_decisions = _mapping(
            lane.get("per_agent_puct_decisions"), "lane.per_agent_puct_decisions"
        )
        per_agent_forwards = _mapping(
            lane.get("per_agent_model_forward_calls"),
            "lane.per_agent_model_forward_calls",
        )
        _require(
            set(per_agent_decisions) == {"A", "B"}
            and set(per_agent_forwards) == {"A", "B"},
            "throughput per-agent counters are incomplete",
        )
        agent_decision_total = 0
        agent_forward_total = 0
        for slot in ("A", "B"):
            slot_decisions = _integer(
                per_agent_decisions.get(slot), f"lane.{slot}.decisions", minimum=1
            )
            slot_forwards = _integer(
                per_agent_forwards.get(slot), f"lane.{slot}.forwards", minimum=1
            )
            _require(
                slot_decisions <= slot_forwards <= slot_decisions * 17,
                "throughput per-agent forward count is inconsistent",
            )
            agent_decision_total += slot_decisions
            agent_forward_total += slot_forwards
        _require(
            agent_decision_total == lane_decisions
            and agent_forward_total == lane_forwards,
            "throughput lane counters do not equal per-agent counters",
        )
        decision_timings = [
            _finite_number(value, "lane.decision_seconds", minimum=0.0)
            for value in _sequence(lane.get("decision_seconds"), "lane.decision_seconds")
        ]
        state_fingerprints = list(
            _sequence(
                lane.get("decision_state_fingerprints"),
                "lane.decision_state_fingerprints",
            )
        )
        action_indices = [
            _integer(value, "lane.decision_action_indices", minimum=0)
            for value in _sequence(
                lane.get("decision_action_indices"),
                "lane.decision_action_indices",
            )
        ]
        unique_state_count = _integer(
            lane.get("unique_state_count"), "lane.unique_state_count", minimum=2
        )
        replayed_game = opening_game
        replayed_plies = opening_plies
        replayed_resets = 0
        for decision_index, (fingerprint, action_index) in enumerate(
            zip(state_fingerprints, action_indices)
        ):
            _require(
                _valid_sha256(fingerprint)
                and fingerprint == replayed_game.state_fingerprint()
                and not replayed_game.game_over,
                "throughput lane pre-state fingerprint/action trace differs",
            )
            _apply_action_index(
                replayed_game,
                action_index,
                f"lane.decision_action_indices[{decision_index}]",
            )
            replayed_plies += 1
            if replayed_game.game_over or replayed_plies >= max_plies:
                replayed_game, replayed_plies = _throughput_opening_game(
                    selected_schedule,
                    size=size,
                    superko_mode=superko_mode,
                )
                replayed_resets += 1
        _require(
            len(decision_timings) == lane_decisions
            and len(state_fingerprints) == lane_decisions
            and len(action_indices) == lane_decisions
            and unique_state_count == len(set(state_fingerprints))
            and all(value > 0.0 for value in decision_timings)
            and math.isclose(
                _finite_number(
                    lane.get("slowest_decision_seconds"),
                    "lane.slowest_decision_seconds",
                ),
                max(decision_timings),
                rel_tol=1e-12,
                abs_tol=1e-12,
            )
            and _integer(lane.get("game_resets"), "lane.game_resets", minimum=0)
            == replayed_resets,
            "throughput lane multi-state decision timing evidence is invalid",
        )
        sustained = _finite_number(
            lane.get("sustained_seconds"), "lane.sustained_seconds"
        )
        lane_total = _finite_number(lane.get("total_seconds"), "lane.total_seconds")
        lane_setup = _finite_number(
            lane.get("setup_seconds"), "lane.setup_seconds", minimum=0.0
        )
        _require(
            requested_case <= sustained
            and sustained <= lane_total <= total
            and lane_setup <= lane_total,
            "throughput lane duration failed",
        )
        _require(
            lane.get("device") == "cuda"
            and "rtx 5090" in str(lane.get("device_name", "")).lower()
            and str(lane.get("torch_version", "")).split("+", 1)[0]
            == EXPECTED_TORCH_VERSION
            and lane.get("cuda_runtime_version") == EXPECTED_CUDA_RUNTIME_VERSION,
            "throughput lane environment differs",
        )
        total_memory = _integer(
            lane.get("device_total_memory_bytes"),
            "lane.device_total_memory_bytes",
            minimum=MIN_DEVICE_MEMORY_BYTES,
        )
        allocated = _integer(
            lane.get("max_memory_allocated_bytes"),
            "lane.max_memory_allocated_bytes",
            minimum=1,
        )
        reserved = _integer(
            lane.get("max_memory_reserved_bytes"),
            "lane.max_memory_reserved_bytes",
            minimum=allocated,
        )
        free_memory = _integer(
            lane.get("device_free_memory_bytes"),
            "lane.device_free_memory_bytes",
            minimum=0,
        )
        _require(
            reserved <= total_memory and free_memory <= total_memory,
            "throughput lane memory telemetry is invalid",
        )
        pid = _integer(lane.get("worker_pid"), "lane.worker_pid", minimum=1)
        _require(pid in preload_pids, "throughput lane did not use a preloaded worker")
        memory_by_pid[pid]["max_memory_allocated_bytes"] = max(
            memory_by_pid[pid]["max_memory_allocated_bytes"], allocated
        )
        memory_by_pid[pid]["max_memory_reserved_bytes"] = max(
            memory_by_pid[pid]["max_memory_reserved_bytes"], reserved
        )
        device_totals.add(total_memory)
        samples = [
            _finite_number(value, "lane.utilization")
            for value in _sequence(
                lane.get("gpu_utilization_samples_percent"), "lane.utilization"
            )
        ]
        _require(
            bool(samples) and all(0.0 <= value <= 100.0 for value in samples),
            "throughput lane utilization is invalid",
        )
        decisions += lane_decisions
        forwards += lane_forwards
        utilization.extend(samples)
        case_sustained[case_index].append(sustained)
        case_decision_timings[case_index].extend(decision_timings)
        observed_pairs.add(pair)
        observed_sizes.add(size)
        observed_pair_sizes.add((pair, size))
        opening_ids[str(size)].add(str(lane["opening_id"]))

    for case_index in range(GPU_SMOKE_CASE_COUNT):
        case_rows = [
            _mapping(lanes[case_index * SCALAR_LANE_COUNT + offset], "lane")
            for offset in range(SCALAR_LANE_COUNT)
        ]
        _require(
            {int(row["worker_pid"]) for row in case_rows} == preload_pids,
            "throughput case does not use all twelve preloaded workers",
        )

    profile_integrity = [
        _mapping(row, f"throughput.resident_integrity[{index}]")
        for index, row in enumerate(
            _sequence(
                profile.get("resident_integrity_results"),
                "throughput.resident_integrity_results",
            )
        )
    ]
    _require(
        profile_integrity == resident_integrity_results
        and len(profile_integrity) == SCALAR_LANE_COUNT,
        "throughput resident integrity result set differs",
    )
    integrity_pids: set[int] = set()
    for index, integrity in enumerate(profile_integrity):
        integrity_pids.add(
            _integer(
                integrity.get("worker_pid"),
                f"resident_integrity[{index}].worker_pid",
                minimum=1,
            )
        )
        integrity_checkpoint_ids = [
            str(value)
            for value in _sequence(
                integrity.get("checkpoint_ids"),
                f"resident_integrity[{index}].checkpoint_ids",
            )
        ]
        _require(
            integrity.get("checkpoint_count") == 15
            and len(integrity_checkpoint_ids) == 15
            and len(set(integrity_checkpoint_ids)) == 15
            and set(integrity_checkpoint_ids) == expected_checkpoint_ids
            and _integer(
                integrity.get("tensor_count"),
                f"resident_integrity[{index}].tensor_count",
                minimum=15,
            )
            >= 15
            and integrity.get("device_baseline_storage") == "immutable_cuda_clone"
            and integrity.get("all_state_tensors_unchanged") is True
            and integrity.get("all_parameter_gradients_none") is True,
            "throughput resident checkpoint integrity differs",
        )
    _require(
        integrity_pids == preload_pids,
        "throughput resident integrity does not cover all twelve preload PIDs",
    )

    expected_coverage = {
        "model_kinds": list(MODEL_KINDS),
        "model_kind_size_cases": [
            {"model_kind": kind, "eval_size": size}
            for kind in MODEL_KINDS
            for size in SIZES
        ],
        "model_pairs": [list(pair) for pair in MODEL_PAIRS],
        "evaluation_sizes": list(SIZES),
        "model_pair_size_cases": [
            {"model_pair": list(pair), "eval_size": size}
            for pair in MODEL_PAIRS
            for size in SIZES
        ],
        "opening_ids_by_size": {
            str(size): sorted(opening_ids[str(size)]) for size in SIZES
        },
    }
    _require(
        observed_kinds == set(MODEL_KINDS)
        and observed_kind_sizes
        == {(kind, size) for kind in MODEL_KINDS for size in SIZES}
        and observed_pairs == set(MODEL_PAIRS)
        and observed_sizes == set(SIZES)
        and observed_pair_sizes
        == {(pair, size) for pair in MODEL_PAIRS for size in SIZES}
        and profile.get("coverage") == expected_coverage,
        "throughput profile coverage is incomplete",
    )
    _require(
        any(
            size == 9 and kind == "topology_gnn"
            for kind, size in observed_kind_sizes
        ),
        "throughput profile does not explicitly cover topology_gnn at N=9",
    )

    aggregate_window = sum(
        max(case_sustained[case_index])
        for case_index in range(GPU_SMOKE_CASE_COUNT)
    )
    aggregate_rate = decisions / aggregate_window
    _require(
        math.isclose(aggregate_window, sustained_total, rel_tol=1e-12, abs_tol=1e-9)
        and math.isclose(
            _finite_number(
                profile.get("aggregate_window_seconds"), "throughput.window"
            ),
            aggregate_window,
            rel_tol=1e-12,
            abs_tol=1e-9,
        )
        and math.isclose(
            _finite_number(
                profile.get("aggregate_puct_decisions_per_second"),
                "throughput.rate",
            ),
            aggregate_rate,
            rel_tol=1e-12,
            abs_tol=1e-12,
        )
        and profile.get("puct_decisions") == decisions
        and profile.get("model_forward_calls") == forwards,
        "throughput profile aggregate counters/window differ",
    )

    capacity_rows = _sequence(profile.get("capacity_cases"), "throughput.capacity_cases")
    _require(
        len(capacity_rows) == GPU_SMOKE_CASE_COUNT,
        "throughput capacity case coverage differs",
    )
    projected_total = 0.0
    for case_index, (pair, size) in enumerate(expected_cases):
        capacity = _mapping(capacity_rows[case_index], f"capacity[{case_index}]")
        timings = case_decision_timings[case_index]
        slowest = max(timings)
        case_work = sum(
            _integer(task.get("games"), "task.games", minimum=1)
            * _integer(task.get("max_plies"), "task.max_plies", minimum=1)
            for task in task_groups[(pair, size)]
        )
        task_barrier_work = [
            math.ceil(
                len(_sequence(task.get("pair_plan"), "task.pair_plan"))
                / SCALAR_LANE_COUNT
            )
            * 2
            * _integer(task.get("max_plies"), "task.max_plies", minimum=1)
            for task in task_groups[(pair, size)]
        ]
        work_per_lane = sum(task_barrier_work)
        projected = work_per_lane * slowest
        projected_total += projected
        _require(
            capacity.get("case_index") == case_index
            and capacity.get("model_pair") == list(pair)
            and capacity.get("eval_size") == size
            and capacity.get("formal_task_count") == len(task_groups[(pair, size)])
            and capacity.get("formal_worst_case_decisions") == case_work
            and capacity.get("formal_worst_case_decisions_per_lane") == work_per_lane
            and capacity.get("formal_task_barrier_decisions_per_lane")
            == task_barrier_work
            and capacity.get("observed_scalar_decision_count") == len(timings)
            and capacity.get("capacity_projection_method")
            == (
                "sum_task_barriers_ceil_pairs_over_12_times_two_games_times_"
                "max_plies_times_slowest_observed_single_decision_seconds"
            )
            and math.isclose(
                _finite_number(
                    capacity.get("slowest_single_decision_seconds"),
                    "capacity.slowest_decision",
                ),
                slowest,
                rel_tol=1e-12,
                abs_tol=1e-12,
            )
            and math.isclose(
                _finite_number(
                    capacity.get("projected_worst_case_seconds"),
                    "capacity.projected",
                ),
                projected,
                rel_tol=1e-12,
                abs_tol=1e-9,
            ),
            "throughput capacity case differs from conservative per-decision projection",
        )
    _require(
        math.isclose(
            _finite_number(
                profile.get("projected_worst_case_seconds"),
                "throughput.projected",
            ),
            projected_total,
            rel_tol=1e-12,
            abs_tol=1e-9,
        )
        and projected_total <= FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "throughput profile completion-capacity gate failed",
    )

    resident_expected = [
        {
            "worker_pid": pid,
            "max_memory_allocated_bytes": memory_by_pid[pid][
                "max_memory_allocated_bytes"
            ],
            "max_memory_reserved_bytes": memory_by_pid[pid][
                "max_memory_reserved_bytes"
            ],
        }
        for pid in sorted(memory_by_pid)
    ]
    aggregate_allocated = sum(
        int(row["max_memory_allocated_bytes"]) for row in resident_expected
    )
    aggregate_reserved = sum(
        int(row["max_memory_reserved_bytes"]) for row in resident_expected
    )
    _require(
        profile.get("resident_worker_memory") == resident_expected
        and profile.get("aggregate_peak_memory_allocated_bytes")
        == aggregate_allocated
        and profile.get("aggregate_peak_memory_reserved_bytes")
        == aggregate_reserved
        and aggregate_allocated <= aggregate_reserved
        and aggregate_reserved <= MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "throughput profile resident allocated/reserved memory gate failed",
    )
    _require(
        len(device_totals) == 1,
        "throughput profile device memory totals differ",
    )
    device_total = next(iter(device_totals))
    free_before = _integer(
        profile.get("device_free_memory_before_preload_bytes"),
        "throughput.device_free_before",
        minimum=0,
    )
    free_after = _integer(
        profile.get("device_free_memory_after_smoke_bytes"),
        "throughput.device_free_after",
        minimum=MIN_DEVICE_FREE_HEADROOM_BYTES,
    )
    used_after = _integer(
        profile.get("device_used_memory_after_smoke_bytes"),
        "throughput.device_used_after",
        minimum=0,
    )
    _require(
        profile.get("device_total_memory_bytes") == device_total
        and free_before <= device_total
        and free_after <= device_total
        and used_after == device_total - free_after,
        "throughput profile device free-headroom telemetry differs",
    )

    utilization_mean = statistics.fmean(utilization)
    _require(
        profile.get("gpu_utilization_samples_percent") == utilization
        and math.isclose(
            _finite_number(
                profile.get("gpu_utilization_mean_percent"),
                "throughput.utilization_mean",
            ),
            utilization_mean,
            rel_tol=1e-12,
            abs_tol=1e-12,
        )
        and utilization_mean >= 50.0
        and profile.get("gpu_utilization_max_percent") == max(utilization),
        "throughput profile utilization gate failed",
    )
    return profile


def _score_for_a(record: Mapping[str, Any]) -> tuple[float | None, str]:
    if record.get("truncated") is True:
        return None, "TRUNCATED"
    winner = record.get("winner")
    if winner == "DRAW":
        return 0.5, "DRAW"
    _require(winner in {"BLACK", "WHITE"}, f"game has invalid winner: {winner!r}")
    a_color = "BLACK" if record.get("black_slot") == "A" else "WHITE"
    return ((1.0, "WIN") if winner == a_color else (0.0, "LOSS"))


def _audit_game(
    record: Mapping[str, Any],
    schedule: Mapping[str, Any],
    *,
    preparation_runner_sha: str,
    formal_runner_sha: str,
    execution_source_closure_sha: str | None = None,
) -> dict[str, Any]:
    game_id = str(schedule["game_id"])
    for field, expected in schedule.items():
        _require(record.get(field) == expected, f"{game_id}: persisted game differs from frozen schedule at {field}")
    _require(record.get("schema_name") == GAME_SCHEMA and record.get("schema_version") == SCHEMA_VERSION, f"{game_id}: formal game schema mismatch")
    _require(record.get("preparation_runner_sha256") == preparation_runner_sha, f"{game_id}: explicit preparation-runner binding missing/drifted")
    _require(record.get("formal_runner_sha256") == formal_runner_sha, f"{game_id}: formal-runner binding mismatch")
    if execution_source_closure_sha is not None:
        _require(
            record.get("execution_source_closure_sha256")
            == execution_source_closure_sha,
            f"{game_id}: execution-source closure binding mismatch",
        )
    _require(record.get("schedule_sha256") == canonical_sha256(schedule), f"{game_id}: bound schedule hash mismatch")
    actions = _sequence(record.get("actions"), f"{game_id}.actions")
    _require(len(actions) == record.get("plies") and len(actions) <= 256, f"{game_id}: ply count mismatch")
    prefix = [int(value) for value in schedule["opening_actions"]]
    _require(len(actions) >= len(prefix), f"{game_id}: action log shorter than opening")
    action_indices: list[int] = []
    for index, raw_entry in enumerate(actions):
        entry = _mapping(raw_entry, f"{game_id}.actions[{index}]")
        _require(entry.get("ply") == index, f"{game_id}: non-contiguous ply index")
        action = _integer(entry.get("action"), f"{game_id}.actions[{index}].action", minimum=0)
        action_indices.append(action)
    _require(action_indices[: len(prefix)] == prefix, f"{game_id}: opening prefix differs from schedule")
    continuation = action_indices[len(prefix) :]
    _require(record.get("continuation_plies") == len(continuation), f"{game_id}: continuation length mismatch")
    full_key = {
        "eval_size": int(schedule["eval_size"]),
        "opening_actions": prefix,
        "continuation_actions": continuation,
    }
    bound_key = {
        **full_key,
        "black_slot": schedule["black_slot"],
        "white_slot": schedule["white_slot"],
    }
    recomputed_full = canonical_sha256(full_key)
    recomputed_continuation = canonical_sha256(continuation)
    recomputed_bound = canonical_sha256(bound_key)
    _require(record.get("full_trajectory_hash") == recomputed_full, f"{game_id}: full trajectory hash mismatch")
    _require(record.get("continuation_trajectory_hash") == recomputed_continuation, f"{game_id}: continuation trajectory hash mismatch")
    _require(record.get("bound_trajectory_hash") == recomputed_bound, f"{game_id}: bound trajectory hash mismatch")
    try:
        replayed = replay_game_record(dict(record))
    except Exception as exc:
        raise VerificationError(f"{game_id}: independent replay failed: {exc}") from exc
    _require(replayed.state_fingerprint() == record.get("final_state_hash"), f"{game_id}: final state hash mismatch")
    score, outcome = _score_for_a(record)
    return {
        "game_id": game_id,
        "task_id": schedule["task_id"],
        "inference_group_id": None,
        "training_seed": schedule["training_seed"],
        "eval_size": schedule["eval_size"],
        "opening_stratum": schedule["opening_stratum"],
        "opening_variant": schedule["opening_variant"],
        "pair_id": schedule["pair_id"],
        "pair_member": schedule["pair_member"],
        "score_for_a": score,
        "outcome": outcome,
        "full_trajectory_hash": recomputed_full,
        "continuation_trajectory_hash": recomputed_continuation,
        "bound_trajectory_hash": recomputed_bound,
        "truncated": bool(record["truncated"]),
    }


def _task_counts(audited: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    outcomes = Counter(str(row["outcome"]) for row in audited)
    strata: dict[str, set[str]] = defaultdict(set)
    stratum_rows: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in audited:
        key = str(row["opening_stratum"])
        strata[key].add(str(row["continuation_trajectory_hash"]))
        stratum_rows[key].append(row)
    exact_four = 0
    exact_two_variants = 0
    exact_variant_color_pairs = 0
    for rows in stratum_rows.values():
        if len(rows) == 4:
            exact_four += 1
        variants: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
        for row in rows:
            variants[int(row["opening_variant"])].append(row)
        if set(variants) == {0, 1}:
            exact_two_variants += 1
        for variant_rows in variants.values():
            members = {int(row["pair_member"]) for row in variant_rows}
            # Audited rows do not retain slots, but the frozen schedule/game
            # equality already proved the member-0/member-1 A/B color swap.
            if len(variant_rows) == 2 and members == {0, 1}:
                exact_variant_color_pairs += 1
    return {
        "games_requested": len(audited),
        "games_completed": len(audited) - outcomes["TRUNCATED"],
        "truncated_games": outcomes["TRUNCATED"],
        "a_wins": outcomes["WIN"],
        "a_losses": outcomes["LOSS"],
        "draws": outcomes["DRAW"],
        "replay_verified_games": len(audited),
        "unique_full_trajectories": len({str(row["full_trajectory_hash"]) for row in audited}),
        "unique_prefix_stripped_continuations": len({str(row["continuation_trajectory_hash"]) for row in audited}),
        "unique_bound_trajectories_with_slots": len({str(row["bound_trajectory_hash"]) for row in audited}),
        "opening_strata": len(strata),
        "opening_strata_with_exact_four_games": exact_four,
        "opening_strata_with_exact_two_variants": exact_two_variants,
        "opening_variants_with_exact_color_pair": exact_variant_color_pairs,
        "strata_with_two_unique_continuations": sum(len(values) >= 2 for values in strata.values()),
    }


def _formal_gate(counts: Mapping[str, Any]) -> dict[str, Any]:
    checks = {
        "exact_game_count": counts["games_requested"] == GAMES_PER_TASK,
        "all_games_completed": counts["games_completed"] == GAMES_PER_TASK,
        "zero_truncations": counts["truncated_games"] == 0,
        "all_games_replay_verified": counts["replay_verified_games"] == GAMES_PER_TASK,
        "minimum_unique_full_trajectories": counts["unique_full_trajectories"] >= 64,
        "minimum_unique_prefix_stripped_continuations": counts["unique_prefix_stripped_continuations"] >= 32,
        "exact_opening_strata": counts["opening_strata"] == STRATA_PER_TASK,
        "exact_four_games_per_opening_stratum": counts["opening_strata_with_exact_four_games"] == STRATA_PER_TASK,
        "exact_two_variants_per_opening_stratum": counts["opening_strata_with_exact_two_variants"] == STRATA_PER_TASK,
        "exact_color_pair_per_opening_variant": counts["opening_variants_with_exact_color_pair"] == STRATA_PER_TASK * 2,
        "minimum_strata_with_two_continuations": counts["strata_with_two_unique_continuations"] >= 24,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": dict(FORMAL_GATES),
        "full_trajectory_key": "eval_size+opening_actions+continuation_actions; slot labels ignored",
        "continuation_key": "continuation_actions only",
        "stratum_key": "opening_stratum across both registered variants and both colors",
    }


def _validate_file_binding(path: Path, digest: Any, *, label: str) -> None:
    _require(path.is_file(), f"{label} artifact is missing: {path}")
    _require(_valid_sha256(digest), f"{label} artifact hash is invalid")
    _require(sha256_file(path) == digest, f"{label} artifact hash mismatch")


def _audit_receipt(
    task: Mapping[str, Any],
    schedules: Sequence[Mapping[str, Any]],
    receipt: Mapping[str, Any],
    *,
    run_root: Path,
    metadata: Mapping[str, Any],
    preparation_runner_sha: str,
    formal_runner_sha: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    task_id = str(task["task_id"])
    expected_base = {
        "schema_name": RECEIPT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "experiment_arm": EXPERIMENT_ARM,
        "task_id": task_id,
        "inference_group_id": task["inference_group_id"],
        "formal_manifest_sha256": task["formal_manifest_sha256"],
        "protocol_sha256": task["protocol_sha256"],
        "preparation_runner_sha256": preparation_runner_sha,
        "formal_runner_sha256": formal_runner_sha,
        "verifier_sha256": metadata["verifier_sha256"],
        "execution_freeze_sha256": metadata["execution_freeze_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "training_seed": task["training_seed"],
        "eval_size": task["eval_size"],
        "model_pair": task["model_pair"],
        "checkpoint_bindings": task["agent_bindings"],
        "max_plies": 256,
        "superko_mode": "enforce",
    }
    for field, expected in expected_base.items():
        _require(receipt.get(field) == expected, f"{task_id}: receipt binding mismatch for {field}")
    _require(receipt.get("status") == "complete" and receipt.get("execution_status") == "complete", f"{task_id}: receipt execution status is not complete")
    execution_identity = _mapping(receipt.get("execution_identity"), f"{task_id}.execution_identity")
    for field in (
        "formal_manifest_sha256",
        "protocol_sha256",
        "preparation_runner_sha256",
        "formal_runner_sha256",
        "verifier_sha256",
        "execution_freeze_sha256",
        "execution_source_hashes",
        "python_version",
        "torch_version",
        "cuda_runtime_version",
        "cudnn_version",
        "device",
        "device_name",
        "formal_source_hash",
        *THROUGHPUT_PROFILE_IDENTITY_FIELDS,
    ):
        _require(execution_identity.get(field) == metadata.get(field), f"{task_id}: execution identity mismatch for {field}")
    source_hashes = _mapping(
        metadata.get("execution_source_hashes"), "execution_metadata.source_hashes"
    )
    execution_source_closure_sha = canonical_sha256(dict(source_hashes))

    task_directory = _task_directory(run_root, task_id)
    receipt_path = task_directory / "receipt.json"
    _require(receipt_path.is_file() and not receipt_path.is_symlink(), f"{task_id}: task receipt artifact is missing/unsafe")
    _require(load_json(receipt_path) == dict(receipt), f"{task_id}: task receipt differs from canonical ledger row")
    games_path = _resolve_artifact(task_directory, receipt.get("games_path"), label=f"{task_id}.games_path")
    summary_path = _resolve_artifact(task_directory, receipt.get("summary_path"), label=f"{task_id}.summary_path")
    _require(receipt.get("games_path") == "games.jsonl", f"{task_id}: games path is not canonical")
    _require(receipt.get("summary_path") == "summary.json", f"{task_id}: summary path is not canonical")
    _require(isinstance(receipt.get("completed_at_utc"), str) and bool(receipt.get("completed_at_utc")), f"{task_id}: completion timestamp is missing")
    _validate_file_binding(games_path, receipt.get("games_sha256"), label=f"{task_id}.games")
    _validate_file_binding(summary_path, receipt.get("summary_sha256"), label=f"{task_id}.summary")
    records = load_jsonl(games_path)
    _require(len(records) == GAMES_PER_TASK, f"{task_id}: games artifact count is not 128")
    ordered_schedules = sorted(schedules, key=lambda row: int(row["game_index"]))
    audited = [
        _audit_game(
            record,
            schedule,
            preparation_runner_sha=preparation_runner_sha,
            formal_runner_sha=formal_runner_sha,
            execution_source_closure_sha=execution_source_closure_sha,
        )
        for record, schedule in zip(records, ordered_schedules)
    ]
    for row in audited:
        row["inference_group_id"] = task["inference_group_id"]
        row["model_pair"] = list(task["model_pair"])
    counts = _task_counts(audited)
    gate = _formal_gate(counts)
    for field, expected in counts.items():
        _require(receipt.get(field) == expected, f"{task_id}: receipt count mismatch for {field}")
    _require(receipt.get("formal_gate") == gate, f"{task_id}: receipt formal gate mismatch")
    expected_gate_status = "passed" if gate["passed"] else "failed"
    _require(receipt.get("gate_status") == expected_gate_status, f"{task_id}: receipt gate status mismatch")
    _require(receipt.get("failure_reason") == (None if gate["passed"] else "formal_task_gate_failed"), f"{task_id}: receipt failure reason mismatch")

    summary = load_json(summary_path)
    for field, expected in {**expected_base, **counts, "formal_gate": gate, "status": "complete", "execution_status": "complete", "gate_status": expected_gate_status, "failure_reason": None if gate["passed"] else "formal_task_gate_failed"}.items():
        _require(summary.get(field) == expected, f"{task_id}: summary mismatch for {field}")

    pair_bindings = _sequence(receipt.get("pair_artifacts"), f"{task_id}.pair_artifacts")
    _require(len(pair_bindings) == PAIRS_PER_TASK, f"{task_id}: receipt does not bind 64 pair artifacts")
    expected_pairs: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        expected_pairs[int(record["pair_index"])].append(record)
    seen_pair_indices: set[int] = set()
    for index, raw_binding in enumerate(pair_bindings):
        binding = _mapping(raw_binding, f"{task_id}.pair_artifacts[{index}]")
        pair_index = index
        _require(pair_index not in seen_pair_indices, f"{task_id}: duplicate pair artifact index")
        seen_pair_indices.add(pair_index)
        pair_path = _resolve_artifact(task_directory, binding.get("path"), label=f"{task_id}.pair_artifacts[{index}].path")
        _require(binding.get("path") == f"pairs/pair_{pair_index:04d}.json", f"{task_id}: non-canonical pair artifact path")
        _validate_file_binding(pair_path, binding.get("sha256"), label=f"{task_id}.pair[{pair_index}]")
        _require(binding.get("bytes") == pair_path.stat().st_size, f"{task_id}: pair artifact byte count mismatch")
        payload = load_json(pair_path)
        _require(payload.get("schema_name") == PAIR_SCHEMA and payload.get("schema_version") == SCHEMA_VERSION, f"{task_id}: pair artifact schema mismatch")
        _require(payload.get("task_id") == task_id and payload.get("pair_index") == pair_index, f"{task_id}: pair artifact identity mismatch")
        _require(payload.get("preparation_runner_sha256") == preparation_runner_sha and payload.get("formal_runner_sha256") == formal_runner_sha, f"{task_id}: pair artifact dual-runner binding mismatch")
        _require(
            payload.get("execution_source_closure_sha256")
            == execution_source_closure_sha,
            f"{task_id}: pair artifact source-closure binding mismatch",
        )
        pair_games = _sequence(payload.get("games"), f"{task_id}.pair[{pair_index}].games")
        expected = sorted(expected_pairs[pair_index], key=lambda row: int(row["pair_member"]))
        _require(payload.get("pair_id") == expected[0]["pair_id"], f"{task_id}: pair artifact pair ID mismatch")
        observed = sorted((dict(_mapping(row, "pair game")) for row in pair_games), key=lambda row: int(row["pair_member"]))
        _require(observed == expected, f"{task_id}: pair artifact games differ from canonical task games")
    _require(seen_pair_indices == set(range(PAIRS_PER_TASK)), f"{task_id}: pair artifact coverage incomplete")
    pair_directory = task_directory / "pairs"
    _validate_pair_directory_entries(pair_directory)
    expected_summary = {
        key: copy_value
        for key, copy_value in receipt.items()
        if key not in {"summary_path", "summary_sha256", "completed_at_utc"}
    }
    _require(summary == expected_summary, f"{task_id}: summary differs from exact receipt body")
    return {"task_id": task_id, **counts, "formal_gate": gate}, audited


def _percentile(values: Sequence[float], probability: float) -> float:
    _require(bool(values), "cannot take percentile of empty values")
    ordered = sorted(values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _crossed_bootstrap(
    matrix: Mapping[int, Mapping[str, float]],
    *,
    replicates: int = BOOTSTRAP_REPLICATES,
    seed: int = BOOTSTRAP_SEED,
) -> list[float]:
    seeds = sorted(matrix)
    _require(len(seeds) == 5, "crossed bootstrap requires exactly five training seeds")
    strata_sets = [set(matrix[item]) for item in seeds]
    _require(all(values == strata_sets[0] for values in strata_sets), "crossed bootstrap seed rows use different strata")
    strata = sorted(strata_sets[0])
    _require(len(strata) == STRATA_PER_TASK, "crossed bootstrap requires exactly 32 strata")
    rng = random.Random(seed)
    estimates: list[float] = []
    denominator = len(seeds) * len(strata)
    for _ in range(replicates):
        sampled_seeds = [rng.choice(seeds) for _ in seeds]
        sampled_strata = [rng.choice(strata) for _ in strata]
        total = sum(matrix[training_seed][stratum] for training_seed in sampled_seeds for stratum in sampled_strata)
        estimates.append(total / denominator)
    return [_percentile(estimates, 0.025), _percentile(estimates, 0.975)]


def _seed_t_interval(values: Sequence[float]) -> list[float]:
    _require(len(values) == 5, "seed-t interval requires exactly five seed means")
    mean = statistics.fmean(values)
    standard_error = statistics.stdev(values) / math.sqrt(5)
    margin = 2.776 * standard_error
    return [max(0.0, mean - margin), min(1.0, mean + margin)]


def _aggregate(audited_games: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for game in audited_games:
        by_group[str(game["inference_group_id"])].append(game)
    _require(len(by_group) == len(MODEL_PAIRS) * len(SIZES), "numeric aggregation requires exactly nine inference groups")
    rows: list[dict[str, Any]] = []
    for pair in MODEL_PAIRS:
        for size in SIZES:
            group_id = f"d16-v3.{pair[0]}_vs_{pair[1]}.n{size}"
            games = by_group.get(group_id, [])
            _require(len(games) == 5 * GAMES_PER_TASK, f"{group_id}: expected 640 games")
            cells: dict[int, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
            outcomes = Counter(str(game["outcome"]) for game in games)
            for game in games:
                score = game["score_for_a"]
                _require(score is not None, f"{group_id}: truncated game reached aggregation")
                cells[int(game["training_seed"])][str(game["opening_stratum"])].append(float(score))
            matrix: dict[int, dict[str, float]] = {}
            seed_rows: list[dict[str, Any]] = []
            seed_means: list[float] = []
            for training_seed in TRAINING_SEEDS:
                strata = cells.get(training_seed, {})
                _require(len(strata) == STRATA_PER_TASK, f"{group_id}: seed {training_seed} lacks 32 strata")
                matrix[training_seed] = {}
                for stratum, values in strata.items():
                    _require(len(values) == 4, f"{group_id}: seed/stratum cell does not contain four games")
                    matrix[training_seed][stratum] = statistics.fmean(values)
                seed_mean = statistics.fmean(matrix[training_seed].values())
                seed_means.append(seed_mean)
                seed_rows.append(
                    {
                        "training_seed": training_seed,
                        "opening_strata": STRATA_PER_TASK,
                        "seed_score_equal_weighted_over_strata": seed_mean,
                    }
                )
            point = statistics.fmean(seed_means)
            rows.append(
                {
                    "inference_group_id": group_id,
                    "model_pair": list(pair),
                    "eval_size": size,
                    "training_seed_units": 5,
                    "seed_by_opening_stratum_units": 5 * STRATA_PER_TASK,
                    "games_completed": len(games),
                    "a_wins": outcomes["WIN"],
                    "a_losses": outcomes["LOSS"],
                    "draws": outcomes["DRAW"],
                    "paired_a_score_equal_weighted_over_seed_and_stratum": point,
                    "primary_interval_method": "two-way crossed training-seed x opening-stratum percentile bootstrap",
                    "primary_ci95": _crossed_bootstrap(matrix),
                    "crossed_bootstrap_replicates": BOOTSTRAP_REPLICATES,
                    "crossed_bootstrap_seed": BOOTSTRAP_SEED,
                    "secondary_interval_method": "Student t interval across five training-seed means",
                    "secondary_ci95": _seed_t_interval(seed_means),
                    "secondary_degrees_of_freedom": 4,
                    "pooled_game_score_descriptive_only": (outcomes["WIN"] + 0.5 * outcomes["DRAW"]) / len(games),
                    "seed_units": seed_rows,
                }
            )
    return rows


def _numeric_core(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "experiment_id": value.get("experiment_id"),
        "formal_manifest_sha256": value.get("formal_manifest_sha256"),
        "task_manifest_sha256": value.get("task_manifest_sha256"),
        "game_manifest_sha256": value.get("game_manifest_sha256"),
        "comparison_rows": value.get("comparison_rows"),
    }


def _numeric_equal(left: Any, right: Any, *, path: str = "$") -> None:
    if isinstance(left, Mapping):
        if not isinstance(right, Mapping) or set(left) != set(right):
            raise VerificationError(f"canonical numeric mismatch at {path}: object keys differ")
        for key in left:
            _numeric_equal(left[key], right[key], path=f"{path}.{key}")
        return
    if isinstance(left, list):
        if not isinstance(right, list) or len(left) != len(right):
            raise VerificationError(f"canonical numeric mismatch at {path}: list shape differs")
        for index, (left_item, right_item) in enumerate(zip(left, right)):
            _numeric_equal(left_item, right_item, path=f"{path}[{index}]")
        return
    if isinstance(left, (int, float)) and not isinstance(left, bool):
        if isinstance(right, bool) or not isinstance(right, (int, float)) or not math.isclose(float(left), float(right), rel_tol=1e-12, abs_tol=1e-12):
            raise VerificationError(f"canonical numeric mismatch at {path}: {left!r} != {right!r}")
        return
    if left != right:
        raise VerificationError(f"canonical numeric mismatch at {path}: {left!r} != {right!r}")


def verify_evidence(
    *,
    manifest_path: Path,
    task_manifest_path: Path,
    game_manifest_path: Path,
    execution_metadata_path: Path,
    receipts_path: Path,
    execution_summary_path: Path,
    formal_runner_path: Path = DEFAULT_FORMAL_RUNNER,
    preparation_runner_path: Path = DEFAULT_PREPARATION_RUNNER,
    canonical_numeric_path: Path | None = None,
    canonical_numeric_sha256: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    gates = {name: False for name in GATE_NAMES}
    issues: list[str] = []
    manifest_path = manifest_path.resolve()
    task_manifest_path = task_manifest_path.resolve()
    game_manifest_path = game_manifest_path.resolve()
    execution_metadata_path = execution_metadata_path.resolve()
    receipts_path = receipts_path.resolve()
    execution_summary_path = execution_summary_path.resolve()
    formal_runner_path = formal_runner_path.resolve()
    preparation_runner_path = preparation_runner_path.resolve()

    manifest = load_json(manifest_path)
    openings_by_id, protocol_sha, opening_sha = _validate_manifest(manifest, manifest_path)
    checkpoint_registry = _manifest_checkpoint_map(manifest)
    formal_manifest_sha = sha256_file(manifest_path)
    gates["manifest_identity"] = True
    gates["manifest_source_hashes"] = True
    gates["opening_registry_bound"] = True

    task_manifest_sha = sha256_file(task_manifest_path)
    game_manifest_sha = sha256_file(game_manifest_path)
    tasks = load_jsonl(task_manifest_path)
    raw_games = load_jsonl(game_manifest_path)
    preparation_runner_sha = sha256_file(preparation_runner_path)
    tasks_by_id = _validate_tasks(
        tasks,
        formal_manifest_sha=formal_manifest_sha,
        game_manifest_sha=game_manifest_sha,
        protocol_sha=protocol_sha,
        opening_manifest_sha=opening_sha,
        preparation_runner_sha=preparation_runner_sha,
        checkpoint_registry=checkpoint_registry,
    )
    gates["task_manifest_complete"] = True
    grouped_schedules, _ = _validate_games(
        raw_games,
        tasks_by_id,
        openings_by_id,
        formal_manifest_sha=formal_manifest_sha,
        opening_manifest_sha=opening_sha,
        preparation_runner_sha=preparation_runner_sha,
    )
    gates["game_manifest_complete"] = True

    metadata = load_json(execution_metadata_path)
    preparation_runner_sha, formal_runner_sha, verifier_bound = _validate_execution_metadata(
        metadata,
        formal_manifest_sha=formal_manifest_sha,
        task_manifest_sha=task_manifest_sha,
        game_manifest_sha=game_manifest_sha,
        protocol_sha=protocol_sha,
        preparation_runner_path=preparation_runner_path,
        formal_runner_path=formal_runner_path,
    )
    gates["dual_runner_hashes_bound"] = True
    gates["execution_metadata_bound"] = True
    gates["verifier_source_bound"] = verifier_bound
    if not verifier_bound:
        issues.append("independent verifier is absent from the frozen execution source closure")
    run_root = receipts_path.parent
    _validate_evidence_root_entries(run_root, tasks)
    throughput_profile_path = (
        run_root / str(metadata["throughput_profile_artifact_path"])
    ).resolve()
    _require(
        throughput_profile_path.parent == run_root.resolve(),
        "throughput profile evidence path escapes the run root",
    )
    _validate_throughput_profile_evidence(
        throughput_profile_path,
        metadata=metadata,
        tasks=tasks,
        grouped_schedules=grouped_schedules,
        checkpoint_registry=checkpoint_registry,
        formal_manifest_sha=formal_manifest_sha,
        formal_runner_sha=formal_runner_sha,
    )
    gates["throughput_profile_verified"] = True

    receipts = load_jsonl(receipts_path)
    _require(len(receipts) == EXPECTED_TASKS, "receipt ledger does not contain exactly 45 receipts")
    receipt_ids = [str(receipt.get("task_id", "")) for receipt in receipts]
    _require(len(set(receipt_ids)) == EXPECTED_TASKS and set(receipt_ids) == set(tasks_by_id), "receipt ledger task coverage is missing/duplicate/extra")
    _require(receipt_ids == [str(task["task_id"]) for task in tasks], "receipt ledger order differs from frozen task order")
    gates["receipt_ledger_complete"] = True

    task_rows: list[dict[str, Any]] = []
    audited_games: list[dict[str, Any]] = []
    for receipt in receipts:
        task_id = str(receipt["task_id"])
        task_row, games = _audit_receipt(
            tasks_by_id[task_id],
            grouped_schedules[task_id],
            receipt,
            run_root=run_root,
            metadata=metadata,
            preparation_runner_sha=preparation_runner_sha,
            formal_runner_sha=formal_runner_sha,
        )
        task_rows.append(task_row)
        audited_games.extend(games)
    gates["artifact_paths_confined"] = True
    gates["artifact_hashes_verified"] = True
    gates["pair_artifacts_complete"] = True
    _require(len(audited_games) == EXPECTED_GAMES, "independent audit did not replay 5,760 games")
    gates["all_games_replayed"] = True
    gates["zero_truncations"] = all(row["truncated"] is False for row in audited_games)
    gates["receipt_counts_recomputed"] = True
    gates["stratum_balance"] = all(row["opening_strata"] == STRATA_PER_TASK for row in task_rows)
    gates["all_task_diversity_gates"] = all(row["formal_gate"]["passed"] is True for row in task_rows)
    if not gates["zero_truncations"]:
        issues.append("one or more independently replayed games are truncated")
    if not gates["all_task_diversity_gates"]:
        issues.append("one or more task diversity gates fail")

    comparison_rows = _aggregate(audited_games)
    gates["statistics_contract"] = True
    numeric = {
        "schema_name": NUMERIC_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": formal_manifest_sha,
        "task_manifest_sha256": task_manifest_sha,
        "game_manifest_sha256": game_manifest_sha,
        "receipt_ledger_sha256": sha256_file(receipts_path),
        "comparison_rows": comparison_rows,
    }

    summary = load_json(execution_summary_path)
    summary_checks = {
        "schema": summary.get("schema_name") == RUN_SCHEMA,
        "experiment": summary.get("experiment_id") == EXPERIMENT_ID,
        "manifest": summary.get("formal_manifest_sha256") == formal_manifest_sha,
        "runner": summary.get("formal_runner_sha256") == formal_runner_sha,
        "verifier": summary.get("verifier_sha256") == metadata.get("verifier_sha256"),
        "execution_freeze": summary.get("execution_freeze_sha256")
        == metadata.get("execution_freeze_sha256"),
        "tasks": summary.get("task_manifest_sha256") == task_manifest_sha,
        "games": summary.get("game_manifest_sha256") == game_manifest_sha,
        "throughput_profile_identity": all(
            summary.get(field) == metadata.get(field)
            for field in THROUGHPUT_PROFILE_IDENTITY_FIELDS
        ),
        "receipts": summary.get("receipts_present") == EXPECTED_TASKS and summary.get("complete_tasks") == EXPECTED_TASKS,
        "complete": summary.get("execution_complete") is True,
        "runner_gate": summary.get("runner_gate_passed") is True,
        "missing": summary.get("missing_tasks") == 0,
        "execution_failed": summary.get("execution_failed_tasks") == 0,
        "gate_failed": summary.get("gate_failed_tasks") == 0,
        "formal_ready_false": summary.get("formal_ready") is False,
        "independent_required": summary.get("independent_verification_required") is True,
        "ledger_hash": summary.get("result_receipts_sha256") == sha256_file(receipts_path),
    }
    gates["execution_summary_consistent"] = all(summary_checks.values())
    if not gates["execution_summary_consistent"]:
        issues.append(
            "execution summary mismatch: "
            + ", ".join(name for name, passed in summary_checks.items() if not passed)
        )

    if canonical_numeric_path is None and canonical_numeric_sha256 is None:
        issues.append("runner-produced canonical numeric artifact/hash was not supplied")
    elif canonical_numeric_path is None or canonical_numeric_sha256 is None:
        raise VerificationError("canonical numeric path and SHA-256 must be supplied together")
    else:
        canonical_numeric_path = canonical_numeric_path.resolve()
        _require(_valid_sha256(canonical_numeric_sha256), "declared canonical numeric SHA-256 is invalid")
        _require(canonical_numeric_path.is_file(), "canonical numeric artifact is missing")
        _require(sha256_file(canonical_numeric_path) == canonical_numeric_sha256, "canonical numeric artifact hash mismatch")
        if summary.get("canonical_numeric_sha256") == canonical_numeric_sha256:
            gates["canonical_numeric_hash_verified"] = True
        else:
            issues.append(
                "canonical numeric artifact is not hash-bound by the immutable execution summary"
            )
        canonical = load_json(canonical_numeric_path)
        _numeric_equal(_numeric_core(numeric), _numeric_core(canonical))
        gates["canonical_numeric_match"] = True

    formal_ready = all(gates.values())
    report = {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS" if formal_ready else "FAIL_CLOSED",
        "formal_ready": formal_ready,
        "experiment_id": EXPERIMENT_ID,
        "verifier_sha256": sha256_file(SCRIPT_PATH),
        "inputs": {
            "manifest": {"path": str(manifest_path), "sha256": formal_manifest_sha},
            "task_manifest": {"path": str(task_manifest_path), "sha256": task_manifest_sha},
            "game_manifest": {"path": str(game_manifest_path), "sha256": game_manifest_sha},
            "execution_metadata": {"path": str(execution_metadata_path), "sha256": sha256_file(execution_metadata_path)},
            "receipts": {"path": str(receipts_path), "sha256": sha256_file(receipts_path)},
            "execution_summary": {"path": str(execution_summary_path), "sha256": sha256_file(execution_summary_path)},
            "throughput_profile": {"path": str(throughput_profile_path), "sha256": sha256_file(throughput_profile_path)},
        },
        "gates": gates,
        "issues": issues,
        "task_count": len(task_rows),
        "game_count": len(audited_games),
        "gate_failed_tasks": [row["task_id"] for row in task_rows if not row["formal_gate"]["passed"]],
        "task_rows": task_rows,
        "numeric_sha256": canonical_sha256(numeric),
    }
    return report, numeric


def failure_report(exc: BaseException, *, manifest_path: Path | None = None) -> dict[str, Any]:
    return {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "FAIL_CLOSED",
        "formal_ready": False,
        "experiment_id": EXPERIMENT_ID,
        "verifier_sha256": sha256_file(SCRIPT_PATH),
        "manifest_path": None if manifest_path is None else str(manifest_path.resolve()),
        "gates": {name: False for name in GATE_NAMES},
        "issues": [f"{type(exc).__name__}: {exc}"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--task-manifest", type=Path, required=True)
    parser.add_argument("--game-manifest", type=Path, required=True)
    parser.add_argument("--execution-metadata", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--execution-summary", type=Path, required=True)
    parser.add_argument("--formal-runner", type=Path, default=DEFAULT_FORMAL_RUNNER)
    parser.add_argument("--preparation-runner", type=Path, default=DEFAULT_PREPARATION_RUNNER)
    parser.add_argument("--canonical-numeric", type=Path)
    parser.add_argument("--canonical-sha256")
    parser.add_argument("--report-output", type=Path, required=True)
    parser.add_argument("--numeric-output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report, numeric = verify_evidence(
            manifest_path=args.manifest,
            task_manifest_path=args.task_manifest,
            game_manifest_path=args.game_manifest,
            execution_metadata_path=args.execution_metadata,
            receipts_path=args.receipts,
            execution_summary_path=args.execution_summary,
            formal_runner_path=args.formal_runner,
            preparation_runner_path=args.preparation_runner,
            canonical_numeric_path=args.canonical_numeric,
            canonical_numeric_sha256=args.canonical_sha256,
        )
        _atomic_write_new(args.numeric_output, pretty_json(numeric))
    except Exception as exc:
        report = failure_report(exc, manifest_path=args.manifest)
    try:
        _atomic_write_new(args.report_output, pretty_json(report))
    except VerificationError as exc:
        print(canonical_json(failure_report(exc, manifest_path=args.manifest)))
        return 2
    print(pretty_json(report), end="")
    return 0 if report["formal_ready"] is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
