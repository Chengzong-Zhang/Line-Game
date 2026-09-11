#!/usr/bin/env python3
"""Bounded deterministic search for a same-implemented-observation witness.

The search replays natural histories from the standard initial state and uses
the implemented ``topology`` observation, including its legal-action mask, as
the visible collision key.  A collision is retained only when the complete
action histories and Superko history sets differ.  Every shared legal action
is then applied to both states and the resulting implemented observations are
compared.  Optional bounded exact minimax checks compare black value, shared
action Q values, and optimal-action sets.

This is an audit artifact, not a proof of nonexistence.  A negative result is
scoped to the exact board, breadth-first action order, state/depth budgets,
and optional solver budget recorded in its JSON output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402
from lifeline_rl.encoding import encode_observation  # noqa: E402


Action = tuple[int, int] | None
History = tuple[Action, ...]

CORE_PATH = PROJECT_ROOT / "lifeline_rl" / "core.py"
ENCODING_PATH = PROJECT_ROOT / "lifeline_rl" / "encoding.py"
PROTOCOL_PATH = PROJECT_ROOT / "D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md"
MANIFEST_PATH = PROJECT_ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
MASK_FREE_ADDENDUM_PATH = PROJECT_ROOT / "D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md"

ACTION_ORDER = "PASS_FIRST_THEN_LEXICOGRAPHIC_POINTS_V1"
OBSERVATION_DEFINITION = (
    "encode_observation(game, 'topology') exactly, plus explicit game_over: "
    "board, coordinates, current player, consecutive skips, legal-action mask, "
    "physical edges, and typed logical edges"
)


@dataclass
class SearchStats:
    states_examined: int = 0
    transitions_examined: int = 0
    terminal_states: int = 0
    depth_cutoff_states: int = 0
    depth_cutoff_action_candidates: int = 0
    duplicate_successors: int = 0
    observation_buckets: int = 0
    observation_collisions: int = 0
    distinct_history_collisions: int = 0
    decision_pairs_checked: int = 0
    exact_solver_nodes: int = 0
    exact_solver_budget_exhaustions: int = 0
    max_depth_reached: int = 0
    peak_frontier: int = 1


@dataclass(frozen=True)
class SeenState:
    snapshot: Any
    history: History
    state_fingerprint: str
    observation_sha256: str


@dataclass
class ExactSolution:
    value: int
    action_values: dict[Action, int]
    optimal_actions: frozenset[Action]


class SolverBudgetExceeded(RuntimeError):
    pass


class ExactSolver:
    """Finite-game backward induction with a deterministic node budget."""

    def __init__(self, grid_size: int, node_budget: int):
        self.grid_size = grid_size
        self.node_budget = node_budget
        self.nodes = 0
        self.memo: dict[Any, ExactSolution] = {}

    def solve(self, snapshot: Any) -> ExactSolution:
        cached = self.memo.get(snapshot)
        if cached is not None:
            return cached
        if self.nodes >= self.node_budget:
            raise SolverBudgetExceeded
        self.nodes += 1
        game = LifelineGame(self.grid_size)
        game.restore(snapshot)
        if game.game_over:
            value = int(game.rewards()[Player.BLACK])
            result = ExactSolution(value, {}, frozenset())
            self.memo[snapshot] = result
            return result

        options: dict[Action, int] = {}
        for action in _ordered_actions(game):
            child = _successor(game, action)
            options[action] = self.solve(child.clone()).value
        target = (
            max(options.values())
            if game.current_player is Player.BLACK
            else min(options.values())
        )
        result = ExactSolution(
            target,
            options,
            frozenset(action for action, value in options.items() if value == target),
        )
        self.memo[snapshot] = result
        return result


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest().upper()


def _json_action(action: Action) -> list[int] | None:
    return None if action is None else [int(action[0]), int(action[1])]


def _observation_payload(game: LifelineGame) -> dict[str, Any]:
    encoded = encode_observation(game, "topology")
    return {"game_over": bool(game.game_over), **encoded}


def _observation_key(game: LifelineGame) -> str:
    return _canonical_json(_observation_payload(game))


def _state_fingerprint(game: LifelineGame) -> str:
    return game.state_fingerprint().upper()


def _history_fingerprint(game: LifelineGame) -> str:
    canonical = "\n".join(sorted(repr(key) for key in game.history_hashes))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().upper()


def _ordered_actions(game: LifelineGame) -> tuple[Action, ...]:
    if game.game_over:
        return ()
    return (None, *tuple(sorted(game.legal_moves())))


def _successor(game: LifelineGame, action: Action) -> LifelineGame:
    child = LifelineGame(game.grid_size)
    child.restore(game.clone())
    result = child.skip_turn() if action is None else child.play_move(action)
    if not result.success:
        raise AssertionError(f"shared/enumerated action failed: {action!r}: {result.reason}")
    return child


def _legal_actions_from_observation(game: LifelineGame) -> tuple[Action, ...]:
    mask = encode_observation(game, "topology")["legal_action_mask"]
    points = tuple(
        point for point, enabled in zip(game.valid_positions, mask[:-1]) if enabled
    )
    return points + ((None,) if mask[-1] else ())


def _outcome_payload(game: LifelineGame, action: Action) -> dict[str, Any]:
    if action is None:
        outcome = {"success": not game.game_over, "reason": None}
    else:
        raw = game.evaluate_move(action)
        outcome = {
            "success": bool(raw.success),
            "reason": raw.reason,
            "would_violate_superko": bool(raw.would_violate_superko),
        }
    return outcome


def _chain(previous: str, value: str) -> str:
    return hashlib.sha256(f"{previous}\n{value}".encode("ascii")).hexdigest().upper()


def _pair_payload(
    first: SeenState,
    second: SeenState,
    game_first: LifelineGame,
    game_second: LifelineGame,
) -> dict[str, Any]:
    return {
        "history_a": [_json_action(action) for action in first.history],
        "history_b": [_json_action(action) for action in second.history],
        "state_fingerprint_a": first.state_fingerprint,
        "state_fingerprint_b": second.state_fingerprint,
        "history_fingerprint_a": _history_fingerprint(game_first),
        "history_fingerprint_b": _history_fingerprint(game_second),
        "observation_sha256": first.observation_sha256,
        "observation": _observation_payload(game_first),
    }


def _compare_pair(
    first: SeenState,
    second: SeenState,
    grid_size: int,
    stats: SearchStats,
    exact_solver: ExactSolver | None,
    max_decision_pairs: int,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    game_a = LifelineGame(grid_size)
    game_b = LifelineGame(grid_size)
    game_a.restore(first.snapshot)
    game_b.restore(second.snapshot)
    pair = _pair_payload(first, second, game_a, game_b)
    shared_actions = _legal_actions_from_observation(game_a)
    if shared_actions != _legal_actions_from_observation(game_b):
        raise AssertionError("observation collision has different implemented legal masks")

    pair_summary: dict[str, Any] = {
        "observation_sha256": first.observation_sha256,
        "shared_legal_actions": [_json_action(action) for action in shared_actions],
        "different_complete_histories": first.history != second.history,
        "different_history_sets": game_a.history_hashes != game_b.history_hashes,
        "transition_checks": len(shared_actions),
    }
    for action in shared_actions:
        next_a = _successor(game_a, action)
        next_b = _successor(game_b, action)
        stats.transitions_examined += 2
        next_key_a = _observation_key(next_a)
        next_key_b = _observation_key(next_b)
        transition = {
            "action": _json_action(action),
            "successor_observation_equal": next_key_a == next_key_b,
            "successor_observation_sha256_a": _sha256_json(_observation_payload(next_a)),
            "successor_observation_sha256_b": _sha256_json(_observation_payload(next_b)),
            "successor_a_terminal": bool(next_a.game_over),
            "successor_b_terminal": bool(next_b.game_over),
        }
        if next_a.game_over:
            transition["successor_black_reward_a"] = int(next_a.rewards()[Player.BLACK])
        if next_b.game_over:
            transition["successor_black_reward_b"] = int(next_b.rewards()[Player.BLACK])
        pair_summary.setdefault("transitions", []).append(transition)
        if next_key_a != next_key_b:
            return {
                **pair,
                "difference": "different_successor_implemented_observation_and_mask",
                "action": _json_action(action),
                "successor_a": _observation_payload(next_a),
                "successor_b": _observation_payload(next_b),
            }, pair_summary
        if (
            next_a.game_over
            and next_b.game_over
            and next_a.rewards()[Player.BLACK] != next_b.rewards()[Player.BLACK]
        ):
            return {
                **pair,
                "difference": "different_terminal_black_reward",
                "action": _json_action(action),
                "successor_a": _observation_payload(next_a),
                "successor_b": _observation_payload(next_b),
            }, pair_summary

    if (
        exact_solver is not None
        and stats.decision_pairs_checked < max_decision_pairs
    ):
        stats.decision_pairs_checked += 1
        try:
            solution_a = exact_solver.solve(first.snapshot)
            solution_b = exact_solver.solve(second.snapshot)
        except SolverBudgetExceeded:
            stats.exact_solver_budget_exhaustions += 1
            pair_summary["exact_solution"] = {"status": "BUDGET_EXHAUSTED"}
        else:
            pair_summary["exact_solution"] = {
                "status": "EXACT",
                "black_value_a": solution_a.value,
                "black_value_b": solution_b.value,
                "optimal_actions_a": [_json_action(a) for a in sorted(
                    solution_a.optimal_actions, key=lambda a: (-1, -1) if a is None else a
                )],
                "optimal_actions_b": [_json_action(a) for a in sorted(
                    solution_b.optimal_actions, key=lambda a: (-1, -1) if a is None else a
                )],
                "shared_action_q_differences": [
                    _json_action(action)
                    for action in shared_actions
                    if solution_a.action_values.get(action)
                    != solution_b.action_values.get(action)
                ],
            }
            if solution_a.value != solution_b.value:
                return {**pair, "difference": "different_exact_black_value", "decision": pair_summary["exact_solution"]}, pair_summary
            if solution_a.optimal_actions != solution_b.optimal_actions:
                return {**pair, "difference": "different_optimal_action_set", "decision": pair_summary["exact_solution"]}, pair_summary
            if any(
                solution_a.action_values.get(action) != solution_b.action_values.get(action)
                for action in shared_actions
            ):
                return {**pair, "difference": "different_shared_action_q_value", "decision": pair_summary["exact_solution"]}, pair_summary

    return None, pair_summary


def search(
    *,
    grid_size: int,
    max_states: int,
    max_depth: int,
    exact_solver_nodes: int,
    max_decision_pairs: int,
    progress_every: int,
) -> dict[str, Any]:
    if grid_size < 2 or max_states <= 0 or max_depth < 0:
        raise ValueError("grid_size >= 2, positive max_states, and non-negative max_depth required")
    if exact_solver_nodes < 0 or max_decision_pairs < 0 or progress_every < 0:
        raise ValueError("solver/pair/progress budgets must be non-negative")

    initial_core_sha256 = _sha256_file(CORE_PATH)
    initial_encoding_sha256 = _sha256_file(ENCODING_PATH)
    initial_search_sha256 = _sha256_file(Path(__file__))
    initial = LifelineGame(grid_size)
    initial_snapshot = initial.clone()
    initial_history: History = ()
    queue: deque[tuple[Any, History]] = deque([(initial_snapshot, initial_history)])
    visited: set[Any] = set()
    buckets: dict[str, list[SeenState]] = {}
    stats = SearchStats()
    trace = "0" * 64
    collision_trace = "0" * 64
    first_witnesses: dict[str, dict[str, Any]] = {}
    pair_summaries: list[dict[str, Any]] = []
    exact_solver = ExactSolver(grid_size, exact_solver_nodes) if exact_solver_nodes else None
    termination_reason = "FRONTIER_EMPTY"

    while queue and stats.states_examined < max_states:
        snapshot, history = queue.popleft()
        if snapshot in visited:
            stats.duplicate_successors += 1
            continue
        visited.add(snapshot)
        game = LifelineGame(grid_size)
        game.restore(snapshot)
        fingerprint = _state_fingerprint(game)
        observation_key = _observation_key(game)
        observation_sha256 = hashlib.sha256(observation_key.encode("utf-8")).hexdigest().upper()
        stats.states_examined += 1
        stats.max_depth_reached = max(stats.max_depth_reached, len(history))
        trace = _chain(trace, fingerprint)

        bucket = buckets.setdefault(observation_key, [])
        if not bucket:
            stats.observation_buckets += 1
        else:
            stats.observation_collisions += len(bucket)
        current = SeenState(snapshot, history, fingerprint, observation_sha256)
        for previous in bucket:
            if previous.history == history or previous.snapshot.history_hashes == snapshot.history_hashes:
                continue
            stats.distinct_history_collisions += 1
            collision_trace = _chain(
                collision_trace,
                f"{previous.state_fingerprint}:{fingerprint}:{observation_sha256}",
            )
            witness, summary = _compare_pair(
                previous,
                current,
                grid_size,
                stats,
                exact_solver,
                max_decision_pairs,
            )
            pair_summaries.append(summary)
            if witness is not None:
                first_witnesses.setdefault(witness["difference"], witness)

        bucket.append(current)
        if game.game_over:
            stats.terminal_states += 1
            continue
        if len(history) >= max_depth:
            actions = _ordered_actions(game)
            stats.depth_cutoff_states += 1
            stats.depth_cutoff_action_candidates += len(actions)
            continue
        for action in _ordered_actions(game):
            child = _successor(game, action)
            child_snapshot = child.clone()
            if child_snapshot in visited:
                stats.duplicate_successors += 1
                continue
            queue.append((child_snapshot, history + (action,)))
        stats.peak_frontier = max(stats.peak_frontier, len(queue))
        if progress_every and stats.states_examined % progress_every == 0:
            print(
                json.dumps(
                    {
                        "states_examined": stats.states_examined,
                        "frontier": len(queue),
                        "observation_collisions": stats.observation_collisions,
                        "distinct_history_collisions": stats.distinct_history_collisions,
                    },
                    sort_keys=True,
                ),
                file=sys.stderr,
                flush=True,
            )
    else:
        if not queue:
            termination_reason = "FRONTIER_EMPTY_WITHIN_BOUNDED_CONFIGURATION"
    if queue and stats.states_examined >= max_states:
        termination_reason = "STATE_BUDGET"

    final_hashes = {
        "engine_core_sha256": _sha256_file(CORE_PATH),
        "encoding_sha256": _sha256_file(ENCODING_PATH),
        "search_script_sha256": _sha256_file(Path(__file__)),
    }
    if final_hashes["engine_core_sha256"] != initial_core_sha256 or final_hashes["encoding_sha256"] != initial_encoding_sha256 or final_hashes["search_script_sha256"] != initial_search_sha256:
        raise RuntimeError("search inputs changed during the run")

    status = "FOUND" if first_witnesses else "NOT_FOUND_WITHIN_DECLARED_BUDGET"
    return {
        "schema_name": "lifeline-d19-v2-same-implemented-observation-mask-search",
        "schema_version": 1,
        "status": status,
        "evidence_tier": "bounded_cpu_audit_search",
        "search_config": {
            "grid_size": grid_size,
            "standard_initial_state": True,
            "start_player": "BLACK",
            "superko_mode": "enforce",
            "strategy": "deterministic_breadth_first_full_snapshot_search",
            "frontier_discipline": "FIFO",
            "action_order": ACTION_ORDER,
            "observation_key": OBSERVATION_DEFINITION,
            "max_states": max_states,
            "max_depth_actions_including_pass": max_depth,
            "exact_solver_node_budget": exact_solver_nodes,
            "max_decision_pairs": max_decision_pairs,
            "wall_clock_stop": False,
        },
        "source_binding": {
            "engine_core_path": CORE_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "engine_core_sha256": initial_core_sha256,
            "encoding_path": ENCODING_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "encoding_sha256": initial_encoding_sha256,
            "search_script_path": Path(__file__).relative_to(PROJECT_ROOT).as_posix(),
            "search_script_sha256": initial_search_sha256,
            "d19_protocol_sha256": _sha256_file(PROTOCOL_PATH),
            "d19_manifest_sha256": _sha256_file(MANIFEST_PATH),
            "mask_free_addendum_sha256": _sha256_file(MASK_FREE_ADDENDUM_PATH),
        },
        "observation_scope": {
            "board_fixed": True,
            "typed_logical_edges_fixed": True,
            "player_fixed": True,
            "skip_state_fixed": True,
            "terminal_flag_fixed": True,
            "implemented_legal_action_mask_fixed": True,
            "complete_history_must_differ": True,
            "history_set_must_differ": True,
        },
        "result": {
            "termination_reason": termination_reason,
            "stats": {
                **vars(stats),
                "exact_solver_nodes": exact_solver.nodes if exact_solver else 0,
            },
            "visited_state_count": len(visited),
            "frontier_remaining": len(queue),
            "visited_trace_sha256": trace,
            "collision_trace_sha256": collision_trace,
            "first_witnesses": first_witnesses,
            "pair_summaries_count": len(pair_summaries),
            "pair_summaries_sha256": _sha256_json(pair_summaries),
        },
        "claim_boundary": {
            "same_implemented_observation_and_mask_witness_found": bool(first_witnesses),
            "global_nonexistence_claimed": False,
            "search_space_exhausted_claimed": False,
            "exact_value_search_scope": (
                "only collision pairs checked before the declared exact solver node/pair budget; "
                "zero means no exact minimax was attempted"
            ),
            "negative_result_interpretation": (
                "No witness was found under this exact deterministic board, strategy, depth/state, "
                "and optional solver budgets; this is not evidence that no witness exists."
            ),
            "mask_free_side6_witness_promoted": False,
        },
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "cpu_only": True,
            "network_used": False,
            "gpu_used": False,
        },
    }


def _write_create_only(path: Path, payload: dict[str, Any]) -> None:
    resolved = path.resolve()
    if resolved.exists():
        raise FileExistsError(f"refusing to overwrite audit artifact: {resolved}")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grid-size", type=int, required=True)
    parser.add_argument("--max-states", type=int, required=True)
    parser.add_argument("--max-depth", type=int, required=True)
    parser.add_argument("--exact-solver-nodes", type=int, default=0)
    parser.add_argument("--max-decision-pairs", type=int, default=0)
    parser.add_argument("--progress-every", type=int, default=0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    payload = search(
        grid_size=args.grid_size,
        max_states=args.max_states,
        max_depth=args.max_depth,
        exact_solver_nodes=args.exact_solver_nodes,
        max_decision_pairs=args.max_decision_pairs,
        progress_every=args.progress_every,
    )
    _write_create_only(args.output, payload)
    print(json.dumps({"status": payload["status"], "output": str(args.output.resolve()), "stats": payload["result"]["stats"]}, sort_keys=True))
    return 0 if payload["status"] == "FOUND" else 2


if __name__ == "__main__":
    raise SystemExit(main())
