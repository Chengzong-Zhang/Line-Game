from __future__ import annotations

import argparse
import json
import random
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from lifeline_rl import LifelineGame, Player
from scripts import run_superko_policy_matrix as matrix


class SuperkoPolicyMatrixTests(unittest.TestCase):
    def _args(self) -> argparse.Namespace:
        return argparse.Namespace(
            minimax_move_cap=4,
            mcts_simulations=1,
            mcts_rollout_depth=0,
            mcts_exploration=2**0.5,
            cycle_max_depth=1,
            cycle_branch_limit=1,
            cycle_node_budget=1,
            max_plies=20,
        )

    def test_frozen_seed_derivation_and_dry_run_are_disjoint(self) -> None:
        derived = tuple(matrix.frozen_seed(index) for index in range(5))
        self.assertEqual(derived, matrix.NEW_SEEDS)
        self.assertEqual(len(set(derived)), 5)
        self.assertNotIn(matrix.DRY_RUN_SEED, derived)

    def test_dry_run_refuses_a_frozen_seed(self) -> None:
        with patch.object(
            sys,
            "argv",
            ["runner", "--seeds", str(matrix.NEW_SEEDS[0]), "--policies", "random"],
        ):
            with self.assertRaises(SystemExit):
                matrix.parse_args()

    def test_formal_mode_refuses_any_budget_change(self) -> None:
        unused = Path("results/validation/__formal_preflight_test_must_not_exist.json")
        with patch.object(
            sys,
            "argv",
            [
                "runner",
                "--purpose",
                "five_seed_extension",
                "--mcts-simulations",
                "15",
                "--allow-checkpoint-source-migration",
                "--output",
                str(unused),
            ],
        ):
            with self.assertRaises(SystemExit):
                matrix.parse_args()

    def test_keyed_random_is_order_independent_at_a_matched_state(self) -> None:
        game = LifelineGame(6)
        agent = matrix.KeyedRandomAgent()
        before = game.clone()
        first = agent.select_action(game, random.Random(12345))
        second = agent.select_action(game, random.Random(12345))
        self.assertEqual(first, second)
        self.assertIn(first, matrix.legal_actions(game))
        self.assertEqual(game.clone(), before)

    def test_random_block_has_four_games_and_paired_decision_seeds(self) -> None:
        args = self._args()
        block = matrix._run_block(
            policy="random",
            grid_size=6,
            master_seed=matrix.DRY_RUN_SEED,
            block_index=0,
            args=args,
            frozen_rl_agent=None,
        )
        self.assertEqual(len(block["orientations"]), 2)
        for orientation in block["orientations"]:
            enforce = orientation["enforce"]
            observe = orientation["observe"]
            self.assertEqual(enforce["focal_color"], observe["focal_color"])
            shared = min(len(enforce["actions"]), len(observe["actions"]))
            for ply in range(shared):
                if (
                    enforce["actions"][ply]["actor"]
                    != observe["actions"][ply]["actor"]
                ):
                    break
                self.assertEqual(
                    enforce["actions"][ply]["decision_seed"],
                    observe["actions"][ply]["decision_seed"],
                )
        json.dumps(block, allow_nan=False)

    def test_positive_control_rejects_and_accepts_the_same_candidate(self) -> None:
        control = matrix._positive_control()
        self.assertTrue(control["passed"])
        self.assertEqual(control["enforce"]["reason"], "SUPERKO_VIOLATION")
        self.assertTrue(control["enforce"]["transactional_state_unchanged"])
        self.assertTrue(control["observe"]["success"])
        self.assertTrue(control["guided_loop"]["valid"])
        self.assertTrue(control["guided_loop"]["closes_root_position"])
        replay = control["observe_two_loop_replay"]
        self.assertEqual(
            replay["loop_end_rule_position_sha256"],
            [replay["stage_rule_position_sha256"]] * 2,
        )
        self.assertEqual(replay["closing_actions_flagged_repeat"], [True, True])
        self.assertEqual(
            control["instrumentation"]["comparison"]["first_aligned_trigger_ply"],
            0,
        )

    def test_comparison_detects_action_position_and_outcome_divergence(self) -> None:
        enforce = {
            "actions": [
                {
                    "actor": Player.BLACK.value,
                    "action": 1,
                    "position_before_sha256": "root",
                    "mode_normalized_state_before_sha256": "full-root",
                    "position_after_sha256": "a",
                    "mode_normalized_state_after_sha256": "full-a",
                    "would_violate_superko_candidates": [],
                }
            ],
            "truncated": False,
            "winner": Player.BLACK.value,
            "focal_score": 1.0,
            "plies": 1,
        }
        observe = {
            "actions": [
                {
                    "actor": Player.BLACK.value,
                    "action": 2,
                    "position_before_sha256": "root",
                    "mode_normalized_state_before_sha256": "full-root",
                    "position_after_sha256": "b",
                    "mode_normalized_state_after_sha256": "full-b",
                    "would_violate_superko_candidates": [],
                }
            ],
            "truncated": False,
            "winner": Player.WHITE.value,
            "focal_score": 0.0,
            "plies": 1,
        }
        result = matrix._compare_games(enforce, observe)
        self.assertTrue(result["trajectory_diverged"])
        self.assertEqual(result["first_action_divergence_ply"], 0)
        self.assertEqual(result["first_position_divergence_after_ply"], 0)
        self.assertFalse(result["outcome_agrees"])
        self.assertEqual(result["focal_score_observe_minus_enforce"], -1.0)

    def test_truncations_are_bounded_not_scored_as_draws(self) -> None:
        blocks = [
            {
                "orientations": [
                    {
                        "enforce": {"focal_score": None},
                        "observe": {"focal_score": 1.0},
                    },
                    {
                        "enforce": {"focal_score": 0.0},
                        "observe": {"focal_score": None},
                    },
                ]
            }
        ]
        bounds = matrix._score_bounds(blocks)
        self.assertEqual(bounds["identified_sample_mean_interval"], [0.0, 1.0])
        self.assertFalse(bounds["sampling_uncertainty_included"])

    def test_hierarchical_score_bootstrap_retains_complete_orientation(self) -> None:
        blocks = [
            {
                "orientations": [
                    {"comparison": {"effect": 0.5}},
                    {"comparison": {"effect": None}},
                ]
            }
        ]
        result = matrix._hierarchical_pair_bootstrap(
            blocks, field="effect", seed=7, resamples=20
        )
        self.assertEqual(result["retained_orientation_pairs"], 1)
        self.assertEqual(result["mean"], 0.5)
        self.assertEqual(result["ci95"], [0.5, 0.5])

    def test_rejoined_projection_is_not_mislabeled_as_aligned_trigger(self) -> None:
        def entry(action: int, before: str, after: str, repeats: list[int]):
            return {
                "actor": Player.BLACK.value,
                "action": action,
                "position_before_sha256": before,
                "position_after_sha256": after,
                "mode_normalized_state_before_sha256": f"full-{before}",
                "mode_normalized_state_after_sha256": f"full-{after}",
                "would_violate_superko_candidates": repeats,
            }

        enforce = {
            "actions": [entry(1, "root", "left", []), entry(3, "same", "end", [9])],
            "truncated": False,
            "winner": Player.BLACK.value,
            "focal_score": 1.0,
            "plies": 2,
        }
        observe = {
            "actions": [entry(2, "root", "right", []), entry(3, "same", "end", [9])],
            "truncated": False,
            "winner": Player.BLACK.value,
            "focal_score": 1.0,
            "plies": 2,
        }
        result = matrix._compare_games(enforce, observe)
        self.assertTrue(result["trajectory_diverged"])
        self.assertEqual(result["aligned_trigger_plies"], [])


if __name__ == "__main__":
    unittest.main()
