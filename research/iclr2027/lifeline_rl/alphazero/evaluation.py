"""Pre-registered, replay-aware arena gates for learned checkpoints.

The functions in this module are deliberately independent of PyTorch.  They
turn the ordinary color-balanced arena artifacts into a small machine-readable
decision record while retaining the distinction between an engineering smoke
test and formal evidence.

Draws count as half a point in the reported score.  The accompanying Wilson
interval applies the same descriptive half-point convention used by
``lifeline_rl.arena``; it is not substituted for the pre-registered 55 percent
point-estimate rule in candidate/champion promotion.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from ..arena import GameRecord, MatchupResult, replay_game_record


GATE_SCHEMA_NAME = "lifeline_rl.alphazero.arena_gate"
GATE_SCHEMA_VERSION = 1
EVIDENCE_TIERS = ("smoke", "pilot", "formal")
GATE_KINDS = ("beat_random", "promote_champion")
D13_FORMAL_GAMES = 200
D13_FORMAL_GRID_SIZE = 5
D13_FORMAL_MAX_PLIES = 256
D13_FORMAL_SEED = 20260825
D13_FORMAL_PUCT_SIMULATIONS = 16
D13_FORMAL_C_PUCT = 1.5
D13_FORMAL_TEMPERATURE = 0.0
D13_FORMAL_SUPERKO_MODE = "enforce"
D13_FORMAL_MODEL_KIND = "topology_gnn"
D13_FORMAL_MIN_SELF_PLAY_GAMES = 100
D13_FORMAL_MIN_GRADIENT_STEPS = 200
D13_NEURAL_AGENT_CLASS = "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent"
D13_RANDOM_AGENT_CLASS = "lifeline_rl.agents.random_agent.RandomAgent"
# Keep this identical to the arena's persisted-summary calculation so a gate
# can cross-check those artifacts bit-for-bit within a tight tolerance.
_WILSON_Z_95 = 1.96


@dataclass(frozen=True)
class ArenaGateConfig:
    """Frozen acceptance rule for one color-balanced learned-agent matchup."""

    evidence_tier: str
    gate_kind: str
    games_required: int
    completed_games_required: int
    maximum_truncated_games: int
    minimum_score_rate: float | None = None
    minimum_wilson_lower_bound_exclusive: float | None = None
    require_color_balance: bool = True
    require_paired_seeds: bool = True
    verify_replays: bool = True
    schema_version: int = GATE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != GATE_SCHEMA_VERSION:
            raise ValueError("unsupported arena-gate config schema")
        if self.evidence_tier not in EVIDENCE_TIERS:
            raise ValueError(f"evidence_tier must be one of {EVIDENCE_TIERS}")
        if self.gate_kind not in GATE_KINDS:
            raise ValueError(f"gate_kind must be one of {GATE_KINDS}")
        for name, value in (
            ("games_required", self.games_required),
            ("completed_games_required", self.completed_games_required),
            ("maximum_truncated_games", self.maximum_truncated_games),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if self.games_required < 2 or self.games_required % 2:
            raise ValueError("games_required must be an even integer of at least 2")
        if self.completed_games_required > self.games_required:
            raise ValueError("completed_games_required cannot exceed games_required")
        if self.maximum_truncated_games > self.games_required:
            raise ValueError("maximum_truncated_games cannot exceed games_required")
        for name, value in (
            ("minimum_score_rate", self.minimum_score_rate),
            (
                "minimum_wilson_lower_bound_exclusive",
                self.minimum_wilson_lower_bound_exclusive,
            ),
        ):
            if value is not None and (
                not math.isfinite(value) or not 0.0 <= value <= 1.0
            ):
                raise ValueError(f"{name} must be None or a finite value in [0, 1]")
        if self.evidence_tier == "formal":
            if (
                self.games_required != D13_FORMAL_GAMES
                or self.completed_games_required != D13_FORMAL_GAMES
            ):
                raise ValueError("formal gates require exactly 200 completed games")
            if self.maximum_truncated_games != 0:
                raise ValueError("formal gates require zero truncated games")
            if not self.require_color_balance or not self.require_paired_seeds:
                raise ValueError("formal gates require color balance and paired seeds")
            if not self.verify_replays:
                raise ValueError("formal gates require action-replay verification")
            if self.gate_kind == "beat_random":
                thresholds_match = (
                    self.minimum_score_rate is None
                    and self.minimum_wilson_lower_bound_exclusive == 0.5
                )
            else:
                thresholds_match = (
                    self.minimum_score_rate == 0.55
                    and self.minimum_wilson_lower_bound_exclusive is None
                )
            if not thresholds_match:
                raise ValueError(
                    f"formal {self.gate_kind} thresholds are frozen and must "
                    "match the registered factory"
                )

    @classmethod
    def formal_beat_random(cls) -> "ArenaGateConfig":
        """D13 claim gate: 200 complete games and Wilson lower bound above 0.5."""

        return cls(
            evidence_tier="formal",
            gate_kind="beat_random",
            games_required=D13_FORMAL_GAMES,
            completed_games_required=D13_FORMAL_GAMES,
            maximum_truncated_games=0,
            minimum_wilson_lower_bound_exclusive=0.5,
        )

    @classmethod
    def formal_promotion(cls) -> "ArenaGateConfig":
        """Candidate/champion rule: promote at a 55 percent point score."""

        return cls(
            evidence_tier="formal",
            gate_kind="promote_champion",
            games_required=D13_FORMAL_GAMES,
            completed_games_required=D13_FORMAL_GAMES,
            maximum_truncated_games=0,
            minimum_score_rate=0.55,
        )

    @classmethod
    def exploratory(
        cls,
        *,
        gate_kind: str,
        evidence_tier: str,
        games: int,
        maximum_truncated_games: int = 0,
        minimum_score_rate: float | None = None,
        minimum_wilson_lower_bound_exclusive: float | None = None,
    ) -> "ArenaGateConfig":
        """Construct a labelled smoke/pilot rule that cannot support a formal claim."""

        if evidence_tier not in {"smoke", "pilot"}:
            raise ValueError("exploratory gates must use smoke or pilot evidence tier")
        return cls(
            evidence_tier=evidence_tier,
            gate_kind=gate_kind,
            games_required=games,
            completed_games_required=games - maximum_truncated_games,
            maximum_truncated_games=maximum_truncated_games,
            minimum_score_rate=minimum_score_rate,
            minimum_wilson_lower_bound_exclusive=(
                minimum_wilson_lower_bound_exclusive
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ArenaGateConfig":
        expected = set(cls.__dataclass_fields__)
        unknown = set(data).difference(expected)
        if unknown:
            raise ValueError(f"unknown arena-gate config keys: {sorted(unknown)}")
        return cls(**dict(data))


def score_wilson_interval(
    wins: int,
    losses: int,
    draws: int,
) -> tuple[float, float] | None:
    """Return the descriptive 95 percent Wilson score interval.

    Wins contribute one point, draws one half, and losses zero.  A missing
    interval for zero completed games is explicit rather than encoded as NaN.
    """

    counts = (wins, losses, draws)
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts):
        raise ValueError("wins, losses, and draws must be non-negative integers")
    count = sum(counts)
    if count == 0:
        return None
    proportion = (wins + 0.5 * draws) / count
    z_squared = _WILSON_Z_95 * _WILSON_Z_95
    denominator = 1.0 + z_squared / count
    center = (proportion + z_squared / (2.0 * count)) / denominator
    margin = (
        _WILSON_Z_95
        * math.sqrt(
            proportion * (1.0 - proportion) / count
            + z_squared / (4.0 * count * count)
        )
        / denominator
    )
    return max(0.0, center - margin), min(1.0, center + margin)


def _record_dict(record: GameRecord | Mapping[str, Any]) -> dict[str, Any]:
    return record.to_dict() if isinstance(record, GameRecord) else dict(record)


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _agent_a_score(record: Mapping[str, Any]) -> float | None:
    if bool(record["truncated"]):
        return None
    if record["winner"] == "DRAW":
        return 0.5
    a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
    return 1.0 if record["winner"] == a_color else 0.0


def _pairing_errors(
    records: Sequence[Mapping[str, Any]],
    *,
    base_seed: Any,
    grid_size: Any,
    superko_mode: Any,
) -> list[str]:
    errors: list[str] = []
    if isinstance(base_seed, bool) or not isinstance(base_seed, int):
        errors.append("summary_missing_valid_base_seed")
        base_seed = None
    pairs: dict[int, list[Mapping[str, Any]]] = {}
    for record in records:
        try:
            pair_index = int(record["pair_index"])
        except (KeyError, TypeError, ValueError):
            errors.append("record_missing_valid_pair_index")
            continue
        pairs.setdefault(pair_index, []).append(record)

    expected_pair_indices = set(range(len(records) // 2))
    if set(pairs) != expected_pair_indices:
        errors.append("pair_indices_not_contiguous")
    for pair_index in sorted(pairs):
        pair = pairs[pair_index]
        if len(pair) != 2:
            errors.append(f"pair_{pair_index}_does_not_have_two_games")
            continue
        if {record.get("game_index") for record in pair} != {
            pair_index * 2,
            pair_index * 2 + 1,
        }:
            errors.append(f"pair_{pair_index}_game_indices_mismatch")
        by_black_slot = {str(record.get("black_slot")): record for record in pair}
        if set(by_black_slot) != {"A", "B"}:
            errors.append(f"pair_{pair_index}_does_not_swap_colors")
            continue
        first = by_black_slot["A"]
        second = by_black_slot["B"]
        for key in ("seed", "grid_size", "superko_mode"):
            if first.get(key) != second.get(key):
                errors.append(f"pair_{pair_index}_{key}_mismatch")
        if first.get("black_agent") != second.get("white_agent"):
            errors.append(f"pair_{pair_index}_agent_a_identity_mismatch")
        if first.get("white_agent") != second.get("black_agent"):
            errors.append(f"pair_{pair_index}_agent_b_identity_mismatch")
        if first.get("black_policy_seed") != second.get("white_policy_seed"):
            errors.append(f"pair_{pair_index}_agent_a_policy_seed_mismatch")
        if first.get("white_policy_seed") != second.get("black_policy_seed"):
            errors.append(f"pair_{pair_index}_agent_b_policy_seed_mismatch")
        if base_seed is not None:
            pair_seed = base_seed + pair_index
            expected_a_seed = pair_seed * 2 + 10_001
            expected_b_seed = pair_seed * 2 + 20_001
            if first.get("seed") != pair_seed or second.get("seed") != pair_seed:
                errors.append(f"pair_{pair_index}_seed_not_derived_from_base")
            if (
                first.get("black_policy_seed") != expected_a_seed
                or first.get("white_policy_seed") != expected_b_seed
                or second.get("black_policy_seed") != expected_b_seed
                or second.get("white_policy_seed") != expected_a_seed
            ):
                errors.append(f"pair_{pair_index}_policy_seeds_not_derived")
        for record in pair:
            if record.get("grid_size") != grid_size:
                errors.append(f"pair_{pair_index}_grid_size_summary_mismatch")
                break
        for record in pair:
            if record.get("superko_mode") != superko_mode:
                errors.append(f"pair_{pair_index}_superko_mode_summary_mismatch")
                break
    return errors


def _is_random_agent_b(summary: Mapping[str, Any]) -> bool:
    metadata = summary.get("agent_b_metadata")
    if isinstance(metadata, Mapping):
        class_name = metadata.get("class")
        return class_name == D13_RANDOM_AGENT_CLASS
    return False


def _frozen_neural_config(
    summary: Mapping[str, Any],
    slot: str,
) -> Mapping[str, Any] | None:
    metadata = summary.get(f"agent_{slot.lower()}_metadata")
    if not isinstance(metadata, Mapping):
        return None
    class_name = metadata.get("class")
    config = metadata.get("config")
    if (
        not isinstance(class_name, str)
        or class_name != D13_NEURAL_AGENT_CLASS
        or not isinstance(config, Mapping)
    ):
        return None
    checkpoint = config.get("checkpoint")
    if not isinstance(checkpoint, Mapping):
        return None
    hashes = (
        checkpoint.get("sha256"),
        checkpoint.get("config_hash"),
        checkpoint.get("source_hash"),
    )
    if not all(
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value.lower())
        for value in hashes
    ):
        return None
    return config


def _d13_neural_diagnostic_errors(
    records: Sequence[Mapping[str, Any]],
    neural_config: Mapping[str, Any],
) -> list[str]:
    """Bind every formal D13 candidate decision to its frozen checkpoint/search."""

    checkpoint = neural_config.get("checkpoint")
    search = neural_config.get("search")
    if not isinstance(checkpoint, Mapping) or not isinstance(search, Mapping):
        return ["d13_candidate_metadata_missing_for_diagnostics"]
    expected = {
        "algorithm": "neural_puct",
        "model_kind": D13_FORMAL_MODEL_KIND,
        "checkpoint_sha256": checkpoint.get("sha256"),
        "train_superko_mode": D13_FORMAL_SUPERKO_MODE,
        "eval_superko_mode": D13_FORMAL_SUPERKO_MODE,
        "superko_mode_override": False,
        "allow_superko_mode_override": False,
        "simulations": D13_FORMAL_PUCT_SIMULATIONS,
        "temperature": D13_FORMAL_TEMPERATURE,
        "root_visit_sum": D13_FORMAL_PUCT_SIMULATIONS,
    }
    errors: list[str] = []
    candidate_decisions = 0
    for game_index, record in enumerate(records):
        candidate_actor = "BLACK" if record.get("black_slot") == "A" else "WHITE"
        actions = record.get("actions")
        if not isinstance(actions, Sequence) or isinstance(actions, (str, bytes)):
            errors.append(f"game_{game_index}_actions_missing_for_diagnostics")
            continue
        for action_index, action in enumerate(actions):
            if not isinstance(action, Mapping) or action.get("actor") != candidate_actor:
                continue
            candidate_decisions += 1
            diagnostics = action.get("diagnostics")
            if not isinstance(diagnostics, Mapping):
                errors.append(
                    f"game_{game_index}_action_{action_index}_candidate_diagnostics_missing"
                )
                continue
            mismatched = [
                field
                for field, value in expected.items()
                if diagnostics.get(field) != value
            ]
            if diagnostics.get("selected_action") != action.get("action"):
                mismatched.append("selected_action")
            if mismatched:
                errors.append(
                    f"game_{game_index}_action_{action_index}_candidate_diagnostics_mismatch:"
                    + ",".join(sorted(set(mismatched)))
                )
    if candidate_decisions == 0:
        errors.append("d13_candidate_has_no_persisted_decisions")
    return errors


def evaluate_arena_gate(
    summary: Mapping[str, Any],
    games: Iterable[GameRecord | Mapping[str, Any]],
    config: ArenaGateConfig,
) -> dict[str, Any]:
    """Recompute one gate from summary and full action records.

    Every formal invocation replays all games, verifies the two-game pairing,
    recomputes scores, and binds the decision to canonical SHA-256 hashes of
    the supplied summary and game records.
    """

    summary_data = dict(summary)
    records = [_record_dict(record) for record in games]
    reasons: list[str] = []
    checks: dict[str, bool] = {}

    try:
        games_requested = int(summary_data["games_requested"])
    except (KeyError, TypeError, ValueError):
        games_requested = -1
    checks["requested_games_exact"] = (
        games_requested == config.games_required == len(records)
    )
    if not checks["requested_games_exact"]:
        reasons.append("requested_games_not_exact")

    indices = [record.get("game_index") for record in records]
    checks["game_indices_contiguous"] = indices == list(range(len(records)))
    if not checks["game_indices_contiguous"]:
        reasons.append("game_indices_not_contiguous")

    a_as_black = sum(record.get("black_slot") == "A" for record in records)
    a_as_white = sum(record.get("white_slot") == "A" for record in records)
    color_balanced = (
        len(records) % 2 == 0
        and a_as_black == a_as_white == len(records) // 2
    )
    checks["color_balanced"] = color_balanced or not config.require_color_balance
    if not checks["color_balanced"]:
        reasons.append("color_balance_failed")

    summary_agent_a = summary_data.get("agent_a")
    summary_agent_b = summary_data.get("agent_b")
    identities_match = all(
        (
            record.get("black_agent") == summary_agent_a
            and record.get("white_agent") == summary_agent_b
        )
        if record.get("black_slot") == "A"
        else (
            record.get("black_agent") == summary_agent_b
            and record.get("white_agent") == summary_agent_a
        )
        for record in records
    )
    checks["summary_agent_identities_match_games"] = identities_match
    if not identities_match:
        reasons.append("summary_agent_identity_mismatch")

    pairing_errors = (
        _pairing_errors(
            records,
            base_seed=summary_data.get("base_seed"),
            grid_size=summary_data.get("grid_size"),
            superko_mode=summary_data.get("superko_mode"),
        )
        if config.require_paired_seeds
        else []
    )
    checks["paired_seeds_and_colors"] = not pairing_errors
    reasons.extend(pairing_errors)

    replay_errors: list[str] = []
    if config.verify_replays:
        for index, record in enumerate(records):
            try:
                replay_game_record(record)
            except (KeyError, TypeError, ValueError, RuntimeError) as exc:
                replay_errors.append(f"game_{index}_replay_failed:{type(exc).__name__}")
    checks["action_replays_valid"] = not replay_errors
    reasons.extend(replay_errors)

    scores = [_agent_a_score(record) for record in records]
    wins = sum(score == 1.0 for score in scores)
    losses = sum(score == 0.0 for score in scores)
    draws = sum(score == 0.5 for score in scores)
    truncated = sum(score is None for score in scores)
    completed = wins + losses + draws
    score_rate = None if completed == 0 else (wins + 0.5 * draws) / completed
    interval = score_wilson_interval(wins, losses, draws)

    expected_counts = {
        "games_completed": completed,
        "truncated_games": truncated,
        "a_wins": wins,
        "a_losses": losses,
        "draws": draws,
    }
    count_mismatches = []
    for key, expected in expected_counts.items():
        try:
            observed = int(summary_data[key])
        except (KeyError, TypeError, ValueError):
            observed = None
        if observed != expected:
            count_mismatches.append(key)
    checks["summary_counts_match"] = not count_mismatches
    if count_mismatches:
        reasons.append("summary_count_mismatch:" + ",".join(count_mismatches))

    expected_color_stats = {
        "a_as_black": {"wins": 0, "losses": 0, "draws": 0, "truncated": 0},
        "a_as_white": {"wins": 0, "losses": 0, "draws": 0, "truncated": 0},
    }
    for record, score in zip(records, scores):
        key = "a_as_black" if record.get("black_slot") == "A" else "a_as_white"
        outcome = (
            "truncated"
            if score is None
            else "wins"
            if score == 1.0
            else "draws"
            if score == 0.5
            else "losses"
        )
        expected_color_stats[key][outcome] += 1
    color_stats_match = all(
        summary_data.get(key) == expected
        for key, expected in expected_color_stats.items()
    )
    checks["summary_color_stats_match"] = color_stats_match
    if not color_stats_match:
        reasons.append("summary_color_stats_mismatch")

    summary_rate = summary_data.get("a_score_rate")
    rate_matches = (
        summary_rate is None and score_rate is None
    ) or (
        score_rate is not None
        and isinstance(summary_rate, (int, float))
        and not isinstance(summary_rate, bool)
        and math.isclose(float(summary_rate), score_rate, rel_tol=0.0, abs_tol=1e-12)
    )
    checks["summary_score_rate_matches"] = rate_matches
    if not rate_matches:
        reasons.append("summary_score_rate_mismatch")

    summary_interval = summary_data.get("a_score_ci95_wilson")
    interval_matches = (
        interval is None and summary_interval is None
    ) or (
        interval is not None
        and isinstance(summary_interval, (list, tuple))
        and len(summary_interval) == 2
        and all(
            isinstance(value, (int, float)) and not isinstance(value, bool)
            for value in summary_interval
        )
        and all(
            math.isclose(float(observed), expected, rel_tol=0.0, abs_tol=1e-12)
            for observed, expected in zip(summary_interval, interval)
        )
    )
    checks["summary_wilson_interval_matches"] = interval_matches
    if not interval_matches:
        reasons.append("summary_wilson_interval_mismatch")

    checks["completed_games_met"] = completed >= config.completed_games_required
    if not checks["completed_games_met"]:
        reasons.append("too_few_completed_games")
    checks["truncation_limit_met"] = truncated <= config.maximum_truncated_games
    if not checks["truncation_limit_met"]:
        reasons.append("too_many_truncated_games")

    if config.minimum_score_rate is None:
        checks["minimum_score_rate_met"] = True
    else:
        checks["minimum_score_rate_met"] = (
            score_rate is not None and score_rate >= config.minimum_score_rate
        )
        if not checks["minimum_score_rate_met"]:
            reasons.append("minimum_score_rate_not_met")

    if config.minimum_wilson_lower_bound_exclusive is None:
        checks["wilson_lower_bound_met"] = True
    else:
        checks["wilson_lower_bound_met"] = (
            interval is not None
            and interval[0] > config.minimum_wilson_lower_bound_exclusive
        )
        if not checks["wilson_lower_bound_met"]:
            reasons.append("wilson_lower_bound_not_met")

    if config.gate_kind == "beat_random":
        checks["opponent_is_random"] = _is_random_agent_b(summary_data)
        if not checks["opponent_is_random"]:
            reasons.append("agent_b_is_not_random")
    else:
        checks["opponent_is_random"] = True

    neural_a = _frozen_neural_config(summary_data, "A")
    checks["agent_a_is_frozen_neural_checkpoint"] = (
        neural_a is not None or config.evidence_tier != "formal"
    )
    if not checks["agent_a_is_frozen_neural_checkpoint"]:
        reasons.append("agent_a_is_not_a_frozen_neural_checkpoint")
    if neural_a is not None:
        agent_a_rule_matched = (
            neural_a.get("train_superko_mode", neural_a.get("superko_mode"))
            == summary_data.get("superko_mode")
            and not bool(neural_a.get("allow_superko_mode_override", False))
        )
    else:
        agent_a_rule_matched = config.evidence_tier != "formal"
    checks["agent_a_training_and_evaluation_rules_match"] = agent_a_rule_matched
    if not agent_a_rule_matched:
        reasons.append("agent_a_training_and_evaluation_rules_mismatch")
    if neural_a is not None:
        checkpoint_a = neural_a.get("checkpoint")
        gradient_steps = (
            checkpoint_a.get("gradient_steps")
            if isinstance(checkpoint_a, Mapping)
            else None
        )
        trained_sizes = neural_a.get("trained_board_sizes")
        agent_a_training_ready = (
            isinstance(gradient_steps, int)
            and not isinstance(gradient_steps, bool)
            and gradient_steps >= 1
            and isinstance(trained_sizes, (list, tuple))
            and summary_data.get("grid_size") in trained_sizes
        )
    else:
        agent_a_training_ready = config.evidence_tier != "formal"
    checks["agent_a_checkpoint_has_training_on_eval_size"] = (
        agent_a_training_ready or config.evidence_tier != "formal"
    )
    if not checks["agent_a_checkpoint_has_training_on_eval_size"]:
        reasons.append("agent_a_checkpoint_not_trained_on_eval_size")

    protocol = summary_data.get("evaluation_protocol")
    formal_protocol_valid = (
        isinstance(protocol, Mapping)
        and protocol.get("root_noise") is False
        and protocol.get("strict_source_validation") is True
    )
    checks["formal_inference_protocol_recorded"] = (
        formal_protocol_valid or config.evidence_tier != "formal"
    )
    if not checks["formal_inference_protocol_recorded"]:
        reasons.append("formal_inference_protocol_missing_or_unsafe")

    is_d13_formal = (
        config.evidence_tier == "formal" and config.gate_kind == "beat_random"
    )
    if is_d13_formal and neural_a is not None:
        checkpoint_a = neural_a.get("checkpoint")
        search_a = neural_a.get("search")
        d13_candidate_valid = (
            neural_a.get("model_kind") == D13_FORMAL_MODEL_KIND
            and isinstance(checkpoint_a, Mapping)
            and isinstance(checkpoint_a.get("games_completed"), int)
            and not isinstance(checkpoint_a.get("games_completed"), bool)
            and checkpoint_a["games_completed"] >= D13_FORMAL_MIN_SELF_PLAY_GAMES
            and isinstance(checkpoint_a.get("gradient_steps"), int)
            and not isinstance(checkpoint_a.get("gradient_steps"), bool)
            and checkpoint_a["gradient_steps"] >= D13_FORMAL_MIN_GRADIENT_STEPS
            and search_a
            == {
                "simulations": D13_FORMAL_PUCT_SIMULATIONS,
                "c_puct": D13_FORMAL_C_PUCT,
                "temperature": D13_FORMAL_TEMPERATURE,
            }
        )
    else:
        d13_candidate_valid = not is_d13_formal
    checks["d13_formal_topology_final_checkpoint"] = d13_candidate_valid
    if not d13_candidate_valid:
        reasons.append("d13_formal_candidate_is_not_the_frozen_topology_checkpoint")

    if is_d13_formal:
        d13_runtime_valid = (
            summary_data.get("grid_size") == D13_FORMAL_GRID_SIZE
            and summary_data.get("max_plies") == D13_FORMAL_MAX_PLIES
            and summary_data.get("base_seed") == D13_FORMAL_SEED
            and summary_data.get("superko_mode") == D13_FORMAL_SUPERKO_MODE
            and isinstance(protocol, Mapping)
            and protocol.get("gate_kind") == "beat_random"
            and protocol.get("evidence_tier") == "formal"
            and protocol.get("shared_puct_search")
            == {
                "simulations": D13_FORMAL_PUCT_SIMULATIONS,
                "c_puct": D13_FORMAL_C_PUCT,
                "temperature": D13_FORMAL_TEMPERATURE,
            }
            and protocol.get("allow_superko_mode_override") is False
        )
    else:
        d13_runtime_valid = True
    checks["d13_formal_evaluation_protocol_frozen"] = d13_runtime_valid
    if not d13_runtime_valid:
        reasons.append("d13_formal_evaluation_protocol_mismatch")

    diagnostic_errors = (
        _d13_neural_diagnostic_errors(records, neural_a)
        if is_d13_formal and neural_a is not None
        else []
    )
    checks["d13_formal_decisions_bound_to_checkpoint"] = not diagnostic_errors
    reasons.extend(diagnostic_errors)

    if config.gate_kind == "promote_champion":
        neural_b = _frozen_neural_config(summary_data, "B")
        checks["agent_b_is_frozen_neural_checkpoint"] = (
            neural_b is not None or config.evidence_tier != "formal"
        )
        if not checks["agent_b_is_frozen_neural_checkpoint"]:
            reasons.append("agent_b_is_not_a_frozen_neural_checkpoint")

        if neural_a is not None and neural_b is not None:
            checkpoint_a = neural_a["checkpoint"]
            checkpoint_b = neural_b["checkpoint"]
            distinct_checkpoints = checkpoint_a["sha256"] != checkpoint_b["sha256"]
            matched_protocol = all(
                neural_a.get(key) == neural_b.get(key)
                for key in (
                    "model_kind",
                    "observation_mode",
                    "train_superko_mode",
                    "allow_superko_mode_override",
                    "search",
                )
            )
        else:
            distinct_checkpoints = config.evidence_tier != "formal"
            matched_protocol = config.evidence_tier != "formal"
        checks["candidate_and_champion_checkpoints_distinct"] = distinct_checkpoints
        checks["candidate_and_champion_protocol_matched"] = matched_protocol
        if not distinct_checkpoints:
            reasons.append("candidate_and_champion_checkpoints_not_distinct")
        if not matched_protocol:
            reasons.append("candidate_and_champion_protocol_mismatch")

    passed = all(checks.values())
    report = {
        "schema": {"name": GATE_SCHEMA_NAME, "version": GATE_SCHEMA_VERSION},
        "config": config.to_dict(),
        "evidence_tier": config.evidence_tier,
        "gate_kind": config.gate_kind,
        "passed": passed,
        "claim_eligible": passed and config.evidence_tier == "formal",
        "reasons": reasons,
        "checks": checks,
        "observed": {
            "games_requested": games_requested,
            "games_in_artifact": len(records),
            "games_completed": completed,
            "truncated_games": truncated,
            "a_as_black_games": a_as_black,
            "a_as_white_games": a_as_white,
            "color_pairs_verified": (
                len(records) // 2 if not pairing_errors else 0
            ),
            "color_balance": (
                "paired_swap_same_seed"
                if color_balanced and not pairing_errors
                else "invalid"
            ),
            "replay_verified_games": len(records) - len(replay_errors),
            "a_wins": wins,
            "a_losses": losses,
            "draws": draws,
            "a_score_rate": score_rate,
            "a_score_ci95_wilson": None if interval is None else list(interval),
            "eval_size": summary_data.get("grid_size"),
            "base_seed": summary_data.get("base_seed"),
            "max_plies": summary_data.get("max_plies"),
            "superko_mode": summary_data.get("superko_mode"),
            "pairing_errors": pairing_errors,
            "replay_errors": replay_errors,
        },
        "agent_a": {
            "name": summary_data.get("agent_a"),
            "metadata": summary_data.get("agent_a_metadata"),
        },
        "agent_b": {
            "name": summary_data.get("agent_b"),
            "metadata": summary_data.get("agent_b_metadata"),
        },
        "artifact_binding": {
            "summary_sha256": _canonical_hash(summary_data),
            "games_sha256": _canonical_hash(records),
        },
    }
    return report


def evaluate_matchup_gate(
    result: MatchupResult,
    config: ArenaGateConfig,
) -> dict[str, Any]:
    """Convenience wrapper for an in-memory arena result."""

    return evaluate_arena_gate(result.summary, result.games, config)


def write_gate_report(
    report: Mapping[str, Any],
    path: str | Path,
    *,
    overwrite: bool = False,
) -> Path:
    """Atomically persist one finite JSON gate report."""

    destination = Path(path)
    if destination.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite arena gate: {destination}")
    schema = report.get("schema")
    if schema != {"name": GATE_SCHEMA_NAME, "version": GATE_SCHEMA_VERSION}:
        raise ValueError("report has an unsupported arena-gate schema")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                dict(report),
                handle,
                indent=2,
                sort_keys=True,
                ensure_ascii=False,
                allow_nan=False,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination


__all__ = [
    "ArenaGateConfig",
    "D13_FORMAL_C_PUCT",
    "D13_FORMAL_GAMES",
    "D13_FORMAL_GRID_SIZE",
    "D13_FORMAL_MAX_PLIES",
    "D13_FORMAL_MIN_GRADIENT_STEPS",
    "D13_FORMAL_MIN_SELF_PLAY_GAMES",
    "D13_FORMAL_MODEL_KIND",
    "D13_FORMAL_PUCT_SIMULATIONS",
    "D13_FORMAL_SEED",
    "D13_FORMAL_SUPERKO_MODE",
    "D13_FORMAL_TEMPERATURE",
    "D13_NEURAL_AGENT_CLASS",
    "D13_RANDOM_AGENT_CLASS",
    "EVIDENCE_TIERS",
    "GATE_KINDS",
    "GATE_SCHEMA_NAME",
    "GATE_SCHEMA_VERSION",
    "evaluate_arena_gate",
    "evaluate_matchup_gate",
    "score_wilson_interval",
    "write_gate_report",
]
