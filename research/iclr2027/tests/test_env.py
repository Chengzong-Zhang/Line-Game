from __future__ import annotations

import unittest

from lifeline_rl import LifelineEnv, Player

from .test_core import HISTORY_A


class EnvironmentTests(unittest.TestCase):
    def test_action_mapping_is_a_bijection_and_pass_is_last(self) -> None:
        env = LifelineEnv(5)
        for action in range(env.pass_action):
            self.assertEqual(env.point_to_action(env.action_to_point(action)), action)
        self.assertIsNone(env.action_to_point(env.pass_action))
        self.assertEqual(env.point_to_action(None), env.pass_action)

    def test_reset_and_step_follow_gymnasium_return_shape(self) -> None:
        env = LifelineEnv(5)
        observation, info = env.reset(seed=7)
        self.assertEqual(len(observation["board"]), 15)
        self.assertEqual(len(observation["legal_action_mask"]), 16)
        self.assertEqual(info["current_player"], "BLACK")

        action = env.point_to_action((0, 3))
        observation, reward, terminated, truncated, info = env.step(action)
        self.assertEqual(reward, 0.0)
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info["acting_player"], "BLACK")
        self.assertEqual(observation["current_player"], 1)

    def test_observation_ablation_boundaries(self) -> None:
        grid = LifelineEnv(5, observation_mode="grid").reset()[0]
        graph = LifelineEnv(5, observation_mode="grid_graph").reset()[0]
        topology = LifelineEnv(5, observation_mode="topology").reset()[0]
        history = LifelineEnv(5, observation_mode="topology_history").reset()[0]
        self.assertNotIn("physical_edges", grid)
        self.assertIn("physical_edges", graph)
        self.assertNotIn("logical_edges", graph)
        self.assertIn("logical_edges", topology)
        self.assertNotIn("history", topology)
        self.assertIn("history", history)

    def test_terminal_reward_is_from_acting_player_perspective(self) -> None:
        env = LifelineEnv(5)
        for point in HISTORY_A:
            env.step(env.point_to_action(point))
        self.assertEqual(env.game.current_player, Player.WHITE)

        _, reward, terminated, _, info = env.step(env.pass_action)
        self.assertTrue(terminated)
        self.assertEqual(reward, 1.0)
        self.assertEqual(info["winner"], "WHITE")
        self.assertEqual(info["rewards"], {"BLACK": -1.0, "WHITE": 1.0})

    def test_illegal_action_penalty_does_not_mutate_state(self) -> None:
        env = LifelineEnv(5, illegal_action_mode="penalty")
        before = env.clone()
        illegal = env.point_to_action((3, 0))
        _, reward, terminated, truncated, info = env.step(illegal)
        self.assertEqual(reward, -1.0)
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info["reason"], "INVALID_MOVE")
        self.assertEqual(env.clone(), before)

    def test_clone_restore_and_replay(self) -> None:
        env = LifelineEnv(5)
        snapshot = env.clone()
        actions = [env.point_to_action((0, 3)), env.point_to_action((0, 4))]
        env.replay(actions)
        self.assertNotEqual(env.clone(), snapshot)
        env.restore(snapshot)
        self.assertEqual(env.clone(), snapshot)

    def test_terminal_action_mask_is_all_zero(self) -> None:
        env = LifelineEnv(5)
        env.step(env.pass_action)
        observation, _, terminated, _, info = env.step(env.pass_action)
        self.assertTrue(terminated)
        self.assertEqual(observation["legal_action_mask"], (0,) * env.action_count)
        self.assertEqual(info["legal_action_mask"], (0,) * env.action_count)


if __name__ == "__main__":
    unittest.main()
