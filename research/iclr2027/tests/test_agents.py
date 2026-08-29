from __future__ import annotations

import random
import unittest

from lifeline_rl import LifelineGame, MCTSAgent, MCTSConfig, Player, RandomAgent
from lifeline_rl.agents.mcts import _Node


class _LastChoice:
    @staticmethod
    def choice(sequence):
        return sequence[-1]


class AgentTests(unittest.TestCase):
    def test_random_agent_samples_pass_as_a_legal_action(self) -> None:
        game = LifelineGame(5)
        action = RandomAgent().select_action(game, _LastChoice())
        self.assertIsNone(action)

    def test_seeded_random_agent_is_reproducible(self) -> None:
        game = LifelineGame(5)
        first = RandomAgent().select_action(game, random.Random(17))
        second = RandomAgent().select_action(game, random.Random(17))
        self.assertEqual(first, second)

    def test_mcts_returns_legal_action_without_mutating_root(self) -> None:
        game = LifelineGame(5)
        before = game.clone()
        agent = MCTSAgent(MCTSConfig(simulations=12, rollout_depth=12))
        result = agent.search(game, random.Random(3))
        self.assertEqual(game.clone(), before)
        self.assertIn(result.action, [*game.legal_moves(), None])
        self.assertEqual(sum(item.visits for item in result.action_stats), 12)

    def test_mcts_is_reproducible_for_a_fixed_seed(self) -> None:
        game = LifelineGame(5)
        config = MCTSConfig(simulations=10, rollout_depth=10)
        first = MCTSAgent(config).search(game, random.Random(91))
        second = MCTSAgent(config).search(game, random.Random(91))
        self.assertEqual(first, second)

    def test_opponent_node_minimizes_root_value(self) -> None:
        agent = MCTSAgent(MCTSConfig(simulations=1, exploration=0.0, rollout_depth=0))
        parent = _Node(player_to_act=Player.WHITE, visits=20)
        high = _Node(player_to_act=Player.BLACK, parent=parent, action=(0, 1), visits=10, value_sum=8)
        low = _Node(player_to_act=Player.BLACK, parent=parent, action=(0, 2), visits=10, value_sum=-2)
        parent.children = {high.action: high, low.action: low}
        selected = agent._select_child(parent, Player.BLACK, random.Random(0))
        self.assertIs(selected, low)

    def test_invalid_mcts_configuration_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            MCTSConfig(simulations=0)
        with self.assertRaises(ValueError):
            MCTSConfig(exploration=-1)
        with self.assertRaises(ValueError):
            MCTSConfig(rollout_depth=-1)


if __name__ == "__main__":
    unittest.main()
