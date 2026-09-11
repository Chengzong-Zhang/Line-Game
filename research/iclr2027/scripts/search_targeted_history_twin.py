#!/usr/bin/env python3
"""Bounded CPU search for a natural paired Superko-history witness.

The frozen n=6 fixture supplies one naturally reachable state in which a move
is rejected by Superko.  This candidate-only tool searches from the standard
initial state for a second natural history with exactly the same mask-free
topology in which that move succeeds.  The heuristic changes only frontier
order; it never discards a state.  Paths containing the fixture's repeated
position key are pruned because Superko histories only grow and such a path
cannot make the candidate legal.

Search output is not accepted evidence.  A found candidate must pass the
independent ``verify_targeted_history_twin.py`` replay verifier before it can
support a scientific claim.  A negative result is always budget-scoped and is
never a nonexistence or exhaustiveness claim.
"""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import platform
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402


Action = tuple[int, int]
MaybePass = Action | None
History = tuple[MaybePass, ...]

DEFAULT_FIXTURE_PATH = PROJECT_ROOT / "state_aliasing" / "superko_n6_witness_v1.json"
EXPECTED_FIXTURE_SHA256 = (
    "A2916486D2A9C4738B1B8A01F72A91A689F968E20D1B6673B5E4F05A15927155"
)
CORE_PATH = PROJECT_ROOT / "lifeline_rl" / "core.py"
ACTION_ORDER = "PASS_FIRST_THEN_LEXICOGRAPHIC_POINTS_V1"
PRIORITY_DEFINITION = (
    "NON_ADMISSIBLE_TARGET_DISTANCE_V1: total weighted topology mismatch, "
    "board mismatch, edge symmetric difference, player mismatch, skip distance, "
    "terminal mismatch, path depth, monotonic insertion id"
)


@dataclass(frozen=True)
class ReferenceTarget:
    fixture: dict[str, Any]
    fixture_sha256: str
    grid_size: int
    reference_history: History
    candidate_action: Action
    forbidden_key: Any
    forbidden_key_sha256: str
    target_topology: dict[str, Any]
    target_topology_sha256: str
    reference_state_fingerprint: str
    reference_history_fingerprint: str
    reference_history_hashes: frozenset[Any]


@dataclass
class SearchStats:
    states_examined: int = 0
    transitions_examined: int = 0
    dominated_successors: int = 0
    stale_frontier_entries: int = 0
    forbidden_key_prunes: int = 0
    terminal_states: int = 0
    depth_cutoff_count: int = 0
    depth_cutoff_action_candidates: int = 0
    topology_hits: int = 0
    distinct_history_topology_hits: int = 0
    candidate_legal_hits: int = 0
    max_depth_reached: int = 0
    peak_frontier: int = 0
    elapsed_seconds: float = 0.0


@dataclass(order=True)
class FrontierEntry:
    priority: tuple[int, ...]
    tie_id: int
    history: History = field(compare=False)
    snapshot: Any = field(compare=False)
    state_fingerprint: str = field(compare=False)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest().upper()


def _history_fingerprint(game: LifelineGame) -> str:
    canonical = "\n".join(sorted(repr(key) for key in game.history_hashes))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().upper()


def _state_key_sha256(key: Any) -> str:
    return hashlib.sha256(repr(key).encode("utf-8")).hexdigest().upper()


def _json_action(action: MaybePass) -> list[int] | None:
    return None if action is None else [int(action[0]), int(action[1])]


def _parse_actions(raw: Iterable[Sequence[int] | None]) -> History:
    parsed: list[MaybePass] = []
    for index, item in enumerate(raw):
        if item is None:
            parsed.append(None)
            continue
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError(f"fixture action {index} is not a point or PASS")
        if type(item[0]) is not int or type(item[1]) is not int:
            raise ValueError(
                f"fixture action {index} coordinates must be strict integers"
            )
        parsed.append((item[0], item[1]))
    return tuple(parsed)


def _replay_standard(grid_size: int, history: History) -> LifelineGame:
    game = LifelineGame(grid_size, start_player=Player.BLACK, superko_mode="enforce")
    game.replay(history)
    return game


def _topology_payload(game: LifelineGame) -> dict[str, Any]:
    return {
        "grid_size": game.grid_size,
        "board": list(game.grid),
        "current_player": game.current_player.value,
        "consecutive_skips": game.consecutive_skips,
        "game_over": game.game_over,
        "logical_edge_indices": {
            player.value: [list(edge) for edge in sorted(game.edges[player])]
            for player in (Player.BLACK, Player.WHITE)
        },
    }


def _load_reference(fixture_path: Path = DEFAULT_FIXTURE_PATH) -> ReferenceTarget:
    fixture_bytes = fixture_path.read_bytes()
    actual_sha256 = hashlib.sha256(fixture_bytes).hexdigest().upper()
    if actual_sha256 != EXPECTED_FIXTURE_SHA256:
        raise ValueError(
            "frozen fixture SHA-256 mismatch: "
            f"expected {EXPECTED_FIXTURE_SHA256}, observed {actual_sha256}"
        )
    try:
        fixture = json.loads(fixture_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("frozen fixture is not strict UTF-8 JSON") from exc
    if fixture.get("fixture_id") != "natural_superko_n6_witness_v1":
        raise ValueError("unexpected fixture id")
    grid_size = int(fixture["grid_size"])
    reference_history = _parse_actions(fixture["natural_prefix"]["actions"])
    raw_candidate = fixture["candidate"]["action"]
    if not isinstance(raw_candidate, list) or len(raw_candidate) != 2:
        raise ValueError("fixture candidate action must be a point")
    if type(raw_candidate[0]) is not int or type(raw_candidate[1]) is not int:
        raise ValueError("fixture candidate action coordinates must be strict integers")
    candidate_action = (raw_candidate[0], raw_candidate[1])

    prefix_count = int(fixture["stage_5"]["prefix_action_count"])
    if not 0 < prefix_count <= len(reference_history):
        raise ValueError("invalid fixture stage prefix length")
    stage_game = _replay_standard(grid_size, reference_history[:prefix_count])
    forbidden_key = stage_game._compute_state_key(stage_game.current_player)
    forbidden_key_sha256 = _state_key_sha256(forbidden_key)
    expected_key_sha256 = str(fixture["stage_5"]["position_key_sha256"]).upper()
    if forbidden_key_sha256 != expected_key_sha256:
        raise ValueError("fixture stage position-key digest does not replay")

    reference = _replay_standard(grid_size, reference_history)
    reference_outcome = reference.evaluate_move(candidate_action)
    if (
        reference_outcome.success
        or reference_outcome.reason != "SUPERKO_VIOLATION"
        or not reference_outcome.would_violate_superko
    ):
        raise ValueError("fixture reference move is not a natural Superko rejection")
    if forbidden_key not in reference.history_hashes:
        raise ValueError("fixture reference history does not contain the repeated key")
    if reference.current_player.value != fixture["candidate"]["actor"]:
        raise ValueError("fixture candidate actor does not match replayed state")

    target_topology = _topology_payload(reference)
    return ReferenceTarget(
        fixture=fixture,
        fixture_sha256=actual_sha256,
        grid_size=grid_size,
        reference_history=reference_history,
        candidate_action=candidate_action,
        forbidden_key=forbidden_key,
        forbidden_key_sha256=forbidden_key_sha256,
        target_topology=target_topology,
        target_topology_sha256=_canonical_sha256(target_topology),
        reference_state_fingerprint=reference.state_fingerprint().upper(),
        reference_history_fingerprint=_history_fingerprint(reference),
        reference_history_hashes=frozenset(reference.history_hashes),
    )


def _topology_distance(game: LifelineGame, target: dict[str, Any]) -> tuple[int, ...]:
    board_mismatch = sum(
        int(observed != expected)
        for observed, expected in zip(game.grid, target["board"])
    )
    target_edges = target["logical_edge_indices"]
    edge_difference = 0
    for player in (Player.BLACK, Player.WHITE):
        expected = {tuple(edge) for edge in target_edges[player.value]}
        edge_difference += len(game.edges[player] ^ expected)
    player_mismatch = int(game.current_player.value != target["current_player"])
    skip_distance = abs(game.consecutive_skips - int(target["consecutive_skips"]))
    terminal_mismatch = int(game.game_over != bool(target["game_over"]))
    total = (
        board_mismatch
        + edge_difference
        + 2 * player_mismatch
        + 2 * skip_distance
        + 4 * terminal_mismatch
    )
    return (
        total,
        board_mismatch,
        edge_difference,
        player_mismatch,
        skip_distance,
        terminal_mismatch,
    )


def _priority(
    game: LifelineGame, target: ReferenceTarget, depth: int
) -> tuple[int, ...]:
    return (*_topology_distance(game, target.target_topology), depth)


def _ordered_actions(game: LifelineGame) -> tuple[MaybePass, ...]:
    if game.game_over:
        return ()
    return (None, *tuple(sorted(game.legal_moves())))


def _apply_action(game: LifelineGame, action: MaybePass) -> None:
    outcome = game.skip_turn() if action is None else game.play_move(action)
    if not outcome.success:
        raise AssertionError(
            f"enumerated action failed during replay: {action!r} ({outcome.reason})"
        )


def _chain_trace(previous: str, state_fingerprint: str) -> str:
    return (
        hashlib.sha256(f"{previous}\n{state_fingerprint}".encode("ascii"))
        .hexdigest()
        .upper()
    )


def _frontier_sha256(
    frontier: list[FrontierEntry], best_depth: dict[Any, int]
) -> tuple[str, int]:
    rows: list[dict[str, Any]] = []
    for entry in sorted(frontier):
        depth = len(entry.history)
        if best_depth.get(entry.snapshot) != depth:
            continue
        rows.append(
            {
                "priority": list(entry.priority),
                "tie_id": entry.tie_id,
                "history": [_json_action(action) for action in entry.history],
                "state_fingerprint": entry.state_fingerprint,
            }
        )
    return _canonical_sha256(rows), len(rows)


def _witness_payload(
    target: ReferenceTarget,
    twin: LifelineGame,
    twin_history: History,
) -> dict[str, Any]:
    reference = _replay_standard(target.grid_size, target.reference_history)
    reference_outcome = reference.evaluate_move(target.candidate_action)
    twin_outcome = twin.evaluate_move(target.candidate_action)
    return {
        "classification": "candidate_natural_same_topology_different_history_superko_legality",
        "reference_history": [
            _json_action(action) for action in target.reference_history
        ],
        "twin_history": [_json_action(action) for action in twin_history],
        "candidate_action": list(target.candidate_action),
        "target_topology": target.target_topology,
        "target_topology_sha256": target.target_topology_sha256,
        "reference_state_fingerprint": reference.state_fingerprint().upper(),
        "twin_state_fingerprint": twin.state_fingerprint().upper(),
        "reference_history_fingerprint": _history_fingerprint(reference),
        "twin_history_fingerprint": _history_fingerprint(twin),
        "reference_history_key_count": len(reference.history_hashes),
        "twin_history_key_count": len(twin.history_hashes),
        "forbidden_key_sha256": target.forbidden_key_sha256,
        "forbidden_key_in_reference_history": target.forbidden_key
        in reference.history_hashes,
        "forbidden_key_in_twin_history": target.forbidden_key in twin.history_hashes,
        "reference_outcome": asdict(reference_outcome),
        "twin_outcome": asdict(twin_outcome),
    }


def search_targeted_history_twin(
    *,
    fixture_path: Path = DEFAULT_FIXTURE_PATH,
    max_states: int = 25_000,
    max_depth: int = 20,
    max_seconds: float | None = 300.0,
    progress_every: int = 1_000,
) -> dict[str, Any]:
    if max_states <= 0:
        raise ValueError("max_states must be positive")
    if max_depth < 0:
        raise ValueError("max_depth must be non-negative")
    if max_seconds is not None and max_seconds <= 0:
        raise ValueError("max_seconds must be positive or None")
    if progress_every < 0:
        raise ValueError("progress_every must be non-negative")

    target = _load_reference(fixture_path)
    initial_core_sha256 = _sha256_file(CORE_PATH)
    initial_search_script_sha256 = _sha256_file(Path(__file__))
    initial = LifelineGame(
        target.grid_size,
        start_player=Player.BLACK,
        superko_mode="enforce",
    )
    initial_snapshot = initial.clone()
    initial_fingerprint = initial.state_fingerprint().upper()
    frontier: list[FrontierEntry] = [
        FrontierEntry(
            priority=_priority(initial, target, 0),
            tie_id=0,
            history=(),
            snapshot=initial_snapshot,
            state_fingerprint=initial_fingerprint,
        )
    ]
    best_depth: dict[Any, int] = {initial_snapshot: 0}
    next_tie_id = 1
    trace_sha256 = "0" * 64
    stats = SearchStats(peak_frontier=1)
    started = time.perf_counter()
    witness: dict[str, Any] | None = None
    termination_reason = "FRONTIER_EMPTY"

    while frontier and stats.states_examined < max_states:
        elapsed = time.perf_counter() - started
        if max_seconds is not None and elapsed >= max_seconds:
            termination_reason = "TIME_BUDGET"
            break
        entry = heapq.heappop(frontier)
        depth = len(entry.history)
        if best_depth.get(entry.snapshot) != depth:
            stats.stale_frontier_entries += 1
            continue

        game = LifelineGame(
            target.grid_size,
            start_player=Player.BLACK,
            superko_mode="enforce",
        )
        game.restore(entry.snapshot)
        observed_fingerprint = game.state_fingerprint().upper()
        if observed_fingerprint != entry.state_fingerprint:
            raise AssertionError("frontier snapshot fingerprint changed")
        stats.states_examined += 1
        stats.max_depth_reached = max(stats.max_depth_reached, depth)
        trace_sha256 = _chain_trace(trace_sha256, observed_fingerprint)

        topology = _topology_payload(game)
        if topology == target.target_topology:
            stats.topology_hits += 1
            if game.history_hashes != target.reference_history_hashes:
                stats.distinct_history_topology_hits += 1
                outcome = game.evaluate_move(target.candidate_action)
                if outcome.success:
                    stats.candidate_legal_hits += 1
                    witness = _witness_payload(target, game, entry.history)
                    termination_reason = "FOUND"
                    break

        actions = _ordered_actions(game)
        if game.game_over:
            stats.terminal_states += 1
            continue
        if depth >= max_depth:
            stats.depth_cutoff_count += 1
            stats.depth_cutoff_action_candidates += len(actions)
            continue

        for action in actions:
            successor = LifelineGame(
                target.grid_size,
                start_player=Player.BLACK,
                superko_mode="enforce",
            )
            successor.restore(entry.snapshot)
            _apply_action(successor, action)
            stats.transitions_examined += 1
            if target.forbidden_key in successor.history_hashes:
                stats.forbidden_key_prunes += 1
                continue
            successor_history = entry.history + (action,)
            successor_depth = len(successor_history)
            successor_snapshot = successor.clone()
            previous_depth = best_depth.get(successor_snapshot)
            if previous_depth is not None and previous_depth <= successor_depth:
                stats.dominated_successors += 1
                continue
            best_depth[successor_snapshot] = successor_depth
            fingerprint = successor.state_fingerprint().upper()
            heapq.heappush(
                frontier,
                FrontierEntry(
                    priority=_priority(successor, target, successor_depth),
                    tie_id=next_tie_id,
                    history=successor_history,
                    snapshot=successor_snapshot,
                    state_fingerprint=fingerprint,
                ),
            )
            next_tie_id += 1
        stats.peak_frontier = max(stats.peak_frontier, len(frontier))
        if progress_every and stats.states_examined % progress_every == 0:
            print(
                json.dumps(
                    {
                        "states_examined": stats.states_examined,
                        "transitions_examined": stats.transitions_examined,
                        "frontier": len(frontier),
                        "max_depth_reached": stats.max_depth_reached,
                        "topology_hits": stats.topology_hits,
                        "elapsed_seconds": round(time.perf_counter() - started, 3),
                    },
                    sort_keys=True,
                ),
                file=sys.stderr,
                flush=True,
            )
    else:
        if frontier and stats.states_examined >= max_states:
            termination_reason = "STATE_BUDGET"
        elif not frontier:
            termination_reason = "FRONTIER_EMPTY_WITHIN_BOUNDED_CONFIGURATION"

    stats.elapsed_seconds = time.perf_counter() - started
    if _sha256_file(fixture_path) != target.fixture_sha256:
        raise RuntimeError("fixture bytes changed during search")
    if _sha256_file(CORE_PATH) != initial_core_sha256:
        raise RuntimeError("Python engine bytes changed during search")
    if _sha256_file(Path(__file__)) != initial_search_script_sha256:
        raise RuntimeError("search script bytes changed during search")
    frontier_sha256, valid_frontier_entries = _frontier_sha256(frontier, best_depth)
    status = "FOUND_CANDIDATE" if witness is not None else "NOT_FOUND_WITHIN_BUDGET"
    return {
        "schema_version": 1,
        "artifact_kind": "targeted_history_twin_search_candidate",
        "evidence_tier": "candidate_only_bounded_cpu_search",
        "input_binding": {
            "fixture_path": fixture_path.relative_to(PROJECT_ROOT).as_posix(),
            "fixture_sha256": target.fixture_sha256,
            "expected_fixture_sha256": EXPECTED_FIXTURE_SHA256,
            "fixture_id": target.fixture["fixture_id"],
            "engine_core_path": CORE_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "engine_core_sha256": initial_core_sha256,
            "search_script_path": Path(__file__).relative_to(PROJECT_ROOT).as_posix(),
            "search_script_sha256": initial_search_script_sha256,
        },
        "search_config": {
            "strategy": "deterministic_target_prioritized_best_first",
            "priority_definition": PRIORITY_DEFINITION,
            "heuristic_admissible": False,
            "heuristic_used_for_pruning": False,
            "action_order": ACTION_ORDER,
            "standard_initial_state": True,
            "start_player": Player.BLACK.value,
            "superko_mode": "enforce",
            "voluntary_pass_included": True,
            "max_states": max_states,
            "max_depth_actions_including_pass": max_depth,
            "max_seconds": max_seconds,
            "progress_every": progress_every,
            "visited_identity": "LOSSLESS_GAME_SNAPSHOT_WITH_SHORTEST_DISCOVERED_ACTION_DEPTH_V1",
            "safe_prune": "FORBIDDEN_RESULT_KEY_ALREADY_IN_MONOTONIC_SUPERKO_HISTORY_V1",
        },
        "target": {
            "grid_size": target.grid_size,
            "candidate_action": list(target.candidate_action),
            "candidate_actor": target.fixture["candidate"]["actor"],
            "forbidden_key_sha256": target.forbidden_key_sha256,
            "target_topology": target.target_topology,
            "target_topology_sha256": target.target_topology_sha256,
            "reference_history": [
                _json_action(action) for action in target.reference_history
            ],
            "reference_state_fingerprint": target.reference_state_fingerprint,
            "reference_history_fingerprint": target.reference_history_fingerprint,
        },
        "result": {
            "status": status,
            "termination_reason": termination_reason,
            "stats": asdict(stats),
            "best_depth_state_count": len(best_depth),
            "frontier_entries_raw": len(frontier),
            "frontier_entries_valid": valid_frontier_entries,
            "frontier_sha256": frontier_sha256,
            "visited_trace_sha256": trace_sha256,
            "witness": witness,
        },
        "claim_boundary": {
            "found_candidate_is_verified_witness": False,
            "independent_replay_verification_required": True,
            "global_nonexistence_claimed": False,
            "search_space_exhausted_claimed": False,
            "shortest_path_claimed": False,
            "a_star_claimed": False,
            "negative_result_interpretation": (
                "No twin was found for this frozen target under the recorded strategy and "
                "budgets; this is not evidence that no natural twin exists."
            ),
        },
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "cpu_only": True,
            "network_used": False,
        },
    }


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _write_candidate_output(path: Path, payload: dict[str, Any]) -> None:
    resolved = path.resolve()
    forbidden_roots = (
        (PROJECT_ROOT / "state_aliasing").resolve(),
        (PROJECT_ROOT / "results" / "formal").resolve(),
    )
    if any(_is_relative_to(resolved, root) for root in forbidden_roots):
        raise ValueError(
            "candidate output may not be written into frozen/formal evidence roots"
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE_PATH)
    parser.add_argument("--max-states", type=int, default=25_000)
    parser.add_argument("--max-depth", type=int, default=20)
    parser.add_argument("--max-seconds", type=float, default=300.0)
    parser.add_argument(
        "--no-time-limit",
        action="store_true",
        help="disable the wall-clock stop and use only deterministic state/depth budgets",
    )
    parser.add_argument("--progress-every", type=int, default=1_000)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = search_targeted_history_twin(
        fixture_path=args.fixture,
        max_states=args.max_states,
        max_depth=args.max_depth,
        max_seconds=None if args.no_time_limit else args.max_seconds,
        progress_every=args.progress_every,
    )
    if args.output is not None:
        _write_candidate_output(args.output, payload)
    else:
        sys.stdout.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
