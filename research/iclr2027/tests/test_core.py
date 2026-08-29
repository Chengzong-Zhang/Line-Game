from __future__ import annotations

import json
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame, Player, PointState


ALIAS_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "aliasing_pair.json").read_text(encoding="utf-8")
)
HISTORY_A = tuple(map(tuple, ALIAS_FIXTURE["histories"]["A"]))
HISTORY_B = tuple(map(tuple, ALIAS_FIXTURE["histories"]["B"]))


class CoreRuleTests(unittest.TestCase):
    def test_initial_state_and_variable_board_sizes(self) -> None:
        for size in (5, 9, 15):
            game = LifelineGame(size)
            self.assertEqual(game.num_points, size * (size + 1) // 2)
            self.assertEqual(game.get_state((0, 0)), PointState.BLACK_NODE)
            self.assertEqual(game.get_state((size - 1, 0)), PointState.WHITE_NODE)
            self.assertEqual(game.current_player, Player.BLACK)
            self.assertEqual(len(game.history_hashes), 1)

    def test_protection_zone_is_illegal(self) -> None:
        game = LifelineGame(5)
        self.assertEqual(game.evaluate_move((3, 0)).reason, "INVALID_MOVE")
        self.assertEqual(game.evaluate_move((3, 1)).reason, "INVALID_MOVE")

    def test_auto_connection_marks_intermediate_line_points(self) -> None:
        game = LifelineGame(5)
        self.assertTrue(game.play_move((0, 3)).success)
        self.assertEqual(game.get_state((0, 1)), PointState.BLACK_LINE)
        self.assertEqual(game.get_state((0, 2)), PointState.BLACK_LINE)
        self.assertEqual(len(game.edges[Player.BLACK]), 1)

    def test_three_point_limitation(self) -> None:
        game = LifelineGame(5)
        self.assertTrue(game.play_move((0, 1)).success)
        self.assertTrue(game.skip_turn().success)
        self.assertEqual(game.current_player, Player.BLACK)
        self.assertFalse(game.evaluate_move((1, 0)).success)

    def test_attack_cascades_and_preserves_surviving_friendly_edges(self) -> None:
        game = LifelineGame(5)
        game.replay(HISTORY_A[:6])
        self.assertEqual(game.get_state((2, 2)), PointState.WHITE_LINE)
        self.assertEqual(game.get_state((0, 4)), PointState.WHITE_NODE)
        black_edges_before = set(game.edges[Player.BLACK])

        self.assertTrue(game.play_move((2, 2)).success)
        for removed in ((3, 1), (1, 3), (0, 4)):
            self.assertEqual(game.get_state(removed), PointState.EMPTY)
        self.assertEqual(game.get_state((2, 0)), PointState.WHITE_NODE)
        self.assertEqual(game.get_state((3, 0)), PointState.WHITE_LINE)
        self.assertLess(len(game.edges[Player.WHITE]), 3)
        self.assertTrue(black_edges_before <= game.edges[Player.BLACK])

    def test_line_attack_can_cut_an_edge_without_deleting_its_nodes(self) -> None:
        game = LifelineGame(5)
        game.replay(HISTORY_A[:9])
        cut_edge = game._edge((0, 1), (2, 1))
        self.assertIn(cut_edge, game.edges[Player.BLACK])
        self.assertEqual(game.get_state((1, 1)), PointState.BLACK_LINE)

        self.assertTrue(game.play_move((1, 1)).success)
        self.assertNotIn(cut_edge, game.edges[Player.BLACK])
        self.assertEqual(game.get_state((0, 1)), PointState.BLACK_NODE)
        self.assertEqual(game.get_state((2, 1)), PointState.BLACK_NODE)

    def test_superko_rejection_restores_board_edges_and_turn(self) -> None:
        probe = LifelineGame(5)
        self.assertTrue(probe._add_node((0, 3)))
        repeated_key = probe._compute_state_key(Player.WHITE)

        game = LifelineGame(5)
        game.history_hashes.add(repeated_key)
        before = game.clone()
        result = game.play_move((0, 3))
        self.assertFalse(result.success)
        self.assertEqual(result.reason, "SUPERKO_VIOLATION")
        self.assertEqual(game.clone(), before)

    def test_two_passes_end_the_game_as_a_draw_initially(self) -> None:
        game = LifelineGame(5)
        self.assertTrue(game.skip_turn().success)
        self.assertFalse(game.game_over)
        self.assertTrue(game.skip_turn().success)
        self.assertTrue(game.game_over)
        self.assertEqual(game.winner(), "DRAW")
        self.assertEqual(game.rewards()[Player.BLACK], 0.0)

    def test_clone_and_restore_include_superko_history(self) -> None:
        game = LifelineGame(5)
        snapshot = game.clone()
        self.assertTrue(game.play_move((0, 3)).success)
        self.assertNotEqual(game.clone(), snapshot)
        game.restore(snapshot)
        self.assertEqual(game.clone(), snapshot)

    def test_reachable_same_board_can_have_different_logical_edges(self) -> None:
        game_a = LifelineGame(5)
        game_b = LifelineGame(5)
        game_a.replay(HISTORY_A)
        game_b.replay(HISTORY_B)

        expected = ALIAS_FIXTURE["expected"]
        self.assertEqual(game_a.grid, expected["board"])
        self.assertEqual(game_a.grid, game_b.grid)
        self.assertEqual(game_a.current_player, game_b.current_player)
        self.assertEqual(game_a.current_player.value, expected["current_player"])
        self.assertNotEqual(game_a.edges[Player.WHITE], game_b.edges[Player.WHITE])
        distinct_edge = game_a._edge(*map(tuple, expected["edge_present_only_in_A"]))
        self.assertIn(distinct_edge, game_a.edges[Player.WHITE])
        self.assertNotIn(distinct_edge, game_b.edges[Player.WHITE])
        common_action = tuple(expected["common_legal_action"])
        self.assertTrue(game_a.evaluate_move(common_action).success)
        self.assertTrue(game_b.evaluate_move(common_action).success)

        self.assertTrue(game_a.play_move(common_action).success)
        self.assertTrue(game_b.play_move(common_action).success)
        self.assertNotEqual(game_a.edges[Player.WHITE], game_b.edges[Player.WHITE])


if __name__ == "__main__":
    unittest.main()
