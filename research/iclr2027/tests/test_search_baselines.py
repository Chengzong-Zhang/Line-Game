from __future__ import annotations

import random
import unittest
from unittest.mock import patch

from lifeline_rl import (
    AGENT_KINDS,
    GreedyAgent,
    LifelineGame,
    MCTSAgent,
    MinimaxAgent,
    MinimaxConfig,
    RandomAgent,
    make_agent,
)
from lifeline_rl.agents import Agent, apply_action, heuristic_score

from .test_core import HISTORY_A


class SearchBaselineTests(unittest.TestCase):
    def test_all_factory_agents_share_the_runtime_interface_and_return_legal_actions(self) -> None:
        game = LifelineGame(5)
        for kind in AGENT_KINDS:
            with self.subTest(kind=kind):
                agent = make_agent(
                    kind,
                    mcts_simulations=2,
                    mcts_rollout_depth=2,
                )
                self.assertIsInstance(agent, Agent)
                before = game.clone()
                action = agent.select_action(game, random.Random(42))
                self.assertIn(action, [*game.legal_moves(), None])
                self.assertEqual(game.clone(), before)
                self.assertIsInstance(agent.diagnostics(), dict)

    def test_factory_has_all_frozen_baseline_kinds(self) -> None:
        self.assertEqual(
            AGENT_KINDS,
            ("random", "greedy", "minimax-2", "minimax-3", "mcts"),
        )
        self.assertIsInstance(make_agent("random"), RandomAgent)
        self.assertIsInstance(make_agent("greedy"), GreedyAgent)
        self.assertIsInstance(make_agent("minimax-2"), MinimaxAgent)
        self.assertIsInstance(make_agent("mcts", mcts_simulations=1), MCTSAgent)
        with self.assertRaises(ValueError):
            make_agent("unknown")

    def test_greedy_is_deterministic_legal_and_does_not_use_nonterminal_exact_territory(self) -> None:
        game = LifelineGame(5)
        before = game.clone()
        with patch.object(
            LifelineGame,
            "_update_territories",
            side_effect=AssertionError("non-terminal exact territory was called"),
        ):
            first = GreedyAgent().select_action(game, random.Random(1))
            second = GreedyAgent().select_action(game, random.Random(999))
        self.assertEqual(first, second)
        self.assertIn(first, [*game.legal_moves(), None])
        self.assertEqual(game.clone(), before)

    def test_minimax_depths_two_and_three_are_deterministic_legal_and_nonmutating(self) -> None:
        game = LifelineGame(5)
        before = game.clone()
        for depth in (2, 3):
            with self.subTest(depth=depth):
                first_agent = MinimaxAgent(MinimaxConfig(depth=depth))
                second_agent = MinimaxAgent(MinimaxConfig(depth=depth))
                first = first_agent.select_action(game, random.Random(1))
                second = second_agent.select_action(game, random.Random(999))
                self.assertEqual(first, second)
                self.assertIn(first, [*game.legal_moves(), None])
                self.assertEqual(game.clone(), before)
                self.assertLessEqual(first_agent.last_search.max_point_branching, 20)
                if depth == 3:
                    self.assertGreater(first_agent.last_search.alpha_beta_cutoffs, 0)

    def test_minimax_public_move_cap_limits_points_but_keeps_pass(self) -> None:
        game = LifelineGame(15)
        self.assertGreater(len(game.legal_moves()), 20)
        agent = MinimaxAgent(MinimaxConfig(depth=2, move_cap=20))
        actions = agent.ordered_actions(game)
        self.assertEqual(len([action for action in actions if action is not None]), 20)
        self.assertIsNone(actions[-1])

    def test_minimax_snapshot_preserves_complete_superko_history(self) -> None:
        game = LifelineGame(5)
        game.replay(HISTORY_A)
        self.assertGreater(len(game.history_hashes), 1)
        before = game.clone()
        MinimaxAgent(MinimaxConfig(depth=2)).search(game)
        self.assertEqual(game.clone(), before)
        self.assertEqual(game.history_hashes, set(before.history_hashes))

    def test_depth_two_uses_the_opponents_minimum_not_cooperative_maximum(self) -> None:
        game = LifelineGame(5)
        agent = MinimaxAgent(MinimaxConfig(depth=2))
        result = agent.search(game)
        root_snapshot = game.clone()
        root_player = game.current_player
        worker = LifelineGame(5)

        root_action = (1, 0)
        worker.restore(root_snapshot)
        apply_action(worker, root_action)
        opponent_snapshot = worker.clone()
        response_values: list[float] = []
        for response in agent.ordered_actions(worker):
            worker.restore(opponent_snapshot)
            apply_action(worker, response)
            response_values.append(heuristic_score(worker, root_player))

        observed = next(item.value for item in result.action_scores if item.action == root_action)
        self.assertEqual(observed, min(response_values))
        self.assertNotEqual(observed, max(response_values))

    def test_invalid_minimax_configuration_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            MinimaxConfig(depth=0)
        with self.assertRaises(ValueError):
            MinimaxConfig(move_cap=0)
        with self.assertRaises(TypeError):
            MinimaxConfig(depth=2.5)
        with self.assertRaises(TypeError):
            MinimaxConfig(move_cap=True)


if __name__ == "__main__":
    unittest.main()
