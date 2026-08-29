#!/usr/bin/env python3
"""Independently replay and audit a full Superko policy-matrix JSON artifact.

The verifier is intentionally read-only and does not import the matrix runner.
It recomputes transition legality, hashes, pairing, event counts, summaries,
and the frozen checkpoint identity from the persisted episode records.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402


EXPERIMENT = "superko-policy-matrix-v1"
PURPOSES = ("dry_run", "five_seed_extension")
FORMAL_SEEDS = (
    2_111_448_885,
    1_179_994_698,
    1_147_703_047,
    2_073_532_949,
    281_460_105,
)
FORMAL_SIZES = (6, 7)
FORMAL_POLICIES = (
    "random",
    "greedy",
    "minimax-2",
    "mcts",
    "frozen-rl",
    "cycle-seeking",
)
MODES = ("enforce", "observe")
ORIENTATIONS = (
    ("focal_black", Player.BLACK),
    ("focal_white", Player.WHITE),
)
OUTCOMES = (Player.BLACK.value, Player.WHITE.value, "DRAW", "TRUNCATED")

EXPECTED_CHECKPOINT_SHA256 = (
    "24fc1e93b74b64e2fdcd79f126f14377916557ac4e1b770b57662a1fe77dc423"
)
EXPECTED_CHECKPOINT_SOURCE_HASH = (
    "90fffac7a50fdcf25b5d2fcd2bcb8e109d176fa261ef6766715f87e2b95124df"
)
EXPECTED_CHECKPOINT_CONFIG_HASH = (
    "4941d9d2c45615592672dacfa7624f2095d045dc74f48a7df6b8eb464bf253fd"
)
EXPECTED_WITNESS_SHA256 = (
    "a2916486d2a9c4738b1b8a01f72a91a689f968e20d1b6673b5e4f05a15927155"
)
WITNESS_PATH = ROOT / "state_aliasing" / "superko_n6_witness_v1.json"


class VerificationError(ValueError):
    """Raised when a persisted policy-matrix invariant does not hold."""


def _fail(path: str, message: str) -> None:
    raise VerificationError(f"{path}: {message}")


def _object(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(path, "expected an object")
    return value


def _array(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(path, "expected an array")
    return value


def _integer(value: Any, path: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(path, "expected an integer")
    if minimum is not None and value < minimum:
        _fail(path, f"expected an integer >= {minimum}")
    return value


def _number(value: Any, path: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "expected a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(path, "expected a finite number")
    if minimum is not None and result < minimum:
        _fail(path, f"expected a number >= {minimum}")
    return result


def _boolean(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        _fail(path, "expected a boolean")
    return value


def _string(value: Any, path: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        _fail(path, "expected a non-empty string" if nonempty else "expected a string")
    return value


def _require(obj: Mapping[str, Any], names: Iterable[str], path: str) -> None:
    missing = [name for name in names if name not in obj]
    if missing:
        _fail(path, f"missing fields: {', '.join(missing)}")


def _expect_equal(actual: Any, expected: Any, path: str) -> None:
    if actual != expected:
        _fail(path, f"expected {expected!r}, got {actual!r}")


def _expect_close(actual: Any, expected: float, path: str) -> None:
    observed = _number(actual, path)
    if not math.isclose(observed, float(expected), rel_tol=1e-12, abs_tol=1e-12):
        _fail(path, f"expected {expected!r}, got {actual!r}")


def _expect_value(actual: Any, expected: Any, path: str) -> None:
    """Compare a recomputed JSON subtree while allowing unrelated extra keys."""

    if isinstance(expected, Mapping):
        obj = _object(actual, path)
        _require(obj, expected, path)
        for key, value in expected.items():
            _expect_value(obj[key], value, f"{path}.{key}")
    elif isinstance(expected, list):
        values = _array(actual, path)
        if len(values) != len(expected):
            _fail(path, f"expected {len(expected)} entries, got {len(values)}")
        for index, value in enumerate(expected):
            _expect_value(values[index], value, f"{path}[{index}]")
    elif isinstance(expected, float):
        _expect_close(actual, expected, path)
    else:
        _expect_equal(actual, expected, path)


def _assert_json_finite(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail(path, "non-finite JSON number")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_json_finite(item, f"{path}[{index}]")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(path, "JSON object contains a non-string key")
            _assert_json_finite(item, f"{path}.{key}")
        return
    _fail(path, f"unsupported JSON value type {type(value).__name__}")


def _reject_constant(token: str) -> None:
    raise VerificationError(f"invalid non-finite JSON constant: {token}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def load_report(path: Path) -> dict[str, Any]:
    """Read one strict JSON object without accepting NaN or duplicate keys."""

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise VerificationError(f"cannot read report: {path}") from exc
    try:
        raw = json.loads(
            text,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise VerificationError(f"invalid JSON report: {path}") from exc
    if not isinstance(raw, dict):
        raise VerificationError("the report root must be an object")
    return raw


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _valid_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower())
    )


def _derive_seed(*parts: object) -> int:
    payload = "|".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def _frozen_seed(index: int) -> int:
    payload = f"{EXPERIMENT}|{index}".encode("ascii")
    return int.from_bytes(hashlib.sha256(payload).digest()[:4], "big") & 0x7FFFFFFF


def _position_projection(game: LifelineGame) -> tuple[object, ...]:
    snapshot = game.clone()
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def _position_sha256(game: LifelineGame) -> str:
    return hashlib.sha256(repr(_position_projection(game)).encode("utf-8")).hexdigest()


def _full_state_sha256(game: LifelineGame) -> str:
    return hashlib.sha256(game.canonical_state_json().encode("utf-8")).hexdigest()


def _mode_normalized_state_sha256(game: LifelineGame) -> str:
    snapshot = game.clone()
    normalized = (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
        snapshot.turn_count,
        tuple(sorted(snapshot.history_hashes, key=repr)),
        snapshot.start_player,
    )
    return hashlib.sha256(repr(normalized).encode("utf-8")).hexdigest()


def _action_trace_sha256(actions: Sequence[Mapping[str, Any]]) -> str:
    payload = [[entry["actor"], entry["action"]] for entry in actions]
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":")).encode("ascii")
    ).hexdigest()


def _focal_score(winner: str | None, truncated: bool, focal: Player) -> float | None:
    if truncated:
        return None
    if winner == "DRAW":
        return 0.5
    if winner == focal.value:
        return 1.0
    if winner == LifelineGame.opponent(focal).value:
        return 0.0
    raise VerificationError(f"unexpected terminal winner {winner!r}")


def _verify_game(
    record: Any,
    *,
    path: str,
    policy: str,
    grid_size: int,
    master_seed: int,
    block_index: int,
    block_seed: int,
    orientation: str,
    focal_color: Player,
    mode: str,
    max_plies: int,
) -> Mapping[str, Any]:
    game_record = _object(record, path)
    required = (
        "mode",
        "grid_size",
        "policy",
        "master_seed",
        "block_index",
        "block_seed",
        "orientation",
        "focal_color",
        "focal_agent",
        "anchor_agent",
        "max_plies",
        "plies",
        "truncated",
        "winner",
        "focal_score",
        "trigger_states",
        "repeat_candidates_total",
        "selected_repetitions",
        "triggered",
        "selected_repetition",
        "decision_seconds",
        "duration_seconds",
        "action_trace_sha256",
        "final_position_sha256",
        "final_full_state_sha256",
        "final_mode_normalized_state_sha256",
        "actions",
    )
    _require(game_record, required, path)
    expected_identity = {
        "mode": mode,
        "grid_size": grid_size,
        "policy": policy,
        "master_seed": master_seed,
        "block_index": block_index,
        "block_seed": block_seed,
        "orientation": orientation,
        "focal_color": focal_color.value,
        "max_plies": max_plies,
    }
    _expect_value(game_record, expected_identity, path)
    focal_agent = _string(game_record["focal_agent"], f"{path}.focal_agent", nonempty=True)
    anchor_agent = _string(game_record["anchor_agent"], f"{path}.anchor_agent", nonempty=True)
    actions = _array(game_record["actions"], f"{path}.actions")
    if len(actions) > max_plies:
        _fail(f"{path}.actions", "trace exceeds max_plies")

    game = LifelineGame(grid_size, superko_mode=mode)
    trigger_states = 0
    repeat_candidates_total = 0
    selected_repetitions = 0
    decision_seconds = {"focal": 0.0, "anchor": 0.0}
    checked_actions: list[Mapping[str, Any]] = []

    for ply, raw_entry in enumerate(actions):
        entry_path = f"{path}.actions[{ply}]"
        entry = _object(raw_entry, entry_path)
        _require(
            entry,
            (
                "ply",
                "actor",
                "slot",
                "agent",
                "decision_seed",
                "position_before_sha256",
                "full_state_before_sha256",
                "mode_normalized_state_before_sha256",
                "legal_actions",
                "action",
                "point",
                "would_violate_superko_candidates",
                "selected_would_violate_superko",
                "result_success",
                "result_reason",
                "result_would_violate_superko",
                "decision_seconds",
                "diagnostics",
                "position_after_sha256",
                "full_state_after_sha256",
                "mode_normalized_state_after_sha256",
            ),
            entry_path,
        )
        if game.game_over:
            _fail(entry_path, "trace continues after a terminal state")
        _expect_equal(entry["ply"], ply, f"{entry_path}.ply")
        actor = game.current_player
        _expect_equal(entry["actor"], actor.value, f"{entry_path}.actor")
        slot = "focal" if actor == focal_color else "anchor"
        _expect_equal(entry["slot"], slot, f"{entry_path}.slot")
        expected_agent = focal_agent if slot == "focal" else anchor_agent
        _expect_equal(entry["agent"], expected_agent, f"{entry_path}.agent")
        _expect_equal(
            entry["position_before_sha256"],
            _position_sha256(game),
            f"{entry_path}.position_before_sha256",
        )
        _expect_equal(
            entry["full_state_before_sha256"],
            _full_state_sha256(game),
            f"{entry_path}.full_state_before_sha256",
        )
        _expect_equal(
            entry["mode_normalized_state_before_sha256"],
            _mode_normalized_state_sha256(game),
            f"{entry_path}.mode_normalized_state_before_sha256",
        )

        legal_indices = [game.point_to_index[point] for point in game.legal_moves()]
        legal_indices.append(game.num_points)
        _expect_equal(entry["legal_actions"], legal_indices, f"{entry_path}.legal_actions")
        repeat_indices = [
            game.point_to_index[point] for point in game.would_violate_superko_moves()
        ]
        _expect_equal(
            entry["would_violate_superko_candidates"],
            repeat_indices,
            f"{entry_path}.would_violate_superko_candidates",
        )
        if repeat_indices:
            trigger_states += 1
            repeat_candidates_total += len(repeat_indices)

        action_index = _integer(entry["action"], f"{entry_path}.action", minimum=0)
        if action_index > game.num_points:
            _fail(f"{entry_path}.action", "action index exceeds PASS index")
        if action_index not in legal_indices:
            _fail(f"{entry_path}.action", "recorded action is illegal in replayed state")
        action = None if action_index == game.num_points else game.valid_positions[action_index]
        expected_point = None if action is None else [action[0], action[1]]
        _expect_equal(entry["point"], expected_point, f"{entry_path}.point")

        selected_repeat = action_index != game.num_points and action_index in repeat_indices
        _expect_equal(
            entry["selected_would_violate_superko"],
            selected_repeat,
            f"{entry_path}.selected_would_violate_superko",
        )
        selected_repetitions += int(selected_repeat)
        expected_seed = _derive_seed(
            EXPERIMENT,
            master_seed,
            block_index,
            grid_size,
            policy,
            orientation,
            slot,
            actor.value,
            ply,
        )
        _expect_equal(entry["decision_seed"], expected_seed, f"{entry_path}.decision_seed")
        elapsed = _number(
            entry["decision_seconds"], f"{entry_path}.decision_seconds", minimum=0.0
        )
        decision_seconds[slot] += elapsed
        _object(entry["diagnostics"], f"{entry_path}.diagnostics")

        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            _fail(entry_path, f"replayed transition failed: {result.reason}")
        _expect_equal(entry["result_success"], True, f"{entry_path}.result_success")
        _expect_equal(entry["result_reason"], None, f"{entry_path}.result_reason")
        _expect_equal(
            entry["result_would_violate_superko"],
            bool(result.would_violate_superko),
            f"{entry_path}.result_would_violate_superko",
        )
        if bool(result.would_violate_superko) != selected_repeat:
            _fail(entry_path, "candidate, selection, and transition Superko flags disagree")
        _expect_equal(
            entry["position_after_sha256"],
            _position_sha256(game),
            f"{entry_path}.position_after_sha256",
        )
        _expect_equal(
            entry["full_state_after_sha256"],
            _full_state_sha256(game),
            f"{entry_path}.full_state_after_sha256",
        )
        _expect_equal(
            entry["mode_normalized_state_after_sha256"],
            _mode_normalized_state_sha256(game),
            f"{entry_path}.mode_normalized_state_after_sha256",
        )
        checked_actions.append(entry)

    plies = len(actions)
    _expect_equal(game_record["plies"], plies, f"{path}.plies")
    truncated = not game.game_over
    if truncated and plies != max_plies:
        _fail(path, "nonterminal game ended before max_plies")
    _expect_equal(game_record["truncated"], truncated, f"{path}.truncated")
    winner_obj = game.winner() if game.game_over else None
    winner = winner_obj.value if isinstance(winner_obj, Player) else winner_obj
    _expect_equal(game_record["winner"], winner, f"{path}.winner")
    expected_score = _focal_score(winner, truncated, focal_color)
    if expected_score is None:
        _expect_equal(game_record["focal_score"], None, f"{path}.focal_score")
    else:
        _expect_close(game_record["focal_score"], expected_score, f"{path}.focal_score")

    _expect_equal(game_record["trigger_states"], trigger_states, f"{path}.trigger_states")
    _expect_equal(
        game_record["repeat_candidates_total"],
        repeat_candidates_total,
        f"{path}.repeat_candidates_total",
    )
    _expect_equal(
        game_record["selected_repetitions"],
        selected_repetitions,
        f"{path}.selected_repetitions",
    )
    _expect_equal(game_record["triggered"], trigger_states > 0, f"{path}.triggered")
    _expect_equal(
        game_record["selected_repetition"],
        selected_repetitions > 0,
        f"{path}.selected_repetition",
    )
    durations = _object(game_record["decision_seconds"], f"{path}.decision_seconds")
    _require(durations, ("focal", "anchor"), f"{path}.decision_seconds")
    for slot in ("focal", "anchor"):
        _expect_close(
            durations[slot], decision_seconds[slot], f"{path}.decision_seconds.{slot}"
        )
    _number(game_record["duration_seconds"], f"{path}.duration_seconds", minimum=0.0)
    _expect_equal(
        game_record["action_trace_sha256"],
        _action_trace_sha256(checked_actions),
        f"{path}.action_trace_sha256",
    )
    _expect_equal(
        game_record["final_position_sha256"],
        _position_sha256(game),
        f"{path}.final_position_sha256",
    )
    _expect_equal(
        game_record["final_full_state_sha256"],
        _full_state_sha256(game),
        f"{path}.final_full_state_sha256",
    )
    _expect_equal(
        game_record["final_mode_normalized_state_sha256"],
        _mode_normalized_state_sha256(game),
        f"{path}.final_mode_normalized_state_sha256",
    )
    return game_record


def _comparison(enforce: Mapping[str, Any], observe: Mapping[str, Any]) -> dict[str, Any]:
    first_action_divergence: int | None = None
    first_position_divergence: int | None = None
    first_complete_state_divergence: int | None = None
    aligned_trigger_plies: list[int] = []
    still_paired = True
    left_actions = enforce["actions"]
    right_actions = observe["actions"]
    shared = min(len(left_actions), len(right_actions))
    for ply in range(shared):
        left = left_actions[ply]
        right = right_actions[ply]
        if (
            still_paired
            and left["mode_normalized_state_before_sha256"]
            == right["mode_normalized_state_before_sha256"]
            and left["would_violate_superko_candidates"]
            and left["would_violate_superko_candidates"]
            == right["would_violate_superko_candidates"]
        ):
            aligned_trigger_plies.append(ply)
        if first_action_divergence is None and (
            left["actor"] != right["actor"] or left["action"] != right["action"]
        ):
            first_action_divergence = ply
        if (
            first_position_divergence is None
            and left["position_after_sha256"] != right["position_after_sha256"]
        ):
            first_position_divergence = ply
        if (
            first_complete_state_divergence is None
            and left["mode_normalized_state_after_sha256"]
            != right["mode_normalized_state_after_sha256"]
        ):
            first_complete_state_divergence = ply
        if (
            left["actor"] != right["actor"]
            or left["action"] != right["action"]
            or left["mode_normalized_state_after_sha256"]
            != right["mode_normalized_state_after_sha256"]
        ):
            still_paired = False
    if len(left_actions) != len(right_actions):
        if first_action_divergence is None:
            first_action_divergence = shared
        if first_position_divergence is None:
            first_position_divergence = shared
        if first_complete_state_divergence is None:
            first_complete_state_divergence = shared
    outcome_enforce = "TRUNCATED" if enforce["truncated"] else enforce["winner"]
    outcome_observe = "TRUNCATED" if observe["truncated"] else observe["winner"]
    score_difference = None
    if enforce["focal_score"] is not None and observe["focal_score"] is not None:
        score_difference = observe["focal_score"] - enforce["focal_score"]
    return {
        "trajectory_diverged": (
            first_action_divergence is not None
            or first_position_divergence is not None
            or first_complete_state_divergence is not None
        ),
        "first_action_divergence_ply": first_action_divergence,
        "first_position_divergence_after_ply": first_position_divergence,
        "first_complete_state_divergence_after_ply": first_complete_state_divergence,
        "aligned_trigger_plies": aligned_trigger_plies,
        "first_aligned_trigger_ply": aligned_trigger_plies[0] if aligned_trigger_plies else None,
        "divergence_begins_at_aligned_trigger": bool(
            aligned_trigger_plies
            and (
                first_action_divergence == aligned_trigger_plies[0]
                or first_position_divergence == aligned_trigger_plies[0]
                or first_complete_state_divergence == aligned_trigger_plies[0]
            )
        ),
        "outcome_enforce": outcome_enforce,
        "outcome_observe": outcome_observe,
        "outcome_agrees": outcome_enforce == outcome_observe,
        "enforce_plies": enforce["plies"],
        "observe_plies": observe["plies"],
        "focal_score_observe_minus_enforce": score_difference,
        "plies_observe_minus_enforce": observe["plies"] - enforce["plies"],
        "truncation_observe_minus_enforce": (
            float(observe["truncated"]) - float(enforce["truncated"])
        ),
    }


def _verify_block(
    raw: Any,
    *,
    path: str,
    policy: str,
    grid_size: int,
    master_seed: int,
    block_index: int,
    max_plies: int,
) -> Mapping[str, Any]:
    block = _object(raw, path)
    _require(block, ("master_seed", "block_index", "block_seed", "orientations", "summary"), path)
    block_seed = _derive_seed(
        EXPERIMENT, master_seed, grid_size, policy, block_index, "block"
    )
    _expect_value(
        block,
        {
            "master_seed": master_seed,
            "block_index": block_index,
            "block_seed": block_seed,
        },
        path,
    )
    orientations = _array(block["orientations"], f"{path}.orientations")
    if len(orientations) != 2:
        _fail(f"{path}.orientations", "each block must contain exactly two orientations")

    verified: list[Mapping[str, Any]] = []
    for index, (orientation_name, focal_color) in enumerate(ORIENTATIONS):
        orientation_path = f"{path}.orientations[{index}]"
        orientation = _object(orientations[index], orientation_path)
        _require(
            orientation,
            ("orientation", "focal_color", "enforce", "observe", "comparison"),
            orientation_path,
        )
        _expect_equal(
            orientation["orientation"], orientation_name, f"{orientation_path}.orientation"
        )
        _expect_equal(
            orientation["focal_color"], focal_color.value, f"{orientation_path}.focal_color"
        )
        games: dict[str, Mapping[str, Any]] = {}
        for mode in MODES:
            games[mode] = _verify_game(
                orientation[mode],
                path=f"{orientation_path}.{mode}",
                policy=policy,
                grid_size=grid_size,
                master_seed=master_seed,
                block_index=block_index,
                block_seed=block_seed,
                orientation=orientation_name,
                focal_color=focal_color,
                mode=mode,
                max_plies=max_plies,
            )
        if games["enforce"]["focal_agent"] != games["observe"]["focal_agent"]:
            _fail(orientation_path, "paired modes use different focal agents")
        if games["enforce"]["anchor_agent"] != games["observe"]["anchor_agent"]:
            _fail(orientation_path, "paired modes use different anchor agents")
        shared = min(len(games["enforce"]["actions"]), len(games["observe"]["actions"]))
        for ply in range(shared):
            left = games["enforce"]["actions"][ply]
            right = games["observe"]["actions"][ply]
            if left["actor"] == right["actor"] and left["slot"] == right["slot"]:
                _expect_equal(
                    left["decision_seed"],
                    right["decision_seed"],
                    f"{orientation_path}.paired_decision_seed[{ply}]",
                )
        expected_comparison = _comparison(games["enforce"], games["observe"])
        _expect_value(
            orientation["comparison"], expected_comparison, f"{orientation_path}.comparison"
        )
        verified.append(orientation)

    focal_scores: dict[str, float | None] = {}
    mean_plies: dict[str, float] = {}
    truncation_rate: dict[str, float] = {}
    for mode in MODES:
        scores = [orientation[mode]["focal_score"] for orientation in verified]
        focal_scores[mode] = (
            statistics.fmean(scores) if all(score is not None for score in scores) else None
        )
        mean_plies[mode] = statistics.fmean(
            orientation[mode]["plies"] for orientation in verified
        )
        truncation_rate[mode] = statistics.fmean(
            float(orientation[mode]["truncated"]) for orientation in verified
        )
    expected_summary = {
        "focal_score": focal_scores,
        "focal_score_observe_minus_enforce": (
            None
            if focal_scores["enforce"] is None or focal_scores["observe"] is None
            else focal_scores["observe"] - focal_scores["enforce"]
        ),
        "mean_plies": mean_plies,
        "mean_plies_observe_minus_enforce": mean_plies["observe"] - mean_plies["enforce"],
        "truncation_rate": truncation_rate,
        "truncation_rate_observe_minus_enforce": (
            truncation_rate["observe"] - truncation_rate["enforce"]
        ),
        "any_trigger": any(
            orientation[mode]["triggered"]
            for orientation in verified
            for mode in MODES
        ),
        "observe_selected_repetition": any(
            orientation["observe"]["selected_repetition"] for orientation in verified
        ),
        "any_trajectory_divergence": any(
            orientation["comparison"]["trajectory_diverged"] for orientation in verified
        ),
    }
    _expect_value(block["summary"], expected_summary, f"{path}.summary")
    return block


def _wilson(successes: int, trials: int) -> list[float] | None:
    if trials == 0:
        return None
    z = 1.959963984540054
    proportion = successes / trials
    z2 = z * z
    denominator = 1.0 + z2 / trials
    center = (proportion + z2 / (2.0 * trials)) / denominator
    margin = z * math.sqrt(
        proportion * (1.0 - proportion) / trials + z2 / (4.0 * trials * trials)
    ) / denominator
    return [
        0.0 if successes == 0 else max(0.0, center - margin),
        1.0 if successes == trials else min(1.0, center + margin),
    ]


def _rate(successes: int, trials: int) -> dict[str, Any]:
    return {
        "successes": successes,
        "trials": trials,
        "rate": successes / trials if trials else None,
        "ci95_wilson": _wilson(successes, trials),
    }


def _percentile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    location = probability * (len(ordered) - 1)
    lower = math.floor(location)
    upper = math.ceil(location)
    fraction = location - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _bootstrap_mean(values: Sequence[float], *, seed: int, resamples: int) -> dict[str, Any]:
    if not values:
        return {"blocks": 0, "mean": None, "resamples": resamples, "ci95": None}
    rng = random.Random(seed)
    count = len(values)
    draws = [
        statistics.fmean(values[rng.randrange(count)] for _ in range(count))
        for _ in range(resamples)
    ]
    return {
        "blocks": count,
        "mean": statistics.fmean(values),
        "resamples": resamples,
        "ci95": [_percentile(draws, 0.025), _percentile(draws, 0.975)],
    }


def _hierarchical_pair_bootstrap(
    blocks: Sequence[Mapping[str, Any]],
    *,
    field: str,
    seed: int,
    resamples: int,
) -> dict[str, Any]:
    by_block = [
        [
            orientation["comparison"][field]
            for orientation in block["orientations"]
            if orientation["comparison"][field] is not None
        ]
        for block in blocks
    ]
    observed = [value for values in by_block for value in values]
    if not observed:
        return {
            "seed_blocks": len(blocks),
            "retained_orientation_pairs": 0,
            "mean": None,
            "resamples_requested": resamples,
            "resamples_valid": 0,
            "ci95": None,
        }
    rng = random.Random(seed)
    sampled_means: list[float] = []
    for _ in range(resamples):
        sampled: list[float] = []
        for _ in blocks:
            values = by_block[rng.randrange(len(by_block))]
            if values:
                sampled.extend(values[rng.randrange(len(values))] for _ in values)
        if sampled:
            sampled_means.append(statistics.fmean(sampled))
    return {
        "seed_blocks": len(blocks),
        "retained_orientation_pairs": len(observed),
        "mean": statistics.fmean(observed),
        "resamples_requested": resamples,
        "resamples_valid": len(sampled_means),
        "ci95": (
            [_percentile(sampled_means, 0.025), _percentile(sampled_means, 0.975)]
            if sampled_means
            else None
        ),
    }


def _hierarchical_relative_plies_bootstrap(
    blocks: Sequence[Mapping[str, Any]], *, seed: int, resamples: int
) -> dict[str, Any]:
    by_block = [
        [
            (
                float(orientation["comparison"]["enforce_plies"]),
                float(orientation["comparison"]["observe_plies"]),
            )
            for orientation in block["orientations"]
        ]
        for block in blocks
    ]
    observed = [pair for values in by_block for pair in values]

    def effect(pairs: Sequence[tuple[float, float]]) -> float:
        enforce_mean = statistics.fmean(pair[0] for pair in pairs)
        observe_mean = statistics.fmean(pair[1] for pair in pairs)
        return (observe_mean - enforce_mean) / enforce_mean

    rng = random.Random(seed)
    sampled_effects: list[float] = []
    for _ in range(resamples):
        sampled: list[tuple[float, float]] = []
        for _ in blocks:
            values = by_block[rng.randrange(len(by_block))]
            sampled.extend(values[rng.randrange(len(values))] for _ in values)
        sampled_effects.append(effect(sampled))
    return {
        "seed_blocks": len(blocks),
        "orientation_pairs": len(observed),
        "effect": effect(observed),
        "definition": "(mean(observe plies)-mean(enforce plies))/mean(enforce plies)",
        "resamples": resamples,
        "ci95": [
            _percentile(sampled_effects, 0.025),
            _percentile(sampled_effects, 0.975),
        ],
    }


def _score_bounds(blocks: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    lower: list[float] = []
    upper: list[float] = []
    for block in blocks:
        enforce_low = enforce_high = observe_low = observe_high = 0.0
        for orientation in block["orientations"]:
            enforce_score = orientation["enforce"]["focal_score"]
            observe_score = orientation["observe"]["focal_score"]
            enforce_low += 0.0 if enforce_score is None else enforce_score
            enforce_high += 1.0 if enforce_score is None else enforce_score
            observe_low += 0.0 if observe_score is None else observe_score
            observe_high += 1.0 if observe_score is None else observe_score
        lower.append(observe_low / 2.0 - enforce_high / 2.0)
        upper.append(observe_high / 2.0 - enforce_low / 2.0)
    return {
        "blocks": len(blocks),
        "identified_sample_mean_interval": [
            statistics.fmean(lower),
            statistics.fmean(upper),
        ],
        "definition": "truncated focal scores range independently over [0,1]",
        "sampling_uncertainty_included": False,
    }


def _verify_condition_summary(
    raw_summary: Any,
    *,
    path: str,
    blocks: Sequence[Mapping[str, Any]],
    policy: str,
    grid_size: int,
    bootstrap_resamples: int,
) -> None:
    summary = _object(raw_summary, path)
    _expect_value(
        summary,
        {
            "policy": policy,
            "grid_size": grid_size,
            "independent_blocks": len(blocks),
            "master_seeds": sorted({block["master_seed"] for block in blocks}),
        },
        path,
    )
    games = {
        mode: [
            orientation[mode]
            for block in blocks
            for orientation in block["orientations"]
        ]
        for mode in MODES
    }
    comparisons = [
        orientation["comparison"]
        for block in blocks
        for orientation in block["orientations"]
    ]

    mode_summary = _object(summary.get("mode"), f"{path}.mode")
    for mode in MODES:
        records = games[mode]
        focal_diagnostics = [
            action["diagnostics"]
            for record in records
            for action in record["actions"]
            if action["slot"] == "focal"
        ]
        completed_scores = [
            record["focal_score"] for record in records if record["focal_score"] is not None
        ]
        outcomes = {outcome: 0 for outcome in OUTCOMES}
        for record in records:
            outcome = "TRUNCATED" if record["truncated"] else record["winner"]
            outcomes[outcome] += 1
        expected = {
            "games": len(records),
            "completed_games": len(completed_scores),
            "outcomes": outcomes,
            "focal_outcomes_completed": {
                "wins": sum(score == 1.0 for score in completed_scores),
                "draws": sum(score == 0.5 for score in completed_scores),
                "losses": sum(score == 0.0 for score in completed_scores),
            },
            "truncation_rate": _rate(sum(record["truncated"] for record in records), len(records)),
            "trigger_game_rate": _rate(sum(record["triggered"] for record in records), len(records)),
            "selected_repetition_game_rate": _rate(
                sum(record["selected_repetition"] for record in records), len(records)
            ),
            "trigger_states": sum(record["trigger_states"] for record in records),
            "selected_repetitions": sum(record["selected_repetitions"] for record in records),
            "mean_plies": statistics.fmean(record["plies"] for record in records),
            "median_plies": statistics.median(record["plies"] for record in records),
            "mean_focal_score_completed_only": (
                statistics.fmean(completed_scores) if completed_scores else None
            ),
            "total_duration_seconds": sum(record["duration_seconds"] for record in records),
            "mean_focal_decision_seconds_per_game": statistics.fmean(
                record["decision_seconds"]["focal"] for record in records
            ),
            "counterfactual_cycle_plans": sum(
                bool(diagnostic.get("counterfactual_cycle_plan_found"))
                for diagnostic in focal_diagnostics
            ),
            "cycle_search_fallbacks": sum(
                str(diagnostic.get("reason", "")).startswith("fallback_")
                for diagnostic in focal_diagnostics
            ),
        }
        _expect_value(mode_summary.get(mode), expected, f"{path}.mode.{mode}")

    contingency = {left: {right: 0 for right in OUTCOMES} for left in OUTCOMES}
    for comparison in comparisons:
        contingency[comparison["outcome_enforce"]][comparison["outcome_observe"]] += 1
    complete_pairs = [
        comparison
        for comparison in comparisons
        if comparison["outcome_enforce"] != "TRUNCATED"
        and comparison["outcome_observe"] != "TRUNCATED"
    ]
    score_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="focal_score_observe_minus_enforce",
        seed=_derive_seed(EXPERIMENT, policy, grid_size, "score-bootstrap"),
        resamples=bootstrap_resamples,
    )
    plies_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="plies_observe_minus_enforce",
        seed=_derive_seed(EXPERIMENT, policy, grid_size, "plies-bootstrap"),
        resamples=bootstrap_resamples,
    )
    relative_plies_bootstrap = _hierarchical_relative_plies_bootstrap(
        blocks,
        seed=_derive_seed(EXPERIMENT, policy, grid_size, "relative-plies-bootstrap"),
        resamples=bootstrap_resamples,
    )
    truncation_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="truncation_observe_minus_enforce",
        seed=_derive_seed(EXPERIMENT, policy, grid_size, "truncation-bootstrap"),
        resamples=bootstrap_resamples,
    )
    score_ci = score_bootstrap["ci95"]
    relative_plies_ci = relative_plies_bootstrap["ci95"]
    truncation_ci = truncation_bootstrap["ci95"]
    observe_truncation_upper = _wilson(
        sum(record["truncated"] for record in games["observe"]),
        len(games["observe"]),
    )[1]
    gates = {
        "score_ci_inside_plus_minus_0_05": bool(
            score_ci is not None and score_ci[0] >= -0.05 and score_ci[1] <= 0.05
        ),
        "relative_plies_ci_inside_plus_minus_0_05": bool(
            relative_plies_ci is not None
            and relative_plies_ci[0] >= -0.05
            and relative_plies_ci[1] <= 0.05
        ),
        "truncation_difference_ci_inside_plus_minus_0_01": bool(
            truncation_ci is not None
            and truncation_ci[0] >= -0.01
            and truncation_ci[1] <= 0.01
        ),
        "observe_truncation_wilson_upper_below_0_01": (
            observe_truncation_upper < 0.01
        ),
    }
    gates["all_pass"] = all(gates.values())
    expected_paired = {
        "orientation_pairs": len(comparisons),
        "trajectory_divergence_rate": _rate(
            sum(comparison["trajectory_diverged"] for comparison in comparisons),
            len(comparisons),
        ),
        "aligned_trigger_orientation_rate": _rate(
            sum(bool(comparison["aligned_trigger_plies"]) for comparison in comparisons),
            len(comparisons),
        ),
        "aligned_trigger_plies": sum(
            len(comparison["aligned_trigger_plies"]) for comparison in comparisons
        ),
        "divergence_at_aligned_trigger_rate": _rate(
            sum(
                comparison["divergence_begins_at_aligned_trigger"]
                for comparison in comparisons
            ),
            len(comparisons),
        ),
        "winner_agreement_complete_pairs": _rate(
            sum(comparison["outcome_agrees"] for comparison in complete_pairs),
            len(complete_pairs),
        ),
        "retained_complete_pair_rate": _rate(len(complete_pairs), len(comparisons)),
        "nonzero_focal_score_difference_rate_complete_pairs": _rate(
            sum(
                comparison["focal_score_observe_minus_enforce"] != 0.0
                for comparison in complete_pairs
            ),
            len(complete_pairs),
        ),
        "outcome_contingency": contingency,
        "trigger_block_rate": _rate(
            sum(block["summary"]["any_trigger"] for block in blocks), len(blocks)
        ),
        "observe_selected_repetition_block_rate": _rate(
            sum(block["summary"]["observe_selected_repetition"] for block in blocks),
            len(blocks),
        ),
        "score_observe_minus_enforce_complete_pairs": score_bootstrap,
        "score_observe_minus_enforce_all_block_bounds": _score_bounds(blocks),
        "mean_plies_observe_minus_enforce": plies_bootstrap,
        "relative_mean_plies_observe_minus_enforce": relative_plies_bootstrap,
        "truncation_rate_observe_minus_enforce": truncation_bootstrap,
        "practical_similarity_gates": gates,
    }
    _expect_value(summary.get("paired"), expected_paired, f"{path}.paired")
    _expect_value(
        summary.get("per_seed"),
        [
            {
                "master_seed": block["master_seed"],
                "block_index": block["block_index"],
                **block["summary"],
            }
            for block in blocks
        ],
        f"{path}.per_seed",
    )


def _resolve_manifest(checkpoint: Path) -> Path:
    resolved = checkpoint.expanduser().resolve()
    if resolved.is_dir() and (resolved / "latest.json").is_file():
        return resolved / "latest.json"
    if resolved.is_dir() and (resolved / "checkpoints" / "latest.json").is_file():
        return resolved / "checkpoints" / "latest.json"
    if resolved.name == "latest.json" and resolved.is_file():
        return resolved
    candidate = resolved.parent / "latest.json"
    if resolved.is_file() and candidate.is_file():
        return candidate
    raise VerificationError(f"checkpoint latest.json is unavailable for {checkpoint}")


def _verify_checkpoint_identity(raw: Any, *, verify_files: bool) -> int:
    path = "$.config.frozen_rl"
    frozen = _object(raw, path)
    _require(
        frozen,
        ("requested", "checkpoint", "simulations", "c_puct", "temperature", "root_noise", "metadata"),
        path,
    )
    requested = _boolean(frozen["requested"], f"{path}.requested")
    if not requested:
        _expect_equal(frozen["metadata"], None, f"{path}.metadata")
        return 0

    metadata = _object(frozen["metadata"], f"{path}.metadata")
    _require(
        metadata,
        (
            "checkpoint",
            "classification",
            "model_kind",
            "observation_mode",
            "trained_board_sizes",
            "train_superko_mode",
            "eval_superko_modes",
            "source_migration_waiver",
            "rule_mode_override",
            "saved_source_hash_matches_current",
            "current_source_hash",
            "search",
        ),
        f"{path}.metadata",
    )
    _expect_value(
        metadata,
        {
            "classification": "engineering_smoke_checkpoint_not_paper_baseline",
            "model_kind": "topology_gnn",
            "observation_mode": "topology",
            "trained_board_sizes": [5],
            "train_superko_mode": "enforce",
            "eval_superko_modes": ["enforce", "observe"],
            "source_migration_waiver": True,
            "rule_mode_override": True,
        },
        f"{path}.metadata",
    )
    _expect_close(frozen["temperature"], 0.0, f"{path}.temperature")
    _expect_equal(frozen["root_noise"], False, f"{path}.root_noise")
    search = _object(metadata["search"], f"{path}.metadata.search")
    _expect_equal(search.get("simulations"), frozen["simulations"], f"{path}.metadata.search.simulations")
    _expect_close(search.get("c_puct"), float(frozen["c_puct"]), f"{path}.metadata.search.c_puct")
    _expect_close(search.get("temperature"), 0.0, f"{path}.metadata.search.temperature")

    identity = _object(metadata["checkpoint"], f"{path}.metadata.checkpoint")
    _require(
        identity,
        (
            "path",
            "sha256",
            "source_hash",
            "config_hash",
            "created_at_utc",
            "games_completed",
            "gradient_steps",
            "iteration",
        ),
        f"{path}.metadata.checkpoint",
    )
    _expect_value(
        identity,
        {"games_completed": 1, "gradient_steps": 1, "iteration": 1},
        f"{path}.metadata.checkpoint",
    )
    _expect_equal(identity["sha256"], EXPECTED_CHECKPOINT_SHA256, f"{path}.metadata.checkpoint.sha256")
    _expect_equal(identity["source_hash"], EXPECTED_CHECKPOINT_SOURCE_HASH, f"{path}.metadata.checkpoint.source_hash")
    _expect_equal(identity["config_hash"], EXPECTED_CHECKPOINT_CONFIG_HASH, f"{path}.metadata.checkpoint.config_hash")
    current_hash = _string(metadata["current_source_hash"], f"{path}.metadata.current_source_hash", nonempty=True)
    if not _valid_sha256(current_hash):
        _fail(f"{path}.metadata.current_source_hash", "invalid SHA-256")
    _expect_equal(
        metadata["saved_source_hash_matches_current"],
        current_hash == EXPECTED_CHECKPOINT_SOURCE_HASH,
        f"{path}.metadata.saved_source_hash_matches_current",
    )

    if not verify_files:
        return 0
    manifest_path = _resolve_manifest(Path(_string(frozen["checkpoint"], f"{path}.checkpoint", nonempty=True)))
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read checkpoint manifest: {manifest_path}") from exc
    manifest = _object(manifest, "checkpoint_manifest")
    _expect_equal(
        manifest.get("schema"),
        {"name": "lifeline-alphazero-latest", "version": 1},
        "checkpoint_manifest.schema",
    )
    _expect_value(
        manifest,
        {
            "checkpoint_schema_version": 1,
            "sha256": EXPECTED_CHECKPOINT_SHA256,
            "source_hash": EXPECTED_CHECKPOINT_SOURCE_HASH,
            "config_hash": EXPECTED_CHECKPOINT_CONFIG_HASH,
            "created_at_utc": identity["created_at_utc"],
        },
        "checkpoint_manifest",
    )
    checkpoint_name = _string(manifest.get("checkpoint"), "checkpoint_manifest.checkpoint", nonempty=True)
    if Path(checkpoint_name).name != checkpoint_name:
        _fail("checkpoint_manifest.checkpoint", "must be a local file name")
    checkpoint_path = (manifest_path.parent / checkpoint_name).resolve()
    identity_path = Path(_string(identity["path"], f"{path}.metadata.checkpoint.path", nonempty=True)).resolve()
    if checkpoint_path != identity_path:
        _fail(f"{path}.metadata.checkpoint.path", "does not identify manifest checkpoint")
    if not checkpoint_path.is_file():
        raise VerificationError(f"checkpoint bytes are unavailable: {checkpoint_path}")
    observed_size = checkpoint_path.stat().st_size
    _expect_equal(manifest.get("size_bytes"), observed_size, "checkpoint_manifest.size_bytes")
    observed_sha = _sha256_file(checkpoint_path)
    _expect_equal(observed_sha, EXPECTED_CHECKPOINT_SHA256, "checkpoint_bytes.sha256")

    run_root = manifest_path.parent.parent if manifest_path.parent.name == "checkpoints" else manifest_path.parent
    run_metadata_path = run_root / "run_metadata.json"
    config_path = run_root / "resolved_config.json"
    if not run_metadata_path.is_file() or not config_path.is_file():
        raise VerificationError("checkpoint run manifest or resolved_config.json is unavailable")
    run_metadata = _object(
        json.loads(run_metadata_path.read_text(encoding="utf-8")), "checkpoint_run_metadata"
    )
    _expect_value(
        run_metadata,
        {
            "source_hash": EXPECTED_CHECKPOINT_SOURCE_HASH,
            "resume_critical_hash": EXPECTED_CHECKPOINT_CONFIG_HASH,
            "kind": "smoke",
        },
        "checkpoint_run_metadata",
    )
    resolved_config = _object(
        json.loads(config_path.read_text(encoding="utf-8")), "checkpoint_resolved_config"
    )
    canonical = json.dumps(
        resolved_config,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    full_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    _expect_equal(run_metadata.get("full_config_hash"), full_hash, "checkpoint_run_metadata.full_config_hash")
    _expect_value(
        resolved_config,
        {"board_sizes": [5], "observation_mode": "topology", "superko_mode": "enforce"},
        "checkpoint_resolved_config",
    )
    return 1


def _formal_config_from_report(config: Mapping[str, Any]) -> dict[str, Any]:
    minimax = _object(config["minimax"], "$.config.minimax")
    mcts = _object(config["mcts"], "$.config.mcts")
    cycle = _object(config["cycle_seeking"], "$.config.cycle_seeking")
    frozen = _object(config["frozen_rl"], "$.config.frozen_rl")
    return {
        "sizes": list(config["sizes"]),
        "policies": list(config["policies"]),
        "seeds": list(config["master_seeds"]),
        "blocks_per_seed": config["blocks_per_seed"],
        "max_plies": config["max_plies"],
        "minimax_move_cap": minimax["move_cap"],
        "mcts_simulations": mcts["simulations"],
        "mcts_rollout_depth": mcts["rollout_depth"],
        "mcts_exploration": mcts["exploration"],
        "cycle_max_depth": cycle["max_depth"],
        "cycle_branch_limit": cycle["branch_limit"],
        "cycle_node_budget": cycle["node_budget"],
        "rl_simulations": frozen["simulations"],
        "rl_c_puct": frozen["c_puct"],
        "rl_device": frozen["device"],
        "bootstrap_resamples": config["bootstrap_resamples"],
    }


def _verify_formal_manifest(
    raw_identity: Any,
    *,
    config: Mapping[str, Any],
    verify_files: bool,
) -> Mapping[str, Any] | None:
    path = "$.config.formal_manifest"
    if not verify_files:
        identity = _object(raw_identity, path)
        _require(identity, ("path", "sha256"), path)
        if not _valid_sha256(identity["sha256"]):
            _fail(f"{path}.sha256", "invalid SHA-256")
        return None
    identity = _object(raw_identity, path)
    _require(identity, ("path", "sha256"), path)
    manifest_path = Path(
        _string(identity["path"], f"{path}.path", nonempty=True)
    ).resolve()
    if not manifest_path.is_file():
        raise VerificationError(f"formal manifest is unavailable: {manifest_path}")
    observed_sha = _sha256_file(manifest_path)
    _expect_equal(identity["sha256"], observed_sha, f"{path}.sha256")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read formal manifest: {manifest_path}") from exc
    manifest = _object(manifest, "formal_manifest")
    _expect_value(
        manifest,
        {
            "schema_version": 1,
            "experiment": EXPERIMENT,
            "formal_config": _formal_config_from_report(config),
            "source_sha256": dict(config["source_sha256"]),
            "checkpoint": {
                "path": str(Path(str(config["frozen_rl"]["checkpoint"])).resolve()),
                "sha256": EXPECTED_CHECKPOINT_SHA256,
                "config_hash": EXPECTED_CHECKPOINT_CONFIG_HASH,
                "source_hash": EXPECTED_CHECKPOINT_SOURCE_HASH,
            },
        },
        "formal_manifest",
    )
    return manifest


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise VerificationError(f"cannot read append-only journal: {path}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(
                line,
                parse_constant=_reject_constant,
                object_pairs_hook=_unique_object,
            )
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise VerificationError(f"invalid journal JSON at {path}:{line_number}") from exc
        if not isinstance(record, dict):
            raise VerificationError(f"journal record is not an object at {path}:{line_number}")
        _assert_json_finite(record, f"journal[{line_number}]")
        records.append(record)
    return records


def _verify_formal_journal(
    *,
    report_path: Path,
    report: Mapping[str, Any],
    config: Mapping[str, Any],
    ordered_blocks: Sequence[tuple[str, int, int, int, Mapping[str, Any]]],
) -> int:
    journal_path = report_path.with_suffix(report_path.suffix + ".blocks.jsonl")
    if not journal_path.is_file():
        raise VerificationError(f"formal append-only journal is unavailable: {journal_path}")
    events = _read_jsonl(journal_path)
    expected_count = len(ordered_blocks) + 2
    if len(events) != expected_count:
        _fail("journal", f"expected {expected_count} records, got {len(events)}")
    attempt_id = report["attempt_id"]
    start = events[0]
    _expect_value(
        start,
        {
            "event": "attempt_started",
            "attempt_id": attempt_id,
            "experiment": EXPERIMENT,
            "purpose": "five_seed_extension",
            "formal_config": _formal_config_from_report(config),
            "formal_manifest": config["formal_manifest"]["path"],
            "formal_manifest_sha256": config["formal_manifest"]["sha256"],
        },
        "journal[0]",
    )
    total = len(ordered_blocks)
    for ordinal, (policy, grid_size, master_seed, block_index, block) in enumerate(
        ordered_blocks, start=1
    ):
        event = events[ordinal]
        _expect_value(
            event,
            {
                "event": "block_completed",
                "attempt_id": attempt_id,
                "ordinal": ordinal,
                "blocks_total": total,
                "policy": policy,
                "grid_size": grid_size,
                "master_seed": master_seed,
                "block_index": block_index,
                "block": block,
            },
            f"journal[{ordinal}]",
        )
    completion = events[-1]
    _expect_value(
        completion,
        {
            "event": "attempt_completed",
            "attempt_id": attempt_id,
            "blocks_completed": total,
            "blocks_total": total,
            "output": str(report_path.resolve()),
            "output_sha256": _sha256_file(report_path),
        },
        f"journal[{len(events) - 1}]",
    )
    return len(events)


def _actions(raw: Iterable[list[int] | None]) -> tuple[tuple[int, int] | None, ...]:
    return tuple(None if action is None else (int(action[0]), int(action[1])) for action in raw)


def _verify_positive_control(raw: Any) -> None:
    path = "$.positive_control"
    control = _object(raw, path)
    _require(
        control,
        (
            "classification",
            "passed",
            "witness_path",
            "witness_sha256",
            "grid_size",
            "natural_prefix_transitions",
            "loop_transitions",
            "candidate",
            "enforce",
            "observe",
            "guided_loop",
            "observe_two_loop_replay",
            "instrumentation",
        ),
        path,
    )
    _expect_value(
        control,
        {
            "classification": "fixture_guided_positive_control_not_generic_policy_result",
            "passed": True,
            "grid_size": 6,
            "witness_sha256": EXPECTED_WITNESS_SHA256,
        },
        path,
    )
    if Path(_string(control["witness_path"], f"{path}.witness_path", nonempty=True)).resolve() != WITNESS_PATH.resolve():
        _fail(f"{path}.witness_path", "does not identify the frozen witness")
    if not WITNESS_PATH.is_file() or _sha256_file(WITNESS_PATH) != EXPECTED_WITNESS_SHA256:
        raise VerificationError("frozen Superko witness bytes do not match their identity")
    witness = json.loads(WITNESS_PATH.read_text(encoding="utf-8"))
    prefix = _actions(witness["natural_prefix"]["actions"])
    loop = _actions(witness["witness_loop"]["actions"])
    candidate = tuple(witness["candidate"]["action"])
    _expect_value(
        control,
        {
            "natural_prefix_transitions": len(prefix),
            "loop_transitions": len(loop),
            "candidate": list(candidate),
        },
        path,
    )

    enforce = LifelineGame(6, superko_mode="enforce")
    enforce.replay(prefix)
    before = enforce.clone()
    observe = LifelineGame(6, superko_mode="observe")
    observe.replay(prefix)

    def instrument_attempt(game: LifelineGame) -> tuple[dict[str, Any], Any]:
        repeats = tuple(game.would_violate_superko_moves())
        record = {
            "ply": 0,
            "actor": game.current_player.value,
            "slot": "fixture",
            "agent": "fixture-guided-forced-action",
            "decision_seed": None,
            "position_before_sha256": _position_sha256(game),
            "full_state_before_sha256": _full_state_sha256(game),
            "mode_normalized_state_before_sha256": _mode_normalized_state_sha256(game),
            "legal_actions": [game.point_to_index[point] for point in game.legal_moves()]
            + [game.num_points],
            "action": game.point_to_index[candidate],
            "point": list(candidate),
            "would_violate_superko_candidates": [
                game.point_to_index[point] for point in repeats
            ],
            "selected_would_violate_superko": candidate in repeats,
        }
        result = game.play_move(candidate)
        record.update(
            {
                "result_success": result.success,
                "result_reason": result.reason,
                "result_would_violate_superko": result.would_violate_superko,
                "position_after_sha256": _position_sha256(game),
                "full_state_after_sha256": _full_state_sha256(game),
                "mode_normalized_state_after_sha256": _mode_normalized_state_sha256(game),
            }
        )
        return record, result

    enforce_record, enforce_result = instrument_attempt(enforce)
    observe_record, observe_result = instrument_attempt(observe)
    instrumentation_comparison = _comparison(
        {
            "actions": [enforce_record],
            "truncated": True,
            "winner": None,
            "focal_score": None,
            "plies": 1,
        },
        {
            "actions": [observe_record],
            "truncated": True,
            "winner": None,
            "focal_score": None,
            "plies": 1,
        },
    )

    stage = LifelineGame(6, superko_mode="enforce")
    stage.replay(prefix[: int(witness["stage_5"]["prefix_action_count"])])
    root_projection = _position_projection(stage)
    working = LifelineGame(6, start_player=stage.start_player, superko_mode="observe")
    working.restore(replace(stage.clone(), superko_mode="observe"))
    last_result = None
    for action in loop:
        last_result = working.skip_turn() if action is None else working.play_move(action)
        if not last_result.success:
            raise VerificationError("fixture-guided loop cannot be replayed")

    repeated = LifelineGame(6, superko_mode="observe")
    repeated.replay(prefix[: int(witness["stage_5"]["prefix_action_count"])])
    stage_digest = _position_sha256(repeated)
    loop_end_digests: list[str] = []
    loop_end_repeat_flags: list[bool] = []
    for _ in range(2):
        closing_result = None
        for action in loop:
            closing_result = (
                repeated.skip_turn() if action is None else repeated.play_move(action)
            )
            if not closing_result.success:
                raise VerificationError("two-loop positive-control replay failed")
        assert closing_result is not None
        loop_end_digests.append(_position_sha256(repeated))
        loop_end_repeat_flags.append(bool(closing_result.would_violate_superko))

    expected = {
        "enforce": {
            "success": False,
            "reason": "SUPERKO_VIOLATION",
            "would_violate_superko": True,
            "transactional_state_unchanged": enforce.clone() == before,
        },
        "observe": {
            "success": True,
            "reason": None,
            "would_violate_superko": True,
        },
        "guided_loop": {
            "valid": bool(last_result and last_result.would_violate_superko),
            "closes_root_position": _position_projection(working) == root_projection,
            "repeat_action": list(loop[-1]) if loop[-1] is not None else None,
            "reason": None,
        },
        "observe_two_loop_replay": {
            "stage_rule_position_sha256": stage_digest,
            "loop_end_rule_position_sha256": loop_end_digests,
            "closing_actions_flagged_repeat": loop_end_repeat_flags,
            "successful_transitions": 2 * len(loop),
        },
        "instrumentation": {
            "enforce_attempt": enforce_record,
            "observe_attempt": observe_record,
            "comparison": instrumentation_comparison,
        },
    }
    _expect_value(control, expected, path)
    if not (enforce_result.would_violate_superko and observe_result.would_violate_superko):
        raise VerificationError("positive-control replay did not expose Superko")


def verify_report(
    report: Mapping[str, Any],
    *,
    report_path: Path | None = None,
    verify_checkpoint_files: bool = True,
    verify_formal_sidecars: bool = True,
) -> dict[str, Any]:
    """Verify a parsed full report and return a compact independently derived audit."""

    _assert_json_finite(report)
    root = _object(report, "$")
    _require(
        root,
        (
            "schema_version",
            "experiment",
            "purpose",
            "attempt_id",
            "claim_boundary",
            "config",
            "positive_control",
            "runtime",
            "conditions",
        ),
        "$",
    )
    _expect_equal(root["schema_version"], 1, "$.schema_version")
    _expect_equal(root["experiment"], EXPERIMENT, "$.experiment")
    purpose = _string(root["purpose"], "$.purpose")
    if purpose not in PURPOSES:
        _fail("$.purpose", f"expected one of {PURPOSES}")
    _string(root["attempt_id"], "$.attempt_id", nonempty=True)
    claim_boundary = _string(root["claim_boundary"], "$.claim_boundary", nonempty=True)
    if "not rule equivalence" not in claim_boundary.lower():
        _fail("$.claim_boundary", "missing the non-equivalence claim boundary")

    config = _object(root["config"], "$.config")
    _require(
        config,
        (
            "sizes",
            "policies",
            "master_seeds",
            "uses_exact_frozen_seed_set",
            "blocks_per_seed",
            "games_per_block",
            "max_plies",
            "minimax",
            "mcts",
            "cycle_seeking",
            "frozen_rl",
            "bootstrap_resamples",
            "source_sha256",
            "formal_manifest",
        ),
        "$.config",
    )
    sizes = [_integer(value, f"$.config.sizes[{index}]") for index, value in enumerate(_array(config["sizes"], "$.config.sizes"))]
    policies = [_string(value, f"$.config.policies[{index}]") for index, value in enumerate(_array(config["policies"], "$.config.policies"))]
    master_seeds = [_integer(value, f"$.config.master_seeds[{index}]", minimum=0) for index, value in enumerate(_array(config["master_seeds"], "$.config.master_seeds"))]
    if not sizes or len(set(sizes)) != len(sizes):
        _fail("$.config.sizes", "sizes must be non-empty and unique")
    if not policies or len(set(policies)) != len(policies) or any(policy not in FORMAL_POLICIES for policy in policies):
        _fail("$.config.policies", "policies must be unique known policy identifiers")
    if not master_seeds or len(set(master_seeds)) != len(master_seeds):
        _fail("$.config.master_seeds", "master seeds must be non-empty and unique")
    exact_seed_set = tuple(master_seeds) == FORMAL_SEEDS
    _expect_equal(config["uses_exact_frozen_seed_set"], exact_seed_set, "$.config.uses_exact_frozen_seed_set")
    blocks_per_seed = _integer(config["blocks_per_seed"], "$.config.blocks_per_seed", minimum=1)
    _expect_equal(config["games_per_block"], 4, "$.config.games_per_block")
    max_plies = _integer(config["max_plies"], "$.config.max_plies", minimum=1)
    bootstrap_resamples = _integer(
        config["bootstrap_resamples"], "$.config.bootstrap_resamples", minimum=1
    )

    if purpose == "five_seed_extension":
        _expect_equal(tuple(_frozen_seed(index) for index in range(5)), FORMAL_SEEDS, "frozen_seed_derivation")
        _expect_equal(tuple(master_seeds), FORMAL_SEEDS, "$.config.master_seeds")
        _expect_equal(tuple(sizes), FORMAL_SIZES, "$.config.sizes")
        _expect_equal(tuple(policies), FORMAL_POLICIES, "$.config.policies")
        _expect_equal(blocks_per_seed, 1, "$.config.blocks_per_seed")
        _expect_equal(max_plies, 120, "$.config.max_plies")
        _expect_equal(bootstrap_resamples, 10_000, "$.config.bootstrap_resamples")
        _expect_value(config["minimax"], {"depth": 2, "move_cap": 20}, "$.config.minimax")
        _expect_value(
            config["mcts"],
            {"simulations": 16, "rollout_depth": 24, "exploration": 2**0.5},
            "$.config.mcts",
        )
        _expect_value(
            config["cycle_seeking"],
            {"max_depth": 4, "branch_limit": 5, "node_budget": 1000, "fallback": "random"},
            "$.config.cycle_seeking",
        )
        _expect_value(
            config["frozen_rl"],
            {
                "requested": True,
                "simulations": 4,
                "c_puct": 1.5,
                "temperature": 0.0,
                "root_noise": False,
                "device": "cpu",
            },
            "$.config.frozen_rl",
        )
        _verify_formal_manifest(
            config["formal_manifest"],
            config=config,
            verify_files=verify_formal_sidecars,
        )
    else:
        if set(master_seeds) & set(FORMAL_SEEDS):
            _fail("$.config.master_seeds", "dry_run consumes a frozen formal seed")
        _expect_equal(config["formal_manifest"], None, "$.config.formal_manifest")

    source_hashes = _object(config["source_sha256"], "$.config.source_sha256")
    if not source_hashes:
        _fail("$.config.source_sha256", "source hash manifest is empty")
    normalized_sources = {str(key).replace("\\", "/"): value for key, value in source_hashes.items()}
    for required_source in (
        "scripts/run_superko_policy_matrix.py",
        "lifeline_rl/core.py",
        "lifeline_rl/agents/cycle_seeking.py",
    ):
        if required_source not in normalized_sources:
            _fail("$.config.source_sha256", f"missing {required_source}")
    for key, value in normalized_sources.items():
        if not _valid_sha256(value):
            _fail(f"$.config.source_sha256.{key}", "invalid SHA-256")

    _verify_positive_control(root["positive_control"])
    checkpoints_verified = _verify_checkpoint_identity(
        config["frozen_rl"], verify_files=verify_checkpoint_files
    )

    conditions = _array(root["conditions"], "$.conditions")
    expected_cells = [(policy, size) for policy in policies for size in sizes]
    if len(conditions) != len(expected_cells):
        _fail("$.conditions", f"expected {len(expected_cells)} cells, got {len(conditions)}")
    verified_games = 0
    verified_blocks = 0
    ordered_blocks: list[tuple[str, int, int, int, Mapping[str, Any]]] = []
    for cell_index, ((expected_policy, expected_size), raw_condition) in enumerate(
        zip(expected_cells, conditions)
    ):
        condition_path = f"$.conditions[{cell_index}]"
        condition = _object(raw_condition, condition_path)
        _require(condition, ("policy", "grid_size", "summary", "blocks"), condition_path)
        _expect_equal(condition["policy"], expected_policy, f"{condition_path}.policy")
        _expect_equal(condition["grid_size"], expected_size, f"{condition_path}.grid_size")
        raw_blocks = _array(condition["blocks"], f"{condition_path}.blocks")
        expected_block_keys = [
            (seed, block_index)
            for seed in master_seeds
            for block_index in range(blocks_per_seed)
        ]
        if purpose == "five_seed_extension" and len(raw_blocks) != 5:
            _fail(f"{condition_path}.blocks", "formal cell must contain exactly five blocks")
        if len(raw_blocks) != len(expected_block_keys):
            _fail(
                f"{condition_path}.blocks",
                f"expected {len(expected_block_keys)} blocks, got {len(raw_blocks)}",
            )
        blocks: list[Mapping[str, Any]] = []
        for block_position, ((seed, block_index), raw_block) in enumerate(
            zip(expected_block_keys, raw_blocks)
        ):
            block = _verify_block(
                raw_block,
                path=f"{condition_path}.blocks[{block_position}]",
                policy=expected_policy,
                grid_size=expected_size,
                master_seed=seed,
                block_index=block_index,
                max_plies=max_plies,
            )
            blocks.append(block)
            ordered_blocks.append(
                (expected_policy, expected_size, seed, block_index, block)
            )
        _verify_condition_summary(
            condition["summary"],
            path=f"{condition_path}.summary",
            blocks=blocks,
            policy=expected_policy,
            grid_size=expected_size,
            bootstrap_resamples=bootstrap_resamples,
        )
        verified_blocks += len(blocks)
        verified_games += 4 * len(blocks)

    runtime = _object(root["runtime"], "$.runtime")
    _number(runtime.get("duration_seconds"), "$.runtime.duration_seconds", minimum=0.0)
    journal_records_verified = 0
    if purpose == "five_seed_extension" and verify_formal_sidecars:
        if report_path is None:
            raise VerificationError(
                "formal sidecar verification requires the full report filesystem path"
            )
        journal_records_verified = _verify_formal_journal(
            report_path=report_path.resolve(),
            report=root,
            config=config,
            ordered_blocks=ordered_blocks,
        )
    return {
        "status": "PASS",
        "experiment": EXPERIMENT,
        "purpose": purpose,
        "conditions_verified": len(conditions),
        "blocks_verified": verified_blocks,
        "games_replayed": verified_games,
        "checkpoint_files_verified": checkpoints_verified,
        "checkpoint_file_verification_skipped": not verify_checkpoint_files,
        "formal_sidecars_verified": journal_records_verified,
        "formal_sidecar_verification_skipped": (
            purpose == "five_seed_extension" and not verify_formal_sidecars
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="full policy-matrix JSON (not --summary-only output)")
    parser.add_argument(
        "--skip-checkpoint-files",
        action="store_true",
        help="audit a portable copy without reading the original checkpoint bytes",
    )
    parser.add_argument(
        "--skip-formal-sidecars",
        action="store_true",
        help="audit a portable formal JSON without its manifest and append-only journal",
    )
    args = parser.parse_args(argv)
    summary = verify_report(
        load_report(args.report),
        report_path=args.report,
        verify_checkpoint_files=not args.skip_checkpoint_files,
        verify_formal_sidecars=not args.skip_formal_sidecars,
    )
    print(json.dumps(summary, indent=2, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
