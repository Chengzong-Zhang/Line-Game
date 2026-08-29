from __future__ import annotations

import csv
import json
import random
import shutil
import unittest
from pathlib import Path

from lifeline_rl import (
    IllegalAgentActionError,
    LifelineGame,
    MCTSAgent,
    MCTSConfig,
    RandomAgent,
    play_game,
    replay_game_record,
    run_matchup,
    write_matchup,
)


class _PassAgent:
    def __init__(self, name: str):
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def select_action(self, game: LifelineGame, rng: random.Random):
        del game, rng
        return None

    def diagnostics(self):
        return {}


class _IllegalAgent(_PassAgent):
    def select_action(self, game: LifelineGame, rng: random.Random):
        del game, rng
        return (999, 999)


class _MutatingAgent(_PassAgent):
    def select_action(self, game: LifelineGame, rng: random.Random):
        del rng
        game.skip_turn()
        return None


class ArenaTests(unittest.TestCase):
    def test_pass_agents_end_in_two_plies(self) -> None:
        record = play_game(
            _PassAgent("pass-a"),
            _PassAgent("pass-b"),
            grid_size=5,
            seed=1,
            max_plies=10,
        )
        self.assertFalse(record.truncated)
        self.assertEqual(record.winner, "DRAW")
        self.assertEqual(record.plies, 2)
        self.assertEqual([action.action for action in record.actions], [15, 15])
        replayed = replay_game_record(record)
        self.assertTrue(replayed.game_over)

    def test_matchup_is_color_balanced_and_reports_draw_score(self) -> None:
        result = run_matchup(
            _PassAgent("A"),
            _PassAgent("B"),
            games=4,
            grid_size=5,
            base_seed=11,
            max_plies=10,
        )
        self.assertEqual([record.black_slot for record in result.games], ["A", "B", "A", "B"])
        self.assertEqual(result.summary["draws"], 4)
        self.assertEqual(result.summary["a_score_rate"], 0.5)
        self.assertEqual(result.summary["a_elo_difference"], 0.0)

    def test_truncation_is_not_counted_as_a_draw(self) -> None:
        result = run_matchup(
            RandomAgent("A"),
            RandomAgent("B"),
            games=2,
            grid_size=5,
            base_seed=2,
            max_plies=1,
        )
        self.assertEqual(result.summary["truncated_games"], 2)
        self.assertEqual(result.summary["games_completed"], 0)
        self.assertIsNone(result.summary["a_score_rate"])

    def test_illegal_and_mutating_agents_are_rejected(self) -> None:
        with self.assertRaises(IllegalAgentActionError):
            play_game(
                _IllegalAgent("bad"),
                _PassAgent("pass"),
                grid_size=5,
                seed=0,
                max_plies=4,
            )
        with self.assertRaises(RuntimeError):
            play_game(
                _MutatingAgent("mutator"),
                _PassAgent("pass"),
                grid_size=5,
                seed=0,
                max_plies=4,
            )

    def test_mcts_vs_random_smoke_match_has_only_legal_actions(self) -> None:
        result = run_matchup(
            MCTSAgent(MCTSConfig(simulations=4, rollout_depth=6)),
            RandomAgent(),
            games=2,
            grid_size=5,
            base_seed=5,
            max_plies=30,
        )
        self.assertEqual(len(result.games), 2)
        self.assertTrue(all(record.plies >= 2 for record in result.games))

    def test_artifact_writer_emits_summary_jsonl_and_csv(self) -> None:
        result = run_matchup(
            _PassAgent("A"),
            _PassAgent("B"),
            games=2,
            grid_size=5,
            max_plies=4,
        )
        temporary = Path(__file__).parent / "_arena_artifact_test"
        if temporary.exists():
            shutil.rmtree(temporary)
        temporary.mkdir()
        try:
            paths = write_matchup(result, temporary)
            summary = json.loads(paths["summary"].read_text(encoding="utf-8"))
            games = [
                json.loads(line)
                for line in paths["games"].read_text(encoding="utf-8").splitlines()
            ]
            for game in games:
                replay_game_record(game)
            with paths["csv"].open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            with self.assertRaises(FileExistsError):
                write_matchup(result, temporary)
        finally:
            shutil.rmtree(temporary)
        self.assertEqual(summary["games_requested"], 2)
        self.assertEqual(len(games), 2)
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
