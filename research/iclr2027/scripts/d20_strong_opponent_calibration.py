#!/usr/bin/env python3
"""Execute the registered D20 Minimax-versus-UCT strong-opponent gate.

This executor is deliberately separate from the D20 factorial runner.  It
creates colour-balanced, rule-generated openings, records every continuation,
and delegates final replay and aggregation to a verifier that never imports
this module.  A failed calibration is evidence of ineligibility, not an
occasion to select a different opponent.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import random
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, Player
from lifeline_rl.agents.minimax import MinimaxAgent, MinimaxConfig
from lifeline_rl.agents.mcts import MCTSAgent, MCTSConfig


SCHEMA_VERSION = 1
MANIFEST_SCHEMA = "lifeline-d20-strong-opponent-calibration-manifest"
RUN_SCHEMA = "lifeline-d20-strong-opponent-calibration-run"
GAME_SCHEMA = "lifeline-d20-strong-opponent-calibration-game"
EXPERIMENT_ID = "d20_strong_opponent_calibration_minimax_d2_cap8_vs_uct16_v1"
PROTOCOL_ID = "d20_strong_opponent_calibration_protocol_20260909_v1"
SCHEDULE_DOMAIN = "d20-strong-opponent-calibration-counter-schedule-v1"

DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d20_strong_opponent_calibration_manifest.json"
DEFAULT_PROTOCOL = RESEARCH_ROOT / "D20_STRONG_OPPONENT_CALIBRATION_PROTOCOL.md"
D20_V2_MANIFEST = RESEARCH_ROOT / "configs" / "d20_matched_ablation_manifest_v2.json"
LOCAL_ARTIFACT_ROOT = (REPO_ROOT / "local_artifacts" / "d20_strong_opponent_calibration").resolve()

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


class CalibrationError(RuntimeError):
    """Raised when a registered calibration invariant fails."""


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
        raise CalibrationError(f"not canonical finite JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest().upper()


def sha256_file(path: str | Path) -> str:
    target = Path(path)
    if not target.is_file() or target.is_symlink():
        raise CalibrationError(f"hash target is not a regular file: {target}")
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CalibrationError(f"cannot read {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise CalibrationError(f"{label} must be a JSON object")
    return value


def _write_new_json(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise CalibrationError(f"refusing to overwrite artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(value), ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def _write_new_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    if path.exists() or path.is_symlink():
        raise CalibrationError(f"refusing to overwrite artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(canonical_json(dict(row)) + "\n")


def _relative_to_repo(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise CalibrationError(f"path is outside the repository: {path}") from exc


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
        raise CalibrationError(f"manifest is not a regular file: {candidate}")
    manifest = _read_json(candidate, "calibration manifest")
    if manifest.get("schema_name") != MANIFEST_SCHEMA or manifest.get("schema_version") != SCHEMA_VERSION:
        raise CalibrationError("unexpected calibration manifest schema")
    if manifest.get("experiment_id") != EXPERIMENT_ID or manifest.get("protocol_id") != PROTOCOL_ID:
        raise CalibrationError("calibration identifier mismatch")
    if manifest.get("status") != "formal_local_execution_authorized":
        raise CalibrationError("calibration is not authorized for formal local execution")
    if manifest.get("relationship_to_d20_v2") != _expected_relationship():
        raise CalibrationError("D20-v2 relationship binding drifted")
    expected_candidate = {
        "id": "minimax_d2_cap8_v1",
        "kind": "minimax_alpha_beta",
        "depth": 2,
        "move_cap": 8,
        "heuristic": "lifeline_rl.agents.heuristic.HeuristicWeights.default",
    }
    if manifest.get("candidate") != expected_candidate:
        raise CalibrationError("candidate configuration drifted")
    expected_reference = {
        "id": "uct_mcts_s16_d80_v1",
        "kind": "uct_mcts_uniform_rollout",
        "simulations": 16,
        "rollout_depth": 80,
        "exploration": math.sqrt(2.0),
    }
    if manifest.get("reference") != expected_reference:
        raise CalibrationError("reference configuration drifted")
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
        raise CalibrationError("arena schedule drifted")
    expected_inference = {
        "primary_statistical_unit": "fixed_rng_block",
        "block_score_games": 8,
        "student_t_critical_two_sided_95_df4": 2.7764451051977987,
        "lower_confidence_bound_rule": "strictly_greater_than_0.5",
        "pooled_games_are_independent": False,
    }
    if manifest.get("inference") != expected_inference:
        raise CalibrationError("inference contract drifted")
    expected_totals = {"sizes": 2, "blocks": 10, "openings": 40, "colour_balanced_pairs": 40, "games": 80}
    if manifest.get("planned_totals") != expected_totals:
        raise CalibrationError("planned totals drifted")
    if manifest.get("protocol_sha256") != sha256_file(DEFAULT_PROTOCOL):
        raise CalibrationError("calibration protocol hash binding drifted")
    bindings = manifest.get("source_bindings")
    if not isinstance(bindings, Mapping) or dict(bindings) != _source_closure():
        raise CalibrationError("calibration source binding drifted")
    return manifest


def _apply_index(game: LifelineGame, action: int) -> None:
    result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
    if not result.success:
        raise CalibrationError(f"illegal indexed action {action}: {result.reason}")


def _opening_from_actions(size: int, actions: Sequence[int]) -> LifelineGame:
    game = LifelineGame(size, start_player=Player.BLACK, superko_mode="enforce")
    for action in actions:
        if game.game_over:
            raise CalibrationError("opening continues after terminal state")
        _apply_index(game, int(action))
    if game.game_over:
        raise CalibrationError("opening is terminal")
    return game


def generate_opening_registry(manifest: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Generate fixed nonterminal openings using only the exact rules engine."""

    arena = manifest["arena"]
    assert isinstance(arena, Mapping)
    registry: dict[str, list[dict[str, Any]]] = {}
    for size_raw in arena["sizes"]:
        size = int(size_raw)
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for block in range(int(arena["blocks_per_size"])):
            for opening_ordinal in range(int(arena["openings_per_block"])):
                prefix_length = int(arena["opening_prefix_lengths"][(block * int(arena["openings_per_block"]) + opening_ordinal) % len(arena["opening_prefix_lengths"])])
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
                        _apply_index(game, game.point_to_index[point])
                        actions.append(game.point_to_index[point])
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
                    raise CalibrationError(
                        f"could not generate unique opening for n={size}, block={block}, opening={opening_ordinal}"
                    )
                seen.add(str(accepted["prefix_fingerprint"]))
                entries.append(accepted)
        expected = int(arena["blocks_per_size"]) * int(arena["openings_per_block"])
        if len(entries) != expected or len(seen) != expected:
            raise CalibrationError("opening registry count or uniqueness mismatch")
        registry[str(size)] = entries
    return registry


def build_task_plan(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the source-independent fixed schedule of colour-balanced pairs."""

    arena = manifest["arena"]
    assert isinstance(arena, Mapping)
    rows: list[dict[str, Any]] = []
    for size_raw in arena["sizes"]:
        size = int(size_raw)
        for block in range(int(arena["blocks_per_size"])):
            for opening_ordinal in range(int(arena["openings_per_block"])):
                pair_index = len(rows)
                pair_id = f"calibration.n{size}.b{block:02d}.o{opening_ordinal:02d}"
                row = {
                    "schema_name": RUN_SCHEMA,
                    "schema_version": SCHEMA_VERSION,
                    "pair_id": pair_id,
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
    expected = manifest["planned_totals"]
    if len(rows) != int(expected["colour_balanced_pairs"]):
        raise CalibrationError("task plan pair count mismatch")
    return rows


def _make_candidate() -> MinimaxAgent:
    return MinimaxAgent(MinimaxConfig(depth=2, move_cap=8), label="minimax_d2_cap8_v1")


def _make_reference() -> MCTSAgent:
    return MCTSAgent(
        MCTSConfig(simulations=16, rollout_depth=80, exploration=math.sqrt(2.0)),
        label="uct_mcts_s16_d80_v1",
    )


def _play_game(
    *,
    task: Mapping[str, Any],
    opening: Mapping[str, Any],
    candidate_as_black: bool,
    max_total_plies: int,
) -> dict[str, Any]:
    game = _opening_from_actions(int(opening["grid_size"]), [int(action) for action in opening["actions"]])
    if game.state_fingerprint() != opening["prefix_fingerprint"]:
        raise CalibrationError("opening fingerprint does not reproduce")
    candidate = _make_candidate()
    reference = _make_reference()
    black_agent, white_agent = (candidate, reference) if candidate_as_black else (reference, candidate)
    candidate_seed = int(task["candidate_policy_seed"])
    reference_seed = int(task["reference_policy_seed"])
    policy_rng = {
        Player.BLACK: random.Random(candidate_seed if candidate_as_black else reference_seed),
        Player.WHITE: random.Random(reference_seed if candidate_as_black else candidate_seed),
    }
    actions: list[dict[str, Any]] = []
    while not game.game_over and len(actions) + len(opening["actions"]) < max_total_plies:
        actor = game.current_player
        agent = black_agent if actor is Player.BLACK else white_agent
        snapshot = game.clone()
        action_point = agent.select_action(game, policy_rng[actor])
        if game.clone() != snapshot:
            raise CalibrationError(f"agent {agent.name!r} mutated the game while choosing")
        if action_point is not None and action_point not in game.point_to_index:
            raise CalibrationError(f"agent {agent.name!r} emitted an invalid point")
        action = game.num_points if action_point is None else game.point_to_index[action_point]
        actions.append(
            {
                "ply": len(actions),
                "actor": actor.value,
                "action": action,
                "state_fingerprint": game.state_fingerprint(),
            }
        )
        _apply_index(game, action)
    truncated = not game.game_over
    winner = None if truncated else game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = None
    if not truncated:
        territories = {player.value: game.cached_territories[player].area for player in (Player.BLACK, Player.WHITE)}
    return {
        "schema_name": GAME_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "pair_id": task["pair_id"],
        "pair_index": task["pair_index"],
        "game_index": 2 * int(task["pair_index"]) + (0 if candidate_as_black else 1),
        "grid_size": int(task["grid_size"]),
        "superko_mode": "enforce",
        "block": task["block"],
        "opening_ordinal": task["opening_ordinal"],
        "opening_id": opening["opening_id"],
        "opening_actions": [int(action) for action in opening["actions"]],
        "opening_fingerprint": opening["prefix_fingerprint"],
        "candidate_id": "minimax_d2_cap8_v1",
        "reference_id": "uct_mcts_s16_d80_v1",
        "candidate_policy_seed": candidate_seed,
        "reference_policy_seed": reference_seed,
        "black_slot": "A" if candidate_as_black else "B",
        "white_slot": "B" if candidate_as_black else "A",
        "black_agent": black_agent.name,
        "white_agent": white_agent.name,
        "terminated": not truncated,
        "truncated": truncated,
        "winner": winner_value,
        "territories": territories,
        "continuation_plies": len(actions),
        "total_plies": len(actions) + len(opening["actions"]),
        "final_state_fingerprint": game.state_fingerprint(),
        "actions": actions,
    }


def _execute_pair(task: Mapping[str, Any], opening: Mapping[str, Any], max_total_plies: int) -> list[dict[str, Any]]:
    first = _play_game(task=task, opening=opening, candidate_as_black=True, max_total_plies=max_total_plies)
    second = _play_game(task=task, opening=opening, candidate_as_black=False, max_total_plies=max_total_plies)
    for row in (first, second):
        row["row_sha256"] = canonical_sha256(row)
    return [first, second]


def _validate_new_output_root(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(LOCAL_ARTIFACT_ROOT)
    except ValueError as exc:
        raise CalibrationError(
            f"calibration output must be below {_relative_to_repo(LOCAL_ARTIFACT_ROOT)}"
        ) from exc
    if resolved == LOCAL_ARTIFACT_ROOT or resolved.exists() or resolved.is_symlink():
        raise CalibrationError("calibration output root must be a new, specific local-artifact directory")
    return resolved


def run_formal(
    *,
    output_root: str | Path,
    manifest_path: str | Path = DEFAULT_MANIFEST,
    workers: int = 1,
) -> dict[str, Any]:
    """Run the immutable calibration schedule once and independently verify it."""

    if isinstance(workers, bool) or not isinstance(workers, int) or workers < 1:
        raise CalibrationError("workers must be a positive integer")
    manifest = load_manifest(manifest_path)
    root = _validate_new_output_root(output_root)
    root.mkdir(parents=True, exist_ok=False)
    plan = build_task_plan(manifest)
    registry = generate_opening_registry(manifest)
    opening_by_id = {str(entry["opening_id"]): entry for entries in registry.values() for entry in entries}
    if len(opening_by_id) != int(manifest["planned_totals"]["openings"]):
        raise CalibrationError("opening lookup has duplicate IDs")
    metadata = {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "protocol_id": PROTOCOL_ID,
        "manifest_path": _relative_to_repo(Path(manifest_path).resolve() if Path(manifest_path).is_absolute() else REPO_ROOT / manifest_path),
        "manifest_sha256": canonical_sha256(manifest),
        "protocol_sha256": sha256_file(DEFAULT_PROTOCOL),
        "source_hashes": _source_closure(),
        "candidate_id": manifest["candidate"]["id"],
        "reference_id": manifest["reference"]["id"],
        "workers": workers,
        "status": "running",
    }
    _write_new_json(root / "run_metadata.json", metadata)
    _write_new_json(root / "task_plan.json", {"pairs": plan})
    _write_new_json(root / "opening_registry.json", registry)

    maximum = int(manifest["arena"]["max_total_plies"])
    pair_rows: dict[str, list[dict[str, Any]]] = {}
    if workers == 1:
        for task in plan:
            pair_rows[str(task["pair_id"])] = _execute_pair(task, opening_by_id[str(task["opening_id"])], maximum)
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {
                str(task["pair_id"]): executor.submit(
                    _execute_pair, task, opening_by_id[str(task["opening_id"])], maximum
                )
                for task in plan
            }
            for task in plan:
                pair_rows[str(task["pair_id"])] = futures[str(task["pair_id"])].result()

    games: list[dict[str, Any]] = []
    for task in plan:
        rows = pair_rows.get(str(task["pair_id"]))
        if rows is None or len(rows) != 2:
            raise CalibrationError(f"missing colour-balanced pair for {task['pair_id']}")
        games.extend(rows)
    if len(games) != int(manifest["planned_totals"]["games"]):
        raise CalibrationError("calibration game count mismatch")
    _write_new_jsonl(root / "games.jsonl", games)

    try:
        import verify_d20_strong_opponent_calibration as independent_verifier  # type: ignore
    except ModuleNotFoundError:  # pragma: no cover - package-style fallback
        from scripts import verify_d20_strong_opponent_calibration as independent_verifier  # type: ignore
    numeric = independent_verifier.recompute_numeric(manifest, plan, games)
    _write_new_json(root / "canonical_numeric.json", numeric)
    report, recomputed = independent_verifier.verify(root, manifest_path=manifest_path)
    if canonical_sha256(numeric) != canonical_sha256(recomputed):
        raise CalibrationError("independent numeric aggregate disagrees with initial aggregate")
    _write_new_json(root / "independent_verification.json", report)
    completion = {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "status": "complete" if bool(report.get("formal_ready")) else "fail_closed",
        "formal_ready": bool(report.get("formal_ready")),
        "games_sha256": sha256_file(root / "games.jsonl"),
        "canonical_numeric_sha256": sha256_file(root / "canonical_numeric.json"),
        "independent_verification_sha256": sha256_file(root / "independent_verification.json"),
    }
    _write_new_json(root / "completion.json", completion)
    return {"run_root": str(root), "completion": completion, "verification": report}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--run-formal", action="store_true")
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--report-output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    selected = int(args.run_formal) + int(args.verify is not None)
    if selected != 1:
        raise SystemExit("select exactly one of --run-formal or --verify")
    if args.run_formal:
        if args.output_root is None:
            raise SystemExit("--run-formal requires --output-root")
        payload = run_formal(
            output_root=args.output_root,
            manifest_path=args.manifest,
            workers=args.workers,
        )
    else:
        if args.report_output is None:
            raise SystemExit("--verify requires --report-output")
        try:
            import verify_d20_strong_opponent_calibration as independent_verifier  # type: ignore
        except ModuleNotFoundError:  # pragma: no cover - package-style fallback
            from scripts import verify_d20_strong_opponent_calibration as independent_verifier  # type: ignore
        report, numeric = independent_verifier.verify(args.verify, manifest_path=args.manifest)
        payload = {"report": report, "canonical_numeric": numeric}
        _write_new_json(args.report_output, payload)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if bool(payload.get("completion", payload.get("report", {})).get("formal_ready")) else 2


if __name__ == "__main__":
    raise SystemExit(main())
