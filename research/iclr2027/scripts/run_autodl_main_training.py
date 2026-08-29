#!/usr/bin/env python3
"""Long-running, checkpointed multi-seed AutoDL v3 training pilot."""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import queue
import shutil
import signal
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import torch

from lifeline_rl.alphazero.config import AlphaZeroConfig
from lifeline_rl.alphazero.network import NetworkConfig, build_policy_value_network
from lifeline_rl_autodl.batched_network import BatchedTorchPolicyValueEvaluator
from lifeline_rl_autodl.trainer import AutoDLRuntimeConfig, BatchedAlphaZeroTrainer
from scripts.autodl_game_gpu import _load_real_states


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--max-wall-seconds", type=int, default=99_600)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--fixture", type=Path)
    return parser


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_main_config(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema_version",
        "experiment_id",
        "seeds",
        "max_workers",
        "torch_threads_per_worker",
        "runtime",
        "alphazero",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise ValueError("AutoDL main config keys do not match schema v1")
    if payload["schema_version"] != 1:
        raise ValueError("unsupported AutoDL main config schema")
    seeds = payload["seeds"]
    if (
        not isinstance(seeds, list)
        or not seeds
        or any(isinstance(seed, bool) or not isinstance(seed, int) for seed in seeds)
        or len(set(seeds)) != len(seeds)
    ):
        raise ValueError("seeds must be unique integers")
    max_workers = int(payload["max_workers"])
    if max_workers < 1 or max_workers > len(seeds):
        raise ValueError("max_workers must be between 1 and the seed count")
    threads = int(payload["torch_threads_per_worker"])
    if threads < 1 or max_workers * threads > 32:
        raise ValueError("worker CPU thread budget must be between 1 and 32")
    runtime = payload["runtime"]
    if not isinstance(runtime, dict) or set(runtime) != {"actor_count", "inference_amp"}:
        raise ValueError("runtime keys do not match schema v1")
    AutoDLRuntimeConfig(**runtime)
    AlphaZeroConfig.from_dict(payload["alphazero"])
    return payload


def _config_for_seed(payload: dict[str, Any], seed: int) -> AlphaZeroConfig:
    config = dict(payload["alphazero"])
    config["seed"] = seed
    return AlphaZeroConfig.from_dict(config)


def _readiness(payload: dict[str, Any], fixture: Path) -> int:
    config = _config_for_seed(payload, int(payload["seeds"][0]))
    states = _load_real_states(fixture)
    games = tuple(states[:4])
    model = build_policy_value_network(
        config.model_kind,
        NetworkConfig(config.hidden_channels, config.message_passing_layers),
    )
    evaluator = BatchedTorchPolicyValueEvaluator(
        model, config.observation_mode, "cpu", use_amp=False
    )
    predictions = evaluator.evaluate_batch(games)
    result = {
        "status": "main_training_readiness_ok",
        "experiment_id": payload["experiment_id"],
        "seed_count": len(payload["seeds"]),
        "max_workers": payload["max_workers"],
        "real_states_parsed": len(states),
        "batch_size": len(games),
        "action_shapes": [len(prediction.priors) for prediction in predictions],
        "parameter_count": model.parameter_count,
        "model_kind": config.model_kind,
    }
    print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    return 0


def _model_payload(trainer: BatchedAlphaZeroTrainer, seed: int) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "seed": seed,
        "counters": trainer.counters.to_dict(),
        "config": trainer.config.to_dict(),
        "runtime": trainer.runtime.to_dict(),
        "source_hash": trainer.current_source_hash(),
        "model_state": {
            key: value.detach().cpu() for key, value in trainer.model.state_dict().items()
        },
    }


def _seed_worker(
    seed: int,
    payload: dict[str, Any],
    output_root: str,
    deadline_epoch: float,
    stop_event: Any,
    event_queue: Any,
) -> None:
    run_root = Path(output_root) / f"seed_{seed}"
    try:
        torch.set_num_threads(int(payload["torch_threads_per_worker"]))
        torch.set_num_interop_threads(1)
        config = _config_for_seed(payload, seed)
        runtime = AutoDLRuntimeConfig(**payload["runtime"])
        run_root.mkdir(parents=True, exist_ok=True)
        _atomic_json(run_root / "resolved_config.json", config.to_dict())
        _atomic_json(run_root / "runtime_config.json", runtime.to_dict())
        trainer = BatchedAlphaZeroTrainer(
            config,
            run_root,
            device="cuda",
            runtime=runtime,
        )
        latest = run_root / "checkpoints" / "latest.json"
        restored_from: str | None = None
        if latest.is_file():
            restored_from = str(trainer.resume(latest)["checkpoint_path"])
        last_metrics: dict[str, Any] | None = None
        last_checkpoint: dict[str, Any] | None = None
        while (
            not stop_event.is_set()
            and time.time() < deadline_epoch
            and trainer.counters.iteration < config.iterations
        ):
            last_metrics = trainer.run_iteration()
            progress = {
                "event": "iteration_complete",
                "seed": seed,
                "iteration": trainer.counters.iteration,
                "games": trainer.counters.games_attempted,
                "gradient_steps": trainer.counters.gradient_steps,
                "buffer_size": len(trainer.replay_buffer),
                "loss": last_metrics.get("loss"),
            }
            print(json.dumps(progress, sort_keys=True), flush=True)
            if trainer.counters.iteration % config.checkpoint_every == 0:
                last_checkpoint = trainer.save()
        last_checkpoint = trainer.save()
        model_path = run_root / "model_final.pt"
        torch.save(_model_payload(trainer, seed), model_path)
        summary = {
            "schema_version": 1,
            "status": "completed_or_time_limited",
            "seed": seed,
            "restored_from": restored_from,
            "counters": trainer.counters.to_dict(),
            "buffer_size": len(trainer.replay_buffer),
            "last_metrics": last_metrics,
            "checkpoint": last_checkpoint,
            "model_path": str(model_path),
            "model_bytes": model_path.stat().st_size,
            "model_sha256": _sha256(model_path),
        }
        _atomic_json(run_root / "seed_summary.json", summary)
        event_queue.put({"status": "ok", "seed": seed})
    except BaseException as exc:
        error = {
            "status": "error",
            "seed": seed,
            "error_type": type(exc).__name__,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }
        try:
            _atomic_json(run_root / "seed_error.json", error)
        finally:
            event_queue.put(error)
        raise


def _run(payload: dict[str, Any], args: argparse.Namespace) -> int:
    if args.output_root is None or args.summary is None:
        raise SystemExit("--output-root and --summary are required for training")
    if args.max_wall_seconds < 600:
        raise SystemExit("--max-wall-seconds must be at least 600")
    output_root = args.output_root.resolve()
    summary_path = args.summary.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    _atomic_json(output_root / "experiment_config.json", payload)
    context = mp.get_context("spawn")
    stop_event = context.Event()
    event_queue = context.Queue()
    deadline_epoch = time.time() + args.max_wall_seconds

    def request_stop(*_: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    processes: list[mp.Process] = []
    for seed in payload["seeds"]:
        process = context.Process(
            target=_seed_worker,
            args=(
                int(seed),
                payload,
                str(output_root),
                deadline_epoch,
                stop_event,
                event_queue,
            ),
            name=f"lifeline-seed-{seed}",
        )
        process.start()
        processes.append(process)

    events: list[dict[str, Any]] = []
    while any(process.is_alive() for process in processes):
        try:
            event = event_queue.get(timeout=2.0)
            events.append(event)
            if event.get("status") == "error":
                stop_event.set()
        except queue.Empty:
            pass
        if time.time() >= deadline_epoch:
            stop_event.set()
    for process in processes:
        process.join(timeout=1.0)
    while True:
        try:
            events.append(event_queue.get_nowait())
        except queue.Empty:
            break

    failures = [
        {"seed": int(process.name.rsplit("-", 1)[-1]), "exit_code": process.exitcode}
        for process in processes
        if process.exitcode != 0
    ]
    seed_summaries: list[dict[str, Any]] = []
    models_dir = summary_path.parent / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    for seed in payload["seeds"]:
        seed_root = output_root / f"seed_{seed}"
        seed_summary_path = seed_root / "seed_summary.json"
        if not seed_summary_path.is_file():
            continue
        seed_summary = json.loads(seed_summary_path.read_text(encoding="utf-8"))
        model_source = Path(seed_summary["model_path"])
        model_destination = models_dir / f"topology_gnn_seed_{seed}.pt"
        shutil.copy2(model_source, model_destination)
        seed_summary["exported_model"] = str(model_destination)
        seed_summaries.append(seed_summary)

    result = {
        "schema_version": 1,
        "status": "failed" if failures else "main_training_complete",
        "experiment_id": payload["experiment_id"],
        "max_wall_seconds": args.max_wall_seconds,
        "seed_count": len(payload["seeds"]),
        "completed_seed_count": len(seed_summaries),
        "failures": failures,
        "events": events,
        "remote_output_root": str(output_root),
        "seed_summaries": seed_summaries,
    }
    _atomic_json(summary_path, result)
    print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    payload = _load_main_config(args.config)
    if args.validate_only:
        if args.fixture is None:
            raise SystemExit("--fixture is required with --validate-only")
        return _readiness(payload, args.fixture)
    return _run(payload, args)


if __name__ == "__main__":
    mp.freeze_support()
    raise SystemExit(main())
