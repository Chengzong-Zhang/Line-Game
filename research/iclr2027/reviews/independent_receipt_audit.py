#!/usr/bin/env python3
"""Read-only audit of the frozen D14--D16 evidence.

By default this checker never opens ``aggregate_v1`` or ``D14_D16_RESULTS.md``.
It reconstructs task completeness, W/D/L, score, and Wilson intervals from the
task bundle, raw receipts, and per-game CSV files; it also hashes artifacts,
profiles deterministic opening and full-trajectory clusters, and replays a
stratified sample directly through ``LifelineGame`` without calling the arena or
aggregation validators.  ``--compare-canonical`` opens ``aggregate_v1`` only
after those independent rows have been reconstructed and compares all 72 rows.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
MANIFEST = PROJECT / "configs" / "d14_d16_formal_manifest.json"
BUNDLE = PROJECT / "results" / "formal" / "d14_d16" / "task_bundle_v1"
RUN = PROJECT / "results" / "formal" / "d14_d16" / "run_v1"
LEDGER = RUN / "result_receipts.jsonl"
AGGREGATE = PROJECT / "results" / "formal" / "d14_d16" / "aggregate_v1" / "aggregate.json"


def project_relative(path: Path) -> str:
    return path.resolve().relative_to(PROJECT.resolve()).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def wilson_interval(score: float, games: int) -> list[float]:
    """Return the two-sided 95% Wilson interval used by the canonical report."""
    z = 1.96
    denominator = 1.0 + z * z / games
    center = (score + z * z / (2.0 * games)) / denominator
    radius = z * math.sqrt(score * (1.0 - score) / games + z * z / (4.0 * games * games))
    radius /= denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def local_path(value: str) -> Path:
    path = Path(value)
    if path.exists():
        return path
    # The evidence was produced on this same checkout.  This fallback keeps the
    # checker relocatable while preserving the suffix beginning at iclr2027.
    lowered = [part.lower() for part in path.parts]
    if "iclr2027" in lowered:
        index = lowered.index("iclr2027")
        candidate = PROJECT.joinpath(*path.parts[index + 1 :])
        if candidate.exists():
            return candidate
    return path


def task_agent_name(spec: dict[str, Any]) -> str:
    if spec.get("kind") == "learned_checkpoint":
        return str(spec["representation"])
    return str(spec.get("baseline_id", spec.get("agent_kind", "unknown")))


def outcome_from_csv(row: dict[str, str]) -> str:
    if row["winner"] == "DRAW":
        return "D"
    winner_slot = row["black_slot"] if row["winner"] == "BLACK" else row["white_slot"]
    return "W" if winner_slot == "A" else "L"


def replay_record(record: dict[str, Any]) -> None:
    # Import only the state machine.  In particular, do not call
    # arena.replay_game_record or either D14--D16 verifier.
    from lifeline_rl.core import LifelineGame, Player

    game = LifelineGame(int(record["grid_size"]), superko_mode=str(record["superko_mode"]))
    for expected_ply, entry in enumerate(record["actions"]):
        if game.game_over:
            raise AssertionError(f"action after terminal ply {expected_ply}")
        if int(entry["ply"]) != expected_ply:
            raise AssertionError(f"non-contiguous ply {expected_ply}")
        if str(entry["actor"]) != game.current_player.value:
            raise AssertionError(f"actor mismatch at ply {expected_ply}")
        point = None if entry["point"] is None else tuple(entry["point"])
        action_index = game.num_points if point is None else game.point_to_index.get(point)
        if action_index != int(entry["action"]):
            raise AssertionError(f"action mapping mismatch at ply {expected_ply}")
        result = game.skip_turn() if point is None else game.play_move(point)
        if not result.success:
            raise AssertionError(f"illegal replay action at ply {expected_ply}: {result.reason}")
    if bool(record["truncated"]) == bool(game.game_over):
        raise AssertionError("terminal/truncation mismatch")
    if not bool(record["truncated"]):
        winner = game.winner()
        winner_value = winner.value if isinstance(winner, Player) else winner
        if winner_value != record["winner"]:
            raise AssertionError("winner mismatch")
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
        if territories != record["territories"]:
            raise AssertionError("territory mismatch")


def iter_selected_jsonl(path: Path, selected: set[int]) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        for index, line in enumerate(stream):
            if index in selected:
                yield json.loads(line)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compare-canonical", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    compare_canonical = args.compare_canonical
    sys.path.insert(0, str(PROJECT))
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    errors: list[str] = []
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    # The bundle snapshot is a byte-for-byte copy, whereas task rows bind the
    # protocol's canonical JSON digest.  Keep those two identities distinct so
    # whitespace-only formatting cannot create a false binding failure.
    manifest_file_hash = sha256_file(MANIFEST)
    snapshot_file_hash = sha256_file(BUNDLE / "manifest_snapshot.json")
    manifest_hash = hashlib.sha256(canonical(manifest).encode("utf-8")).hexdigest()
    training_tasks = read_jsonl(BUNDLE / "training_tasks.jsonl")
    evaluation_tasks = read_jsonl(BUNDLE / "evaluation_tasks.jsonl")
    tasks = training_tasks + evaluation_tasks
    receipts = read_jsonl(LEDGER)
    task_by_id = {task["task_id"]: task for task in tasks}
    receipt_ids = [receipt["task_id"] for receipt in receipts]
    expected_ids = set(task_by_id)
    seen_ids = set(receipt_ids)

    if manifest_file_hash != snapshot_file_hash:
        errors.append("manifest snapshot byte hash differs from the frozen manifest")
    if any(task.get("manifest_sha256") != manifest_hash for task in tasks):
        errors.append("one or more tasks do not bind the current manifest hash")
    if len(receipt_ids) != len(seen_ids):
        errors.append("duplicate receipt task_id")
    if expected_ids != seen_ids:
        errors.append("receipt task set differs from task bundle")

    status_counts = Counter(str(receipt.get("status")) for receipt in receipts)
    kind_counts = Counter(str(receipt.get("result_kind")) for receipt in receipts)
    identity_strings = {canonical(receipt.get("execution_identity")) for receipt in receipts}
    if len(identity_strings) != 1:
        errors.append("execution identity is not unique across receipts")

    current_identity = {
        "trainer_source_hash": AlphaZeroTrainer.current_source_hash(),
        "runner_sha256": sha256_file(PROJECT / "scripts" / "run_d14_d16_task_bundle.py"),
        "protocol_sha256": sha256_file(PROJECT / "scripts" / "d14_d16_experiments.py"),
    }
    receipt_identity = receipts[0]["execution_identity"]
    for key, actual in current_identity.items():
        if receipt_identity.get(key) != actual:
            errors.append(f"current {key} differs from receipt identity")

    artifact_hash_checks = 0
    artifact_hash_mismatches: list[str] = []
    checkpoint_hash_checks = 0
    config_hash_checks = 0
    self_play_games = 0
    gradient_steps = 0
    parameter_counts: dict[str, set[int]] = defaultdict(set)

    for receipt in receipts[: len(training_tasks)]:
        self_play_games += int(receipt["self_play_games_completed"])
        gradient_steps += int(receipt["gradient_steps_completed"])
        parameter_counts[str(receipt["representation"])].add(int(receipt["parameter_count"]))
        for path_key, hash_key in (
            ("resolved_config_path", "resolved_config_sha256"),
            ("metrics_path", "metrics_sha256"),
            ("games_log_path", "games_log_sha256"),
        ):
            path = local_path(str(receipt[path_key]))
            actual = sha256_file(path) if path.exists() else "MISSING"
            artifact_hash_checks += 1
            if path_key == "resolved_config_path":
                config_hash_checks += 1
            if actual != receipt[hash_key]:
                artifact_hash_mismatches.append(f"{receipt['task_id']}:{path_key}")
        expected_steps = [40, 80, 120, 160, 200]
        actual_steps = [int(item["gradient_steps"]) for item in receipt["checkpoint_artifacts"]]
        if actual_steps != expected_steps:
            errors.append(f"{receipt['task_id']}: checkpoint step schedule mismatch")
        for artifact in receipt["checkpoint_artifacts"]:
            path = local_path(str(artifact["checkpoint_path"]))
            actual = sha256_file(path) if path.exists() else "MISSING"
            artifact_hash_checks += 1
            checkpoint_hash_checks += 1
            if actual != artifact["checkpoint_sha256"]:
                artifact_hash_mismatches.append(
                    f"{receipt['task_id']}:checkpoint-{artifact['gradient_steps']}"
                )
            if artifact["source_hash"] != current_identity["trainer_source_hash"]:
                errors.append(f"{receipt['task_id']}: checkpoint source hash mismatch")

    task_wdl: dict[str, Counter[str]] = {}
    aggregate_wdl: dict[tuple[Any, ...], Counter[str]] = defaultdict(Counter)
    aggregate_seed_counts: dict[tuple[Any, ...], Counter[int]] = defaultdict(Counter)
    total_eval_games = 0
    total_truncations = 0
    pair_seed_ranges: dict[str, tuple[int, int]] = {}

    evaluation_receipts = receipts[len(training_tasks) :]
    for receipt in evaluation_receipts:
        task = task_by_id[receipt["task_id"]]
        for path_key, hash_key in (
            ("arena_summary_path", "arena_summary_sha256"),
            ("arena_games_path", "arena_games_sha256"),
            ("arena_csv_path", "arena_csv_sha256"),
        ):
            path = local_path(str(receipt[path_key]))
            actual = sha256_file(path) if path.exists() else "MISSING"
            artifact_hash_checks += 1
            if actual != receipt[hash_key]:
                artifact_hash_mismatches.append(f"{receipt['task_id']}:{path_key}")

        csv_path = local_path(str(receipt["arena_csv_path"]))
        with csv_path.open("r", encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream))
        counts = Counter(outcome_from_csv(row) for row in rows)
        task_wdl[receipt["task_id"]] = counts
        total_eval_games += len(rows)
        truncations = sum(str(row["truncated"]).lower() == "true" for row in rows)
        total_truncations += truncations
        expected = Counter(
            {"W": int(receipt["a_wins"]), "D": int(receipt["draws"]), "L": int(receipt["a_losses"])}
        )
        if counts != expected:
            errors.append(f"{receipt['task_id']}: raw CSV W/D/L differs from receipt")
        if len(rows) != int(receipt["games_completed"]):
            errors.append(f"{receipt['task_id']}: raw CSV game count differs from receipt")
        if truncations != int(receipt["truncated_games"]):
            errors.append(f"{receipt['task_id']}: raw CSV truncation count differs from receipt")
        pair_indices = [int(row["pair_index"]) for row in rows]
        seeds = [int(row["seed"]) for row in rows]
        if seeds:
            pair_seed_ranges[receipt["task_id"]] = (min(seeds), max(seeds))
        for row in rows:
            expected_seed = int(task["seed"]) + int(row["pair_index"])
            if int(row["seed"]) != expected_seed:
                errors.append(f"{receipt['task_id']}: pair seed derivation mismatch")
                break
        if sorted(pair_indices) != sorted(index // 2 for index in range(len(rows))):
            errors.append(f"{receipt['task_id']}: pair index multiplicity mismatch")

        key = (
            task["evaluation_kind"],
            int(task["eval_size"]),
            task_agent_name(task["agent_a"]),
            task_agent_name(task["agent_b"]),
            int(task["checkpoint_gradient_steps"]),
        )
        aggregate_wdl[key].update(counts)
        aggregate_seed_counts[key][int(task["seed"])] += 1
        # The final UCT row is intentionally reused as the 200-step learning-
        # curve point.  Preserve that purpose-level alias instead of grouping
        # solely by evaluation_kind.
        if "learning_curve" in task.get("purposes", []) and task["evaluation_kind"] != "learning_curve":
            learning_key = ("learning_curve",) + key[1:]
            aggregate_wdl[learning_key].update(counts)
            aggregate_seed_counts[learning_key][int(task["seed"])] += 1

    if artifact_hash_mismatches:
        errors.append(f"artifact hash mismatches: {len(artifact_hash_mismatches)}")

    # Profile every D16 raw game.  Opening cluster is deliberately defined as
    # (color assignment, first six action indices); full trajectory uses the
    # complete action-index sequence.  Both ignore timing and diagnostics.
    rr_tasks: list[dict[str, Any]] = []
    rr_task_profiles: dict[str, dict[str, Any]] = {}
    rr_group_opening: dict[tuple[Any, ...], Counter[str]] = defaultdict(Counter)
    rr_group_full: dict[tuple[Any, ...], Counter[str]] = defaultdict(Counter)
    receipt_by_id = {receipt["task_id"]: receipt for receipt in receipts}
    for task in evaluation_tasks:
        if task["evaluation_kind"] != "representation_round_robin":
            continue
        rr_tasks.append(task)
        receipt = receipt_by_id[task["task_id"]]
        opening = Counter()
        full = Counter()
        with local_path(str(receipt["arena_games_path"])).open("r", encoding="utf-8") as stream:
            for line in stream:
                record = json.loads(line)
                actions = [int(entry["action"]) for entry in record["actions"]]
                color = f"{record['black_slot']}-{record['white_slot']}"
                opening_key = hashlib.sha256(canonical([color, actions[:6]]).encode()).hexdigest()
                full_key = hashlib.sha256(canonical([color, actions]).encode()).hexdigest()
                opening[opening_key] += 1
                full[full_key] += 1
        group_key = (
            int(task["eval_size"]),
            task_agent_name(task["agent_a"]),
            task_agent_name(task["agent_b"]),
        )
        rr_group_opening[group_key].update(opening)
        rr_group_full[group_key].update(full)
        rr_task_profiles[task["task_id"]] = {
            "opening_clusters": len(opening),
            "opening_cluster_sizes": sorted(opening.values(), reverse=True),
            "full_trajectory_clusters": len(full),
            "full_trajectory_cluster_sizes": sorted(full.values(), reverse=True),
        }

    # Replay the first swapped-color pair from every evaluation task.  This
    # covers all 315 task identities and all five training seeds while remaining
    # a bounded sample of the 30,600 receipt-bound records.
    replayed_games = 0
    replay_seed_counts: Counter[int] = Counter()
    replay_failures: list[str] = []
    for task in evaluation_tasks:
        receipt = receipt_by_id[task["task_id"]]
        selected = {0, 1}
        try:
            records = list(iter_selected_jsonl(local_path(str(receipt["arena_games_path"])), selected))
            if len(records) != 2:
                raise AssertionError("did not read two sampled games")
            for record in records:
                replay_record(record)
                replayed_games += 1
                replay_seed_counts[int(task["seed"])] += 1
        except Exception as exc:  # audit evidence must retain the exact failing task
            replay_failures.append(f"{task['task_id']}: {type(exc).__name__}: {exc}")

    def summarized_rows(kind: str) -> list[dict[str, Any]]:
        rows = []
        for key, counts in aggregate_wdl.items():
            evaluation_kind, size, agent_a, agent_b, step = key
            if evaluation_kind != kind:
                continue
            games = counts["W"] + counts["D"] + counts["L"]
            score = (counts["W"] + 0.5 * counts["D"]) / games
            rows.append(
                {
                    "size": size,
                    "agent_a": agent_a,
                    "agent_b": agent_b,
                    "gradient_step": step,
                    "W": counts["W"],
                    "D": counts["D"],
                    "L": counts["L"],
                    "games": games,
                    "score": score,
                    "wilson_ci95": wilson_interval(score, games),
                    "training_seeds": sorted(aggregate_seed_counts[key]),
                }
            )
        return sorted(rows, key=canonical)

    independent_rows = {
        "learning_curve": summarized_rows("learning_curve"),
        "final_vs_search": summarized_rows("final_vs_search"),
        "representation_round_robin": summarized_rows("representation_round_robin"),
    }
    canonical_comparison: dict[str, Any] = {"enabled": False}
    if compare_canonical:
        aggregate = json.loads(AGGREGATE.read_text(encoding="utf-8"))
        canonical_sections = {
            "learning_curve": aggregate["arena_learning_curve"],
            "final_vs_search": aggregate["final_vs_search"],
            "representation_round_robin": aggregate["representation_round_robin"],
        }

        def independent_key(kind: str, row: dict[str, Any]) -> tuple[Any, ...]:
            base = (int(row["size"]), str(row["agent_a"]), str(row["agent_b"]))
            return base + ((int(row["gradient_step"]),) if kind == "learning_curve" else ())

        def canonical_key(kind: str, row: dict[str, Any]) -> tuple[Any, ...]:
            base = (int(row["eval_size"]), str(row["agent_a_id"]), str(row["agent_b_id"]))
            return base + ((int(row["checkpoint_gradient_steps"]),) if kind == "learning_curve" else ())

        wdl_mismatches = 0
        score_mismatches = 0
        wilson_mismatches = 0
        missing_keys: list[str] = []
        extra_keys: list[str] = []
        max_abs_error = 0.0
        compared_rows = 0
        for kind, rows in independent_rows.items():
            observed = {independent_key(kind, row): row for row in rows}
            expected = {canonical_key(kind, row): row for row in canonical_sections[kind]}
            missing_keys.extend(f"{kind}:{key}" for key in sorted(expected.keys() - observed.keys()))
            extra_keys.extend(f"{kind}:{key}" for key in sorted(observed.keys() - expected.keys()))
            for key in sorted(observed.keys() & expected.keys()):
                left = observed[key]
                right = expected[key]
                compared_rows += 1
                if (left["W"], left["D"], left["L"], left["games"]) != (
                    int(right["a_wins"]),
                    int(right["draws"]),
                    int(right["a_losses"]),
                    int(right["games_completed"]),
                ):
                    wdl_mismatches += 1
                score_error = abs(float(left["score"]) - float(right["a_score_rate"]))
                max_abs_error = max(max_abs_error, score_error)
                if score_error > 1e-12:
                    score_mismatches += 1
                interval_errors = [
                    abs(float(a) - float(b))
                    for a, b in zip(left["wilson_ci95"], right["a_score_ci95_wilson"])
                ]
                max_abs_error = max(max_abs_error, *interval_errors)
                if any(value > 1e-12 for value in interval_errors):
                    wilson_mismatches += 1
        canonical_comparison = {
            "enabled": True,
            "aggregate_sha256": sha256_file(AGGREGATE),
            "independent_rows": sum(len(rows) for rows in independent_rows.values()),
            "canonical_rows": sum(len(rows) for rows in canonical_sections.values()),
            "compared_rows": compared_rows,
            "missing_keys": missing_keys,
            "extra_keys": extra_keys,
            "wdl_mismatches": wdl_mismatches,
            "score_mismatches": score_mismatches,
            "wilson_mismatches": wilson_mismatches,
            "max_abs_error": max_abs_error,
        }
        if missing_keys or extra_keys or wdl_mismatches or score_mismatches or wilson_mismatches:
            errors.append("canonical aggregate differs from independently reconstructed rows")

    rr_task_unique = Counter(profile["full_trajectory_clusters"] for profile in rr_task_profiles.values())
    rr_group_summary = []
    for key in sorted(rr_group_full, key=canonical):
        size, agent_a, agent_b = key
        rr_group_summary.append(
            {
                "size": size,
                "agent_a": agent_a,
                "agent_b": agent_b,
                "games": sum(rr_group_full[key].values()),
                "opening_clusters_first6_with_color": len(rr_group_opening[key]),
                "full_trajectory_clusters_with_color": len(rr_group_full[key]),
                "largest_opening_cluster": max(rr_group_opening[key].values()),
                "largest_full_trajectory_cluster": max(rr_group_full[key].values()),
            }
        )

    report = {
        "audit_contract": {
            "aggregate_files_loaded": compare_canonical,
            "results_document_loaded": False,
            "raw_sources": [
                project_relative(MANIFEST),
                project_relative(BUNDLE / "training_tasks.jsonl"),
                project_relative(BUNDLE / "evaluation_tasks.jsonl"),
                project_relative(LEDGER),
                "receipt-bound per-game CSV/JSONL and checkpoints",
            ],
            "opening_cluster_definition": "color assignment plus first six action indices",
        },
        "manifest": {
            "canonical_sha256": manifest_hash,
            "file_sha256": manifest_file_hash,
            "snapshot_file_sha256": snapshot_file_hash,
            "experiment_id": manifest["experiment_id"],
            "evidence_tier": manifest["evidence_tier"],
        },
        "tasks_and_receipts": {
            "expected_tasks": len(tasks),
            "training_tasks": len(training_tasks),
            "evaluation_tasks": len(evaluation_tasks),
            "receipt_lines": len(receipts),
            "missing": sorted(expected_ids - seen_ids),
            "extra": sorted(seen_ids - expected_ids),
            "duplicate_count": len(receipt_ids) - len(seen_ids),
            "status_counts": dict(status_counts),
            "kind_counts": dict(kind_counts),
        },
        "training": {
            "self_play_games": self_play_games,
            "gradient_steps": gradient_steps,
            "parameter_counts": {key: sorted(value) for key, value in sorted(parameter_counts.items())},
            "checkpoint_hash_checks": checkpoint_hash_checks,
            "config_hash_checks": config_hash_checks,
        },
        "identity": {
            "unique_receipt_identities": len(identity_strings),
            "receipt_identity": receipt_identity,
            "current_identity_hashes": current_identity,
        },
        "artifacts": {
            "sha256_checks": artifact_hash_checks,
            "sha256_mismatches": artifact_hash_mismatches,
        },
        "evaluation": {
            "raw_csv_games": total_eval_games,
            "raw_csv_truncations": total_truncations,
            "task_wdl_mismatch_count": sum("raw CSV W/D/L" in error for error in errors),
            "pair_seed_min": min(value[0] for value in pair_seed_ranges.values()),
            "pair_seed_max": max(value[1] for value in pair_seed_ranges.values()),
            "learning_curve": independent_rows["learning_curve"],
            "final_vs_search": independent_rows["final_vs_search"],
            "representation_round_robin": independent_rows["representation_round_robin"],
        },
        "canonical_comparison": canonical_comparison,
        "seed_and_opening_clusters": {
            "declared_training_seeds": manifest["seeds"],
            "round_robin_tasks_by_full_trajectory_cluster_count": dict(rr_task_unique),
            "round_robin_groups": rr_group_summary,
        },
        "independent_replay_sample": {
            "selection": "game_index 0 and 1 from every evaluation task",
            "tasks": len(evaluation_tasks),
            "games_replayed": replayed_games,
            "training_seed_coverage": dict(sorted(replay_seed_counts.items())),
            "failures": replay_failures,
        },
        "errors": errors + replay_failures,
        "ok": not errors and not replay_failures,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
    sys.stdout.write(rendered)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
