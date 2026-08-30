#!/usr/bin/env python3
"""Reconstruct D14--D16 seed/pair summaries without running new games.

The audit reads the frozen task bundle, all 330 receipts, every receipt-bound
CSV/JSONL artifact, and the compact canonical aggregates.  It writes only
derived review receipts outside the frozen formal tree.  Medians and ranges are
descriptive; this script deliberately computes no p-values or confidence
intervals and authorizes no independent-game, ranking, or generalization claim.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import statistics
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PROJECT = Path(__file__).resolve().parents[1]
REVIEWS = PROJECT / "reviews"
FORMAL_ROOT = PROJECT / "results" / "formal" / "d14_d16"
MANIFEST = PROJECT / "configs" / "d14_d16_formal_manifest.json"
BUNDLE = FORMAL_ROOT / "task_bundle_v1"
TRAINING_TASKS = BUNDLE / "training_tasks.jsonl"
EVALUATION_TASKS = BUNDLE / "evaluation_tasks.jsonl"
RUN = FORMAL_ROOT / "run_v1"
LEDGER = RUN / "result_receipts.jsonl"
AGGREGATE_ROOT = FORMAL_ROOT / "aggregate_v1"
AGGREGATE_JSON = AGGREGATE_ROOT / "aggregate.json"
CANONICAL_CSVS = {
    "learning_curve": AGGREGATE_ROOT / "arena_learning_curve.csv",
    "final_vs_search": AGGREGATE_ROOT / "final_vs_search.csv",
    "representation_round_robin": AGGREGATE_ROOT / "representation_round_robin.csv",
}
DEFAULT_JSON = REVIEWS / "d14_d16_seed_pair_descriptive_audit.json"
DEFAULT_MARKDOWN = REVIEWS / "d14_d16_seed_pair_descriptive_audit.md"
SCRIPT = Path(__file__).resolve()


class AuditError(RuntimeError):
    """Raised when frozen evidence or a reconstruction invariant disagrees."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def project_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT.resolve()).as_posix()
    except ValueError as exc:
        raise AuditError(f"path is outside the project: {path}") from exc


def resolve_receipt_path(value: str) -> Path:
    path = Path(value)
    if not path.exists():
        lowered = [part.lower() for part in path.parts]
        if "iclr2027" not in lowered:
            raise AuditError(f"receipt path is not relocatable: {value}")
        index = lowered.index("iclr2027")
        path = PROJECT.joinpath(*path.parts[index + 1 :])
    path = path.resolve()
    project_relative(path)
    if not path.is_file():
        raise AuditError(f"receipt artifact is missing: {path}")
    return path


def load_json(path: Path) -> tuple[Any, str]:
    raw = path.read_bytes()
    try:
        return json.loads(raw), sha256_bytes(raw)
    except json.JSONDecodeError as exc:
        raise AuditError(f"invalid JSON: {project_relative(path)}: {exc}") from exc


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    rows: list[dict[str, Any]] = []
    try:
        for line in raw.splitlines():
            if line.strip():
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise AuditError(f"non-object JSONL row: {project_relative(path)}")
                rows.append(value)
    except json.JSONDecodeError as exc:
        raise AuditError(f"invalid JSONL: {project_relative(path)}: {exc}") from exc
    return rows, sha256_bytes(raw)


def hash_and_count_jsonl(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as stream:
        for raw_line in stream:
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            value = json.loads(raw_line)
            if not isinstance(value, dict):
                raise AuditError(f"non-object JSONL row: {project_relative(path)}")
            count += 1
    return digest.hexdigest(), count


def load_csv(path: Path) -> tuple[list[dict[str, str]], str]:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AuditError(f"CSV is not UTF-8: {project_relative(path)}") from exc
    rows = list(csv.DictReader(io.StringIO(text, newline="")))
    return rows, sha256_bytes(raw)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditError(message)


def agent_name(spec: Mapping[str, Any]) -> str:
    if spec.get("kind") == "learned_checkpoint":
        return str(spec["representation"])
    return str(spec.get("baseline_id", spec.get("agent_kind", "unknown")))


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    lowered = str(value).strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    raise AuditError(f"invalid boolean value: {value!r}")


def outcome_for_a(*, black_slot: str, white_slot: str, winner: str) -> str:
    require({black_slot, white_slot} == {"A", "B"}, "invalid A/B color assignment")
    if winner == "DRAW":
        return "D"
    require(winner in {"BLACK", "WHITE"}, f"invalid winner: {winner}")
    winning_slot = black_slot if winner == "BLACK" else white_slot
    return "W" if winning_slot == "A" else "L"


def wdl_score(counts: Mapping[str, int]) -> float:
    games = int(counts.get("W", 0)) + int(counts.get("D", 0)) + int(counts.get("L", 0))
    require(games > 0, "cannot score an empty outcome collection")
    return (int(counts.get("W", 0)) + 0.5 * int(counts.get("D", 0))) / games


def summary(values: Sequence[float]) -> dict[str, Any]:
    require(bool(values), "cannot summarize an empty sequence")
    ordered = sorted(float(value) for value in values)
    return {
        "median": statistics.median(ordered),
        "range": [ordered[0], ordered[-1]],
    }


def pair_score_label(outcomes: Iterable[str]) -> tuple[float, str]:
    counts = Counter(outcomes)
    require(sum(counts.values()) == 2, "a color-swapped pair must contain two games")
    quarter_points = 2 * counts["W"] + counts["D"]
    value = quarter_points / 4.0
    label = f"{value:.2f}".rstrip("0").rstrip(".")
    return value, label


def validate_csv_json_core(task_id: str, row: Mapping[str, str], record: Mapping[str, Any]) -> None:
    for key in ("game_index", "pair_index", "seed", "grid_size", "plies"):
        require(int(row[key]) == int(record[key]), f"{task_id}: CSV/JSONL {key} mismatch")
    for key in (
        "superko_mode",
        "black_slot",
        "white_slot",
        "black_agent",
        "white_agent",
        "winner",
    ):
        require(str(row[key]) == str(record[key]), f"{task_id}: CSV/JSONL {key} mismatch")
    require(
        parse_bool(row["truncated"]) == bool(record["truncated"]),
        f"{task_id}: CSV/JSONL truncated mismatch",
    )


def trajectory_profile(record: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    actions = [int(entry["action"]) for entry in record["actions"]]
    color = f"{record['black_slot']}-{record['white_slot']}"
    digest = hashlib.sha256(canonical([color, actions]).encode("utf-8")).hexdigest()
    profile = {
        "trajectory_sha256": digest,
        "color_assignment": (
            "A=BLACK,B=WHITE" if record["black_slot"] == "A" else "A=WHITE,B=BLACK"
        ),
        "black_slot": str(record["black_slot"]),
        "white_slot": str(record["white_slot"]),
        "plies": len(actions),
        "winner": str(record["winner"]),
        "outcome_for_a": outcome_for_a(
            black_slot=str(record["black_slot"]),
            white_slot=str(record["white_slot"]),
            winner=str(record["winner"]),
        ),
        "truncated": bool(record["truncated"]),
    }
    return digest, profile


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def validate_output_path(path: Path) -> Path:
    resolved = path.resolve()
    project_relative(resolved)
    try:
        resolved.relative_to(FORMAL_ROOT.resolve())
    except ValueError:
        return resolved
    raise AuditError("refusing to write a derived audit inside the frozen formal tree")


def process_training_receipts(
    training_tasks: Sequence[Mapping[str, Any]],
    receipt_by_id: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    rows: list[dict[str, Any]] = []
    totals = {"self_play_games": 0, "gradient_steps": 0, "metrics_rows": 0}
    for task in training_tasks:
        task_id = str(task["task_id"])
        receipt = receipt_by_id[task_id]
        require(receipt.get("result_kind") == "training", f"{task_id}: wrong result kind")
        require(receipt.get("status") == "complete", f"{task_id}: training not complete")
        games_path = resolve_receipt_path(str(receipt["games_log_path"]))
        metrics_path = resolve_receipt_path(str(receipt["metrics_path"]))
        games_hash, games_rows = hash_and_count_jsonl(games_path)
        metrics_hash, metrics_rows = hash_and_count_jsonl(metrics_path)
        require(games_hash == receipt["games_log_sha256"], f"{task_id}: games hash mismatch")
        require(metrics_hash == receipt["metrics_sha256"], f"{task_id}: metrics hash mismatch")
        require(
            games_rows == int(receipt["self_play_games_completed"]),
            f"{task_id}: self-play row count mismatch",
        )
        totals["self_play_games"] += games_rows
        totals["gradient_steps"] += int(receipt["gradient_steps_completed"])
        totals["metrics_rows"] += metrics_rows
        rows.append(
            {
                "task_id": task_id,
                "training_seed": int(task["seed"]),
                "model": str(task["representation"]),
                "self_play_games": games_rows,
                "gradient_steps": int(receipt["gradient_steps_completed"]),
                "games_jsonl_sha256": games_hash,
                "metrics_jsonl_sha256": metrics_hash,
                "metrics_rows": metrics_rows,
            }
        )
    return sorted(rows, key=lambda row: row["task_id"]), totals


def process_evaluation_receipt(
    task: Mapping[str, Any], receipt: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    task_id = str(task["task_id"])
    require(receipt.get("result_kind") == "evaluation", f"{task_id}: wrong result kind")
    require(receipt.get("status") == "complete", f"{task_id}: evaluation not complete")
    csv_path = resolve_receipt_path(str(receipt["arena_csv_path"]))
    jsonl_path = resolve_receipt_path(str(receipt["arena_games_path"]))
    csv_rows, csv_hash = load_csv(csv_path)
    require(csv_hash == receipt["arena_csv_sha256"], f"{task_id}: CSV hash mismatch")

    jsonl_digest = hashlib.sha256()
    jsonl_count = 0
    d16_clusters: dict[str, dict[str, Any]] = {}
    d16_counts: Counter[str] = Counter()
    with jsonl_path.open("rb") as stream:
        for raw_line in stream:
            jsonl_digest.update(raw_line)
            if not raw_line.strip():
                continue
            require(jsonl_count < len(csv_rows), f"{task_id}: JSONL has extra rows")
            record = json.loads(raw_line)
            require(isinstance(record, dict), f"{task_id}: non-object JSONL row")
            validate_csv_json_core(task_id, csv_rows[jsonl_count], record)
            if task["evaluation_kind"] == "representation_round_robin":
                digest, profile = trajectory_profile(record)
                if digest in d16_clusters:
                    require(
                        d16_clusters[digest] == profile,
                        f"{task_id}: one full trajectory has inconsistent outcomes",
                    )
                else:
                    d16_clusters[digest] = profile
                d16_counts[digest] += 1
            jsonl_count += 1
    jsonl_hash = jsonl_digest.hexdigest()
    require(jsonl_hash == receipt["arena_games_sha256"], f"{task_id}: JSONL hash mismatch")
    require(jsonl_count == len(csv_rows), f"{task_id}: CSV/JSONL row count mismatch")

    outcomes = [
        outcome_for_a(
            black_slot=row["black_slot"],
            white_slot=row["white_slot"],
            winner=row["winner"],
        )
        for row in csv_rows
    ]
    counts = Counter(outcomes)
    expected_counts = Counter(
        {
            "W": int(receipt["a_wins"]),
            "D": int(receipt["draws"]),
            "L": int(receipt["a_losses"]),
        }
    )
    require(counts == expected_counts, f"{task_id}: reconstructed W/D/L mismatch")
    require(len(csv_rows) == int(receipt["games_completed"]), f"{task_id}: game count mismatch")
    require(not any(parse_bool(row["truncated"]) for row in csv_rows), f"{task_id}: truncation")

    pairs: dict[int, list[tuple[dict[str, str], str]]] = defaultdict(list)
    for row, outcome in zip(csv_rows, outcomes, strict=True):
        pairs[int(row["pair_index"])].append((row, outcome))
    pair_scores: list[float] = []
    pair_histogram: Counter[str] = Counter()
    for pair_index, pair_rows in sorted(pairs.items()):
        require(len(pair_rows) == 2, f"{task_id}: pair {pair_index} does not have two games")
        assignments = {(row["black_slot"], row["white_slot"]) for row, _ in pair_rows}
        require(assignments == {("A", "B"), ("B", "A")}, f"{task_id}: bad color swap")
        pair_seeds = {int(row["seed"]) for row, _ in pair_rows}
        require(pair_seeds == {int(task["seed"]) + pair_index}, f"{task_id}: pair seed drift")
        pair_score, pair_label = pair_score_label(outcome for _, outcome in pair_rows)
        pair_scores.append(pair_score)
        pair_histogram[pair_label] += 1

    model = agent_name(task["agent_a"])
    opponent = agent_name(task["agent_b"])
    row = {
        "task_id": task_id,
        "evaluation_kind": str(task["evaluation_kind"]),
        "purposes": sorted(str(value) for value in task["purposes"]),
        "training_seed": int(task["seed"]),
        "model": model,
        "size": int(task["eval_size"]),
        "opponent": opponent,
        "checkpoint_gradient_steps": int(task["checkpoint_gradient_steps"]),
        "games": len(csv_rows),
        "pairs": len(pairs),
        "W": counts["W"],
        "D": counts["D"],
        "L": counts["L"],
        "score": wdl_score(counts),
        "pair_score": {
            **summary(pair_scores),
            "histogram": dict(sorted(pair_histogram.items(), key=lambda item: float(item[0]))),
        },
        "arena_csv_sha256": csv_hash,
        "arena_games_jsonl_sha256": jsonl_hash,
    }

    d16_profile: dict[str, Any] | None = None
    if task["evaluation_kind"] == "representation_round_robin":
        trajectories = []
        for digest, profile in sorted(
            d16_clusters.items(), key=lambda item: (item[1]["black_slot"] != "A", item[0])
        ):
            trajectories.append({**profile, "repetitions": d16_counts[digest]})
        require(len(trajectories) == 2, f"{task_id}: expected two color-conditioned trajectories")
        require(
            sorted(item["repetitions"] for item in trajectories) == [100, 100],
            f"{task_id}: expected each trajectory to repeat 100 times",
        )
        require(
            {item["color_assignment"] for item in trajectories}
            == {"A=BLACK,B=WHITE", "A=WHITE,B=BLACK"},
            f"{task_id}: missing one color-conditioned trajectory",
        )
        d16_profile = {
            "task_id": task_id,
            "training_seed": int(task["seed"]),
            "model": model,
            "size": int(task["eval_size"]),
            "opponent": opponent,
            "games": len(csv_rows),
            "pairs": len(pairs),
            "W": counts["W"],
            "D": counts["D"],
            "L": counts["L"],
            "score": wdl_score(counts),
            "unique_color_conditioned_full_trajectories": len(trajectories),
            "trajectories": trajectories,
        }
    return row, d16_profile


def build_purpose_groups(
    seed_rows: Sequence[Mapping[str, Any]], declared_seeds: Sequence[int]
) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[Mapping[str, Any]]] = defaultdict(list)
    for row in seed_rows:
        for purpose in row["purposes"]:
            key = (
                purpose,
                row["model"],
                int(row["size"]),
                row["opponent"],
                int(row["checkpoint_gradient_steps"]),
            )
            groups[key].append(row)
    output: list[dict[str, Any]] = []
    expected_seeds = sorted(int(seed) for seed in declared_seeds)
    for key, rows in sorted(groups.items(), key=lambda item: canonical(item[0])):
        purpose, model, size, opponent, step = key
        rows = sorted(rows, key=lambda row: int(row["training_seed"]))
        seeds = [int(row["training_seed"]) for row in rows]
        require(seeds == expected_seeds, f"{purpose}/{model}/n{size}/{opponent}: seed drift")
        pooled = Counter()
        for row in rows:
            pooled.update({label: int(row[label]) for label in ("W", "D", "L")})
        seed_scores = [float(row["score"]) for row in rows]
        output.append(
            {
                "purpose": purpose,
                "model": model,
                "size": size,
                "opponent": opponent,
                "checkpoint_gradient_steps": step,
                "training_seed_n": len(rows),
                "seed_scores": [
                    {"training_seed": int(row["training_seed"]), "score": float(row["score"])}
                    for row in rows
                ],
                "seed_score": summary(seed_scores),
                "pooled_W": pooled["W"],
                "pooled_D": pooled["D"],
                "pooled_L": pooled["L"],
                "pooled_games": sum(pooled.values()),
                "pooled_score": wdl_score(pooled),
            }
        )
    return output


def compare_canonical(groups: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    mismatches: list[str] = []
    compared = 0
    for purpose, path in CANONICAL_CSVS.items():
        canonical_rows, _ = load_csv(path)
        observed_rows = [row for row in groups if row["purpose"] == purpose]

        def observed_key(row: Mapping[str, Any]) -> tuple[Any, ...]:
            base = (str(row["model"]), int(row["size"]), str(row["opponent"]))
            if purpose == "learning_curve":
                return base + (int(row["checkpoint_gradient_steps"]),)
            return base

        def expected_key(row: Mapping[str, str]) -> tuple[Any, ...]:
            base = (str(row["agent_a_id"]), int(row["eval_size"]), str(row["agent_b_id"]))
            if purpose == "learning_curve":
                return base + (int(row["checkpoint_gradient_steps"]),)
            return base

        observed = {observed_key(row): row for row in observed_rows}
        expected = {expected_key(row): row for row in canonical_rows}
        for key in sorted(expected.keys() - observed.keys(), key=canonical):
            mismatches.append(f"{purpose}: missing reconstructed key {key}")
        for key in sorted(observed.keys() - expected.keys(), key=canonical):
            mismatches.append(f"{purpose}: unexpected reconstructed key {key}")
        for key in sorted(observed.keys() & expected.keys(), key=canonical):
            left = observed[key]
            right = expected[key]
            compared += 1
            left_values = (
                int(left["pooled_W"]),
                int(left["pooled_D"]),
                int(left["pooled_L"]),
                int(left["pooled_games"]),
            )
            right_values = (
                int(right["a_wins"]),
                int(right["draws"]),
                int(right["a_losses"]),
                int(right["games_completed"]),
            )
            if left_values != right_values:
                mismatches.append(f"{purpose}: W/D/L/games mismatch at {key}")
            if abs(float(left["pooled_score"]) - float(right["a_score_rate"])) > 1e-12:
                mismatches.append(f"{purpose}: score mismatch at {key}")
    require(not mismatches, "canonical comparison failed: " + "; ".join(mismatches[:5]))
    return {"compared_rows": compared, "mismatches": mismatches}


def format_score(value: float) -> str:
    return f"{value:.3f}"


def markdown_report(report: Mapping[str, Any], json_sha256: str) -> str:
    lines = [
        "# D14--D16 seed/pair-level descriptive audit",
        "",
        "Status: **PASS — descriptive only; no inferential use authorized.**",
        "",
        "This receipt was rebuilt from all 330 frozen receipts and their bound CSV/JSONL ",
        "artifacts. It ran no game, training, or experiment and wrote nothing to the formal tree. ",
        "The independent unit is not 30,600 games: only five training seeds are available, ",
        "color-swapped pairs share checkpoints and schedules, and every D16 200-game task is ",
        "100 exact repetitions of each of two color-conditioned full trajectories. Medians and ",
        "ranges below are descriptive; do not infer significance, independent-game uncertainty, ",
        "a global representation ranking, sample efficiency, or unseen-size generalization.",
        "",
        "## Receipt binding",
        "",
        f"- Script SHA-256: `{report['sources']['reviews/d14_d16_seed_pair_descriptive_audit.py']}`",
        f"- JSON receipt SHA-256: `{json_sha256}`",
        f"- Ledger SHA-256: `{report['sources']['results/formal/d14_d16/run_v1/result_receipts.jsonl']}`",
        f"- Receipts: {report['counts']['receipts']} = "
        f"{report['counts']['training_receipts']} training + "
        f"{report['counts']['evaluation_receipts']} evaluation",
        f"- Evaluation games/pairs: {report['counts']['evaluation_games']:,} / "
        f"{report['counts']['evaluation_pairs']:,}",
        f"- D16 tasks and trajectories: {report['counts']['d16_tasks']} tasks; "
        "2 color-conditioned full trajectories per task, 100 repetitions each",
        f"- Canonical CSV comparison: {report['canonical_comparison']['compared_rows']} rows; "
        "0 mismatches",
        "",
    ]

    section_titles = {
        "learning_curve": "D14 learning-curve checkpoints",
        "final_vs_search": "D15 final checkpoint versus search baselines",
        "representation_round_robin": "D16 representation round robin",
    }
    for purpose in ("learning_curve", "final_vs_search", "representation_round_robin"):
        lines.extend(
            [
                f"## {section_titles[purpose]}",
                "",
                "All scores are from A/model's perspective. `range` is the min--max across n=5 ",
                "training seeds; pooled W/D/L is retained only for reconciliation.",
                "",
                "| Model A | n | Opponent B | Step | Seed scores | Median | Range | Pooled W/D/L | Pooled score |",
                "| --- | ---: | --- | ---: | --- | ---: | --- | ---: | ---: |",
            ]
        )
        rows = [row for row in report["purpose_group_summaries"] if row["purpose"] == purpose]
        for row in rows:
            seed_scores = ", ".join(
                f"{item['training_seed']}:{format_score(item['score'])}"
                for item in row["seed_scores"]
            )
            score_range = row["seed_score"]["range"]
            lines.append(
                f"| {row['model']} | {row['size']} | {row['opponent']} | "
                f"{row['checkpoint_gradient_steps']} | {seed_scores} | "
                f"{format_score(row['seed_score']['median'])} | "
                f"[{format_score(score_range[0])}, {format_score(score_range[1])}] | "
                f"{row['pooled_W']}/{row['pooled_D']}/{row['pooled_L']} | "
                f"{format_score(row['pooled_score'])} |"
            )
        lines.append("")

    lines.extend(
        [
            "## D16 per-task full-trajectory outcomes",
            "",
            "Trajectory hashes bind the color assignment plus the complete action-index sequence. ",
            "Each cell reports outcome for A and exact repetition count; the 200 rows are not 200 ",
            "independent trials.",
            "",
            "| Seed | n | A | B | W/D/L | Score | A=BLACK trajectory | A=WHITE trajectory |",
            "| ---: | ---: | --- | --- | ---: | ---: | --- | --- |",
        ]
    )
    for row in report["d16_task_trajectory_profiles"]:
        by_color = {item["color_assignment"]: item for item in row["trajectories"]}
        black = by_color["A=BLACK,B=WHITE"]
        white = by_color["A=WHITE,B=BLACK"]
        lines.append(
            f"| {row['training_seed']} | {row['size']} | {row['model']} | {row['opponent']} | "
            f"{row['W']}/{row['D']}/{row['L']} | {format_score(row['score'])} | "
            f"{black['outcome_for_a']} x{black['repetitions']}, "
            f"`{black['trajectory_sha256'][:16]}` | "
            f"{white['outcome_for_a']} x{white['repetitions']}, "
            f"`{white['trajectory_sha256'][:16]}` |"
        )
    lines.extend(
        [
            "",
            "## Interpretation boundary",
            "",
            "- `n=5` refers to training seeds, not independent games.",
            "- Pair summaries are schedule- and checkpoint-conditioned descriptive units.",
            "- D16 task scores reduce to two unique color-conditioned outcomes repeated 100 times.",
            "- No confidence interval, p-value, multiple-comparison claim, causal representation ",
            "  effect, global ranking, sample-efficiency claim, or generalization claim is produced.",
            "",
        ]
    )
    return "\n".join(line.rstrip() for line in lines)


def run_audit() -> dict[str, Any]:
    manifest, manifest_hash = load_json(MANIFEST)
    training_tasks, training_tasks_hash = load_jsonl(TRAINING_TASKS)
    evaluation_tasks, evaluation_tasks_hash = load_jsonl(EVALUATION_TASKS)
    receipts, ledger_hash = load_jsonl(LEDGER)
    aggregate, aggregate_hash = load_json(AGGREGATE_JSON)
    require(isinstance(manifest, dict), "manifest must be an object")
    require(isinstance(aggregate, dict), "aggregate must be an object")

    all_tasks = training_tasks + evaluation_tasks
    task_by_id = {str(task["task_id"]): task for task in all_tasks}
    receipt_by_id = {str(receipt["task_id"]): receipt for receipt in receipts}
    require(len(task_by_id) == len(all_tasks), "duplicate task id")
    require(len(receipt_by_id) == len(receipts), "duplicate receipt id")
    require(set(task_by_id) == set(receipt_by_id), "task/receipt identity set mismatch")
    require(len(receipts) == 330, f"expected 330 receipts, found {len(receipts)}")
    require(len(training_tasks) == 15, "expected 15 training tasks")
    require(len(evaluation_tasks) == 315, "expected 315 evaluation tasks")

    training_rows, training_totals = process_training_receipts(training_tasks, receipt_by_id)
    seed_task_rows: list[dict[str, Any]] = []
    d16_profiles: list[dict[str, Any]] = []
    for task in evaluation_tasks:
        row, d16_profile = process_evaluation_receipt(task, receipt_by_id[str(task["task_id"])])
        seed_task_rows.append(row)
        if d16_profile is not None:
            d16_profiles.append(d16_profile)
    seed_task_rows.sort(key=lambda row: row["task_id"])
    d16_profiles.sort(key=lambda row: row["task_id"])

    purpose_groups = build_purpose_groups(seed_task_rows, manifest["seeds"])
    canonical_comparison = compare_canonical(purpose_groups)
    canonical_hashes = {
        project_relative(path): sha256_file(path) for path in CANONICAL_CSVS.values()
    }
    counts = {
        "receipts": len(receipts),
        "training_receipts": len(training_tasks),
        "evaluation_receipts": len(evaluation_tasks),
        "evaluation_games": sum(int(row["games"]) for row in seed_task_rows),
        "evaluation_pairs": sum(int(row["pairs"]) for row in seed_task_rows),
        "purpose_group_rows": len(purpose_groups),
        "d16_tasks": len(d16_profiles),
    }
    require(counts["evaluation_games"] == 30_600, "evaluation game total mismatch")
    require(counts["evaluation_pairs"] == 15_300, "evaluation pair total mismatch")
    require(counts["purpose_group_rows"] == 72, "purpose group total mismatch")
    require(counts["d16_tasks"] == 45, "D16 task total mismatch")
    require(training_totals["self_play_games"] == 1_500, "self-play total mismatch")
    require(training_totals["gradient_steps"] == 3_000, "gradient-step total mismatch")
    require(aggregate.get("formal_ready") is True, "canonical aggregate is not formal-ready")

    sources = {
        project_relative(SCRIPT): sha256_file(SCRIPT),
        project_relative(MANIFEST): manifest_hash,
        project_relative(TRAINING_TASKS): training_tasks_hash,
        project_relative(EVALUATION_TASKS): evaluation_tasks_hash,
        project_relative(LEDGER): ledger_hash,
        project_relative(AGGREGATE_JSON): aggregate_hash,
        **canonical_hashes,
    }
    return {
        "schema_name": "lifeline-d14-d16-seed-pair-descriptive-audit",
        "schema_version": 1,
        "status": "PASS_DESCRIPTIVE_ONLY_NO_INFERENCE",
        "contract": {
            "new_games_run": 0,
            "formal_tree_writes": 0,
            "training_seed_n": len(manifest["seeds"]),
            "score_definition": "(A wins + 0.5 * draws) / games",
            "pair_definition": "same pair_index and seed, with A/B colors swapped",
            "d16_full_trajectory_definition": (
                "SHA-256 of canonical [black_slot-white_slot, complete action-index sequence]"
            ),
            "inference_authorized": False,
        },
        "sources": dict(sorted(sources.items())),
        "counts": counts,
        "training_totals": training_totals,
        "training_receipt_rows": training_rows,
        "seed_task_rows": seed_task_rows,
        "purpose_group_summaries": purpose_groups,
        "d16_task_trajectory_profiles": d16_profiles,
        "canonical_comparison": canonical_comparison,
        "limitations": [
            "Only five training seeds are available in each purpose-level cell.",
            "Color-swapped games within a pair share checkpoints and an evaluation schedule.",
            "Every D16 200-game task contains two color-conditioned full trajectories, each repeated 100 times.",
            "Medians and ranges are descriptive and do not establish independent-game uncertainty.",
            "No significance, global ranking, causal representation effect, sample efficiency, or unseen-size generalization is authorized.",
        ],
    }


def run_self_test() -> None:
    require(outcome_for_a(black_slot="A", white_slot="B", winner="BLACK") == "W", "W")
    require(outcome_for_a(black_slot="A", white_slot="B", winner="WHITE") == "L", "L")
    require(outcome_for_a(black_slot="B", white_slot="A", winner="WHITE") == "W", "W2")
    require(outcome_for_a(black_slot="B", white_slot="A", winner="DRAW") == "D", "D")
    value, label = pair_score_label(["W", "D"])
    require(value == 0.75 and label == "0.75", "pair score")
    require(summary([0.0, 0.25, 0.5, 0.75, 1.0]) == {"median": 0.5, "range": [0.0, 1.0]}, "summary")
    first, first_profile = trajectory_profile(
        {
            "black_slot": "A",
            "white_slot": "B",
            "winner": "BLACK",
            "truncated": False,
            "actions": [{"action": 1}, {"action": 2}],
        }
    )
    second, _ = trajectory_profile(
        {
            "black_slot": "B",
            "white_slot": "A",
            "winner": "BLACK",
            "truncated": False,
            "actions": [{"action": 1}, {"action": 2}],
        }
    )
    require(first != second, "trajectory hash must bind color")
    require(first_profile["outcome_for_a"] == "W", "trajectory outcome")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output-json", type=Path, default=DEFAULT_JSON)
    result.add_argument("--output-markdown", type=Path, default=DEFAULT_MARKDOWN)
    result.add_argument("--self-test", action="store_true")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.self_test:
            run_self_test()
            print(json.dumps({"self_test": "PASS"}, sort_keys=True))
            return 0
        output_json = validate_output_path(args.output_json)
        output_markdown = validate_output_path(args.output_markdown)
        report = run_audit()
        json_text = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        atomic_write(output_json, json_text)
        json_hash = sha256_file(output_json)
        markdown_text = markdown_report(report, json_hash)
        atomic_write(output_markdown, markdown_text)
        result = {
            "status": report["status"],
            "output_json": project_relative(output_json),
            "output_json_sha256": json_hash,
            "output_markdown": project_relative(output_markdown),
            "output_markdown_sha256": sha256_file(output_markdown),
            "counts": report["counts"],
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (AuditError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
