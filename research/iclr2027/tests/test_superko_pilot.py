from __future__ import annotations

import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from lifeline_rl import Player, PointState
from scripts import run_superko_ablation as pilot


def _mode_record(outcome: str, *, plies: int = 10) -> dict[str, Any]:
    if outcome == "TRUNCATED":
        return {
            "truncated": True,
            "winner": None,
            "black_score": None,
            "plies": plies,
            "triggered": False,
            "selected_repetition": False,
        }
    scores = {
        Player.BLACK.value: 1.0,
        "DRAW": 0.5,
        Player.WHITE.value: 0.0,
    }
    return {
        "truncated": False,
        "winner": outcome,
        "black_score": scores[outcome],
        "plies": plies,
        "triggered": False,
        "selected_repetition": False,
    }


def _episode(
    enforce_outcome: str,
    observe_outcome: str,
    *,
    enforce_plies: int = 10,
    observe_plies: int = 10,
) -> dict[str, Any]:
    return {
        "trajectory_diverged": enforce_outcome != observe_outcome,
        "first_action_divergence_ply": None,
        "first_position_divergence_after_ply": None,
        "enforce": _mode_record(enforce_outcome, plies=enforce_plies),
        "observe": _mode_record(observe_outcome, plies=observe_plies),
    }


class _FakeGame:
    def __init__(
        self,
        valid_positions: list[tuple[int, int]],
        legal: list[tuple[int, int]],
    ) -> None:
        self.valid_positions = valid_positions
        self._legal = legal
        self.current_player = Player.BLACK
        self.consecutive_skips = 0

    def legal_moves(self) -> list[tuple[int, int]]:
        return list(self._legal)

    def get_state(self, _point: tuple[int, int]) -> PointState:
        return PointState.EMPTY


class _ForcedDivergenceGame:
    def __init__(self, _grid_size: int, *, superko_mode: str) -> None:
        self.superko_mode = superko_mode
        self.valid_positions = [(0, 0), (0, 1)]
        self.point_to_index = {
            point: index for index, point in enumerate(self.valid_positions)
        }
        self.num_points = len(self.valid_positions)
        self.grid = [int(PointState.EMPTY)] * self.num_points
        self.edges = {Player.BLACK: set(), Player.WHITE: set()}
        self.current_player = Player.BLACK
        self.consecutive_skips = 0
        self.game_over = False

    def legal_moves(self) -> list[tuple[int, int]]:
        return [(0, 0)] if self.superko_mode == "enforce" else [(0, 1)]

    def would_violate_superko_moves(self) -> list[tuple[int, int]]:
        return []

    def get_state(self, _point: tuple[int, int]) -> PointState:
        return PointState.EMPTY

    def play_move(self, point: tuple[int, int]) -> SimpleNamespace:
        self.grid[self.point_to_index[point]] = int(PointState.BLACK_NODE)
        self.game_over = True
        return SimpleNamespace(
            success=True,
            reason=None,
            would_violate_superko=False,
        )

    def skip_turn(self) -> SimpleNamespace:
        self.game_over = True
        return SimpleNamespace(
            success=True,
            reason=None,
            would_violate_superko=False,
        )

    def winner(self) -> Player:
        return Player.BLACK


class CanonicalCouplingTests(unittest.TestCase):
    def test_keyed_priority_is_deterministic_and_order_independent(self) -> None:
        candidates = [(0, 1), (1, 1), (2, 0), (2, 2), (3, 1)]
        priority_key = 0x123456789ABCDEF
        expected = pilot._select_by_keyed_priority(
            candidates,
            priority_key=priority_key,
        )
        self.assertEqual(
            pilot._select_by_keyed_priority(
                list(reversed(candidates)),
                priority_key=priority_key,
            ),
            expected,
        )
        self.assertEqual(
            pilot._select_by_keyed_priority(
                candidates,
                priority_key=priority_key,
            ),
            expected,
        )

    def test_adding_lower_priority_action_preserves_shared_choice(self) -> None:
        priority_key = 20260825
        universe = [(row, column) for row in range(5) for column in range(3)]
        ranked = sorted(
            universe,
            key=lambda action: pilot._keyed_action_priority(priority_key, action),
        )
        lower = ranked[0]
        winner = ranked[-1]
        other = ranked[len(ranked) // 2]
        base = [winner, other]

        self.assertEqual(
            pilot._select_by_keyed_priority(base, priority_key=priority_key),
            winner,
        )
        self.assertEqual(
            pilot._select_by_keyed_priority(
                base + [lower],
                priority_key=priority_key,
            ),
            winner,
        )

        base_game = _FakeGame(universe, base)
        augmented_game = _FakeGame(universe, base + [lower])
        common = {
            "actions_played": 1,
            "pass_draw": 1.0,
            "attack_draw": 1.0,
            "priority_key": priority_key,
            "pass_probability": 0.12,
            "attack_bias": 0.95,
        }
        self.assertEqual(pilot._choose_action(base_game, **common), (winner, False))
        self.assertEqual(
            pilot._choose_action(augmented_game, **common),
            (winner, False),
        )

    def test_preferred_tier_is_part_of_composite_priority(self) -> None:
        priority_key = 17
        actions = [(0, 1), (1, 1), (2, 0)]
        ranked = sorted(
            actions,
            key=lambda action: pilot._keyed_action_priority(priority_key, action),
        )
        lowest = ranked[0]
        highest = ranked[-1]
        self.assertEqual(
            pilot._select_by_keyed_priority(
                actions,
                priority_key=priority_key,
                preferred=[lowest],
            ),
            lowest,
        )
        self.assertNotEqual(lowest, highest)

    def test_divergent_episode_records_actions_and_shared_randomness(self) -> None:
        with patch.object(pilot, "LifelineGame", _ForcedDivergenceGame):
            result = pilot._run_episode(
                grid_size=5,
                episode=3,
                episode_seed=12345,
                max_plies=1,
                pass_probability=0.0,
                attack_bias=0.0,
            )
        self.assertTrue(result["trajectory_diverged"])
        self.assertEqual(result["first_action_divergence_ply"], 0)
        divergence = result["first_trajectory_divergence"]
        self.assertEqual(divergence["pair_ply"], 0)
        self.assertTrue(divergence["action_diverged"])
        self.assertTrue(divergence["position_diverged_after_ply"])
        self.assertEqual(
            divergence["selected_actions"]["enforce"]["action"],
            [0, 0],
        )
        self.assertEqual(
            divergence["selected_actions"]["observe"]["action"],
            [0, 1],
        )
        self.assertEqual(
            len(divergence["shared_randomness"]["priority_key_hex"]),
            32,
        )


class PilotStatisticsTests(unittest.TestCase):
    def test_relative_mean_plies_bootstrap_is_exact_for_proportional_pairs(
        self,
    ) -> None:
        result = pilot._paired_bootstrap_relative_mean(
            [10.0, 20.0, 30.0, 40.0],
            [11.0, 22.0, 33.0, 44.0],
            seed=123,
            resamples=250,
        )
        self.assertEqual(result["paired_episodes"], 4)
        self.assertAlmostEqual(result["observed_relative_difference"], 0.1)
        self.assertAlmostEqual(result["ci95"][0], 0.1)
        self.assertAlmostEqual(result["ci95"][1], 0.1)

    def test_relative_mean_plies_rejects_invalid_baseline(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite and positive"):
            pilot._paired_bootstrap_relative_mean(
                [0.0, 1.0],
                [1.0, 1.0],
                seed=1,
                resamples=10,
            )

    def test_complete_four_class_outcome_contingency(self) -> None:
        episodes = [
            _episode(enforce, observe)
            for enforce in pilot.OUTCOME_CATEGORIES
            for observe in pilot.OUTCOME_CATEGORIES
        ]
        result = pilot._outcome_contingency(episodes)
        self.assertEqual(result["categories"], list(pilot.OUTCOME_CATEGORIES))
        self.assertEqual(result["total_pairs"], 16)
        self.assertEqual(result["off_diagonal_pairs"], 12)
        for enforce in pilot.OUTCOME_CATEGORIES:
            for observe in pilot.OUTCOME_CATEGORIES:
                self.assertEqual(result["counts"][enforce][observe], 1)

    def test_truncation_score_bounds_use_every_pair(self) -> None:
        episodes = [
            _episode(Player.BLACK.value, Player.WHITE.value),
            _episode("DRAW", "TRUNCATED"),
            _episode("TRUNCATED", Player.BLACK.value),
            _episode("TRUNCATED", "TRUNCATED"),
        ]
        result = pilot._black_score_difference_sample_bounds(episodes)
        self.assertEqual(result["pairs"], 4)
        self.assertEqual(result["identified_interval"], [-0.625, 0.375])
        self.assertEqual(result["worst_case"], -0.625)
        self.assertEqual(result["best_case"], 0.375)
        self.assertFalse(result["sampling_uncertainty_included"])

    def test_pair_summary_reports_nonzero_score_rate_and_all_pair_fields(self) -> None:
        episodes = [
            _episode(Player.BLACK.value, Player.WHITE.value, observe_plies=11),
            _episode("DRAW", "DRAW", enforce_plies=20, observe_plies=22),
            _episode("TRUNCATED", Player.BLACK.value),
            _episode(Player.WHITE.value, "TRUNCATED"),
        ]
        result = pilot._summarize_pairs(episodes, base_seed=9, grid_size=6)
        nonzero = result["nonzero_black_score_difference_rate_among_complete_pairs"]
        self.assertEqual(nonzero["successes"], 1)
        self.assertEqual(nonzero["trials"], 2)
        self.assertEqual(nonzero["rate"], 0.5)
        self.assertEqual(nonzero["ci95_wilson"], pilot._wilson(1, 2))
        self.assertEqual(
            result["outcome_contingency_all_pairs"]["total_pairs"],
            4,
        )
        self.assertEqual(
            result["black_score_observe_minus_enforce_sample_bounds_all_pairs"][
                "pairs"
            ],
            4,
        )
        self.assertIn(
            "relative_mean_plies_all_pairs",
            result["paired_bootstrap_observe_minus_enforce"],
        )

    def test_zero_of_one_hundred_wilson_upper_bound_is_not_zero(self) -> None:
        interval = pilot._wilson(0, 100)
        assert interval is not None
        self.assertEqual(interval[0], 0.0)
        self.assertAlmostEqual(interval[1], 0.03699349820698568)


if __name__ == "__main__":
    unittest.main()
