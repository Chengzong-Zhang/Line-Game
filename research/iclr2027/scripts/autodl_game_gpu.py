#!/usr/bin/env python3
"""Readiness, CUDA saturation smoke, and remote benchmark for Game AutoDL v2."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:
    import torch
    from torch import nn
except ImportError as exc:
    raise SystemExit("Game AutoDL GPU path requires PyTorch >= 2.3") from exc

from lifeline_rl.alphazero.network import (
    NetworkConfig,
    TensorBatch,
    build_policy_value_network,
    collate_positions,
)
from lifeline_rl.alphazero.puct import PUCTConfig
from lifeline_rl.alphazero.self_play import SelfPlayConfig
from lifeline_rl.core import LifelineGame, Player
from lifeline_rl_autodl import (
    BatchedPUCTSearch,
    BatchedTorchPolicyValueEvaluator,
    play_multi_actor_self_play,
)


DEFAULT_CONFIG = RESEARCH_ROOT / "configs" / "autodl_game_gpu_v2.json"
DEFAULT_FIXTURE = RESEARCH_ROOT / "state_aliasing" / "pairs_v1.json"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Local readiness and paid-instance smoke for Game AutoDL v2"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    readiness = subparsers.add_parser(
        "readiness",
        help="CPU-only real-fixture parse/model/batched-forward check",
    )
    readiness.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    readiness.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)

    smoke = subparsers.add_parser(
        "gpu-smoke",
        help="15-30 second real CUDA forward/backward and batched-PUCT calibration",
    )
    smoke.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    smoke.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    smoke.add_argument("--seconds", type=float, default=20.0)
    smoke.add_argument("--profile-output", type=Path, required=True)

    benchmark = subparsers.add_parser(
        "remote-benchmark",
        help="bounded multi-actor self-play using the smoke-selected profile",
    )
    benchmark.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    benchmark.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    benchmark.add_argument("--throughput-profile", type=Path, required=True)
    benchmark.add_argument("--output", type=Path, required=True)
    benchmark.add_argument("--games", type=int, default=16)
    benchmark.add_argument("--max-plies", type=int, default=48)
    benchmark.add_argument("--training-seconds", type=float, default=30.0)
    return parser


def _load_config(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema_version",
        "model_kind",
        "observation_mode",
        "hidden_channels",
        "message_passing_layers",
        "actor_candidates",
        "training_batch_candidates",
        "puct_simulations",
        "max_plies",
        "seed",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise ValueError("AutoDL GPU config keys do not match schema v1")
    if payload["schema_version"] != 1:
        raise ValueError("unsupported AutoDL GPU config schema")
    for key in ("actor_candidates", "training_batch_candidates"):
        candidates = payload[key]
        if (
            not isinstance(candidates, list)
            or not candidates
            or any(
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 1
                for value in candidates
            )
            or candidates != sorted(set(candidates))
        ):
            raise ValueError(f"{key} must be sorted unique positive integers")
    return payload


def _replay_history(grid_size: int, history: list[Any]) -> LifelineGame:
    game = LifelineGame(grid_size)
    for raw_action in history:
        result = (
            game.skip_turn()
            if raw_action is None
            else game.play_move((int(raw_action[0]), int(raw_action[1])))
        )
        if not result.success:
            raise ValueError(f"fixture history contains illegal action: {result.reason}")
    if game.game_over:
        raise ValueError("readiness fixture must end at a non-terminal state")
    return game


def _load_real_states(path: Path) -> tuple[LifelineGame, ...]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("dataset_id") != "lifeline_rl_state_aliasing_pairs":
        raise ValueError("unexpected readiness fixture dataset")
    states: list[LifelineGame] = []
    for pair in payload.get("pairs", ()):
        size = int(pair["grid_size"])
        for key in ("history_a", "history_b"):
            states.append(_replay_history(size, pair[key]))
    if not states:
        raise ValueError("readiness fixture contains no replayable states")
    return tuple(states)


def _clone_game(game: LifelineGame) -> LifelineGame:
    clone = LifelineGame(
        game.grid_size,
        start_player=game.start_player,
        superko_mode=game.superko_mode,
    )
    clone.restore(game.clone())
    return clone


def _actor_states(
    states: tuple[LifelineGame, ...],
    count: int,
) -> tuple[LifelineGame, ...]:
    return tuple(_clone_game(states[index % len(states)]) for index in range(count))


def _build_model(config: dict[str, Any], device: torch.device) -> nn.Module:
    return build_policy_value_network(
        config["model_kind"],
        NetworkConfig(
            hidden_channels=int(config["hidden_channels"]),
            message_passing_layers=int(config["message_passing_layers"]),
        ),
    ).to(device)


def _validate_predictions(
    games: tuple[LifelineGame, ...],
    predictions: tuple[Any, ...],
) -> None:
    if len(predictions) != len(games):
        raise RuntimeError("batched evaluator returned the wrong row count")
    for game, prediction in zip(games, predictions):
        if len(prediction.priors) != game.num_points + 1:
            raise RuntimeError("mixed-size PASS relocation produced a wrong action shape")
        if not math.isclose(sum(prediction.priors), 1.0, rel_tol=1e-5, abs_tol=1e-5):
            raise RuntimeError("batched priors do not sum to one")
        if not -1.0 <= float(prediction.value) <= 1.0:
            raise RuntimeError("batched value is outside [-1, 1]")


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _readiness(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    config = _load_config(args.config)
    states = _load_real_states(args.fixture)
    games = _actor_states(states, min(4, len(states)))
    device = torch.device("cpu")
    torch.manual_seed(int(config["seed"]))
    model = _build_model(config, device)
    evaluator = BatchedTorchPolicyValueEvaluator(
        model,
        config["observation_mode"],
        device,
    )
    predictions = evaluator.evaluate_batch(games)
    _validate_predictions(games, predictions)
    snapshots = tuple(game.clone() for game in games)
    search = BatchedPUCTSearch(
        evaluator,
        PUCTConfig(
            simulations=2,
            dirichlet_epsilon=0.0,
        ),
    )
    results = search.search_batch(
        games,
        tuple(random.Random(int(config["seed"]) + index) for index in range(len(games))),
        temperatures=(0.0,) * len(games),
        add_root_noise=False,
    )
    if any(game.clone() != snapshot for game, snapshot in zip(games, snapshots)):
        raise RuntimeError("batched readiness search mutated an input game")
    payload = {
        "status": "readiness_ok",
        "device": "cpu",
        "duration_seconds": time.perf_counter() - started,
        "fixture": str(args.fixture.resolve()),
        "real_states_parsed": len(states),
        "mixed_sizes": sorted({game.grid_size for game in games}),
        "batch_size": len(games),
        "model_kind": config["model_kind"],
        "parameter_count": int(getattr(model, "parameter_count")),
        "prediction_action_shapes": [len(item.priors) for item in predictions],
        "search_root_visits": [sum(item.visits) for item in results],
        "torch_version": torch.__version__,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def _synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def _time_batch_inference(
    model: nn.Module,
    config: dict[str, Any],
    games: tuple[LifelineGame, ...],
    *,
    use_amp: bool,
    repeats: int = 3,
) -> float:
    evaluator = BatchedTorchPolicyValueEvaluator(
        model,
        config["observation_mode"],
        "cuda",
        use_amp=use_amp,
    )
    evaluator.evaluate_batch(games)
    _synchronize(torch.device("cuda"))
    started = time.perf_counter()
    for _ in range(repeats):
        evaluator.evaluate_batch(games)
    _synchronize(torch.device("cuda"))
    return len(games) * repeats / (time.perf_counter() - started)


def _training_experiences(games: tuple[LifelineGame, ...]) -> tuple[Any, ...]:
    experiences: list[Any] = []
    for index, game in enumerate(games):
        legal_points = set(game.legal_moves())
        legal_mask = tuple(
            int(point in legal_points) for point in game.valid_positions
        ) + (1,)
        visits = tuple(int(legal) for legal in legal_mask)
        experiences.append(
            SimpleNamespace(
                grid_size=game.grid_size,
                board=tuple(game.grid),
                physical_edges=game.physical_edges,
                logical_edges=(
                    tuple(sorted(game.edges[Player.BLACK])),
                    tuple(sorted(game.edges[Player.WHITE])),
                ),
                current_player=game.current_player.value,
                consecutive_skips=game.consecutive_skips,
                legal_action_mask=legal_mask,
                root_visits=visits,
                z=1.0 if index % 2 else -1.0,
            )
        )
    return tuple(experiences)


def _optimizer_step(
    model: nn.Module,
    config: dict[str, Any],
    games: tuple[LifelineGame, ...],
    *,
    use_amp: bool,
    optimizer: torch.optim.Optimizer,
    scaler: torch.amp.GradScaler,
) -> dict[str, float]:
    started_collate = time.perf_counter()
    batch = collate_positions(
        _training_experiences(games),
        config["observation_mode"],
        device="cuda",
    )
    collate_seconds = time.perf_counter() - started_collate
    metrics = _optimizer_step_batch(
        model,
        batch,
        use_amp=use_amp,
        optimizer=optimizer,
        scaler=scaler,
    )
    metrics["collate_seconds"] = collate_seconds
    return metrics


def _optimizer_step_batch(
    model: nn.Module,
    batch: TensorBatch,
    *,
    use_amp: bool,
    optimizer: torch.optim.Optimizer,
    scaler: torch.amp.GradScaler,
) -> dict[str, float]:
    model.train()
    _synchronize(torch.device("cuda"))
    started_step = time.perf_counter()
    optimizer.zero_grad(set_to_none=True)
    with torch.autocast(
        device_type="cuda",
        dtype=torch.bfloat16,
        enabled=use_amp,
    ):
        logits, values = model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )
        policy_loss = -(
            batch.policy_targets * torch.log_softmax(logits, dim=1)
        ).sum(dim=1).mean()
        value_loss = torch.mean((values - batch.value_targets) ** 2)
        loss = policy_loss + value_loss
    if not bool(torch.isfinite(loss)):
        raise FloatingPointError("non-finite CUDA smoke loss")
    scaler.scale(loss).backward()
    scaler.unscale_(optimizer)
    gradient_norm = nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    if not math.isfinite(float(gradient_norm)):
        raise FloatingPointError("non-finite CUDA smoke gradient norm")
    scaler.step(optimizer)
    scaler.update()
    _synchronize(torch.device("cuda"))
    return {
        "optimizer_step_seconds": time.perf_counter() - started_step,
        "loss": float(loss.detach().float().cpu()),
        "gradient_norm": float(gradient_norm),
    }


def _repeat_rows(tensor: torch.Tensor, rows: int) -> torch.Tensor:
    repeats = [math.ceil(rows / int(tensor.shape[0]))] + [1] * (tensor.ndim - 1)
    return tensor.repeat(*repeats)[:rows].contiguous()


def _training_batch(
    games: tuple[LifelineGame, ...],
    config: dict[str, Any],
    rows: int,
) -> TensorBatch:
    base = collate_positions(
        _training_experiences(games),
        config["observation_mode"],
        device="cuda",
    )
    if base.policy_targets is None or base.value_targets is None:
        raise RuntimeError("training batch lost replay targets")
    return TensorBatch(
        node_features=_repeat_rows(base.node_features, rows),
        adjacency=_repeat_rows(base.adjacency, rows),
        node_mask=_repeat_rows(base.node_mask, rows),
        legal_action_mask=_repeat_rows(base.legal_action_mask, rows),
        policy_targets=_repeat_rows(base.policy_targets, rows),
        value_targets=_repeat_rows(base.value_targets, rows),
    )


def _adamw(model: nn.Module) -> torch.optim.Optimizer:
    try:
        return torch.optim.AdamW(model.parameters(), lr=1e-3, fused=True)
    except (RuntimeError, TypeError):
        return torch.optim.AdamW(model.parameters(), lr=1e-3)


def _gpu_smoke(args: argparse.Namespace) -> int:
    if not 15.0 <= args.seconds <= 30.0:
        raise SystemExit("--seconds must be between 15 and 30")
    if not torch.cuda.is_available():
        raise SystemExit("CUDA smoke requires torch.cuda.is_available() == True")
    config = _load_config(args.config)
    states = _load_real_states(args.fixture)
    device = torch.device("cuda")
    torch.set_float32_matmul_precision("high")
    torch.manual_seed(int(config["seed"]))
    torch.cuda.manual_seed_all(int(config["seed"]))
    model = _build_model(config, device)
    torch.cuda.reset_peak_memory_stats(device)

    smallest = int(config["actor_candidates"][0])
    probe_games = _actor_states(states, smallest)
    fp32_rate = _time_batch_inference(
        model, config, probe_games, use_amp=False
    )
    amp_rate = _time_batch_inference(
        model, config, probe_games, use_amp=True
    )
    use_amp = amp_rate >= fp32_rate

    optimizer = _adamw(model)
    # BF16 keeps Tensor Core throughput without FP16 gradient scaling overflow.
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    actor_calibration: list[dict[str, Any]] = []
    best: tuple[float, int] | None = None
    for actor_count in config["actor_candidates"]:
        games = _actor_states(states, int(actor_count))
        try:
            torch.cuda.reset_peak_memory_stats(device)
            rate = _time_batch_inference(
                model,
                config,
                games,
                use_amp=use_amp,
                repeats=2,
            )
            training_metrics = _optimizer_step(
                model,
                config,
                games,
                use_amp=use_amp,
                optimizer=optimizer,
                scaler=scaler,
            )
            memory_gb = torch.cuda.max_memory_allocated(device) / (1024**3)
            actor_calibration.append(
                {
                    "actor_count": int(actor_count),
                    "positions_per_second": rate,
                    "peak_allocated_gb": memory_gb,
                    "training_step": training_metrics,
                    "status": "ok",
                }
            )
            if best is None or rate > best[0]:
                best = (rate, int(actor_count))
        except torch.cuda.OutOfMemoryError:
            optimizer.zero_grad(set_to_none=True)
            torch.cuda.empty_cache()
            actor_calibration.append(
                {"actor_count": int(actor_count), "status": "cuda_oom"}
            )
            break
    if best is None:
        raise RuntimeError("no actor candidate fit in CUDA memory")
    actor_count = best[1]
    games = _actor_states(states, actor_count)

    training_calibration: list[dict[str, Any]] = []
    best_training: tuple[float, int] | None = None
    for batch_size in config["training_batch_candidates"]:
        batch: TensorBatch | None = None
        try:
            torch.cuda.reset_peak_memory_stats(device)
            prepared_at = time.perf_counter()
            batch = _training_batch(games, config, int(batch_size))
            batch_prepare_seconds = time.perf_counter() - prepared_at
            _optimizer_step_batch(
                model,
                batch,
                use_amp=True,
                optimizer=optimizer,
                scaler=scaler,
            )
            timed_at = time.perf_counter()
            last_metrics: dict[str, float] | None = None
            for _ in range(2):
                last_metrics = _optimizer_step_batch(
                    model,
                    batch,
                    use_amp=True,
                    optimizer=optimizer,
                    scaler=scaler,
                )
            timed_seconds = time.perf_counter() - timed_at
            rate = 2 * int(batch_size) / timed_seconds
            memory_gb = torch.cuda.max_memory_allocated(device) / (1024**3)
            training_calibration.append(
                {
                    "batch_size": int(batch_size),
                    "examples_per_second": rate,
                    "batch_prepare_seconds": batch_prepare_seconds,
                    "optimizer_step_seconds": (
                        None if last_metrics is None else last_metrics["optimizer_step_seconds"]
                    ),
                    "peak_allocated_gb": memory_gb,
                    "status": "ok",
                }
            )
            if best_training is None or rate > best_training[0]:
                best_training = (rate, int(batch_size))
        except torch.cuda.OutOfMemoryError:
            optimizer.zero_grad(set_to_none=True)
            training_calibration.append(
                {"batch_size": int(batch_size), "status": "cuda_oom"}
            )
            break
        finally:
            del batch
            torch.cuda.empty_cache()
    if best_training is None:
        raise RuntimeError("no replay training batch fit in CUDA memory")
    training_batch_size = best_training[1]
    prepared_at = time.perf_counter()
    training_batch = _training_batch(games, config, training_batch_size)
    training_batch_prepare_seconds = time.perf_counter() - prepared_at

    evaluator = BatchedTorchPolicyValueEvaluator(
        model,
        config["observation_mode"],
        device,
        use_amp=use_amp,
    )
    search = BatchedPUCTSearch(
        evaluator,
        PUCTConfig(
            simulations=int(config["puct_simulations"]),
            dirichlet_epsilon=0.0,
        ),
    )
    rngs = tuple(
        random.Random(int(config["seed"]) + index)
        for index in range(actor_count)
    )
    results = search.search_batch(
        games,
        rngs,
        temperatures=(0.0,) * actor_count,
        add_root_noise=False,
    )
    if any(
        sum(result.visits) != int(config["puct_simulations"])
        for result in results
    ):
        raise RuntimeError("batched PUCT smoke lost simulations")
    started = time.perf_counter()
    search_calls = 1
    optimizer_steps = 0
    optimizer_step_seconds = 0.0
    last_training_metrics: dict[str, float] | None = None
    while time.perf_counter() - started < args.seconds:
        last_training_metrics = _optimizer_step_batch(
            model,
            training_batch,
            use_amp=True,
            optimizer=optimizer,
            scaler=scaler,
        )
        optimizer_step_seconds += last_training_metrics["optimizer_step_seconds"]
        optimizer_steps += 1
    _synchronize(device)
    elapsed = time.perf_counter() - started
    if optimizer_steps < 1 or last_training_metrics is None:
        raise RuntimeError("CUDA smoke did not complete an optimizer step")
    profile = {
        "schema_version": 2,
        "status": "gpu_smoke_ok",
        "device_name": torch.cuda.get_device_name(device),
        "torch_version": torch.__version__,
        "cuda_runtime": torch.version.cuda,
        "model_kind": config["model_kind"],
        "parameter_count": int(getattr(model, "parameter_count")),
        "chosen_actor_count": actor_count,
        "inference_amp": use_amp,
        "chosen_training_batch_size": training_batch_size,
        "training_amp": True,
        "training_precision": "bfloat16",
        "fp32_probe_positions_per_second": fp32_rate,
        "amp_probe_positions_per_second": amp_rate,
        "actor_calibration": actor_calibration,
        "training_calibration": training_calibration,
        "sustained_seconds": elapsed,
        "sustained_search_calls": search_calls,
        "sustained_optimizer_steps": optimizer_steps,
        "sustained_actor_searches": search_calls * actor_count,
        "sustained_training_examples": optimizer_steps * training_batch_size,
        "training_batch_prepare_seconds": training_batch_prepare_seconds,
        "sustained_optimizer_step_seconds": optimizer_step_seconds,
        "sustained_training_examples_per_second": (
            optimizer_steps * training_batch_size / elapsed
        ),
        "sustained_last_loss": last_training_metrics["loss"],
        "sustained_last_gradient_norm": last_training_metrics["gradient_norm"],
        "puct_simulations": int(config["puct_simulations"]),
        "peak_allocated_gb": torch.cuda.max_memory_allocated(device) / (1024**3),
        "profile_path": str(args.profile_output),
    }
    _atomic_json(args.profile_output, profile)
    print(json.dumps(profile, indent=2, sort_keys=True))
    return 0


def _remote_benchmark(args: argparse.Namespace) -> int:
    if not torch.cuda.is_available():
        raise SystemExit("remote benchmark requires CUDA")
    if args.games < 1 or args.max_plies < 1 or args.training_seconds < 5.0:
        raise SystemExit("--games/--max-plies must be positive and training must be >= 5s")
    config = _load_config(args.config)
    profile = json.loads(args.throughput_profile.read_text(encoding="utf-8"))
    if profile.get("status") != "gpu_smoke_ok":
        raise ValueError("throughput profile is not a successful GPU smoke")
    actor_count = min(int(profile["chosen_actor_count"]), args.games)
    use_amp = bool(profile["inference_amp"])
    device = torch.device("cuda")
    torch.set_float32_matmul_precision("high")
    torch.manual_seed(int(config["seed"]))
    torch.cuda.manual_seed_all(int(config["seed"]))
    torch.cuda.reset_peak_memory_stats(device)
    model = _build_model(config, device)
    evaluator = BatchedTorchPolicyValueEvaluator(
        model,
        config["observation_mode"],
        device,
        use_amp=use_amp,
    )
    search = BatchedPUCTSearch(
        evaluator,
        PUCTConfig(
            simulations=int(config["puct_simulations"]),
            dirichlet_epsilon=0.0,
        ),
    )
    self_play = SelfPlayConfig(
        grid_size=9,
        max_plies=args.max_plies,
        temperature_moves=args.max_plies,
        initial_temperature=1.0,
        final_temperature=1.0,
        observation_mode=config["observation_mode"],
        add_root_noise=False,
    )
    self_play_started = time.perf_counter()
    results = play_multi_actor_self_play(
        search,
        (self_play,) * actor_count,
        tuple(int(config["seed"]) + index for index in range(actor_count)),
    )
    _synchronize(device)
    self_play_seconds = time.perf_counter() - self_play_started

    states = _load_real_states(args.fixture)
    replay_games = _actor_states(states, max(1, min(128, actor_count)))
    training_batch_size = int(profile["chosen_training_batch_size"])
    batch_prepared_at = time.perf_counter()
    training_batch = _training_batch(replay_games, config, training_batch_size)
    batch_prepare_seconds = time.perf_counter() - batch_prepared_at
    optimizer = _adamw(model)
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    training_started = time.perf_counter()
    training_steps = 0
    last_training_metrics: dict[str, float] | None = None
    while time.perf_counter() - training_started < args.training_seconds:
        last_training_metrics = _optimizer_step_batch(
            model,
            training_batch,
            use_amp=bool(profile["training_amp"]),
            optimizer=optimizer,
            scaler=scaler,
        )
        training_steps += 1
    _synchronize(device)
    training_seconds = time.perf_counter() - training_started
    if training_steps < 1 or last_training_metrics is None:
        raise RuntimeError("remote benchmark completed no replay training step")
    payload = {
        "schema_version": 2,
        "status": "remote_benchmark_ok",
        "actor_count": actor_count,
        "inference_amp": use_amp,
        "games_completed": sum(result.terminated for result in results),
        "games_truncated": sum(result.truncated for result in results),
        "total_plies": sum(result.plies for result in results),
        "self_play_seconds": self_play_seconds,
        "actor_plies_per_second": (
            sum(result.plies for result in results) / self_play_seconds
        ),
        "puct_simulations": int(config["puct_simulations"]),
        "training_source": "replicated_real_fixture_for_throughput_only",
        "training_batch_size": training_batch_size,
        "training_amp": bool(profile["training_amp"]),
        "training_precision": str(profile.get("training_precision", "bfloat16")),
        "training_batch_prepare_seconds": batch_prepare_seconds,
        "training_seconds": training_seconds,
        "training_steps": training_steps,
        "training_examples": training_steps * training_batch_size,
        "training_examples_per_second": (
            training_steps * training_batch_size / training_seconds
        ),
        "last_training_loss": last_training_metrics["loss"],
        "last_gradient_norm": last_training_metrics["gradient_norm"],
        "elapsed_seconds": self_play_seconds + training_seconds,
        "device_name": torch.cuda.get_device_name(device),
        "peak_allocated_gb": torch.cuda.max_memory_allocated(device) / (1024**3),
    }
    _atomic_json(args.output, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "readiness":
        return _readiness(args)
    if args.command == "gpu-smoke":
        return _gpu_smoke(args)
    if args.command == "remote-benchmark":
        return _remote_benchmark(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
