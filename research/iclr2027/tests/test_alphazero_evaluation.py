from __future__ import annotations

import json
import random
import shutil
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from lifeline_rl import LifelineGame, run_matchup
from lifeline_rl.agents.base import legal_actions
from lifeline_rl.alphazero.evaluation import (
    ArenaGateConfig,
    evaluate_arena_gate,
    evaluate_matchup_gate,
    score_wilson_interval,
    write_gate_report,
)


class _FirstLegalAgent:
    def __init__(self, name: str = "candidate") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def select_action(self, game: LifelineGame, rng: random.Random):
        del rng
        return legal_actions(game)[0]

    def diagnostics(self):
        return {}


class _PassAgent:
    def __init__(self, name: str = "random") -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def select_action(self, game: LifelineGame, rng: random.Random):
        del game, rng
        return None

    def diagnostics(self):
        return {}


def _mark_b_as_random(summary: dict[str, object]) -> None:
    summary["agent_b_metadata"] = {
        "name": "random",
        "class": "lifeline_rl.agents.random_agent.RandomAgent",
    }
    summary["agent_kinds"] = {"A": "alphazero", "B": "random"}


def _mark_a_as_neural(summary: dict[str, object]) -> None:
    summary["agent_a_metadata"] = {
        "name": "candidate",
        "class": "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent",
        "config": {
            "model_kind": "topology_gnn",
            "observation_mode": "topology",
            "train_superko_mode": "enforce",
            "allow_superko_mode_override": False,
            "trained_board_sizes": [5],
            "parameter_count": 100,
            "search": {"simulations": 16, "c_puct": 1.5, "temperature": 0.0},
            "checkpoint": {
                "sha256": "a" * 64,
                "config_hash": "b" * 64,
                "source_hash": "c" * 64,
                "games_completed": 100,
                "gradient_steps": 200,
            },
        },
    }


def _bind_d13_candidate_diagnostics(games: list[dict[str, object]]) -> None:
    for record in games:
        candidate_actor = "BLACK" if record["black_slot"] == "A" else "WHITE"
        for action in record["actions"]:
            if action["actor"] != candidate_actor:
                continue
            action["diagnostics"] = {
                "algorithm": "neural_puct",
                "model_kind": "topology_gnn",
                "checkpoint_sha256": "a" * 64,
                "train_superko_mode": "enforce",
                "eval_superko_mode": "enforce",
                "superko_mode_override": False,
                "allow_superko_mode_override": False,
                "simulations": 16,
                "temperature": 0.0,
                "selected_action": action["action"],
                "root_visit_sum": 16,
            }


class AlphaZeroEvaluationTests(unittest.TestCase):
    def test_formal_gate_factories_are_frozen(self) -> None:
        random_gate = ArenaGateConfig.formal_beat_random()
        self.assertEqual(random_gate.games_required, 200)
        self.assertEqual(random_gate.completed_games_required, 200)
        self.assertEqual(random_gate.maximum_truncated_games, 0)
        self.assertEqual(random_gate.minimum_wilson_lower_bound_exclusive, 0.5)

        promotion = ArenaGateConfig.formal_promotion()
        self.assertEqual(promotion.minimum_score_rate, 0.55)
        self.assertIsNone(promotion.minimum_wilson_lower_bound_exclusive)
        with self.assertRaisesRegex(ValueError, "exactly 200"):
            ArenaGateConfig(
                evidence_tier="formal",
                gate_kind="beat_random",
                games_required=20,
                completed_games_required=20,
                maximum_truncated_games=0,
            )
        with self.assertRaisesRegex(ValueError, "thresholds are frozen"):
            ArenaGateConfig(
                evidence_tier="formal",
                gate_kind="beat_random",
                games_required=200,
                completed_games_required=200,
                maximum_truncated_games=0,
            )
        weakened = random_gate.to_dict()
        weakened["minimum_wilson_lower_bound_exclusive"] = 0.1
        with self.assertRaisesRegex(ValueError, "thresholds are frozen"):
            ArenaGateConfig.from_dict(weakened)

    def test_wilson_interval_uses_draws_as_half_points(self) -> None:
        all_wins = score_wilson_interval(200, 0, 0)
        all_draws = score_wilson_interval(0, 0, 200)
        self.assertIsNotNone(all_wins)
        self.assertGreater(all_wins[0], 0.98)
        self.assertAlmostEqual(all_draws[0], 0.43135962209034523)
        self.assertAlmostEqual(all_draws[1], 0.5686403779096547)
        self.assertIsNone(score_wilson_interval(0, 0, 0))

    def test_formal_beat_random_gate_passes_replayed_color_pairs(self) -> None:
        two_games = run_matchup(
            _FirstLegalAgent(),
            _PassAgent(),
            games=2,
            grid_size=5,
            base_seed=20260825,
            max_plies=256,
        )
        games = []
        for pair_index in range(100):
            for color_index, template in enumerate(two_games.games):
                record = deepcopy(template.to_dict())
                record["game_index"] = pair_index * 2 + color_index
                record["pair_index"] = pair_index
                record["seed"] = 20260825 + pair_index
                pair_seed = 20260825 + pair_index
                seed_a = pair_seed * 2 + 10_001
                seed_b = pair_seed * 2 + 20_001
                if record["black_slot"] == "A":
                    record["black_policy_seed"] = seed_a
                    record["white_policy_seed"] = seed_b
                else:
                    record["black_policy_seed"] = seed_b
                    record["white_policy_seed"] = seed_a
                games.append(record)
        _bind_d13_candidate_diagnostics(games)
        summary = dict(two_games.summary)
        summary.update(
            {
                "games_requested": 200,
                "games_completed": 200,
                "truncated_games": 0,
                "a_wins": 200,
                "a_losses": 0,
                "draws": 0,
                "a_score_rate": 1.0,
                "a_score_ci95_wilson": list(score_wilson_interval(200, 0, 0)),
                "a_as_black": {
                    "wins": 100,
                    "losses": 0,
                    "draws": 0,
                    "truncated": 0,
                },
                "a_as_white": {
                    "wins": 100,
                    "losses": 0,
                    "draws": 0,
                    "truncated": 0,
                },
                "evaluation_protocol": {
                    "gate_kind": "beat_random",
                    "evidence_tier": "formal",
                    "shared_puct_search": {
                        "simulations": 16,
                        "c_puct": 1.5,
                        "temperature": 0.0,
                    },
                    "root_noise": False,
                    "strict_source_validation": True,
                    "allow_superko_mode_override": False,
                },
                "base_seed": 20260825,
                "max_plies": 256,
            }
        )
        _mark_a_as_neural(summary)
        _mark_b_as_random(summary)
        with patch(
            "lifeline_rl.alphazero.evaluation.replay_game_record"
        ) as replay:
            report = evaluate_arena_gate(
                summary,
                games,
                ArenaGateConfig.formal_beat_random(),
            )

        self.assertTrue(report["passed"])
        self.assertTrue(report["claim_eligible"])
        self.assertEqual(report["reasons"], [])
        self.assertEqual(report["observed"]["a_wins"], 200)
        self.assertEqual(len(report["artifact_binding"]["games_sha256"]), 64)
        self.assertEqual(replay.call_count, 200)

        relaxed = deepcopy(summary)
        relaxed["evaluation_protocol"]["shared_puct_search"]["simulations"] = 64
        with patch("lifeline_rl.alphazero.evaluation.replay_game_record"):
            rejected = evaluate_arena_gate(
                relaxed,
                games,
                ArenaGateConfig.formal_beat_random(),
            )
        self.assertFalse(rejected["passed"])
        self.assertIn("d13_formal_evaluation_protocol_mismatch", rejected["reasons"])

        duplicated_pair_seed = deepcopy(games)
        duplicated_pair_seed[2]["seed"] = duplicated_pair_seed[0]["seed"]
        duplicated_pair_seed[3]["seed"] = duplicated_pair_seed[0]["seed"]
        for record in duplicated_pair_seed[2:4]:
            if record["black_slot"] == "A":
                record["black_policy_seed"] = duplicated_pair_seed[0]["black_policy_seed"]
                record["white_policy_seed"] = duplicated_pair_seed[0]["white_policy_seed"]
            else:
                record["black_policy_seed"] = duplicated_pair_seed[0]["white_policy_seed"]
                record["white_policy_seed"] = duplicated_pair_seed[0]["black_policy_seed"]
        with patch("lifeline_rl.alphazero.evaluation.replay_game_record"):
            rejected_seed = evaluate_arena_gate(
                summary,
                duplicated_pair_seed,
                ArenaGateConfig.formal_beat_random(),
            )
        self.assertFalse(rejected_seed["passed"])
        self.assertIn("pair_1_seed_not_derived_from_base", rejected_seed["reasons"])

        mismatched_record_protocol = deepcopy(games)
        mismatched_record_protocol[0]["grid_size"] = 7
        mismatched_record_protocol[1]["superko_mode"] = "observe"
        with patch("lifeline_rl.alphazero.evaluation.replay_game_record"):
            rejected_record = evaluate_arena_gate(
                summary,
                mismatched_record_protocol,
                ArenaGateConfig.formal_beat_random(),
            )
        self.assertFalse(rejected_record["passed"])
        self.assertIn("pair_0_grid_size_summary_mismatch", rejected_record["reasons"])
        self.assertIn(
            "pair_0_superko_mode_summary_mismatch", rejected_record["reasons"]
        )

        spoofed_class = deepcopy(summary)
        spoofed_class["agent_a_metadata"]["class"] = "evil.NeuralPUCTAgent"
        spoofed_class["agent_b_metadata"]["class"] = "evil.RandomAgent"
        with patch("lifeline_rl.alphazero.evaluation.replay_game_record"):
            rejected_class = evaluate_arena_gate(
                spoofed_class,
                games,
                ArenaGateConfig.formal_beat_random(),
            )
        self.assertFalse(rejected_class["passed"])
        self.assertIn("agent_a_is_not_a_frozen_neural_checkpoint", rejected_class["reasons"])
        self.assertIn("agent_b_is_not_random", rejected_class["reasons"])

        tampered_diagnostics = deepcopy(games)
        for action in tampered_diagnostics[0]["actions"]:
            if action["actor"] == "BLACK":
                action["diagnostics"]["checkpoint_sha256"] = "d" * 64
                break
        with patch("lifeline_rl.alphazero.evaluation.replay_game_record"):
            rejected_diagnostics = evaluate_arena_gate(
                summary,
                tampered_diagnostics,
                ArenaGateConfig.formal_beat_random(),
            )
        self.assertFalse(rejected_diagnostics["passed"])
        self.assertFalse(
            rejected_diagnostics["checks"][
                "d13_formal_decisions_bound_to_checkpoint"
            ]
        )
        self.assertTrue(
            any(
                "candidate_diagnostics_mismatch" in reason
                for reason in rejected_diagnostics["reasons"]
            )
        )

    def test_pair_seed_tampering_and_summary_tampering_fail(self) -> None:
        result = run_matchup(
            _FirstLegalAgent(),
            _PassAgent(),
            games=2,
            grid_size=5,
            base_seed=19,
            max_plies=40,
        )
        _mark_b_as_random(result.summary)
        games = [record.to_dict() for record in result.games]
        games[1]["white_policy_seed"] += 1
        summary = dict(result.summary)
        summary["a_wins"] = 0
        gate = ArenaGateConfig.exploratory(
            evidence_tier="pilot",
            gate_kind="beat_random",
            games=2,
        )
        report = evaluate_arena_gate(summary, games, gate)

        self.assertFalse(report["passed"])
        self.assertFalse(report["claim_eligible"])
        self.assertIn("pair_0_agent_a_policy_seed_mismatch", report["reasons"])
        self.assertTrue(
            any(reason.startswith("summary_count_mismatch") for reason in report["reasons"])
        )

    def test_smoke_can_pass_integrity_but_is_not_claim_eligible(self) -> None:
        result = run_matchup(
            _FirstLegalAgent(),
            _PassAgent(),
            games=2,
            grid_size=5,
            max_plies=40,
        )
        _mark_b_as_random(result.summary)
        gate = ArenaGateConfig.exploratory(
            evidence_tier="smoke",
            gate_kind="beat_random",
            games=2,
        )
        report = evaluate_matchup_gate(result, gate)
        self.assertTrue(report["passed"])
        self.assertFalse(report["claim_eligible"])

    def test_gate_report_is_atomic_and_refuses_overwrite(self) -> None:
        result = run_matchup(
            _FirstLegalAgent(),
            _PassAgent(),
            games=2,
            grid_size=5,
            max_plies=40,
        )
        _mark_b_as_random(result.summary)
        report = evaluate_matchup_gate(
            result,
            ArenaGateConfig.exploratory(
                evidence_tier="smoke",
                gate_kind="beat_random",
                games=2,
            ),
        )
        temporary = Path(__file__).parent / "_arena_gate_artifact_test"
        if temporary.exists():
            shutil.rmtree(temporary)
        temporary.mkdir()
        try:
            path = temporary / "gate.json"
            write_gate_report(report, path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)
            self.assertFalse(list(path.parent.glob(".*.tmp")))
            with self.assertRaises(FileExistsError):
                write_gate_report(report, path)
        finally:
            shutil.rmtree(temporary)


if __name__ == "__main__":
    unittest.main()
