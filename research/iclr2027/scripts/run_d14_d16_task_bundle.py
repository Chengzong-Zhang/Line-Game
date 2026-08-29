#!/usr/bin/env python3
"""Resumable sequential executor for D14--D16 task bundles.

Formal execution requires an explicit ``--confirm-formal`` switch.  Dry runs
are read-only.  Every attempted task owns an atomic receipt; completed tasks
are skipped on restart, while failed tasks remain visible and require an
explicit ``--retry-failed`` to run again.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import platform
import re
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:  # direct script execution
    from d14_d16_experiments import (  # type: ignore
        RESULT_SCHEMA_NAME,
        SCHEMA_VERSION,
        ProtocolError,
        _validate_evaluation_result,
        _validate_training_result,
        canonical_agent_binding,
        canonical_json,
        generate_tasks,
        load_jsonl,
        load_manifest,
        manifest_hash,
        validate_checkpoint_artifact,
        validate_action_diagnostics,
        validate_result_ledger,
    )
except ModuleNotFoundError:  # import as scripts.run_d14_d16_task_bundle in tests
    from scripts.d14_d16_experiments import (  # type: ignore
        RESULT_SCHEMA_NAME,
        SCHEMA_VERSION,
        ProtocolError,
        _validate_evaluation_result,
        _validate_training_result,
        canonical_agent_binding,
        canonical_json,
        generate_tasks,
        load_jsonl,
        load_manifest,
        manifest_hash,
        validate_checkpoint_artifact,
        validate_action_diagnostics,
        validate_result_ledger,
    )


EXECUTION_SCHEMA_NAME = "lifeline-d14-d16-execution"
EXECUTION_SCHEMA_VERSION = 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    _atomic_text(
        path,
        json.dumps(
            payload,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n",
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError(f"JSON artifact must be an object: {path}")
    return payload


def _mapping_or_protocol(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{label} must be a JSON object")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug[:160] or "task"


def _configure_deterministic_runtime(device: str) -> None:
    """Make crash replay deterministic or fail loudly on unsupported CUDA ops."""

    cuda_requested = str(device).lower().startswith("cuda")
    if cuda_requested:
        accepted_cublas = {":4096:8", ":16:8"}
        configured_cublas = os.environ.get("CUBLAS_WORKSPACE_CONFIG")
        if configured_cublas is None:
            os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
        elif configured_cublas not in accepted_cublas:
            raise ProtocolError(
                "CUBLAS_WORKSPACE_CONFIG must be :4096:8 or :16:8 before CUDA initialization"
            )
    import torch

    resolved = torch.device(device)
    if resolved.type == "cuda" and not torch.cuda.is_available():
        raise ProtocolError(f"requested CUDA device is unavailable: {device}")
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.allow_tf32 = False
    if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
        torch.backends.cuda.matmul.allow_tf32 = False


def _task_directory(run_root: Path, task_id: str) -> Path:
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return run_root / "tasks" / f"{_slug(task_id)}__{digest}"


def load_task_bundle(
    manifest: Mapping[str, Any], bundle_directory: str | Path
) -> dict[str, list[dict[str, Any]]]:
    """Load a task bundle and prove it is the exact deterministic expansion."""

    bundle = Path(bundle_directory)
    snapshot_path = bundle / "manifest_snapshot.json"
    training_path = bundle / "training_tasks.jsonl"
    evaluation_path = bundle / "evaluation_tasks.jsonl"
    for path in (snapshot_path, training_path, evaluation_path):
        if not path.is_file():
            raise ProtocolError(f"task bundle artifact is missing: {path}")
    snapshot = _read_json(snapshot_path)
    if canonical_json(snapshot) != canonical_json(manifest):
        raise ProtocolError("task bundle manifest_snapshot.json differs from manifest")
    observed = {
        "training": load_jsonl(training_path),
        "evaluation": load_jsonl(evaluation_path),
    }
    expected = generate_tasks(manifest)
    for kind in ("training", "evaluation"):
        if canonical_json({"tasks": observed[kind]}) != canonical_json(
            {"tasks": expected[kind]}
        ):
            raise ProtocolError(f"task bundle {kind}_tasks.jsonl was modified or reordered")
    return observed


def build_training_config(task: Mapping[str, Any]):
    """Translate one frozen task into the trainer's versioned config."""

    from lifeline_rl.alphazero.config import AlphaZeroConfig
    from lifeline_rl.alphazero.network import observation_mode_for_model

    budget = task["training_budget"]
    model_config = task["model_config"]
    config = AlphaZeroConfig(
        seed=int(task["seed"]),
        observation_mode=observation_mode_for_model(str(task["representation"])),
        model_kind=str(task["representation"]),
        board_sizes=tuple(int(size) for size in task["board_sizes"]),
        iterations=int(budget["iterations"]),
        games_per_iteration=int(budget["games_per_iteration"]),
        puct_simulations=int(budget["puct_simulations"]),
        c_puct=float(budget["c_puct"]),
        dirichlet_alpha=float(budget["dirichlet_alpha"]),
        dirichlet_epsilon=float(budget["dirichlet_epsilon"]),
        max_plies=int(budget["max_plies"]),
        temperature_moves=int(budget["temperature_moves"]),
        initial_temperature=float(budget["initial_temperature"]),
        final_temperature=float(budget["final_temperature"]),
        replay_capacity=int(budget["replay_capacity"]),
        batch_size=int(budget["batch_size"]),
        training_steps_per_iteration=int(budget["training_steps_per_iteration"]),
        learning_rate=float(budget["learning_rate"]),
        weight_decay=float(budget["weight_decay"]),
        gradient_clip_norm=float(budget["gradient_clip_norm"]),
        hidden_channels=int(model_config["hidden_channels"]),
        message_passing_layers=int(model_config["message_passing_layers"]),
        checkpoint_every=int(budget["checkpoint_every_iterations"]),
        superko_mode=str(budget["superko_mode"]),
    )
    if config.iterations * config.games_per_iteration != budget["self_play_games"]:
        raise ProtocolError(f"{task['task_id']}: training game schedule mismatch")
    if config.iterations * config.training_steps_per_iteration != budget["gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: gradient schedule mismatch")
    return config


def _result_header(task: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema_name": RESULT_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": task["experiment_id"],
        "manifest_sha256": task["manifest_sha256"],
        "evidence_tier": task["evidence_tier"],
        "task_id": task["task_id"],
        "result_kind": task["task_kind"],
    }


def _failed_receipt(task: Mapping[str, Any], exc: BaseException) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        **_result_header(task),
        "status": "failed",
        "failed_at_utc": _utc_now(),
        "failure_reason": f"{type(exc).__name__}: {exc}",
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
    if task["task_kind"] == "training":
        receipt.update(
            {
                "representation": task["representation"],
                "board_sizes": task["board_sizes"],
                "seed": task["seed"],
                "parameter_count": task["expected_trainable_parameters"],
            }
        )
    else:
        receipt.update(
            {
                "train_sizes": task["train_sizes"],
                "eval_size": task["eval_size"],
                "seed": task["seed"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
            }
        )
    return receipt


def _load_state(path: Path, task: Mapping[str, Any]) -> dict[str, Any]:
    if not path.is_file():
        return {
            "schema_name": EXECUTION_SCHEMA_NAME,
            "schema_version": EXECUTION_SCHEMA_VERSION,
            "task_id": task["task_id"],
            "manifest_sha256": task["manifest_sha256"],
            "attempts": 0,
            "status": "pending",
            "latest_checkpoint_directory": None,
            "wall_clock_seconds": 0.0,
            "checkpoint_artifacts": [],
        }
    state = _read_json(path)
    if (
        state.get("schema_name") != EXECUTION_SCHEMA_NAME
        or state.get("schema_version") != EXECUTION_SCHEMA_VERSION
        or state.get("task_id") != task["task_id"]
        or state.get("manifest_sha256") != task["manifest_sha256"]
    ):
        raise ProtocolError(f"task state is incompatible: {path}")
    return state


def _checkpoint_metrics(metrics_path: Path) -> dict[int, Mapping[str, Any]]:
    rows = load_jsonl(metrics_path)
    result: dict[int, Mapping[str, Any]] = {}
    for row in rows:
        counters = row.get("counters")
        if not isinstance(counters, Mapping):
            raise ProtocolError(f"training metric lacks counters: {metrics_path}")
        step = counters.get("gradient_steps")
        if isinstance(step, bool) or not isinstance(step, int) or step < 0:
            raise ProtocolError(f"training metric has invalid gradient_steps: {metrics_path}")
        if step in result and result[step] != row:
            raise ProtocolError(f"duplicate non-identical metric at gradient step {step}")
        result[step] = row
    return result


def _checkpoint_payload_counters(path: Path) -> dict[str, int]:
    import torch

    try:
        try:
            payload = torch.load(path, map_location="cpu", weights_only=False)
        except TypeError:
            payload = torch.load(path, map_location="cpu")
    except Exception as exc:
        raise ProtocolError(f"cannot inspect checkpoint payload: {path}") from exc
    counters = payload.get("counters") if isinstance(payload, Mapping) else None
    if not isinstance(counters, Mapping):
        raise ProtocolError(f"checkpoint payload counters are missing: {path}")
    return {str(key): int(value) for key, value in counters.items()}


def _recover_partial_snapshot_manifest(
    task: Mapping[str, Any], snapshot_directory: Path
) -> None:
    """Recover the atomic-save gap where the checkpoint exists before latest.json."""

    latest_path = snapshot_directory / "latest.json"
    if latest_path.is_file():
        return
    match = re.fullmatch(r"gradient_(\d{6})", snapshot_directory.name)
    if match is None:
        raise ProtocolError(f"invalid snapshot directory name: {snapshot_directory}")
    step = int(match.group(1))
    updates = int(task["training_budget"]["training_steps_per_iteration"])
    if step % updates:
        raise ProtocolError(f"{task['task_id']}: partial snapshot step is off schedule")
    iteration = step // updates
    checkpoint_path = snapshot_directory / f"checkpoint_{iteration:06d}.pt"
    if not checkpoint_path.is_file():
        raise ProtocolError(
            f"{task['task_id']}: partial snapshot has neither latest.json nor its checkpoint"
        )
    import torch

    try:
        try:
            payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        except TypeError:
            payload = torch.load(checkpoint_path, map_location="cpu")
    except Exception as exc:
        raise ProtocolError(
            f"{task['task_id']}: partial checkpoint cannot be deserialized"
        ) from exc
    if not isinstance(payload, Mapping):
        raise ProtocolError(f"{task['task_id']}: partial checkpoint payload is invalid")
    created_at = payload.get("created_at_utc")
    config_hash = payload.get("config_hash")
    source_hash = payload.get("source_hash")
    if (
        not isinstance(created_at, str)
        or not isinstance(config_hash, str)
        or not isinstance(source_hash, str)
    ):
        raise ProtocolError(f"{task['task_id']}: partial checkpoint provenance is missing")
    _atomic_json(
        latest_path,
        {
            "schema": {"name": "lifeline-alphazero-latest", "version": 1},
            "checkpoint": checkpoint_path.name,
            "checkpoint_schema_version": 1,
            "sha256": _sha256_file(checkpoint_path),
            "size_bytes": checkpoint_path.stat().st_size,
            "created_at_utc": created_at,
            "config_hash": config_hash,
            "source_hash": source_hash,
        },
    )


def _snapshot_artifact(
    task: Mapping[str, Any], snapshot_directory: Path, *, wall_clock_seconds: float
) -> dict[str, Any]:
    _recover_partial_snapshot_manifest(task, snapshot_directory)
    latest = _read_json(snapshot_directory / "latest.json")
    checkpoint_name = latest.get("checkpoint")
    if not isinstance(checkpoint_name, str) or Path(checkpoint_name).name != checkpoint_name:
        raise ProtocolError(f"invalid checkpoint manifest in {snapshot_directory}")
    checkpoint_path = snapshot_directory / checkpoint_name
    match = re.fullmatch(r"gradient_(\d{6})", snapshot_directory.name)
    if match is None:
        raise ProtocolError(f"invalid snapshot directory name: {snapshot_directory}")
    artifact = {
        "gradient_steps": int(match.group(1)),
        "iteration": None,
        "checkpoint_directory": str(snapshot_directory.resolve()),
        "checkpoint_path": str(checkpoint_path.resolve()),
        "checkpoint_sha256": latest.get("sha256"),
        "checkpoint_size_bytes": latest.get("size_bytes"),
        "config_hash": latest.get("config_hash"),
        "source_hash": latest.get("source_hash"),
        "created_at_utc": latest.get("created_at_utc"),
        "payload_counters": _checkpoint_payload_counters(checkpoint_path),
        "wall_clock_seconds": float(wall_clock_seconds),
    }
    artifact["iteration"] = artifact["payload_counters"]["iteration"]
    validate_checkpoint_artifact(task, artifact)
    return artifact


def _discover_snapshot_artifacts(
    task: Mapping[str, Any],
    run_directory: Path,
    state: Mapping[str, Any],
) -> list[dict[str, Any]]:
    snapshots_root = run_directory / "snapshots"
    if not snapshots_root.exists():
        return []
    if not snapshots_root.is_dir():
        raise ProtocolError(f"snapshot root is not a directory: {snapshots_root}")
    state_by_step = {
        int(item["gradient_steps"]): item
        for item in state.get("checkpoint_artifacts", [])
    }
    elapsed = float(state.get("wall_clock_seconds", 0.0))
    discovered: list[dict[str, Any]] = []
    for directory in sorted(snapshots_root.iterdir()):
        if not directory.is_dir():
            raise ProtocolError(f"unexpected file in snapshot root: {directory}")
        match = re.fullmatch(r"gradient_(\d{6})", directory.name)
        if match is None:
            raise ProtocolError(f"unexpected snapshot directory: {directory}")
        step = int(match.group(1))
        prior = state_by_step.get(step)
        if prior is not None and prior.get("wall_clock_seconds") is not None:
            wall_clock = float(prior["wall_clock_seconds"])
        else:
            attempt_started = state.get(
                "interrupted_attempt_started_at_utc",
                state.get("attempt_started_at_utc"),
            )
            attempt_base = float(
                state.get(
                    "interrupted_wall_clock_at_attempt_start",
                    state.get("wall_clock_at_attempt_start", elapsed),
                )
            )
            latest = _read_json(directory / "latest.json")
            created = latest.get("created_at_utc")
            wall_clock = elapsed
            if isinstance(attempt_started, str) and isinstance(created, str):
                try:
                    start_time = datetime.fromisoformat(
                        attempt_started.replace("Z", "+00:00")
                    )
                    created_time = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    wall_clock = attempt_base + max(
                        0.0, (created_time - start_time).total_seconds()
                    )
                except ValueError:
                    wall_clock = elapsed
        discovered.append(
            _snapshot_artifact(task, directory, wall_clock_seconds=wall_clock)
        )
    steps = [item["gradient_steps"] for item in discovered]
    required = list(task["required_checkpoint_gradient_steps"])
    if steps != required[: len(steps)]:
        raise ProtocolError(
            f"{task['task_id']}: snapshots are not a scheduled prefix: {steps}"
        )
    return discovered


def run_training_task(
    task: Mapping[str, Any], task_directory: Path, *, device: str
) -> dict[str, Any]:
    """Run or strictly resume one mixed-size training task."""

    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    config = build_training_config(task)
    run_directory = task_directory / "training_run"
    run_directory.mkdir(parents=True, exist_ok=True)
    resolved_config_path = run_directory / "resolved_config.json"
    config_payload = config.to_dict()
    if resolved_config_path.is_file():
        if _read_json(resolved_config_path) != config_payload:
            raise ProtocolError(f"{task['task_id']}: resolved config changed across resume")
    else:
        _atomic_json(resolved_config_path, config_payload)

    state_path = task_directory / "state.json"
    state = _load_state(state_path, task)
    discovered = _discover_snapshot_artifacts(task, run_directory, state)
    if discovered:
        accounted_wall_clock = max(
            float(state.get("wall_clock_seconds", 0.0)),
            float(discovered[-1]["wall_clock_seconds"]),
        )
        state["checkpoint_artifacts"] = discovered
        state["latest_checkpoint_directory"] = discovered[-1][
            "checkpoint_directory"
        ]
        state["counters"] = discovered[-1]["payload_counters"]
        state["wall_clock_seconds"] = accounted_wall_clock
        state["orphan_snapshots_adopted"] = [
            item["gradient_steps"] for item in discovered
        ]
        _atomic_json(state_path, state)
    started = time.perf_counter()
    elapsed_before = float(state.get("wall_clock_seconds", 0.0))
    trainer = AlphaZeroTrainer(config, run_directory, device=device)
    latest = state.get("latest_checkpoint_directory")
    if latest is not None:
        latest_path = Path(str(latest))
        if not latest_path.is_dir():
            raise ProtocolError(f"{task['task_id']}: latest checkpoint directory is missing")
        trainer.resume(latest_path, strict_source=True)

    budget = task["training_budget"]
    expected_updates = int(budget["training_steps_per_iteration"])
    checkpoint_every = int(budget["checkpoint_every_iterations"])
    checkpoint_artifacts = list(state.get("checkpoint_artifacts", []))
    while trainer.counters.iteration < config.iterations:
        prior_games = trainer.counters.games_attempted
        prior_steps = trainer.counters.gradient_steps
        metrics = trainer.run_iteration()
        if trainer.counters.games_attempted - prior_games != config.games_per_iteration:
            raise ProtocolError(f"{task['task_id']}: trainer violated games_per_iteration")
        if int(metrics["games_truncated"]) != 0:
            raise ProtocolError(f"{task['task_id']}: self-play produced a truncated game")
        if trainer.counters.gradient_steps - prior_steps != expected_updates:
            raise ProtocolError(
                f"{task['task_id']}: scheduled {expected_updates} updates but trainer "
                f"performed {trainer.counters.gradient_steps - prior_steps}; replay warmup "
                "must not silently reduce the formal gradient budget"
            )
        state.update(
            {
                "status": "running",
                "wall_clock_seconds": elapsed_before + (time.perf_counter() - started),
                "counters": trainer.counters.to_dict(),
                "updated_at_utc": _utc_now(),
            }
        )
        _atomic_json(state_path, state)
        if trainer.counters.iteration % checkpoint_every == 0:
            gradient_step = trainer.counters.gradient_steps
            snapshot_directory = run_directory / "snapshots" / f"gradient_{gradient_step:06d}"
            checkpoint_path = snapshot_directory / f"checkpoint_{trainer.counters.iteration:06d}.pt"
            trainer.save(checkpoint_path)
            artifact = _snapshot_artifact(
                task,
                snapshot_directory,
                wall_clock_seconds=elapsed_before + (time.perf_counter() - started),
            )
            checkpoint_artifacts = [
                item
                for item in checkpoint_artifacts
                if int(item["gradient_steps"]) != gradient_step
            ]
            checkpoint_artifacts.append(artifact)
            checkpoint_artifacts.sort(key=lambda item: int(item["gradient_steps"]))
            state.update(
                {
                    "status": "running",
                    "latest_checkpoint_directory": str(snapshot_directory.resolve()),
                    "wall_clock_seconds": elapsed_before + (time.perf_counter() - started),
                    "checkpoint_artifacts": checkpoint_artifacts,
                    "counters": trainer.counters.to_dict(),
                    "updated_at_utc": _utc_now(),
                }
            )
            _atomic_json(state_path, state)

    counters = trainer.counters.to_dict()
    if counters["games_completed"] != int(budget["self_play_games"]):
        raise ProtocolError(f"{task['task_id']}: completed self-play game budget mismatch")
    if counters["games_truncated"] != 0:
        raise ProtocolError(f"{task['task_id']}: formal training contains truncations")
    if counters["gradient_steps"] != int(budget["gradient_steps"]):
        raise ProtocolError(f"{task['task_id']}: completed gradient budget mismatch")
    required_steps = list(task["required_checkpoint_gradient_steps"])
    observed_steps = [int(item["gradient_steps"]) for item in checkpoint_artifacts]
    if observed_steps != required_steps:
        raise ProtocolError(
            f"{task['task_id']}: checkpoint mapping mismatch: {observed_steps} != {required_steps}"
        )

    metrics_by_step = _checkpoint_metrics(run_directory / "metrics.jsonl")
    final_elapsed = elapsed_before + (time.perf_counter() - started)
    artifacts_by_step = {
        int(item["gradient_steps"]): item for item in checkpoint_artifacts
    }
    curve_snapshots: list[dict[str, Any]] = []
    for step in required_steps:
        metric = metrics_by_step.get(step)
        if metric is None:
            raise ProtocolError(f"{task['task_id']}: metric snapshot missing at step {step}")
        metric_counters = metric["counters"]
        curve_snapshots.append(
            {
                "gradient_steps": step,
                "self_play_games": int(metric_counters["games_completed"]),
                "environment_steps": int(metric_counters["environment_steps"]),
                "loss": metric.get("loss"),
                "policy_loss": metric.get("policy_loss"),
                "value_loss": metric.get("value_loss"),
                "wall_clock_seconds": float(
                    artifacts_by_step[step]["wall_clock_seconds"]
                ),
            }
        )
    receipt = {
        **_result_header(task),
        "status": "complete",
        "completed_at_utc": _utc_now(),
        "representation": task["representation"],
        "board_sizes": task["board_sizes"],
        "seed": task["seed"],
        "parameter_count": trainer.model.parameter_count,
        "training_budget": task["training_budget"],
        "puct_simulations": config.puct_simulations,
        "self_play_games_completed": counters["games_completed"],
        "gradient_steps_completed": counters["gradient_steps"],
        "environment_steps_completed": counters["environment_steps"],
        "checkpoint_gradient_steps": required_steps,
        "curve_snapshots": curve_snapshots,
        "checkpoint_artifacts": checkpoint_artifacts,
        "resolved_config_path": str(resolved_config_path.resolve()),
        "resolved_config_sha256": _sha256_file(resolved_config_path),
        "metrics_path": str((run_directory / "metrics.jsonl").resolve()),
        "metrics_sha256": _sha256_file(run_directory / "metrics.jsonl"),
        "games_log_path": str((run_directory / "self_play_games.jsonl").resolve()),
        "games_log_sha256": _sha256_file(run_directory / "self_play_games.jsonl"),
        "wall_clock_seconds": final_elapsed,
        "device": str(trainer.device),
    }
    state.update(
        {
            "status": "complete",
            "wall_clock_seconds": final_elapsed,
            "counters": counters,
            "checkpoint_artifacts": checkpoint_artifacts,
            "completed_at_utc": receipt["completed_at_utc"],
        }
    )
    _atomic_json(state_path, state)
    return receipt


def _training_task_map(tasks: Mapping[str, Sequence[Mapping[str, Any]]]) -> dict[str, Mapping[str, Any]]:
    return {task["task_id"]: task for task in tasks["training"]}


def _load_training_receipt(
    run_root: Path,
    training_task_id: str,
    training_tasks: Mapping[str, Mapping[str, Any]],
) -> tuple[Mapping[str, Any], Path]:
    if training_task_id not in training_tasks:
        raise ProtocolError(f"evaluation references unknown training task {training_task_id}")
    training_task = training_tasks[training_task_id]
    directory = _task_directory(run_root, training_task_id)
    receipt_path = directory / "receipt.json"
    if not receipt_path.is_file():
        raise ProtocolError(f"training receipt is missing for {training_task_id}")
    receipt = _read_json(receipt_path)
    if receipt.get("status") != "complete":
        raise ProtocolError(f"training task is not complete: {training_task_id}")
    return receipt, directory


def _build_agent(
    spec: Mapping[str, Any],
    *,
    run_root: Path,
    training_tasks: Mapping[str, Mapping[str, Any]],
    device: str,
):
    if spec["kind"] == "search_baseline":
        from lifeline_rl import make_agent

        kind = str(spec["agent_kind"])
        config = spec.get("config", {})
        options: dict[str, Any] = {}
        if kind.startswith("minimax"):
            options["minimax_move_cap"] = int(config.get("move_cap", 20))
        if kind == "mcts":
            options.update(
                {
                    "mcts_simulations": int(config["simulations"]),
                    "mcts_rollout_depth": int(config.get("rollout_depth", 80)),
                    "mcts_exploration": float(config.get("exploration", math.sqrt(2.0))),
                }
            )
        return make_agent(kind, **options)
    if spec["kind"] != "learned_checkpoint":
        raise ProtocolError(f"unsupported arena agent kind {spec['kind']!r}")

    from lifeline_rl.alphazero.neural_agent import (
        NeuralPUCTAgent,
        NeuralPUCTSearchConfig,
    )

    receipt, training_directory = _load_training_receipt(
        run_root, str(spec["training_task_id"]), training_tasks
    )
    requested_step = int(spec["gradient_steps"])
    artifacts = {
        int(item["gradient_steps"]): item for item in receipt["checkpoint_artifacts"]
    }
    if requested_step not in artifacts:
        raise ProtocolError(
            f"training task {spec['training_task_id']} lacks checkpoint step {requested_step}"
        )
    artifact = artifacts[requested_step]
    search = spec["search"]
    return NeuralPUCTAgent.from_checkpoint(
        artifact["checkpoint_directory"],
        config_path=training_directory / "training_run" / "resolved_config.json",
        device=device,
        search_config=NeuralPUCTSearchConfig(
            simulations=int(search["simulations"]),
            c_puct=float(search["c_puct"]),
            temperature=float(search["temperature"]),
        ),
        label=(
            f"{spec['representation']}-seed"
            f"{training_tasks[spec['training_task_id']]['seed']}-gs{requested_step}"
        ),
        expected_model_kind=str(spec["representation"]),
        strict_source=True,
    )


def _verify_arena_artifacts(
    task: Mapping[str, Any], arena_directory: Path
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    dict[str, int],
    dict[str, dict[str, Any]],
]:
    from lifeline_rl import LifelineGame, replay_game_record

    summary_path = arena_directory / "summary.json"
    games_path = arena_directory / "games.jsonl"
    if not summary_path.is_file() or not games_path.is_file():
        raise ProtocolError(f"arena artifacts are incomplete: {arena_directory}")
    summary = _read_json(summary_path)
    records = load_jsonl(games_path)
    requested = int(task["games"])
    if len(records) != requested or int(summary.get("games_requested", -1)) != requested:
        raise ProtocolError(f"{task['task_id']}: arena game count mismatch")
    expected_summary_binding = {
        "experiment_id": task["experiment_id"],
        "manifest_sha256": task["manifest_sha256"],
        "evidence_tier": task["evidence_tier"],
        "task_id": task["task_id"],
        "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
        "grid_size": task["eval_size"],
        "superko_mode": task["superko_mode"],
        "base_seed": task["seed"],
        "max_plies": task["max_plies"],
        "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
    }
    for field, expected in expected_summary_binding.items():
        if summary.get(field) != expected:
            raise ProtocolError(
                f"{task['task_id']}: arena summary is not bound to this task ({field})"
            )
    agent_bindings = {
        "A": canonical_agent_binding(
            task,
            task["agent_a"],
            _mapping_or_protocol(summary.get("agent_a_metadata"), "agent A metadata"),
        ),
        "B": canonical_agent_binding(
            task,
            task["agent_b"],
            _mapping_or_protocol(summary.get("agent_b_metadata"), "agent B metadata"),
        ),
    }
    action_count = LifelineGame(
        int(task["eval_size"]), superko_mode=str(task["superko_mode"])
    ).num_points + 1

    for game_index, record in enumerate(records):
        expected_pair = game_index // 2
        if int(record.get("game_index", -1)) != game_index:
            raise ProtocolError(f"{task['task_id']}: non-contiguous arena game_index")
        if int(record.get("pair_index", -1)) != expected_pair:
            raise ProtocolError(f"{task['task_id']}: arena pair_index mismatch")
        if int(record.get("grid_size", -1)) != int(task["eval_size"]):
            raise ProtocolError(f"{task['task_id']}: arena record grid_size mismatch")
        if record.get("superko_mode") != task["superko_mode"]:
            raise ProtocolError(f"{task['task_id']}: arena record Superko mismatch")
        if int(record.get("seed", -1)) != int(task["seed"]) + expected_pair:
            raise ProtocolError(f"{task['task_id']}: arena record pair seed mismatch")
        black_slot = record.get("black_slot")
        white_slot = record.get("white_slot")
        if {black_slot, white_slot} != {"A", "B"} or black_slot == white_slot:
            raise ProtocolError(f"{task['task_id']}: arena record slot assignment is invalid")
        expected_black = summary["agent_a"] if black_slot == "A" else summary["agent_b"]
        expected_white = summary["agent_a"] if white_slot == "A" else summary["agent_b"]
        if record.get("black_agent") != expected_black or record.get("white_agent") != expected_white:
            raise ProtocolError(f"{task['task_id']}: arena record agent identity mismatch")
        actions = record.get("actions")
        if not isinstance(actions, list) or record.get("plies") != len(actions):
            raise ProtocolError(f"{task['task_id']}: arena action log length mismatch")
        for action in actions:
            action_mapping = _mapping_or_protocol(action, "arena action")
            actor = action_mapping.get("actor")
            if actor not in {"BLACK", "WHITE"}:
                raise ProtocolError(f"{task['task_id']}: arena action actor is invalid")
            actor_slot = black_slot if actor == "BLACK" else white_slot
            spec = task["agent_a"] if actor_slot == "A" else task["agent_b"]
            validate_action_diagnostics(
                task,
                spec,
                agent_bindings[actor_slot],
                action_mapping,
                action_count=action_count,
            )
        replay_game_record(record)
    pairing_errors: list[str] = []
    for pair_index in range(requested // 2):
        pair = [record for record in records if int(record["pair_index"]) == pair_index]
        if len(pair) != 2:
            pairing_errors.append(f"pair_{pair_index}_count")
            continue
        by_black_slot = {record["black_slot"]: record for record in pair}
        if set(by_black_slot) != {"A", "B"}:
            pairing_errors.append(f"pair_{pair_index}_slots")
            continue
        first = by_black_slot["A"]
        second = by_black_slot["B"]
        if int(first["seed"]) != int(second["seed"]):
            pairing_errors.append(f"pair_{pair_index}_seed")
        a_seed_first = first["black_policy_seed"]
        a_seed_second = second["white_policy_seed"]
        b_seed_first = first["white_policy_seed"]
        b_seed_second = second["black_policy_seed"]
        if a_seed_first != a_seed_second:
            pairing_errors.append(f"pair_{pair_index}_agent_a_policy_seed")
        if b_seed_first != b_seed_second:
            pairing_errors.append(f"pair_{pair_index}_agent_b_policy_seed")
    if pairing_errors:
        raise ProtocolError(
            f"{task['task_id']}: invalid color pairs: {', '.join(pairing_errors[:5])}"
        )

    wins = losses = draws = truncated = 0
    a_as_black = a_as_white = 0
    for record in records:
        if record["black_slot"] == "A":
            a_as_black += 1
        elif record["white_slot"] == "A":
            a_as_white += 1
        else:
            raise ProtocolError(f"{task['task_id']}: game lacks agent A")
        if record["truncated"]:
            truncated += 1
        elif record["winner"] == "DRAW":
            draws += 1
        else:
            a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
            if record["winner"] == a_color:
                wins += 1
            else:
                losses += 1
    observed = {
        "games_requested": requested,
        "games_completed": requested - truncated,
        "truncated_games": truncated,
        "a_as_black_games": a_as_black,
        "a_as_white_games": a_as_white,
        "color_pairs_verified": requested // 2,
        "replay_verified_games": len(records),
        "a_wins": wins,
        "a_losses": losses,
        "draws": draws,
    }
    if truncated != 0:
        raise ProtocolError(f"{task['task_id']}: evaluation contains {truncated} truncations")
    for field in (
        "games_completed",
        "truncated_games",
        "a_wins",
        "a_losses",
        "draws",
    ):
        if int(summary.get(field, -1)) != observed[field]:
            raise ProtocolError(f"{task['task_id']}: arena summary mismatch for {field}")

    csv_path = arena_directory / "games.csv"
    csv_fields = [
        "game_index",
        "pair_index",
        "seed",
        "grid_size",
        "superko_mode",
        "black_slot",
        "white_slot",
        "black_agent",
        "white_agent",
        "winner",
        "truncated",
        "plies",
        "duration_seconds",
        "black_area",
        "white_area",
    ]
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != csv_fields:
                raise ProtocolError(f"{task['task_id']}: arena CSV header mismatch")
            csv_rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ProtocolError(f"{task['task_id']}: cannot parse arena CSV") from exc
    if len(csv_rows) != len(records):
        raise ProtocolError(f"{task['task_id']}: arena CSV row count mismatch")
    for game_index, (record, observed_row) in enumerate(zip(records, csv_rows)):
        territories = record.get("territories")
        expected_row = {
            "game_index": str(record["game_index"]),
            "pair_index": str(record["pair_index"]),
            "seed": str(record["seed"]),
            "grid_size": str(record["grid_size"]),
            "superko_mode": str(record["superko_mode"]),
            "black_slot": str(record["black_slot"]),
            "white_slot": str(record["white_slot"]),
            "black_agent": str(record["black_agent"]),
            "white_agent": str(record["white_agent"]),
            "winner": str(record["winner"]),
            "truncated": str(record["truncated"]),
            "plies": str(record["plies"]),
            "duration_seconds": str(record["duration_seconds"]),
            "black_area": "" if territories is None else str(territories["BLACK"]),
            "white_area": "" if territories is None else str(territories["WHITE"]),
        }
        if observed_row != expected_row:
            raise ProtocolError(
                f"{task['task_id']}: arena CSV disagrees with game {game_index}"
            )
    return summary, records, observed, agent_bindings


def run_evaluation_task(
    task: Mapping[str, Any],
    task_directory: Path,
    *,
    run_root: Path,
    training_tasks: Mapping[str, Mapping[str, Any]],
    device: str,
) -> dict[str, Any]:
    """Run or verify one fixed-checkpoint color-balanced arena task."""

    from lifeline_rl import run_matchup, write_matchup

    arena_directory = task_directory / "arena"
    artifact_paths = [
        arena_directory / "summary.json",
        arena_directory / "games.jsonl",
        arena_directory / "games.csv",
    ]
    existing = [path for path in artifact_paths if path.exists()]
    if existing and len(existing) != len(artifact_paths):
        raise ProtocolError(f"{task['task_id']}: partial arena artifacts require inspection")
    if not existing:
        agent_a = _build_agent(
            task["agent_a"],
            run_root=run_root,
            training_tasks=training_tasks,
            device=device,
        )
        agent_b = _build_agent(
            task["agent_b"],
            run_root=run_root,
            training_tasks=training_tasks,
            device=device,
        )
        result = run_matchup(
            agent_a,
            agent_b,
            games=int(task["games"]),
            grid_size=int(task["eval_size"]),
            base_seed=int(task["seed"]),
            max_plies=int(task["max_plies"]),
            superko_mode=str(task["superko_mode"]),
        )
        result.summary.update(
            {
                "experiment_id": task["experiment_id"],
                "manifest_sha256": task["manifest_sha256"],
                "evidence_tier": task["evidence_tier"],
                "task_id": task["task_id"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
            }
        )
        write_matchup(result, arena_directory)

    summary, records, observed, agent_bindings = _verify_arena_artifacts(
        task, arena_directory
    )
    receipt = {
        **_result_header(task),
        "status": "complete",
        "completed_at_utc": _utc_now(),
        "train_sizes": task["train_sizes"],
        "eval_size": task["eval_size"],
        "seed": task["seed"],
        "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
        "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
        "agent_bindings": agent_bindings,
        **observed,
        "color_balance": task["color_balance"],
        "max_plies": task["max_plies"],
        "superko_mode": task["superko_mode"],
        "arena_summary_path": str((arena_directory / "summary.json").resolve()),
        "arena_games_path": str((arena_directory / "games.jsonl").resolve()),
        "arena_csv_path": str((arena_directory / "games.csv").resolve()),
        "arena_summary_sha256": _sha256_file(arena_directory / "summary.json"),
        "arena_games_sha256": _sha256_file(arena_directory / "games.jsonl"),
        "arena_csv_sha256": _sha256_file(arena_directory / "games.csv"),
        "agent_a": summary.get("agent_a_metadata"),
        "agent_b": summary.get("agent_b_metadata"),
    }
    if len(records) != observed["replay_verified_games"]:  # pragma: no cover
        raise AssertionError("replay verifier count drift")
    return receipt


def _existing_receipt(
    task_directory: Path,
    task: Mapping[str, Any],
    *,
    expected_execution_identity: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    path = task_directory / "receipt.json"
    if not path.is_file():
        return None
    receipt = _read_json(path)
    if (
        receipt.get("schema_name") != RESULT_SCHEMA_NAME
        or receipt.get("schema_version") != SCHEMA_VERSION
    ):
        raise ProtocolError(f"receipt schema is invalid: {path}")
    for field in (
        "experiment_id",
        "manifest_sha256",
        "evidence_tier",
        "task_id",
    ):
        if receipt.get(field) != task[field]:
            raise ProtocolError(f"receipt identity mismatch at {path}: {field}")
    if receipt.get("status") not in {"complete", "failed"}:
        raise ProtocolError(f"receipt status is invalid: {path}")
    if (
        expected_execution_identity is not None
        and receipt.get("execution_identity") != expected_execution_identity
    ):
        raise ProtocolError(f"receipt execution source/runner identity mismatch: {path}")
    return receipt


def _write_attempt(task_directory: Path, state: Mapping[str, Any], receipt: Mapping[str, Any]) -> None:
    attempt = int(state.get("attempts", 0))
    path = task_directory / "attempts" / f"attempt_{attempt:04d}.json"
    if path.exists():
        raise ProtocolError(f"attempt history already exists: {path}")
    _atomic_json(path, receipt)


def _validate_task_receipt(
    task: Mapping[str, Any],
    receipt: Mapping[str, Any],
    checkpoint_index: Mapping[tuple[str, int], Mapping[str, Any]],
) -> None:
    if task["task_kind"] == "training":
        _validate_training_result(receipt, task)
    else:
        _validate_evaluation_result(receipt, task, checkpoint_index)


def _index_training_checkpoints(
    task: Mapping[str, Any],
    receipt: Mapping[str, Any],
    checkpoint_index: dict[tuple[str, int], Mapping[str, Any]],
) -> None:
    if task.get("task_kind") != "training" or receipt.get("status") != "complete":
        return
    for artifact in receipt.get("checkpoint_artifacts", []):
        checkpoint_index[(str(task["task_id"]), int(artifact["gradient_steps"]))] = artifact


def collect_receipts(
    tasks: Mapping[str, Sequence[Mapping[str, Any]]], run_root: Path
) -> tuple[list[dict[str, Any]], list[str]]:
    receipts: list[dict[str, Any]] = []
    missing: list[str] = []
    for task in list(tasks["training"]) + list(tasks["evaluation"]):
        receipt = _existing_receipt(_task_directory(run_root, task["task_id"]), task)
        if receipt is None:
            missing.append(task["task_id"])
        else:
            receipts.append(receipt)
    return receipts, missing


def validate_present_receipts(
    tasks: Mapping[str, Sequence[Mapping[str, Any]]],
    run_root: Path,
    *,
    expected_execution_identity: Mapping[str, Any] | None,
    receipt_validator: Callable[
        [Mapping[str, Any], Mapping[str, Any], Mapping[tuple[str, int], Mapping[str, Any]]],
        None,
    ] = _validate_task_receipt,
) -> tuple[
    list[dict[str, Any]],
    list[str],
    dict[tuple[str, int], Mapping[str, Any]],
]:
    """Deep-validate every present receipt, with training dependencies first."""

    receipts: list[dict[str, Any]] = []
    missing: list[str] = []
    checkpoint_index: dict[tuple[str, int], Mapping[str, Any]] = {}
    for task in tasks["training"]:
        receipt = _existing_receipt(
            _task_directory(run_root, task["task_id"]),
            task,
            expected_execution_identity=expected_execution_identity,
        )
        if receipt is None:
            missing.append(str(task["task_id"]))
            continue
        receipt_validator(task, receipt, checkpoint_index)
        _index_training_checkpoints(task, receipt, checkpoint_index)
        receipts.append(receipt)
    for task in tasks["evaluation"]:
        receipt = _existing_receipt(
            _task_directory(run_root, task["task_id"]),
            task,
            expected_execution_identity=expected_execution_identity,
        )
        if receipt is None:
            missing.append(str(task["task_id"]))
            continue
        receipt_validator(task, receipt, checkpoint_index)
        receipts.append(receipt)
    return receipts, missing, checkpoint_index


def _invalidate_result_ledger(run_root: Path, reason: str) -> None:
    ledger = run_root / "result_receipts.jsonl"
    archived: str | None = None
    if ledger.is_file():
        stale_directory = run_root / "stale_ledgers"
        stale_directory.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        destination = stale_directory / f"result_receipts_{timestamp}.jsonl"
        os.replace(ledger, destination)
        archived = str(destination.resolve())
    _atomic_json(
        run_root / "result_ledger_status.json",
        {
            "schema_name": EXECUTION_SCHEMA_NAME,
            "schema_version": EXECUTION_SCHEMA_VERSION,
            "valid": False,
            "reason": reason,
            "archived_previous_ledger": archived,
            "updated_at_utc": _utc_now(),
        },
    )


def _execution_metadata(
    manifest: Mapping[str, Any], bundle_directory: Path, device: str
) -> dict[str, Any]:
    import torch
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    protocol_path = Path(__file__).with_name("d14_d16_experiments.py")
    resolved_device = torch.device(device)
    device_name: str | None = None
    if resolved_device.type == "cuda" and torch.cuda.is_available():
        device_name = torch.cuda.get_device_name(resolved_device)
    return {
        "schema_name": EXECUTION_SCHEMA_NAME,
        "schema_version": EXECUTION_SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "bundle_directory": str(bundle_directory.resolve()),
        "device": device,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "trainer_source_hash": AlphaZeroTrainer.current_source_hash(),
        "runner_sha256": _sha256_file(Path(__file__).resolve()),
        "protocol_sha256": _sha256_file(protocol_path.resolve()),
        "torch_version": str(torch.__version__),
        "cuda_runtime_version": torch.version.cuda,
        "cudnn_version": torch.backends.cudnn.version(),
        "device_name": device_name,
        "cublas_workspace_config": os.environ.get("CUBLAS_WORKSPACE_CONFIG"),
        "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        "cudnn_benchmark": bool(torch.backends.cudnn.benchmark),
        "cudnn_deterministic": bool(torch.backends.cudnn.deterministic),
    }


def _receipt_execution_identity(metadata: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "trainer_source_hash": str(metadata["trainer_source_hash"]),
        "runner_sha256": str(metadata["runner_sha256"]),
        "protocol_sha256": str(metadata["protocol_sha256"]),
        "torch_version": str(metadata["torch_version"]),
        "cuda_runtime_version": metadata["cuda_runtime_version"],
        "cudnn_version": metadata["cudnn_version"],
        "device": str(metadata["device"]),
        "device_name": metadata["device_name"],
        "cublas_workspace_config": metadata["cublas_workspace_config"],
    }


def run_bundle(
    manifest: Mapping[str, Any],
    tasks: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    bundle_directory: Path,
    run_root: Path,
    device: str,
    task_kind: str = "all",
    max_tasks: int | None = None,
    retry_failed: bool = False,
    continue_on_error: bool = False,
    training_runner: Callable[..., dict[str, Any]] = run_training_task,
    evaluation_runner: Callable[..., dict[str, Any]] = run_evaluation_task,
    receipt_validator: Callable[
        [Mapping[str, Any], Mapping[str, Any], Mapping[tuple[str, int], Mapping[str, Any]]],
        None,
    ] = _validate_task_receipt,
) -> dict[str, Any]:
    """Sequentially execute pending tasks and atomically persist each outcome."""

    run_root.mkdir(parents=True, exist_ok=True)
    _configure_deterministic_runtime(device)
    metadata_path = run_root / "execution_metadata.json"
    expected_metadata = _execution_metadata(manifest, bundle_directory, device)
    if metadata_path.is_file():
        if _read_json(metadata_path) != expected_metadata:
            _invalidate_result_ledger(run_root, "execution_metadata_mismatch")
            raise ProtocolError("run root belongs to a different manifest, bundle, or device")
    else:
        _atomic_json(metadata_path, expected_metadata)
    execution_identity = _receipt_execution_identity(expected_metadata)
    _invalidate_result_ledger(run_root, "execution_invocation_started")

    selected: list[Mapping[str, Any]] = []
    if task_kind in {"all", "training"}:
        selected.extend(tasks["training"])
    if task_kind in {"all", "evaluation"}:
        selected.extend(tasks["evaluation"])
    training_tasks = _training_task_map(tasks)
    _, _, checkpoint_index = validate_present_receipts(
        tasks,
        run_root,
        expected_execution_identity=execution_identity,
        receipt_validator=receipt_validator,
    )
    validated_existing = {
        str(task["task_id"])
        for task in list(tasks["training"]) + list(tasks["evaluation"])
        if (_task_directory(run_root, task["task_id"]) / "receipt.json").is_file()
    }
    attempted = skipped_complete = skipped_failed = failed = 0
    for task in selected:
        task_directory = _task_directory(run_root, task["task_id"])
        existing = _existing_receipt(
            task_directory,
            task,
            expected_execution_identity=execution_identity,
        )
        if existing is not None and task["task_id"] not in validated_existing:
            receipt_validator(task, existing, checkpoint_index)
        if existing is not None and existing["status"] == "complete":
            skipped_complete += 1
            continue
        if existing is not None and existing["status"] == "failed" and not retry_failed:
            skipped_failed += 1
            continue
        if max_tasks is not None and attempted >= max_tasks:
            break
        task_directory.mkdir(parents=True, exist_ok=True)
        state_path = task_directory / "state.json"
        state = _load_state(state_path, task)
        if state.get("status") in {"running", "failed"} and state.get(
            "attempt_started_at_utc"
        ):
            state["interrupted_attempt_started_at_utc"] = state[
                "attempt_started_at_utc"
            ]
            state["interrupted_wall_clock_at_attempt_start"] = state.get(
                "wall_clock_at_attempt_start", state.get("wall_clock_seconds", 0.0)
            )
        state["attempts"] = int(state.get("attempts", 0)) + 1
        state["status"] = "running"
        state["attempt_started_at_utc"] = _utc_now()
        state["wall_clock_at_attempt_start"] = float(
            state.get("wall_clock_seconds", 0.0)
        )
        _atomic_json(state_path, state)
        attempted += 1
        try:
            if task["task_kind"] == "training":
                receipt = training_runner(task, task_directory, device=device)
            else:
                receipt = evaluation_runner(
                    task,
                    task_directory,
                    run_root=run_root,
                    training_tasks=training_tasks,
                    device=device,
                )
        except Exception as exc:  # outcome is deliberately persisted before policy choice
            receipt = _failed_receipt(task, exc)
            receipt["execution_identity"] = execution_identity
            receipt_validator(task, receipt, checkpoint_index)
            failed += 1
            state = _load_state(state_path, task)
            state["status"] = "failed"
            state["failure_reason"] = receipt["failure_reason"]
            state["failed_at_utc"] = receipt["failed_at_utc"]
            _atomic_json(state_path, state)
            _write_attempt(task_directory, state, receipt)
            _atomic_json(task_directory / "receipt.json", receipt)
            if not continue_on_error:
                break
        else:
            receipt["execution_identity"] = execution_identity
            receipt_validator(task, receipt, checkpoint_index)
            if task["task_kind"] == "training":
                _index_training_checkpoints(task, receipt, checkpoint_index)
            state = _load_state(state_path, task)
            state["status"] = "complete"
            state["completed_at_utc"] = receipt.get("completed_at_utc", _utc_now())
            _atomic_json(state_path, state)
            _write_attempt(task_directory, state, receipt)
            _atomic_json(task_directory / "receipt.json", receipt)

    receipts, missing, _ = validate_present_receipts(
        tasks,
        run_root,
        expected_execution_identity=execution_identity,
        receipt_validator=receipt_validator,
    )
    total_failed = sum(receipt.get("status") == "failed" for receipt in receipts)
    total_complete = sum(receipt.get("status") == "complete" for receipt in receipts)
    ledger_path: str | None = None
    if not missing:
        validate_result_ledger(manifest, receipts)
        ledger = run_root / "result_receipts.jsonl"
        _atomic_text(
            ledger,
            "".join(
                json.dumps(receipt, sort_keys=True, ensure_ascii=False) + "\n"
                for receipt in receipts
            ),
        )
        ledger_path = str(ledger.resolve())
        _atomic_json(
            run_root / "result_ledger_status.json",
            {
                "schema_name": EXECUTION_SCHEMA_NAME,
                "schema_version": EXECUTION_SCHEMA_VERSION,
                "valid": True,
                "ledger_path": ledger_path,
                "ledger_sha256": _sha256_file(ledger),
                "manifest_sha256": manifest_hash(manifest),
                "execution_identity": execution_identity,
                "failed_receipts": total_failed,
                "formal_ready": (
                    manifest["evidence_tier"] == "formal" and total_failed == 0
                ),
                "updated_at_utc": _utc_now(),
            },
        )
    summary = {
        "schema_name": EXECUTION_SCHEMA_NAME,
        "schema_version": EXECUTION_SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "attempted_this_invocation": attempted,
        "failed_this_invocation": failed,
        "skipped_complete": skipped_complete,
        "skipped_failed": skipped_failed,
        "receipts_present": len(receipts),
        "receipts_missing": len(missing),
        "complete_receipts": total_complete,
        "failed_receipts": total_failed,
        "formal_ready": (
            manifest["evidence_tier"] == "formal"
            and not missing
            and total_failed == 0
            and ledger_path is not None
        ),
        "missing_preview": missing[:10],
        "result_ledger": ledger_path,
        "updated_at_utc": _utc_now(),
    }
    _atomic_json(run_root / "execution_summary.json", summary)
    return summary


def status_summary(
    manifest: Mapping[str, Any],
    tasks: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    bundle_directory: Path,
    run_root: Path,
    receipt_validator: Callable[
        [Mapping[str, Any], Mapping[str, Any], Mapping[tuple[str, int], Mapping[str, Any]]],
        None,
    ] = _validate_task_receipt,
) -> dict[str, Any]:
    """Read-only status that refuses to endorse stale receipts or a stale ledger."""

    metadata_path = run_root / "execution_metadata.json"
    execution_identity: Mapping[str, Any] | None = None
    if metadata_path.is_file():
        metadata = _read_json(metadata_path)
        device = metadata.get("device")
        if not isinstance(device, str) or not device:
            raise ProtocolError("execution metadata has no valid device")
        _configure_deterministic_runtime(device)
        expected_metadata = _execution_metadata(manifest, bundle_directory, device)
        if metadata != expected_metadata:
            raise ProtocolError("execution metadata is stale or belongs to another run")
        execution_identity = _receipt_execution_identity(metadata)

    receipts, missing, _ = validate_present_receipts(
        tasks,
        run_root,
        expected_execution_identity=execution_identity,
        receipt_validator=receipt_validator,
    )
    if receipts and execution_identity is None:
        raise ProtocolError("receipts exist without execution metadata")

    ledger_status_path = run_root / "result_ledger_status.json"
    ledger_claim_valid = False
    ledger_path: str | None = None
    if ledger_status_path.is_file():
        ledger_status = _read_json(ledger_status_path)
        ledger_claim_valid = ledger_status.get("valid") is True
        if ledger_claim_valid:
            if missing:
                raise ProtocolError("result ledger claims valid while task receipts are missing")
            ledger = run_root / "result_receipts.jsonl"
            if (
                not ledger.is_file()
                or ledger_status.get("ledger_path") != str(ledger.resolve())
                or ledger_status.get("ledger_sha256") != _sha256_file(ledger)
                or ledger_status.get("manifest_sha256") != manifest_hash(manifest)
                or ledger_status.get("execution_identity") != execution_identity
            ):
                raise ProtocolError("result ledger status is not bound to the current ledger")
            ledger_receipts = load_jsonl(ledger)
            if canonical_json({"receipts": ledger_receipts}) != canonical_json(
                {"receipts": receipts}
            ):
                raise ProtocolError("result ledger differs from the deeply validated receipts")
            validate_result_ledger(manifest, ledger_receipts)
            ledger_path = str(ledger.resolve())

    total_complete = sum(receipt.get("status") == "complete" for receipt in receipts)
    total_failed = sum(receipt.get("status") == "failed" for receipt in receipts)
    return {
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "receipts_present": len(receipts),
        "complete": total_complete,
        "failed": total_failed,
        "missing": len(missing),
        "missing_preview": missing[:10],
        "artifacts_deep_validated": len(receipts),
        "result_ledger_valid": ledger_claim_valid,
        "result_ledger": ledger_path,
        "formal_ready": (
            manifest["evidence_tier"] == "formal"
            and not missing
            and total_failed == 0
            and ledger_claim_valid
        ),
    }


def dry_run_summary(
    manifest: Mapping[str, Any], tasks: Mapping[str, Sequence[Mapping[str, Any]]]
) -> dict[str, Any]:
    configs = [build_training_config(task) for task in tasks["training"]]
    return {
        "status": "dry_run_ok_no_writes",
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "training_tasks": len(tasks["training"]),
        "evaluation_tasks": len(tasks["evaluation"]),
        "training_schedule": {
            "iterations": sorted({config.iterations for config in configs}),
            "games_per_iteration": sorted({config.games_per_iteration for config in configs}),
            "training_steps_per_iteration": sorted(
                {config.training_steps_per_iteration for config in configs}
            ),
            "checkpoint_every_iterations": sorted(
                {config.checkpoint_every for config in configs}
            ),
        },
        "first_training_task": (
            None if not tasks["training"] else tasks["training"][0]["task_id"]
        ),
        "first_evaluation_task": (
            None if not tasks["evaluation"] else tasks["evaluation"][0]["task_id"]
        ),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("dry-run", "run", "status"):
        child = subparsers.add_parser(command)
        child.add_argument("--manifest", type=Path, required=True)
        child.add_argument("--bundle-dir", type=Path, required=True)
        if command != "dry-run":
            child.add_argument("--run-root", type=Path, required=True)
    run = subparsers.choices["run"]
    run.add_argument("--device", default="cpu")
    run.add_argument("--task-kind", choices=("all", "training", "evaluation"), default="all")
    run.add_argument("--max-tasks", type=int)
    run.add_argument("--retry-failed", action="store_true")
    run.add_argument("--continue-on-error", action="store_true")
    run.add_argument("--confirm-formal", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        tasks = load_task_bundle(manifest, args.bundle_dir)
        if args.command == "dry-run":
            payload = dry_run_summary(manifest, tasks)
        elif args.command == "status":
            payload = status_summary(
                manifest,
                tasks,
                bundle_directory=args.bundle_dir,
                run_root=args.run_root,
            )
        else:
            if args.max_tasks is not None and args.max_tasks < 1:
                raise ProtocolError("--max-tasks must be positive")
            if manifest["evidence_tier"] == "formal" and not args.confirm_formal:
                raise ProtocolError(
                    "formal execution is locked; inspect dry-run output, freeze source, "
                    "then pass --confirm-formal explicitly"
                )
            payload = run_bundle(
                manifest,
                tasks,
                bundle_directory=args.bundle_dir,
                run_root=args.run_root,
                device=args.device,
                task_kind=args.task_kind,
                max_tasks=args.max_tasks,
                retry_failed=args.retry_failed,
                continue_on_error=args.continue_on_error,
            )
    except ProtocolError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
