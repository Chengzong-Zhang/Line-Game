from __future__ import annotations

import copy
import json
import unittest

from lifeline_rl import LifelineGame, Player

from .test_core import HISTORY_A


class SerializationTests(unittest.TestCase):
    def test_canonical_json_and_fingerprint_are_stable(self) -> None:
        first = LifelineGame(5)
        second = LifelineGame(5)
        first.replay(HISTORY_A[:7])
        second.replay(HISTORY_A[:7])
        self.assertEqual(first.canonical_state_json(), second.canonical_state_json())
        self.assertEqual(first.state_fingerprint(), second.state_fingerprint())
        self.assertEqual(len(first.state_fingerprint()), 64)
        json.loads(first.canonical_state_json())

    def test_serialized_state_round_trip_is_lossless(self) -> None:
        original = LifelineGame(5)
        original.replay(HISTORY_A)
        restored = LifelineGame.from_serialized_state(original.serialize_state())
        self.assertEqual(restored.clone(), original.clone())
        self.assertEqual(restored.canonical_state_json(), original.canonical_state_json())

    def test_terminal_state_round_trip_recomputes_exact_score(self) -> None:
        original = LifelineGame(5)
        original.replay(HISTORY_A)
        original.skip_turn()
        self.assertTrue(original.game_over)
        restored = LifelineGame.from_serialized_state(original.serialize_state())
        self.assertEqual(restored.winner(), original.winner())
        self.assertEqual(restored.cached_territories, original.cached_territories)

    def test_non_default_start_player_round_trip_is_lossless(self) -> None:
        original = LifelineGame(5, start_player=Player.WHITE)
        original.play_move((0, 4))
        serialized = original.serialize_state()
        self.assertEqual(serialized["schema_version"], 3)
        self.assertEqual(serialized["start_player"], "WHITE")

        restored = LifelineGame.from_serialized_state(serialized)
        self.assertEqual(restored.start_player, Player.WHITE)
        self.assertEqual(restored.clone(), original.clone())
        self.assertEqual(restored.canonical_state_json(), original.canonical_state_json())

    def test_corrupted_serialized_states_are_rejected(self) -> None:
        game = LifelineGame(5)
        serialized = game.serialize_state()
        bad_board = copy.deepcopy(serialized)
        bad_board["board"][0] = 99
        with self.assertRaises(ValueError):
            LifelineGame.from_serialized_state(bad_board)

        bad_positions = copy.deepcopy(serialized)
        bad_positions["positions"].reverse()
        with self.assertRaises(ValueError):
            LifelineGame.from_serialized_state(bad_positions)

        bad_history = copy.deepcopy(serialized)
        bad_history["history"].append(copy.deepcopy(bad_history["history"][0]))
        with self.assertRaises(ValueError):
            LifelineGame.from_serialized_state(bad_history)


if __name__ == "__main__":
    unittest.main()
