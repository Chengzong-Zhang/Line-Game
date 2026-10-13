"""Size-transfer scaffolding: plan, initialize, and probe; never launch training.

Only load trusted local checkpoints. A supplied SHA-256 binds provenance, not
pickle safety. Long-run supervision and strength evaluation are future work.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import torch

from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.checkpoint import canonical_config_hash
from lifeline_rl.alphazero.config import AlphaZeroConfig
from lifeline_rl.alphazero.network import (
    NetworkConfig, TorchPolicyValueEvaluator, build_policy_value_network,
    collate_positions,
)
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

ALL_SIZES = tuple(range(5, 16))
SEEDS = (2026092201, 2026092202, 2026092203)
STAGE_GAMES = (48, 64, 80)  # pilot caps, not a claim of sufficient training
MATCH_FIELDS = ("model_kind", "observation_mode", "hidden_channels",
                "message_passing_layers", "superko_mode")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    """Atomic, flushed writes; callers must exclusively own the new directory."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True,
                      allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_source(path: Path, expected_sha256: str) -> dict:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256):
        raise ValueError("expected SHA-256 must contain 64 hexadecimal characters")
    # Hash and deserialize the same bytes, even if the source is being updated.
    import io
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256.lower():
        raise ValueError("source checkpoint SHA-256 mismatch")
    payload = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=False)
    if payload.get("schema") != {"name": "lifeline-alphazero-checkpoint", "version": 1}:
        raise ValueError("unsupported source checkpoint schema")
    if canonical_config_hash(payload["config"]) != payload.get("config_hash"):
        raise ValueError("source checkpoint config hash mismatch")
    config = AlphaZeroConfig.from_dict(payload["config"])
    model = build_policy_value_network(
        config.model_kind, NetworkConfig(config.hidden_channels, config.message_passing_layers))
    model.load_state_dict(payload["model_state_dict"], strict=True)
    if not all(bool(torch.isfinite(tensor).all())
               for tensor in model.state_dict().values()):
        raise ValueError("source model contains non-finite weights")
    return payload


def source_receipt(path: Path, digest: str, payload: dict) -> dict:
    return {"path": str(path.resolve()), "sha256": digest.lower(),
            "source_hash": payload.get("source_hash"),
            "config_hash": payload["config_hash"],
            "trained_board_sizes": payload["config"]["board_sizes"],
            "counters": payload.get("counters")}


def initialize(config: AlphaZeroConfig, output: Path, *, source: Path | None = None,
               source_sha256: str | None = None, dry_run: bool = False) -> dict:
    if (source is None) != (source_sha256 is None):
        raise ValueError("source checkpoint and SHA-256 must be supplied together")
    payload = load_source(source, source_sha256) if source is not None else None
    if payload is not None:
        old = AlphaZeroConfig.from_dict(payload["config"])
        for name in MATCH_FIELDS:
            if getattr(old, name) != getattr(config, name):
                raise ValueError(f"migration changes {name}; explicit adapter required")
    if output.exists():
        raise FileExistsError(f"refusing existing output directory: {output}")
    receipt = {
        "schema_version": 1, "status": "PREFLIGHT_OK" if dry_run else "INITIALIZED_ONLY",
        "evidence_tier": "draft", "formal_ready": False,
        "initialization": "weights_only" if payload is not None else "random",
        "source": None if payload is None else source_receipt(source, source_sha256, payload),
        "config_hash": config.fingerprint(),
        "current_source_hash": AlphaZeroTrainer.current_source_hash(),
        "initializer_sha256": sha256_file(Path(__file__)),
        "state_policy": "fresh optimizer, replay, counters and RNGs; source weights only",
        "rule_compatibility": "UNVERIFIED; matching superko_mode is not rule equivalence",
        "training_started": False,
    }
    if dry_run:
        return receipt
    # mkdir(exist_ok=False) is an exclusive claim; never reuse partial init output.
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "initialization.json", {**receipt, "status": "INITIALIZING"})
    write_json(output / "resolved_config.json", config.to_dict())
    trainer = AlphaZeroTrainer(config, output, device="cpu")
    if payload is not None:
        trainer.model.load_state_dict(payload["model_state_dict"], strict=True)
    receipt["checkpoint"] = trainer.save()
    # Written last: absence or INITIALIZING means initialization is incomplete.
    write_json(output / "initialization.json", receipt)
    return receipt


def generate_plan(source: Path, digest: str, output: Path) -> dict:
    payload = load_source(source, digest)
    base = AlphaZeroConfig.from_dict(payload["config"])
    tasks = []
    configs = {}
    for seed in SEEDS:
        for arm in ("scratch_all", "transfer_all", "transfer_curriculum"):
            previous = None
            for stage, games in enumerate(STAGE_GAMES, 1):
                sizes = (tuple(range(5, (11, 13, 15)[stage - 1] + 1))
                         if arm == "transfer_curriculum" else ALL_SIZES)
                task_id = f"{arm}.seed{seed}.stage{stage}"
                config = base.with_overrides(
                    seed=seed + 1000 * (stage - 1), board_sizes=sizes,
                    iterations=games, games_per_iteration=1, checkpoint_every=1,
                    puct_simulations=16, max_plies=512, batch_size=32,
                    training_steps_per_iteration=4, learning_rate=1e-4,
                    replay_capacity=50_000,
                )
                config_name = f"{task_id}.json"
                configs[config_name] = config.to_dict()
                tasks.append({
                    "id": task_id, "arm": arm, "replicate_seed": seed, "stage": stage,
                    "config": f"configs/{config_name}", "config_hash": config.fingerprint(),
                    "initialize_from": previous or ("random" if arm == "scratch_all" else "source"),
                    "weights_only": True, "game_attempt_cap": games,
                    "optimizer_step_cap": games * 4,
                    "completed_stage_required": previous is not None,
                })
                previous = task_id
    plan = {
        "schema_version": 1, "status": "DRAFT_NOT_LAUNCH_READY", "formal_ready": False,
        "source": source_receipt(source, digest, payload),
        "generator_sha256": sha256_file(Path(__file__)),
        "training_source_hash": AlphaZeroTrainer.current_source_hash(),
        "evaluation_sizes": list(ALL_SIZES), "replicate_seeds": list(SEEDS),
        "zero_shot": {"initialize_from": "source", "training_games": 0},
        "stage_state_policy": "all trained arms reset optimizer/replay/RNG at every stage; transfer weights only",
        "budget_kind": "equal game-attempt caps, not equal compute; record actual updates and time",
        "per_arm_per_seed_game_attempt_cap": sum(STAGE_GAMES),
        "total_game_attempt_cap": len(SEEDS) * 3 * sum(STAGE_GAMES),
        "tasks": tasks,
        "launch_blockers": [
            "audit source-vs-target rule compatibility",
            "durable per-game/per-update transactions and tested crash recovery",
            "independent supervisor, exclusive worker lock, bounded retries, pause/stop",
            "paired diverse-opening evaluation with durable game receipts and replay verification",
            "calibrate runtime, memory, truncation and approve resource budget",
        ],
    }
    output.mkdir(parents=True, exist_ok=False)
    (output / "configs").mkdir()
    for name, config in configs.items():
        write_json(output / "configs" / name, config)
    write_json(output / "plan.json", plan)
    return plan


def probe(source: Path, digest: str) -> dict:
    """Check actual weights on both start players and one legal successor per size."""
    payload = load_source(source, digest)
    config = AlphaZeroConfig.from_dict(payload["config"])
    model = build_policy_value_network(
        config.model_kind, NetworkConfig(config.hidden_channels, config.message_passing_layers))
    model.load_state_dict(payload["model_state_dict"], strict=True)
    evaluator = TorchPolicyValueEvaluator(model)
    records = []
    for size in ALL_SIZES:
        for start in (Player.BLACK, Player.WHITE):
            game = LifelineGame(size, start_player=start, superko_mode=config.superko_mode)
            for ply in (0, 1):
                if ply:
                    legal = game.legal_moves()
                    if not legal or not game.play_move(sorted(legal)[0]).success:
                        raise RuntimeError("probe could not construct a legal successor")
                result = evaluator.evaluate(game)
                batch = collate_positions([game], config.observation_mode)
                probabilities = torch.tensor(result.priors)
                if len(result.priors) != size * (size + 1) // 2 + 1:
                    raise RuntimeError("action dimension mismatch")
                if not bool(torch.isfinite(probabilities).all()) or bool((probabilities < 0).any()):
                    raise RuntimeError("invalid policy probabilities")
                if abs(sum(result.priors) - 1.0) > 1e-5:
                    raise RuntimeError("policy probabilities do not sum to one")
                if bool((probabilities[~batch.legal_action_mask[0].bool()] != 0).any()):
                    raise RuntimeError("illegal action has nonzero probability")
                if not math.isfinite(result.value) or not -1 <= result.value <= 1:
                    raise RuntimeError("invalid value prediction")
                records.append({"size": size, "start_player": start.value, "ply": ply,
                                "actions": len(result.priors)})
    return {"status": "INFERENCE_PROBE_PASSED", "strength_evaluated": False,
            "rules_verified": False, "formal_ready": False,
            "source": source_receipt(source, digest, payload), "positions": records}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "init", "probe"):
        sub = commands.add_parser(name)
        sub.add_argument("--source-checkpoint", type=Path, required=name != "init")
        sub.add_argument("--source-sha256", required=name != "init")
        if name != "probe":
            sub.add_argument("--output", type=Path, required=True)
        if name == "init":
            sub.add_argument("--config", type=Path, required=True)
            sub.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    torch.set_num_threads(1)
    if args.command == "plan":
        result = generate_plan(args.source_checkpoint, args.source_sha256, args.output)
        result = {"status": result["status"], "plan": str((args.output / "plan.json").resolve()),
                  "tasks": len(result["tasks"]), "training_started": False}
    elif args.command == "probe":
        result = probe(args.source_checkpoint, args.source_sha256)
    else:
        result = initialize(AlphaZeroConfig.load(args.config), args.output,
                            source=args.source_checkpoint, source_sha256=args.source_sha256,
                            dry_run=args.dry_run)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
