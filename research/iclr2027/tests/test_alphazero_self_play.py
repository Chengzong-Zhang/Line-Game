from __future__ import annotations

import json
import random
import unittest
from dataclasses import dataclass
from pathlib import Path

from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.puct import PUCTConfig, PUCTSearch, PolicyValue
from lifeline_rl.alphazero.replay import ReplayBuffer
from lifeline_rl.alphazero.self_play import SelfPlayConfig, play_self_play_game


HISTORY_A = tuple(
    map(
        tuple,
        json.loads(
            (Path(__file__).parent / "fixtures" / "aliasing_pair.json").read_text(
                encoding="utf-8"
            )
        )["histories"]["A"],
    )
)


@dataclass(frozen=True)
class FakeSearchResult:
    action: int
    root_player: Player
    simulations: int
    visits: tuple[int, ...]
    priors: tuple[float, ...]
    policy: tuple[float, ...]


def fake_result(game: LifelineGame, action: int) -> FakeSearchResult:
    action_count = game.num_points + 1
    visits = tuple(1 if index == action else 0 for index in range(action_count))
    distribution = tuple(1.0 if index == action else 0.0 for index in range(action_count))
    return FakeSearchResult(
        action=action,
        root_player=game.current_player,
        simulations=1,
        visits=visits,
        priors=distribution,
        policy=distribution,
    )


class PassSearcher:
    def __init__(self) -> None:
        self.calls: list[tuple[float, bool, int, float]] = []

    def search(
        self,
        game: LifelineGame,
        rng: random.Random,
        *,
        temperature: float,
        add_root_noise: bool,
    ) -> FakeSearchResult:
        self.calls.append((temperature, add_root_noise, game.turn_count, rng.random()))
        return fake_result(game, game.num_points)


class ScriptedSearcher:
    def __init__(self, points: tuple[tuple[int, int] | None, ...]):
        self.points = points
        self.index = 0

    def search(
        self,
        game: LifelineGame,
        rng: random.Random,
        *,
        temperature: float,
        add_root_noise: bool,
    ) -> FakeSearchResult:
        point = self.points[self.index]
        self.index += 1
        action = game.num_points if point is None else game.point_to_index[point]
        return fake_result(game, action)


class RandomLegalSearcher:
    def search(
        self,
        game: LifelineGame,
        rng: random.Random,
        *,
        temperature: float,
        add_root_noise: bool,
    ) -> FakeSearchResult:
        legal = [game.point_to_index[point] for point in game.legal_moves()]
        legal.append(game.num_points)
        return fake_result(game, rng.choice(legal))


class PassBiasedEvaluator:
    def evaluate(self, game: LifelineGame) -> PolicyValue:
        priors = (0.0,) * game.num_points + (1.0,)
        return PolicyValue(value=0.0, priors=priors)


class AlphaZeroSelfPlayTests(unittest.TestCase):
    def test_temperature_schedule_uses_ply_even_when_pass_does_not_advance_turn_count(self) -> None:
        searcher = PassSearcher()
        result = play_self_play_game(
            searcher,
            SelfPlayConfig(
                grid_size=5,
                max_plies=4,
                temperature_moves=1,
                initial_temperature=1.0,
                final_temperature=0.0,
            ),
            seed=77,
        )
        self.assertFalse(result.truncated)
        self.assertEqual([entry.temperature for entry in result.actions], [1.0, 0.0])
        self.assertEqual([entry.turn_count_before for entry in result.actions], [0, 0])
        self.assertEqual([call[:3] for call in searcher.calls], [(1.0, True, 0), (0.0, True, 0)])

    def test_terminal_values_use_each_samples_actual_player_and_commit_atomically(self) -> None:
        replay = ReplayBuffer(capacity=64, seed=5)
        result = play_self_play_game(
            ScriptedSearcher((*HISTORY_A, None)),
            SelfPlayConfig(grid_size=5, max_plies=len(HISTORY_A) + 2),
            seed=91,
            game_index=4,
            replay_buffer=replay,
        )
        self.assertFalse(result.truncated)
        self.assertEqual(result.winner, "WHITE")
        self.assertEqual(result.rewards, {"BLACK": -1.0, "WHITE": 1.0})
        self.assertEqual(len(result.experiences), len(HISTORY_A) + 1)
        self.assertEqual(replay.samples, result.experiences)
        self.assertTrue(result.added_to_replay)
        self.assertEqual({sample.z for sample in result.experiences}, {-1.0, 1.0})
        for sample in result.experiences:
            self.assertEqual(sample.z, result.rewards[sample.current_player])
            self.assertEqual(sample.provenance["reward_source"], "LifelineGame.rewards")

        replayed = LifelineGame(5)
        for expected_ply, entry in enumerate(result.action_log):
            self.assertEqual(entry.ply, expected_ply)
            self.assertEqual(entry.actor, replayed.current_player.value)
            self.assertEqual(entry.state_fingerprint, replayed.state_fingerprint())
            point = None if entry.action == replayed.num_points else replayed.valid_positions[entry.action]
            self.assertEqual(entry.point, point)
            move = replayed.skip_turn() if point is None else replayed.play_move(point)
            self.assertTrue(move.success)
        self.assertTrue(replayed.game_over)

    def test_truncated_game_keeps_complete_log_but_adds_no_training_samples(self) -> None:
        replay = ReplayBuffer(capacity=8, seed=1)
        result = play_self_play_game(
            PassSearcher(),
            SelfPlayConfig(grid_size=5, max_plies=1),
            seed=2,
            replay_buffer=replay,
        )
        self.assertTrue(result.truncated)
        self.assertEqual(result.plies, 1)
        self.assertEqual(len(result.actions), 1)
        self.assertEqual(result.experiences, ())
        self.assertFalse(result.added_to_replay)
        self.assertEqual(len(replay), 0)
        self.assertEqual(replay.total_added, 0)
        self.assertEqual(result.to_dict()["actions"][0]["action"], 15)

    def test_fixed_seed_reproduces_search_sampling_and_action_log(self) -> None:
        config = SelfPlayConfig(grid_size=5, max_plies=8)
        first = play_self_play_game(RandomLegalSearcher(), config, seed=2027)
        second = play_self_play_game(RandomLegalSearcher(), config, seed=2027)
        self.assertEqual(
            [(entry.actor, entry.action, entry.state_fingerprint) for entry in first.actions],
            [(entry.actor, entry.action, entry.state_fingerprint) for entry in second.actions],
        )

    def test_dependency_free_self_play_integrates_with_real_puct(self) -> None:
        searcher = PUCTSearch(
            PassBiasedEvaluator(),
            PUCTConfig(simulations=2, dirichlet_epsilon=0.0),
        )
        result = play_self_play_game(
            searcher,
            SelfPlayConfig(grid_size=5, max_plies=4, add_root_noise=False),
            seed=18,
        )
        self.assertTrue(result.terminated)
        self.assertEqual([entry.action for entry in result.actions], [15, 15])
        replayed = LifelineGame(5)
        replayed.skip_turn()
        replayed.skip_turn()
        self.assertEqual(result.final_state_fingerprint, replayed.state_fingerprint())

    def test_invalid_configuration_is_rejected(self) -> None:
        self.assertEqual(SelfPlayConfig(grid_size=5).observation_mode, "grid_graph")
        with self.assertRaises(ValueError):
            SelfPlayConfig(grid_size=5, max_plies=0)
        with self.assertRaises(ValueError):
            SelfPlayConfig(grid_size=5, temperature_moves=-1)
        with self.assertRaises(ValueError):
            SelfPlayConfig(grid_size=5, initial_temperature=-0.1)
        with self.assertRaises(ValueError):
            SelfPlayConfig(grid_size=5, observation_mode="invented")


if __name__ == "__main__":
    unittest.main()
