from __future__ import annotations

import json
import random
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame, Player, PointState


ALIAS_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "aliasing_pair.json").read_text(encoding="utf-8")
)
HISTORY_A = tuple(map(tuple, ALIAS_FIXTURE["histories"]["A"]))


def player_points(game: LifelineGame, player: Player) -> set[tuple[int, int]]:
    return set(game._player_nodes(player) + game._player_lines(player))


class TargetedTransitionTests(unittest.TestCase):
    def assert_structural_invariants(self, game: LifelineGame) -> None:
        """Check redundant board/edge connectivity facts after a transition."""

        for player in (Player.BLACK, Player.WHITE):
            node_state, line_state = {
                Player.BLACK: (PointState.BLACK_NODE, PointState.BLACK_LINE),
                Player.WHITE: (PointState.WHITE_NODE, PointState.WHITE_LINE),
            }[player]
            nodes = set(game._player_nodes(player))
            lines = set(game._player_lines(player))
            initial = game.initial_positions[player]
            self.assertIn(initial, nodes)

            edge_graph: dict[tuple[int, int], set[tuple[int, int]]] = {}
            covered_lines: set[tuple[int, int]] = set()
            for edge in game.edges[player]:
                point_a, point_b = game.edge_points(edge)
                self.assertIn(point_a, nodes)
                self.assertIn(point_b, nodes)
                edge_graph.setdefault(point_a, set()).add(point_b)
                edge_graph.setdefault(point_b, set()).add(point_a)
                path = game.line_points(point_a, point_b)
                self.assertGreaterEqual(len(path), 2)
                for point in path:
                    self.assertIn(game.get_state(point), (node_state, line_state))
                covered_lines.update(path[1:-1])

            reachable = {initial}
            frontier = [initial]
            while frontier:
                current = frontier.pop()
                for following in edge_graph.get(current, ()):
                    if following not in reachable:
                        reachable.add(following)
                        frontier.append(following)
            self.assertEqual(nodes, reachable)
            self.assertTrue(lines <= covered_lines)

        black = player_points(game, Player.BLACK)
        white = player_points(game, Player.WHITE)
        self.assertTrue(black.isdisjoint(white))

    def test_attack_deletes_exact_disconnected_component_and_restores_survivor(self) -> None:
        game = LifelineGame(5)
        game.replay(HISTORY_A[:6])
        surviving_edge = game._edge((2, 0), (4, 0))
        deleted_edges = {
            game._edge((4, 0), (1, 3)),
            game._edge((4, 0), (0, 4)),
            game._edge((1, 3), (0, 4)),
        }
        self.assertEqual(game.edges[Player.WHITE], deleted_edges | {surviving_edge})
        self.assertEqual(game.get_state((2, 2)), PointState.WHITE_LINE)

        result = game.play_move((2, 2))

        self.assertTrue(result.success)
        self.assertEqual(game.get_state((2, 2)), PointState.BLACK_NODE)
        for point in ((3, 1), (1, 3), (0, 4)):
            self.assertEqual(game.get_state(point), PointState.EMPTY)
        self.assertEqual(game.edges[Player.WHITE], {surviving_edge})
        self.assertEqual(game.get_state((2, 0)), PointState.WHITE_NODE)
        self.assertEqual(game.get_state((3, 0)), PointState.WHITE_LINE)
        self.assertEqual(game.get_state((4, 0)), PointState.WHITE_NODE)
        self.assert_structural_invariants(game)

    def test_attack_can_cut_one_edge_without_deleting_any_opponent_node(self) -> None:
        game = LifelineGame(5)
        game.replay(HISTORY_A[:9])
        cut_edge = game._edge((0, 1), (2, 1))
        before_nodes = set(game._player_nodes(Player.BLACK))
        before_black_edges = set(game.edges[Player.BLACK])
        before_white_edges = set(game.edges[Player.WHITE])
        new_white_edge = game._edge((2, 0), (1, 1))
        self.assertIn(cut_edge, before_black_edges)
        self.assertEqual(game.get_state((1, 1)), PointState.BLACK_LINE)

        result = game.play_move((1, 1))

        self.assertTrue(result.success)
        self.assertEqual(set(game._player_nodes(Player.BLACK)), before_nodes)
        self.assertEqual(game.edges[Player.BLACK], before_black_edges - {cut_edge})
        self.assertEqual(game.edges[Player.WHITE], before_white_edges | {new_white_edge})
        self.assertEqual(game.get_state((1, 1)), PointState.WHITE_NODE)
        # BLACK has no move after the cut, so the reference rule auto-skips it.
        self.assertEqual(game.current_player, Player.WHITE)
        self.assertEqual(game.consecutive_skips, 1)
        self.assert_structural_invariants(game)

    def test_synthetic_superko_rejection_is_a_full_transactional_rollback(self) -> None:
        reached = LifelineGame(5)
        self.assertTrue(reached.play_move((0, 3)).success)
        repeated_key = reached._compute_state_key(Player.WHITE)
        self.assertIn(repeated_key, reached.history_hashes)

        game = LifelineGame(5)
        game.history_hashes.add(repeated_key)
        legal_before = game.legal_moves()
        snapshot_before = game.clone()
        serialized_before = game.serialize_state()

        result = game.play_move((0, 3))

        self.assertFalse(result.success)
        self.assertEqual(result.reason, "SUPERKO_VIOLATION")
        self.assertEqual(game.clone(), snapshot_before)
        self.assertEqual(game.serialize_state(), serialized_before)
        self.assertEqual(game.legal_moves(), legal_before)


class DeterministicPropertyTests(unittest.TestCase):
    def assert_structural_invariants(self, game: LifelineGame) -> None:
        TargetedTransitionTests().assert_structural_invariants(game)

    @staticmethod
    def seeded_trace(size: int, seed: int, max_plies: int) -> list[tuple[int, int] | None]:
        rng = random.Random(seed)
        game = LifelineGame(size)
        actions: list[tuple[int, int] | None] = []
        for ply in range(max_plies):
            if game.game_over:
                break
            legal = game.legal_moves()
            if ply > 0 and ply % 11 == 0 and game.consecutive_skips == 0:
                action = None
                result = game.skip_turn()
            elif legal:
                action = rng.choice(legal)
                result = game.play_move(action)
            else:
                action = None
                result = game.skip_turn()
            if not result.success:
                raise AssertionError((size, seed, ply, action, result))
            actions.append(action)
        return actions

    def test_seeded_replays_are_deterministic_across_board_sizes(self) -> None:
        budgets = {5: 24, 7: 20, 9: 16, 12: 10, 15: 8}
        for size, max_plies in budgets.items():
            with self.subTest(size=size):
                actions = self.seeded_trace(size, 20260825 + size, max_plies)
                first = LifelineGame(size)
                second = LifelineGame(size)
                for action in actions:
                    before = first.clone()
                    legal_once = first.legal_moves()
                    self.assertEqual(first.clone(), before)
                    self.assertEqual(first.legal_moves(), legal_once)
                    result_first = first.skip_turn() if action is None else first.play_move(action)
                    result_second = second.skip_turn() if action is None else second.play_move(action)
                    self.assertEqual(result_first, result_second)
                    self.assertEqual(first.clone(), second.clone())
                    self.assertEqual(first.serialize_state(), second.serialize_state())
                    self.assert_structural_invariants(first)

    def test_evaluate_move_is_pure_for_every_point_on_seeded_states(self) -> None:
        game = LifelineGame(7)
        actions = self.seeded_trace(7, 9173, 12)
        for action in actions:
            before = game.clone()
            evaluations = tuple(game.evaluate_move(point) for point in game.valid_positions)
            self.assertEqual(game.clone(), before)
            expected_legal = [
                point
                for point, evaluation in zip(game.valid_positions, evaluations)
                if evaluation.success
            ]
            self.assertEqual(game.legal_moves(), expected_legal)
            if action is None:
                game.skip_turn()
            else:
                self.assertTrue(game.play_move(action).success)


if __name__ == "__main__":
    unittest.main()
