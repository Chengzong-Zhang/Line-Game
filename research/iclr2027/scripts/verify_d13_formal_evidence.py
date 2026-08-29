#!/usr/bin/env python3
"""Jointly verify the two D13 formal claims against one frozen checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl.alphazero.evaluation import (  # noqa: E402
    D13_FORMAL_MIN_GRADIENT_STEPS,
    D13_FORMAL_MIN_SELF_PLAY_GAMES,
    D13_FORMAL_MODEL_KIND,
)
from lifeline_rl.alphazero.learning_health import (  # noqa: E402
    LearningHealthConfig,
    evaluate_learning_health,
)
from scripts.verify_neural_arena_results import (  # noqa: E402
    verify_neural_arena_directory,
)


def _read_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read JSON object {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"JSON artifact must be an object: {path}")
    return payload


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_joint_report(report: Mapping[str, Any], path: str | Path) -> Path:
    """Atomically persist one immutable D13 joint-evidence receipt."""

    destination = Path(path)
    if destination.exists():
        raise FileExistsError(f"refusing to overwrite D13 joint report: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                dict(report),
                handle,
                indent=2,
                sort_keys=True,
                ensure_ascii=False,
                allow_nan=False,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def verify_learning_health_report(path: str | Path) -> dict[str, Any]:
    """Recompute a saved formal learning-health report from checkpoint bytes."""

    saved = _read_object(Path(path).resolve())
    checkpoint = saved.get("checkpoint")
    if not isinstance(checkpoint, Mapping) or not isinstance(checkpoint.get("path"), str):
        raise ValueError("learning-health report has no checkpoint path")
    recomputed = evaluate_learning_health(
        checkpoint["path"],
        LearningHealthConfig(),
        strict_source=True,
    )
    if recomputed != saved:
        raise ValueError("learning-health report does not match strict recomputation")
    return recomputed


def validate_d13_joint_evidence(
    learning_report: Mapping[str, Any],
    arena_verification: Mapping[str, Any],
) -> dict[str, Any]:
    """Require both formal gates to identify the same Topology checkpoint."""

    if (
        learning_report.get("evidence_tier") != "formal"
        or learning_report.get("passed") is not True
        or learning_report.get("claim_eligible") is not True
    ):
        raise ValueError("D13 learning-health evidence is not formal and claim-eligible")
    checkpoint = learning_report.get("checkpoint")
    observed = learning_report.get("observed")
    if not isinstance(checkpoint, Mapping) or not isinstance(observed, Mapping):
        raise ValueError("D13 learning-health checkpoint identity is missing")
    if checkpoint.get("strict_source_verified") is not True:
        raise ValueError("D13 learning-health source was not strictly verified")
    if observed.get("model_kind") != D13_FORMAL_MODEL_KIND:
        raise ValueError("D13 learning-health model is not topology_gnn")
    if (
        not isinstance(observed.get("games_completed"), int)
        or isinstance(observed.get("games_completed"), bool)
        or observed["games_completed"] < D13_FORMAL_MIN_SELF_PLAY_GAMES
        or not isinstance(observed.get("gradient_steps"), int)
        or isinstance(observed.get("gradient_steps"), bool)
        or observed["gradient_steps"] < D13_FORMAL_MIN_GRADIENT_STEPS
    ):
        raise ValueError("D13 learning-health checkpoint is not training-ready")

    if (
        arena_verification.get("evidence_tier") != "formal"
        or arena_verification.get("gate_kind") != "beat_random"
        or arena_verification.get("gate_passed") is not True
        or arena_verification.get("claim_eligible") is not True
        or arena_verification.get("checkpoint_file_verification_skipped") is not False
    ):
        raise ValueError("D13 arena evidence is not strict formal beat-random evidence")
    identities = arena_verification.get("checkpoint_identities")
    arena_checkpoint = identities.get("A") if isinstance(identities, Mapping) else None
    if not isinstance(arena_checkpoint, Mapping):
        raise ValueError("D13 arena candidate checkpoint identity is missing")
    if arena_checkpoint.get("model_kind") != D13_FORMAL_MODEL_KIND:
        raise ValueError("D13 arena candidate is not topology_gnn")

    learning_sha = checkpoint.get("sha256")
    arena_sha = arena_checkpoint.get("sha256")
    learning_source = checkpoint.get("source_hash")
    arena_source = arena_checkpoint.get("source_hash")
    if learning_sha != arena_sha:
        raise ValueError("D13 learning and arena reports use different checkpoint SHA-256")
    if learning_source != arena_source:
        raise ValueError("D13 learning and arena reports use different source hashes")
    return {
        "schema": {"name": "lifeline-d13-joint-evidence", "version": 1},
        "status": "PASS",
        "claim_eligible": True,
        "model_kind": D13_FORMAL_MODEL_KIND,
        "checkpoint_sha256": learning_sha,
        "source_hash": learning_source,
        "games_completed": observed["games_completed"],
        "gradient_steps": observed["gradient_steps"],
        "arena_games_replayed": arena_verification.get("games_replayed"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--learning-health", type=Path, required=True)
    parser.add_argument("--arena-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    learning = verify_learning_health_report(args.learning_health)
    arena = verify_neural_arena_directory(
        args.arena_dir,
        skip_checkpoint_files=False,
    )
    result = validate_d13_joint_evidence(learning, arena)
    learning_path = args.learning_health.resolve()
    arena_root = args.arena_dir.resolve()
    result["artifact_binding"] = {
        "learning_health": {
            "path": str(learning_path),
            "sha256": _sha256_file(learning_path),
        },
        "arena_summary": {
            "path": str(arena_root / "summary.json"),
            "sha256": _sha256_file(arena_root / "summary.json"),
        },
        "arena_games": {
            "path": str(arena_root / "games.jsonl"),
            "sha256": _sha256_file(arena_root / "games.jsonl"),
        },
        "arena_gate": {
            "path": str(arena_root / "gate.json"),
            "sha256": _sha256_file(arena_root / "gate.json"),
        },
    }
    result["verifier_binding"] = {
        "joint_verifier_sha256": _sha256_file(Path(__file__).resolve()),
        "arena_verifier_sha256": _sha256_file(
            RESEARCH_ROOT / "scripts" / "verify_neural_arena_results.py"
        ),
        "arena_runner_sha256": _sha256_file(
            RESEARCH_ROOT / "scripts" / "run_neural_arena.py"
        ),
        "learning_verifier_sha256": _sha256_file(
            RESEARCH_ROOT / "scripts" / "verify_topology_learning.py"
        ),
        "evaluation_source_sha256": _sha256_file(
            RESEARCH_ROOT / "lifeline_rl" / "alphazero" / "evaluation.py"
        ),
        "learning_health_source_sha256": _sha256_file(
            RESEARCH_ROOT / "lifeline_rl" / "alphazero" / "learning_health.py"
        ),
        "checkpoint_source_hash": result["source_hash"],
    }
    write_joint_report(result, args.output)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
