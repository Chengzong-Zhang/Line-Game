from __future__ import annotations

import json
import random
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame
from lifeline_rl.agents.base import Agent, apply_action, legal_actions
from lifeline_rl.agents.cycle_seeking import (
    CycleSeekingAgent,
    CycleSeekingConfig,
    check_fixture_guided_cycle,
)


ROOT = Path(__file__).resolve().parents[1]
WITNESS_PATH = ROOT / "state_aliasing" / "superko_n6_witness_v1.json"

Action = tuple[int, int] | None


def _actions(raw: list[list[int] | None]) -> tuple[Action, ...]:
    return tuple(
        None if action is None else (int(action[0]), int(action[1]))
        for action in raw
    )


def _position_projection(game: LifelineGame) -> tuple[object, ...]:
    snapshot = game.clone()
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


class CycleSeekingAgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.witness = json.loads(WITNESS_PATH.read_text(encoding="utf-8"))
        cls.prefix = _actions(cls.witness["natural_prefix"]["actions"])
        cls.fixture_loop = _actions(cls.witness["witness_loop"]["actions"])
        raw_candidate = cls.witness["candidate"]["action"]
        cls.candidate = (int(raw_candidate[0]), int(raw_candidate[1]))

    def _game(self, mode: str, action_count: int) -> LifelineGame:
        game = LifelineGame(self.witness["grid_size"], superko_mode=mode)
        game.replay(self.prefix[:action_count])
        return game

    def test_generic_search_finds_and_closes_cycle_from_frozen_stage_five(self) -> None:
        stage_count = int(self.witness["stage_5"]["prefix_action_count"])
        game = self._game("observe", stage_count)
        before = game.clone()
        root_projection = _position_projection(game)
        config = CycleSeekingConfig(
            max_depth=6,
            branch_limit=8,
            node_budget=25_000,
            fallback="first",
        )
        agent = CycleSeekingAgent(config)

        result = agent.search(game, random.Random(7))

        self.assertEqual(game.clone(), before)
        self.assertEqual(result.reason, "counterfactual_cycle")
        self.assertTrue(result.found_cycle)
        self.assertLessEqual(len(result.path), config.max_depth)
        self.assertLessEqual(result.nodes_expanded, config.node_budget)
        self.assertLessEqual(result.max_depth_reached, config.max_depth)
        self.assertEqual(result.action, result.path[0])
        self.assertIn(result.action, legal_actions(game))
        self.assertEqual(result.repeat_action, result.path[-1])

        check = check_fixture_guided_cycle(game, result.path)
        self.assertTrue(check.valid, check)
        self.assertTrue(check.closes_root_position, check)

        replay = self._game("observe", stage_count)
        final_result = None
        for action in result.path:
            if action is None:
                final_result = replay.skip_turn()
            else:
                final_result = replay.play_move(action)
            self.assertTrue(final_result.success, (action, final_result))
        self.assertIsNotNone(final_result)
        self.assertTrue(final_result.would_violate_superko)
        self.assertEqual(_position_projection(replay), root_projection)

    def test_fixture_guided_positive_control_is_separate_and_exact(self) -> None:
        stage_count = int(self.witness["stage_5"]["prefix_action_count"])
        game = self._game("enforce", stage_count)
        before = game.clone()

        check = check_fixture_guided_cycle(game, self.fixture_loop)
        incomplete = check_fixture_guided_cycle(game, self.fixture_loop[:-1])

        self.assertEqual(game.clone(), before)
        self.assertTrue(check.valid)
        self.assertTrue(check.closes_root_position)
        self.assertEqual(check.repeat_action, self.candidate)
        self.assertFalse(incomplete.valid)
        self.assertEqual(incomplete.reason, "last_action_is_not_repeat")

    def test_observe_prioritizes_an_immediate_repeat(self) -> None:
        game = self._game("observe", len(self.prefix))
        before = game.clone()
        agent = CycleSeekingAgent(CycleSeekingConfig(max_depth=1, node_budget=2))

        action = agent.select_action(game, random.Random(11))

        self.assertEqual(game.clone(), before)
        self.assertEqual(action, self.candidate)
        self.assertEqual(agent.last_search.reason, "immediate_repeat")
        self.assertEqual(agent.last_search.path, (self.candidate,))
        self.assertTrue(game.evaluate_move(action).would_violate_superko)

    def test_enforce_never_returns_the_forbidden_repeat(self) -> None:
        game = self._game("enforce", len(self.prefix))
        before = game.clone()
        legal = legal_actions(game)
        self.assertNotIn(self.candidate, legal)
        self.assertIn(self.candidate, game.would_violate_superko_moves())
        agent = CycleSeekingAgent(
            CycleSeekingConfig(
                max_depth=1,
                branch_limit=2,
                node_budget=4,
                fallback="first",
            )
        )

        action = agent.select_action(game, random.Random(11))

        self.assertEqual(game.clone(), before)
        self.assertIn(action, legal)
        self.assertNotEqual(action, self.candidate)
        self.assertEqual(agent.last_search.reason, "fallback_first")

    def test_seeded_fallback_is_reproducible_and_implements_agent_protocol(self) -> None:
        game = LifelineGame(5)
        config = CycleSeekingConfig(
            max_depth=1,
            branch_limit=1,
            node_budget=2,
            fallback="random",
        )
        first_agent = CycleSeekingAgent(config)
        second_agent = CycleSeekingAgent(config)

        first = first_agent.select_action(game, random.Random(20260826))
        second = second_agent.select_action(game, random.Random(20260826))

        self.assertIsInstance(first_agent, Agent)
        self.assertEqual(first, second)
        self.assertIn(first, legal_actions(game))
        self.assertEqual(first_agent.last_search.reason, "fallback_random")
        self.assertEqual(first_agent.diagnostics(), first_agent.last_search.to_dict())

    def test_configuration_terminal_and_helper_boundaries(self) -> None:
        for kwargs in (
            {"max_depth": 0},
            {"branch_limit": 0},
            {"node_budget": 0},
            {"fallback": "unknown"},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    CycleSeekingConfig(**kwargs)

        terminal = LifelineGame(5)
        apply_action(terminal, None)
        apply_action(terminal, None)
        self.assertTrue(terminal.game_over)
        with self.assertRaisesRegex(RuntimeError, "terminal"):
            CycleSeekingAgent().select_action(terminal, random.Random(0))

        empty = check_fixture_guided_cycle(LifelineGame(5), ())
        pass_last = check_fixture_guided_cycle(LifelineGame(5), (None,))
        self.assertEqual(empty.reason, "empty_path")
        self.assertEqual(pass_last.reason, "pass_cannot_trigger_superko")


if __name__ == "__main__":
    unittest.main()
