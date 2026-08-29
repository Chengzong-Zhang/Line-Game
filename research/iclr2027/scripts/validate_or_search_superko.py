"""Reproduce the bounded and exhaustive natural-Superko checks.

The exhaustive check deliberately removes history while constructing the raw
transition graph.  It then propagates all history keys that can occur on any
path through that graph.  If no move edge repeats a propagated key, Superko
cannot reject a move on any real trajectory represented by the graph.

For side length five the graph is small enough to enumerate completely.  A
second consecutive PASS is omitted because it terminates immediately and does
not add a history key; every non-terminal single-PASS transition is included.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import GameSnapshot, LifelineGame, Player, PointState  # noqa: E402
from lifeline_rl.core import StateKey  # noqa: E402

Point = tuple[int, int]


@dataclass(frozen=True)
class RawEdge:
    successor: int
    action: Point | None
    history_key_id: int | None


@dataclass(frozen=True)
class RawGraph:
    states: tuple[GameSnapshot, ...]
    adjacency: tuple[tuple[RawEdge, ...], ...]
    history_keys: tuple[StateKey, ...]
    include_passes: bool

    @property
    def transition_count(self) -> int:
        return sum(map(len, self.adjacency))


def _without_history(snapshot: GameSnapshot) -> GameSnapshot:
    return replace(snapshot, history_hashes=frozenset())


def _node_key(snapshot: GameSnapshot) -> tuple[object, ...]:
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def _play_raw_move(game: LifelineGame, action: Point) -> StateKey | None:
    """Apply a locally valid move while keeping history empty.

    ``LifelineGame.play_move`` writes the new key before its automatic no-move
    check.  A raw graph must not let even that one newly written key influence
    automatic skipping, otherwise the absence proof would be circular.  This
    helper mirrors the public transition ordering but deliberately omits the
    history lookup and insertion.
    """

    if game.game_over or not game._add_node(action):
        return None
    move_key = game._compute_state_key(game.opponent(game.current_player))
    game.turn_count += 1
    game.consecutive_skips = 0
    game._legal_moves_cache.clear()
    game._switch_player()
    game._check_and_auto_skip()
    if game.game_over:
        game._update_territories()
    return move_key


def build_raw_graph(
    grid_size: int = 5,
    *,
    include_passes: bool = True,
    progress: Callable[[int, int], None] | None = None,
) -> RawGraph:
    """Enumerate every locally valid transition reachable from the start.

    Stored snapshots have empty histories, so the graph is independent of a
    particular path.  Move edges retain the exact state key that a real move
    would add to its Superko history.  This function is also the reusable graph
    interface for exact value analysis on the side-five game.
    """

    if grid_size != 5:
        raise ValueError("complete raw-graph enumeration is currently certified only for grid_size=5")

    game = LifelineGame(grid_size)
    initial_key = next(iter(game.history_hashes))
    initial = _without_history(game.clone())
    states = [initial]
    state_ids = {_node_key(initial): 0}
    history_keys = [initial_key]
    history_key_ids = {initial_key: 0}
    adjacency: list[tuple[RawEdge, ...]] = []
    queue = deque([0])

    while queue:
        state_id = queue.popleft()
        snapshot = states[state_id]
        outgoing: list[RawEdge] = []
        if not snapshot.game_over:
            for action in game.valid_positions:
                game.restore(snapshot)
                move_key = _play_raw_move(game, action)
                if move_key is None:
                    continue
                if game.history_hashes:
                    raise AssertionError("raw transition unexpectedly retained history")
                key_id = history_key_ids.get(move_key)
                if key_id is None:
                    key_id = len(history_keys)
                    history_key_ids[move_key] = key_id
                    history_keys.append(move_key)
                successor = _without_history(game.clone())
                successor_key = _node_key(successor)
                successor_id = state_ids.get(successor_key)
                if successor_id is None:
                    successor_id = len(states)
                    state_ids[successor_key] = successor_id
                    states.append(successor)
                    queue.append(successor_id)
                outgoing.append(RawEdge(successor_id, action, key_id))

            # A pass from consecutive_skips==1 can only terminate.  It writes no
            # history key and has no future transition, so it is irrelevant to
            # natural-Superko reachability and intentionally omitted.
            if include_passes and snapshot.consecutive_skips == 0:
                game.restore(snapshot)
                result = game.skip_turn()
                if result.success and not game.game_over:
                    successor = _without_history(game.clone())
                    successor_key = _node_key(successor)
                    successor_id = state_ids.get(successor_key)
                    if successor_id is None:
                        successor_id = len(states)
                        state_ids[successor_key] = successor_id
                        states.append(successor)
                        queue.append(successor_id)
                    outgoing.append(RawEdge(successor_id, None, None))

        adjacency.append(tuple(outgoing))
        if progress is not None and state_id > 0 and state_id % 10_000 == 0:
            progress(state_id, len(states))

    return RawGraph(
        states=tuple(states),
        adjacency=tuple(adjacency),
        history_keys=tuple(history_keys),
        include_passes=include_passes,
    )


def topological_order(graph: RawGraph) -> tuple[int, ...]:
    indegree = [0] * len(graph.states)
    for outgoing in graph.adjacency:
        for edge in outgoing:
            indegree[edge.successor] += 1
    queue = deque(index for index, degree in enumerate(indegree) if degree == 0)
    order: list[int] = []
    while queue:
        state_id = queue.popleft()
        order.append(state_id)
        for edge in graph.adjacency[state_id]:
            indegree[edge.successor] -= 1
            if indegree[edge.successor] == 0:
                queue.append(edge.successor)
    return tuple(order)


def analyze_exhaustive_graph(graph: RawGraph) -> dict[str, object]:
    """Use exact bitset DP to test every raw path for a repeated move key."""

    order = topological_order(graph)
    is_dag = len(order) == len(graph.states)
    result: dict[str, object] = {
        "status": "COMPLETE" if is_dag else "INCONCLUSIVE_GRAPH_HAS_CYCLE",
        "grid_size": 5,
        "include_nonterminal_passes": graph.include_passes,
        "states": len(graph.states),
        "transitions": graph.transition_count,
        "distinct_move_history_keys": len(graph.history_keys),
        "topological_nodes": len(order),
        "is_dag": is_dag,
        "natural_superko_found": None if not is_dag else False,
    }
    if not is_dag:
        return result

    histories = [0] * len(graph.states)
    histories[0] = 1  # history_keys[0] is the initial state key.
    max_depth = [0] * len(graph.states)
    candidate: dict[str, object] | None = None
    for state_id in order:
        history_bits = histories[state_id]
        for edge in graph.adjacency[state_id]:
            if edge.history_key_id is not None and history_bits & (1 << edge.history_key_id):
                candidate = {
                    "state_id": state_id,
                    "action": list(edge.action) if edge.action is not None else None,
                    "history_key_id": edge.history_key_id,
                }
                break
            successor_bits = history_bits
            if edge.history_key_id is not None:
                successor_bits |= 1 << edge.history_key_id
            histories[edge.successor] |= successor_bits
            max_depth[edge.successor] = max(max_depth[edge.successor], max_depth[state_id] + 1)
        if candidate is not None:
            break

    result.update(
        {
            "natural_superko_found": candidate is not None,
            "candidate": candidate,
            "max_raw_path_length": max(max_depth),
            "max_reachable_history_key_union": max(bits.bit_count() for bits in histories),
        }
    )
    return result


def random_search(
    *,
    grid_size: int,
    episodes: int,
    max_plies: int,
    seed: int,
    pass_probability: float,
    attack_bias: float,
) -> dict[str, object]:
    """Run deterministic attack-biased real games and return any witness."""

    rng = random.Random(seed)
    digest = hashlib.sha256()
    total_plies = 0
    attacks_played = 0
    passes_played = 0
    for episode in range(episodes):
        game = LifelineGame(grid_size)
        actions: list[Point | None] = []
        for ply in range(max_plies):
            if game.game_over:
                break
            legal: list[Point] = []
            attacks: list[Point] = []
            rejected_by_superko: list[Point] = []
            opponent_line = (
                PointState.WHITE_LINE
                if game.current_player is Player.BLACK
                else PointState.BLACK_LINE
            )
            for point in game.valid_positions:
                evaluation = game.evaluate_move(point)
                if evaluation.reason == "SUPERKO_VIOLATION":
                    rejected_by_superko.append(point)
                elif evaluation.success:
                    legal.append(point)
                    if game.get_state(point) == opponent_line:
                        attacks.append(point)
            if rejected_by_superko:
                return {
                    "status": "FOUND",
                    "grid_size": grid_size,
                    "seed": seed,
                    "episode": episode,
                    "ply": ply,
                    "prefix": [list(action) if action is not None else None for action in actions],
                    "rejected_actions": [list(point) for point in rejected_by_superko],
                    "episodes_budget": episodes,
                    "max_plies": max_plies,
                    "total_plies_examined": total_plies,
                    "attacks_played": attacks_played,
                    "passes_played": passes_played,
                }

            if (
                ply > 0
                and game.consecutive_skips == 0
                and rng.random() < pass_probability
            ):
                action = None
                passes_played += 1
                result = game.skip_turn()
            elif attacks and rng.random() < attack_bias:
                action = rng.choice(attacks)
                attacks_played += 1
                result = game.play_move(action)
            elif legal:
                action = rng.choice(legal)
                result = game.play_move(action)
            else:
                action = None
                passes_played += 1
                result = game.skip_turn()
            if not result.success:
                raise AssertionError((episode, ply, action, result))
            actions.append(action)
            total_plies += 1
            digest.update(
                json.dumps([episode, ply, action], separators=(",", ":")).encode("ascii")
            )

    return {
        "status": "NOT_FOUND_WITHIN_BUDGET",
        "grid_size": grid_size,
        "seed": seed,
        "episodes_budget": episodes,
        "max_plies": max_plies,
        "total_plies_examined": total_plies,
        "attacks_played": attacks_played,
        "passes_played": passes_played,
        "trace_digest_sha256": digest.hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("exhaustive", "random", "both"), default="both")
    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--episodes", type=int, default=2_000)
    parser.add_argument("--max-plies", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--pass-probability", type=float, default=0.12)
    parser.add_argument("--attack-bias", type=float, default=0.90)
    parser.add_argument("--no-passes", action="store_true")
    parser.add_argument("--progress", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 0.0 <= args.pass_probability <= 1.0:
        parser.error("--pass-probability must be in [0, 1]")
    if not 0.0 <= args.attack_bias <= 1.0:
        parser.error("--attack-bias must be in [0, 1]")

    started = time.perf_counter()
    report: dict[str, object] = {"schema_version": 1}
    if args.mode in {"exhaustive", "both"}:
        if args.grid_size != 5:
            parser.error("exhaustive mode is certified only for --grid-size 5")

        def progress(processed: int, discovered: int) -> None:
            print(
                f"graph progress: processed={processed} discovered={discovered}",
                file=sys.stderr,
                flush=True,
            )

        graph = build_raw_graph(
            args.grid_size,
            include_passes=not args.no_passes,
            progress=progress if args.progress else None,
        )
        report["exhaustive"] = analyze_exhaustive_graph(graph)
    if args.mode in {"random", "both"}:
        report["random"] = random_search(
            grid_size=args.grid_size,
            episodes=args.episodes,
            max_plies=args.max_plies,
            seed=args.seed,
            pass_probability=args.pass_probability,
            attack_bias=args.attack_bias,
        )
    report["elapsed_seconds"] = round(time.perf_counter() - started, 6)
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
