#!/usr/bin/env python3
"""Independent, fail-closed verifier for a completed local D20 run.

This file deliberately does not import the D20 runner. It separately hashes
the source closure, loads final checkpoints, replays every persisted arena
game from the registered opening, and recomputes training-seed factorial
contrasts before comparing them with the runner's canonical numeric artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:
    import d19_v2_matched_history_contract as matched_contract  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    from scripts import d19_v2_matched_history_contract as matched_contract  # type: ignore

import torch

from lifeline_rl import LifelineGame, Player


SCHEMA_VERSION = 2
EXPERIMENT_ID = "d20_matched_logical_edges_compact_history_formal_v2"
REPORT_SCHEMA = "lifeline-d20-matched-ablation-independent-verification"
NUMERIC_SCHEMA = "lifeline-d20-matched-ablation-canonical-numeric"
DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d20_matched_ablation_manifest_v2.json"


class VerificationError(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise VerificationError(f"not canonical finite JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest().upper()


def sha256_file(path: str | Path) -> str:
    target = Path(path)
    if not target.is_file() or target.is_symlink():
        raise VerificationError(f"not a regular file: {target}")
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be a JSON object")
    return value


def read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise VerificationError(f"cannot read {label}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            raise VerificationError(f"blank JSONL row in {label} at {number}")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise VerificationError(f"invalid JSONL row in {label} at {number}") from exc
        if not isinstance(value, dict):
            raise VerificationError(f"non-object JSONL row in {label} at {number}")
        rows.append(value)
    return rows


def apply_index(game: LifelineGame, action: int) -> None:
    result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
    if not result.success:
        raise VerificationError(f"illegal action {action}: {result.reason}")


def opening_game(size: int, actions: Sequence[int]) -> LifelineGame:
    game = LifelineGame(size, superko_mode="enforce")
    for action in actions:
        if game.game_over:
            raise VerificationError("opening continues after terminal state")
        apply_index(game, int(action))
    if game.game_over:
        raise VerificationError("opening is terminal")
    return game


def score_for_a(row: Mapping[str, Any]) -> float | None:
    if bool(row["truncated"]):
        return None
    if row["winner"] == "DRAW":
        return 0.5
    a_colour = "BLACK" if row["black_slot"] == "A" else "WHITE"
    return 1.0 if row["winner"] == a_colour else 0.0


def replay_game(row: Mapping[str, Any]) -> None:
    game = opening_game(int(row["grid_size"]), [int(value) for value in row["opening_actions"]])
    if game.state_fingerprint() != row["opening_fingerprint"]:
        raise VerificationError("opening fingerprint mismatch")
    actions = row.get("actions")
    if not isinstance(actions, list):
        raise VerificationError("continuation actions are not a list")
    for ply, action_row in enumerate(actions):
        if not isinstance(action_row, Mapping) or game.game_over:
            raise VerificationError("malformed or post-terminal continuation")
        if action_row.get("ply") != ply or action_row.get("actor") != game.current_player.value:
            raise VerificationError("continuation ply or actor mismatch")
        if action_row.get("state_fingerprint") != game.state_fingerprint():
            raise VerificationError("continuation pre-action fingerprint mismatch")
        apply_index(game, int(action_row["action"]))
    if bool(row["truncated"]):
        if game.game_over:
            raise VerificationError("terminal game labelled truncated")
        return
    if not game.game_over:
        raise VerificationError("non-truncated game did not terminate")
    winner = game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = {player.value: game.cached_territories[player].area for player in (Player.BLACK, Player.WHITE)}
    if winner_value != row.get("winner") or territories != row.get("territories"):
        raise VerificationError("winner or territory mismatch after replay")
    if game.state_fingerprint() != row.get("final_state_fingerprint"):
        raise VerificationError("final state fingerprint mismatch")


def t_interval(values: Sequence[float]) -> dict[str, Any]:
    if len(values) != 5:
        raise VerificationError("each primary estimate must retain all five seeds")
    mean = statistics.fmean(values)
    margin = 2.7764451051977987 * statistics.stdev(values) / math.sqrt(5.0)
    return {"n": 5, "df": 4, "mean": mean, "ci95": [mean - margin, mean + margin]}


def recompute_numeric(
    games: Sequence[Mapping[str, Any]],
    *,
    expected_games_per_cell: int,
) -> dict[str, Any]:
    groups: dict[tuple[str, int, str, int], list[float]] = {}
    for row in games:
        score = score_for_a(row)
        if score is None:
            raise VerificationError("truncated game is not aggregable")
        key = (str(row["arm_id"]), int(row["training_seed"]), str(row["opponent_id"]), int(row["grid_size"]))
        groups.setdefault(key, []).append(float(score))
    by_cell: dict[tuple[str, int], dict[str, dict[int, float]]] = {}
    for (arm, seed, opponent, size), scores in groups.items():
        if len(scores) != expected_games_per_cell:
            raise VerificationError(
                f"{arm}/seed{seed}/{opponent}/n{size} has {len(scores)} games, "
                f"not {expected_games_per_cell}"
            )
        by_cell.setdefault((opponent, size), {}).setdefault(arm, {})[seed] = statistics.fmean(scores)

    arms = ("edge0_history0", "edge1_history0", "edge0_history1", "edge1_history1")
    cells: list[dict[str, Any]] = []
    contrasts: list[dict[str, Any]] = []
    for (opponent, size), values_by_arm in sorted(by_cell.items()):
        if set(values_by_arm) != set(arms):
            raise VerificationError("factorial cell lacks one or more arms")
        seed_sets = [set(values_by_arm[arm]) for arm in arms]
        if any(seed_set != seed_sets[0] for seed_set in seed_sets[1:]) or len(seed_sets[0]) != 5:
            raise VerificationError("factorial cell lacks paired five-seed coverage")
        seeds = sorted(seed_sets[0])
        values = {arm: [values_by_arm[arm][seed] for seed in seeds] for arm in arms}
        for arm in arms:
            cells.append({
                "opponent_id": opponent,
                "eval_size": size,
                "arm_id": arm,
                "training_seed_score_rates": values[arm],
                "training_seed_interval": t_interval(values[arm]),
            })
        e00, e10, e01, e11 = (values[arm] for arm in arms)
        contrast_values = {
            "logical_at_history0": [right - left for left, right in zip(e00, e10)],
            "logical_at_history1": [right - left for left, right in zip(e01, e11)],
            "history_at_edge0": [right - left for left, right in zip(e00, e01)],
            "history_at_edge1": [right - left for left, right in zip(e10, e11)],
            "interaction": [a - b - c + d for a, b, c, d in zip(e11, e10, e01, e00)],
        }
        for name, values_for_contrast in contrast_values.items():
            contrasts.append({
                "opponent_id": opponent,
                "eval_size": size,
                "contrast": name,
                "training_seed_values": values_for_contrast,
                "training_seed_interval": t_interval(values_for_contrast),
            })
    return {
        "schema_name": NUMERIC_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "primary_statistical_unit": "training_seed",
        "pooled_games_are_independent": False,
        "cell_estimates": cells,
        "factorial_contrasts": contrasts,
        "evaluation_games": len(games),
    }


def source_bindings_ok(manifest: Mapping[str, Any]) -> None:
    bindings = manifest.get("source_bindings")
    if not isinstance(bindings, Mapping):
        raise VerificationError("manifest source bindings missing")
    for raw_path, expected in bindings.items():
        if not isinstance(raw_path, str) or not isinstance(expected, str):
            raise VerificationError("malformed source binding")
        candidate = (REPO_ROOT / raw_path).resolve()
        try:
            candidate.relative_to(REPO_ROOT.resolve())
        except ValueError as exc:
            raise VerificationError("source binding escapes repository") from exc
        if sha256_file(candidate) != expected.upper():
            raise VerificationError(f"source binding drifted: {raw_path}")


def _safe_checkpoint_path(raw: object, run_root: Path) -> Path:
    if not isinstance(raw, str) or not raw:
        raise VerificationError("checkpoint path missing")
    candidate = (REPO_ROOT / raw).resolve()
    try:
        candidate.relative_to(run_root)
    except ValueError as exc:
        raise VerificationError("checkpoint path escapes D20 run root") from exc
    return candidate


def verify(run_root: str | Path, *, manifest_path: str | Path = DEFAULT_MANIFEST) -> tuple[dict[str, Any], dict[str, Any]]:
    root = Path(run_root).resolve()
    manifest = read_json(Path(manifest_path).resolve(), "manifest")
    if manifest.get("experiment_id") != EXPERIMENT_ID:
        raise VerificationError("wrong D20 experiment identifier")
    source_bindings_ok(manifest)
    metadata = read_json(root / "run_metadata.json", "run metadata")
    manifest_hash = canonical_sha256(manifest)
    if metadata.get("experiment_id") != EXPERIMENT_ID or metadata.get("manifest_sha256") != manifest_hash:
        raise VerificationError("run metadata binding mismatch")
    if metadata.get("source_hashes") != manifest.get("source_bindings"):
        raise VerificationError("run metadata source closure mismatch")
    calibration = read_json(root / "strong_opponent_calibration.json", "strong-opponent calibration")
    if metadata.get("strong_opponent_calibration") != calibration:
        raise VerificationError("strong-opponent calibration metadata mismatch")
    report_path_raw = calibration.get("report_path")
    if not isinstance(report_path_raw, str) or not report_path_raw:
        raise VerificationError("strong-opponent calibration report path missing")
    calibration_path = (REPO_ROOT / report_path_raw).resolve()
    try:
        calibration_path.relative_to((REPO_ROOT / "local_artifacts").resolve())
    except ValueError as exc:
        raise VerificationError("strong-opponent calibration report escapes local artifacts") from exc
    if sha256_file(calibration_path) != calibration.get("report_sha256"):
        raise VerificationError("strong-opponent calibration report hash mismatch")
    calibration_report = read_json(calibration_path, "strong-opponent calibration report")
    if calibration_report != calibration.get("report"):
        raise VerificationError("strong-opponent calibration report content mismatch")
    required_calibration = {
        "status": "PASS",
        "formal_ready": True,
        "candidate_id": "minimax_d2_cap8_v1",
        "passed_sizes": [10, 12],
    }
    for key, expected in required_calibration.items():
        if calibration_report.get(key) != expected:
            raise VerificationError(f"strong-opponent calibration fails at {key}")
    plan = read_json(root / "task_plan.json", "task plan")
    training_tasks = plan.get("training")
    evaluation_tasks = plan.get("evaluation")
    if not isinstance(training_tasks, list) or not isinstance(evaluation_tasks, list):
        raise VerificationError("task plan has no task lists")
    totals = manifest.get("planned_totals")
    if not isinstance(totals, Mapping) or len(training_tasks) != totals.get("training_tasks") or len(evaluation_tasks) != totals.get("evaluation_tasks"):
        raise VerificationError("task-plan totals mismatch")
    training_receipts = read_jsonl(root / "training_receipts.jsonl", "training receipts")
    evaluation_receipts = read_jsonl(root / "evaluation_receipts.jsonl", "evaluation receipts")
    if len(training_receipts) != len(training_tasks) or len(evaluation_receipts) != len(evaluation_tasks):
        raise VerificationError("receipt coverage mismatch")
    planned_training = {str(task["task_id"]) for task in training_tasks}
    received_training = {str(receipt.get("task", {}).get("task_id")) for receipt in training_receipts}
    if planned_training != received_training:
        raise VerificationError("training receipt ID coverage mismatch")
    for receipt in training_receipts:
        if receipt.get("status") != "complete" or receipt.get("kind") != "training":
            raise VerificationError("incomplete training receipt")
        task = receipt.get("task")
        checkpoint = receipt.get("checkpoint")
        if not isinstance(task, Mapping) or not isinstance(checkpoint, Mapping):
            raise VerificationError("malformed training receipt")
        path = _safe_checkpoint_path(checkpoint.get("checkpoint_path"), root)
        if sha256_file(path) != checkpoint.get("checkpoint_sha256"):
            raise VerificationError("checkpoint byte hash mismatch")
        try:
            payload = torch.load(path, map_location="cpu", weights_only=True)
        except Exception as exc:
            raise VerificationError("checkpoint cannot be loaded") from exc
        if not isinstance(payload, Mapping) or payload.get("task_id") != task.get("task_id"):
            raise VerificationError("checkpoint task binding mismatch")
        state = payload.get("model_state_dict")
        if not isinstance(state, Mapping):
            raise VerificationError("checkpoint has no model state")
        model = matched_contract.instantiate_matched_model(int(task["training_seed"]))
        model.load_state_dict(state, strict=True)
        if sum(parameter.numel() for parameter in model.parameters()) != 63_235:
            raise VerificationError("checkpoint parameter count mismatch")
        if matched_contract.model_state_sha256(model) != checkpoint.get("model_state_sha256"):
            raise VerificationError("checkpoint state hash mismatch")
    planned_evaluation = {str(task["task_id"]) for task in evaluation_tasks}
    received_evaluation = {str(receipt.get("task", {}).get("task_id")) for receipt in evaluation_receipts}
    if planned_evaluation != received_evaluation:
        raise VerificationError("evaluation receipt ID coverage mismatch")
    games = read_jsonl(root / "evaluation_games.jsonl", "evaluation games")
    if len(games) != totals.get("evaluation_games"):
        raise VerificationError("evaluation game count mismatch")
    evaluation = manifest.get("evaluation")
    if not isinstance(evaluation, Mapping):
        raise VerificationError("evaluation config missing")
    expected_task_games = int(evaluation["games_per_task"])
    expected_pairs = int(evaluation["paired_color_pairs"])
    expected_openings = int(evaluation["opening_strata"]) * int(evaluation["opening_variants_per_stratum"])
    per_task: dict[str, list[Mapping[str, Any]]] = {}
    for row in games:
        raw = dict(row)
        recorded_hash = raw.pop("row_sha256", None)
        if recorded_hash != canonical_sha256(raw):
            raise VerificationError("game-row hash mismatch")
        replay_game(row)
        per_task.setdefault(str(row["task_id"]), []).append(row)
    for receipt in evaluation_receipts:
        if receipt.get("status") != "complete" or receipt.get("kind") != "evaluation":
            raise VerificationError("incomplete evaluation receipt")
        task = receipt.get("task")
        if not isinstance(task, Mapping):
            raise VerificationError("malformed evaluation receipt")
        rows = per_task.get(str(task["task_id"]), [])
        if len(rows) != expected_task_games or any(bool(row["truncated"]) for row in rows):
            raise VerificationError("task has incorrect game coverage or truncation")
        pairs: dict[str, list[Mapping[str, Any]]] = {}
        for row in rows:
            pairs.setdefault(str(row["pair_id"]), []).append(row)
        if len(pairs) != expected_pairs or any(len(pair) != 2 for pair in pairs.values()):
            raise VerificationError("pair coverage mismatch")
        for pair in pairs.values():
            if {row["black_slot"] for row in pair} != {"A", "B"}:
                raise VerificationError("colour swap missing")
            if pair[0]["opening_fingerprint"] != pair[1]["opening_fingerprint"]:
                raise VerificationError("paired games have distinct openings")
        if len({row["opening_fingerprint"] for row in rows}) != expected_openings:
            raise VerificationError("opening diversity gate failed")
    numeric = recompute_numeric(games, expected_games_per_cell=expected_task_games)
    canonical = read_json(root / "canonical_numeric.json", "canonical numeric")
    if canonical_sha256(canonical) != canonical_sha256(numeric):
        raise VerificationError("runner numeric aggregate differs from independent recomputation")
    report = {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "formal_ready": True,
        "experiment_id": EXPERIMENT_ID,
        "independent_of_runner_import": True,
        "manifest_sha256": manifest_hash,
        "training_tasks": len(training_receipts),
        "evaluation_tasks": len(evaluation_receipts),
        "evaluation_games_replayed": len(games),
        "canonical_numeric_sha256": canonical_sha256(numeric),
    }
    return report, numeric


def write_new(path: Path, payload: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise VerificationError(f"refusing to overwrite report: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--run-root", type=Path, required=True)
    result.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    result.add_argument("--report-output", type=Path, required=True)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        report, numeric = verify(args.run_root, manifest_path=args.manifest)
    except Exception as exc:
        report = {
            "schema_name": REPORT_SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "status": "FAIL_CLOSED",
            "formal_ready": False,
            "experiment_id": EXPERIMENT_ID,
            "issues": [f"{type(exc).__name__}: {exc}"],
        }
        numeric = None
    output = {"report": report, "canonical_numeric": numeric}
    try:
        write_new(args.report_output, output)
    except Exception as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "issue": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 2
    print(json.dumps(output, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report.get("formal_ready") is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
