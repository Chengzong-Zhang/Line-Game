#!/usr/bin/env python3
"""Freeze, generate, validate, and aggregate the D14--D16 experiment matrix.

The script is intentionally independent of the model and trainer modules.  It
turns a versioned JSON manifest into deterministic task ledgers and refuses to
aggregate incomplete, mixed-tier, compute-mismatched, or non-color-balanced
formal evidence.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import math
import os
import random
import statistics
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_NAME = "lifeline-d14-d16-experiment-manifest"
SCHEMA_VERSION = 1
TASK_SCHEMA_NAME = "lifeline-d14-d16-task"
RESULT_SCHEMA_NAME = "lifeline-d14-d16-result"
FORMAL_REPRESENTATIONS = ("padded_cnn", "grid_gnn", "topology_gnn")
FORMAL_TRAIN_SIZES = (5, 7, 9)
FORMAL_SEARCH_AGENT_KINDS = ("random", "greedy", "minimax-2", "minimax-3", "mcts")
EVIDENCE_TIERS = ("smoke", "pilot", "formal")


class ProtocolError(ValueError):
    """Raised when an artifact cannot support the declared experiment tier."""


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _positive_int(value: object, path: str) -> int:
    if not _is_int(value) or int(value) < 1:
        raise ProtocolError(f"{path} must be a positive integer")
    return int(value)


def _non_negative_int(value: object, path: str) -> int:
    if not _is_int(value) or int(value) < 0:
        raise ProtocolError(f"{path} must be a non-negative integer")
    return int(value)


def _mapping(value: object, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProtocolError(f"{path} must be a JSON object")
    return value


def _sequence(value: object, path: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ProtocolError(f"{path} must be a JSON array")
    return value


def _unique_strings(value: object, path: str) -> list[str]:
    items = _sequence(value, path)
    if not items or any(not isinstance(item, str) or not item for item in items):
        raise ProtocolError(f"{path} must contain non-empty strings")
    strings = list(items)
    if len(strings) != len(set(strings)):
        raise ProtocolError(f"{path} must not contain duplicates")
    return strings


def canonical_json(payload: Mapping[str, Any]) -> str:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def manifest_hash(manifest: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def current_execution_identity() -> dict[str, str]:
    """Return the source identity required for newly aggregated formal evidence."""

    research_root = Path(__file__).resolve().parents[1]
    if str(research_root) not in sys.path:
        sys.path.insert(0, str(research_root))
    try:
        import torch
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
    except ImportError as exc:  # pragma: no cover - formal aggregation uses train env
        raise ProtocolError("formal source verification requires the AlphaZero train environment") from exc
    runner_path = Path(__file__).with_name("run_d14_d16_task_bundle.py")
    if not runner_path.is_file():
        raise ProtocolError(f"D14--D16 runner source is missing: {runner_path}")
    return {
        "trainer_source_hash": AlphaZeroTrainer.current_source_hash(),
        "runner_sha256": _sha256_file(runner_path),
        "protocol_sha256": _sha256_file(Path(__file__).resolve()),
        "torch_version": str(torch.__version__),
    }


def _json_file(path: str | Path, label: str) -> dict[str, Any]:
    candidate = Path(path)
    try:
        payload = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read {label} {candidate}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError(f"{label} must be a JSON object: {candidate}")
    return payload


def load_manifest(path: str | Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read manifest {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError("manifest must be a JSON object")
    validate_manifest(payload)
    return payload


def validate_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the experiment contract and return a compact audit summary."""

    if manifest.get("schema_name") != SCHEMA_NAME:
        raise ProtocolError(f"manifest schema_name must be {SCHEMA_NAME!r}")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ProtocolError(f"manifest schema_version must be {SCHEMA_VERSION}")
    experiment_id = manifest.get("experiment_id")
    if not isinstance(experiment_id, str) or not experiment_id.strip():
        raise ProtocolError("experiment_id must be a non-empty string")
    tier = manifest.get("evidence_tier")
    if tier not in EVIDENCE_TIERS:
        raise ProtocolError(f"evidence_tier must be one of {EVIDENCE_TIERS}")
    if manifest.get("task_scope") != "mixed_size_train_same_size_eval":
        raise ProtocolError(
            "task_scope must be 'mixed_size_train_same_size_eval' for D14--D16"
        )

    representations_raw = _sequence(manifest.get("representations"), "representations")
    representations: list[str] = []
    for index, raw in enumerate(representations_raw):
        entry = _mapping(raw, f"representations[{index}]")
        representation_id = entry.get("id")
        if not isinstance(representation_id, str) or not representation_id:
            raise ProtocolError(f"representations[{index}].id must be non-empty")
        if representation_id in representations:
            raise ProtocolError(f"duplicate representation id {representation_id!r}")
        if not isinstance(entry.get("observation"), str) or not entry.get("observation"):
            raise ProtocolError(f"representations[{index}].observation must be non-empty")
        if not isinstance(entry.get("model_family"), str) or not entry.get("model_family"):
            raise ProtocolError(f"representations[{index}].model_family must be non-empty")
        _positive_int(
            entry.get("expected_trainable_parameters"),
            f"representations[{index}].expected_trainable_parameters",
        )
        _mapping(entry.get("model_config"), f"representations[{index}].model_config")
        representations.append(representation_id)

    train_sizes_raw = _sequence(manifest.get("train_sizes"), "train_sizes")
    train_sizes = [_positive_int(item, f"train_sizes[{index}]") for index, item in enumerate(train_sizes_raw)]
    if len(train_sizes) != len(set(train_sizes)):
        raise ProtocolError("train_sizes must not contain duplicates")
    if any(size not in range(5, 16) for size in train_sizes):
        raise ProtocolError("train_sizes must be in the supported range 5..15")

    seeds_raw = _sequence(manifest.get("seeds"), "seeds")
    seeds = [_non_negative_int(item, f"seeds[{index}]") for index, item in enumerate(seeds_raw)]
    if not seeds:
        raise ProtocolError("seeds must not be empty")
    if len(seeds) != len(set(seeds)):
        raise ProtocolError("seeds must not contain duplicates")

    budget = _mapping(manifest.get("training_budget"), "training_budget")
    required_budget_fields = (
        "puct_simulations",
        "self_play_games",
        "gradient_steps",
        "max_plies",
        "replay_capacity",
        "batch_size",
        "iterations",
        "games_per_iteration",
        "training_steps_per_iteration",
        "checkpoint_every_iterations",
    )
    for field in required_budget_fields:
        _positive_int(budget.get(field), f"training_budget.{field}")
    if int(budget["iterations"]) * int(budget["games_per_iteration"]) != int(
        budget["self_play_games"]
    ):
        raise ProtocolError(
            "iterations * games_per_iteration must equal self_play_games"
        )
    if int(budget["iterations"]) * int(
        budget["training_steps_per_iteration"]
    ) != int(budget["gradient_steps"]):
        raise ProtocolError(
            "iterations * training_steps_per_iteration must equal gradient_steps"
        )
    if int(budget["iterations"]) % int(budget["checkpoint_every_iterations"]):
        raise ProtocolError("checkpoint_every_iterations must divide iterations")
    if int(budget["games_per_iteration"]) * 2 < int(budget["batch_size"]):
        raise ProtocolError(
            "games_per_iteration * 2 must cover batch_size so the first scheduled "
            "optimizer updates cannot be skipped even if every game is two PASSes"
        )
    if budget.get("terminal_reward") != "win_draw_loss_only":
        raise ProtocolError("training_budget.terminal_reward must be 'win_draw_loss_only'")
    if budget.get("superko_mode") != "enforce":
        raise ProtocolError("training_budget.superko_mode must be 'enforce'")
    for field in (
        "c_puct",
        "dirichlet_alpha",
        "initial_temperature",
        "learning_rate",
        "gradient_clip_norm",
    ):
        value = budget.get(field)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or float(value) <= 0.0
        ):
            raise ProtocolError(f"training_budget.{field} must be finite and positive")
    for field in ("dirichlet_epsilon",):
        value = budget.get(field)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0.0 <= float(value) <= 1.0
        ):
            raise ProtocolError(f"training_budget.{field} must be in [0, 1]")
    final_temperature = budget.get("final_temperature")
    if (
        isinstance(final_temperature, bool)
        or not isinstance(final_temperature, (int, float))
        or not math.isfinite(final_temperature)
        or float(final_temperature) < 0.0
    ):
        raise ProtocolError("training_budget.final_temperature must be finite and non-negative")
    weight_decay = budget.get("weight_decay")
    if (
        isinstance(weight_decay, bool)
        or not isinstance(weight_decay, (int, float))
        or not math.isfinite(weight_decay)
        or float(weight_decay) < 0.0
    ):
        raise ProtocolError("training_budget.weight_decay must be finite and non-negative")
    _non_negative_int(
        budget.get("temperature_moves"), "training_budget.temperature_moves"
    )

    evaluation = _mapping(manifest.get("evaluation"), "evaluation")
    curve_games = _positive_int(
        evaluation.get("curve_games_per_matchup"),
        "evaluation.curve_games_per_matchup",
    )
    final_games = _positive_int(
        evaluation.get("final_games_per_matchup"),
        "evaluation.final_games_per_matchup",
    )
    evaluation_max_plies = _positive_int(
        evaluation.get("max_plies"), "evaluation.max_plies"
    )
    if evaluation_max_plies != int(budget["max_plies"]):
        raise ProtocolError("training and evaluation max_plies must match")
    if evaluation.get("superko_mode") != budget.get("superko_mode"):
        raise ProtocolError("training and evaluation Superko modes must match")
    if curve_games < 2 or curve_games % 2:
        raise ProtocolError("evaluation.curve_games_per_matchup must be an even integer >= 2")
    if final_games < 2 or final_games % 2:
        raise ProtocolError("evaluation.final_games_per_matchup must be an even integer >= 2")
    if evaluation.get("color_balance") != "paired_swap_same_seed":
        raise ProtocolError("evaluation.color_balance must be 'paired_swap_same_seed'")
    checkpoints_raw = _sequence(
        evaluation.get("checkpoint_gradient_steps"),
        "evaluation.checkpoint_gradient_steps",
    )
    checkpoints = [
        _positive_int(item, f"evaluation.checkpoint_gradient_steps[{index}]")
        for index, item in enumerate(checkpoints_raw)
    ]
    if checkpoints != sorted(set(checkpoints)):
        raise ProtocolError("checkpoint_gradient_steps must be strictly increasing")
    if not checkpoints or checkpoints[-1] != int(budget["gradient_steps"]):
        raise ProtocolError("the final checkpoint must equal training_budget.gradient_steps")
    expected_checkpoints = [
        iteration * int(budget["training_steps_per_iteration"])
        for iteration in range(
            int(budget["checkpoint_every_iterations"]),
            int(budget["iterations"]) + 1,
            int(budget["checkpoint_every_iterations"]),
        )
    ]
    if checkpoints != expected_checkpoints:
        raise ProtocolError(
            "checkpoint_gradient_steps must exactly map checkpoint iterations to "
            "scheduled gradient steps"
        )
    final_opponents = _unique_strings(
        evaluation.get("final_search_opponents"),
        "evaluation.final_search_opponents",
    )
    curve_opponent = evaluation.get("curve_opponent")
    if not isinstance(curve_opponent, str) or not curve_opponent:
        raise ProtocolError("evaluation.curve_opponent must be non-empty")
    if evaluation.get("representation_round_robin") is not True:
        raise ProtocolError("evaluation.representation_round_robin must be true")

    baselines_raw = _sequence(manifest.get("search_baselines"), "search_baselines")
    baseline_ids: list[str] = []
    baseline_kinds: list[str] = []
    baseline_by_id: dict[str, Mapping[str, Any]] = {}
    for index, raw in enumerate(baselines_raw):
        entry = _mapping(raw, f"search_baselines[{index}]")
        baseline_id = entry.get("id")
        kind = entry.get("agent_kind")
        if not isinstance(baseline_id, str) or not baseline_id:
            raise ProtocolError(f"search_baselines[{index}].id must be non-empty")
        if baseline_id in baseline_by_id:
            raise ProtocolError(f"duplicate search baseline id {baseline_id!r}")
        if not isinstance(kind, str) or not kind:
            raise ProtocolError(f"search_baselines[{index}].agent_kind must be non-empty")
        _mapping(entry.get("config", {}), f"search_baselines[{index}].config")
        baseline_ids.append(baseline_id)
        baseline_kinds.append(kind)
        baseline_by_id[baseline_id] = entry
    if curve_opponent not in baseline_by_id:
        raise ProtocolError("evaluation.curve_opponent is not a declared search baseline")
    if any(item not in baseline_by_id for item in final_opponents):
        raise ProtocolError("every final_search_opponent must be a declared baseline")

    matching = _mapping(manifest.get("matching"), "matching")
    exact_fields = set(_unique_strings(matching.get("exact_fields"), "matching.exact_fields"))
    required_exact = {
        "board_size_schedule",
        "seed_schedule",
        "puct_simulations",
        "self_play_games",
        "gradient_steps",
        "iteration_schedule",
        "evaluation_games",
        "terminal_reward",
        "max_plies",
        "superko_mode",
        "optimizer_hyperparameters",
        "temperature_schedule",
        "dirichlet_noise",
    }
    if not required_exact.issubset(exact_fields):
        missing = sorted(required_exact - exact_fields)
        raise ProtocolError(f"matching.exact_fields is missing {missing}")
    tolerance = matching.get("parameter_count_relative_tolerance")
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
        raise ProtocolError("parameter_count_relative_tolerance must be numeric")
    tolerance = float(tolerance)
    if not math.isfinite(tolerance) or not 0.0 <= tolerance <= 0.25:
        raise ProtocolError("parameter_count_relative_tolerance must be in [0, 0.25]")
    if matching.get("parameter_count_scope") != "trainable_parameters_per_seed":
        raise ProtocolError(
            "matching.parameter_count_scope must be "
            "'trainable_parameters_per_seed'"
        )

    if tier == "formal":
        if tuple(representations) != FORMAL_REPRESENTATIONS:
            raise ProtocolError(
                f"formal representations must be ordered as {FORMAL_REPRESENTATIONS}"
            )
        if tuple(train_sizes) != FORMAL_TRAIN_SIZES:
            raise ProtocolError(f"formal train_sizes must be {FORMAL_TRAIN_SIZES}")
        if len(seeds) != 5:
            raise ProtocolError("formal central comparison requires exactly five seeds")
        if curve_games < 20:
            raise ProtocolError("formal learning-curve probes require at least 20 games")
        if final_games < 200:
            raise ProtocolError("formal final evaluation requires at least 200 games per matchup")
        if set(baseline_kinds) != set(FORMAL_SEARCH_AGENT_KINDS):
            raise ProtocolError(
                "formal final evaluation must declare Random, Greedy, Minimax-2, "
                "Minimax-3, and MCTS"
            )
        final_kinds = {baseline_by_id[item]["agent_kind"] for item in final_opponents}
        if final_kinds != {"random", "mcts"}:
            raise ProtocolError(
                "formal neural final_search_opponents must be Random and matched-budget MCTS"
            )
        if tolerance > 0.01:
            raise ProtocolError("D14--D16 formal parameter-count tolerance may not exceed 1%")

        expected_counts = {
            entry["id"]: int(entry["expected_trainable_parameters"])
            for entry in representations_raw
        }
        relative_spread = max(expected_counts.values()) / min(expected_counts.values()) - 1.0
        if relative_spread > tolerance + 1e-12:
            raise ProtocolError(
                "manifest expected parameter counts exceed the declared tolerance: "
                f"spread={relative_spread:.6f}, counts={expected_counts}"
            )

    mcts_entries = [entry for entry in baseline_by_id.values() if entry["agent_kind"] == "mcts"]
    for entry in mcts_entries:
        simulations = _positive_int(entry["config"].get("simulations"), "mcts.config.simulations")
        if simulations != int(budget["puct_simulations"]):
            raise ProtocolError("search MCTS simulations must match training PUCT simulations")

    training_count = len(representations) * len(seeds)
    evaluation_units = training_count * len(train_sizes)
    curve_count = evaluation_units * (len(checkpoints) - 1)
    final_search_count = evaluation_units * len(final_opponents)
    round_robin_count = (
        math.comb(len(representations), 2) * len(train_sizes) * len(seeds)
    )
    return {
        "experiment_id": experiment_id,
        "evidence_tier": tier,
        "manifest_sha256": manifest_hash(manifest),
        "representations": representations,
        "train_sizes": train_sizes,
        "seeds": seeds,
        "training_tasks": training_count,
        "evaluation_tasks": curve_count + final_search_count + round_robin_count,
        "evaluation_breakdown": {
            "curve_nonfinal": curve_count,
            "final_search": final_search_count,
            "representation_round_robin": round_robin_count,
        },
    }


def _task_header(manifest: Mapping[str, Any], task_id: str, kind: str) -> dict[str, Any]:
    return {
        "schema_name": TASK_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "task_id": task_id,
        "task_kind": kind,
    }


def generate_tasks(manifest: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Generate deterministic train and fixed-checkpoint evaluation tasks."""

    validate_manifest(manifest)
    representations = [entry["id"] for entry in manifest["representations"]]
    sizes = list(manifest["train_sizes"])
    seeds = list(manifest["seeds"])
    budget = dict(manifest["training_budget"])
    evaluation = manifest["evaluation"]
    checkpoints = list(evaluation["checkpoint_gradient_steps"])
    final_step = checkpoints[-1]
    curve_games = int(evaluation["curve_games_per_matchup"])
    final_games = int(evaluation["final_games_per_matchup"])
    baseline_by_id = {entry["id"]: entry for entry in manifest["search_baselines"]}

    training: list[dict[str, Any]] = []
    training_by_key: dict[tuple[str, int], dict[str, Any]] = {}
    size_slug = "-".join(str(size) for size in sizes)
    representation_entries = {entry["id"]: entry for entry in manifest["representations"]}
    for representation in representations:
        for seed in seeds:
            task_id = f"train.mixed_n{size_slug}.{representation}.seed{seed}"
            task = {
                **_task_header(manifest, task_id, "training"),
                "representation": representation,
                "board_sizes": sizes,
                "seed": seed,
                "model_config": representation_entries[representation]["model_config"],
                "expected_trainable_parameters": representation_entries[representation][
                    "expected_trainable_parameters"
                ],
                "training_budget": budget,
                "required_checkpoint_gradient_steps": checkpoints,
                "output_tier": manifest["evidence_tier"],
            }
            training.append(task)
            training_by_key[(representation, seed)] = task

    evaluation_tasks: list[dict[str, Any]] = []

    def learned_agent(representation: str, seed: int, step: int) -> dict[str, Any]:
        training_task = training_by_key[(representation, seed)]
        return {
            "kind": "learned_checkpoint",
            "representation": representation,
            "training_task_id": training_task["task_id"],
            "gradient_steps": step,
            "search": {
                "simulations": budget["puct_simulations"],
                "c_puct": budget["c_puct"],
                "temperature": 0.0,
            },
        }

    def append_baseline_task(
        purpose: str,
        representation: str,
        size: int,
        seed: int,
        step: int,
        baseline_id: str,
        games: int,
        purposes: list[str] | None = None,
    ) -> None:
        task_id = (
            f"eval.{purpose}.n{size}.{representation}.seed{seed}."
            f"gs{step}.vs.{baseline_id}"
        )
        evaluation_tasks.append(
            {
                **_task_header(manifest, task_id, "evaluation"),
                "evaluation_kind": purpose,
                "purposes": purposes or [purpose],
                "train_sizes": sizes,
                "eval_size": size,
                "seed": seed,
                "checkpoint_gradient_steps": step,
                "agent_a": learned_agent(representation, seed, step),
                "agent_b": {
                    "kind": "search_baseline",
                    "baseline_id": baseline_id,
                    "agent_kind": baseline_by_id[baseline_id]["agent_kind"],
                    "config": baseline_by_id[baseline_id]["config"],
                },
                "games": games,
                "color_balance": evaluation["color_balance"],
                "max_plies": evaluation["max_plies"],
                "superko_mode": evaluation["superko_mode"],
            }
        )

    for size in sizes:
        for representation in representations:
            for seed in seeds:
                for step in checkpoints[:-1]:
                    append_baseline_task(
                        "learning_curve",
                        representation,
                        size,
                        seed,
                        step,
                        evaluation["curve_opponent"],
                        curve_games,
                    )
                for baseline_id in evaluation["final_search_opponents"]:
                    purposes = ["final_vs_search"]
                    if baseline_id == evaluation["curve_opponent"]:
                        purposes.append("learning_curve")
                    append_baseline_task(
                        "final_vs_search",
                        representation,
                        size,
                        seed,
                        final_step,
                        baseline_id,
                        final_games,
                        purposes,
                    )

    for size in sizes:
        for seed in seeds:
            for representation_a, representation_b in itertools.combinations(representations, 2):
                task_id = (
                    f"eval.representation_round_robin.n{size}.seed{seed}."
                    f"{representation_a}.vs.{representation_b}.gs{final_step}"
                )
                evaluation_tasks.append(
                    {
                        **_task_header(manifest, task_id, "evaluation"),
                        "evaluation_kind": "representation_round_robin",
                        "purposes": ["representation_round_robin"],
                        "train_sizes": sizes,
                        "eval_size": size,
                        "seed": seed,
                        "checkpoint_gradient_steps": final_step,
                        "agent_a": learned_agent(representation_a, seed, final_step),
                        "agent_b": learned_agent(representation_b, seed, final_step),
                        "games": final_games,
                        "color_balance": evaluation["color_balance"],
                        "max_plies": evaluation["max_plies"],
                        "superko_mode": evaluation["superko_mode"],
                    }
                )

    task_ids = [task["task_id"] for task in training + evaluation_tasks]
    if len(task_ids) != len(set(task_ids)):  # pragma: no cover - invariant guard
        raise ProtocolError("task generation produced duplicate task ids")
    return {"training": training, "evaluation": evaluation_tasks}


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


def write_task_bundle(manifest: Mapping[str, Any], output_directory: str | Path) -> dict[str, Any]:
    output = Path(output_directory)
    if output.exists() and any(output.iterdir()):
        raise ProtocolError(f"refusing to reuse non-empty task directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    tasks = generate_tasks(manifest)
    audit = validate_manifest(manifest)
    _atomic_text(
        output / "manifest_snapshot.json",
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    )
    for key, filename in (("training", "training_tasks.jsonl"), ("evaluation", "evaluation_tasks.jsonl")):
        _atomic_text(
            output / filename,
            "".join(json.dumps(task, sort_keys=True, ensure_ascii=False) + "\n" for task in tasks[key]),
        )
    summary = {
        "schema_version": SCHEMA_VERSION,
        **audit,
        "artifacts": {
            "manifest": str((output / "manifest_snapshot.json").resolve()),
            "training_tasks": str((output / "training_tasks.jsonl").resolve()),
            "evaluation_tasks": str((output / "evaluation_tasks.jsonl").resolve()),
        },
        "status": "tasks_generated_not_run",
    }
    _atomic_text(
        output / "bundle_summary.json",
        json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
    )
    return summary


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ProtocolError(f"cannot read JSONL {path}: {exc}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ProtocolError(f"invalid JSON at {path}:{line_number}: {exc}") from exc
        if not isinstance(record, dict):
            raise ProtocolError(f"JSONL record at {path}:{line_number} must be an object")
        records.append(record)
    return records


def _finite_optional(record: Mapping[str, Any], field: str, path: str) -> float | None:
    value = record.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProtocolError(f"{path}.{field} must be finite or null")
    return float(value)


def expected_training_config(task: Mapping[str, Any]) -> dict[str, Any]:
    """Return the exact AlphaZeroConfig JSON implied by one training task."""

    budget = task["training_budget"]
    model = task["model_config"]
    observation = "topology" if task["representation"] == "topology_gnn" else "grid_graph"
    return {
        "schema_version": 1,
        "seed": task["seed"],
        "observation_mode": observation,
        "model_kind": task["representation"],
        "board_sizes": task["board_sizes"],
        "iterations": budget["iterations"],
        "games_per_iteration": budget["games_per_iteration"],
        "puct_simulations": budget["puct_simulations"],
        "c_puct": budget["c_puct"],
        "dirichlet_alpha": budget["dirichlet_alpha"],
        "dirichlet_epsilon": budget["dirichlet_epsilon"],
        "max_plies": budget["max_plies"],
        "temperature_moves": budget["temperature_moves"],
        "initial_temperature": budget["initial_temperature"],
        "final_temperature": budget["final_temperature"],
        "replay_capacity": budget["replay_capacity"],
        "batch_size": budget["batch_size"],
        "training_steps_per_iteration": budget["training_steps_per_iteration"],
        "learning_rate": budget["learning_rate"],
        "weight_decay": budget["weight_decay"],
        "gradient_clip_norm": budget["gradient_clip_norm"],
        "hidden_channels": model["hidden_channels"],
        "message_passing_layers": model["message_passing_layers"],
        "checkpoint_every": budget["checkpoint_every_iterations"],
        "superko_mode": budget["superko_mode"],
    }


def _execution_identity(result: Mapping[str, Any], task_id: str) -> Mapping[str, Any]:
    identity = _mapping(result.get("execution_identity"), f"{task_id}.execution_identity")
    fields = {
        "trainer_source_hash",
        "runner_sha256",
        "protocol_sha256",
        "torch_version",
        "cuda_runtime_version",
        "cudnn_version",
        "device",
        "device_name",
        "cublas_workspace_config",
    }
    if set(identity) != fields:
        raise ProtocolError(f"{task_id}: execution_identity fields do not match the schema")
    for field in ("trainer_source_hash", "runner_sha256", "protocol_sha256"):
        if not _valid_sha256(identity.get(field)):
            raise ProtocolError(f"{task_id}: execution_identity.{field} must be SHA-256")
    if not isinstance(identity.get("torch_version"), str) or not identity["torch_version"]:
        raise ProtocolError(f"{task_id}: execution_identity.torch_version must be non-empty")
    if not isinstance(identity.get("device"), str) or not identity["device"]:
        raise ProtocolError(f"{task_id}: execution_identity.device must be non-empty")
    for field in ("cuda_runtime_version", "device_name", "cublas_workspace_config"):
        if identity.get(field) is not None and not isinstance(identity[field], str):
            raise ProtocolError(f"{task_id}: execution_identity.{field} must be text or null")
    if identity.get("cudnn_version") is not None and not _is_int(identity["cudnn_version"]):
        raise ProtocolError(f"{task_id}: execution_identity.cudnn_version must be integer or null")
    return identity


_BASELINE_CLASSES = {
    "random": "lifeline_rl.agents.random_agent.RandomAgent",
    "greedy": "lifeline_rl.agents.greedy.GreedyAgent",
    "minimax-2": "lifeline_rl.agents.minimax.MinimaxAgent",
    "minimax-3": "lifeline_rl.agents.minimax.MinimaxAgent",
    "mcts": "lifeline_rl.agents.mcts.MCTSAgent",
}


def canonical_agent_binding(
    task: Mapping[str, Any],
    spec: Mapping[str, Any],
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate actual arena metadata against a task and normalize its identity."""

    if spec["kind"] == "search_baseline":
        kind = str(spec["agent_kind"])
        expected_class = _BASELINE_CLASSES.get(kind)
        if expected_class is None or metadata.get("class") != expected_class:
            raise ProtocolError(
                f"{task['task_id']}: actual baseline class does not match {kind}"
            )
        actual_config = metadata.get("config")
        if kind == "mcts":
            expected_config = {
                "simulations": spec["config"]["simulations"],
                "rollout_depth": spec["config"].get("rollout_depth", 80),
                "exploration": spec["config"].get("exploration", math.sqrt(2.0)),
            }
            if actual_config != expected_config:
                raise ProtocolError(f"{task['task_id']}: actual MCTS config mismatch")
        elif kind.startswith("minimax"):
            expected_config = {
                "depth": int(kind[-1]),
                "move_cap": spec["config"].get("move_cap", 20),
            }
            if actual_config != expected_config:
                raise ProtocolError(f"{task['task_id']}: actual Minimax config mismatch")
        return {
            "kind": "search_baseline",
            "agent_kind": kind,
            "class": expected_class,
            "name": metadata.get("name"),
            "config": actual_config,
        }

    if spec["kind"] != "learned_checkpoint":
        raise ProtocolError(f"{task['task_id']}: unknown agent spec kind")
    expected_class = "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent"
    if metadata.get("class") != expected_class:
        raise ProtocolError(f"{task['task_id']}: learned slot is not NeuralPUCTAgent")
    config = _mapping(metadata.get("config"), f"{task['task_id']}.agent_metadata.config")
    checkpoint = _mapping(config.get("checkpoint"), "neural checkpoint identity")
    search = _mapping(config.get("search"), "neural search config")
    if config.get("model_kind") != spec["representation"]:
        raise ProtocolError(f"{task['task_id']}: neural model kind mismatch")
    if checkpoint.get("gradient_steps") != spec["gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: neural checkpoint gradient step mismatch")
    if search != spec["search"]:
        raise ProtocolError(f"{task['task_id']}: neural search budget mismatch")
    if config.get("trained_board_sizes") != task["train_sizes"]:
        raise ProtocolError(f"{task['task_id']}: neural training-size metadata mismatch")
    if config.get("train_superko_mode") != task["superko_mode"]:
        raise ProtocolError(f"{task['task_id']}: neural training-rule metadata mismatch")
    if bool(config.get("allow_superko_mode_override", False)):
        raise ProtocolError(f"{task['task_id']}: Superko override is forbidden")
    for field in ("sha256", "config_hash", "source_hash"):
        if not _valid_sha256(checkpoint.get(field)):
            raise ProtocolError(f"{task['task_id']}: neural checkpoint {field} invalid")
    return {
        "kind": "learned_checkpoint",
        "class": expected_class,
        "name": metadata.get("name"),
        "representation": spec["representation"],
        "training_task_id": spec["training_task_id"],
        "gradient_steps": spec["gradient_steps"],
        "parameter_count": config.get("parameter_count"),
        "search": dict(search),
        "checkpoint_sha256": checkpoint["sha256"],
        "checkpoint_config_hash": checkpoint["config_hash"],
        "checkpoint_source_hash": checkpoint["source_hash"],
    }


def validate_action_diagnostics(
    task: Mapping[str, Any],
    spec: Mapping[str, Any],
    binding: Mapping[str, Any],
    action: Mapping[str, Any],
    *,
    action_count: int,
) -> None:
    """Bind every persisted decision diagnostic to the scheduled agent."""

    label = f"{task['task_id']}: action diagnostics"
    diagnostics = _mapping(action.get("diagnostics"), label)
    actor = action.get("actor")
    if spec["kind"] == "learned_checkpoint":
        if (
            diagnostics.get("algorithm") != "neural_puct"
            or diagnostics.get("model_kind") != spec["representation"]
            or diagnostics.get("checkpoint_sha256") != binding["checkpoint_sha256"]
            or diagnostics.get("train_superko_mode") != task["superko_mode"]
            or diagnostics.get("eval_superko_mode") != task["superko_mode"]
            or diagnostics.get("superko_mode_override") is not False
            or diagnostics.get("allow_superko_mode_override") is not False
            or diagnostics.get("simulations") != spec["search"]["simulations"]
            or diagnostics.get("temperature") != spec["search"]["temperature"]
            or diagnostics.get("root_player") != actor
            or diagnostics.get("selected_action") != action.get("action")
            or diagnostics.get("root_visit_sum") != spec["search"]["simulations"]
        ):
            raise ProtocolError(f"{label} do not match the learned checkpoint")
        visits = _sequence(diagnostics.get("root_visits"), f"{label}.root_visits")
        priors = _sequence(diagnostics.get("root_priors"), f"{label}.root_priors")
        q_values = _sequence(diagnostics.get("root_q_values"), f"{label}.root_q_values")
        if (
            len(visits) != action_count
            or len(priors) != action_count
            or len(q_values) != action_count
            or any(not _is_int(value) or int(value) < 0 for value in visits)
            or sum(int(value) for value in visits) != spec["search"]["simulations"]
        ):
            raise ProtocolError(f"{label} contain an invalid neural root search")
        for field, values in (("root_priors", priors), ("root_q_values", q_values)):
            for value in values:
                _finite_number(value, f"{label}.{field}")
        return

    kind = str(spec["agent_kind"])
    if kind == "random":
        if diagnostics:
            raise ProtocolError(f"{label} for RandomAgent must be empty")
        return
    if diagnostics.get("root_player") != actor:
        raise ProtocolError(f"{label} have the wrong root player")
    if kind == "mcts":
        config = spec["config"]
        if (
            diagnostics.get("simulations") != config["simulations"]
            or diagnostics.get("rollout_depth") != config.get("rollout_depth", 80)
            or diagnostics.get("exploration") != config.get("exploration", math.sqrt(2.0))
        ):
            raise ProtocolError(f"{label} do not match the MCTS budget")
    elif kind.startswith("minimax"):
        if diagnostics.get("config") != {
            "depth": int(kind[-1]),
            "move_cap": spec["config"].get("move_cap", 20),
        }:
            raise ProtocolError(f"{label} do not match the Minimax budget")
    elif kind == "greedy":
        if diagnostics.get("actions_evaluated", 0) < 1:
            raise ProtocolError(f"{label} do not contain a Greedy search")
    else:  # pragma: no cover - manifest validation rejects unknown baselines
        raise ProtocolError(f"{label} use an unsupported baseline")


def validate_checkpoint_artifact(
    task: Mapping[str, Any], artifact: Mapping[str, Any]
) -> dict[str, Any]:
    """Bind a checkpoint manifest and payload counters to one scheduled step."""

    step = _positive_int(artifact.get("gradient_steps"), "checkpoint.gradient_steps")
    if step not in task["required_checkpoint_gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: unscheduled checkpoint step {step}")
    budget = task["training_budget"]
    updates = int(budget["training_steps_per_iteration"])
    if step % updates:
        raise ProtocolError(f"{task['task_id']}: checkpoint step is off schedule")
    expected_iteration = step // updates
    checkpoint_path = Path(str(artifact.get("checkpoint_path", "")))
    checkpoint_directory = Path(str(artifact.get("checkpoint_directory", "")))
    if (
        artifact.get("iteration") != expected_iteration
        or checkpoint_directory.name != f"gradient_{step:06d}"
        or checkpoint_path.name != f"checkpoint_{expected_iteration:06d}.pt"
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint path does not encode its scheduled step")
    if not checkpoint_path.is_file() or checkpoint_path.parent.resolve() != checkpoint_directory.resolve():
        raise ProtocolError(f"{task['task_id']}: checkpoint path/directory is missing or inconsistent")
    latest_path = checkpoint_directory / "latest.json"
    latest = _json_file(latest_path, "checkpoint manifest")
    if latest.get("checkpoint") != checkpoint_path.name:
        raise ProtocolError(f"{task['task_id']}: latest manifest points to another checkpoint")
    actual_sha = _sha256_file(checkpoint_path)
    if (
        not _valid_sha256(artifact.get("checkpoint_sha256"))
        or artifact["checkpoint_sha256"] != actual_sha
        or latest.get("sha256") != actual_sha
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint SHA-256 binding failed")
    if (
        latest.get("size_bytes") != checkpoint_path.stat().st_size
        or artifact.get("checkpoint_size_bytes") != checkpoint_path.stat().st_size
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint size binding failed")

    expected_config = expected_training_config(task)
    expected_config.pop("iterations")
    expected_config.pop("checkpoint_every")
    expected_config_json = canonical_json(expected_config)
    expected_config_hash = hashlib.sha256(expected_config_json.encode("utf-8")).hexdigest()
    try:
        from lifeline_rl.alphazero.checkpoint import load_checkpoint
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            build_policy_value_network,
        )
        from lifeline_rl.alphazero.replay import ReplayBuffer
        import torch
        model = build_policy_value_network(
            str(task["representation"]),
            NetworkConfig(
                hidden_channels=int(task["model_config"]["hidden_channels"]),
                message_passing_layers=int(task["model_config"]["message_passing_layers"]),
            ),
        )
        optimizer = torch.optim.AdamW(
            model.parameters(),
            lr=float(budget["learning_rate"]),
            weight_decay=float(budget["weight_decay"]),
        )
        replay = ReplayBuffer(
            capacity=int(budget["replay_capacity"]),
            seed=int(task["seed"]) ^ 0xB0FF_E123,
        )
        self_play_rng = random.Random(int(task["seed"]) ^ 0xA17E_2027)
        payload = load_checkpoint(
            checkpoint_directory,
            model=model,
            optimizer=optimizer,
            buffer=replay,
            local_rngs={"self_play": self_play_rng},
            expected_config=expected_config,
            expected_config_hash=expected_config_hash,
            expected_source_hash=str(artifact.get("source_hash", "")),
            strict_source=True,
            map_location="cpu",
            restore_global_rng=False,
            restore_local_rng=True,
        )
    except Exception as exc:
        raise ProtocolError(f"{task['task_id']}: checkpoint schema/model validation failed") from exc
    counters = _mapping(payload.get("counters"), "checkpoint payload counters")
    expected_games = expected_iteration * int(budget["games_per_iteration"])
    expected_counters = {
        "iteration": expected_iteration,
        "games_attempted": expected_games,
        "games_completed": expected_games,
        "games_truncated": 0,
        "gradient_steps": step,
        "examples_seen": step * int(budget["batch_size"]),
        "next_game_id": expected_games,
    }
    for field, expected in expected_counters.items():
        if counters.get(field) != expected:
            raise ProtocolError(
                f"{task['task_id']}: checkpoint payload {field}={counters.get(field)!r}, "
                f"expected {expected}"
            )
    source_hash = payload.get("source_hash")
    config_hash = payload.get("config_hash")
    if (
        source_hash != latest.get("source_hash")
        or source_hash != artifact.get("source_hash")
        or config_hash != latest.get("config_hash")
        or config_hash != artifact.get("config_hash")
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint source/config binding failed")
    if payload.get("config") != expected_config:
        raise ProtocolError(f"{task['task_id']}: checkpoint config does not match task")
    if (
        payload.get("config_json") != expected_config_json
        or config_hash != expected_config_hash
        or latest.get("created_at_utc") != payload.get("created_at_utc")
        or artifact.get("created_at_utc") != payload.get("created_at_utc")
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint config/time provenance mismatch")
    metadata = _mapping(payload.get("metadata"), "checkpoint payload metadata")
    if (
        metadata.get("safe_point") != "between_complete_games_after_optimizer_step"
        or
        metadata.get("model_kind") != task["representation"]
        or metadata.get("observation_mode")
        != ("topology" if task["representation"] == "topology_gnn" else "grid_graph")
        or metadata.get("network_config") != {
            "hidden_channels": task["model_config"]["hidden_channels"],
            "message_passing_layers": task["model_config"]["message_passing_layers"],
        }
        or metadata.get("parameter_count") != task["expected_trainable_parameters"]
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint model metadata mismatch")
    trainer_state = _mapping(payload.get("trainer_state"), "checkpoint trainer state")
    if trainer_state.get("schema_version") != 1 or trainer_state.get("counters") != dict(counters):
        raise ProtocolError(f"{task['task_id']}: trainer state/counter binding failed")
    environment_steps = _non_negative_int(
        counters.get("environment_steps"), "checkpoint environment_steps"
    )
    if (
        replay.capacity != int(budget["replay_capacity"])
        or replay.total_added != environment_steps
        or len(replay) != min(replay.capacity, environment_steps)
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint replay/counter binding failed")
    if len(optimizer.param_groups) != 1 or (
        float(optimizer.param_groups[0]["lr"]) != float(budget["learning_rate"])
        or float(optimizer.param_groups[0]["weight_decay"])
        != float(budget["weight_decay"])
    ):
        raise ProtocolError(f"{task['task_id']}: checkpoint optimizer config mismatch")
    if artifact.get("payload_counters") != dict(counters):
        raise ProtocolError(f"{task['task_id']}: receipt payload counters are not actual")
    return {
        "gradient_steps": step,
        "iteration": expected_iteration,
        "checkpoint_sha256": actual_sha,
        "config_hash": config_hash,
        "source_hash": source_hash,
        "payload_counters": dict(counters),
    }


def _finite_number(value: object, label: str, *, non_negative: bool = False) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or (non_negative and float(value) < 0.0)
    ):
        qualifier = "finite non-negative" if non_negative else "finite"
        raise ProtocolError(f"{label} must be a {qualifier} number")
    return float(value)


def _validate_self_play_games(
    task: Mapping[str, Any], games_path: Path
) -> tuple[list[dict[str, Any]], list[int]]:
    """Replay every persisted self-play trajectory and bind its deterministic schedule."""

    try:
        from lifeline_rl import LifelineGame, Player
    except ImportError as exc:  # pragma: no cover - formal aggregation uses train env
        raise ProtocolError("self-play artifact verification requires lifeline_rl") from exc

    records = load_jsonl(games_path)
    budget = task["training_budget"]
    games_per_iteration = int(budget["games_per_iteration"])
    expected_games = int(budget["self_play_games"])
    if len(records) != expected_games:
        raise ProtocolError(
            f"{task['task_id']}: persisted self-play game count {len(records)} "
            f"does not match {expected_games}"
        )
    schedule_rng = random.Random(int(task["seed"]) ^ 0xA17E_2027)
    experiences_by_iteration = [0 for _ in range(int(budget["iterations"]))]
    for game_index, record in enumerate(records):
        label = f"{task['task_id']}.self_play_games[{game_index}]"
        expected_seed = schedule_rng.getrandbits(63)
        expected_size = schedule_rng.choice(tuple(task["board_sizes"]))
        expected_iteration = game_index // games_per_iteration
        if (
            record.get("schema_version") != 1
            or record.get("game_index") != game_index
            or record.get("iteration") != expected_iteration
            or record.get("seed") != expected_seed
            or record.get("grid_size") != expected_size
            or record.get("superko_mode") != budget["superko_mode"]
            or record.get("start_player") != "BLACK"
        ):
            raise ProtocolError(f"{label}: deterministic task binding failed")
        actions = _sequence(record.get("actions"), f"{label}.actions")
        if (
            not actions
            or len(actions) > int(budget["max_plies"])
            or record.get("plies") != len(actions)
            or record.get("sample_count") != len(actions)
            or record.get("added_to_replay") is not True
            or record.get("terminated") is not True
            or record.get("truncated") is not False
        ):
            raise ProtocolError(f"{label}: terminal trajectory accounting failed")

        game = LifelineGame(
            expected_size,
            start_player="BLACK",
            superko_mode=str(budget["superko_mode"]),
        )
        for ply, raw_action in enumerate(actions):
            action = _mapping(raw_action, f"{label}.actions[{ply}]")
            action_index = _non_negative_int(action.get("action"), f"{label}.actions[{ply}].action")
            if action_index > game.num_points:
                raise ProtocolError(f"{label}: action index is outside the action space")
            legal_points = set(game.legal_moves())
            legal_mask = tuple(int(point in legal_points) for point in game.valid_positions) + (1,)
            expected_point = (
                None
                if action_index == game.num_points
                else list(game.valid_positions[action_index])
            )
            expected_temperature = (
                float(budget["initial_temperature"])
                if ply < int(budget["temperature_moves"])
                else float(budget["final_temperature"])
            )
            if (
                action.get("ply") != ply
                or action.get("turn_count_before") != game.turn_count
                or action.get("actor") != game.current_player.value
                or action.get("point") != expected_point
                or action.get("state_fingerprint") != game.state_fingerprint()
                or tuple(action.get("legal_action_mask", ())) != legal_mask
                or not math.isclose(
                    _finite_number(action.get("temperature"), f"{label}.temperature", non_negative=True),
                    expected_temperature,
                    rel_tol=0.0,
                    abs_tol=1e-12,
                )
            ):
                raise ProtocolError(f"{label}: action provenance mismatch at ply {ply}")
            if legal_mask[action_index] != 1:
                raise ProtocolError(f"{label}: selected action is illegal at ply {ply}")

            visits = _sequence(action.get("root_visits"), f"{label}.root_visits")
            if (
                len(visits) != len(legal_mask)
                or any(not _is_int(value) or int(value) < 0 for value in visits)
                or sum(int(value) for value in visits) != int(budget["puct_simulations"])
                or action.get("simulations") != int(budget["puct_simulations"])
            ):
                raise ProtocolError(f"{label}: PUCT visit budget mismatch at ply {ply}")
            for field in ("root_policy", "root_priors"):
                vector = _sequence(action.get(field), f"{label}.{field}")
                if len(vector) != len(legal_mask):
                    raise ProtocolError(f"{label}: {field} width mismatch at ply {ply}")
                values = [
                    _finite_number(value, f"{label}.{field}", non_negative=True)
                    for value in vector
                ]
                if (
                    not math.isclose(sum(values), 1.0, rel_tol=0.0, abs_tol=1e-6)
                    or any(values[index] > 1e-9 for index, legal in enumerate(legal_mask) if not legal)
                ):
                    raise ProtocolError(f"{label}: invalid {field} at ply {ply}")

            move = (
                game.skip_turn()
                if expected_point is None
                else game.play_move(tuple(expected_point))
            )
            if not move.success:
                raise ProtocolError(f"{label}: persisted action is illegal at ply {ply}")
        if not game.game_over or record.get("final_state_fingerprint") != game.state_fingerprint():
            raise ProtocolError(f"{label}: terminal state fingerprint mismatch")
        winner = game.winner()
        winner_value = winner.value if isinstance(winner, Player) else winner
        rewards = game.rewards()
        expected_rewards = {
            player.value: rewards[player] for player in (Player.BLACK, Player.WHITE)
        }
        if record.get("winner") != winner_value or record.get("rewards") != expected_rewards:
            raise ProtocolError(f"{label}: terminal outcome mismatch")
        experiences_by_iteration[expected_iteration] += len(actions)
    return records, experiences_by_iteration


def _validate_training_metrics(
    task: Mapping[str, Any],
    metrics_path: Path,
    experiences_by_iteration: Sequence[int],
) -> dict[int, Mapping[str, Any]]:
    rows = load_jsonl(metrics_path)
    budget = task["training_budget"]
    iterations = int(budget["iterations"])
    if len(rows) != iterations:
        raise ProtocolError(
            f"{task['task_id']}: metrics row count {len(rows)} does not match {iterations}"
        )
    by_step: dict[int, Mapping[str, Any]] = {}
    cumulative_environment_steps = 0
    for row_index, row in enumerate(rows):
        iteration = row_index + 1
        label = f"{task['task_id']}.metrics[{row_index}]"
        expected_experiences = int(experiences_by_iteration[row_index])
        cumulative_environment_steps += expected_experiences
        expected_gradient_steps = iteration * int(budget["training_steps_per_iteration"])
        expected_games = iteration * int(budget["games_per_iteration"])
        expected_counters = {
            "iteration": iteration,
            "games_attempted": expected_games,
            "games_completed": expected_games,
            "games_truncated": 0,
            "environment_steps": cumulative_environment_steps,
            "gradient_steps": expected_gradient_steps,
            "examples_seen": expected_gradient_steps * int(budget["batch_size"]),
            "next_game_id": expected_games,
        }
        counters = _mapping(row.get("counters"), f"{label}.counters")
        if dict(counters) != expected_counters:
            raise ProtocolError(f"{label}: cumulative counters do not match persisted games")
        if (
            row.get("schema_version") != 1
            or row.get("iteration") != iteration
            or row.get("games_completed") != int(budget["games_per_iteration"])
            or row.get("games_truncated") != 0
            or row.get("experiences_added") != expected_experiences
            or row.get("buffer_size")
            != min(int(budget["replay_capacity"]), cumulative_environment_steps)
            or row.get("gradient_steps_this_iteration")
            != int(budget["training_steps_per_iteration"])
            or row.get("model_kind") != task["representation"]
            or row.get("observation_mode")
            != ("topology" if task["representation"] == "topology_gnn" else "grid_graph")
            or row.get("parameter_count") != task["expected_trainable_parameters"]
        ):
            raise ProtocolError(f"{label}: metric/task binding failed")
        for field in ("loss", "policy_loss", "value_loss", "gradient_norm"):
            _finite_number(row.get(field), f"{label}.{field}", non_negative=True)
        by_step[expected_gradient_steps] = row
    return by_step


def _validate_training_artifacts(
    result: Mapping[str, Any], task: Mapping[str, Any]
) -> list[dict[str, Any]]:
    expected_config = expected_training_config(task)
    resolved_path = Path(str(result.get("resolved_config_path", "")))
    if _json_file(resolved_path, "resolved training config") != expected_config:
        raise ProtocolError(f"{task['task_id']}: resolved config artifact mismatch")
    if result.get("resolved_config_sha256") != _sha256_file(resolved_path):
        raise ProtocolError(f"{task['task_id']}: resolved config hash mismatch")
    run_directory = resolved_path.parent.resolve()
    metrics_path = Path(str(result.get("metrics_path", "")))
    games_path = Path(str(result.get("games_log_path", "")))
    expected_paths = {
        metrics_path: (run_directory / "metrics.jsonl").resolve(),
        games_path: (run_directory / "self_play_games.jsonl").resolve(),
    }
    for path, expected_path in expected_paths.items():
        if not path.is_file() or path.resolve() != expected_path:
            raise ProtocolError(f"{task['task_id']}: training log path is not canonical")
    if result.get("metrics_sha256") != _sha256_file(metrics_path):
        raise ProtocolError(f"{task['task_id']}: metrics artifact binding failed")
    if result.get("games_log_sha256") != _sha256_file(games_path):
        raise ProtocolError(f"{task['task_id']}: self-play games artifact binding failed")
    _, experiences_by_iteration = _validate_self_play_games(task, games_path)
    metrics_by_step = _validate_training_metrics(
        task, metrics_path, experiences_by_iteration
    )
    artifacts = _sequence(result.get("checkpoint_artifacts"), "checkpoint_artifacts")
    if [item.get("gradient_steps") for item in artifacts] != task[
        "required_checkpoint_gradient_steps"
    ]:
        raise ProtocolError(f"{task['task_id']}: checkpoint artifact steps mismatch")
    inspections = []
    prior_wall_clock = -1.0
    for raw_artifact in artifacts:
        artifact = _mapping(raw_artifact, "checkpoint")
        step = int(artifact["gradient_steps"])
        expected_directory = (run_directory / "snapshots" / f"gradient_{step:06d}").resolve()
        if Path(str(artifact.get("checkpoint_directory", ""))).resolve() != expected_directory:
            raise ProtocolError(f"{task['task_id']}: checkpoint directory is not canonical")
        wall_clock = _finite_number(
            artifact.get("wall_clock_seconds"),
            f"{task['task_id']}.checkpoint.wall_clock_seconds",
            non_negative=True,
        )
        if wall_clock < prior_wall_clock:
            raise ProtocolError(f"{task['task_id']}: checkpoint wall-clock is not monotonic")
        prior_wall_clock = wall_clock
        inspection = validate_checkpoint_artifact(task, artifact)
        metric = metrics_by_step.get(step)
        if metric is None or inspection["payload_counters"] != dict(metric["counters"]):
            raise ProtocolError(f"{task['task_id']}: checkpoint counters do not match metrics")
        inspections.append(inspection)
    source_hashes = {item["source_hash"] for item in inspections}
    config_hashes = {item["config_hash"] for item in inspections}
    if len(source_hashes) != 1 or len(config_hashes) != 1:
        raise ProtocolError(f"{task['task_id']}: checkpoints mix source/config identities")
    identity = _execution_identity(result, task["task_id"])
    if source_hashes != {identity["trainer_source_hash"]}:
        raise ProtocolError(f"{task['task_id']}: execution/checkpoint source hash mismatch")
    snapshots_by_step = {
        int(snapshot["gradient_steps"]): snapshot for snapshot in result["curve_snapshots"]
    }
    artifacts_by_step = {int(item["gradient_steps"]): item for item in artifacts}
    for step in task["required_checkpoint_gradient_steps"]:
        metric = metrics_by_step[step]
        counters = metric["counters"]
        expected_snapshot = {
            "gradient_steps": step,
            "self_play_games": counters["games_completed"],
            "environment_steps": counters["environment_steps"],
            "loss": metric["loss"],
            "policy_loss": metric["policy_loss"],
            "value_loss": metric["value_loss"],
            "wall_clock_seconds": artifacts_by_step[step]["wall_clock_seconds"],
        }
        if snapshots_by_step.get(step) != expected_snapshot:
            raise ProtocolError(f"{task['task_id']}: curve snapshot is not backed by metrics")
    final_counters = metrics_by_step[max(metrics_by_step)]["counters"]
    if result.get("environment_steps_completed") != final_counters["environment_steps"]:
        raise ProtocolError(f"{task['task_id']}: final environment-step count mismatch")
    if _finite_number(
        result.get("wall_clock_seconds"),
        f"{task['task_id']}.wall_clock_seconds",
        non_negative=True,
    ) < prior_wall_clock:
        raise ProtocolError(f"{task['task_id']}: final wall-clock precedes a checkpoint")
    return inspections


def _validate_training_result(
    result: Mapping[str, Any], task: Mapping[str, Any]
) -> None:
    budget = task["training_budget"]
    for field in ("representation", "board_sizes", "seed"):
        if result.get(field) != task[field]:
            raise ProtocolError(f"{task['task_id']}: result {field} does not match task")
    parameter_count = _positive_int(result.get("parameter_count"), f"{task['task_id']}.parameter_count")
    if parameter_count != task["expected_trainable_parameters"]:
        raise ProtocolError(
            f"{task['task_id']}: parameter count {parameter_count} does not match "
            f"the preflight count {task['expected_trainable_parameters']}"
        )
    _execution_identity(result, task["task_id"])
    if result.get("status") == "failed":
        if not isinstance(result.get("failure_reason"), str) or not result["failure_reason"]:
            raise ProtocolError(f"{task['task_id']}: failed result requires failure_reason")
        return
    if result.get("status") != "complete":
        raise ProtocolError(f"{task['task_id']}: status must be complete or failed")
    if result.get("training_budget") != budget:
        raise ProtocolError(f"{task['task_id']}: resolved training budget mismatch")
    if _positive_int(result.get("puct_simulations"), f"{task['task_id']}.puct_simulations") != budget["puct_simulations"]:
        raise ProtocolError(f"{task['task_id']}: PUCT simulation budget mismatch")
    if _positive_int(result.get("self_play_games_completed"), f"{task['task_id']}.self_play_games_completed") != budget["self_play_games"]:
        raise ProtocolError(f"{task['task_id']}: self-play game budget mismatch")
    if _positive_int(result.get("gradient_steps_completed"), f"{task['task_id']}.gradient_steps_completed") != budget["gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: gradient-step budget mismatch")
    checkpoints = list(_sequence(result.get("checkpoint_gradient_steps"), f"{task['task_id']}.checkpoint_gradient_steps"))
    if checkpoints != task["required_checkpoint_gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: fixed checkpoint list mismatch")
    snapshots = _sequence(result.get("curve_snapshots"), f"{task['task_id']}.curve_snapshots")
    snapshot_steps: list[int] = []
    prior_wall_clock = -1.0
    for index, raw in enumerate(snapshots):
        snapshot = _mapping(raw, f"{task['task_id']}.curve_snapshots[{index}]")
        step = _positive_int(snapshot.get("gradient_steps"), "curve snapshot gradient_steps")
        self_play_games = _positive_int(
            snapshot.get("self_play_games"), "curve snapshot self_play_games"
        )
        expected_iteration = step // int(budget["training_steps_per_iteration"])
        expected_games = expected_iteration * int(budget["games_per_iteration"])
        if self_play_games != expected_games:
            raise ProtocolError(
                f"{task['task_id']}: checkpoint step {step} must map to "
                f"{expected_games} self-play games"
            )
        _positive_int(snapshot.get("environment_steps"), "curve snapshot environment_steps")
        for metric in ("loss", "policy_loss", "value_loss", "wall_clock_seconds"):
            _finite_optional(snapshot, metric, f"{task['task_id']}.curve_snapshots[{index}]")
        wall_clock = snapshot.get("wall_clock_seconds")
        if wall_clock is None or float(wall_clock) < prior_wall_clock:
            raise ProtocolError(f"{task['task_id']}: checkpoint wall-clock must be monotonic")
        prior_wall_clock = float(wall_clock)
        snapshot_steps.append(step)
    if snapshot_steps != task["required_checkpoint_gradient_steps"]:
        raise ProtocolError(f"{task['task_id']}: curve snapshots do not cover fixed checkpoints")
    _validate_training_artifacts(result, task)


def _validate_evaluation_result(
    result: Mapping[str, Any],
    task: Mapping[str, Any],
    checkpoint_index: Mapping[tuple[str, int], Mapping[str, Any]] | None = None,
) -> None:
    for field in ("train_sizes", "eval_size", "seed", "checkpoint_gradient_steps"):
        if result.get(field) != task[field]:
            raise ProtocolError(f"{task['task_id']}: result {field} does not match task")
    _execution_identity(result, task["task_id"])
    if result.get("status") == "failed":
        if not isinstance(result.get("failure_reason"), str) or not result["failure_reason"]:
            raise ProtocolError(f"{task['task_id']}: failed result requires failure_reason")
        return
    if result.get("status") != "complete":
        raise ProtocolError(f"{task['task_id']}: status must be complete or failed")
    if result.get("max_plies") != task["max_plies"]:
        raise ProtocolError(f"{task['task_id']}: max_plies budget mismatch")
    if result.get("superko_mode") != task["superko_mode"]:
        raise ProtocolError(f"{task['task_id']}: Superko mode mismatch")

    requested = _positive_int(result.get("games_requested"), f"{task['task_id']}.games_requested")
    completed = _non_negative_int(result.get("games_completed"), f"{task['task_id']}.games_completed")
    truncated = _non_negative_int(result.get("truncated_games"), f"{task['task_id']}.truncated_games")
    if requested != task["games"] or completed != requested or truncated != 0:
        raise ProtocolError(
            f"{task['task_id']}: complete evaluation must contain exactly "
            f"{task['games']} completed games and zero truncations"
        )
    if task["evidence_tier"] == "formal":
        minimum_games = 20 if task["evaluation_kind"] == "learning_curve" else 200
        if requested < minimum_games:
            raise ProtocolError(
                f"{task['task_id']}: formal {task['evaluation_kind']} result has "
                f"fewer than {minimum_games} games"
            )
    half = requested // 2
    if (
        _non_negative_int(result.get("a_as_black_games"), "a_as_black_games") != half
        or _non_negative_int(result.get("a_as_white_games"), "a_as_white_games") != half
        or _non_negative_int(result.get("color_pairs_verified"), "color_pairs_verified") != half
        or result.get("color_balance") != "paired_swap_same_seed"
    ):
        raise ProtocolError(
            f"{task['task_id']}: evaluation is not a verified same-seed color swap"
        )
    if _positive_int(result.get("replay_verified_games"), "replay_verified_games") != requested:
        raise ProtocolError(f"{task['task_id']}: every arena game must pass replay verification")
    wins = _non_negative_int(result.get("a_wins"), "a_wins")
    losses = _non_negative_int(result.get("a_losses"), "a_losses")
    draws = _non_negative_int(result.get("draws"), "draws")
    if wins + losses + draws != completed:
        raise ProtocolError(f"{task['task_id']}: W/D/L counts do not sum to completed games")
    if result.get("agent_specs") != {"A": task["agent_a"], "B": task["agent_b"]}:
        raise ProtocolError(f"{task['task_id']}: receipt agent specs do not match task")
    bindings = _mapping(result.get("agent_bindings"), "agent_bindings")
    for slot, spec in (("A", task["agent_a"]), ("B", task["agent_b"])):
        binding = _mapping(bindings.get(slot), f"agent_bindings.{slot}")
        if binding.get("kind") != spec["kind"]:
            raise ProtocolError(f"{task['task_id']}: agent binding kind mismatch")
        if spec["kind"] == "search_baseline":
            if (
                binding.get("agent_kind") != spec["agent_kind"]
                or binding.get("class") != _BASELINE_CLASSES[spec["agent_kind"]]
            ):
                raise ProtocolError(f"{task['task_id']}: baseline binding mismatch")
        else:
            if (
                binding.get("representation") != spec["representation"]
                or binding.get("training_task_id") != spec["training_task_id"]
                or binding.get("gradient_steps") != spec["gradient_steps"]
                or binding.get("search") != spec["search"]
            ):
                raise ProtocolError(f"{task['task_id']}: neural agent binding mismatch")
            if checkpoint_index is not None:
                expected = checkpoint_index.get(
                    (str(spec["training_task_id"]), int(spec["gradient_steps"]))
                )
                if expected is None:
                    raise ProtocolError(f"{task['task_id']}: referenced checkpoint is absent")
                for binding_field, artifact_field in (
                    ("checkpoint_sha256", "checkpoint_sha256"),
                    ("checkpoint_config_hash", "config_hash"),
                    ("checkpoint_source_hash", "source_hash"),
                ):
                    if binding.get(binding_field) != expected.get(artifact_field):
                        raise ProtocolError(
                            f"{task['task_id']}: neural binding does not match training checkpoint"
                        )
    _validate_evaluation_artifacts(result, task)


def _validate_evaluation_artifacts(
    result: Mapping[str, Any], task: Mapping[str, Any]
) -> None:
    try:
        from lifeline_rl import LifelineGame, replay_game_record
    except ImportError as exc:  # pragma: no cover
        raise ProtocolError("arena artifact verification requires lifeline_rl") from exc

    summary_path = Path(str(result.get("arena_summary_path", "")))
    games_path = Path(str(result.get("arena_games_path", "")))
    csv_path = Path(str(result.get("arena_csv_path", "")))
    if not summary_path.is_file() or not games_path.is_file() or not csv_path.is_file():
        raise ProtocolError(f"{task['task_id']}: arena artifacts are missing")
    arena_directory = summary_path.parent.resolve()
    if (
        summary_path.resolve() != arena_directory / "summary.json"
        or games_path.resolve() != arena_directory / "games.jsonl"
        or csv_path.resolve() != arena_directory / "games.csv"
    ):
        raise ProtocolError(f"{task['task_id']}: arena artifact paths are not canonical")
    if (
        result.get("arena_summary_sha256") != _sha256_file(summary_path)
        or result.get("arena_games_sha256") != _sha256_file(games_path)
        or result.get("arena_csv_sha256") != _sha256_file(csv_path)
    ):
        raise ProtocolError(f"{task['task_id']}: arena artifact hash binding failed")
    summary = _json_file(summary_path, "arena summary")
    expected_summary = {
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
    for field, expected in expected_summary.items():
        if summary.get(field) != expected:
            raise ProtocolError(f"{task['task_id']}: arena summary task binding failed")
    actual_bindings = {
        "A": canonical_agent_binding(task, task["agent_a"], _mapping(summary.get("agent_a_metadata"), "agent A metadata")),
        "B": canonical_agent_binding(task, task["agent_b"], _mapping(summary.get("agent_b_metadata"), "agent B metadata")),
    }
    if result.get("agent_bindings") != actual_bindings:
        raise ProtocolError(f"{task['task_id']}: receipt agent bindings are not actual metadata")
    records = load_jsonl(games_path)
    action_count = LifelineGame(
        int(task["eval_size"]), superko_mode=str(task["superko_mode"])
    ).num_points + 1
    if len(records) != int(task["games"]):
        raise ProtocolError(f"{task['task_id']}: persisted arena game count mismatch")
    for game_index, record in enumerate(records):
        pair_index = game_index // 2
        actions = _sequence(record.get("actions"), "arena actions")
        if (
            record.get("game_index") != game_index
            or record.get("pair_index") != pair_index
            or record.get("grid_size") != task["eval_size"]
            or record.get("superko_mode") != task["superko_mode"]
            or record.get("seed") != task["seed"] + pair_index
            or record.get("truncated") is not False
            or record.get("plies") != len(actions)
            or record.get("plies", 0) > task["max_plies"]
        ):
            raise ProtocolError(f"{task['task_id']}: arena record task binding failed")
        black_slot = record.get("black_slot")
        white_slot = record.get("white_slot")
        if {black_slot, white_slot} != {"A", "B"} or black_slot == white_slot:
            raise ProtocolError(f"{task['task_id']}: arena record slot binding failed")
        expected_black = summary["agent_a"] if black_slot == "A" else summary["agent_b"]
        expected_white = summary["agent_a"] if white_slot == "A" else summary["agent_b"]
        if record.get("black_agent") != expected_black or record.get("white_agent") != expected_white:
            raise ProtocolError(f"{task['task_id']}: arena record agent identity mismatch")
        for action in actions:
            action_mapping = _mapping(action, "arena action")
            actor = action_mapping.get("actor")
            if actor not in {"BLACK", "WHITE"}:
                raise ProtocolError(f"{task['task_id']}: arena action actor is invalid")
            actor_slot = black_slot if actor == "BLACK" else white_slot
            spec = task["agent_a"] if actor_slot == "A" else task["agent_b"]
            validate_action_diagnostics(
                task,
                spec,
                actual_bindings[actor_slot],
                action_mapping,
                action_count=action_count,
            )
        replay_game_record(record)
    for pair_index in range(int(task["games"]) // 2):
        first, second = records[pair_index * 2 : pair_index * 2 + 2]
        if (
            first.get("black_slot") != "A"
            or second.get("black_slot") != "B"
            or first.get("black_policy_seed") != second.get("white_policy_seed")
            or first.get("white_policy_seed") != second.get("black_policy_seed")
        ):
            raise ProtocolError(f"{task['task_id']}: persisted color pair is invalid")

    observed_counts = {
        "games_requested": len(records),
        "games_completed": 0,
        "truncated_games": 0,
        "a_wins": 0,
        "a_losses": 0,
        "draws": 0,
        "a_as_black_games": 0,
        "a_as_white_games": 0,
    }
    for record in records:
        a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
        observed_counts[
            "a_as_black_games" if a_color == "BLACK" else "a_as_white_games"
        ] += 1
        if record["truncated"]:
            observed_counts["truncated_games"] += 1
            continue
        observed_counts["games_completed"] += 1
        if record["winner"] == "DRAW":
            observed_counts["draws"] += 1
        elif record["winner"] == a_color:
            observed_counts["a_wins"] += 1
        else:
            observed_counts["a_losses"] += 1
    for field, observed in observed_counts.items():
        summary_fields = {
            "games_requested",
            "games_completed",
            "truncated_games",
            "a_wins",
            "a_losses",
            "draws",
        }
        if result.get(field) != observed or (
            field in summary_fields and summary.get(field) != observed
        ):
            raise ProtocolError(
                f"{task['task_id']}: persisted games disagree with {field}"
            )

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
    for field in (
        "games_requested",
        "games_completed",
        "truncated_games",
        "a_wins",
        "a_losses",
        "draws",
    ):
        if summary.get(field) != result.get(field):
            raise ProtocolError(f"{task['task_id']}: receipt/summary count mismatch")


def validate_result_ledger(
    manifest: Mapping[str, Any], results: Sequence[Mapping[str, Any]]
) -> tuple[dict[str, Mapping[str, Any]], dict[str, Mapping[str, Any]]]:
    """Validate one complete result receipt for every generated task."""

    tasks = generate_tasks(manifest)
    expected = {task["task_id"]: task for task in tasks["training"] + tasks["evaluation"]}
    by_id: dict[str, Mapping[str, Any]] = {}
    for index, result in enumerate(results):
        path = f"results[{index}]"
        if result.get("schema_name") != RESULT_SCHEMA_NAME or result.get("schema_version") != SCHEMA_VERSION:
            raise ProtocolError(f"{path}: unsupported result schema")
        if result.get("experiment_id") != manifest["experiment_id"]:
            raise ProtocolError(f"{path}: experiment_id mismatch")
        if result.get("manifest_sha256") != manifest_hash(manifest):
            raise ProtocolError(f"{path}: manifest hash mismatch")
        if result.get("evidence_tier") != manifest["evidence_tier"]:
            raise ProtocolError(f"{path}: mixed evidence tiers are forbidden")
        task_id = result.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ProtocolError(f"{path}: task_id must be non-empty")
        if task_id in by_id:
            raise ProtocolError(f"duplicate result receipt for task {task_id!r}")
        if task_id not in expected:
            raise ProtocolError(f"unexpected result task_id {task_id!r}")
        by_id[task_id] = result

    missing = sorted(set(expected) - set(by_id))
    if missing:
        preview = ", ".join(missing[:5])
        suffix = "..." if len(missing) > 5 else ""
        raise ProtocolError(
            f"missing {len(missing)} task receipts (missing seeds/runs are not dropped): "
            f"{preview}{suffix}"
        )
    identities = {
        canonical_json(dict(_execution_identity(result, task_id)))
        for task_id, result in by_id.items()
    }
    if len(identities) != 1:
        raise ProtocolError("result ledger mixes trainer source or runner identities")
    if manifest["evidence_tier"] == "formal":
        observed_identity = dict(_execution_identity(next(iter(by_id.values())), "result ledger"))
        current_identity = current_execution_identity()
        if any(
            observed_identity.get(field) != value
            for field, value in current_identity.items()
        ):
            raise ProtocolError(
                "formal result ledger source identity differs from the current frozen sources"
            )

    checkpoint_index: dict[tuple[str, int], Mapping[str, Any]] = {}
    for task_id, task in expected.items():
        if task["task_kind"] != "training":
            continue
        result = by_id[task_id]
        _validate_training_result(result, task)
        if result["status"] == "complete":
            for artifact in result["checkpoint_artifacts"]:
                checkpoint_index[(task_id, int(artifact["gradient_steps"]))] = artifact
    for task_id, task in expected.items():
        if task["task_kind"] == "evaluation":
            _validate_evaluation_result(by_id[task_id], task, checkpoint_index)
    return expected, by_id


def audit_parameter_counts(
    manifest: Mapping[str, Any],
    counts: Sequence[Mapping[str, Any]],
    *,
    require_seed_matrix: bool,
) -> dict[str, Any]:
    """Audit trainable-parameter parity without importing any model code."""

    validate_manifest(manifest)
    representations = [entry["id"] for entry in manifest["representations"]]
    seeds: list[int | None] = list(manifest["seeds"]) if require_seed_matrix else [None]
    expected_by_representation = {
        entry["id"]: int(entry["expected_trainable_parameters"])
        for entry in manifest["representations"]
    }
    observed: dict[tuple[int | None, str], int] = {}
    for index, raw in enumerate(counts):
        entry = _mapping(raw, f"counts[{index}]")
        representation = entry.get("representation")
        seed = entry.get("seed") if require_seed_matrix else None
        key = (seed, representation)
        if representation not in representations or seed not in seeds:
            raise ProtocolError(f"counts[{index}] does not belong to the manifest matrix")
        if key in observed:
            raise ProtocolError(f"duplicate parameter count for {key}")
        count = _positive_int(entry.get("parameter_count"), f"counts[{index}].parameter_count")
        if count != expected_by_representation[representation]:
            raise ProtocolError(
                f"counts[{index}] for {representation} is {count}, expected "
                f"{expected_by_representation[representation]} from the frozen dry-run"
            )
        observed[key] = count
    expected = {
        (seed, representation)
        for seed in seeds
        for representation in representations
    }
    missing = sorted(expected - set(observed), key=str)
    if missing:
        raise ProtocolError(f"parameter audit is missing {len(missing)} matrix entries")

    tolerance = float(manifest["matching"]["parameter_count_relative_tolerance"])
    groups: list[dict[str, Any]] = []
    for seed in seeds:
        values = {representation: observed[(seed, representation)] for representation in representations}
        minimum = min(values.values())
        maximum = max(values.values())
        relative_spread = maximum / minimum - 1.0
        if relative_spread > tolerance + 1e-12:
            raise ProtocolError(
                f"parameter parity failed for seed={seed}: "
                f"spread={relative_spread:.6f} > tolerance={tolerance:.6f}, counts={values}"
            )
        groups.append(
            {
                "seed": seed,
                "counts": values,
                "minimum": minimum,
                "maximum": maximum,
                "relative_spread": relative_spread,
                "tolerance": tolerance,
                "pass": True,
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "evidence_tier": manifest["evidence_tier"],
        "scope": manifest["matching"]["parameter_count_scope"],
        "groups": groups,
        "pass": True,
    }


def _score_ci95(wins: int, draws: int, games: int) -> list[float] | None:
    if games < 1:
        return None
    proportion = (wins + 0.5 * draws) / games
    z = 1.96
    denominator = 1.0 + z * z / games
    center = (proportion + z * z / (2.0 * games)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1.0 - proportion) / games
            + z * z / (4.0 * games * games)
        )
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def _aggregate_evaluations(
    pairs: Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]],
    group_fields: Sequence[str],
) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = defaultdict(list)
    for task, result in pairs:
        key_values: list[Any] = []
        for field in group_fields:
            if field == "agent_a_id":
                agent = task["agent_a"]
                key_values.append(agent.get("representation", agent.get("baseline_id")))
            elif field == "agent_b_id":
                agent = task["agent_b"]
                key_values.append(agent.get("representation", agent.get("baseline_id")))
            else:
                key_values.append(task[field])
        groups[tuple(key_values)].append((task, result))

    rows: list[dict[str, Any]] = []
    for key, entries in sorted(groups.items(), key=lambda item: str(item[0])):
        completed_entries = [result for _, result in entries if result["status"] == "complete"]
        failed_entries = [result for _, result in entries if result["status"] == "failed"]
        wins = sum(int(result["a_wins"]) for result in completed_entries)
        losses = sum(int(result["a_losses"]) for result in completed_entries)
        draws = sum(int(result["draws"]) for result in completed_entries)
        games = wins + losses + draws
        row = dict(zip(group_fields, key))
        row.update(
            {
                "seed_receipts": len(entries),
                "completed_seed_receipts": len(completed_entries),
                "failed_seed_receipts": len(failed_entries),
                "games_completed": games,
                "a_wins": wins,
                "a_losses": losses,
                "draws": draws,
                "a_score_rate": None if not games else (wins + 0.5 * draws) / games,
                "a_score_ci95_wilson": _score_ci95(wins, draws, games),
                "failure_reasons": [result["failure_reason"] for result in failed_entries],
            }
        )
        rows.append(row)
    return rows


def aggregate_results(
    manifest: Mapping[str, Any], results: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Validate every receipt, audit parity, and aggregate without seed dropping."""

    expected, by_id = validate_result_ledger(manifest, results)
    training_pairs = [
        (task, by_id[task_id])
        for task_id, task in expected.items()
        if task["task_kind"] == "training"
    ]
    evaluation_pairs = [
        (task, by_id[task_id])
        for task_id, task in expected.items()
        if task["task_kind"] == "evaluation"
    ]
    counts = [
        {
            "representation": task["representation"],
            "seed": task["seed"],
            "parameter_count": result["parameter_count"],
        }
        for task, result in training_pairs
    ]
    parameter_audit = audit_parameter_counts(manifest, counts, require_seed_matrix=True)

    failed_training = [result for _, result in training_pairs if result["status"] == "failed"]
    failed_evaluation = [result for _, result in evaluation_pairs if result["status"] == "failed"]

    snapshot_groups: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for task, result in training_pairs:
        if result["status"] != "complete":
            continue
        for snapshot in result["curve_snapshots"]:
            snapshot_groups[(task["representation"], snapshot["gradient_steps"])].append(snapshot)
    training_curve: list[dict[str, Any]] = []
    for (representation, step), snapshots in sorted(snapshot_groups.items(), key=lambda item: str(item[0])):
        row: dict[str, Any] = {
            "representation": representation,
            "train_sizes": list(manifest["train_sizes"]),
            "gradient_steps": step,
            "completed_seeds": len(snapshots),
        }
        for field in (
            "self_play_games",
            "environment_steps",
            "loss",
            "policy_loss",
            "value_loss",
            "wall_clock_seconds",
        ):
            values = [float(snapshot[field]) for snapshot in snapshots if snapshot.get(field) is not None]
            row[f"mean_{field}"] = statistics.fmean(values) if values else None
        training_curve.append(row)

    learning_curve_pairs = [
        (task, result)
        for task, result in evaluation_pairs
        if "learning_curve" in task["purposes"]
    ]
    final_search_pairs = [
        (task, result)
        for task, result in evaluation_pairs
        if "final_vs_search" in task["purposes"]
    ]
    round_robin_pairs = [
        (task, result)
        for task, result in evaluation_pairs
        if "representation_round_robin" in task["purposes"]
    ]
    arena_learning_curve = _aggregate_evaluations(
        learning_curve_pairs,
        ("agent_a_id", "eval_size", "checkpoint_gradient_steps", "agent_b_id"),
    )
    final_vs_search = _aggregate_evaluations(
        final_search_pairs,
        ("agent_a_id", "eval_size", "agent_b_id"),
    )
    representation_round_robin = _aggregate_evaluations(
        round_robin_pairs,
        ("eval_size", "agent_a_id", "agent_b_id"),
    )

    formal_ready = not failed_training and not failed_evaluation
    return {
        "schema_version": SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "evidence_tier": manifest["evidence_tier"],
        "formal_ready": formal_ready if manifest["evidence_tier"] == "formal" else False,
        "status": "complete" if formal_ready else "complete_with_declared_failures",
        "receipts": {
            "training": len(training_pairs),
            "evaluation": len(evaluation_pairs),
            "failed_training": len(failed_training),
            "failed_evaluation": len(failed_evaluation),
        },
        "failed_runs": [
            {"task_id": result["task_id"], "reason": result["failure_reason"]}
            for result in failed_training + failed_evaluation
        ],
        "parameter_audit": parameter_audit,
        "training_curve": training_curve,
        "arena_learning_curve": arena_learning_curve,
        "final_vs_search": final_vs_search,
        "representation_round_robin": representation_round_robin,
    }


def _csv_value(value: Any) -> Any:
    if isinstance(value, (list, dict)):
        return json.dumps(value, sort_keys=True, ensure_ascii=False)
    return value


def _write_csv(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    if not rows:
        _atomic_text(path, "")
        return
    fieldnames: list[str] = []
    for row in rows:
        for field in row:
            if field not in fieldnames:
                fieldnames.append(field)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                writer.writerow({field: _csv_value(row.get(field)) for field in fieldnames})
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


def write_aggregate(aggregate: Mapping[str, Any], output_directory: str | Path) -> dict[str, str]:
    output = Path(output_directory)
    if output.exists() and any(output.iterdir()):
        raise ProtocolError(f"refusing to reuse non-empty aggregate directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    _atomic_text(
        output / "aggregate.json",
        json.dumps(aggregate, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
    )
    artifacts = {"aggregate": str((output / "aggregate.json").resolve())}
    for field, filename in (
        ("training_curve", "training_curve.csv"),
        ("arena_learning_curve", "arena_learning_curve.csv"),
        ("final_vs_search", "final_vs_search.csv"),
        ("representation_round_robin", "representation_round_robin.csv"),
    ):
        path = output / filename
        _write_csv(path, aggregate[field])
        artifacts[field] = str(path.resolve())
    return artifacts


def _load_counts(path: str | Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read parameter counts {path}: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("counts"), list):
        raise ProtocolError("parameter-count file must be an object with a counts array")
    return payload["counts"]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="validate and summarize a manifest")
    validate.add_argument("--manifest", type=Path, required=True)
    generate = subparsers.add_parser("generate", help="write deterministic task JSONL files")
    generate.add_argument("--manifest", type=Path, required=True)
    generate.add_argument("--output-dir", type=Path, required=True)
    audit = subparsers.add_parser("audit-parameters", help="check dry-run parameter counts")
    audit.add_argument("--manifest", type=Path, required=True)
    audit.add_argument("--counts", type=Path, required=True)
    aggregate = subparsers.add_parser("aggregate", help="validate and aggregate a complete result ledger")
    aggregate.add_argument("--manifest", type=Path, required=True)
    aggregate.add_argument("--results", type=Path, required=True)
    aggregate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        if args.command == "validate":
            payload = validate_manifest(manifest)
        elif args.command == "generate":
            payload = write_task_bundle(manifest, args.output_dir)
        elif args.command == "audit-parameters":
            payload = audit_parameter_counts(
                manifest, _load_counts(args.counts), require_seed_matrix=False
            )
        elif args.command == "aggregate":
            aggregate = aggregate_results(manifest, load_jsonl(args.results))
            payload = {
                "summary": {
                    key: aggregate[key]
                    for key in ("experiment_id", "evidence_tier", "formal_ready", "status", "receipts")
                },
                "artifacts": write_aggregate(aggregate, args.output_dir),
            }
        else:  # pragma: no cover - argparse owns this branch
            raise AssertionError(args.command)
    except ProtocolError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
