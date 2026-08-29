#!/usr/bin/env python3
"""Evaluate one frozen AlphaZero checkpoint in a replayable arena."""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:
    import torch
except ImportError as exc:
    raise SystemExit(
        "Neural arena evaluation requires PyTorch. Install the train extra."
    ) from exc

from lifeline_rl import AGENT_KINDS, make_agent, run_matchup, write_matchup  # noqa: E402
from lifeline_rl.alphazero.evaluation import (  # noqa: E402
    ArenaGateConfig,
    D13_FORMAL_C_PUCT,
    D13_FORMAL_GAMES,
    D13_FORMAL_GRID_SIZE,
    D13_FORMAL_MAX_PLIES,
    D13_FORMAL_MIN_GRADIENT_STEPS,
    D13_FORMAL_MIN_SELF_PLAY_GAMES,
    D13_FORMAL_MODEL_KIND,
    D13_FORMAL_PUCT_SIMULATIONS,
    D13_FORMAL_SEED,
    D13_FORMAL_SUPERKO_MODE,
    D13_FORMAL_TEMPERATURE,
    EVIDENCE_TIERS,
    GATE_KINDS,
    evaluate_matchup_gate,
    write_gate_report,
)
from lifeline_rl.alphazero.network import MODEL_KINDS  # noqa: E402
from lifeline_rl.alphazero.neural_agent import (  # noqa: E402
    NeuralPUCTAgent,
    NeuralPUCTSearchConfig,
)


def _git_metadata() -> dict[str, object]:
    repository = RESEARCH_ROOT.parents[1]
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repository,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    return {
        "commit": revision.stdout.strip() if revision.returncode == 0 else None,
        "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
    }


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")


def _unique_output(root: Path, stem: str) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    base = root / f"{timestamp}_{_slug(stem)}"
    candidate = base
    suffix = 1
    while candidate.exists():
        candidate = Path(f"{base}_{suffix}")
        suffix += 1
    return candidate


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run a frozen checkpoint against Random/search or another checkpoint, "
            "then emit a replay-verified D13 gate."
        )
    )
    parser.add_argument("--checkpoint-a", type=Path, required=True)
    parser.add_argument("--config-a", type=Path)
    opponent = parser.add_mutually_exclusive_group()
    opponent.add_argument("--checkpoint-b", type=Path)
    opponent.add_argument("--baseline-b", choices=AGENT_KINDS, default="random")
    parser.add_argument("--config-b", type=Path)
    parser.add_argument("--expected-model-kind-a", choices=MODEL_KINDS)
    parser.add_argument("--expected-model-kind-b", choices=MODEL_KINDS)
    parser.add_argument("--expected-source-hash-a")
    parser.add_argument("--expected-source-hash-b")
    parser.add_argument("--allow-source-mismatch", action="store_true")
    parser.add_argument(
        "--allow-superko-mode-override",
        action="store_true",
        help="explicit fixed-checkpoint rules ablation; retained in agent metadata",
    )

    parser.add_argument("--gate-kind", choices=GATE_KINDS, required=True)
    parser.add_argument("--evidence-tier", choices=EVIDENCE_TIERS, required=True)
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--minimum-score-rate", type=float)
    parser.add_argument("--minimum-wilson-lower-exclusive", type=float)
    parser.add_argument("--maximum-truncated-games", type=int, default=0)
    parser.add_argument("--require-pass", action="store_true")

    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--superko-mode", choices=("enforce", "observe"), default="enforce")
    parser.add_argument("--seed", type=int, default=20260826)
    parser.add_argument("--max-plies", type=int, default=200)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--puct-simulations", type=int, default=64)
    parser.add_argument("--c-puct", type=float, default=1.5)
    parser.add_argument("--temperature", type=float, default=0.0)

    parser.add_argument("--minimax-move-cap", type=int, default=20)
    parser.add_argument("--mcts-simulations", type=int, default=64)
    parser.add_argument("--mcts-rollout-depth", type=int, default=80)
    parser.add_argument("--mcts-exploration", type=float, default=2**0.5)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=RESEARCH_ROOT / "results" / "neural_arena",
    )
    parser.add_argument("--overwrite", action="store_true")
    return parser


def _gate_config(args: argparse.Namespace) -> ArenaGateConfig:
    if args.evidence_tier == "formal":
        if args.minimum_score_rate is not None or args.minimum_wilson_lower_exclusive is not None:
            raise SystemExit("formal gate thresholds are frozen and cannot be overridden")
        if args.maximum_truncated_games != 0:
            raise SystemExit("formal gates require --maximum-truncated-games 0")
        gate = (
            ArenaGateConfig.formal_beat_random()
            if args.gate_kind == "beat_random"
            else ArenaGateConfig.formal_promotion()
        )
        if args.games != gate.games_required:
            raise SystemExit("formal gates require --games 200")
        return gate
    return ArenaGateConfig.exploratory(
        gate_kind=args.gate_kind,
        evidence_tier=args.evidence_tier,
        games=args.games,
        maximum_truncated_games=args.maximum_truncated_games,
        minimum_score_rate=args.minimum_score_rate,
        minimum_wilson_lower_bound_exclusive=args.minimum_wilson_lower_exclusive,
    )


def _validate_formal_protocol_args(args: argparse.Namespace) -> None:
    """Reject any CLI relaxation of the frozen formal inference protocol."""

    if args.evidence_tier != "formal":
        return
    if args.overwrite:
        raise SystemExit("formal evaluation artifacts are immutable; --overwrite is forbidden")
    if args.expected_source_hash_a is not None or args.expected_source_hash_b is not None:
        raise SystemExit(
            "formal evaluation binds checkpoints to the current source; explicit "
            "--expected-source-hash overrides are forbidden"
        )
    if args.gate_kind != "beat_random":
        return
    expected = {
        "games": D13_FORMAL_GAMES,
        "grid_size": D13_FORMAL_GRID_SIZE,
        "max_plies": D13_FORMAL_MAX_PLIES,
        "seed": D13_FORMAL_SEED,
        "superko_mode": D13_FORMAL_SUPERKO_MODE,
        "puct_simulations": D13_FORMAL_PUCT_SIMULATIONS,
        "c_puct": D13_FORMAL_C_PUCT,
        "temperature": D13_FORMAL_TEMPERATURE,
    }
    mismatches = [
        name for name, required in expected.items()
        if getattr(args, name) != required
    ]
    if args.expected_model_kind_a not in (None, D13_FORMAL_MODEL_KIND):
        mismatches.append("expected_model_kind_a")
    if mismatches:
        raise SystemExit(
            "D13 formal beat-random protocol is frozen; mismatched arguments: "
            + ", ".join(mismatches)
        )


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    gate_config = _gate_config(args)
    _validate_formal_protocol_args(args)
    if args.evidence_tier == "formal" and args.temperature != 0.0:
        raise SystemExit("formal evaluation requires --temperature 0")
    if args.evidence_tier == "formal" and args.allow_source_mismatch:
        raise SystemExit("formal evaluation requires strict checkpoint source validation")
    if args.evidence_tier == "formal" and args.allow_superko_mode_override:
        raise SystemExit(
            "D13 formal gates require training/evaluation rule match; use a "
            "separately labelled rules-ablation protocol for overrides"
        )
    if args.gate_kind == "beat_random" and (
        args.checkpoint_b is not None or args.baseline_b != "random"
    ):
        raise SystemExit("beat_random gate requires --baseline-b random")
    if args.gate_kind == "promote_champion" and args.checkpoint_b is None:
        raise SystemExit("promote_champion gate requires --checkpoint-b")
    if args.config_b is not None and args.checkpoint_b is None:
        raise SystemExit("--config-b requires --checkpoint-b")
    if args.expected_model_kind_b is not None and args.checkpoint_b is None:
        raise SystemExit("--expected-model-kind-b requires --checkpoint-b")

    search_config = NeuralPUCTSearchConfig(
        simulations=args.puct_simulations,
        c_puct=args.c_puct,
        temperature=args.temperature,
    )
    strict_source = not args.allow_source_mismatch
    agent_a = NeuralPUCTAgent.from_checkpoint(
        args.checkpoint_a,
        config_path=args.config_a,
        device=args.device,
        search_config=search_config,
        label="candidate" if args.gate_kind == "promote_champion" else None,
        expected_model_kind=args.expected_model_kind_a,
        expected_source_hash=args.expected_source_hash_a,
        strict_source=strict_source,
        allow_superko_mode_override=args.allow_superko_mode_override,
    )
    if args.evidence_tier == "formal" and args.gate_kind == "beat_random":
        identity = agent_a.checkpoint_identity
        if agent_a.config.model_kind != D13_FORMAL_MODEL_KIND:
            raise SystemExit(
                f"D13 formal requires {D13_FORMAL_MODEL_KIND}, got "
                f"{agent_a.config.model_kind}"
            )
        if (
            identity.games_completed is None
            or identity.games_completed < D13_FORMAL_MIN_SELF_PLAY_GAMES
            or identity.gradient_steps is None
            or identity.gradient_steps < D13_FORMAL_MIN_GRADIENT_STEPS
        ):
            raise SystemExit(
                "D13 formal requires a final checkpoint with at least "
                f"{D13_FORMAL_MIN_SELF_PLAY_GAMES} completed self-play games and "
                f"{D13_FORMAL_MIN_GRADIENT_STEPS} gradient steps"
            )

    if args.checkpoint_b is not None:
        agent_b = NeuralPUCTAgent.from_checkpoint(
            args.checkpoint_b,
            config_path=args.config_b,
            device=args.device,
            search_config=search_config,
            label="champion",
            expected_model_kind=args.expected_model_kind_b,
            expected_source_hash=args.expected_source_hash_b,
            strict_source=strict_source,
            allow_superko_mode_override=args.allow_superko_mode_override,
        )
        opponent_kind = "alphazero_checkpoint"
    else:
        agent_b = make_agent(
            args.baseline_b,
            minimax_move_cap=args.minimax_move_cap,
            mcts_simulations=args.mcts_simulations,
            mcts_rollout_depth=args.mcts_rollout_depth,
            mcts_exploration=args.mcts_exploration,
        )
        opponent_kind = args.baseline_b

    result = run_matchup(
        agent_a,
        agent_b,
        games=args.games,
        grid_size=args.grid_size,
        base_seed=args.seed,
        max_plies=args.max_plies,
        superko_mode=args.superko_mode,
    )
    result.summary["agent_kinds"] = {
        "A": "alphazero_checkpoint",
        "B": opponent_kind,
    }
    result.summary["evaluation_protocol"] = {
        "gate_kind": args.gate_kind,
        "evidence_tier": args.evidence_tier,
        "shared_puct_search": search_config.__dict__,
        "root_noise": False,
        "allow_superko_mode_override": args.allow_superko_mode_override,
        "strict_source_validation": strict_source,
    }
    result.summary["runtime"] = {
        "python": sys.version,
        "platform": platform.platform(),
        "torch": torch.__version__,
        "device": str(torch.device(args.device)),
    }
    result.summary["git"] = _git_metadata()

    stem = (
        f"{args.gate_kind}_{args.evidence_tier}_n{args.grid_size}_g{args.games}_"
        f"seed{args.seed}"
    )
    output = args.output_dir or _unique_output(args.output_root, stem)
    result.summary["run_id"] = output.name
    result.summary["artifacts"] = {
        "summary": str((output / "summary.json").resolve()),
        "games": str((output / "games.jsonl").resolve()),
        "csv": str((output / "games.csv").resolve()),
        "gate": str((output / "gate.json").resolve()),
    }
    gate_report = evaluate_matchup_gate(result, gate_config)
    write_matchup(result, output, overwrite=args.overwrite)
    write_gate_report(gate_report, output / "gate.json", overwrite=args.overwrite)

    receipt = {
        "status": "evaluation_complete",
        "output_directory": str(output.resolve()),
        "gate_passed": gate_report["passed"],
        "claim_eligible": gate_report["claim_eligible"],
        "reasons": gate_report["reasons"],
        "observed": gate_report["observed"],
        "checkpoint_a": agent_a.metadata_dict()["checkpoint"],
        "checkpoint_b": (
            None
            if not isinstance(agent_b, NeuralPUCTAgent)
            else agent_b.metadata_dict()["checkpoint"]
        ),
        "artifacts": result.summary["artifacts"],
    }
    print(json.dumps(receipt, indent=2, sort_keys=True, ensure_ascii=False))
    return 2 if args.require_pass and not gate_report["passed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
