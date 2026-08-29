from __future__ import annotations

import copy
import json
import unittest

from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.replay import Experience, ReplayBuffer


def make_experience(identifier: int, grid_size: int = 5, z: float = 1.0) -> Experience:
    game = LifelineGame(grid_size)
    legal_points = set(game.legal_moves())
    mask = tuple(int(point in legal_points) for point in game.valid_positions) + (1,)
    visits = tuple(0 for _ in game.valid_positions) + (identifier + 1,)
    return Experience(
        grid_size=grid_size,
        observation_mode="topology_history",
        board=tuple(game.grid),
        physical_edges=game.physical_edges,
        logical_edges=(
            tuple(sorted(game.edges[Player.BLACK])),
            tuple(sorted(game.edges[Player.WHITE])),
        ),
        current_player=game.current_player.value,
        consecutive_skips=game.consecutive_skips,
        legal_action_mask=mask,
        root_visits=visits,
        z=z,
        state_fingerprint=game.state_fingerprint(),
        provenance={"game": identifier // 10, "ply": identifier},
    )


class AlphaZeroReplayTests(unittest.TestCase):
    def test_experience_round_trip_supports_variable_board_sizes(self) -> None:
        for grid_size in (5, 7, 10):
            with self.subTest(grid_size=grid_size):
                sample = make_experience(grid_size, grid_size=grid_size, z=0.0)
                restored = Experience.from_dict(sample.to_dict())
                self.assertEqual(restored, sample)
                self.assertEqual(sample.num_points, grid_size * (grid_size + 1) // 2)
                self.assertEqual(sample.action_count, sample.num_points + 1)
                self.assertAlmostEqual(sum(sample.policy_target), 1.0)
                self.assertEqual(sample.current_player, "BLACK")

    def test_fifo_capacity_and_whole_game_add_are_atomic(self) -> None:
        replay = ReplayBuffer(capacity=4, seed=3)
        replay.add_game((make_experience(0), make_experience(1)))
        replay.add_game((make_experience(2), make_experience(3), make_experience(4)))
        self.assertEqual(
            [sample.provenance["ply"] for sample in replay.samples],
            [1, 2, 3, 4],
        )
        self.assertEqual(replay.total_added, 5)

        before = replay.state_dict()
        with self.assertRaises(TypeError):
            replay.add_game((make_experience(5), object()))
        self.assertEqual(replay.state_dict(), before)

    def test_buffer_breaks_mutable_provenance_aliases(self) -> None:
        replay = ReplayBuffer(capacity=2, seed=3)
        sample = make_experience(0)
        replay.add_game((sample,))
        sample.provenance["mutated_after_add"] = True
        returned = replay.samples[0]
        returned.provenance["mutated_after_read"] = True
        stored = replay.samples[0].provenance
        self.assertNotIn("mutated_after_add", stored)
        self.assertNotIn("mutated_after_read", stored)

    def test_state_restores_order_rng_position_and_total_added(self) -> None:
        replay = ReplayBuffer(capacity=8, seed=1234)
        replay.add_game(make_experience(index) for index in range(6))
        replay.sample(2)
        checkpoint = replay.state_dict()

        expected_first = replay.sample(3)
        expected_second = replay.sample(3)
        restored = ReplayBuffer.from_state_dict(checkpoint)
        json_restored = ReplayBuffer.from_state_dict(json.loads(json.dumps(checkpoint)))
        self.assertEqual(restored.samples, tuple(make_experience(index) for index in range(6)))
        self.assertEqual(restored.total_added, 6)
        self.assertEqual(restored.sample(3), expected_first)
        self.assertEqual(restored.sample(3), expected_second)
        self.assertEqual(json_restored.sample(3), expected_first)
        self.assertEqual(json_restored.sample(3), expected_second)

    def test_failed_load_does_not_partially_change_buffer(self) -> None:
        replay = ReplayBuffer(capacity=3, seed=9)
        replay.add_game((make_experience(1), make_experience(2)))
        before = replay.state_dict()
        damaged = copy.deepcopy(before)
        damaged["rng_state"] = (999, (), None)
        with self.assertRaises(ValueError):
            replay.load_state_dict(damaged)
        self.assertEqual(replay.state_dict(), before)

        wrong_capacity = copy.deepcopy(before)
        wrong_capacity["capacity"] = 4
        with self.assertRaises(ValueError):
            replay.load_state_dict(wrong_capacity)
        self.assertEqual(replay.state_dict(), before)

    def test_experience_rejects_illegal_visit_mass(self) -> None:
        state = make_experience(0).to_dict()
        illegal_action = state["legal_action_mask"].index(0)
        state["root_visits"][illegal_action] = 1
        with self.assertRaises(ValueError):
            Experience.from_dict(state)

    def test_experience_rejects_unknown_modes_and_board_states(self) -> None:
        unknown_mode = make_experience(0).to_dict()
        unknown_mode["observation_mode"] = "invented"
        with self.assertRaises(ValueError):
            Experience.from_dict(unknown_mode)

        invalid_board = make_experience(0).to_dict()
        invalid_board["board"][2] = 5
        with self.assertRaises(ValueError):
            Experience.from_dict(invalid_board)


if __name__ == "__main__":
    unittest.main()
