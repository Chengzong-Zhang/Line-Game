#!/usr/bin/env python3
"""Run or resume the single-process D9--D10 AlphaZero pipeline."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:
    import torch
except ImportError as exc:
    raise SystemExit(
        "AlphaZero training requires PyTorch. Install the optional extra with:\n"
        "  python -m pip install -e .\\research\\iclr2027[train]"
    ) from exc

from lifeline_rl.alphazero.config import AlphaZeroConfig
from lifeline_rl.alphazero.network import (
    MODEL_KINDS,
    NetworkConfig,
    build_policy_value_network,
    observation_mode_for_model,
)
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer, seed_everything


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="D9-D10 AlphaZero self-play, replay, training, and checkpoint runner"
    )
    parser.add_argument("--config", type=Path, help="versioned JSON config")
    parser.add_argument("--seed", type=int, help="override the config seed")
    parser.add_argument(
        "--model-kind",
        choices=MODEL_KINDS,
        help="override model family and its required observation encoder",
    )
    parser.add_argument("--iterations", type=int, help="override total target iterations")
    parser.add_argument(
        "--additional-iterations",
        type=int,
        help="on resume, run this many iterations beyond the restored counter",
    )
    parser.add_argument("--output-dir", type=Path, help="new run directory")
    parser.add_argument(
        "--resume",
        type=Path,
        help="checkpoint directory, latest.json, or checkpoint file",
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="PyTorch device (default: cpu; use cuda explicitly for formal runs)",
    )
    parser.add_argument("--smoke", action="store_true", help="use a tiny labelled smoke config")
    parser.add_argument("--dry-run", action="store_true", help="validate and print; do not write")
    parser.add_argument(
        "--allow-source-mismatch",
        action="store_true",
        help="intentional checkpoint migration only; disables source hash equality",
    )
    return parser


def _run_directory_from_resume(path: Path) -> Path:
    resolved = path.resolve()
    checkpoint_directory = resolved if resolved.is_dir() else resolved.parent
    if checkpoint_directory.name == "checkpoints":
        return checkpoint_directory.parent
    return checkpoint_directory


def _load_config(args: argparse.Namespace) -> AlphaZeroConfig:
    config_path = args.config
    if config_path is None and args.resume is not None:
        candidate = _run_directory_from_resume(args.resume) / "resolved_config.json"
        if candidate.is_file():
            config_path = candidate
    config = AlphaZeroConfig.load(config_path) if config_path else AlphaZeroConfig()
    if args.smoke:
        config = config.smoke()
    changes: dict[str, Any] = {}
    if args.seed is not None:
        changes["seed"] = args.seed
    if args.model_kind is not None:
        changes["model_kind"] = args.model_kind
        changes["observation_mode"] = observation_mode_for_model(args.model_kind)
    if args.iterations is not None:
        changes["iterations"] = args.iterations
    return config.with_overrides(**changes) if changes else config


def _default_output(config: AlphaZeroConfig, smoke: bool) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    category = "smoke" if smoke else "training"
    name = f"{timestamp}_az_{config.model_kind}_seed{config.seed}"
    return RESEARCH_ROOT / "results" / category / "alphazero" / name


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


def _dry_run(config: AlphaZeroConfig, device: str) -> int:
    seed_everything(config.seed)
    model = build_policy_value_network(
        config.model_kind,
        NetworkConfig(config.hidden_channels, config.message_passing_layers),
    ).to(torch.device(device))
    payload = {
        "status": "dry_run_ok",
        "device": str(torch.device(device)),
        "torch_version": torch.__version__,
        "model_kind": config.model_kind,
        "observation_mode": config.observation_mode,
        "parameter_count": model.parameter_count,
        "config_hash": config.fingerprint(),
        "resume_critical_hash": config.fingerprint(resume_critical=True),
        "source_hash": AlphaZeroTrainer.current_source_hash(),
        "config": config.to_dict(),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.additional_iterations is not None and args.resume is None:
        raise SystemExit("--additional-iterations requires --resume")
    if args.additional_iterations is not None and args.additional_iterations < 1:
        raise SystemExit("--additional-iterations must be positive")
    config = _load_config(args)
    if args.dry_run:
        return _dry_run(config, args.device)

    if args.resume is not None:
        output_directory = (
            args.output_dir.resolve()
            if args.output_dir is not None
            else _run_directory_from_resume(args.resume)
        )
        if not output_directory.is_dir():
            raise SystemExit(f"resume run directory does not exist: {output_directory}")
    else:
        output_directory = (
            args.output_dir.resolve()
            if args.output_dir is not None
            else _default_output(config, args.smoke)
        )
        if output_directory.exists() and any(output_directory.iterdir()):
            raise SystemExit(f"refusing to overwrite non-empty run directory: {output_directory}")
        output_directory.mkdir(parents=True, exist_ok=True)
        _atomic_json(output_directory / "resolved_config.json", config.to_dict())

    trainer = AlphaZeroTrainer(config, output_directory, device=args.device)
    restored_from: str | None = None
    if args.resume is not None:
        payload = trainer.resume(
            args.resume,
            strict_source=not args.allow_source_mismatch,
        )
        restored_from = payload["checkpoint_path"]

    target_iterations = config.iterations
    if args.additional_iterations is not None:
        target_iterations = trainer.counters.iteration + args.additional_iterations
    if target_iterations < trainer.counters.iteration:
        raise SystemExit(
            f"target iteration {target_iterations} precedes restored iteration "
            f"{trainer.counters.iteration}"
        )

    run_event = {
        "schema_version": 1,
        "started_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "kind": "smoke" if args.smoke else "training",
        "device": str(torch.device(args.device)),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "model_kind": config.model_kind,
        "observation_mode": config.observation_mode,
        "parameter_count": trainer.model.parameter_count,
        "config": config.to_dict(),
        "full_config_hash": config.fingerprint(),
        "resume_critical_hash": config.fingerprint(resume_critical=True),
        "source_hash": trainer.current_source_hash(),
        "restored_from": restored_from,
        "restored_iteration": trainer.counters.iteration,
        "target_iteration": target_iterations,
    }
    event_name = (
        "run_metadata.json"
        if args.resume is None
        else f"resume_{trainer.counters.iteration:06d}_metadata.json"
    )
    _atomic_json(output_directory / event_name, run_event)

    final_manifest: dict[str, Any] | None = None
    while trainer.counters.iteration < target_iterations:
        metrics = trainer.run_iteration()
        print(json.dumps(metrics, sort_keys=True))
        if trainer.counters.iteration % config.checkpoint_every == 0:
            final_manifest = trainer.save()
    if trainer.counters.iteration > 0 and (
        final_manifest is None
        or int(Path(final_manifest["checkpoint"]).stem.rsplit("_", 1)[-1])
        != trainer.counters.iteration
    ):
        final_manifest = trainer.save()

    summary = {
        "status": "complete",
        "output_directory": str(output_directory.resolve()),
        "model_kind": config.model_kind,
        "observation_mode": config.observation_mode,
        "parameter_count": trainer.model.parameter_count,
        "counters": trainer.counters.to_dict(),
        "buffer_size": len(trainer.replay_buffer),
        "latest_checkpoint": (
            None if final_manifest is None else final_manifest["checkpoint"]
        ),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
