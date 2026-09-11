"""Focused regression checks for the D20 strong-opponent calibration gate."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = RESEARCH_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import d20_strong_opponent_calibration as calibration  # noqa: E402
import verify_d20_strong_opponent_calibration as verifier  # noqa: E402
from lifeline_rl import LifelineGame  # noqa: E402
from lifeline_rl.agents.minimax import MinimaxAgent, MinimaxConfig  # noqa: E402
from lifeline_rl.agents.mcts import MCTSAgent, MCTSConfig  # noqa: E402


class D20StrongOpponentCalibrationTests(unittest.TestCase):
    def test_registered_plan_and_openings_are_complete_and_replayable(self) -> None:
        manifest = calibration.load_manifest()
        self.assertEqual(manifest, verifier.load_manifest())
        plan = calibration.build_task_plan(manifest)
        registry = calibration.generate_opening_registry(manifest)

        self.assertEqual(len(plan), 40)
        self.assertEqual(sum(2 for _ in plan), 80)
        for size, entries in registry.items():
            self.assertEqual(len(entries), 20, size)
            self.assertEqual(len({entry["prefix_fingerprint"] for entry in entries}), 20, size)
            for entry in entries:
                replayed = calibration._opening_from_actions(int(size), entry["actions"])
                self.assertEqual(replayed.state_fingerprint(), entry["prefix_fingerprint"])
                hashed = dict(entry)
                recorded = hashed.pop("row_sha256")
                self.assertEqual(recorded, calibration.canonical_sha256(hashed))

    def test_colour_swapped_pair_is_replayable_without_using_formal_baselines(self) -> None:
        """Exercise record/replay invariants with intentionally tiny test agents."""

        game = LifelineGame(5, superko_mode="enforce")
        opening_action = game.point_to_index[game.legal_moves()[0]]
        calibration._apply_index(game, opening_action)
        opening = {
            "opening_id": "n5.b00.o00",
            "grid_size": 5,
            "block": 0,
            "opening_ordinal": 0,
            "actions": [opening_action],
            "prefix_fingerprint": game.state_fingerprint(),
        }
        task = {
            "pair_id": "test.n5.b00.o00",
            "pair_index": 0,
            "grid_size": 5,
            "block": 0,
            "opening_ordinal": 0,
            "opening_id": "n5.b00.o00",
            "candidate_policy_seed": 11,
            "reference_policy_seed": 29,
        }

        with patch.object(
            calibration,
            "_make_candidate",
            lambda: MinimaxAgent(MinimaxConfig(depth=1, move_cap=2), label="minimax_d2_cap8_v1"),
        ), patch.object(
            calibration,
            "_make_reference",
            lambda: MCTSAgent(MCTSConfig(simulations=1, rollout_depth=1), label="uct_mcts_s16_d80_v1"),
        ):
            rows = calibration._execute_pair(task, opening, 256)

        self.assertEqual([row["game_index"] for row in rows], [0, 1])
        self.assertEqual({row["black_slot"] for row in rows}, {"A", "B"})
        for row in rows:
            verifier._replay_game(row, task, opening, 256)

    def test_verifier_is_not_coupled_to_executor_import(self) -> None:
        source = Path(verifier.__file__).read_text(encoding="utf-8")
        self.assertNotIn("import d20_strong_opponent_calibration", source)
        self.assertNotIn("from d20_strong_opponent_calibration", source)


if __name__ == "__main__":
    unittest.main()
