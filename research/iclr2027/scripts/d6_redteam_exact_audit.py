#!/usr/bin/env python3
"""Independent red-team audit for the side-five D6 aliasing claims.

This file deliberately does not call ``exact_grid_value_search``.  It reuses
only the raw graph enumerator, independently checks graph closure/reachability,
solves the finite game by backward induction with PASS evaluated from every
nonterminal state, and measures several increasingly strong notions of
decision relevance for Grid-colliding topology states.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from lifeline_rl import GameSnapshot, LifelineGame, Player  # noqa: E402
from lifeline_rl.encoding import encode_observation  # noqa: E402
from validate_or_search_superko import (  # noqa: E402
    RawGraph,
    analyze_exhaustive_graph,
    build_raw_graph,
    topological_order,
)


Action = tuple[int, int] | None


def node_key(snapshot: GameSnapshot) -> tuple[Any, ...]:
    """The path-independent state used by the raw enumerator."""

    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def grid_key(snapshot: GameSnapshot) -> tuple[Any, ...]:
    return (
        snapshot.grid,
        snapshot.current_player,
        snapshot.consecutive_skips,
        snapshot.game_over,
    )


def topology_key(snapshot: GameSnapshot) -> tuple[Any, ...]:
    return (snapshot.black_edges, snapshot.white_edges)


def visible_key(
    snapshot: GameSnapshot,
    terminal_value: int | None,
    legal_actions: frozenset[Action],
) -> tuple[Any, ...]:
    return (
        snapshot.grid,
        snapshot.current_player,
        snapshot.consecutive_skips,
        snapshot.game_over,
        terminal_value,
        legal_actions,
    )


def terminal_black_value(game: LifelineGame) -> int:
    value = game.rewards()[Player.BLACK]
    if value not in (-1.0, 0.0, 1.0):
        raise AssertionError(f"unexpected reward {value!r}")
    return int(value)


def verify_graph(graph: RawGraph) -> dict[str, Any]:
    """Check uniqueness, root reachability, edge targets, and action uniqueness."""

    keys = [node_key(snapshot) for snapshot in graph.states]
    unique_nodes = len(set(keys)) == len(keys)
    targets_in_range = all(
        0 <= edge.successor < len(graph.states)
        for outgoing in graph.adjacency
        for edge in outgoing
    )
    unique_actions = all(
        len({edge.action for edge in outgoing}) == len(outgoing)
        for outgoing in graph.adjacency
    )
    reached = {0}
    queue = deque([0])
    while queue:
        state_id = queue.popleft()
        for edge in graph.adjacency[state_id]:
            if edge.successor not in reached:
                reached.add(edge.successor)
                queue.append(edge.successor)
    return {
        "unique_node_keys": unique_nodes,
        "all_edge_targets_in_range": targets_in_range,
        "unique_outgoing_actions": unique_actions,
        "root_reaches_all_nodes": len(reached) == len(graph.states),
        "reachable_nodes": len(reached),
    }


def verify_versioned_weak_fixture() -> dict[str, Any]:
    fixture_path = PROJECT_ROOT / "tests" / "fixtures" / "aliasing_pair.json"
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    games: list[LifelineGame] = []
    for label in ("A", "B"):
        game = LifelineGame(int(payload["grid_size"]))
        game.replay(
            None if action is None else (int(action[0]), int(action[1]))
            for action in payload["histories"][label]
        )
        games.append(game)
    game_a, game_b = games
    return {
        "replay_succeeds": True,
        "implemented_grid_observations_equal": (
            encode_observation(game_a, "grid") == encode_observation(game_b, "grid")
        ),
        "implemented_topology_observations_equal": (
            encode_observation(game_a, "topology")
            == encode_observation(game_b, "topology")
        ),
        "legal_action_sets_equal": set(game_a.legal_moves()) == set(game_b.legal_moves()),
        "logical_edge_sets_equal": all(
            game_a.edges[player] == game_b.edges[player]
            for player in (Player.BLACK, Player.WHITE)
        ),
        "superko_history_sets_equal": game_a.history_hashes == game_b.history_hashes,
    }


def pass_outcome(
    graph: RawGraph,
    state_id: int,
    game: LifelineGame,
) -> tuple[int | None, tuple[Any, ...]]:
    """Execute PASS from a raw state and return terminal value or successor key."""

    game.restore(graph.states[state_id])
    result = game.skip_turn()
    if not result.success:
        raise AssertionError(f"PASS failed at nonterminal state {state_id}")
    snapshot = game.clone()
    if snapshot.game_over:
        return terminal_black_value(game), visible_key(
            snapshot, terminal_black_value(game), frozenset()
        )
    return None, visible_key(snapshot, None, frozenset())


def solve(graph: RawGraph) -> dict[str, Any]:
    """Exact zero-sum solution with every legal PASS branch included."""

    order = topological_order(graph)
    if len(order) != len(graph.states):
        raise AssertionError("backward induction requires a DAG")
    key_to_id = {node_key(snapshot): state_id for state_id, snapshot in enumerate(graph.states)}
    game = LifelineGame(5)
    values = [0] * len(graph.states)
    action_values: list[dict[Action, int]] = [{} for _ in graph.states]
    visible_successors: list[dict[Action, tuple[Any, ...]]] = [
        {} for _ in graph.states
    ]
    pass_terminal_from_zero_skips = 0
    pass_nonterminal_mismatch = 0

    for state_id in reversed(order):
        snapshot = graph.states[state_id]
        game.restore(snapshot)
        if snapshot.game_over:
            values[state_id] = terminal_black_value(game)
            continue

        options: dict[Action, int] = {}
        visible: dict[Action, tuple[Any, ...]] = {}
        for edge in graph.adjacency[state_id]:
            if edge.action is None:
                continue
            options[edge.action] = values[edge.successor]
            successor = graph.states[edge.successor]
            terminal = values[edge.successor] if successor.game_over else None
            visible[edge.action] = visible_key(
                successor,
                terminal,
                frozenset(action_values[edge.successor]),
            )

        game.restore(snapshot)
        pass_result = game.skip_turn()
        if not pass_result.success:
            raise AssertionError(f"PASS failed at {state_id}")
        passed = game.clone()
        if passed.game_over:
            pass_value = terminal_black_value(game)
            if snapshot.consecutive_skips == 0:
                pass_terminal_from_zero_skips += 1
            visible[None] = visible_key(passed, pass_value, frozenset())
        else:
            successor_id = key_to_id.get(node_key(passed))
            if successor_id is None:
                raise AssertionError(f"nonterminal PASS successor absent at {state_id}")
            pass_value = values[successor_id]
            visible[None] = visible_key(
                graph.states[successor_id],
                None,
                frozenset(action_values[successor_id]),
            )
            recorded = [edge.successor for edge in graph.adjacency[state_id] if edge.action is None]
            if recorded != [successor_id]:
                pass_nonterminal_mismatch += 1
        options[None] = pass_value

        target = max(options.values()) if snapshot.current_player is Player.BLACK else min(options.values())
        values[state_id] = target
        action_values[state_id] = options
        visible_successors[state_id] = visible

    optimal_actions = [
        frozenset(action for action, q_value in q_values.items() if q_value == values[state_id])
        for state_id, q_values in enumerate(action_values)
    ]
    return {
        "values": values,
        "action_values": action_values,
        "optimal_actions": optimal_actions,
        "visible_successors": visible_successors,
        "pass_terminal_from_zero_skips": pass_terminal_from_zero_skips,
        "pass_nonterminal_edge_mismatches": pass_nonterminal_mismatch,
        "initial_black_value": values[0],
    }


def compare_solver_without_zero_skip_terminal_pass(
    graph: RawGraph,
    corrected: dict[str, Any],
) -> dict[str, int]:
    """Quantify the effect of omitting terminal PASS from zero-skip states.

    This mirrors the earlier exact-search branch construction.  It is an audit
    comparison only; the corrected solver above is the source of conclusions.
    """

    order = topological_order(graph)
    game = LifelineGame(5)
    values = [0] * len(graph.states)
    optimal: list[frozenset[Action]] = [frozenset() for _ in graph.states]
    for state_id in reversed(order):
        snapshot = graph.states[state_id]
        game.restore(snapshot)
        if snapshot.game_over:
            values[state_id] = terminal_black_value(game)
            continue
        options = {edge.action: values[edge.successor] for edge in graph.adjacency[state_id]}
        if snapshot.consecutive_skips == 1:
            game.restore(snapshot)
            result = game.skip_turn()
            if not result.success or not game.game_over:
                raise AssertionError("expected terminal second PASS")
            options[None] = terminal_black_value(game)
        if not options:
            raise AssertionError(f"legacy comparison has no action at {state_id}")
        target = max(options.values()) if snapshot.current_player is Player.BLACK else min(options.values())
        values[state_id] = target
        optimal[state_id] = frozenset(action for action, value in options.items() if value == target)
    return {
        "states_with_value_difference": sum(
            left != right for left, right in zip(values, corrected["values"])
        ),
        "states_with_optimal_set_difference": sum(
            left != right for left, right in zip(optimal, corrected["optimal_actions"])
        ),
        "legacy_initial_black_value": values[0],
    }


def shortest_histories(graph: RawGraph) -> list[list[Action]]:
    parent: list[tuple[int, Action] | None] = [None] * len(graph.states)
    queue = deque([0])
    seen = {0}
    while queue:
        state_id = queue.popleft()
        for edge in graph.adjacency[state_id]:
            if edge.successor not in seen:
                seen.add(edge.successor)
                parent[edge.successor] = (state_id, edge.action)
                queue.append(edge.successor)
    result: list[list[Action]] = []
    for state_id in range(len(graph.states)):
        reverse: list[Action] = []
        cursor = state_id
        while parent[cursor] is not None:
            previous, action = parent[cursor]
            reverse.append(action)
            cursor = previous
        result.append(list(reversed(reverse)))
    return result


def json_action(action: Action) -> list[int] | None:
    return None if action is None else [action[0], action[1]]


def witness_payload(
    graph: RawGraph,
    histories: list[list[Action]],
    state_a: int,
    state_b: int,
    solved: dict[str, Any],
    difference: str,
) -> dict[str, Any]:
    return {
        "difference": difference,
        "state_ids": [state_a, state_b],
        "histories": [
            [json_action(action) for action in histories[state_a]],
            [json_action(action) for action in histories[state_b]],
        ],
        "black_values": [solved["values"][state_a], solved["values"][state_b]],
        "optimal_actions": [
            [json_action(action) for action in sorted(
                solved["optimal_actions"][state_id],
                key=lambda action: (-1, -1) if action is None else action,
            )]
            for state_id in (state_a, state_b)
        ],
        "logical_edges": [
            {
                "black": [list(edge) for edge in graph.states[state_id].black_edges],
                "white": [list(edge) for edge in graph.states[state_id].white_edges],
            }
            for state_id in (state_a, state_b)
        ],
    }


def analyze_aliases(graph: RawGraph, solved: dict[str, Any]) -> dict[str, Any]:
    groups: dict[tuple[Any, ...], list[int]] = {}
    for state_id, snapshot in enumerate(graph.states):
        groups.setdefault(grid_key(snapshot), []).append(state_id)

    counts = {
        "grid_alias_groups": 0,
        "distinct_topology_pairs": 0,
        "different_legal_action_sets": 0,
        "different_visible_one_step_outcomes": 0,
        "different_exact_black_values": 0,
        "different_optimal_action_sets": 0,
        "disjoint_optimal_action_sets": 0,
        "different_shared_action_q_values": 0,
    }
    witnesses: dict[str, dict[str, Any]] = {}
    histories: list[list[Action]] | None = None

    for ids in groups.values():
        if len(ids) < 2:
            continue
        counts["grid_alias_groups"] += 1
        for offset, state_a in enumerate(ids):
            for state_b in ids[offset + 1 :]:
                if topology_key(graph.states[state_a]) == topology_key(graph.states[state_b]):
                    continue
                counts["distinct_topology_pairs"] += 1
                actions_a = set(solved["action_values"][state_a])
                actions_b = set(solved["action_values"][state_b])
                legal_diff = actions_a != actions_b
                visible_diff = any(
                    solved["visible_successors"][state_a][action]
                    != solved["visible_successors"][state_b][action]
                    for action in actions_a & actions_b
                )
                value_diff = solved["values"][state_a] != solved["values"][state_b]
                optimal_a = solved["optimal_actions"][state_a]
                optimal_b = solved["optimal_actions"][state_b]
                optimal_diff = optimal_a != optimal_b
                # Empty optimal sets occur only for terminal states.  Calling
                # two empty sets "disjoint" is mathematically true but not a
                # decision-relevance witness because there is no decision.
                disjoint = bool(optimal_a and optimal_b and optimal_a.isdisjoint(optimal_b))
                q_diff = any(
                    solved["action_values"][state_a][action]
                    != solved["action_values"][state_b][action]
                    for action in actions_a & actions_b
                )
                flags = {
                    "different_legal_action_sets": legal_diff,
                    "different_visible_one_step_outcomes": visible_diff,
                    "different_exact_black_values": value_diff,
                    "different_optimal_action_sets": optimal_diff,
                    "disjoint_optimal_action_sets": disjoint,
                    "different_shared_action_q_values": q_diff,
                }
                for label, present in flags.items():
                    if not present:
                        continue
                    counts[label] += 1
                    if label not in witnesses:
                        if histories is None:
                            histories = shortest_histories(graph)
                        witnesses[label] = witness_payload(
                            graph, histories, state_a, state_b, solved, label
                        )
    return {"counts": counts, "first_witnesses": witnesses}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    graph = build_raw_graph(5, include_passes=True)
    exhaustive = analyze_exhaustive_graph(graph)
    verification = verify_graph(graph)
    solved = solve(graph)
    omission_effect = compare_solver_without_zero_skip_terminal_pass(graph, solved)
    aliases = analyze_aliases(graph, solved)
    report = {
        "schema_version": 1,
        "scope": "complete raw side-five graph; larger boards are not covered",
        "exhaustive_superko_analysis": exhaustive,
        "independent_graph_checks": verification,
        "versioned_weak_fixture": verify_versioned_weak_fixture(),
        "exact_solution_checks": {
            key: solved[key]
            for key in (
                "initial_black_value",
                "pass_terminal_from_zero_skips",
                "pass_nonterminal_edge_mismatches",
            )
        },
        "omitted_zero_skip_terminal_pass_effect": omission_effect,
        "alias_analysis": aliases,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
