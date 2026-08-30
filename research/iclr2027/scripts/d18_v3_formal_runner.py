#!/usr/bin/env python3
"""Execute the separately authorized D18-v3 formal bundle fail-closed.

This file is intentionally separate from ``d18_v3_runner.py``.  The latter is
the frozen zero-execution preparation tool and remains unable to play a game.
No command here contacts AutoDL; ``generate-job`` only writes a reviewable job
TOML.  The paid product command must still be invoked separately by the owner.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import hashlib
import json
import math
import multiprocessing
import os
import platform
import random
import shutil
import statistics
import sys
import tempfile
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_PATH.parent
REPO_ROOT = SCRIPT_PATH.parents[3]
RESEARCH_ROOT = REPO_ROOT / "research" / "iclr2027"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import d17_d19_runner as legacy  # noqa: E402
import d18_v3_runner as prep  # noqa: E402


SCHEMA_VERSION = 1
RUN_SCHEMA = "lifeline-d18-v3-formal-run"
GAME_SCHEMA = "lifeline-d18-v3-formal-game"
PAIR_SCHEMA = "lifeline-d18-v3-formal-pair"
RECEIPT_SCHEMA = "lifeline-d18-v3-formal-task-receipt"
STAGE_SCHEMA = "lifeline-d18-v3-autodl-stage"
EXPERIMENT_ID = prep.EXPERIMENT_ID
DEFAULT_MANIFEST = prep.DEFAULT_MANIFEST
DEFAULT_POLICY = RESEARCH_ROOT / "autodl" / "d18_v3_12yuan.policy.toml"
EXPECTED_TASKS = prep.EXPECTED_TASKS
EXPECTED_GAMES = prep.EXPECTED_GAMES
EXPECTED_GAMES_PER_TASK = prep.EXPECTED_GAMES_PER_TASK
EXPECTED_PAIRS_PER_TASK = prep.EXPECTED_PAIRS_PER_TASK
MAX_RUNTIME_SECONDS = 11_520
POLICY_MAX_DELIVERY_BYTES = 512 * 1024 * 1024
WORKER_RUN_METADATA_RESERVE_BYTES = 64 * 1024 * 1024
MAX_EXPORT_BYTES = POLICY_MAX_DELIVERY_BYTES - WORKER_RUN_METADATA_RESERVE_BYTES
EXPORT_MANIFEST_RESERVE_BYTES = 4 * 1024 * 1024
INSTANCE_UUID = "pro-788096a9e3b2"
GPU_SPEC = "5090-p"
IMAGE_UUID = "base-image-ec1e9vdbd3"
VERIFIER_PATH = SCRIPT_DIR / "d18_v3_verify_evidence.py"
DEPENDENCY_LOCK_PATH = (
    RESEARCH_ROOT / "autodl" / "d18_v3_runtime_requirements.lock.txt"
)
BUNDLE_HASH_FILES = {
    "bundle_summary_sha256": "bundle_summary.json",
    "task_manifest_sha256": "tasks.jsonl",
    "game_manifest_sha256": "game_manifest.jsonl",
    "manifest_snapshot_sha256": "manifest_snapshot.json",
}
STAGE_SEMANTIC_HASH_FIELDS = (
    "formal_manifest_sha256",
    "formal_runner_sha256",
    "preparation_runner_sha256",
    "verifier_sha256",
    "dependency_lock_sha256",
    *BUNDLE_HASH_FILES,
)
WRITER_LOCK_NAME = ".d18_v3_formal_writer.lock"
BOOTSTRAP_REPLICATES = 20_000
BOOTSTRAP_SEED = prep.BOOTSTRAP_SEED
SEED_T_CRITICAL_DF4 = 2.776
SCALAR_LANE_COUNT = 12
SCALAR_LANE_EXECUTION_MODE = "production_equivalent_scalar_puct_lanes"
INFERENCE_BATCH_SIZE = 1
INFERENCE_DTYPE = "float32"
AMP_ENABLED = False
THROUGHPUT_PROFILE_SCHEMA = "lifeline-d18-v3-gpu-smoke"
THROUGHPUT_PROFILE_ARTIFACT_NAME = "throughput_profile.json"
GPU_SMOKE_MIN_TOTAL_SECONDS = 15.0
GPU_SMOKE_MAX_TOTAL_SECONDS = 30.0
FORMAL_NON_GAMEPLAY_RESERVE_FRACTION = 0.25
FORMAL_GAMEPLAY_BUDGET_SECONDS = int(
    MAX_RUNTIME_SECONDS * (1.0 - FORMAL_NON_GAMEPLAY_RESERVE_FRACTION)
)
EXPECTED_TORCH_VERSION = "2.8.0"
EXPECTED_CUDA_RUNTIME_VERSION = "12.8"
EXPECTED_DEVICE_NAME_FRAGMENT = "RTX 5090"
MIN_DEVICE_MEMORY_BYTES = 31 * 1024**3
MAX_AGGREGATE_LANE_MEMORY_BYTES = 30 * 1024**3
PROFILE_MODEL_KINDS = ("padded_cnn", "grid_gnn", "topology_gnn")
PROFILE_MODEL_PAIRS = tuple(tuple(pair) for pair in prep.MODEL_PAIRS)
PROFILE_EVAL_SIZES = (5, 7, 9)
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


class FormalExecutionError(RuntimeError):
    """A formal execution or evidence invariant failed."""


class _ScalarLaneExecutor:
    """Run independent scalar PUCT lanes with deterministic result ordering.

    The production backend always uses spawned processes.  Tests may inject a
    compatible executor factory (normally ``ThreadPoolExecutor``) so the
    orchestration and fail-closed behavior can be checked without CUDA.
    """

    def __init__(
        self,
        lane_count: int = SCALAR_LANE_COUNT,
        *,
        executor_factory: Callable[..., Any] | None = None,
        initializer: Callable[..., Any] | None = None,
        initargs: tuple[Any, ...] = (),
    ) -> None:
        _require(lane_count > 0, "scalar lane count must be positive")
        self.lane_count = int(lane_count)
        self._executor_factory = executor_factory
        self._initializer = initializer
        self._initargs = initargs
        self._executor: Any | None = None

    def __enter__(self) -> "_ScalarLaneExecutor":
        _require(self._executor is None, "scalar lane executor is already open")
        kwargs: dict[str, Any] = {"max_workers": self.lane_count}
        if self._initializer is not None:
            kwargs.update(initializer=self._initializer, initargs=self._initargs)
        if self._executor_factory is None:
            kwargs["mp_context"] = multiprocessing.get_context("spawn")
            self._executor = concurrent.futures.ProcessPoolExecutor(**kwargs)
        else:
            self._executor = self._executor_factory(**kwargs)
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        executor = self._executor
        self._executor = None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)

    def map_ordered(
        self,
        worker: Callable[[Any], Any],
        payloads: Sequence[Any],
    ) -> list[Any]:
        executor = self._executor
        _require(executor is not None, "scalar lane executor is not open")
        futures = [executor.submit(worker, payload) for payload in payloads]
        try:
            return [future.result() for future in futures]
        except Exception as exc:
            for future in futures:
                future.cancel()
            raise FormalExecutionError(
                f"scalar lane worker failed: {type(exc).__name__}: {exc}"
            ) from exc


class _AdvisoryWriterLock:
    """Cross-platform non-blocking advisory lock for one formal writer."""

    def __init__(self, path: Path):
        self.path = path
        self._handle: Any | None = None

    def __enter__(self) -> "_AdvisoryWriterLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError) as exc:
            handle.close()
            raise FormalExecutionError(
                f"another D18-v3 formal writer holds the advisory lock: {self.path}"
            ) from exc
        self._handle = handle
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        handle = self._handle
        self._handle = None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        raise FormalExecutionError(f"value is not canonical finite JSON: {exc}") from exc


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
        raise FormalExecutionError(f"value is not finite JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise FormalExecutionError(f"cannot hash {path}: {exc}") from exc
    return digest.hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise FormalExecutionError(message)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        _require(key not in value, f"duplicate JSON key: {key!r}")
        value[key] = item
    return value


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FormalExecutionError(f"cannot read JSON {path}: {exc}") from exc
    _require(isinstance(value, dict), f"JSON root must be an object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            _require(bool(line.strip()), f"blank JSONL row at {path}:{number}")
            value = json.loads(line, object_pairs_hook=_unique_object)
            _require(isinstance(value, dict), f"JSONL row is not an object at {path}:{number}")
            rows.append(value)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FormalExecutionError(f"cannot read JSONL {path}: {exc}") from exc
    return rows


def _jsonl_text(rows: Iterable[Mapping[str, Any]]) -> str:
    return "".join(canonical_json(dict(row)) + "\n" for row in rows)


def _atomic_text(path: Path, text: str, *, overwrite: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise FormalExecutionError(f"refusing to overwrite immutable file: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _atomic_json(path: Path, value: Mapping[str, Any], *, overwrite: bool = False) -> None:
    _atomic_text(path, pretty_json(dict(value)), overwrite=overwrite)


def _repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise FormalExecutionError(f"path escapes repository: {path}") from exc


def _resolve_repo_path(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    _repo_relative(resolved)
    return resolved


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _validate_write_target(
    manifest: Mapping[str, Any],
    path: Path,
    *,
    environment_root: str,
    label: str,
) -> Path:
    resolved = path.resolve()
    local_root = _resolve_repo_path(str(manifest["output_root"]))
    allowed_roots = [local_root]
    raw_environment_root = os.environ.get(environment_root)
    if raw_environment_root:
        allowed_roots.append(Path(raw_environment_root).resolve())
    _require(
        any(_is_relative_to(resolved, root) and resolved != root for root in allowed_roots),
        f"{label} must be a named child of the D18-v3 output root or {environment_root}",
    )
    return resolved


def _bound_task_schedules(
    task: Mapping[str, Any], schedules: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Join task-only fields to the frozen game rows without changing either file.

    The preparation bundle deliberately stores ``eval_size`` and ``pair_index``
    once in the task/pair plan rather than duplicating them in every game row.
    Formal execution needs both values, so this adapter proves the join and
    binds the original row hash before adding the two derived fields.
    """

    _require(len(schedules) == EXPECTED_GAMES_PER_TASK, "task schedule count is not 128")
    pair_plans = task.get("pair_plan")
    _require(
        isinstance(pair_plans, list) and len(pair_plans) == EXPECTED_PAIRS_PER_TASK,
        "task pair plan count is not 64",
    )
    by_pair: dict[str, Mapping[str, Any]] = {}
    for plan in pair_plans:
        pair_id = str(plan["pair_id"])
        _require(pair_id not in by_pair, f"duplicate task pair plan: {pair_id}")
        by_pair[pair_id] = plan

    bound: list[dict[str, Any]] = []
    for raw in schedules:
        _require(raw.get("task_id") == task.get("task_id"), "game row belongs to another task")
        pair_id = str(raw.get("pair_id", ""))
        _require(pair_id in by_pair, f"game row has no matching task pair plan: {pair_id}")
        plan = by_pair[pair_id]
        member = int(raw["pair_member"])
        _require(member in (0, 1), f"invalid pair member for {pair_id}")
        _require(
            str(raw["game_id"]) == str(plan["game_ids"][member]),
            f"game row differs from pair plan for {pair_id}",
        )
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
            _require(raw.get(field) == expected, f"{pair_id}: task/game join changed {field}")
        _require(
            raw.get("runner_sha256") == sha256_file(prep.SCRIPT_PATH),
            f"{pair_id}: game row preparation-runner binding is stale",
        )
        row = copy.deepcopy(dict(raw))
        row["eval_size"] = int(task["eval_size"])
        row["pair_index"] = int(plan["pair_index"])
        row["frozen_game_schedule_sha256"] = canonical_sha256(dict(raw))
        bound.append(row)

    bound.sort(key=lambda row: int(row["game_index"]))
    _require(
        [int(row["game_index"]) for row in bound]
        == list(range(EXPECTED_GAMES_PER_TASK)),
        "task game indices are not exact and contiguous",
    )
    return bound


def load_frozen_bundle(
    manifest_path: Path, bundle_directory: Path
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Load and exactly regenerate the frozen 45-task/5,760-game bundle."""

    manifest_path = manifest_path.resolve()
    bundle_directory = bundle_directory.resolve()
    manifest = prep.load_json(manifest_path)
    prep.validate_formal_manifest(manifest, manifest_path=manifest_path)
    prep.validate_bundle_directory(bundle_directory)
    tasks = _read_jsonl(bundle_directory / "tasks.jsonl")
    raw_games = _read_jsonl(bundle_directory / "game_manifest.jsonl")
    summary = _read_json(bundle_directory / "bundle_summary.json")
    expected = prep.materialize_bundle(manifest=manifest, manifest_path=manifest_path)
    _require(tasks == expected["task_rows"], "task bundle differs from exact regeneration")
    _require(raw_games == expected["game_rows"], "game bundle differs from exact regeneration")
    _require(summary == expected["summary"], "bundle summary differs from exact regeneration")
    _require(len(tasks) == EXPECTED_TASKS, "formal task count is not 45")
    _require(len(raw_games) == EXPECTED_GAMES, "formal game count is not 5,760")
    _require(all(int(task["games"]) == EXPECTED_GAMES_PER_TASK for task in tasks), "task game count changed")
    _require(
        all(task.get("runner_sha256") == sha256_file(prep.SCRIPT_PATH) for task in tasks),
        "task rows do not bind the current frozen preparation runner",
    )
    output_root = _resolve_repo_path(str(manifest["output_root"]))
    _require(
        _is_relative_to(bundle_directory, output_root) and bundle_directory != output_root,
        "formal bundle must be a named directory inside the frozen D18-v3 output root",
    )
    grouped_raw: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in raw_games:
        grouped_raw[str(row["task_id"])].append(row)
    _require(set(grouped_raw) == {str(task["task_id"]) for task in tasks}, "game task IDs differ")
    games: list[dict[str, Any]] = []
    for task in tasks:
        games.extend(_bound_task_schedules(task, grouped_raw[str(task["task_id"])]))
    return manifest, tasks, games, summary


def validate_contract(manifest_path: Path, bundle_directory: Path) -> dict[str, Any]:
    manifest, tasks, games, summary = load_frozen_bundle(manifest_path, bundle_directory)
    return {
        "schema_name": "lifeline-d18-v3-formal-execution-contract-check",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "formal_manifest_sha256": sha256_file(manifest_path.resolve()),
        "bundle_task_count": len(tasks),
        "bundle_game_count": len(games),
        "bundle_summary_sha256": sha256_file(bundle_directory.resolve() / "bundle_summary.json"),
        "formal_games_executed": 0,
        "gpu_actions": 0,
        "paid_actions": 0,
        "summary": summary,
    }


def _legacy_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    adapted = copy.deepcopy(dict(manifest))
    adapted["d16_v2"] = {"learned_search": copy.deepcopy(manifest["search"])}
    return adapted


def _agent_spec(binding: Mapping[str, Any]) -> dict[str, Any]:
    spec = copy.deepcopy(dict(binding))
    spec["kind"] = "learned_checkpoint"
    return spec


def _opening_from_pair(pair: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "opening_id": pair["opening_id"],
        "opening_actions": list(pair["opening_actions"]),
        "opening_prefix_hash": pair["opening_prefix_hash"],
        "opening_state_hash": pair["opening_state_hash"],
    }


def _first_task_by_size(tasks: Sequence[Mapping[str, Any]]) -> dict[int, Mapping[str, Any]]:
    result: dict[int, Mapping[str, Any]] = {}
    for task in tasks:
        result.setdefault(int(task["eval_size"]), task)
    _require(set(result) == {5, 7, 9}, "task bundle does not cover sizes 5, 7, and 9")
    return result


def task_shaped_readiness(
    manifest_path: Path, bundle_directory: Path
) -> dict[str, Any]:
    """Load every frozen checkpoint and exercise all model kinds and sizes."""

    import torch

    started = time.perf_counter()
    manifest_path = manifest_path.resolve()
    manifest, tasks, _, _ = load_frozen_bundle(manifest_path, bundle_directory)
    tasks_by_size = _first_task_by_size(tasks)
    opening_by_size = {
        size: _opening_from_pair(task["pair_plan"][0])
        for size, task in tasks_by_size.items()
    }
    adapted = _legacy_manifest(manifest)
    cases: list[dict[str, Any]] = []
    seen_kinds: set[str] = set()
    seen_sizes: set[int] = set()
    checkpoint_ids: set[str] = set()
    sizes = tuple(int(value) for value in prep.SIZES)
    for index, binding in enumerate(manifest["checkpoints"]):
        checkpoint_id = str(binding["checkpoint_id"])
        _require(checkpoint_id not in checkpoint_ids, "duplicate readiness checkpoint")
        checkpoint_ids.add(checkpoint_id)
        size = sizes[index % len(sizes)]
        spec = _agent_spec(binding)
        agent = legacy._load_neural_agent(
            spec,
            manifest=adapted,
            manifest_path=manifest_path,
            device="cpu",
            arm_name="d16_v2",
        )
        case = legacy._forward_case(
            agent,
            checkpoint=spec,
            size=size,
            opening=opening_by_size[size],
            fixture_kind="d18_v3_registered_opening",
        )
        case.update(
            {
                "checkpoint_id": checkpoint_id,
                "training_seed": int(binding["training_seed"]),
            }
        )
        cases.append(case)
        seen_kinds.add(str(binding["model_kind"]))
        seen_sizes.add(size)
    _require(len(checkpoint_ids) == 15, "readiness did not load all fifteen checkpoints")
    _require(
        seen_kinds == {"padded_cnn", "grid_gnn", "topology_gnn"},
        "readiness did not cover all model kinds",
    )
    _require(seen_sizes == {5, 7, 9}, "readiness did not cover all evaluation sizes")
    return {
        "schema_name": "lifeline-d18-v3-task-shaped-readiness",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "formal_manifest_sha256": sha256_file(manifest_path),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "verifier_sha256": sha256_file(VERIFIER_PATH),
        "device": "cpu",
        "torch_version": torch.__version__,
        "real_opening_samples": {
            str(size): opening_by_size[size]["opening_id"] for size in sorted(seen_sizes)
        },
        "loaded_checkpoint_count": len(checkpoint_ids),
        "loaded_checkpoint_ids": sorted(checkpoint_ids),
        "model_kinds_built": sorted(seen_kinds),
        "evaluation_sizes_forwarded": sorted(seen_sizes),
        "model_forward_calls": len(cases),
        "forward_cases": cases,
        "formal_games_executed": 0,
        "duration_seconds": time.perf_counter() - started,
        "completed_at_utc": _utc_now(),
    }


def _gpu_smoke_select_action(agent: Any, game: Any, rng: random.Random) -> Any:
    """Exercise one formal PUCT decision on a real, non-mutated game object."""

    from lifeline_rl import LifelineGame

    _require(
        isinstance(game, LifelineGame),
        "GPU smoke requires a LifelineGame, not a detached GameSnapshot",
    )
    before = game.clone()
    action = agent.select_action(game, rng)
    _require(game.clone() == before, "GPU smoke PUCT mutated its input game")
    return action


def _run_gpu_smoke_lane(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Run one production-initialized scalar, FP32, batch-one PUCT lane."""

    import torch

    _require(isinstance(payload, Mapping), "GPU smoke lane payload must be an object")
    lane_started = time.perf_counter()
    lane_index = payload.get("lane_index")
    seconds = payload.get("seconds")
    binding = payload.get("agent_binding")
    opening = payload.get("opening")
    model_pair = payload.get("model_pair")
    eval_size = payload.get("eval_size")
    _require(
        isinstance(lane_index, int) and not isinstance(lane_index, bool),
        "GPU smoke lane index must be an integer",
    )
    _require(
        isinstance(seconds, (int, float))
        and not isinstance(seconds, bool)
        and math.isfinite(float(seconds))
        and GPU_SMOKE_MIN_TOTAL_SECONDS <= float(seconds) <= GPU_SMOKE_MAX_TOTAL_SECONDS,
        "GPU smoke lane duration is invalid",
    )
    _require(isinstance(binding, Mapping), "GPU smoke agent binding is missing")
    _require(isinstance(opening, Mapping), "GPU smoke opening is missing")
    _require(
        isinstance(model_pair, list) and len(model_pair) == 2,
        "GPU smoke model pair is invalid",
    )
    _require(
        isinstance(eval_size, int) and eval_size in PROFILE_EVAL_SIZES,
        "GPU smoke evaluation size is invalid",
    )
    torch.cuda.reset_peak_memory_stats()
    loaded = _formal_lane_agent(binding)
    floating_state = [
        tensor
        for tensor in loaded.model.state_dict().values()
        if tensor.is_floating_point()
    ]
    _require(bool(floating_state), "GPU smoke model has no floating-point state")
    _require(
        all(tensor.dtype == torch.float32 for tensor in floating_state),
        "GPU smoke checkpoint is not entirely FP32",
    )
    game = legacy._game_from_opening(dict(opening), int(eval_size))
    before = {
        name: tensor.detach().cpu().clone()
        for name, tensor in loaded.model.state_dict().items()
    }
    torch.cuda.synchronize()
    setup_seconds = time.perf_counter() - lane_started
    decisions = 0
    model_forward_calls = 0
    utilization: list[float] = []

    def count_forward(*_: Any) -> None:
        nonlocal model_forward_calls
        model_forward_calls += 1

    forward_hook = loaded.model.register_forward_pre_hook(count_forward)
    sustained_started = time.perf_counter()
    deadline = sustained_started + float(seconds)
    next_utilization_sample = sustained_started
    helper = getattr(torch.cuda, "utilization", None)
    _require(callable(helper), "GPU smoke requires torch.cuda.utilization telemetry")
    try:
        with torch.inference_mode():
            while time.perf_counter() < deadline:
                now = time.perf_counter()
                if now >= next_utilization_sample:
                    utilization.append(float(helper()))
                    next_utilization_sample = now + 0.5
                playable = legacy._playable_game_copy(game)
                _gpu_smoke_select_action(
                    loaded,
                    playable,
                    random.Random(
                        202608300000 + int(lane_index) * 1_000_000 + decisions
                    ),
                )
                decisions += 1
    finally:
        forward_hook.remove()
    torch.cuda.synchronize()
    sustained_seconds = time.perf_counter() - sustained_started
    _require(decisions > 0, "GPU smoke lane did not complete a formal PUCT decision")
    _require(model_forward_calls > 0, "GPU smoke lane did not execute a model forward")
    _require(bool(utilization), "GPU smoke lane did not collect utilization telemetry")
    after = loaded.model.state_dict()
    _require(
        all(
            torch.equal(before[name], tensor.detach().cpu())
            for name, tensor in after.items()
        ),
        "GPU smoke changed frozen checkpoint weights or buffers",
    )
    _require(
        all(parameter.grad is None for parameter in loaded.model.parameters()),
        "GPU smoke created gradients on the frozen inference model",
    )
    device_index = torch.cuda.current_device()
    device_properties = torch.cuda.get_device_properties(device_index)
    return {
        "lane_index": int(lane_index),
        "coverage_case_id": str(payload["coverage_case_id"]),
        "checkpoint_id": str(binding["checkpoint_id"]),
        "model_kind": str(binding["model_kind"]),
        "model_pair": [str(value) for value in model_pair],
        "agent_slot": str(payload["agent_slot"]),
        "eval_size": int(eval_size),
        "opening_id": str(opening["opening_id"]),
        "puct_decisions": decisions,
        "model_forward_calls": model_forward_calls,
        "setup_seconds": setup_seconds,
        "sustained_seconds": sustained_seconds,
        "total_seconds": time.perf_counter() - lane_started,
        "gpu_utilization_samples_percent": utilization,
        "max_memory_allocated_bytes": torch.cuda.max_memory_allocated(),
        "device": str(torch.device("cuda")),
        "device_name": torch.cuda.get_device_name(device_index),
        "device_total_memory_bytes": int(device_properties.total_memory),
        "torch_version": torch.__version__,
        "cuda_runtime_version": torch.version.cuda,
    }


def _gpu_smoke_lane_payloads(
    tasks: Sequence[Mapping[str, Any]], *, seconds: float
) -> list[dict[str, Any]]:
    """Bind twelve lanes to the frozen 3-pair by 3-size task matrix."""

    by_case: dict[tuple[tuple[str, str], int], list[Mapping[str, Any]]] = defaultdict(list)
    for task in tasks:
        pair = tuple(str(value) for value in task["model_pair"])
        size = int(task["eval_size"])
        by_case[(pair, size)].append(task)
    expected_cases = {
        (pair, size) for pair in PROFILE_MODEL_PAIRS for size in PROFILE_EVAL_SIZES
    }
    _require(set(by_case) == expected_cases, "GPU smoke task matrix coverage differs")
    selected = {
        key: min(rows, key=lambda row: int(row["training_seed"]))
        for key, rows in by_case.items()
    }
    payloads: list[dict[str, Any]] = []

    def append_case(task: Mapping[str, Any], slot: str) -> None:
        lane_index = len(payloads)
        pair = [str(value) for value in task["model_pair"]]
        opening = _opening_from_pair(task["pair_plan"][0])
        payloads.append(
            {
                "lane_index": lane_index,
                "coverage_case_id": (
                    f"{pair[0]}_vs_{pair[1]}.n{int(task['eval_size'])}."
                    f"{slot}.lane{lane_index:02d}"
                ),
                "seconds": float(seconds),
                "agent_binding": copy.deepcopy(dict(task["agent_bindings"][slot])),
                "agent_slot": slot,
                "model_pair": pair,
                "eval_size": int(task["eval_size"]),
                "opening": opening,
            }
        )

    slot_by_size = {5: "A", 7: "B", 9: "A"}
    for pair in PROFILE_MODEL_PAIRS:
        for size in PROFILE_EVAL_SIZES:
            append_case(selected[(pair, size)], slot_by_size[size])
    for model_kind in PROFILE_MODEL_KINDS:
        matching = next(
            (task, slot)
            for pair in PROFILE_MODEL_PAIRS
            for size in PROFILE_EVAL_SIZES
            for task in (selected[(pair, size)],)
            for slot in ("A", "B")
            if task["agent_bindings"][slot]["model_kind"] == model_kind
        )
        append_case(*matching)
    _require(len(payloads) == SCALAR_LANE_COUNT, "GPU smoke lane count drifted")
    return payloads


def _profile_coverage(lane_results: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    kinds = {str(row["model_kind"]) for row in lane_results}
    pairs = {tuple(str(value) for value in row["model_pair"]) for row in lane_results}
    sizes = {int(row["eval_size"]) for row in lane_results}
    pair_sizes = {
        (tuple(str(value) for value in row["model_pair"]), int(row["eval_size"]))
        for row in lane_results
    }
    return {
        "model_kinds": [kind for kind in PROFILE_MODEL_KINDS if kind in kinds],
        "model_pairs": [list(pair) for pair in PROFILE_MODEL_PAIRS if pair in pairs],
        "evaluation_sizes": [size for size in PROFILE_EVAL_SIZES if size in sizes],
        "model_pair_size_cases": [
            {"model_pair": list(pair), "eval_size": size}
            for pair in PROFILE_MODEL_PAIRS
            for size in PROFILE_EVAL_SIZES
            if (pair, size) in pair_sizes
        ],
        "opening_ids_by_size": {
            str(size): sorted(
                {
                    str(row["opening_id"])
                    for row in lane_results
                    if int(row["eval_size"]) == size
                }
            )
            for size in PROFILE_EVAL_SIZES
        },
    }


def gpu_smoke(
    manifest_path: Path,
    bundle_directory: Path,
    *,
    seconds: float,
    profile_output: Path | None,
) -> dict[str, Any]:
    """Sustain the frozen CUDA inference/PUCT path without changing weights.

    Smoke workers use the exact formal initializer, cached-agent loader,
    playable-game copy, and scalar ``select_action`` path.  Together they
    cover every model family, every frozen model pair, and n=5/7/9 openings
    without completing a game or writing lane artifacts.
    """

    if not 15.0 <= seconds <= 30.0:
        raise FormalExecutionError("GPU smoke duration must be between 15 and 30 seconds")

    import torch

    _require(torch.cuda.is_available(), "GPU smoke requires an available CUDA device")
    work_raw = os.environ.get("AUTODL_WORK_DIR")
    _require(bool(work_raw), "AUTODL_WORK_DIR is required for GPU smoke")
    work_directory = Path(str(work_raw)).resolve()
    profile_output = (profile_output or work_directory / "d18_v3_gpu_throughput.json").resolve()
    try:
        profile_output.relative_to(work_directory)
    except ValueError as exc:
        raise FormalExecutionError("GPU smoke profile must stay inside AUTODL_WORK_DIR") from exc
    _require(not profile_output.exists(), f"refusing to overwrite GPU profile: {profile_output}")

    started = time.perf_counter()
    manifest_path = manifest_path.resolve()
    manifest, tasks, _, _ = load_frozen_bundle(manifest_path, bundle_directory)
    supply_started = time.perf_counter()
    lane_payloads = _gpu_smoke_lane_payloads(tasks, seconds=seconds)
    supply_seconds = time.perf_counter() - supply_started
    with _ScalarLaneExecutor(
        SCALAR_LANE_COUNT,
        initializer=_initialize_formal_lane_worker,
        initargs=(copy.deepcopy(manifest), str(manifest_path), "cuda"),
    ) as lane_executor:
        lane_results = lane_executor.map_ordered(
            _run_gpu_smoke_lane,
            lane_payloads,
        )
    _require(
        [row["lane_index"] for row in lane_results]
        == list(range(SCALAR_LANE_COUNT)),
        "GPU smoke lane results are not in canonical order",
    )
    decisions = sum(int(row["puct_decisions"]) for row in lane_results)
    model_forward_calls = sum(int(row["model_forward_calls"]) for row in lane_results)
    setup_seconds = max(float(row["setup_seconds"]) for row in lane_results)
    sustained_seconds = max(
        float(row["sustained_seconds"]) for row in lane_results
    )
    utilization = [
        float(sample)
        for row in lane_results
        for sample in row["gpu_utilization_samples_percent"]
    ]
    device_names = {str(row["device_name"]) for row in lane_results}
    torch_versions = {str(row["torch_version"]) for row in lane_results}
    cuda_versions = {str(row["cuda_runtime_version"]) for row in lane_results}
    _require(len(device_names) == 1, "GPU smoke lanes used different devices")
    _require(len(torch_versions) == 1, "GPU smoke lanes used different torch versions")
    _require(len(cuda_versions) == 1, "GPU smoke lanes used different CUDA runtimes")
    total_seconds = time.perf_counter() - started
    _require(
        GPU_SMOKE_MIN_TOTAL_SECONDS <= total_seconds <= GPU_SMOKE_MAX_TOTAL_SECONDS,
        "GPU smoke total duration must stay within 15-30 seconds; the requested "
        "sustained interval leaves only bounded process/model setup headroom",
    )
    aggregate_window_seconds = max(
        float(row["sustained_seconds"]) for row in lane_results
    )
    aggregate_rate = decisions / aggregate_window_seconds
    max_plies = max(int(task["max_plies"]) for task in tasks)
    worst_case_decisions = EXPECTED_GAMES * max_plies
    projected_worst_case_seconds = worst_case_decisions / aggregate_rate
    aggregate_memory = sum(
        int(row["max_memory_allocated_bytes"]) for row in lane_results
    )
    profile = {
        "schema_name": THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "formal_manifest_sha256": sha256_file(manifest_path),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "frozen_checkpoint_models": True,
        "formal_games_executed": 0,
        "device": "cuda",
        "device_name": next(iter(device_names)),
        "torch_version": next(iter(torch_versions)),
        "cuda_runtime_version": next(iter(cuda_versions)),
        "inference_only": True,
        "training_mode": False,
        "amp_enabled": AMP_ENABLED,
        "batch_calibration_performed": False,
        "selected_batch_size": INFERENCE_BATCH_SIZE,
        "inference_batch_size": INFERENCE_BATCH_SIZE,
        "inference_dtype": INFERENCE_DTYPE,
        "scalar_lane_count": SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": SCALAR_LANE_EXECUTION_MODE,
        "production_equivalent_mode": True,
        "optimizer_steps": 0,
        "backward_calls": 0,
        "formal_numeric_path_match": True,
        "puct_simulations": int(manifest["search"]["simulations"]),
        "temperature": float(manifest["search"]["temperature"]),
        "root_noise": bool(manifest["search"]["add_root_noise"]),
        "data_supply": "registered_d18_v3_task_binding_and_opening_clone",
        "coverage": _profile_coverage(lane_results),
        "input_parse_and_collate_seconds": supply_seconds,
        "setup_seconds": setup_seconds,
        "puct_decisions": decisions,
        "model_forward_calls": model_forward_calls,
        "requested_sustained_seconds": float(seconds),
        "sustained_seconds": sustained_seconds,
        "duration_seconds": total_seconds,
        "total_seconds": total_seconds,
        "aggregate_window_seconds": aggregate_window_seconds,
        "aggregate_puct_decisions_per_second": aggregate_rate,
        "formal_game_count": EXPECTED_GAMES,
        "formal_max_plies": max_plies,
        "worst_case_puct_decisions": worst_case_decisions,
        "formal_runtime_seconds": MAX_RUNTIME_SECONDS,
        "non_gameplay_reserve_fraction": FORMAL_NON_GAMEPLAY_RESERVE_FRACTION,
        "formal_gameplay_budget_seconds": FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "projected_worst_case_seconds": projected_worst_case_seconds,
        "lane_results": lane_results,
        "gpu_utilization_samples_percent": utilization,
        "gpu_utilization_mean_percent": statistics.fmean(utilization) if utilization else None,
        "gpu_utilization_max_percent": max(utilization) if utilization else None,
        "aggregate_peak_memory_allocated_bytes": aggregate_memory,
        "aggregate_peak_memory_limit_bytes": MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "minimum_device_memory_bytes": MIN_DEVICE_MEMORY_BYTES,
        "completed_at_utc": _utc_now(),
    }
    _validate_throughput_profile_payload(
        profile,
        manifest_sha256=sha256_file(manifest_path),
        tasks=tasks,
    )
    _atomic_json(profile_output, profile)
    return profile


def _finite_number(value: Any, label: str, *, minimum: float | None = None) -> float:
    _require(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value)),
        f"{label} must be finite",
    )
    result = float(value)
    if minimum is not None:
        _require(result >= minimum, f"{label} must be >= {minimum}")
    return result


def _require_all_numbers_finite(value: Any, label: str = "throughput") -> None:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, (int, float)):
        _require(math.isfinite(float(value)), f"{label} must be finite")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _require_all_numbers_finite(item, f"{label}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _require_all_numbers_finite(item, f"{label}[{index}]")


def _validate_throughput_profile_payload(
    profile: Mapping[str, Any],
    *,
    manifest_sha256: str,
    tasks: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Validate identity, coverage, environment, capacity, and finite telemetry."""

    _require_all_numbers_finite(profile)
    expected = {
        "schema_name": THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": manifest_sha256,
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "formal_games_executed": 0,
        "frozen_checkpoint_models": True,
        "device": "cuda",
        "inference_only": True,
        "training_mode": False,
        "amp_enabled": AMP_ENABLED,
        "batch_calibration_performed": False,
        "selected_batch_size": INFERENCE_BATCH_SIZE,
        "inference_batch_size": INFERENCE_BATCH_SIZE,
        "inference_dtype": INFERENCE_DTYPE,
        "scalar_lane_count": SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": SCALAR_LANE_EXECUTION_MODE,
        "production_equivalent_mode": True,
        "optimizer_steps": 0,
        "backward_calls": 0,
        "formal_numeric_path_match": True,
        "puct_simulations": 16,
        "temperature": 0.0,
        "root_noise": False,
        "formal_game_count": EXPECTED_GAMES,
        "formal_runtime_seconds": MAX_RUNTIME_SECONDS,
        "non_gameplay_reserve_fraction": FORMAL_NON_GAMEPLAY_RESERVE_FRACTION,
        "formal_gameplay_budget_seconds": FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "aggregate_peak_memory_limit_bytes": MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "minimum_device_memory_bytes": MIN_DEVICE_MEMORY_BYTES,
    }
    for field, value in expected.items():
        _require(
            profile.get(field) == value,
            f"formal throughput profile binding mismatch: {field}",
        )
    _require(len(tasks) == EXPECTED_TASKS, "formal throughput task count drifted")
    max_plies = max(int(task["max_plies"]) for task in tasks)
    worst_case_decisions = EXPECTED_GAMES * max_plies
    _require(profile.get("formal_max_plies") == max_plies, "formal throughput max-plies drifted")
    _require(
        profile.get("worst_case_puct_decisions") == worst_case_decisions,
        "formal throughput worst-case decision count drifted",
    )
    _require(
        EXPECTED_DEVICE_NAME_FRAGMENT.lower()
        in str(profile.get("device_name", "")).lower(),
        "formal throughput profile is not from an RTX 5090",
    )
    _require(
        str(profile.get("torch_version", "")).split("+", 1)[0]
        == EXPECTED_TORCH_VERSION,
        "formal throughput torch version drifted",
    )
    _require(
        profile.get("cuda_runtime_version") == EXPECTED_CUDA_RUNTIME_VERSION,
        "formal throughput CUDA runtime drifted",
    )
    requested_seconds = _finite_number(
        profile.get("requested_sustained_seconds"),
        "throughput.requested_sustained_seconds",
        minimum=GPU_SMOKE_MIN_TOTAL_SECONDS,
    )
    _require(
        requested_seconds <= GPU_SMOKE_MAX_TOTAL_SECONDS,
        "formal throughput requested duration exceeds 30 seconds",
    )
    total_seconds = _finite_number(profile.get("total_seconds"), "throughput.total_seconds")
    _require(
        GPU_SMOKE_MIN_TOTAL_SECONDS <= total_seconds <= GPU_SMOKE_MAX_TOTAL_SECONDS,
        "formal throughput total duration is outside 15-30 seconds",
    )
    _require(
        math.isclose(
            _finite_number(profile.get("duration_seconds"), "throughput.duration_seconds"),
            total_seconds,
            rel_tol=1e-12,
            abs_tol=1e-12,
        ),
        "formal throughput duration fields differ",
    )
    lane_results = profile.get("lane_results")
    _require(
        isinstance(lane_results, list) and len(lane_results) == SCALAR_LANE_COUNT,
        "formal throughput profile does not contain all scalar lanes",
    )
    _require(
        all(isinstance(row, Mapping) for row in lane_results)
        and [row.get("lane_index") for row in lane_results]
        == list(range(SCALAR_LANE_COUNT)),
        "formal throughput profile lane order drifted",
    )
    allowed_by_case: dict[tuple[tuple[str, str], int], dict[str, set[str]]] = defaultdict(
        lambda: {"checkpoint_ids": set(), "opening_ids": set()}
    )
    for task in tasks:
        key = (tuple(str(value) for value in task["model_pair"]), int(task["eval_size"]))
        allowed_by_case[key]["checkpoint_ids"].update(
            str(task["agent_bindings"][slot]["checkpoint_id"])
            for slot in ("A", "B")
        )
        allowed_by_case[key]["opening_ids"].update(
            str(pair["opening_id"]) for pair in task["pair_plan"]
        )
    decisions = 0
    forward_calls = 0
    memory_sum = 0
    utilization: list[float] = []
    lane_sustained: list[float] = []
    for index, lane in enumerate(lane_results):
        lane_decisions = lane.get("puct_decisions")
        lane_forwards = lane.get("model_forward_calls")
        _require(
            isinstance(lane_decisions, int)
            and not isinstance(lane_decisions, bool)
            and lane_decisions > 0,
            f"throughput lane {index} has no PUCT decisions",
        )
        _require(
            isinstance(lane_forwards, int)
            and not isinstance(lane_forwards, bool)
            and lane_decisions <= lane_forwards <= lane_decisions * 17,
            f"throughput lane {index} forward count is inconsistent",
        )
        sustained = _finite_number(
            lane.get("sustained_seconds"),
            f"throughput lane {index} sustained_seconds",
        )
        lane_total = _finite_number(
            lane.get("total_seconds"), f"throughput lane {index} total_seconds"
        )
        _finite_number(
            lane.get("setup_seconds"),
            f"throughput lane {index} setup_seconds",
            minimum=0.0,
        )
        _require(
            requested_seconds <= sustained <= requested_seconds + 5.0,
            f"throughput lane {index} did not sustain the requested interval",
        )
        _require(
            sustained <= lane_total <= total_seconds,
            f"throughput lane {index} duration exceeds the smoke command",
        )
        _require(lane.get("device") == "cuda", f"throughput lane {index} is not CUDA")
        _require(
            EXPECTED_DEVICE_NAME_FRAGMENT.lower()
            in str(lane.get("device_name", "")).lower(),
            f"throughput lane {index} is not on RTX 5090",
        )
        _require(
            str(lane.get("torch_version", "")).split("+", 1)[0]
            == EXPECTED_TORCH_VERSION,
            f"throughput lane {index} torch version drifted",
        )
        _require(
            lane.get("cuda_runtime_version") == EXPECTED_CUDA_RUNTIME_VERSION,
            f"throughput lane {index} CUDA runtime drifted",
        )
        device_memory = lane.get("device_total_memory_bytes")
        peak_memory = lane.get("max_memory_allocated_bytes")
        _require(
            isinstance(device_memory, int)
            and not isinstance(device_memory, bool)
            and device_memory >= MIN_DEVICE_MEMORY_BYTES,
            f"throughput lane {index} device memory is below the 32-GiB class",
        )
        _require(
            isinstance(peak_memory, int)
            and not isinstance(peak_memory, bool)
            and 0 < peak_memory <= device_memory,
            f"throughput lane {index} peak memory is invalid",
        )
        samples = lane.get("gpu_utilization_samples_percent")
        _require(
            isinstance(samples, list) and bool(samples),
            f"throughput lane {index} has no utilization samples",
        )
        lane_samples = [
            _finite_number(sample, f"throughput lane {index} utilization")
            for sample in samples
        ]
        _require(
            all(0.0 <= sample <= 100.0 for sample in lane_samples),
            f"throughput lane {index} utilization is outside 0-100",
        )
        pair = tuple(str(value) for value in lane.get("model_pair", []))
        size = lane.get("eval_size")
        key = (pair, size)
        _require(key in allowed_by_case, f"throughput lane {index} task case is unknown")
        _require(
            lane.get("checkpoint_id") in allowed_by_case[key]["checkpoint_ids"],
            f"throughput lane {index} checkpoint is not task-bound",
        )
        _require(
            lane.get("opening_id") in allowed_by_case[key]["opening_ids"],
            f"throughput lane {index} opening is not task-bound",
        )
        _require(
            lane.get("model_kind") in pair
            and lane.get("model_kind") in PROFILE_MODEL_KINDS,
            f"throughput lane {index} model family is not pair-bound",
        )
        _require(
            lane.get("agent_slot") in {"A", "B"},
            f"throughput lane {index} agent slot is invalid",
        )
        _require(
            bool(str(lane.get("coverage_case_id", ""))),
            f"throughput lane {index} coverage ID is missing",
        )
        decisions += lane_decisions
        forward_calls += lane_forwards
        memory_sum += peak_memory
        utilization.extend(lane_samples)
        lane_sustained.append(sustained)
    coverage = _profile_coverage(lane_results)
    expected_coverage = {
        "model_kinds": list(PROFILE_MODEL_KINDS),
        "model_pairs": [list(pair) for pair in PROFILE_MODEL_PAIRS],
        "evaluation_sizes": list(PROFILE_EVAL_SIZES),
        "model_pair_size_cases": [
            {"model_pair": list(pair), "eval_size": size}
            for pair in PROFILE_MODEL_PAIRS
            for size in PROFILE_EVAL_SIZES
        ],
        "opening_ids_by_size": coverage["opening_ids_by_size"],
    }
    _require(
        profile.get("coverage") == expected_coverage,
        "formal throughput coverage is incomplete",
    )
    _require(profile.get("puct_decisions") == decisions, "formal throughput decision aggregate drifted")
    _require(profile.get("model_forward_calls") == forward_calls, "formal throughput forward aggregate drifted")
    aggregate_window = max(lane_sustained)
    aggregate_rate = decisions / aggregate_window
    projected = worst_case_decisions / aggregate_rate
    _require(
        math.isclose(
            _finite_number(profile.get("aggregate_window_seconds"), "throughput.aggregate_window_seconds"),
            aggregate_window,
            rel_tol=1e-12,
            abs_tol=1e-12,
        ),
        "formal throughput aggregate window drifted",
    )
    _require(
        math.isclose(
            _finite_number(profile.get("aggregate_puct_decisions_per_second"), "throughput.aggregate_rate"),
            aggregate_rate,
            rel_tol=1e-12,
            abs_tol=1e-12,
        ),
        "formal throughput aggregate rate drifted",
    )
    _require(
        math.isclose(
            _finite_number(profile.get("projected_worst_case_seconds"), "throughput.projected_seconds"),
            projected,
            rel_tol=1e-12,
            abs_tol=1e-9,
        ),
        "formal throughput projection drifted",
    )
    _require(
        projected <= FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "formal throughput cannot finish the worst-case decision load inside 8,640 seconds",
    )
    _require(
        profile.get("aggregate_peak_memory_allocated_bytes") == memory_sum
        and memory_sum <= MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "formal throughput aggregate lane memory exceeds the safe 32-GiB class gate",
    )
    _require(
        profile.get("gpu_utilization_samples_percent") == utilization,
        "formal throughput utilization samples drifted",
    )
    utilization_mean = statistics.fmean(utilization)
    _require(
        math.isclose(
            _finite_number(profile.get("gpu_utilization_mean_percent"), "throughput.utilization_mean"),
            utilization_mean,
            rel_tol=1e-12,
            abs_tol=1e-12,
        )
        and utilization_mean >= 50.0,
        "formal throughput mean GPU utilization is below 50 percent",
    )
    _require(
        profile.get("gpu_utilization_max_percent") == max(utilization),
        "formal throughput utilization maximum drifted",
    )
    return dict(profile)


def _validate_throughput_profile(
    profile_path: Path,
    *,
    manifest_path: Path,
    tasks: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Validate the immutable smoke receipt before any formal-run mutation."""

    profile_path = profile_path.resolve()
    _require(profile_path.is_file(), "formal throughput profile is missing")
    profile = _validate_throughput_profile_payload(
        _read_json(profile_path),
        manifest_sha256=sha256_file(manifest_path.resolve()),
        tasks=tasks,
    )
    expected = {
        "schema_name": THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": sha256_file(manifest_path.resolve()),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "formal_games_executed": 0,
        "inference_only": True,
        "training_mode": False,
        "amp_enabled": AMP_ENABLED,
        "batch_calibration_performed": False,
        "selected_batch_size": INFERENCE_BATCH_SIZE,
        "inference_batch_size": INFERENCE_BATCH_SIZE,
        "inference_dtype": INFERENCE_DTYPE,
        "scalar_lane_count": SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": SCALAR_LANE_EXECUTION_MODE,
        "production_equivalent_mode": True,
        "optimizer_steps": 0,
        "backward_calls": 0,
        "formal_numeric_path_match": True,
    }
    for field, value in expected.items():
        _require(
            profile.get(field) == value,
            f"formal throughput profile binding mismatch: {field}",
        )
    _require(
        profile.get("puct_simulations") == 16,
        "formal throughput profile PUCT simulation count drifted",
    )
    _require(
        profile.get("temperature") == 0.0,
        "formal throughput profile temperature drifted",
    )
    _require(
        profile.get("root_noise") is False,
        "formal throughput profile root-noise setting drifted",
    )
    lane_results = profile.get("lane_results")
    _require(
        isinstance(lane_results, list) and len(lane_results) == SCALAR_LANE_COUNT,
        "formal throughput profile does not contain all scalar lanes",
    )
    _require(
        [row.get("lane_index") for row in lane_results]
        == list(range(SCALAR_LANE_COUNT)),
        "formal throughput profile lane order drifted",
    )
    _require(
        all(int(row.get("puct_decisions", 0)) > 0 for row in lane_results),
        "formal throughput profile contains an idle scalar lane",
    )
    return profile


def _throughput_profile_identity(
    profile_path: Path,
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "throughput_profile_sha256": sha256_file(profile_path.resolve()),
        "throughput_profile_artifact_path": profile_path.name,
        "throughput_profile_schema_name": profile["schema_name"],
        "throughput_profile_schema_version": profile["schema_version"],
        "throughput_profile_formal_manifest_sha256": profile[
            "formal_manifest_sha256"
        ],
        "throughput_profile_formal_runner_sha256": profile[
            "formal_runner_sha256"
        ],
        "scalar_lane_count": profile["scalar_lane_count"],
        "scalar_lane_execution_mode": profile["scalar_lane_execution_mode"],
        "inference_batch_size": profile["inference_batch_size"],
        "inference_dtype": profile["inference_dtype"],
        "amp_enabled": profile["amp_enabled"],
    }


def _slug(value: str) -> str:
    safe = "".join(character if character.isalnum() or character in "._-" else "-" for character in value)
    return safe[:180].strip("-") or "task"


def _task_directory(run_root: Path, task_id: str) -> Path:
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return run_root / "tasks" / f"{_slug(task_id)}__{digest}"


def _pair_path(task_directory: Path, pair_index: int) -> Path:
    return task_directory / "pairs" / f"pair_{pair_index:04d}.json"


def _task_artifact_path(task_directory: Path, raw: Any, expected_name: str) -> Path:
    _require(raw == expected_name, f"receipt must use relative {expected_name!r}")
    path = (task_directory / expected_name).resolve()
    _require(
        path.parent == task_directory.resolve(),
        f"receipt artifact escapes its task directory: {raw!r}",
    )
    return path


def _play_game(schedule: Mapping[str, Any], *, agent_a: Any, agent_b: Any) -> dict[str, Any]:
    from lifeline_rl import LifelineGame, Player

    size = int(schedule["eval_size"])
    game = LifelineGame(size, start_player=Player.BLACK, superko_mode=str(schedule["superko_mode"]))
    actions: list[dict[str, Any]] = []
    for raw_action in schedule["opening_actions"]:
        _require(not game.game_over, "opening becomes terminal before completion")
        actor = game.current_player
        action_index = int(raw_action)
        point = None if action_index == game.num_points else game.valid_positions[action_index]
        legacy._apply_action_index(game, action_index)
        actions.append(
            {
                "ply": len(actions),
                "actor": actor.value,
                "action": action_index,
                "point": None if point is None else [int(point[0]), int(point[1])],
                "decision_seconds": 0.0,
                "diagnostics": {
                    "phase": "opening_prefix",
                    "opening_id": schedule["opening_id"],
                    "opening_stratum": schedule["opening_stratum"],
                },
            }
        )
    _require(not game.game_over, "opening is terminal")
    _require(game.state_fingerprint() == schedule["opening_state_hash"], "opening state hash mismatch")

    agents = {"A": agent_a, "B": agent_b}
    color_slots = {Player.BLACK: str(schedule["black_slot"]), Player.WHITE: str(schedule["white_slot"])}
    policy_rng = {
        Player.BLACK: random.Random(int(schedule["black_policy_seed"])),
        Player.WHITE: random.Random(int(schedule["white_policy_seed"])),
    }
    started = time.perf_counter()
    max_plies = int(schedule["max_plies"])
    while not game.game_over and len(actions) < max_plies:
        actor = game.current_player
        agent = agents[color_slots[actor]]
        snapshot = game.clone()
        decision_started = time.perf_counter()
        action = agent.select_action(game, policy_rng[actor])
        decision_seconds = time.perf_counter() - decision_started
        _require(game.clone() == snapshot, f"agent {agent.name!r} mutated arena state")
        action_index, point = legacy._policy_action(game, action)
        legacy._apply_action_index(game, action_index)
        actions.append(
            {
                "ply": len(actions),
                "actor": actor.value,
                "action": action_index,
                "point": point,
                "decision_seconds": decision_seconds,
                "diagnostics": legacy._compact_diagnostics(agent, phase="evaluation"),
            }
        )
    truncated = not game.game_over
    winner = None if truncated else game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = None
    if game.game_over:
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
    prefix_length = len(schedule["opening_actions"])
    all_actions = [int(entry["action"]) for entry in actions]
    continuation = all_actions[prefix_length:]
    full_key = {
        "eval_size": size,
        "opening_actions": [int(value) for value in schedule["opening_actions"]],
        "continuation_actions": continuation,
    }
    bound_key = {**full_key, "black_slot": schedule["black_slot"], "white_slot": schedule["white_slot"]}
    record = copy.deepcopy(dict(schedule))
    record.update(
        {
            "schema_name": GAME_SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
            "formal_runner_sha256": sha256_file(SCRIPT_PATH),
            "schedule_sha256": canonical_sha256(schedule),
            "grid_size": size,
            "black_agent": agent_a.name if schedule["black_slot"] == "A" else agent_b.name,
            "white_agent": agent_a.name if schedule["white_slot"] == "A" else agent_b.name,
            "winner": winner_value,
            "truncated": truncated,
            "plies": len(actions),
            "continuation_plies": len(continuation),
            "duration_seconds": time.perf_counter() - started,
            "territories": territories,
            "actions": actions,
            "full_trajectory_hash": canonical_sha256(full_key),
            "continuation_trajectory_hash": canonical_sha256(continuation),
            "bound_trajectory_hash": canonical_sha256(bound_key),
            "final_state_hash": game.state_fingerprint(),
        }
    )
    return record


_FORMAL_LANE_MANIFEST: dict[str, Any] | None = None
_FORMAL_LANE_MANIFEST_PATH: Path | None = None
_FORMAL_LANE_DEVICE: str | None = None
_FORMAL_LANE_AGENT_CACHE: dict[tuple[str, str], Any] = {}


def _initialize_formal_lane_worker(
    manifest: Mapping[str, Any],
    manifest_path: str,
    device: str,
) -> None:
    """Bind immutable formal inputs once in each spawned lane process."""

    global _FORMAL_LANE_MANIFEST
    global _FORMAL_LANE_MANIFEST_PATH
    global _FORMAL_LANE_DEVICE
    _FORMAL_LANE_MANIFEST = copy.deepcopy(dict(manifest))
    _FORMAL_LANE_MANIFEST_PATH = Path(manifest_path).resolve()
    _FORMAL_LANE_DEVICE = str(device)
    _FORMAL_LANE_AGENT_CACHE.clear()


def _formal_lane_agent(binding: Mapping[str, Any]) -> Any:
    import torch

    _require(_FORMAL_LANE_MANIFEST is not None, "formal lane manifest is unbound")
    _require(
        _FORMAL_LANE_MANIFEST_PATH is not None,
        "formal lane manifest path is unbound",
    )
    _require(_FORMAL_LANE_DEVICE is not None, "formal lane device is unbound")
    spec = _agent_spec(binding)
    key = (str(spec["checkpoint_id"]), _FORMAL_LANE_DEVICE)
    if key not in _FORMAL_LANE_AGENT_CACHE:
        agent = legacy._load_neural_agent(
            spec,
            manifest=_legacy_manifest(_FORMAL_LANE_MANIFEST),
            manifest_path=_FORMAL_LANE_MANIFEST_PATH,
            device=_FORMAL_LANE_DEVICE,
            arm_name="d16_v2",
        )
        agent.model.eval()
        floating_state = [
            tensor
            for tensor in agent.model.state_dict().values()
            if tensor.is_floating_point()
        ]
        _require(bool(floating_state), "formal lane model has no floating-point state")
        _require(
            all(tensor.dtype == torch.float32 for tensor in floating_state),
            "formal lane checkpoint is not entirely FP32",
        )
        _require(
            all(parameter.grad is None for parameter in agent.model.parameters()),
            "formal lane checkpoint has pre-existing gradients",
        )
        _FORMAL_LANE_AGENT_CACHE[key] = agent
    return _FORMAL_LANE_AGENT_CACHE[key]


def _run_formal_pair_lane(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Compute one independent color pair and return data without writing."""

    import torch

    _require(isinstance(payload, Mapping), "formal lane payload must be an object")
    _require(isinstance(payload.get("task"), Mapping), "formal lane task is missing")
    _require(isinstance(payload.get("schedules"), list), "formal lane schedules are missing")
    task = dict(payload["task"])
    schedules = sorted(
        (dict(row) for row in payload["schedules"]),
        key=lambda row: int(row["pair_member"]),
    )
    _require(len(schedules) == 2, "a formal scalar lane needs one color pair")
    agents = {
        slot: _formal_lane_agent(task["agent_bindings"][slot])
        for slot in ("A", "B")
    }
    with torch.inference_mode():
        records = [
            _play_game(schedule, agent_a=agents["A"], agent_b=agents["B"])
            for schedule in schedules
        ]
    return {
        "schema_name": PAIR_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "task_id": schedules[0]["task_id"],
        "pair_id": schedules[0]["pair_id"],
        "pair_index": int(schedules[0]["pair_index"]),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "games": records,
    }


def _validate_game(record: Mapping[str, Any], schedule: Mapping[str, Any]) -> None:
    from lifeline_rl import replay_game_record

    for field, expected in schedule.items():
        _require(record.get(field) == expected, f"{schedule['game_id']}: schedule field changed: {field}")
    _require(record.get("schema_name") == GAME_SCHEMA, "formal game schema mismatch")
    _require(
        record.get("preparation_runner_sha256") == sha256_file(prep.SCRIPT_PATH)
        == schedule.get("runner_sha256"),
        "preparation runner binding mismatch",
    )
    _require(record.get("formal_runner_sha256") == sha256_file(SCRIPT_PATH), "formal runner binding mismatch")
    _require(record.get("schedule_sha256") == canonical_sha256(schedule), "game schedule hash mismatch")
    actions = record.get("actions")
    _require(isinstance(actions, list) and len(actions) == int(record.get("plies", -1)), "action log length mismatch")
    prefix = [int(value) for value in schedule["opening_actions"]]
    observed_prefix = [int(entry["action"]) for entry in actions[: len(prefix)]]
    _require(observed_prefix == prefix, "game opening prefix differs from schedule")
    continuation = [int(entry["action"]) for entry in actions[len(prefix) :]]
    full_key = {"eval_size": int(schedule["eval_size"]), "opening_actions": prefix, "continuation_actions": continuation}
    bound_key = {**full_key, "black_slot": schedule["black_slot"], "white_slot": schedule["white_slot"]}
    _require(record.get("full_trajectory_hash") == canonical_sha256(full_key), "full trajectory hash mismatch")
    _require(record.get("continuation_trajectory_hash") == canonical_sha256(continuation), "continuation hash mismatch")
    _require(record.get("bound_trajectory_hash") == canonical_sha256(bound_key), "bound trajectory hash mismatch")
    replayed = replay_game_record(dict(record))
    _require(replayed.state_fingerprint() == record.get("final_state_hash"), "independent game replay hash mismatch")


def _validate_pair(payload: Mapping[str, Any], schedules: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    _require(len(schedules) == 2, "a formal color pair needs exactly two games")
    _require(payload.get("schema_name") == PAIR_SCHEMA, "formal pair schema mismatch")
    _require(payload.get("schema_version") == SCHEMA_VERSION, "formal pair schema version mismatch")
    records = payload.get("games")
    _require(isinstance(records, list) and len(records) == 2, "pair artifact needs two game records")
    ordered_schedules = sorted(schedules, key=lambda row: int(row["pair_member"]))
    ordered_records = sorted((dict(row) for row in records), key=lambda row: int(row["pair_member"]))
    for record, schedule in zip(ordered_records, ordered_schedules):
        _validate_game(record, schedule)
    first, second = ordered_records
    _require(
        int(first["pair_member"]) == 0 and int(second["pair_member"]) == 1
        and first["black_slot"] == "A" and first["white_slot"] == "B"
        and second["black_slot"] == "B" and second["white_slot"] == "A",
        "pair does not implement the frozen color swap",
    )
    expected_pair_index = int(ordered_schedules[0]["pair_index"])
    _require(payload.get("task_id") == first["task_id"], "pair task binding mismatch")
    _require(payload.get("pair_id") == first["pair_id"], "pair ID binding mismatch")
    _require(payload.get("pair_index") == expected_pair_index, "pair index binding mismatch")
    _require(
        payload.get("preparation_runner_sha256") == sha256_file(prep.SCRIPT_PATH)
        == first["runner_sha256"],
        "pair preparation runner binding mismatch",
    )
    _require(
        payload.get("formal_runner_sha256") == sha256_file(SCRIPT_PATH),
        "pair formal runner binding mismatch",
    )
    invariant_fields = (
        "pair_id",
        "opening_stratum",
        "opening_variant",
        "opening_id",
        "opening_actions",
        "opening_prefix_hash",
        "opening_state_hash",
        "training_seed",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
    )
    for field in invariant_fields:
        _require(first[field] == second[field], f"color pair changed {field}")
    return ordered_records


def _task_counts(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    wins = losses = draws = truncated = 0
    for record in records:
        if bool(record["truncated"]):
            truncated += 1
        elif record["winner"] == "DRAW":
            draws += 1
        else:
            a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
            if record["winner"] == a_color:
                wins += 1
            else:
                losses += 1
    strata: dict[str, set[str]] = defaultdict(set)
    stratum_rows: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        key = str(record["opening_stratum"])
        strata[key].add(str(record["continuation_trajectory_hash"]))
        stratum_rows[key].append(record)
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
            if (
                len(variant_rows) == 2
                and {int(row["pair_member"]) for row in variant_rows} == {0, 1}
                and {(str(row["black_slot"]), str(row["white_slot"])) for row in variant_rows}
                == {("A", "B"), ("B", "A")}
            ):
                exact_variant_color_pairs += 1
    return {
        "games_requested": len(records),
        "games_completed": len(records) - truncated,
        "truncated_games": truncated,
        "a_wins": wins,
        "a_losses": losses,
        "draws": draws,
        "replay_verified_games": len(records),
        "unique_full_trajectories": len({str(row["full_trajectory_hash"]) for row in records}),
        "unique_prefix_stripped_continuations": len(
            {str(row["continuation_trajectory_hash"]) for row in records}
        ),
        "unique_bound_trajectories_with_slots": len(
            {str(row["bound_trajectory_hash"]) for row in records}
        ),
        "opening_strata": len(strata),
        "opening_strata_with_exact_four_games": exact_four,
        "opening_strata_with_exact_two_variants": exact_two_variants,
        "opening_variants_with_exact_color_pair": exact_variant_color_pairs,
        "strata_with_two_unique_continuations": sum(len(values) >= 2 for values in strata.values()),
    }


def _formal_gate(task: Mapping[str, Any], counts: Mapping[str, Any]) -> dict[str, Any]:
    gates = task["formal_gates"]
    checks = {
        "exact_game_count": counts["games_requested"] == int(task["games"]) == EXPECTED_GAMES_PER_TASK,
        "all_games_completed": counts["games_completed"] == int(task["games"]),
        "zero_truncations": counts["truncated_games"] == 0,
        "all_games_replay_verified": counts["replay_verified_games"] == int(task["games"]),
        "minimum_unique_full_trajectories": counts["unique_full_trajectories"] >= int(gates["min_unique_trajectories"]),
        "minimum_unique_prefix_stripped_continuations": counts["unique_prefix_stripped_continuations"] >= int(gates["min_unique_prefix_stripped_continuations"]),
        "exact_opening_strata": counts["opening_strata"] == int(gates["opening_strata"]),
        "exact_four_games_per_opening_stratum": (
            counts["opening_strata_with_exact_four_games"] == int(gates["opening_strata"])
        ),
        "exact_two_variants_per_opening_stratum": (
            counts["opening_strata_with_exact_two_variants"] == int(gates["opening_strata"])
        ),
        "exact_color_pair_per_opening_variant": (
            counts["opening_variants_with_exact_color_pair"]
            == int(gates["opening_strata"]) * 2
        ),
        "minimum_strata_with_two_continuations": counts["strata_with_two_unique_continuations"] >= int(gates["min_clusters_with_two_continuations"]),
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": copy.deepcopy(dict(gates)),
        "full_trajectory_key": "eval_size+opening_actions+continuation_actions; slot labels ignored",
        "continuation_key": "continuation_actions only",
        "stratum_key": "opening_stratum across both registered variants and both colors",
    }


def _runner_score_for_a(record: Mapping[str, Any]) -> tuple[float, str]:
    _require(record.get("truncated") is False, "truncated game reached canonical aggregation")
    winner = record.get("winner")
    if winner == "DRAW":
        return 0.5, "DRAW"
    _require(winner in {"BLACK", "WHITE"}, f"invalid winner in canonical aggregation: {winner!r}")
    a_color = "BLACK" if record.get("black_slot") == "A" else "WHITE"
    return ((1.0, "WIN") if winner == a_color else (0.0, "LOSS"))


def _runner_percentile(values: Sequence[float], probability: float) -> float:
    _require(bool(values), "cannot take a percentile of no values")
    ordered = sorted(float(value) for value in values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _runner_crossed_bootstrap(
    matrix: Mapping[int, Mapping[str, float]],
    *,
    replicates: int = BOOTSTRAP_REPLICATES,
    seed: int = BOOTSTRAP_SEED,
) -> list[float]:
    seeds = sorted(matrix)
    _require(seeds == list(prep.TRAINING_SEEDS), "canonical bootstrap training seeds changed")
    strata_sets = [set(matrix[item]) for item in seeds]
    _require(
        bool(strata_sets) and all(values == strata_sets[0] for values in strata_sets),
        "canonical bootstrap seed rows use different strata",
    )
    strata = sorted(strata_sets[0])
    _require(len(strata) == 32, "canonical bootstrap requires exactly 32 strata")
    _require(replicates > 0, "canonical bootstrap requires positive replicates")
    rng = random.Random(seed)
    estimates: list[float] = []
    denominator = len(seeds) * len(strata)
    for _ in range(replicates):
        sampled_seeds = [rng.choice(seeds) for _ in seeds]
        sampled_strata = [rng.choice(strata) for _ in strata]
        total = sum(
            matrix[training_seed][stratum]
            for training_seed in sampled_seeds
            for stratum in sampled_strata
        )
        estimates.append(total / denominator)
    return [
        _runner_percentile(estimates, 0.025),
        _runner_percentile(estimates, 0.975),
    ]


def _runner_seed_t_interval(values: Sequence[float]) -> list[float]:
    _require(len(values) == 5, "canonical seed-t interval requires five seed means")
    mean = statistics.fmean(values)
    standard_error = statistics.stdev(values) / math.sqrt(5)
    margin = SEED_T_CRITICAL_DF4 * standard_error
    return [max(0.0, mean - margin), min(1.0, mean + margin)]


def _runner_comparison_rows(
    records: Sequence[Mapping[str, Any]],
    *,
    bootstrap_replicates: int = BOOTSTRAP_REPLICATES,
) -> list[dict[str, Any]]:
    """Compute the runner-side numeric artifact without importing the verifier."""

    by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for record in records:
        by_group[str(record["inference_group_id"])].append(record)
    _require(
        len(by_group) == len(prep.MODEL_PAIRS) * len(prep.SIZES),
        "canonical aggregation requires exactly nine inference groups",
    )
    rows: list[dict[str, Any]] = []
    for pair in prep.MODEL_PAIRS:
        for size in prep.SIZES:
            group_id = f"d16-v3.{pair[0]}_vs_{pair[1]}.n{size}"
            games = by_group.get(group_id, [])
            _require(len(games) == 5 * EXPECTED_GAMES_PER_TASK, f"{group_id}: expected 640 games")
            cells: dict[int, dict[str, list[float]]] = defaultdict(
                lambda: defaultdict(list)
            )
            outcomes: Counter[str] = Counter()
            for game in games:
                score, outcome = _runner_score_for_a(game)
                outcomes[outcome] += 1
                cells[int(game["training_seed"])][str(game["opening_stratum"])].append(score)
            matrix: dict[int, dict[str, float]] = {}
            seed_rows: list[dict[str, Any]] = []
            seed_means: list[float] = []
            for training_seed in prep.TRAINING_SEEDS:
                strata = cells.get(int(training_seed), {})
                _require(len(strata) == 32, f"{group_id}: seed {training_seed} lacks 32 strata")
                matrix[int(training_seed)] = {}
                for stratum, values in strata.items():
                    _require(len(values) == 4, f"{group_id}: seed/stratum cell must contain four games")
                    matrix[int(training_seed)][stratum] = statistics.fmean(values)
                seed_mean = statistics.fmean(matrix[int(training_seed)].values())
                seed_means.append(seed_mean)
                seed_rows.append(
                    {
                        "training_seed": int(training_seed),
                        "opening_strata": 32,
                        "seed_score_equal_weighted_over_strata": seed_mean,
                    }
                )
            point = statistics.fmean(seed_means)
            rows.append(
                {
                    "inference_group_id": group_id,
                    "model_pair": list(pair),
                    "eval_size": int(size),
                    "training_seed_units": 5,
                    "seed_by_opening_stratum_units": 160,
                    "games_completed": len(games),
                    "a_wins": outcomes["WIN"],
                    "a_losses": outcomes["LOSS"],
                    "draws": outcomes["DRAW"],
                    "paired_a_score_equal_weighted_over_seed_and_stratum": point,
                    "primary_interval_method": "two-way crossed training-seed x opening-stratum percentile bootstrap",
                    "primary_ci95": _runner_crossed_bootstrap(
                        matrix,
                        replicates=bootstrap_replicates,
                        seed=BOOTSTRAP_SEED,
                    ),
                    "crossed_bootstrap_replicates": bootstrap_replicates,
                    "crossed_bootstrap_seed": BOOTSTRAP_SEED,
                    "secondary_interval_method": "Student t interval across five training-seed means",
                    "secondary_ci95": _runner_seed_t_interval(seed_means),
                    "secondary_degrees_of_freedom": 4,
                    "pooled_game_score_descriptive_only": (
                        outcomes["WIN"] + 0.5 * outcomes["DRAW"]
                    )
                    / len(games),
                    "seed_units": seed_rows,
                }
            )
    return rows


def _runner_numeric_artifact(
    records: Sequence[Mapping[str, Any]],
    *,
    metadata: Mapping[str, Any],
    receipt_ledger_sha256: str,
) -> dict[str, Any]:
    return {
        "schema_name": "lifeline-d18-v3-runner-canonical-numeric",
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": metadata["formal_manifest_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "receipt_ledger_sha256": receipt_ledger_sha256,
        "comparison_rows": _runner_comparison_rows(records),
    }


def _group_games(games: Sequence[Mapping[str, Any]]) -> dict[str, list[Mapping[str, Any]]]:
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for game in games:
        grouped[str(game["task_id"])].append(game)
    for rows in grouped.values():
        rows.sort(key=lambda row: int(row["game_index"]))
    return dict(grouped)


def _execution_dependency_paths(manifest_path: Path) -> tuple[Path, ...]:
    manifest = prep.load_json(manifest_path)
    _require(VERIFIER_PATH.is_file(), "independent D18-v3 verifier source is missing")
    sources: set[Path] = {
        SCRIPT_PATH,
        VERIFIER_PATH,
        DEPENDENCY_LOCK_PATH,
        prep.SCRIPT_PATH,
        Path(legacy.__file__).resolve(),
        Path(legacy.__file__).resolve().with_name("d17_d19_experiments.py"),
        manifest_path.resolve(),
        RESEARCH_ROOT / "pyproject.toml",
    }
    for raw_path in manifest["source_hashes"]:
        sources.add(_resolve_repo_path(str(raw_path)))
    for checkpoint in manifest["checkpoints"]:
        for field in (
            "path",
            "config_path",
            "source_receipt_path",
            "latest_manifest_path",
        ):
            sources.add(_resolve_repo_path(str(checkpoint[field])))
    return tuple(sorted(sources, key=lambda item: _repo_relative(item)))


def _execution_source_hashes(manifest_path: Path) -> dict[str, str]:
    return {
        _repo_relative(path): sha256_file(path)
        for path in _execution_dependency_paths(manifest_path)
    }


def _bundle_hashes(bundle_directory: Path) -> dict[str, str]:
    return {
        field: sha256_file(bundle_directory / filename)
        for field, filename in BUNDLE_HASH_FILES.items()
    }


def _stage_semantic_bindings(
    manifest_path: Path, bundle_directory: Path
) -> dict[str, str]:
    bundle_relative = _repo_relative(bundle_directory.resolve())
    return {
        "formal_manifest_sha256": _repo_relative(manifest_path.resolve()),
        "formal_runner_sha256": _repo_relative(SCRIPT_PATH),
        "preparation_runner_sha256": _repo_relative(prep.SCRIPT_PATH),
        "verifier_sha256": _repo_relative(VERIFIER_PATH),
        "dependency_lock_sha256": _repo_relative(DEPENDENCY_LOCK_PATH),
        **{
            field: f"{bundle_relative}/{filename}"
            for field, filename in BUNDLE_HASH_FILES.items()
        },
    }


def _expected_stage_rows(
    manifest_path: Path, bundle_directory: Path
) -> dict[str, dict[str, Any]]:
    source_hashes = _execution_source_hashes(manifest_path.resolve())
    expected_paths = {
        relative: _resolve_repo_path(relative) for relative in source_hashes
    }
    bundle_directory = bundle_directory.resolve()
    for filename in BUNDLE_HASH_FILES.values():
        path = bundle_directory / filename
        expected_paths[_repo_relative(path)] = path
    return {
        relative: {
            "path": relative,
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }
        for relative, path in sorted(expected_paths.items())
    }


def _require_stage_matches_local_closure(
    stage_manifest: Mapping[str, Any],
    manifest_path: Path,
    bundle_directory: Path,
) -> None:
    actual_rows = {
        str(row["path"]): dict(row) for row in stage_manifest.get("files", [])
    }
    expected_rows = _expected_stage_rows(manifest_path, bundle_directory)
    _require(
        actual_rows == expected_rows,
        "AutoDL stage rows differ from the exact local source and bundle closure",
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


def _execution_freeze_core(metadata: Mapping[str, Any]) -> dict[str, Any]:
    missing = [field for field in EXECUTION_FREEZE_FIELDS if field not in metadata]
    _require(not missing, "execution metadata core is incomplete: " + ", ".join(missing))
    return {
        field: copy.deepcopy(metadata[field]) for field in EXECUTION_FREEZE_FIELDS
    }


def _execution_metadata(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
    device: str,
    throughput_profile_path: Path,
    throughput_profile: Mapping[str, Any],
) -> dict[str, Any]:
    import torch

    device_object = torch.device(device)
    if device_object.type == "cuda":
        _require(torch.cuda.is_available(), f"requested CUDA device is unavailable: {device}")
        device_name = torch.cuda.get_device_name(device_object)
    else:
        device_name = None
    metadata = {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "formal_manifest_path": str(manifest_path.resolve()),
        "formal_manifest_sha256": sha256_file(manifest_path),
        "protocol_sha256": manifest["protocol_sha256"],
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "verifier_sha256": sha256_file(VERIFIER_PATH),
        "execution_source_hashes": _execution_source_hashes(manifest_path),
        "bundle_directory": str(bundle_directory.resolve()),
        **_bundle_hashes(bundle_directory),
        "run_root": str(run_root.resolve()),
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "cuda_runtime_version": torch.version.cuda,
        "cudnn_version": torch.backends.cudnn.version(),
        "device": str(device_object),
        "device_name": device_name,
        "formal_source_hash": legacy._validate_source_identity(manifest["checkpoints"]),
        **_throughput_profile_identity(
            throughput_profile_path,
            throughput_profile,
        ),
    }
    metadata["execution_freeze_sha256"] = canonical_sha256(
        _execution_freeze_core(metadata)
    )
    return metadata


def _task_receipt_base(task: Mapping[str, Any], metadata: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema_name": RECEIPT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": task["experiment_id"],
        "experiment_arm": task["experiment_arm"],
        "task_id": task["task_id"],
        "inference_group_id": task["inference_group_id"],
        "formal_manifest_sha256": task["formal_manifest_sha256"],
        "protocol_sha256": task["protocol_sha256"],
        "preparation_runner_sha256": task["runner_sha256"],
        "formal_runner_sha256": metadata["formal_runner_sha256"],
        "verifier_sha256": metadata["verifier_sha256"],
        "execution_freeze_sha256": metadata["execution_freeze_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "training_seed": task["training_seed"],
        "eval_size": task["eval_size"],
        "model_pair": task["model_pair"],
        "checkpoint_bindings": copy.deepcopy(task["agent_bindings"]),
        "max_plies": task["max_plies"],
        "superko_mode": task["superko_mode"],
        "execution_identity": {
            key: copy.deepcopy(metadata[key])
            for key in (
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
            )
        },
    }


def _execute_pair_lanes(
    task: Mapping[str, Any],
    pairs: Mapping[int, Sequence[Mapping[str, Any]]],
    *,
    task_directory: Path,
    lane_executor: _ScalarLaneExecutor,
) -> None:
    """Compute all missing pairs, validate all, then write canonically in parent."""

    missing: list[tuple[int, Sequence[Mapping[str, Any]]]] = []
    for pair_index in sorted(pairs):
        schedules = pairs[pair_index]
        path = _pair_path(task_directory, pair_index)
        if path.is_file():
            _validate_pair(_read_json(path), schedules)
        else:
            missing.append((pair_index, schedules))
    if not missing:
        return
    jobs = [
        {
            "task": copy.deepcopy(dict(task)),
            "schedules": [copy.deepcopy(dict(row)) for row in schedules],
        }
        for _, schedules in missing
    ]
    payloads = lane_executor.map_ordered(_run_formal_pair_lane, jobs)
    _require(
        all(isinstance(payload, Mapping) for payload in payloads),
        "formal scalar lane returned an invalid payload",
    )
    expected_indices = [pair_index for pair_index, _ in missing]
    _require(
        [int(payload.get("pair_index", -1)) for payload in payloads]
        == expected_indices,
        "formal scalar lane results are not in canonical pair order",
    )
    for payload, (_, schedules) in zip(payloads, missing):
        _validate_pair(payload, schedules)
    for payload, (pair_index, _) in zip(payloads, missing):
        _atomic_json(_pair_path(task_directory, pair_index), payload)


def _pair_evidence(
    task_directory: Path, schedules: Sequence[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    for schedule in schedules:
        grouped[int(schedule["pair_index"])].append(schedule)
    _require(len(grouped) == EXPECTED_PAIRS_PER_TASK, "task pair evidence count is not 64")
    expected_names = {f"pair_{index:04d}.json" for index in grouped}
    pairs_directory = task_directory / "pairs"
    _require(pairs_directory.is_dir(), "task pair evidence directory is missing")
    observed_names = {
        path.name for path in pairs_directory.iterdir() if path.is_file()
    }
    _require(observed_names == expected_names, "task pair evidence file set differs")
    rows: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    for pair_index in sorted(grouped):
        path = _pair_path(task_directory, pair_index)
        pair_records = _validate_pair(_read_json(path), grouped[pair_index])
        records.extend(pair_records)
        rows.append(
            {
                "path": path.relative_to(task_directory).as_posix(),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
        )
    records.sort(key=lambda row: int(row["game_index"]))
    return rows, records


def _run_task(
    task: Mapping[str, Any],
    schedules: Sequence[Mapping[str, Any]],
    *,
    task_directory: Path,
    metadata: Mapping[str, Any],
    lane_executor: _ScalarLaneExecutor,
) -> dict[str, Any]:
    receipt_path = task_directory / "receipt.json"
    if receipt_path.is_file():
        receipt = _read_json(receipt_path)
        _validate_task_receipt(
            task, schedules, receipt, metadata, task_directory=task_directory
        )
        return receipt
    pairs: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    for schedule in schedules:
        pairs[int(schedule["pair_index"])].append(schedule)
    _require(len(pairs) == EXPECTED_PAIRS_PER_TASK, "task pair count is not 64")
    _execute_pair_lanes(
        task,
        pairs,
        task_directory=task_directory,
        lane_executor=lane_executor,
    )
    pair_artifacts, pair_records = _pair_evidence(task_directory, schedules)
    records = pair_records
    counts = _task_counts(records)
    gate = _formal_gate(task, counts)
    games_path = task_directory / "games.jsonl"
    games_text = _jsonl_text(records)
    if games_path.is_file():
        _require(games_path.read_text(encoding="utf-8") == games_text, "existing task games differ")
    else:
        _atomic_text(games_path, games_text)
    summary = {
        **_task_receipt_base(task, metadata),
        **counts,
        "formal_gate": gate,
        "status": "complete",
        "execution_status": "complete",
        "gate_status": "passed" if gate["passed"] else "failed",
        "failure_reason": None if gate["passed"] else "formal_task_gate_failed",
        "pair_artifacts": pair_artifacts,
        "games_path": "games.jsonl",
        "games_sha256": sha256_file(games_path),
    }
    summary_path = task_directory / "summary.json"
    _atomic_json(summary_path, summary)
    receipt = {
        **summary,
        "summary_path": "summary.json",
        "summary_sha256": sha256_file(summary_path),
        "completed_at_utc": _utc_now(),
    }
    _validate_task_receipt(
        task, schedules, receipt, metadata, task_directory=task_directory
    )
    _atomic_json(receipt_path, receipt)
    return receipt


def _validate_task_receipt(
    task: Mapping[str, Any],
    schedules: Sequence[Mapping[str, Any]],
    receipt: Mapping[str, Any],
    metadata: Mapping[str, Any],
    *,
    task_directory: Path,
) -> None:
    for field, expected in _task_receipt_base(task, metadata).items():
        _require(receipt.get(field) == expected, f"{task['task_id']}: receipt binding mismatch: {field}")
    games_path = _task_artifact_path(
        task_directory, receipt.get("games_path"), "games.jsonl"
    )
    summary_path = _task_artifact_path(
        task_directory, receipt.get("summary_path"), "summary.json"
    )
    _require(games_path.is_file() and summary_path.is_file(), "receipt artifacts are missing")
    _require(sha256_file(games_path) == receipt.get("games_sha256"), "task games hash mismatch")
    _require(sha256_file(summary_path) == receipt.get("summary_sha256"), "task summary hash mismatch")
    records = _read_jsonl(games_path)
    ordered_schedules = sorted(schedules, key=lambda row: int(row["game_index"]))
    _require(len(records) == len(ordered_schedules), "receipt game count mismatch")
    for record, schedule in zip(records, ordered_schedules):
        _validate_game(record, schedule)
    pair_artifacts, pair_records = _pair_evidence(task_directory, ordered_schedules)
    _require(pair_records == records, "task games differ from atomic pair evidence")
    _require(receipt.get("pair_artifacts") == pair_artifacts, "pair artifact manifest mismatch")
    counts = _task_counts(records)
    gate = _formal_gate(task, counts)
    for field, expected in counts.items():
        _require(receipt.get(field) == expected, f"receipt count mismatch: {field}")
    _require(receipt.get("formal_gate") == gate, "receipt formal gate mismatch")
    _require(receipt.get("gate_status") == ("passed" if gate["passed"] else "failed"), "receipt gate status mismatch")
    _require(receipt.get("status") == "complete", "receipt status is not complete")
    _require(receipt.get("execution_status") == "complete", "receipt execution status is not complete")
    _require(
        receipt.get("failure_reason")
        == (None if gate["passed"] else "formal_task_gate_failed"),
        "receipt failure reason is inconsistent with the formal gate",
    )
    expected_summary = {
        key: copy.deepcopy(value)
        for key, value in receipt.items()
        if key not in {"summary_path", "summary_sha256", "completed_at_utc"}
    }
    _require(_read_json(summary_path) == expected_summary, "task summary differs from receipt")


def _write_failure(task_directory: Path, state: Mapping[str, Any], exc: BaseException) -> None:
    attempts = task_directory / "attempts"
    attempts.mkdir(parents=True, exist_ok=True)
    index = int(state.get("attempts", 1))
    path = attempts / f"attempt_{index:04d}.failed.json"
    payload = {
        "schema_name": "lifeline-d18-v3-failed-attempt",
        "schema_version": SCHEMA_VERSION,
        "task_id": state["task_id"],
        "attempt": index,
        "error_type": type(exc).__name__,
        "error": str(exc),
        "failed_at_utc": _utc_now(),
    }
    if not path.exists():
        _atomic_json(path, payload)


def _current_status(
    tasks: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    *,
    run_root: Path,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    grouped = _group_games(games)
    receipts: list[dict[str, Any]] = []
    missing: list[str] = []
    failed: list[str] = []
    gate_failed: list[str] = []
    for task in tasks:
        task_id = str(task["task_id"])
        task_directory = _task_directory(run_root, task_id)
        receipt_path = task_directory / "receipt.json"
        if not receipt_path.is_file():
            state_path = task_directory / "state.json"
            if state_path.is_file() and _read_json(state_path).get("status") == "failed":
                failed.append(task_id)
            else:
                missing.append(task_id)
            continue
        receipt = _read_json(receipt_path)
        _validate_task_receipt(
            task,
            grouped[task_id],
            receipt,
            metadata,
            task_directory=task_directory,
        )
        receipts.append(receipt)
        if receipt["gate_status"] != "passed":
            gate_failed.append(task_id)
    execution_complete = len(receipts) == EXPECTED_TASKS and not missing and not failed
    runner_gate_passed = execution_complete and not gate_failed
    return {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "formal_manifest_sha256": metadata["formal_manifest_sha256"],
        "formal_runner_sha256": metadata["formal_runner_sha256"],
        "verifier_sha256": metadata["verifier_sha256"],
        "execution_freeze_sha256": metadata["execution_freeze_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        **{
            field: copy.deepcopy(metadata[field])
            for field in THROUGHPUT_PROFILE_IDENTITY_FIELDS
        },
        "receipts_present": len(receipts),
        "complete_tasks": len(receipts),
        "missing_tasks": len(missing),
        "missing_preview": missing[:10],
        "execution_failed_tasks": len(failed),
        "execution_failed_preview": failed[:10],
        "gate_failed_tasks": len(gate_failed),
        "gate_failed_preview": gate_failed[:10],
        "execution_complete": execution_complete,
        "runner_gate_passed": runner_gate_passed,
        "independent_verification_required": True,
        "formal_ready": False,
        "formal_ready_reason": "independent_verification_not_part_of_execution_runner",
    }


def _execute_formal_tasks(
    tasks: Sequence[Mapping[str, Any]],
    grouped: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    run_root: Path,
    metadata: Mapping[str, Any],
    lane_executor: _ScalarLaneExecutor,
    continue_on_error: bool,
    authorize_resume: bool,
) -> None:
    for task in tasks:
        task_id = str(task["task_id"])
        task_directory = _task_directory(run_root, task_id)
        task_directory.mkdir(parents=True, exist_ok=True)
        receipt_path = task_directory / "receipt.json"
        if receipt_path.is_file():
            _validate_task_receipt(
                task,
                grouped[task_id],
                _read_json(receipt_path),
                metadata,
                task_directory=task_directory,
            )
            continue
        state_path = task_directory / "state.json"
        state = (
            _read_json(state_path)
            if state_path.is_file()
            else {"task_id": task_id, "attempts": 0}
        )
        _require(state.get("task_id") == task_id, "task state belongs to another task")
        previous_status = state.get("status")
        if state_path.is_file() and previous_status in {
            "failed",
            "running",
            "complete",
        }:
            _require(
                authorize_resume,
                f"{task_id}: state={previous_status!r} without a receipt; "
                "explicit --authorize-resume is required",
            )
        elif state_path.is_file():
            _require(
                previous_status in {None, "pending"},
                f"{task_id}: unsupported resumable state {previous_status!r}",
            )
        state.update(
            {
                "attempts": int(state.get("attempts", 0)) + 1,
                "status": "running",
                "started_at_utc": _utc_now(),
            }
        )
        _atomic_json(state_path, state, overwrite=True)
        try:
            _run_task(
                task,
                grouped[task_id],
                task_directory=task_directory,
                metadata=metadata,
                lane_executor=lane_executor,
            )
        except Exception as exc:
            state.update(
                {
                    "status": "failed",
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                    "failed_at_utc": _utc_now(),
                }
            )
            _atomic_json(state_path, state, overwrite=True)
            _write_failure(task_directory, state, exc)
            if not continue_on_error:
                raise
        else:
            state.update(
                {"status": "complete", "completed_at_utc": _utc_now()}
            )
            _atomic_json(state_path, state, overwrite=True)


def run_bundle(
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
    *,
    device: str,
    continue_on_error: bool,
    export_directory: Path | None,
    confirm_formal: bool,
    throughput_profile: Path | None = None,
    authorize_resume: bool = False,
    _writer_lock_held: bool = False,
) -> dict[str, Any]:
    _require(confirm_formal, "formal execution requires --confirm-formal")
    _require(str(device).startswith("cuda"), "formal execution requires an explicit CUDA device")
    _require(
        throughput_profile is not None,
        "formal execution requires --throughput-profile",
    )
    throughput_profile_path = Path(throughput_profile).resolve()
    manifest, tasks, games, _ = load_frozen_bundle(manifest_path, bundle_directory)
    validated_throughput_profile = _validate_throughput_profile(
        throughput_profile_path,
        manifest_path=manifest_path.resolve(),
        tasks=tasks,
    )
    run_root = _validate_write_target(
        manifest,
        run_root,
        environment_root="AUTODL_WORK_DIR",
        label="formal run root",
    )
    if run_root.exists():
        _require(run_root.is_dir(), "run root exists but is not a directory")
        if not (run_root / "execution_metadata.json").is_file():
            unexpected = [
                path
                for path in run_root.iterdir()
                if path.name
                not in {WRITER_LOCK_NAME, THROUGHPUT_PROFILE_ARTIFACT_NAME}
            ]
            _require(not unexpected, "refusing a nonempty unbound run root")
    else:
        run_root.mkdir(parents=True)
    if not _writer_lock_held:
        with _AdvisoryWriterLock(run_root / WRITER_LOCK_NAME):
            return run_bundle(
                manifest_path,
                bundle_directory,
                run_root,
                device=device,
                continue_on_error=continue_on_error,
                export_directory=export_directory,
                confirm_formal=confirm_formal,
                throughput_profile=throughput_profile_path,
                authorize_resume=authorize_resume,
                _writer_lock_held=True,
            )
    throughput_evidence_path = run_root / THROUGHPUT_PROFILE_ARTIFACT_NAME
    if throughput_evidence_path.is_file():
        _require(
            _read_json(throughput_evidence_path) == validated_throughput_profile,
            "persisted throughput profile differs from the validated smoke receipt",
        )
    else:
        _atomic_json(throughput_evidence_path, validated_throughput_profile)
    validated_throughput_profile = _validate_throughput_profile(
        throughput_evidence_path,
        manifest_path=manifest_path.resolve(),
        tasks=tasks,
    )
    metadata = _execution_metadata(
        manifest,
        manifest_path=manifest_path.resolve(),
        bundle_directory=bundle_directory.resolve(),
        run_root=run_root,
        device=device,
        throughput_profile_path=throughput_evidence_path,
        throughput_profile=validated_throughput_profile,
    )
    metadata_path = run_root / "execution_metadata.json"
    if metadata_path.is_file():
        _require(_read_json(metadata_path) == metadata, "run root belongs to another execution identity")
    else:
        _atomic_json(metadata_path, metadata)
    grouped = _group_games(games)
    with _ScalarLaneExecutor(
        SCALAR_LANE_COUNT,
        initializer=_initialize_formal_lane_worker,
        initargs=(copy.deepcopy(manifest), str(manifest_path.resolve()), device),
    ) as lane_executor:
        _execute_formal_tasks(
            tasks,
            grouped,
            run_root=run_root,
            metadata=metadata,
            lane_executor=lane_executor,
            continue_on_error=continue_on_error,
            authorize_resume=authorize_resume,
        )

    status = _current_status(tasks, games, run_root=run_root, metadata=metadata)
    if status["execution_complete"]:
        receipts = [
            _read_json(_task_directory(run_root, str(task["task_id"])) / "receipt.json")
            for task in tasks
        ]
        ledger_path = run_root / "result_receipts.jsonl"
        ledger_text = _jsonl_text(receipts)
        if ledger_path.is_file():
            _require(ledger_path.read_text(encoding="utf-8") == ledger_text, "result ledger changed")
        else:
            _atomic_text(ledger_path, ledger_text)
        ledger_sha256 = sha256_file(ledger_path)
        status["result_receipts_path"] = "result_receipts.jsonl"
        status["result_receipts_sha256"] = ledger_sha256
        canonical_records: list[dict[str, Any]] = []
        for task, receipt in zip(tasks, receipts):
            task_directory = _task_directory(run_root, str(task["task_id"]))
            games_path = _task_artifact_path(
                task_directory, receipt.get("games_path"), "games.jsonl"
            )
            canonical_records.extend(_read_jsonl(games_path))
        _require(
            len(canonical_records) == EXPECTED_GAMES,
            "canonical numeric input does not contain 5,760 games",
        )
        numeric = _runner_numeric_artifact(
            canonical_records,
            metadata=metadata,
            receipt_ledger_sha256=ledger_sha256,
        )
        numeric_path = run_root / "canonical_numeric.json"
        if numeric_path.is_file():
            _require(
                _read_json(numeric_path) == numeric,
                "immutable runner canonical numeric artifact changed",
            )
        else:
            _atomic_json(numeric_path, numeric)
        status["canonical_numeric_path"] = "canonical_numeric.json"
        status["canonical_numeric_sha256"] = sha256_file(numeric_path)
    status_path = run_root / "execution_summary.json"
    if status["execution_complete"] and status_path.is_file():
        existing_status = _read_json(status_path)
        if existing_status.get("execution_complete") is True:
            _require(existing_status == status, "immutable complete execution summary changed")
        else:
            _atomic_json(status_path, status, overwrite=True)
    else:
        _atomic_json(status_path, status, overwrite=not status["execution_complete"])
    if export_directory is not None:
        checked_export = _validate_write_target(
            manifest,
            export_directory,
            environment_root="AUTODL_EXPORT_DIR",
            label="formal export directory",
        )
        export_results(
            run_root,
            checked_export,
            expected_task_directory_names={
                _task_directory(run_root, str(task["task_id"])).name
                for task in tasks
            },
        )
    return status


def read_only_status(
    manifest_path: Path, bundle_directory: Path, run_root: Path
) -> dict[str, Any]:
    manifest, tasks, games, _ = load_frozen_bundle(manifest_path, bundle_directory)
    del manifest
    metadata_path = run_root.resolve() / "execution_metadata.json"
    _require(metadata_path.is_file(), "execution metadata is missing")
    metadata = _read_json(metadata_path)
    _require(metadata.get("run_root") == str(run_root.resolve()), "run-root metadata binding mismatch")
    _require(
        metadata.get("formal_manifest_sha256") == sha256_file(manifest_path.resolve()),
        "current formal manifest differs from run identity",
    )
    _require(
        metadata.get("preparation_runner_sha256") == sha256_file(prep.SCRIPT_PATH),
        "current preparation runner differs from run identity",
    )
    _require(metadata["formal_runner_sha256"] == sha256_file(SCRIPT_PATH), "current formal runner differs from run identity")
    _require(
        metadata.get("verifier_sha256") == sha256_file(VERIFIER_PATH),
        "current verifier differs from run identity",
    )
    _require(
        metadata.get("execution_freeze_sha256")
        == canonical_sha256(_execution_freeze_core(metadata)),
        "execution metadata freeze hash mismatch",
    )
    _require(metadata["execution_source_hashes"] == _execution_source_hashes(manifest_path.resolve()), "current source closure differs from run identity")
    for field, expected in _bundle_hashes(bundle_directory.resolve()).items():
        _require(metadata.get(field) == expected, f"current bundle differs from run identity: {field}")
    return _current_status(tasks, games, run_root=run_root.resolve(), metadata=metadata)


EXPORT_ROOT_FILES = frozenset(
    {
        Path("canonical_numeric.json"),
        Path("execution_metadata.json"),
        Path("execution_summary.json"),
        Path("result_receipts.jsonl"),
        Path(THROUGHPUT_PROFILE_ARTIFACT_NAME),
    }
)


def _is_attempt_artifact(relative: Path) -> bool:
    return (
        len(relative.parts) >= 3
        and relative.parts[0] == "tasks"
        and relative.parts[2] == "attempts"
    )


def _is_internal_run_artifact(relative: Path) -> bool:
    return (
        relative == Path(WRITER_LOCK_NAME)
        or (
            len(relative.parts) == 3
            and relative.parts[0] == "tasks"
            and relative.name == "state.json"
        )
        or _is_attempt_artifact(relative)
    )


def _ancestor_directories(paths: Iterable[Path]) -> set[Path]:
    directories: set[Path] = set()
    for path in paths:
        parent = path.parent
        while parent != Path("."):
            directories.add(parent)
            parent = parent.parent
    return directories


def _validate_export_path_set(
    relatives: set[Path], expected_task_directory_names: Iterable[str]
) -> set[Path]:
    root_files = {path for path in relatives if len(path.parts) == 1}
    _require(root_files == EXPORT_ROOT_FILES, "formal export root file set differs")
    task_names = set(expected_task_directory_names)
    _require(
        len(task_names) == EXPECTED_TASKS
        and all(name and Path(name).name == name for name in task_names),
        "frozen formal task directory set is invalid",
    )
    expected = set(EXPORT_ROOT_FILES)
    for task_name in task_names:
        task_root = Path("tasks") / task_name
        expected.update(
            {
                task_root / "games.jsonl",
                task_root / "receipt.json",
                task_root / "summary.json",
            }
        )
        expected.update(
            task_root / "pairs" / f"pair_{pair_index:04d}.json"
            for pair_index in range(EXPECTED_PAIRS_PER_TASK)
        )
    missing = sorted((path.as_posix() for path in expected - relatives))
    extra = sorted((path.as_posix() for path in relatives - expected))
    _require(
        not missing and not extra,
        "formal export file set differs: "
        f"missing={missing[:5]}, extra={extra[:5]}",
    )
    return expected


def _scan_export_destination(
    export_directory: Path,
    planned_rows: Mapping[Path, Mapping[str, Any]],
    *,
    require_complete: bool,
) -> int:
    if not export_directory.exists():
        return 0
    _require(
        export_directory.is_dir() and not export_directory.is_symlink(),
        "formal export destination is not a real directory",
    )
    expected_files = set(planned_rows)
    allowed_directories = _ancestor_directories(expected_files)
    observed_files: set[Path] = set()
    observed_directories: set[Path] = set()
    total_bytes = 0
    for path in sorted(export_directory.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(export_directory)
        _require(not path.is_symlink(), f"formal export destination contains a symlink: {relative}")
        if path.is_dir():
            observed_directories.add(relative)
            continue
        _require(path.is_file(), f"formal export destination contains a special file: {relative}")
        observed_files.add(relative)
        observed_bytes = path.stat().st_size
        total_bytes += observed_bytes
        if relative in planned_rows:
            row = planned_rows[relative]
            _require(
                observed_bytes == int(row["bytes"])
                and sha256_file(path) == str(row["sha256"]),
                f"formal export destination hash or size differs: {relative}",
            )
    _require(
        observed_files <= expected_files,
        "formal export destination contains stale or unknown files",
    )
    _require(
        observed_directories <= allowed_directories,
        "formal export destination contains stale or unknown directories",
    )
    if require_complete:
        _require(observed_files == expected_files, "formal export destination is incomplete")
        _require(total_bytes <= MAX_EXPORT_BYTES, "formal export destination exceeds its byte bound")
    return total_bytes


def _copy_verified(
    source: Path,
    destination: Path,
    *,
    expected_sha256: str,
    expected_bytes: int,
) -> None:
    _require(
        source.is_file()
        and not source.is_symlink()
        and source.stat().st_size == expected_bytes
        and sha256_file(source) == expected_sha256,
        f"formal export source changed after preflight: {source}",
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    _require(not destination.is_symlink(), f"formal export destination is a symlink: {destination}")
    if destination.exists():
        _require(
            destination.is_file()
            and destination.stat().st_size == expected_bytes
            and sha256_file(destination) == expected_sha256,
            f"export destination differs: {destination}",
        )
        return
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        _require(
            temporary.stat().st_size == expected_bytes
            and sha256_file(temporary) == expected_sha256,
            "export temporary copy hash or size mismatch",
        )
        _require(
            source.stat().st_size == expected_bytes
            and sha256_file(source) == expected_sha256,
            f"formal export source changed during copy: {source}",
        )
        _require(not destination.exists(), f"export destination appeared during copy: {destination}")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    _require(
        destination.stat().st_size == expected_bytes
        and sha256_file(destination) == expected_sha256,
        "export destination hash or size mismatch",
    )


def export_results(
    run_root: Path,
    export_directory: Path,
    *,
    expected_task_directory_names: Iterable[str],
) -> dict[str, Any]:
    _require(
        run_root.is_dir() and not run_root.is_symlink(),
        "formal run root is not a real directory",
    )
    planned: list[tuple[Path, Path, dict[str, Any]]] = []
    observed_directories: set[Path] = set()
    for source in sorted(run_root.rglob("*"), key=lambda path: path.as_posix()):
        relative = source.relative_to(run_root)
        _require(not source.is_symlink(), f"formal run contains a symlink: {relative}")
        if source.is_dir():
            observed_directories.add(relative)
            continue
        _require(source.is_file(), f"formal run contains a special file: {relative}")
        if _is_internal_run_artifact(relative):
            continue
        before_size = source.stat().st_size
        digest = sha256_file(source)
        _require(source.stat().st_size == before_size, f"formal export source changed during preflight: {source}")
        row = {
            "path": relative.as_posix(),
            "sha256": digest,
            "bytes": before_size,
        }
        planned.append((source, relative, row))
    expected_files = _validate_export_path_set(
        {relative for _, relative, _ in planned}, expected_task_directory_names
    )
    planned_rows = {relative: row for _, relative, row in planned}
    _require(
        len(planned_rows) == len(planned),
        "formal export planning contains duplicate paths",
    )
    allowed_source_directories = _ancestor_directories(expected_files)
    unknown_directories = {
        relative
        for relative in observed_directories
        if relative not in allowed_source_directories
        and not _is_attempt_artifact(relative)
    }
    _require(
        not unknown_directories,
        "formal run contains unknown directories: "
        + ", ".join(sorted(path.as_posix() for path in unknown_directories)[:5]),
    )
    payload_bytes = sum(int(row["bytes"]) for _, _, row in planned)
    payload_limit = MAX_EXPORT_BYTES - EXPORT_MANIFEST_RESERVE_BYTES
    _require(
        payload_limit >= 0 and payload_bytes <= payload_limit,
        "formal export exceeds the fail-closed byte bound: "
        f"payload={payload_bytes}, payload_limit={payload_limit}, "
        f"max_export_bytes={MAX_EXPORT_BYTES}",
    )
    copied = [copy.deepcopy(row) for _, _, row in planned]
    manifest_core = {
        "schema_name": "lifeline-d18-v3-export-manifest",
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "file_count": len(copied),
        "total_bytes": payload_bytes,
        "max_export_bytes": MAX_EXPORT_BYTES,
        "export_manifest_reserve_bytes": EXPORT_MANIFEST_RESERVE_BYTES,
        "projected_upper_bound_bytes": payload_bytes + EXPORT_MANIFEST_RESERVE_BYTES,
        "worker_run_metadata_reserve_bytes": WORKER_RUN_METADATA_RESERVE_BYTES,
        "policy_max_delivery_bytes": POLICY_MAX_DELIVERY_BYTES,
        "projected_worker_delivery_upper_bound_bytes": (
            payload_bytes
            + EXPORT_MANIFEST_RESERVE_BYTES
            + WORKER_RUN_METADATA_RESERVE_BYTES
        ),
        "files": copied,
    }
    manifest_payload = {**manifest_core, "created_at_utc": _utc_now()}
    manifest_bytes = len(pretty_json(manifest_payload).encode("utf-8"))
    _require(
        manifest_bytes <= EXPORT_MANIFEST_RESERVE_BYTES,
        "formal export manifest exceeds its reserved byte budget: "
        f"manifest={manifest_bytes}, reserve={EXPORT_MANIFEST_RESERVE_BYTES}",
    )
    if export_directory.exists():
        _require(
            export_directory.is_dir() and not export_directory.is_symlink(),
            "formal export destination is not a real directory",
        )
    manifest_path = export_directory / "export_manifest.json"
    if manifest_path.exists():
        _require(
            not manifest_path.is_symlink()
            and manifest_path.stat().st_size <= EXPORT_MANIFEST_RESERVE_BYTES,
            "existing export manifest exceeds its reserved byte budget",
        )
        manifest = _read_json(manifest_path)
        for field, expected in manifest_core.items():
            _require(manifest.get(field) == expected, "existing export manifest differs")
    else:
        manifest = manifest_payload
    if manifest_path.exists():
        manifest_row = {
            "sha256": sha256_file(manifest_path),
            "bytes": manifest_path.stat().st_size,
        }
    else:
        manifest_text = pretty_json(manifest)
        manifest_row = {
            "sha256": hashlib.sha256(manifest_text.encode("utf-8")).hexdigest(),
            "bytes": len(manifest_text.encode("utf-8")),
        }
    destination_rows = {
        **planned_rows,
        Path("export_manifest.json"): manifest_row,
    }
    _scan_export_destination(
        export_directory, destination_rows, require_complete=False
    )
    export_directory.mkdir(parents=True, exist_ok=True)
    for source, relative, row in planned:
        destination = export_directory / relative
        _copy_verified(
            source,
            destination,
            expected_sha256=str(row["sha256"]),
            expected_bytes=int(row["bytes"]),
        )
    if not manifest_path.exists():
        _atomic_json(manifest_path, manifest)
    _scan_export_destination(
        export_directory, destination_rows, require_complete=True
    )
    return manifest


def prepare_autodl_stage(
    manifest_path: Path,
    bundle_directory: Path,
    output: Path,
) -> dict[str, Any]:
    manifest, _, _, _ = load_frozen_bundle(manifest_path, bundle_directory)
    output = _validate_write_target(
        manifest,
        output,
        environment_root="AUTODL_WORK_DIR",
        label="AutoDL stage",
    )
    _require(not output.exists(), f"refusing existing AutoDL stage: {output}")
    sources = set(_execution_dependency_paths(manifest_path.resolve()))
    for name in ("bundle_summary.json", "game_manifest.jsonl", "manifest_snapshot.json", "tasks.jsonl"):
        sources.add(bundle_directory.resolve() / name)
    output.mkdir(parents=True)
    rows: list[dict[str, Any]] = []
    for source in sorted(sources, key=lambda path: _repo_relative(path)):
        relative = Path(_repo_relative(source))
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        _require(sha256_file(destination) == sha256_file(source), f"stage copy hash mismatch: {relative}")
        rows.append({"path": relative.as_posix(), "sha256": sha256_file(source), "bytes": source.stat().st_size})
    payload = {
        "schema_name": STAGE_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "prepared_not_run",
        "experiment_id": manifest["experiment_id"],
        "formal_manifest_sha256": sha256_file(manifest_path.resolve()),
        "formal_runner_sha256": sha256_file(SCRIPT_PATH),
        "preparation_runner_sha256": sha256_file(prep.SCRIPT_PATH),
        "verifier_sha256": sha256_file(VERIFIER_PATH),
        "dependency_lock_sha256": sha256_file(DEPENDENCY_LOCK_PATH),
        **_bundle_hashes(bundle_directory.resolve()),
        "semantic_bindings": _stage_semantic_bindings(
            manifest_path.resolve(), bundle_directory.resolve()
        ),
        "file_count": len(rows),
        "total_bytes": sum(int(row["bytes"]) for row in rows),
        "files": rows,
        "formal_games_executed": 0,
        "paid_actions": 0,
        "created_at_utc": _utc_now(),
    }
    stage_manifest = output / "autodl_stage_manifest.json"
    _atomic_json(stage_manifest, payload)
    stage_manifest_sha256 = sha256_file(stage_manifest)
    _validated_autodl_stage(
        output, expected_manifest_sha256=stage_manifest_sha256
    )
    return {
        **payload,
        "stage_manifest_path": str(stage_manifest),
        "stage_manifest_sha256": stage_manifest_sha256,
    }


def _safe_stage_relative_path(raw: Any) -> Path:
    _require(isinstance(raw, str) and bool(raw), "stage row path is invalid")
    _require("\\" not in raw and "\x00" not in raw, "stage row path is not canonical POSIX")
    pure = PurePosixPath(raw)
    _require(
        not pure.is_absolute()
        and pure.as_posix() == raw
        and all(part not in {"", ".", ".."} and ":" not in part for part in pure.parts),
        f"stage row path is unsafe: {raw!r}",
    )
    return Path(*pure.parts)


def _validated_autodl_stage(
    stage_directory: Path, *, expected_manifest_sha256: str | None = None
) -> tuple[dict[str, Any], str]:
    _require(
        stage_directory.is_dir() and not stage_directory.is_symlink(),
        "AutoDL stage is not a real directory",
    )
    stage_directory = stage_directory.resolve()
    manifest_path = stage_directory / "autodl_stage_manifest.json"
    _require(
        manifest_path.is_file() and not manifest_path.is_symlink(),
        "stage manifest is missing or is a symlink",
    )
    manifest_sha256 = sha256_file(manifest_path)
    if expected_manifest_sha256 is not None:
        _require(
            len(expected_manifest_sha256) == 64
            and all(character in "0123456789abcdef" for character in expected_manifest_sha256)
            and manifest_sha256 == expected_manifest_sha256,
            "stage manifest SHA-256 binding mismatch",
        )
    manifest = _read_json(manifest_path)
    _require(manifest.get("schema_name") == STAGE_SCHEMA, "stage schema mismatch")
    _require(manifest.get("schema_version") == SCHEMA_VERSION, "stage schema version mismatch")
    _require(manifest.get("status") == "prepared_not_run", "stage status is not review-only")
    _require(manifest.get("experiment_id") == EXPERIMENT_ID, "stage experiment ID mismatch")
    _require(manifest.get("formal_games_executed") == 0, "stage claims formal execution")
    _require(manifest.get("paid_actions") == 0, "stage claims a paid action")
    rows = manifest.get("files")
    _require(isinstance(rows, list) and bool(rows), "stage file rows are missing")
    planned: dict[Path, dict[str, Any]] = {}
    for raw_row in rows:
        _require(
            isinstance(raw_row, dict)
            and set(raw_row) == {"path", "sha256", "bytes"},
            "stage file row schema differs",
        )
        relative = _safe_stage_relative_path(raw_row["path"])
        _require(relative not in planned, f"duplicate stage file row: {relative}")
        digest = raw_row["sha256"]
        byte_count = raw_row["bytes"]
        _require(
            isinstance(digest, str)
            and len(digest) == 64
            and all(character in "0123456789abcdef" for character in digest),
            f"stage file digest is invalid: {relative}",
        )
        _require(
            type(byte_count) is int and byte_count >= 0,
            f"stage file byte count is invalid: {relative}",
        )
        planned[relative] = dict(raw_row)
    _require(
        manifest.get("file_count") == len(planned),
        "stage manifest file_count differs",
    )
    _require(
        manifest.get("total_bytes")
        == sum(int(row["bytes"]) for row in planned.values()),
        "stage manifest total_bytes differs",
    )
    for field in STAGE_SEMANTIC_HASH_FIELDS:
        digest = manifest.get(field)
        _require(
            isinstance(digest, str)
            and len(digest) == 64
            and all(character in "0123456789abcdef" for character in digest),
            f"stage manifest digest is invalid: {field}",
        )
    expected_files = set(planned) | {Path("autodl_stage_manifest.json")}
    expected_directories = _ancestor_directories(expected_files)
    observed_files: set[Path] = set()
    observed_directories: set[Path] = set()
    for path in sorted(stage_directory.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(stage_directory)
        _require(not path.is_symlink(), f"AutoDL stage contains a symlink: {relative}")
        if path.is_dir():
            observed_directories.add(relative)
            continue
        _require(path.is_file(), f"AutoDL stage contains a special file: {relative}")
        observed_files.add(relative)
    _require(observed_files == expected_files, "AutoDL stage file closure differs")
    _require(observed_directories == expected_directories, "AutoDL stage directory closure differs")
    for relative, row in planned.items():
        staged = stage_directory / relative
        _require(
            staged.stat().st_size == int(row["bytes"])
            and sha256_file(staged) == str(row["sha256"]),
            f"staged file differs: {relative}",
        )
    semantic_bindings = manifest.get("semantic_bindings")
    _require(
        isinstance(semantic_bindings, dict)
        and set(semantic_bindings) == set(STAGE_SEMANTIC_HASH_FIELDS),
        "stage semantic binding fields differ",
    )
    bound_paths: set[Path] = set()
    for field in STAGE_SEMANTIC_HASH_FIELDS:
        relative = _safe_stage_relative_path(semantic_bindings[field])
        _require(
            relative not in bound_paths,
            f"duplicate stage semantic binding path: {relative}",
        )
        bound_paths.add(relative)
        _require(
            relative in planned
            and planned[relative]["sha256"] == manifest[field],
            f"stage semantic binding differs: {field}",
        )
    return manifest, manifest_sha256


def validate_autodl_stage(
    stage_directory: Path, *, expected_manifest_sha256: str | None = None
) -> dict[str, Any]:
    manifest, manifest_sha256 = _validated_autodl_stage(
        stage_directory,
        expected_manifest_sha256=expected_manifest_sha256,
    )
    return {
        "schema_name": "lifeline-d18-v3-autodl-stage-validation",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "stage_manifest_sha256": manifest_sha256,
        "file_count": manifest["file_count"],
        "total_bytes": manifest["total_bytes"],
        "formal_games_executed": 0,
        "paid_actions": 0,
    }


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def _build_staged_readiness_command(
    *,
    local_python: Path,
    stage_directory: Path,
    manifest_path: Path,
    bundle_directory: Path,
    stage_manifest_sha256: str,
) -> str:
    # AutoDL Direct runs readiness with cwd=code_path.  Keep every stage path
    # relative to that immutable root so the Windows cmd.exe command contains
    # no quoted token.  Runner 1.15 passes the command through Popen(argv),
    # whose Windows list2cmdline handling turns embedded quotes into literal
    # \" characters before cmd.exe sees them.
    _require(stage_directory.is_absolute(), "readiness stage directory must be absolute")
    tokens = [
        local_python.resolve().as_posix(),
        "-B",
        Path(_repo_relative(SCRIPT_PATH)).as_posix(),
        "readiness",
        "--manifest",
        Path(_repo_relative(manifest_path.resolve())).as_posix(),
        "--bundle-dir",
        Path(_repo_relative(bundle_directory.resolve())).as_posix(),
        "--stage-dir",
        ".",
        "--expected-stage-manifest-sha256",
        stage_manifest_sha256,
    ]
    safe_characters = frozenset("_./:\\-")
    _require(
        all(
            token
            and all(character.isalnum() or character in safe_characters for character in token)
            for token in tokens
        ),
        "local readiness requires quote-free shell tokens",
    )
    return " ".join(tokens)


def generate_job(
    manifest_path: Path,
    bundle_directory: Path,
    stage_directory: Path,
    output: Path,
    *,
    local_python: Path,
    remote_python: str,
    max_runtime_seconds: int,
) -> dict[str, Any]:
    _require(
        60 <= max_runtime_seconds <= MAX_RUNTIME_SECONDS,
        "job runtime exceeds the 11,520-second budget gate",
    )
    manifest, _, _, _ = load_frozen_bundle(manifest_path, bundle_directory)
    stage_directory = stage_directory.resolve()
    output = output.resolve()
    _require(not output.exists(), f"refusing to overwrite job TOML: {output}")
    stage_manifest, stage_manifest_sha256 = _validated_autodl_stage(
        stage_directory
    )
    _require(
        stage_manifest.get("semantic_bindings")
        == _stage_semantic_bindings(
            manifest_path.resolve(), bundle_directory.resolve()
        ),
        "stage semantic paths differ from the requested local inputs",
    )
    _require_stage_matches_local_closure(
        stage_manifest, manifest_path.resolve(), bundle_directory.resolve()
    )
    _require(stage_manifest.get("formal_manifest_sha256") == sha256_file(manifest_path.resolve()), "stage manifest binding mismatch")
    _require(stage_manifest.get("formal_runner_sha256") == sha256_file(SCRIPT_PATH), "stage runner binding mismatch")
    _require(
        stage_manifest.get("preparation_runner_sha256") == sha256_file(prep.SCRIPT_PATH),
        "stage preparation-runner binding mismatch",
    )
    _require(
        stage_manifest.get("verifier_sha256") == sha256_file(VERIFIER_PATH),
        "stage verifier binding mismatch",
    )
    for field, expected in _bundle_hashes(bundle_directory.resolve()).items():
        _require(
            stage_manifest.get(field) == expected,
            f"stage bundle binding mismatch: {field}",
        )

    dependency_lock_relative = _repo_relative(DEPENDENCY_LOCK_PATH)
    dependency_lock_sha256 = sha256_file(DEPENDENCY_LOCK_PATH)
    staged_dependency_lock = stage_directory / dependency_lock_relative
    _require(
        staged_dependency_lock.is_file()
        and sha256_file(staged_dependency_lock) == dependency_lock_sha256,
        "staged dependency lock is missing or differs",
    )
    setup_revision = f"d18-v3-stage-{stage_manifest_sha256}"

    remote_manifest = Path(_repo_relative(manifest_path.resolve()))
    remote_runner = Path(_repo_relative(SCRIPT_PATH))
    remote_bundle = Path(_repo_relative(bundle_directory.resolve()))
    readiness_command = _build_staged_readiness_command(
        local_python=local_python,
        stage_directory=stage_directory,
        manifest_path=manifest_path,
        bundle_directory=bundle_directory,
        stage_manifest_sha256=stage_manifest_sha256,
    )
    smoke_command = (
        f"{remote_python} {remote_runner.as_posix()} gpu-smoke "
        f"--manifest {remote_manifest.as_posix()} "
        f"--bundle-dir {remote_bundle.as_posix()} --seconds 20 "
        "--profile-output $AUTODL_WORK_DIR/d18_v3_gpu_throughput.json"
    )
    formal_command = (
        f"{remote_python} {remote_runner.as_posix()} run "
        f"--manifest {remote_manifest.as_posix()} "
        f"--bundle-dir {remote_bundle.as_posix()} "
        f"--run-root $AUTODL_WORK_DIR/d18_v3/{EXPERIMENT_ID}/formal_run "
        "--throughput-profile $AUTODL_WORK_DIR/d18_v3_gpu_throughput.json "
        "--device cuda "
        f"--export-dir $AUTODL_EXPORT_DIR/d18_v3/{EXPERIMENT_ID} --confirm-formal"
    )
    setup_command = (
        f"{remote_python} -B {remote_runner.as_posix()} validate-autodl-stage "
        f"--stage-dir . --expected-manifest-sha256 {stage_manifest_sha256}"
    )
    environment_probe_command = (
        'python3 -c "import sys, torch; '
        'assert sys.version_info[:2] == (3, 12); '
        'assert torch.__version__.split(\'+\', 1)[0] == \'2.8.0\'; '
        'assert torch.version.cuda == \'12.8\'; '
        'assert torch.cuda.is_available()"'
    )
    content = "\n".join(
        [
            'name = "lifeline-d18-v3-formal-v1"',
            "",
            f"image_uuid = {_toml_string(IMAGE_UUID)}",
            'framework = "pytorch"',
            'framework_version = "2.8.0"',
            'cuda_runtime = "12.8"',
            'python_version = "3.12"',
            f"dependency_lock = {_toml_string(dependency_lock_relative)}",
            f"setup_revision = {_toml_string(setup_revision)}",
            'selection_strategy = "ordered"',
            'instance_reuse = "require"',
            f"preferred_instance_uuid = {_toml_string(INSTANCE_UUID)}",
            'accelerator = "cuda"',
            "gpu_num = 1",
            "min_cpu_cores = 24",
            "min_ram_gb = 64",
            "min_vram_gb = 32",
            "cuda_v_from = 128",
            f"allowed_gpu_specs = [{_toml_string(GPU_SPEC)}]",
            "min_gpu_utilization_percent = 50",
            f"max_runtime_seconds = {max_runtime_seconds}",
            "",
            f"code_path = {_toml_string(str(stage_directory))}",
            "input_paths = []",
            f"setup_command = {_toml_string(setup_command)}",
            f"environment_probe_command = {_toml_string(environment_probe_command)}",
            "",
            f"readiness_command = {_toml_string(readiness_command)}",
            "readiness_timeout_seconds = 600",
            f"gpu_smoke_command = {_toml_string(smoke_command)}",
            "gpu_smoke_timeout_seconds = 240",
            f"command = {_toml_string(formal_command)}",
            "",
            "[environment]",
            f"D18_V3_STAGE_MANIFEST_SHA256 = {_toml_string(stage_manifest_sha256)}",
            'PYTHONUNBUFFERED = "1"',
            'OMP_NUM_THREADS = "2"',
            'MKL_NUM_THREADS = "2"',
            "",
        ]
    )
    _atomic_text(output, content)
    return {
        "status": "job_generated_not_run",
        "path": str(output),
        "sha256": sha256_file(output),
        "instance_reuse": "require",
        "preferred_instance_uuid": INSTANCE_UUID,
        "allowed_gpu_specs": [GPU_SPEC],
        "image_uuid": IMAGE_UUID,
        "dependency_lock": dependency_lock_relative,
        "dependency_lock_sha256": dependency_lock_sha256,
        "stage_manifest_sha256": stage_manifest_sha256,
        "setup_revision": setup_revision,
        "min_gpu_utilization_percent": 50,
        "max_runtime_seconds": max_runtime_seconds,
        "readiness_command": readiness_command,
        "gpu_smoke_command": smoke_command,
        "formal_command": formal_command,
        "policy_path": str(DEFAULT_POLICY.resolve()),
        "paid_actions": 0,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate")
    validate.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    validate.add_argument("--bundle-dir", type=Path, required=True)

    validate_stage = commands.add_parser("validate-autodl-stage")
    validate_stage.add_argument("--stage-dir", type=Path, required=True)
    validate_stage.add_argument("--expected-manifest-sha256")

    readiness = commands.add_parser("readiness")
    readiness.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    readiness.add_argument("--bundle-dir", type=Path, required=True)
    readiness.add_argument("--stage-dir", type=Path, required=True)
    readiness.add_argument("--expected-stage-manifest-sha256", required=True)

    smoke = commands.add_parser("gpu-smoke")
    smoke.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    smoke.add_argument("--bundle-dir", type=Path, required=True)
    smoke.add_argument("--seconds", type=float, default=20.0)
    smoke.add_argument("--profile-output", type=Path)

    run = commands.add_parser("run")
    run.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    run.add_argument("--bundle-dir", type=Path, required=True)
    run.add_argument("--run-root", type=Path, required=True)
    run.add_argument("--throughput-profile", type=Path, required=True)
    run.add_argument("--device", default="cuda")
    run.add_argument("--continue-on-error", action="store_true")
    run.add_argument("--authorize-resume", action="store_true")
    run.add_argument("--export-dir", type=Path)
    run.add_argument("--confirm-formal", action="store_true")

    status = commands.add_parser("status")
    status.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    status.add_argument("--bundle-dir", type=Path, required=True)
    status.add_argument("--run-root", type=Path, required=True)

    stage = commands.add_parser("prepare-autodl-stage")
    stage.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    stage.add_argument("--bundle-dir", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)

    job = commands.add_parser("generate-job")
    job.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    job.add_argument("--bundle-dir", type=Path, required=True)
    job.add_argument("--stage-dir", type=Path, required=True)
    job.add_argument("--output", type=Path, required=True)
    job.add_argument("--local-python", type=Path, default=Path(sys.executable))
    job.add_argument("--remote-python", default="python3")
    job.add_argument("--max-runtime-seconds", type=int, default=MAX_RUNTIME_SECONDS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "validate":
            payload = validate_contract(args.manifest, args.bundle_dir)
        elif args.command == "validate-autodl-stage":
            payload = validate_autodl_stage(
                args.stage_dir,
                expected_manifest_sha256=args.expected_manifest_sha256,
            )
        elif args.command == "readiness":
            stage_validation = validate_autodl_stage(
                args.stage_dir,
                expected_manifest_sha256=args.expected_stage_manifest_sha256,
            )
            payload = task_shaped_readiness(args.manifest, args.bundle_dir)
            payload["stage_manifest_sha256"] = stage_validation[
                "stage_manifest_sha256"
            ]
        elif args.command == "gpu-smoke":
            payload = gpu_smoke(
                args.manifest,
                args.bundle_dir,
                seconds=args.seconds,
                profile_output=args.profile_output,
            )
        elif args.command == "run":
            payload = run_bundle(
                args.manifest,
                args.bundle_dir,
                args.run_root,
                device=args.device,
                continue_on_error=args.continue_on_error,
                export_directory=args.export_dir,
                confirm_formal=args.confirm_formal,
                throughput_profile=args.throughput_profile,
                authorize_resume=args.authorize_resume,
            )
        elif args.command == "status":
            payload = read_only_status(args.manifest, args.bundle_dir, args.run_root)
        elif args.command == "prepare-autodl-stage":
            payload = prepare_autodl_stage(args.manifest, args.bundle_dir, args.output)
        elif args.command == "generate-job":
            payload = generate_job(
                args.manifest,
                args.bundle_dir,
                args.stage_dir,
                args.output,
                local_python=args.local_python,
                remote_python=args.remote_python,
                max_runtime_seconds=args.max_runtime_seconds,
            )
        else:  # pragma: no cover
            raise FormalExecutionError(f"unsupported command: {args.command}")
    except (FormalExecutionError, prep.PreparationError, legacy.ProtocolError) as exc:
        print(canonical_json({"status": "FAIL_CLOSED", "error": str(exc)}))
        return 2
    print(pretty_json(payload), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
