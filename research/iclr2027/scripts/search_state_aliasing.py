#!/usr/bin/env python3
"""Search for reproducible state-aliasing witnesses in LIFELINE.

The search is deterministic for a fixed configuration.  It deliberately keeps
the search procedure separate from the evidence fixtures: a candidate is only
promoted to the versioned dataset after it has been replayed and independently
checked by the D6 regression tests.

Two witness classes are sought:

``grid_topology``
    Equal implemented Grid observations (including the legal-action mask), but
    different logical edges. A strict witness changes a shared action's next
    Grid observation, reward, or terminal result. A legal-set difference is not
    a Grid alias because the mask exposes it.

``history_superko``
    Equal mask-free current topology projections but different Superko
    histories. A strict witness has an action that succeeds in one state and is
    rejected as ``SUPERKO_VIOLATION`` in the other. Such a witness diagnoses
    the mask-free projection; the implemented Topology observation would expose
    the legality difference through its mask.

This script uses only the Python standard library and the public environment
API.  Run it from ``research/iclr2027`` or from anywhere in the repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lifeline_rl import LifelineGame, Player, PointState  # noqa: E402
from lifeline_rl.encoding import encode_observation  # noqa: E402


Action = tuple[int, int]
MaybePass = Action | None
History = tuple[MaybePass, ...]


@dataclass(frozen=True)
class Candidate:
    history: tuple[Action, ...]
    legal: tuple[Action, ...]
    superko: tuple[Action, ...]
    history_size: int
    edge_signature: tuple[tuple[tuple[int, int], ...], ...]
    history_fingerprint: str


@dataclass
class SearchStats:
    episodes: int = 0
    states: int = 0
    moves: int = 0
    grid_collisions: int = 0
    distinct_edge_collisions: int = 0
    topology_collisions: int = 0
    distinct_history_collisions: int = 0
    natural_superko_states: int = 0
    max_turn_count: int = 0
    elapsed_seconds: float = 0.0


@dataclass
class SearchResult:
    config: dict[str, Any]
    stats: SearchStats = field(default_factory=SearchStats)
    grid_strict: dict[str, Any] | None = None
    history_strict: dict[str, Any] | None = None
    grid_weak: dict[str, Any] | None = None


def _edge_signature(game: LifelineGame) -> tuple[tuple[tuple[int, int], ...], ...]:
    return tuple(tuple(sorted(game.edges[player])) for player in (Player.BLACK, Player.WHITE))


def _grid_key(game: LifelineGame) -> tuple[Any, ...]:
    """Hashable identity of the implemented Grid observation."""

    observation = encode_observation(game, "grid")
    return (
        game.grid_size,
        observation["board"],
        observation["current_player"],
        observation["consecutive_skips"],
        observation["legal_action_mask"],
    )


def _mask_free_topology_key(game: LifelineGame) -> tuple[Any, ...]:
    """Current topology projection used only by the Superko diagnostic."""

    return (
        game.grid_size,
        tuple(game.grid),
        game.current_player.value,
        game.consecutive_skips,
        game.game_over,
        _edge_signature(game),
    )


def _action_outcomes(game: LifelineGame) -> tuple[tuple[Action, ...], tuple[Action, ...]]:
    legal: list[Action] = []
    superko: list[Action] = []
    if game.game_over:
        return (), ()
    for point in game.valid_positions:
        result = game.evaluate_move(point)
        if result.success:
            legal.append(point)
        elif result.reason == "SUPERKO_VIOLATION":
            superko.append(point)
    return tuple(legal), tuple(superko)


def _history_fingerprint(game: LifelineGame) -> str:
    """Compact deterministic identity for the unordered Superko history set."""

    canonical = "\n".join(sorted(repr(key) for key in game.history_hashes))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _replay(grid_size: int, history: Iterable[Sequence[int] | None]) -> LifelineGame:
    game = LifelineGame(grid_size)
    game.replay(
        tuple(
            None if action is None else (int(action[0]), int(action[1]))
            for action in history
        )
    )
    return game


def _json_action(action: MaybePass) -> list[int] | None:
    return None if action is None else list(action)


def _apply_action(game: LifelineGame, action: MaybePass):
    return game.skip_turn() if action is None else game.play_move(action)


def _visible_state(game: LifelineGame) -> dict[str, Any]:
    winner = game.winner()
    return {
        "board": list(game.grid),
        "current_player": game.current_player.value,
        "consecutive_skips": game.consecutive_skips,
        "game_over": game.game_over,
        "legal_action_mask": list(encode_observation(game, "grid")["legal_action_mask"]),
        "winner": winner.value if isinstance(winner, Player) else winner,
        "rewards": {
            player.value: game.rewards()[player]
            for player in (Player.BLACK, Player.WHITE)
        },
    }


def _logical_edges_as_points(game: LifelineGame) -> dict[str, list[list[list[int]]]]:
    result: dict[str, list[list[list[int]]]] = {}
    for player in (Player.BLACK, Player.WHITE):
        result[player.value] = [
            [list(game.valid_positions[a]), list(game.valid_positions[b])]
            for a, b in sorted(game.edges[player])
        ]
    return result


def _serialized_pair(
    kind: str,
    game_a: LifelineGame,
    game_b: LifelineGame,
    history_a: History,
    history_b: History,
    witness: dict[str, Any],
) -> dict[str, Any]:
    return {
        "kind": kind,
        "grid_size": game_a.grid_size,
        "history_a": [_json_action(action) for action in history_a],
        "history_b": [_json_action(action) for action in history_b],
        "state_a": game_a.serialize_state(),
        "state_b": game_b.serialize_state(),
        "logical_edges_as_points": {
            "a": _logical_edges_as_points(game_a),
            "b": _logical_edges_as_points(game_b),
        },
        "witness": witness,
    }


def classify_grid_pair(
    grid_size: int,
    history_a: History,
    history_b: History,
) -> dict[str, Any] | None:
    """Return strict/weak evidence for two replayable Grid-colliding states."""

    game_a = _replay(grid_size, history_a)
    game_b = _replay(grid_size, history_b)
    if _grid_key(game_a) != _grid_key(game_b):
        return None
    if _edge_signature(game_a) == _edge_signature(game_b):
        return None

    legal_a, _ = _action_outcomes(game_a)
    legal_b, _ = _action_outcomes(game_b)
    if legal_a != legal_b:
        raise AssertionError("equal implemented Grid observations must have equal legal masks")

    common_actions: set[MaybePass] = set(legal_a) & set(legal_b)
    if not game_a.game_over:
        common_actions.add(None)
    for action in sorted(
        common_actions,
        key=lambda candidate: (-1, -1) if candidate is None else candidate,
    ):
        next_a = LifelineGame.from_serialized_state(game_a.serialize_state())
        next_b = LifelineGame.from_serialized_state(game_b.serialize_state())
        result_a = _apply_action(next_a, action)
        result_b = _apply_action(next_b, action)
        if not result_a.success or not result_b.success:
            continue
        visible_a = _visible_state(next_a)
        visible_b = _visible_state(next_b)
        if visible_a != visible_b:
            witness = {
                "strict": True,
                "difference": "visible_successor",
                "action": _json_action(action),
                "successor_a": visible_a,
                "successor_b": visible_b,
            }
            return _serialized_pair(
                "grid_topology_strict", game_a, game_b, history_a, history_b, witness
            )

    witness = {
        "strict": False,
        "difference": "logical_edges_only",
        "common_legal_actions": [
            _json_action(action)
            for action in sorted(
                common_actions,
                key=lambda candidate: (-1, -1) if candidate is None else candidate,
            )
        ],
    }
    return _serialized_pair("grid_topology_weak", game_a, game_b, history_a, history_b, witness)


def classify_history_pair(
    grid_size: int,
    history_a: History,
    history_b: History,
) -> dict[str, Any] | None:
    """Return a strict Superko-history witness, or ``None``."""

    game_a = _replay(grid_size, history_a)
    game_b = _replay(grid_size, history_b)
    if _mask_free_topology_key(game_a) != _mask_free_topology_key(game_b):
        return None
    if game_a.history_hashes == game_b.history_hashes:
        return None

    legal_a, superko_a = _action_outcomes(game_a)
    legal_b, superko_b = _action_outcomes(game_b)
    strict_actions = sorted(
        (set(superko_a) & set(legal_b)) | (set(superko_b) & set(legal_a))
    )
    if not strict_actions:
        return None
    action = strict_actions[0]
    outcome_a = game_a.evaluate_move(action)
    outcome_b = game_b.evaluate_move(action)
    witness = {
        "strict": True,
        "difference": "superko_legality",
        "action": list(action),
        "outcome_a": {
            "success": outcome_a.success,
            "reason": outcome_a.reason,
        },
        "outcome_b": {
            "success": outcome_b.success,
            "reason": outcome_b.reason,
        },
    }
    return _serialized_pair(
        "history_superko_strict", game_a, game_b, history_a, history_b, witness
    )


def exact_grid_value_search() -> dict[str, Any]:
    """Run the independently red-teamed exhaustive n=5 solver.

    The audit evaluates PASS directly from every nonterminal state, including
    the case where the first PASS triggers an automatic opponent skip and
    immediate termination.  Keeping this wrapper thin prevents the search and
    audit paths from silently diverging.
    """

    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from d6_redteam_exact_audit import (  # noqa: PLC0415
        analyze_aliases,
        compare_solver_without_zero_skip_terminal_pass,
        solve,
        verify_graph,
    )
    from validate_or_search_superko import (  # noqa: PLC0415
        analyze_exhaustive_graph,
        build_raw_graph,
    )

    graph = build_raw_graph(5, include_passes=True)
    exhaustive = analyze_exhaustive_graph(graph)
    verification = verify_graph(graph)
    solved = solve(graph)
    aliases = analyze_aliases(graph, solved)
    omission_effect = compare_solver_without_zero_skip_terminal_pass(graph, solved)
    strict_labels = (
        "different_legal_action_sets",
        "different_visible_one_step_outcomes",
        "different_exact_black_values",
        "different_optimal_action_sets",
        "disjoint_optimal_action_sets",
        "different_shared_action_q_values",
    )
    counts = aliases["counts"]
    strict_count = sum(int(counts[label]) for label in strict_labels)
    return {
        "status": "FOUND" if strict_count else "NOT_FOUND_EXHAUSTIVELY",
        "proof_scope": exhaustive,
        "independent_graph_checks": verification,
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
        "witness": next(iter(aliases["first_witnesses"].values()), None),
    }


def paired_continuation_search(
    grid_size: int,
    history_a: History,
    history_b: History,
    *,
    max_pair_states: int = 100_000,
    max_depth: int = 20,
    progress_every: int = 10_000,
) -> dict[str, Any]:
    """Search all shared continuations of a reachable weak Grid-alias pair.

    The search advances the same action in both hidden states as long as their
    Grid observations remain equal.  It returns the earliest reachable pair
    whose legal actions or one-step visible successor differ.
    """

    initial_a = _replay(grid_size, history_a)
    initial_b = _replay(grid_size, history_b)
    if _grid_key(initial_a) != _grid_key(initial_b):
        raise ValueError("seed histories do not produce the same Grid observation")
    if _edge_signature(initial_a) == _edge_signature(initial_b):
        raise ValueError("seed histories do not differ in logical topology")

    queue: deque[tuple[Any, Any, tuple[MaybePass, ...]]] = deque(
        [(initial_a.clone(), initial_b.clone(), ())]
    )
    visited: set[tuple[Any, Any]] = set()
    examined_actions = 0
    max_depth_reached = 0
    while queue and len(visited) < max_pair_states:
        snapshot_a, snapshot_b, suffix = queue.popleft()
        game_a = LifelineGame(grid_size)
        game_b = LifelineGame(grid_size)
        game_a.restore(snapshot_a)
        game_b.restore(snapshot_b)
        pair_key = (snapshot_a, snapshot_b)
        if pair_key in visited:
            continue
        visited.add(pair_key)
        if progress_every and len(visited) % progress_every == 0:
            print(
                json.dumps(
                    {
                        "paired_states": len(visited),
                        "frontier": len(queue),
                        "depth": len(suffix),
                        "actions_examined": examined_actions,
                    },
                    sort_keys=True,
                ),
                file=sys.stderr,
                flush=True,
            )
        max_depth_reached = max(max_depth_reached, len(suffix))

        legal_points_a, _ = _action_outcomes(game_a)
        legal_points_b, _ = _action_outcomes(game_b)
        legal_a: set[MaybePass] = set(legal_points_a)
        legal_b: set[MaybePass] = set(legal_points_b)
        if not game_a.game_over:
            legal_a.add(None)
        if not game_b.game_over:
            legal_b.add(None)
        if legal_a != legal_b:
            only_a = sorted(legal_a - legal_b, key=lambda a: (-1, -1) if a is None else a)
            only_b = sorted(legal_b - legal_a, key=lambda a: (-1, -1) if a is None else a)
            evidence_action = (only_a or only_b)[0]
            def evaluate_without_mutation(game: LifelineGame) -> dict[str, Any]:
                if game.game_over:
                    return {"success": False, "reason": "GAME_OVER"}
                if evidence_action is not None:
                    return asdict(game.evaluate_move(evidence_action))
                probe = LifelineGame(grid_size)
                probe.restore(game.clone())
                return asdict(probe.skip_turn())

            outcome_a = evaluate_without_mutation(game_a)
            outcome_b = evaluate_without_mutation(game_b)
            current_history_a = history_a + suffix
            current_history_b = history_b + suffix
            witness = {
                "strict": True,
                "difference": "legal_actions_after_shared_continuation",
                "shared_continuation": [_json_action(action) for action in suffix],
                "action": _json_action(evidence_action),
                "legal_only_in_a": [_json_action(action) for action in only_a],
                "legal_only_in_b": [_json_action(action) for action in only_b],
                "outcome_a": outcome_a,
                "outcome_b": outcome_b,
            }
            return {
                "status": "FOUND",
                "pair_states_examined": len(visited),
                "actions_examined": examined_actions,
                "max_depth_reached": max_depth_reached,
                "pair": _serialized_pair(
                    "grid_topology_strict",
                    game_a,
                    game_b,
                    current_history_a,
                    current_history_b,
                    witness,
                ),
            }

        if len(suffix) >= max_depth or game_a.game_over:
            continue
        for action in sorted(legal_a & legal_b, key=lambda a: (-1, -1) if a is None else a):
            examined_actions += 1
            next_a = LifelineGame(grid_size)
            next_b = LifelineGame(grid_size)
            next_a.restore(snapshot_a)
            next_b.restore(snapshot_b)
            result_a = _apply_action(next_a, action)
            result_b = _apply_action(next_b, action)
            if not result_a.success or not result_b.success:
                raise AssertionError("shared legal action did not replay in both paired states")
            if _visible_state(next_a) != _visible_state(next_b):
                current_history_a = history_a + suffix
                current_history_b = history_b + suffix
                witness = {
                    "strict": True,
                    "difference": "visible_successor_after_shared_continuation",
                    "shared_continuation": [_json_action(item) for item in suffix],
                    "action": _json_action(action),
                    "successor_a": _visible_state(next_a),
                    "successor_b": _visible_state(next_b),
                }
                return {
                    "status": "FOUND",
                    "pair_states_examined": len(visited),
                    "actions_examined": examined_actions,
                    "max_depth_reached": max_depth_reached,
                    "pair": _serialized_pair(
                        "grid_topology_strict",
                        game_a,
                        game_b,
                        current_history_a,
                        current_history_b,
                        witness,
                    ),
                }
            if _edge_signature(next_a) == _edge_signature(next_b):
                continue
            queue.append((next_a.clone(), next_b.clone(), suffix + (action,)))

    return {
        "status": "NOT_FOUND_WITHIN_BUDGET" if queue else "NOT_FOUND_EXHAUSTIVELY",
        "pair_states_examined": len(visited),
        "actions_examined": examined_actions,
        "max_depth_reached": max_depth_reached,
        "max_pair_states": max_pair_states,
        "max_depth": max_depth,
        "frontier_remaining": len(queue),
    }


def _pick_move(
    game: LifelineGame,
    legal: Sequence[Action],
    rng: random.Random,
    attack_weight: float,
) -> Action:
    opponent_line = PointState.WHITE_LINE if game.current_player is Player.BLACK else PointState.BLACK_LINE
    weights = [attack_weight if game.get_state(point) == opponent_line else 1.0 for point in legal]
    return rng.choices(list(legal), weights=weights, k=1)[0]


def random_search(
    *,
    grid_size: int,
    episodes: int,
    max_plies: int,
    seed: int,
    attack_weight: float,
    max_bucket_histories: int,
    progress_every: int,
    stop_when_complete: bool,
) -> SearchResult:
    """Run deterministic attack-biased random walks and inspect collisions."""

    config = {
        "method": "attack_biased_random_walk",
        "grid_size": grid_size,
        "episodes": episodes,
        "max_plies": max_plies,
        "seed": seed,
        "attack_weight": attack_weight,
        "max_bucket_histories": max_bucket_histories,
    }
    result = SearchResult(config=config)
    rng = random.Random(seed)
    grid_seen: dict[tuple[Any, ...], list[Candidate]] = {}
    topology_seen: dict[tuple[Any, ...], list[Candidate]] = {}
    started = time.perf_counter()

    for episode in range(episodes):
        game = LifelineGame(grid_size)
        history: list[Action] = []
        for _ in range(max_plies + 1):
            result.stats.states += 1
            result.stats.max_turn_count = max(result.stats.max_turn_count, game.turn_count)
            legal, superko = _action_outcomes(game)
            if superko:
                result.stats.natural_superko_states += 1
            candidate = Candidate(
                history=tuple(history),
                legal=legal,
                superko=superko,
                history_size=len(game.history_hashes),
                edge_signature=_edge_signature(game),
                history_fingerprint=_history_fingerprint(game),
            )

            grid_key = _grid_key(game)
            grid_bucket = grid_seen.setdefault(grid_key, [])
            if grid_bucket:
                result.stats.grid_collisions += 1
            edge_sig = candidate.edge_signature
            for previous in grid_bucket:
                if previous.edge_signature == edge_sig:
                    continue
                result.stats.distinct_edge_collisions += 1
                classified = classify_grid_pair(grid_size, previous.history, candidate.history)
                if classified is not None:
                    if classified["witness"]["strict"]:
                        result.grid_strict = classified
                        break
                    candidate_score = (
                        int(not classified["state_a"]["game_over"]),
                        len(classified["witness"]["common_legal_actions"]),
                        -len(classified["history_a"]),
                    )
                    current_score = (
                        (
                            int(not result.grid_weak["state_a"]["game_over"]),
                            len(result.grid_weak["witness"]["common_legal_actions"]),
                            -len(result.grid_weak["history_a"]),
                        )
                        if result.grid_weak is not None
                        else (-1, -1, -10**9)
                    )
                    if candidate_score > current_score:
                        result.grid_weak = classified
            if not any(item.edge_signature == edge_sig for item in grid_bucket) and len(
                grid_bucket
            ) < max_bucket_histories:
                grid_bucket.append(candidate)

            topology_key = _mask_free_topology_key(game)
            topology_bucket = topology_seen.setdefault(topology_key, [])
            if topology_bucket:
                result.stats.topology_collisions += 1
            for previous in topology_bucket:
                if previous.history_fingerprint == candidate.history_fingerprint:
                    continue
                result.stats.distinct_history_collisions += 1
                if (set(previous.superko) & set(legal)) or (set(superko) & set(previous.legal)):
                    classified = classify_history_pair(
                        grid_size, previous.history, candidate.history
                    )
                    if classified is not None:
                        result.history_strict = classified
                        break
            history_marker = (candidate.superko, candidate.legal, candidate.history_size)
            if not any(
                (item.superko, item.legal, item.history_size) == history_marker
                for item in topology_bucket
            ) and len(topology_bucket) < max_bucket_histories:
                topology_bucket.append(candidate)

            if stop_when_complete and result.grid_strict and result.history_strict:
                break
            if game.game_over or not legal or len(history) >= max_plies:
                break
            action = _pick_move(game, legal, rng, attack_weight)
            move_result = game.play_move(action)
            if not move_result.success:
                raise RuntimeError(f"search selected illegal action {action}: {move_result.reason}")
            history.append(action)
            result.stats.moves += 1

        result.stats.episodes = episode + 1
        if progress_every and (episode + 1) % progress_every == 0:
            elapsed = time.perf_counter() - started
            print(
                json.dumps(
                    {
                        "progress_episode": episode + 1,
                        "states": result.stats.states,
                        "grid_strict": result.grid_strict is not None,
                        "history_strict": result.history_strict is not None,
                        "natural_superko_states": result.stats.natural_superko_states,
                        "elapsed_seconds": round(elapsed, 3),
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
        if stop_when_complete and result.grid_strict and result.history_strict:
            break

    result.stats.elapsed_seconds = time.perf_counter() - started
    return result


def _jsonable(result: SearchResult) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "search_config": result.config,
        "stats": asdict(result.stats),
        "grid_strict": result.grid_strict,
        "history_strict": result.history_strict,
        "grid_weak": result.grid_weak,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("random", "exact-n5", "both", "paired"),
        default="random",
        help="random collision search, exhaustive n=5 value analysis, or both",
    )
    parser.add_argument("--grid-size", type=int, default=5)
    parser.add_argument("--episodes", type=int, default=10_000)
    parser.add_argument("--max-plies", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--attack-weight", type=float, default=16.0)
    parser.add_argument("--max-bucket-histories", type=int, default=4)
    parser.add_argument(
        "--pair-dataset",
        type=Path,
        default=PROJECT_ROOT / "state_aliasing" / "pairs_v1.json",
    )
    parser.add_argument("--pair-id", default="weak_grid_topology_n6_v1")
    parser.add_argument("--max-pair-states", type=int, default=5_000)
    parser.add_argument("--max-depth", type=int, default=20)
    parser.add_argument("--progress-every", type=int, default=250)
    parser.add_argument("--keep-searching", action="store_true")
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="print compact stats and witness histories instead of serialized states",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="optional JSON report path (candidate evidence, not an accepted fixture)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result: SearchResult | None = None
    payload: dict[str, Any] = {"schema_version": 1}
    if args.mode in {"random", "both"}:
        result = random_search(
            grid_size=args.grid_size,
            episodes=args.episodes,
            max_plies=args.max_plies,
            seed=args.seed,
            attack_weight=args.attack_weight,
            max_bucket_histories=args.max_bucket_histories,
            progress_every=args.progress_every,
            stop_when_complete=not args.keep_searching,
        )
        payload["random"] = _jsonable(result)
    if args.mode in {"exact-n5", "both"}:
        if args.grid_size != 5:
            raise SystemExit("--mode exact-n5/both requires --grid-size 5")
        payload["exact_n5"] = exact_grid_value_search()
    if args.mode == "paired":
        pair_dataset = json.loads(args.pair_dataset.read_text(encoding="utf-8"))
        try:
            pair = next(
                item for item in pair_dataset["pairs"]
                if item["pair_id"] == args.pair_id
            )
        except StopIteration as exc:
            raise SystemExit(f"pair id not found: {args.pair_id}") from exc
        payload["paired"] = paired_continuation_search(
            pair["grid_size"],
            tuple(
                None if action is None else (action[0], action[1])
                for action in pair["history_a"]
            ),
            tuple(
                None if action is None else (action[0], action[1])
                for action in pair["history_b"]
            ),
            max_pair_states=args.max_pair_states,
            max_depth=args.max_depth,
        )
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    if args.summary_only:
        random_payload = payload.get("random")
        exact_payload = payload.get("exact_n5")
        paired_payload = payload.get("paired")
        compact = {
            "schema_version": payload["schema_version"],
            "search_config": random_payload["search_config"] if random_payload else None,
            "stats": random_payload["stats"] if random_payload else None,
            "grid_strict": (
                {
                    "history_a": result.grid_strict["history_a"],
                    "history_b": result.grid_strict["history_b"],
                    "witness": result.grid_strict["witness"],
                }
                if result is not None and result.grid_strict
                else None
            ),
            "history_strict": (
                {
                    "history_a": result.history_strict["history_a"],
                    "history_b": result.history_strict["history_b"],
                    "witness": result.history_strict["witness"],
                }
                if result is not None and result.history_strict
                else None
            ),
            "grid_weak_found": result is not None and result.grid_weak is not None,
            "grid_weak": (
                {
                    "history_a": result.grid_weak["history_a"],
                    "history_b": result.grid_weak["history_b"],
                    "witness": result.grid_weak["witness"],
                    "game_over": result.grid_weak["state_a"]["game_over"],
                }
                if result is not None and result.grid_weak
                else None
            ),
            "exact_n5": (
                {
                    key: value
                    for key, value in exact_payload.items()
                    if key != "witness"
                }
                | {
                    "witness": (
                        {
                            "history_a": exact_payload["witness"]["history_a"],
                            "history_b": exact_payload["witness"]["history_b"],
                            "witness": exact_payload["witness"]["witness"],
                        }
                        if exact_payload and exact_payload["witness"]
                        else None
                    )
                }
                if exact_payload
                else None
            ),
            "paired": (
                {key: value for key, value in paired_payload.items() if key != "pair"}
                if paired_payload
                else None
            ),
        }
        print(json.dumps(compact, indent=2, sort_keys=True))
    else:
        print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    random_complete = bool(result and result.grid_strict and result.history_strict)
    exact_status = payload.get("exact_n5", {}).get("status")
    exact_complete = exact_status in {"FOUND", "NOT_FOUND_EXHAUSTIVELY"}
    paired_found = payload.get("paired", {}).get("status") == "FOUND"
    return 0 if random_complete or exact_complete or paired_found else 2


if __name__ == "__main__":
    raise SystemExit(main())
