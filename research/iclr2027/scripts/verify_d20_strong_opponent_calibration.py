#!/usr/bin/env python3
"""Independent replay and aggregation verifier for the D20 calibration gate.

This module intentionally does not import ``d20_strong_opponent_calibration``.
It reconstructs the registered schedule and openings from the manifest, then
replays every persisted action before deriving the five-block t intervals.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, Player


SCHEMA_VERSION = 1
MANIFEST_SCHEMA = "lifeline-d20-strong-opponent-calibration-manifest"
RUN_SCHEMA = "lifeline-d20-strong-opponent-calibration-run"
GAME_SCHEMA = "lifeline-d20-strong-opponent-calibration-game"
REPORT_SCHEMA = "lifeline-d20-strong-opponent-calibration-verification"
NUMERIC_SCHEMA = "lifeline-d20-strong-opponent-calibration-numeric"
EXPERIMENT_ID = "d20_strong_opponent_calibration_minimax_d2_cap8_vs_uct16_v1"
PROTOCOL_ID = "d20_strong_opponent_calibration_protocol_20260909_v1"
SCHEDULE_DOMAIN = "d20-strong-opponent-calibration-counter-schedule-v1"

DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d20_strong_opponent_calibration_manifest.json"
DEFAULT_PROTOCOL = RESEARCH_ROOT / "D20_STRONG_OPPONENT_CALIBRATION_PROTOCOL.md"
D20_V2_MANIFEST = RESEARCH_ROOT / "configs" / "d20_matched_ablation_manifest_v2.json"

SOURCE_PATHS = (
    "research/iclr2027/scripts/d20_strong_opponent_calibration.py",
    "research/iclr2027/scripts/verify_d20_strong_opponent_calibration.py",
    "research/iclr2027/lifeline_rl/__init__.py",
    "research/iclr2027/lifeline_rl/arena.py",
    "research/iclr2027/lifeline_rl/core.py",
    "research/iclr2027/lifeline_rl/encoding.py",
    "research/iclr2027/lifeline_rl/env.py",
    "research/iclr2027/lifeline_rl/agents/__init__.py",
    "research/iclr2027/lifeline_rl/agents/base.py",
    "research/iclr2027/lifeline_rl/agents/cycle_seeking.py",
    "research/iclr2027/lifeline_rl/agents/factory.py",
    "research/iclr2027/lifeline_rl/agents/greedy.py",
    "research/iclr2027/lifeline_rl/agents/heuristic.py",
    "research/iclr2027/lifeline_rl/agents/mcts.py",
    "research/iclr2027/lifeline_rl/agents/minimax.py",
    "research/iclr2027/lifeline_rl/agents/random_agent.py",
)


class VerificationError(RuntimeError):
    """Raised when a calibration artifact cannot support a formal result."""


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
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
        raise VerificationError(f"cannot read {label}: {path}: {exc}") from exc
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


def write_new(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise VerificationError(f"refusing to overwrite report: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(value), ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def _derive_seed(domain: str, *components: object) -> int:
    digest = hashlib.sha256(
        canonical_json(
            {"schedule_domain": SCHEDULE_DOMAIN, "domain": domain, "components": components}
        ).encode("utf-8")
    ).digest()
    seed = int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)
    return seed or 1


def _source_closure() -> dict[str, str]:
    return {relative: sha256_file(REPO_ROOT / relative) for relative in SOURCE_PATHS}


def _expected_relationship() -> dict[str, Any]:
    return {
        "mode": "pre_execution_gate_only",
        "candidate_replacement_after_failure_forbidden": True,
        "passing_does_not_close_d19_v2_construct_validity_blocker": True,
        "d20_v2_manifest_sha256": sha256_file(D20_V2_MANIFEST),
    }


def load_manifest(path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    candidate = candidate.resolve()
    if not candidate.is_file() or candidate.is_symlink():
        raise VerificationError(f"manifest is not a regular file: {candidate}")
    manifest = read_json(candidate, "calibration manifest")
    if manifest.get("schema_name") != MANIFEST_SCHEMA or manifest.get("schema_version") != SCHEMA_VERSION:
        raise VerificationError("unexpected calibration manifest schema")
    if manifest.get("experiment_id") != EXPERIMENT_ID or manifest.get("protocol_id") != PROTOCOL_ID:
        raise VerificationError("calibration identifier mismatch")
    if manifest.get("status") != "formal_local_execution_authorized":
        raise VerificationError("calibration is not a formal execution registration")
    if manifest.get("relationship_to_d20_v2") != _expected_relationship():
        raise VerificationError("D20-v2 relationship binding drifted")
    expected_candidate = {
        "id": "minimax_d2_cap8_v1",
        "kind": "minimax_alpha_beta",
        "depth": 2,
        "move_cap": 8,
        "heuristic": "lifeline_rl.agents.heuristic.HeuristicWeights.default",
    }
    if manifest.get("candidate") != expected_candidate:
        raise VerificationError("candidate configuration drifted")
    expected_reference = {
        "id": "uct_mcts_s16_d80_v1",
        "kind": "uct_mcts_uniform_rollout",
        "simulations": 16,
        "rollout_depth": 80,
        "exploration": math.sqrt(2.0),
    }
    if manifest.get("reference") != expected_reference:
        raise VerificationError("reference configuration drifted")
    expected_arena = {
        "sizes": [10, 12],
        "blocks_per_size": 5,
        "openings_per_block": 4,
        "colour_swapped_games_per_opening": 2,
        "start_player": "BLACK",
        "superko_mode": "enforce",
        "max_total_plies": 256,
        "opening_generator": "counter_seeded_rule_engine_only_v1",
        "opening_prefix_lengths": [3, 4, 5, 6, 7, 8],
        "opening_uniqueness": "state_fingerprint_within_size",
    }
    if manifest.get("arena") != expected_arena:
        raise VerificationError("arena schedule drifted")
    expected_inference = {
        "primary_statistical_unit": "fixed_rng_block",
        "block_score_games": 8,
        "student_t_critical_two_sided_95_df4": 2.7764451051977987,
        "lower_confidence_bound_rule": "strictly_greater_than_0.5",
        "pooled_games_are_independent": False,
    }
    if manifest.get("inference") != expected_inference:
        raise VerificationError("inference contract drifted")
    expected_totals = {"sizes": 2, "blocks": 10, "openings": 40, "colour_balanced_pairs": 40, "games": 80}
    if manifest.get("planned_totals") != expected_totals:
        raise VerificationError("planned totals drifted")
    if manifest.get("protocol_sha256") != sha256_file(DEFAULT_PROTOCOL):
        raise VerificationError("calibration protocol hash binding drifted")
    bindings = manifest.get("source_bindings")
    if not isinstance(bindings, Mapping) or dict(bindings) != _source_closure():
        raise VerificationError("calibration source binding drifted")
    return manifest


def apply_index(game: LifelineGame, action: int) -> None:
    if isinstance(action, bool) or not isinstance(action, int):
        raise VerificationError("action must be an integer")
    result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
    if not result.success:
        raise VerificationError(f"illegal action {action}: {result.reason}")


def opening_game(size: int, actions: Sequence[int]) -> LifelineGame:
    game = LifelineGame(size, start_player=Player.BLACK, superko_mode="enforce")
    for action in actions:
        if game.game_over:
            raise VerificationError("opening continues after terminal state")
        apply_index(game, int(action))
    if game.game_over:
        raise VerificationError("opening is terminal")
    return game


def generate_opening_registry(manifest: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    arena = manifest["arena"]
    assert isinstance(arena, Mapping)
    registry: dict[str, list[dict[str, Any]]] = {}
    for size_raw in arena["sizes"]:
        size = int(size_raw)
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for block in range(int(arena["blocks_per_size"])):
            for opening_ordinal in range(int(arena["openings_per_block"])):
                prefix_lengths = arena["opening_prefix_lengths"]
                prefix_length = int(prefix_lengths[(block * int(arena["openings_per_block"]) + opening_ordinal) % len(prefix_lengths)])
                accepted: dict[str, Any] | None = None
                for attempt in range(1_000):
                    rng = random.Random(_derive_seed("opening", size, block, opening_ordinal, attempt))
                    game = LifelineGame(size, start_player=Player.BLACK, superko_mode="enforce")
                    actions: list[int] = []
                    for _ in range(prefix_length):
                        legal = game.legal_moves()
                        if game.game_over or not legal:
                            break
                        point = rng.choice(legal)
                        action = game.point_to_index[point]
                        apply_index(game, action)
                        actions.append(action)
                    if len(actions) != prefix_length or game.game_over:
                        continue
                    fingerprint = game.state_fingerprint()
                    if fingerprint in seen:
                        continue
                    accepted = {
                        "opening_id": f"n{size}.b{block:02d}.o{opening_ordinal:02d}",
                        "grid_size": size,
                        "block": block,
                        "opening_ordinal": opening_ordinal,
                        "generator_attempt": attempt,
                        "actions": actions,
                        "prefix_fingerprint": fingerprint,
                        "plies": len(actions),
                    }
                    accepted["row_sha256"] = canonical_sha256(accepted)
                    break
                if accepted is None:
                    raise VerificationError(
                        f"could not generate unique opening for n={size}, block={block}, opening={opening_ordinal}"
                    )
                seen.add(str(accepted["prefix_fingerprint"]))
                entries.append(accepted)
        expected = int(arena["blocks_per_size"]) * int(arena["openings_per_block"])
        if len(entries) != expected or len(seen) != expected:
            raise VerificationError("opening registry count or uniqueness mismatch")
        registry[str(size)] = entries
    return registry


def build_task_plan(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    arena = manifest["arena"]
    assert isinstance(arena, Mapping)
    rows: list[dict[str, Any]] = []
    for size_raw in arena["sizes"]:
        size = int(size_raw)
        for block in range(int(arena["blocks_per_size"])):
            for opening_ordinal in range(int(arena["openings_per_block"])):
                pair_index = len(rows)
                row = {
                    "schema_name": RUN_SCHEMA,
                    "schema_version": SCHEMA_VERSION,
                    "pair_id": f"calibration.n{size}.b{block:02d}.o{opening_ordinal:02d}",
                    "pair_index": pair_index,
                    "grid_size": size,
                    "block": block,
                    "opening_ordinal": opening_ordinal,
                    "opening_id": f"n{size}.b{block:02d}.o{opening_ordinal:02d}",
                    "candidate_policy_seed": _derive_seed("candidate_policy", size, block, opening_ordinal),
                    "reference_policy_seed": _derive_seed("reference_policy", size, block, opening_ordinal),
                }
                row["row_sha256"] = canonical_sha256(row)
                rows.append(row)
    if len(rows) != int(manifest["planned_totals"]["colour_balanced_pairs"]):
        raise VerificationError("task plan pair count mismatch")
    return rows


def _score_for_candidate(row: Mapping[str, Any]) -> float:
    if bool(row.get("truncated")):
        raise VerificationError("truncated game cannot be aggregated")
    winner = row.get("winner")
    if winner == "DRAW":
        return 0.5
    candidate_colour = "BLACK" if row.get("black_slot") == "A" else "WHITE"
    if winner == candidate_colour:
        return 1.0
    if winner in {"BLACK", "WHITE"}:
        return 0.0
    raise VerificationError("completed game has invalid winner")


def _t_interval(values: Sequence[float]) -> dict[str, Any]:
    if len(values) != 5:
        raise VerificationError("calibration requires exactly five block means")
    mean = statistics.fmean(values)
    margin = 2.7764451051977987 * statistics.stdev(values) / math.sqrt(5.0)
    return {"n": 5, "df": 4, "mean": mean, "ci95": [mean - margin, mean + margin]}


def recompute_numeric(
    manifest: Mapping[str, Any],
    plan: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Recompute the fixed-block analysis from fully validated game rows."""

    by_size_block: dict[tuple[int, int], list[float]] = {}
    pooled: dict[int, list[float]] = {}
    for row in games:
        score = _score_for_candidate(row)
        size = int(row["grid_size"])
        block = int(row["block"])
        by_size_block.setdefault((size, block), []).append(score)
        pooled.setdefault(size, []).append(score)
    arena = manifest["arena"]
    assert isinstance(arena, Mapping)
    per_size: list[dict[str, Any]] = []
    passed_sizes: list[int] = []
    for size_raw in arena["sizes"]:
        size = int(size_raw)
        block_scores: list[float] = []
        for block in range(int(arena["blocks_per_size"])):
            scores = by_size_block.get((size, block), [])
            if len(scores) != 8:
                raise VerificationError(f"n={size}, block={block} has {len(scores)} games, not 8")
            block_scores.append(statistics.fmean(scores))
        interval = _t_interval(block_scores)
        lower = float(interval["ci95"][0])
        passed = lower > 0.5
        if passed:
            passed_sizes.append(size)
        size_scores = pooled.get(size, [])
        if len(size_scores) != 40:
            raise VerificationError(f"n={size} has {len(size_scores)} games, not 40")
        per_size.append(
            {
                "grid_size": size,
                "block_score_rates": block_scores,
                "block_interval": interval,
                "lower_confidence_bound": lower,
                "passes_lower_bound": passed,
                "games": len(size_scores),
                "candidate_wins": sum(score == 1.0 for score in size_scores),
                "candidate_draws": sum(score == 0.5 for score in size_scores),
                "candidate_losses": sum(score == 0.0 for score in size_scores),
            }
        )
    expected_games = int(manifest["planned_totals"]["games"])
    if len(games) != expected_games or len(plan) != int(manifest["planned_totals"]["colour_balanced_pairs"]):
        raise VerificationError("numeric input coverage disagrees with manifest")
    return {
        "schema_name": NUMERIC_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "candidate_id": "minimax_d2_cap8_v1",
        "reference_id": "uct_mcts_s16_d80_v1",
        "primary_statistical_unit": "fixed_rng_block",
        "pooled_games_are_independent": False,
        "lower_confidence_bound_rule": "two_sided_student_t_95_lower_gt_0.5_df4",
        "size_estimates": per_size,
        "passed_sizes": passed_sizes,
        "calibration_games": len(games),
    }


def _replay_game(row: Mapping[str, Any], task: Mapping[str, Any], opening: Mapping[str, Any], max_total_plies: int) -> None:
    raw = dict(row)
    recorded_hash = raw.pop("row_sha256", None)
    if recorded_hash != canonical_sha256(raw):
        raise VerificationError("game row hash mismatch")
    expected_as_black = int(task["pair_index"]) * 2 == int(row.get("game_index"))
    expected_static = {
        "schema_name": GAME_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pair_id": task["pair_id"],
        "pair_index": task["pair_index"],
        "grid_size": task["grid_size"],
        "superko_mode": "enforce",
        "block": task["block"],
        "opening_ordinal": task["opening_ordinal"],
        "opening_id": opening["opening_id"],
        "opening_actions": opening["actions"],
        "opening_fingerprint": opening["prefix_fingerprint"],
        "candidate_id": "minimax_d2_cap8_v1",
        "reference_id": "uct_mcts_s16_d80_v1",
        "candidate_policy_seed": task["candidate_policy_seed"],
        "reference_policy_seed": task["reference_policy_seed"],
        "black_slot": "A" if expected_as_black else "B",
        "white_slot": "B" if expected_as_black else "A",
        "black_agent": "minimax_d2_cap8_v1" if expected_as_black else "uct_mcts_s16_d80_v1",
        "white_agent": "uct_mcts_s16_d80_v1" if expected_as_black else "minimax_d2_cap8_v1",
        "terminated": True,
        "truncated": False,
    }
    for key, expected in expected_static.items():
        if row.get(key) != expected:
            raise VerificationError(f"game row static field mismatch: {key}")
    expected_index = 2 * int(task["pair_index"]) + (0 if expected_as_black else 1)
    if row.get("game_index") != expected_index:
        raise VerificationError("game index does not match registered colour schedule")
    game = opening_game(int(opening["grid_size"]), [int(action) for action in opening["actions"]])
    if game.state_fingerprint() != opening["prefix_fingerprint"]:
        raise VerificationError("opening fingerprint cannot be replayed")
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
        action = action_row.get("action")
        if isinstance(action, bool) or not isinstance(action, int):
            raise VerificationError("continuation action is not an integer")
        apply_index(game, action)
    if not game.game_over:
        raise VerificationError("non-truncated game did not terminate")
    if len(actions) + len(opening["actions"]) > max_total_plies:
        raise VerificationError("game exceeded maximum registered total plies")
    winner = game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = {player.value: game.cached_territories[player].area for player in (Player.BLACK, Player.WHITE)}
    if row.get("winner") != winner_value or row.get("territories") != territories:
        raise VerificationError("winner or territory mismatch after replay")
    if row.get("continuation_plies") != len(actions) or row.get("total_plies") != len(actions) + len(opening["actions"]):
        raise VerificationError("game ply count mismatch")
    if row.get("final_state_fingerprint") != game.state_fingerprint():
        raise VerificationError("final-state fingerprint mismatch")


def verify(
    run_root: str | Path,
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = load_manifest(manifest_path)
    root = Path(run_root).resolve()
    if not root.is_dir() or root.is_symlink():
        raise VerificationError("run root is not a regular directory")
    metadata = read_json(root / "run_metadata.json", "run metadata")
    if metadata.get("schema_name") != RUN_SCHEMA or metadata.get("experiment_id") != EXPERIMENT_ID:
        raise VerificationError("run metadata schema or experiment mismatch")
    if metadata.get("protocol_id") != PROTOCOL_ID:
        raise VerificationError("run metadata protocol mismatch")
    if metadata.get("manifest_sha256") != canonical_sha256(manifest):
        raise VerificationError("run metadata manifest binding mismatch")
    if metadata.get("protocol_sha256") != sha256_file(DEFAULT_PROTOCOL):
        raise VerificationError("run metadata protocol hash mismatch")
    if metadata.get("source_hashes") != _source_closure():
        raise VerificationError("run source closure drifted")
    if metadata.get("candidate_id") != "minimax_d2_cap8_v1" or metadata.get("reference_id") != "uct_mcts_s16_d80_v1":
        raise VerificationError("run baseline identity mismatch")
    persisted_plan = read_json(root / "task_plan.json", "task plan")
    plan = build_task_plan(manifest)
    if persisted_plan != {"pairs": plan}:
        raise VerificationError("persisted task plan differs from registration")
    persisted_openings = read_json(root / "opening_registry.json", "opening registry")
    expected_openings = generate_opening_registry(manifest)
    if persisted_openings != expected_openings:
        raise VerificationError("persisted opening registry differs from registration")
    opening_by_id = {str(entry["opening_id"]): entry for entries in expected_openings.values() for entry in entries}
    games = read_jsonl(root / "games.jsonl", "calibration games")
    if len(games) != int(manifest["planned_totals"]["games"]):
        raise VerificationError("calibration game count mismatch")
    rows_by_pair: dict[str, list[Mapping[str, Any]]] = {}
    for row in games:
        rows_by_pair.setdefault(str(row.get("pair_id")), []).append(row)
    maximum = int(manifest["arena"]["max_total_plies"])
    ordered_rows: list[Mapping[str, Any]] = []
    for task in plan:
        pair_rows = rows_by_pair.get(str(task["pair_id"]), [])
        if len(pair_rows) != 2:
            raise VerificationError(f"pair {task['pair_id']} lacks exactly two games")
        pair_rows = sorted(pair_rows, key=lambda row: int(row.get("game_index", -1)))
        if [row.get("game_index") for row in pair_rows] != [2 * int(task["pair_index"]), 2 * int(task["pair_index"]) + 1]:
            raise VerificationError("pair game order or coverage mismatch")
        opening = opening_by_id.get(str(task["opening_id"]))
        if opening is None:
            raise VerificationError("planned opening is missing")
        for row in pair_rows:
            _replay_game(row, task, opening, maximum)
            ordered_rows.append(row)
    if [row.get("game_index") for row in games] != list(range(len(games))):
        raise VerificationError("games file is not in registered deterministic order")
    numeric = recompute_numeric(manifest, plan, ordered_rows)
    persisted_numeric = read_json(root / "canonical_numeric.json", "canonical numeric")
    if canonical_sha256(persisted_numeric) != canonical_sha256(numeric):
        raise VerificationError("persisted numeric aggregate differs from independent recomputation")
    passed_sizes = list(numeric["passed_sizes"])
    required_sizes = list(manifest["arena"]["sizes"])
    formal_ready = passed_sizes == required_sizes
    report = {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS" if formal_ready else "FAIL_CLOSED",
        "formal_ready": formal_ready,
        "experiment_id": EXPERIMENT_ID,
        "protocol_id": PROTOCOL_ID,
        "candidate_id": "minimax_d2_cap8_v1",
        "reference_id": "uct_mcts_s16_d80_v1",
        "required_sizes": required_sizes,
        "passed_sizes": passed_sizes,
        "primary_statistical_unit": "fixed_rng_block",
        "pooled_games_are_independent": False,
        "lower_confidence_bound_rule": "two_sided_student_t_95_lower_gt_0.5_df4",
        "independent_of_runner_import": True,
        "manifest_sha256": canonical_sha256(manifest),
        "games_replayed": len(games),
        "all_games_replayed": True,
        "zero_truncations": True,
        "canonical_numeric_sha256": canonical_sha256(numeric),
        "size_estimates": numeric["size_estimates"],
    }
    return report, numeric


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
