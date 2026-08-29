"""Run a paired engineering pilot for enforce versus observe Superko modes.

The two modes receive the same per-episode, per-ply random-number tape.  The
policy deliberately mixes attack-biased point moves with voluntary PASS so
that a rules-induced action-set difference does not also change how many
random numbers are consumed.  ``observe`` is assumed to keep exact repetition
history and to admit moves that would be rejected by ``enforce`` while marking
their :class:`MoveResult` with ``would_violate_superko``.

This script is an engineering diagnostic, not an equivalence test.  Truncated
games remain a separate outcome and are never converted to draws.
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
from typing import Any, Iterable, Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineGame, Player, PointState  # noqa: E402


Action = tuple[int, int] | None
SUPERKO_MODES = ("enforce", "observe")
OUTCOME_CATEGORIES = (
    Player.BLACK.value,
    Player.WHITE.value,
    "DRAW",
    "TRUNCATED",
)
BOOTSTRAP_RESAMPLES = 10_000
WILSON_Z = 1.959963984540054
ACTION_PRIORITY_BITS = 128
ACTION_COUPLING = {
    "name": "canonical_keyed_action_priority_v1",
    "randomness": (
        "one shared 128-bit priority key per paired ply; each point receives "
        "SHA-256(key, row, column)"
    ),
    "selection": (
        "after the shared PASS and attack-preference gates, choose the legal "
        "point with maximal (preferred-tier, keyed-priority, coordinate)"
    ),
    "invariance": (
        "adding a candidate below the current maximal composite priority "
        "does not change the selected shared action"
    ),
}

CLAIM_BOUNDARY = (
    "ENGINEERING_PILOT_ONLY: results describe one seeded attack-plus-PASS "
    "random policy, not trained-agent strength or rule equivalence. Wilson "
    "intervals are descriptive; decision states within a game are dependent. "
    "Paired bootstrap intervals resample whole episodes. Truncations are "
    "reported separately and never scored as draws; complete-pair score is "
    "secondary, while all-pair score bounds expose truncation uncertainty. "
    "Failure to reject a null "
    "hypothesis is not evidence that enforce and observe are equivalent; an "
    "equivalence claim requires pre-registered effect margins and confidence "
    "intervals wholly inside those margins."
)


def _derive_seed(*parts: object) -> int:
    encoded = "|".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(encoded).digest()[:8], "big")


def _winner_value(game: LifelineGame, truncated: bool) -> str | None:
    if truncated:
        return None
    winner = game.winner()
    return winner.value if isinstance(winner, Player) else winner


def _black_score(winner: str | None, truncated: bool) -> float | None:
    if truncated:
        return None
    if winner == Player.BLACK.value:
        return 1.0
    if winner == "DRAW":
        return 0.5
    if winner == Player.WHITE.value:
        return 0.0
    raise AssertionError(f"unexpected completed-game winner: {winner!r}")


def _position_signature(game: LifelineGame) -> tuple[Any, ...]:
    """Rule-relevant current position, deliberately excluding history/mode."""

    return (
        tuple(game.grid),
        tuple(sorted(game.edges[Player.BLACK])),
        tuple(sorted(game.edges[Player.WHITE])),
        game.current_player.value,
        game.consecutive_skips,
        game.game_over,
    )


def _position_fingerprint(game: LifelineGame) -> str:
    payload = repr(_position_signature(game)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _action_index(game: LifelineGame, action: Action) -> int:
    return game.num_points if action is None else game.point_to_index[action]


def _action_json(action: Action) -> list[int] | None:
    return None if action is None else [action[0], action[1]]


def _ordered_points(
    game: LifelineGame, points: Iterable[Sequence[int]]
) -> list[tuple[int, int]]:
    normalized = {(int(point[0]), int(point[1])) for point in points}
    return [point for point in game.valid_positions if point in normalized]


def _keyed_action_priority(priority_key: int, action: tuple[int, int]) -> int:
    """Return a stable, set-independent pseudo-random priority for one point."""

    if priority_key < 0:
        raise ValueError("priority_key must be non-negative")
    payload = json.dumps(
        ["canonical_keyed_action_priority_v1", priority_key, action[0], action[1]],
        separators=(",", ":"),
    ).encode("ascii")
    return int.from_bytes(hashlib.sha256(payload).digest(), "big")


def _select_by_keyed_priority(
    candidates: Sequence[tuple[int, int]],
    *,
    priority_key: int,
    preferred: Iterable[tuple[int, int]] = (),
) -> tuple[int, int]:
    """Select canonically without remapping shared actions as set size changes."""

    if not candidates:
        raise ValueError("candidates must not be empty")
    preferred_set = set(preferred)
    return max(
        candidates,
        key=lambda action: (
            int(action in preferred_set),
            _keyed_action_priority(priority_key, action),
            action,
        ),
    )


def _choose_action(
    game: LifelineGame,
    *,
    actions_played: int,
    pass_draw: float,
    attack_draw: float,
    priority_key: int,
    pass_probability: float,
    attack_bias: float,
) -> tuple[Action, bool]:
    """Choose from shared gates plus a set-independent per-action priority."""

    if (
        actions_played > 0
        and game.consecutive_skips == 0
        and pass_draw < pass_probability
    ):
        return None, False

    legal = _ordered_points(game, game.legal_moves())
    opponent_line = (
        PointState.WHITE_LINE
        if game.current_player is Player.BLACK
        else PointState.BLACK_LINE
    )
    attacks = [point for point in legal if game.get_state(point) == opponent_line]
    use_attacks = bool(attacks) and attack_draw < attack_bias
    if not legal:
        return None, False
    selected = _select_by_keyed_priority(
        legal,
        priority_key=priority_key,
        preferred=attacks if use_attacks else (),
    )
    return selected, use_attacks


def _initial_mode_record() -> dict[str, Any]:
    return {
        "decision_states": 0,
        "would_trigger_states": 0,
        "locally_legal_point_actions": 0,
        "would_violate_superko_candidates": 0,
        "selected_would_violate_superko": 0,
        "passes": 0,
        "attacks": 0,
        "plies": 0,
    }


def _run_episode(
    *,
    grid_size: int,
    episode: int,
    episode_seed: int,
    max_plies: int,
    pass_probability: float,
    attack_bias: float,
) -> dict[str, Any]:
    games = {mode: LifelineGame(grid_size, superko_mode=mode) for mode in SUPERKO_MODES}
    mode_records = {mode: _initial_mode_record() for mode in SUPERKO_MODES}
    action_digests = {mode: hashlib.sha256() for mode in SUPERKO_MODES}
    tape = random.Random(episode_seed)
    first_action_divergence_ply: int | None = None
    first_action_divergence_selected_actions: dict[str, Any] | None = None
    first_position_divergence_after_ply: int | None = None
    first_trajectory_divergence: dict[str, Any] | None = None

    for pair_ply in range(max_plies):
        if all(game.game_over for game in games.values()):
            break

        pass_draw = tape.random()
        attack_draw = tape.random()
        priority_key = tape.getrandbits(ACTION_PRIORITY_BITS)
        active_before = {mode: not games[mode].game_over for mode in SUPERKO_MODES}
        selected_actions: dict[str, Action] = {}

        for mode in SUPERKO_MODES:
            game = games[mode]
            record = mode_records[mode]
            if game.game_over:
                continue

            would_repeat = set(
                _ordered_points(game, game.would_violate_superko_moves())
            )
            legal = set(game.legal_moves())
            record["decision_states"] += 1
            record["locally_legal_point_actions"] += len(legal | would_repeat)
            record["would_violate_superko_candidates"] += len(would_repeat)
            if would_repeat:
                record["would_trigger_states"] += 1

            action, selected_attack = _choose_action(
                game,
                actions_played=record["plies"],
                pass_draw=pass_draw,
                attack_draw=attack_draw,
                priority_key=priority_key,
                pass_probability=pass_probability,
                attack_bias=attack_bias,
            )
            selected_actions[mode] = action
            selected_repeat = action is not None and action in would_repeat
            if selected_repeat:
                record["selected_would_violate_superko"] += 1
            if action is None:
                record["passes"] += 1
                result = game.skip_turn()
            else:
                if selected_attack:
                    record["attacks"] += 1
                result = game.play_move(action)
            if not result.success:
                raise AssertionError(
                    f"{mode} rejected selected action at n={grid_size}, "
                    f"episode={episode}, ply={pair_ply}: {action!r} ({result.reason})"
                )
            if bool(result.would_violate_superko) != selected_repeat:
                raise AssertionError(
                    f"would-violate flag disagrees with probe at n={grid_size}, "
                    f"episode={episode}, ply={pair_ply}, mode={mode}"
                )
            record["plies"] += 1
            action_digests[mode].update(
                json.dumps(
                    [pair_ply, _action_index(game, action)],
                    separators=(",", ":"),
                ).encode("ascii")
            )

        if first_action_divergence_ply is None:
            if active_before["enforce"] != active_before["observe"]:
                first_action_divergence_ply = pair_ply
            elif active_before["enforce"] and (
                selected_actions["enforce"] != selected_actions["observe"]
            ):
                first_action_divergence_ply = pair_ply

        if first_position_divergence_after_ply is None and _position_signature(
            games["enforce"]
        ) != _position_signature(games["observe"]):
            first_position_divergence_after_ply = pair_ply

        if first_trajectory_divergence is None and (
            first_action_divergence_ply == pair_ply
            or first_position_divergence_after_ply == pair_ply
        ):
            selected_action_payload = {
                mode: {
                    "active": active_before[mode],
                    "action": (
                        _action_json(selected_actions[mode])
                        if active_before[mode]
                        else None
                    ),
                    "action_index": (
                        _action_index(games[mode], selected_actions[mode])
                        if active_before[mode]
                        else None
                    ),
                }
                for mode in SUPERKO_MODES
            }
            if first_action_divergence_ply == pair_ply:
                first_action_divergence_selected_actions = selected_action_payload
            first_trajectory_divergence = {
                "pair_ply": pair_ply,
                "action_diverged": first_action_divergence_ply == pair_ply,
                "position_diverged_after_ply": (
                    first_position_divergence_after_ply == pair_ply
                ),
                "selected_actions": selected_action_payload,
                "shared_randomness": {
                    "pass_draw": pass_draw,
                    "attack_draw": attack_draw,
                    "priority_key_hex": f"{priority_key:032x}",
                },
            }

    for mode in SUPERKO_MODES:
        game = games[mode]
        record = mode_records[mode]
        truncated = not game.game_over
        winner = _winner_value(game, truncated)
        record.update(
            {
                "triggered": record["would_trigger_states"] > 0,
                "selected_repetition": record["selected_would_violate_superko"] > 0,
                "winner": winner,
                "black_score": _black_score(winner, truncated),
                "truncated": truncated,
                "action_trace_sha256": action_digests[mode].hexdigest(),
                "final_position_sha256": _position_fingerprint(game),
            }
        )

    trajectory_diverged = (
        first_action_divergence_ply is not None
        or first_position_divergence_after_ply is not None
    )
    return {
        "episode": episode,
        "episode_seed": episode_seed,
        "trajectory_diverged": trajectory_diverged,
        "first_action_divergence_ply": first_action_divergence_ply,
        "first_action_divergence_selected_actions": (
            first_action_divergence_selected_actions
        ),
        "first_position_divergence_after_ply": first_position_divergence_after_ply,
        "first_trajectory_divergence": first_trajectory_divergence,
        "enforce": mode_records["enforce"],
        "observe": mode_records["observe"],
    }


def _wilson(successes: int, trials: int) -> list[float] | None:
    if trials == 0:
        return None
    if successes < 0 or successes > trials:
        raise ValueError("successes must be in [0, trials]")
    proportion = successes / trials
    z2 = WILSON_Z * WILSON_Z
    denominator = 1.0 + z2 / trials
    center = (proportion + z2 / (2.0 * trials)) / denominator
    margin = (
        WILSON_Z
        * math.sqrt(
            proportion * (1.0 - proportion) / trials + z2 / (4.0 * trials * trials)
        )
        / denominator
    )
    lower = 0.0 if successes == 0 else max(0.0, center - margin)
    upper = 1.0 if successes == trials else min(1.0, center + margin)
    return [lower, upper]


def _rate(successes: int, trials: int) -> dict[str, Any]:
    return {
        "successes": successes,
        "trials": trials,
        "rate": successes / trials if trials else None,
        "ci95_wilson": _wilson(successes, trials),
    }


def _percentile(sorted_values: list[float], probability: float) -> float:
    if len(sorted_values) == 1:
        return sorted_values[0]
    location = probability * (len(sorted_values) - 1)
    lower = int(math.floor(location))
    upper = int(math.ceil(location))
    if lower == upper:
        return sorted_values[lower]
    weight = location - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def _paired_bootstrap(
    differences: list[float],
    *,
    seed: int,
) -> dict[str, Any]:
    if not differences:
        return {
            "paired_episodes": 0,
            "observed_mean": None,
            "resamples": BOOTSTRAP_RESAMPLES,
            "ci95": None,
        }
    rng = random.Random(seed)
    count = len(differences)
    means = [
        statistics.fmean(differences[rng.randrange(count)] for _ in range(count))
        for _ in range(BOOTSTRAP_RESAMPLES)
    ]
    means.sort()
    return {
        "paired_episodes": count,
        "observed_mean": statistics.fmean(differences),
        "resamples": BOOTSTRAP_RESAMPLES,
        "ci95": [_percentile(means, 0.025), _percentile(means, 0.975)],
    }


def _paired_bootstrap_relative_mean(
    enforce_values: Sequence[float],
    observe_values: Sequence[float],
    *,
    seed: int,
    resamples: int = BOOTSTRAP_RESAMPLES,
) -> dict[str, Any]:
    """Bootstrap a relative mean difference by resampling paired episodes."""

    if len(enforce_values) != len(observe_values):
        raise ValueError("paired value sequences must have equal length")
    if resamples < 1:
        raise ValueError("resamples must be at least 1")
    if not enforce_values:
        return {
            "paired_episodes": 0,
            "observed_relative_difference": None,
            "resamples": resamples,
            "ci95": None,
            "definition": "(mean(observe)-mean(enforce))/mean(enforce)",
        }
    if any(not math.isfinite(value) or value <= 0.0 for value in enforce_values):
        raise ValueError("every enforce baseline value must be finite and positive")
    if any(not math.isfinite(value) for value in observe_values):
        raise ValueError("every observe value must be finite")

    count = len(enforce_values)
    enforce_mean = statistics.fmean(enforce_values)
    observe_mean = statistics.fmean(observe_values)
    observed = (observe_mean - enforce_mean) / enforce_mean
    rng = random.Random(seed)
    effects: list[float] = []
    for _ in range(resamples):
        indices = [rng.randrange(count) for _ in range(count)]
        sampled_enforce = statistics.fmean(enforce_values[index] for index in indices)
        sampled_observe = statistics.fmean(observe_values[index] for index in indices)
        effects.append((sampled_observe - sampled_enforce) / sampled_enforce)
    effects.sort()
    return {
        "paired_episodes": count,
        "observed_relative_difference": observed,
        "resamples": resamples,
        "ci95": [_percentile(effects, 0.025), _percentile(effects, 0.975)],
        "definition": "(mean(observe)-mean(enforce))/mean(enforce)",
    }


def _outcome_category(record: dict[str, Any]) -> str:
    if record["truncated"]:
        return "TRUNCATED"
    winner = record["winner"]
    if winner not in OUTCOME_CATEGORIES[:-1]:
        raise ValueError(f"unexpected completed-game winner: {winner!r}")
    return str(winner)


def _outcome_contingency(episodes: Sequence[dict[str, Any]]) -> dict[str, Any]:
    counts = {
        enforce: {observe: 0 for observe in OUTCOME_CATEGORIES}
        for enforce in OUTCOME_CATEGORIES
    }
    for episode in episodes:
        enforce = _outcome_category(episode["enforce"])
        observe = _outcome_category(episode["observe"])
        counts[enforce][observe] += 1
    return {
        "row_mode": "enforce",
        "column_mode": "observe",
        "categories": list(OUTCOME_CATEGORIES),
        "counts": counts,
        "total_pairs": len(episodes),
        "off_diagonal_pairs": sum(
            counts[enforce][observe]
            for enforce in OUTCOME_CATEGORIES
            for observe in OUTCOME_CATEGORIES
            if enforce != observe
        ),
    }


def _black_score_interval(record: dict[str, Any]) -> tuple[float, float]:
    if record["truncated"]:
        return 0.0, 1.0
    score = record["black_score"]
    if score not in {0.0, 0.5, 1.0}:
        raise ValueError(f"unexpected completed-game black score: {score!r}")
    return float(score), float(score)


def _black_score_difference_sample_bounds(
    episodes: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Bound the all-pair sample mean without assigning scores to truncations."""

    lower_differences: list[float] = []
    upper_differences: list[float] = []
    for episode in episodes:
        enforce_low, enforce_high = _black_score_interval(episode["enforce"])
        observe_low, observe_high = _black_score_interval(episode["observe"])
        lower_differences.append(observe_low - enforce_high)
        upper_differences.append(observe_high - enforce_low)
    if not episodes:
        identified_interval = None
    else:
        identified_interval = [
            statistics.fmean(lower_differences),
            statistics.fmean(upper_differences),
        ]
    return {
        "pairs": len(episodes),
        "identified_interval": identified_interval,
        "worst_case": identified_interval[0] if identified_interval else None,
        "best_case": identified_interval[1] if identified_interval else None,
        "score_scale": {"BLACK": 1.0, "DRAW": 0.5, "WHITE": 0.0},
        "truncated_score_interval": [0.0, 1.0],
        "sampling_uncertainty_included": False,
    }


def _finite_summary(values: list[int]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "minimum": min(values) if values else None,
        "median": statistics.median(values) if values else None,
        "mean": statistics.fmean(values) if values else None,
        "maximum": max(values) if values else None,
    }


def _summarize_mode(episodes: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    records = [episode[mode] for episode in episodes]
    completed = [record for record in records if not record["truncated"]]
    outcomes = {
        Player.BLACK.value: sum(
            record["winner"] == Player.BLACK.value for record in completed
        ),
        Player.WHITE.value: sum(
            record["winner"] == Player.WHITE.value for record in completed
        ),
        "DRAW": sum(record["winner"] == "DRAW" for record in completed),
        "TRUNCATED": sum(record["truncated"] for record in records),
    }
    decisions = sum(record["decision_states"] for record in records)
    local_candidates = sum(record["locally_legal_point_actions"] for record in records)
    trigger_states = sum(record["would_trigger_states"] for record in records)
    repeat_candidates = sum(
        record["would_violate_superko_candidates"] for record in records
    )
    selected_repeats = sum(
        record["selected_would_violate_superko"] for record in records
    )
    return {
        "games": len(records),
        "completed_games": len(completed),
        "outcomes": outcomes,
        "game_trigger_rate": _rate(
            sum(record["triggered"] for record in records), len(records)
        ),
        "game_selected_repetition_rate": _rate(
            sum(record["selected_repetition"] for record in records), len(records)
        ),
        "truncation_rate": _rate(outcomes["TRUNCATED"], len(records)),
        "decision_state_trigger_rate_descriptive": _rate(trigger_states, decisions),
        "selected_repetition_per_decision_descriptive": _rate(
            selected_repeats, decisions
        ),
        "would_repeat_candidate_share": (
            repeat_candidates / local_candidates if local_candidates else None
        ),
        "decision_states": decisions,
        "locally_legal_point_actions": local_candidates,
        "would_violate_superko_candidates": repeat_candidates,
        "selected_would_violate_superko": selected_repeats,
        "passes": sum(record["passes"] for record in records),
        "attacks": sum(record["attacks"] for record in records),
        "mean_plies": statistics.fmean(record["plies"] for record in records),
        "completed_outcome_rates": {
            "black_win": _rate(outcomes[Player.BLACK.value], len(completed)),
            "white_win": _rate(outcomes[Player.WHITE.value], len(completed)),
            "draw": _rate(outcomes["DRAW"], len(completed)),
        },
    }


def _summarize_pairs(
    episodes: list[dict[str, Any]],
    *,
    base_seed: int,
    grid_size: int,
) -> dict[str, Any]:
    complete_pairs = [
        episode
        for episode in episodes
        if not episode["enforce"]["truncated"] and not episode["observe"]["truncated"]
    ]
    score_differences = [
        episode["observe"]["black_score"] - episode["enforce"]["black_score"]
        for episode in complete_pairs
    ]
    enforce_plies = [float(episode["enforce"]["plies"]) for episode in episodes]
    observe_plies = [float(episode["observe"]["plies"]) for episode in episodes]
    plies_differences = [
        observe - enforce for enforce, observe in zip(enforce_plies, observe_plies)
    ]
    truncation_differences = [
        float(episode["observe"]["truncated"] - episode["enforce"]["truncated"])
        for episode in episodes
    ]
    trigger_differences = [
        float(episode["observe"]["triggered"] - episode["enforce"]["triggered"])
        for episode in episodes
    ]
    selected_repeat_differences = [
        float(
            episode["observe"]["selected_repetition"]
            - episode["enforce"]["selected_repetition"]
        )
        for episode in episodes
    ]
    winner_matches = sum(
        episode["enforce"]["winner"] == episode["observe"]["winner"]
        for episode in complete_pairs
    )
    divergences = sum(episode["trajectory_diverged"] for episode in episodes)
    return {
        "trajectory_divergence_rate": _rate(divergences, len(episodes)),
        "winner_agreement_among_complete_pairs": _rate(
            winner_matches, len(complete_pairs)
        ),
        "nonzero_black_score_difference_rate_among_complete_pairs": _rate(
            sum(difference != 0.0 for difference in score_differences),
            len(complete_pairs),
        ),
        "complete_pairs": len(complete_pairs),
        "outcome_contingency_all_pairs": _outcome_contingency(episodes),
        "black_score_observe_minus_enforce_sample_bounds_all_pairs": (
            _black_score_difference_sample_bounds(episodes)
        ),
        "first_action_divergence_ply": _finite_summary(
            [
                episode["first_action_divergence_ply"]
                for episode in episodes
                if episode["first_action_divergence_ply"] is not None
            ]
        ),
        "first_position_divergence_after_ply": _finite_summary(
            [
                episode["first_position_divergence_after_ply"]
                for episode in episodes
                if episode["first_position_divergence_after_ply"] is not None
            ]
        ),
        "paired_bootstrap_observe_minus_enforce": {
            "black_score_complete_pairs": _paired_bootstrap(
                score_differences,
                seed=_derive_seed(base_seed, grid_size, "black_score_bootstrap"),
            ),
            "plies_all_pairs": _paired_bootstrap(
                plies_differences,
                seed=_derive_seed(base_seed, grid_size, "plies_bootstrap"),
            ),
            "relative_mean_plies_all_pairs": _paired_bootstrap_relative_mean(
                enforce_plies,
                observe_plies,
                seed=_derive_seed(
                    base_seed,
                    grid_size,
                    "relative_mean_plies_bootstrap",
                ),
            ),
            "truncation_indicator_all_pairs": _paired_bootstrap(
                truncation_differences,
                seed=_derive_seed(base_seed, grid_size, "truncation_bootstrap"),
            ),
            "game_trigger_indicator_all_pairs": _paired_bootstrap(
                trigger_differences,
                seed=_derive_seed(base_seed, grid_size, "trigger_bootstrap"),
            ),
            "selected_repetition_indicator_all_pairs": _paired_bootstrap(
                selected_repeat_differences,
                seed=_derive_seed(base_seed, grid_size, "selection_bootstrap"),
            ),
        },
    }


def run_size(
    *,
    grid_size: int,
    episodes: int,
    max_plies: int,
    seed: int,
    pass_probability: float,
    attack_bias: float,
    progress: bool,
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    progress_every = max(1, episodes // 20)
    for episode in range(episodes):
        episode_seed = _derive_seed(seed, grid_size, episode, "paired_policy_tape")
        records.append(
            _run_episode(
                grid_size=grid_size,
                episode=episode,
                episode_seed=episode_seed,
                max_plies=max_plies,
                pass_probability=pass_probability,
                attack_bias=attack_bias,
            )
        )
        if progress and (
            (episode + 1) % progress_every == 0 or episode + 1 == episodes
        ):
            print(
                json.dumps(
                    {
                        "grid_size": grid_size,
                        "episodes_completed": episode + 1,
                        "episodes_total": episodes,
                    },
                    sort_keys=True,
                ),
                file=sys.stderr,
                flush=True,
            )
    return {
        "grid_size": grid_size,
        "modes": {mode: _summarize_mode(records, mode) for mode in SUPERKO_MODES},
        "paired": _summarize_pairs(records, base_seed=seed, grid_size=grid_size),
        "episodes": records,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[5, 6])
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--max-plies", type=int, default=120)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--pass-probability", type=float, default=0.12)
    parser.add_argument("--attack-bias", type=float, default=0.90)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--progress", action="store_true")
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="omit per-episode records from stdout while retaining them in --output",
    )
    args = parser.parse_args()
    if not args.sizes:
        parser.error("--sizes requires at least one board size")
    if len(set(args.sizes)) != len(args.sizes):
        parser.error("--sizes must not contain duplicates")
    if any(size < 5 or size > 15 for size in args.sizes):
        parser.error("every --sizes value must be in [5, 15]")
    if args.episodes < 1:
        parser.error("--episodes must be at least 1")
    if args.max_plies < 1:
        parser.error("--max-plies must be at least 1")
    if not 0.0 <= args.pass_probability <= 1.0:
        parser.error("--pass-probability must be in [0, 1]")
    if not 0.0 <= args.attack_bias <= 1.0:
        parser.error("--attack-bias must be in [0, 1]")
    return args


def main() -> int:
    args = parse_args()
    script_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report = {
        "schema_version": 2,
        "experiment": "paired_superko_enforce_vs_observe_attack_pass_random",
        "config": {
            "sizes": args.sizes,
            "episodes_per_size": args.episodes,
            "max_plies": args.max_plies,
            "base_seed": args.seed,
            "pass_probability": args.pass_probability,
            "attack_bias": args.attack_bias,
            "superko_modes": list(SUPERKO_MODES),
            "bootstrap_resamples": BOOTSTRAP_RESAMPLES,
            "script_sha256": script_sha256,
            "coupling_version": ACTION_COUPLING["name"],
            "action_coupling": ACTION_COUPLING,
            "common_random_numbers": (
                "one deterministic episode seed, two shared uniform gate "
                "draws, and one shared 128-bit action-priority key per paired ply"
            ),
            "truncation_scoring": "separate outcome; never a draw",
        },
        "claim_boundary": CLAIM_BOUNDARY,
        "results": [
            run_size(
                grid_size=size,
                episodes=args.episodes,
                max_plies=args.max_plies,
                seed=args.seed,
                pass_probability=args.pass_probability,
                attack_bias=args.attack_bias,
                progress=args.progress,
            )
            for size in args.sizes
        ],
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    printed_report = report
    if args.summary_only:
        printed_report = {
            **report,
            "results": [
                {key: value for key, value in result.items() if key != "episodes"}
                for result in report["results"]
            ],
        }
    print(json.dumps(printed_report, ensure_ascii=False, indent=2, sort_keys=True))
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
