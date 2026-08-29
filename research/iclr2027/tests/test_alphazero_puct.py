from __future__ import annotations

import math
import random
import unittest

from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.puct import (
    PUCTConfig,
    PUCTSearch,
    PolicyValue,
    PolicyValueEvaluator,
)


def integer_legal_actions(game: LifelineGame) -> list[int]:
    return [game.point_to_index[point] for point in game.legal_moves()] + [game.num_points]


class ConstantEvaluator:
    def __init__(self, value: float = 0.0, priors: object | None = None):
        self.value = value
        self.priors = priors
        self.calls: list[tuple[Player, bool, int]] = []

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        self.calls.append((game.current_player, game.game_over, game.turn_count))
        if game.game_over:
            raise AssertionError("terminal state reached the evaluator")
        priors = self.priors
        if priors is None:
            priors = [1.0] * (game.num_points + 1)
        return PolicyValue(self.value, priors)  # type: ignore[arg-type]


class ActorAwareEvaluator:
    """Force one root action, then score every child for its current actor."""

    def __init__(self, root_turn: int, preferred_action: int):
        self.root_turn = root_turn
        self.preferred_action = preferred_action

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        if game.game_over:
            raise AssertionError("terminal state reached the evaluator")
        priors = [0.0] * (game.num_points + 1)
        if game.turn_count == self.root_turn:
            priors[self.preferred_action] = 1.0
            value = 0.0
        else:
            value = 1.0
        return PolicyValue(value, priors)


class PUCTTests(unittest.TestCase):
    def test_protocol_integer_actions_masking_normalization_and_root_immutability(self) -> None:
        game = LifelineGame(5)
        before = game.clone()
        legal = integer_legal_actions(game)
        point_action = legal[0]
        priors = [0.0] * (game.num_points + 1)
        priors[0] = 1_000.0  # occupied and therefore illegal at the root
        priors[point_action] = 2.0
        priors[game.num_points] = 1.0
        evaluator = ConstantEvaluator(priors=priors)
        self.assertIsInstance(evaluator, PolicyValueEvaluator)

        result = PUCTSearch(
            evaluator,
            PUCTConfig(simulations=8, c_puct=1.0),
        ).search(game, random.Random(17), temperature=1.0)

        self.assertEqual(game.clone(), before)
        self.assertEqual(len(result.visits), game.num_points + 1)
        self.assertEqual(len(result.priors), game.num_points + 1)
        self.assertEqual(result.simulations, sum(result.visits))
        self.assertIn(result.action, legal)
        self.assertEqual(result.priors[0], 0.0)
        self.assertAlmostEqual(result.priors[point_action], 2.0 / 3.0)
        self.assertAlmostEqual(result.priors[game.num_points], 1.0 / 3.0)
        self.assertAlmostEqual(math.fsum(result.priors), 1.0)
        self.assertAlmostEqual(math.fsum(result.policy), 1.0)

    def test_zero_or_unusable_legal_mass_falls_back_to_uniform(self) -> None:
        game = LifelineGame(5)
        evaluator = ConstantEvaluator(
            priors=[float("nan"), -3.0] + [0.0] * (game.num_points - 1)
        )
        result = PUCTSearch(
            evaluator,
            PUCTConfig(simulations=1),
        ).search(game, random.Random(2))

        legal = integer_legal_actions(game)
        expected = 1.0 / len(legal)
        for action, prior in enumerate(result.priors):
            self.assertAlmostEqual(prior, expected if action in legal else 0.0)

    def test_terminal_children_use_exact_payoff_without_evaluation(self) -> None:
        game = LifelineGame(5)
        game.skip_turn()
        before = game.clone()
        priors = [0.0] * (game.num_points + 1)
        priors[game.num_points] = 1.0
        evaluator = ConstantEvaluator(priors=priors)

        result = PUCTSearch(
            evaluator,
            PUCTConfig(simulations=1),
        ).search(game, random.Random(5))

        self.assertEqual(result.visits[game.num_points], 1)
        self.assertEqual(len(evaluator.calls), 1)  # the non-terminal root only
        self.assertFalse(evaluator.calls[0][1])
        self.assertEqual(game.clone(), before)

    def test_terminal_root_is_rejected_before_evaluator_call(self) -> None:
        game = LifelineGame(5)
        game.skip_turn()
        game.skip_turn()
        evaluator = ConstantEvaluator()
        with self.assertRaises(RuntimeError):
            PUCTSearch(evaluator, PUCTConfig(simulations=1)).search(
                game,
                random.Random(0),
            )
        self.assertEqual(evaluator.calls, [])

    def test_absolute_backup_negates_when_actor_changes(self) -> None:
        game = LifelineGame(5)
        preferred = game.point_to_index[game.legal_moves()[0]]
        evaluator = ActorAwareEvaluator(game.turn_count, preferred)
        result = PUCTSearch(
            evaluator,
            PUCTConfig(simulations=2, c_puct=1.0),
        ).search(game, random.Random(3), temperature=1.0)

        # The child evaluator says +1 for WHITE.  Absolute-player backup makes
        # that -1 for the BLACK root, so the preferred edge is not revisited.
        self.assertEqual(result.visits[preferred], 1)
        self.assertEqual(result.q_values[preferred], -1.0)

    def test_absolute_backup_does_not_flip_after_auto_skip_to_same_actor(self) -> None:
        history = [
            (2, 0),
            (2, 2),
            (0, 1),
            (0, 4),
            (0, 3),
            (1, 2),
            (2, 1),
            (3, 0),
            (1, 3),
        ]
        game = LifelineGame(5)
        game.replay(history)
        self.assertEqual(game.current_player, Player.WHITE)
        preferred = game.point_to_index[(1, 1)]
        probe = game.clone()
        game.play_move((1, 1))
        self.assertEqual(game.current_player, Player.WHITE)
        game.restore(probe)
        before = game.clone()

        evaluator = ActorAwareEvaluator(game.turn_count, preferred)
        result = PUCTSearch(
            evaluator,
            PUCTConfig(simulations=2, c_puct=1.0),
        ).search(game, random.Random(11), temperature=1.0)

        # The +1 child value belongs to WHITE at both ends of the edge.  A
        # depth-based sign flip would select another root action on simulation
        # two; absolute payoff backup correctly revisits this edge.
        self.assertEqual(result.visits[preferred], 2)
        # The second traversal may end by PASS with the opposite exact terminal
        # payoff, so its backup can cancel the first +1 in the final mean.  The
        # revisit count itself is the discriminating assertion: selection on
        # simulation two observes the first simulation's same-actor +1.
        self.assertEqual(game.clone(), before)

    def test_root_noise_and_search_are_reproducible_with_fixed_rng(self) -> None:
        config = PUCTConfig(
            simulations=12,
            c_puct=1.25,
            dirichlet_alpha=0.5,
            dirichlet_epsilon=0.4,
        )
        first = PUCTSearch(ConstantEvaluator(), config).search(
            LifelineGame(5),
            random.Random(2027),
            temperature=0.8,
            add_root_noise=True,
        )
        second = PUCTSearch(ConstantEvaluator(), config).search(
            LifelineGame(5),
            random.Random(2027),
            temperature=0.8,
            add_root_noise=True,
        )
        self.assertEqual(first, second)

    def test_result_can_recompute_temperature_policy_and_resample(self) -> None:
        result = PUCTSearch(
            ConstantEvaluator(),
            PUCTConfig(simulations=7),
        ).search(LifelineGame(5), random.Random(31), temperature=1.0)

        expected = tuple(visit / 7.0 for visit in result.visits)
        for observed, wanted in zip(result.root_policy(1.0), expected):
            self.assertAlmostEqual(observed, wanted)
        cold = result.root_policy(0.0)
        self.assertEqual(sum(probability == 1.0 for probability in cold), 1)
        self.assertEqual(
            result.select_action(random.Random(999), temperature=0.0),
            cold.index(1.0),
        )

    def test_invalid_configurations_are_rejected(self) -> None:
        with self.assertRaises(TypeError):
            PUCTConfig(simulations=True)
        with self.assertRaises(ValueError):
            PUCTConfig(simulations=0)
        with self.assertRaises(ValueError):
            PUCTConfig(c_puct=-0.1)
        with self.assertRaises(ValueError):
            PUCTConfig(dirichlet_alpha=0.0)
        with self.assertRaises(ValueError):
            PUCTConfig(dirichlet_epsilon=1.1)


if __name__ == "__main__":
    unittest.main()
