from __future__ import annotations

import shutil
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame, Player

try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class AlphaZeroLearningHealthTests(unittest.TestCase):
    def test_formal_thresholds_are_frozen(self) -> None:
        from lifeline_rl.alphazero.learning_health import LearningHealthConfig

        gate = LearningHealthConfig()
        self.assertEqual(gate.evidence_tier, "formal")
        self.assertEqual(gate.minimum_games_completed, 100)
        self.assertEqual(gate.minimum_gradient_steps, 200)
        self.assertEqual(gate.minimum_relative_loss_improvement, 0.01)
        with self.assertRaisesRegex(ValueError, "formal.*frozen"):
            LearningHealthConfig(
                evidence_tier="formal",
                minimum_games_completed=1,
            )

    def test_non_float_model_state_does_not_break_parameter_diagnostics(self) -> None:
        from lifeline_rl.alphazero.learning_health import _parameter_diagnostics

        class ModelWithBooleanBuffer(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.weight = torch.nn.Parameter(torch.tensor([1.0]))
                self.register_buffer("initialized", torch.tensor(True))

        initial = ModelWithBooleanBuffer()
        final = ModelWithBooleanBuffer()
        with torch.no_grad():
            final.weight.add_(2.0)
        finite, delta = _parameter_diagnostics(initial, final)
        self.assertTrue(finite)
        self.assertEqual(delta, 2.0)

    def test_checkpoint_counters_are_not_coerced_or_allowed_to_disagree(self) -> None:
        from lifeline_rl.alphazero.learning_health import _validated_counters
        from lifeline_rl.alphazero.trainer import TrainingCounters

        counters = TrainingCounters().to_dict()
        payload = {
            "counters": counters,
            "trainer_state": {"schema_version": 1, "counters": dict(counters)},
        }
        payload["counters"]["games_completed"] = "100"
        payload["trainer_state"]["counters"]["games_completed"] = "100"
        with self.assertRaisesRegex(ValueError, "non-negative integers"):
            _validated_counters(payload)

        payload["counters"]["games_completed"] = 100
        payload["trainer_state"]["counters"]["games_completed"] = 99
        with self.assertRaisesRegex(ValueError, "counters disagree"):
            _validated_counters(payload)

    def test_trained_topology_checkpoint_beats_its_reconstructed_initialization(self) -> None:
        from lifeline_rl.alphazero.config import AlphaZeroConfig
        from lifeline_rl.alphazero.learning_health import (
            LearningHealthConfig,
            evaluate_learning_health,
        )
        from lifeline_rl.alphazero.replay import Experience
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

        output = Path(__file__).parent / "_learning_health_test"
        if output.exists():
            shutil.rmtree(output)
        try:
            config = AlphaZeroConfig(
                seed=123,
                observation_mode="topology",
                model_kind="topology_gnn",
                board_sizes=(5,),
                puct_simulations=1,
                replay_capacity=32,
                batch_size=8,
                hidden_channels=8,
                message_passing_layers=1,
            )
            trainer = AlphaZeroTrainer(config, output, device="cpu")
            game = LifelineGame(5)
            legal = set(game.legal_moves())
            mask = tuple(int(point in legal) for point in game.valid_positions) + (1,)
            visits = tuple(1 if value else 0 for value in mask)
            experiences = tuple(
                Experience(
                    grid_size=5,
                    observation_mode="topology",
                    board=tuple(game.grid),
                    physical_edges=game.physical_edges,
                    logical_edges=(
                        tuple(sorted(game.edges[Player.BLACK])),
                        tuple(sorted(game.edges[Player.WHITE])),
                    ),
                    current_player=game.current_player.value,
                    consecutive_skips=0,
                    legal_action_mask=mask,
                    root_visits=visits,
                    z=0.0,
                    state_fingerprint=game.state_fingerprint(),
                    provenance={"game_index": 0, "ply": index},
                )
                for index in range(8)
            )
            trainer.replay_buffer.add_game(experiences)
            trainer.counters.games_completed = 1
            for _ in range(20):
                trainer.train_batch()
            trainer.save()

            report = evaluate_learning_health(
                output / "checkpoints",
                LearningHealthConfig.exploratory("smoke"),
            )
            self.assertTrue(report["passed"], report)
            self.assertFalse(report["claim_eligible"])
            self.assertGreater(report["observed"]["parameter_delta_l2"], 0.0)
            self.assertGreaterEqual(
                report["observed"]["relative_total_loss_improvement"], 0.0
            )
            self.assertTrue(report["checks"]["checkpoint_metadata"])
            self.assertTrue(report["checks"]["initialization_runtime"])

            non_strict_formal = evaluate_learning_health(
                output / "checkpoints",
                LearningHealthConfig(),
                strict_source=False,
            )
            self.assertFalse(non_strict_formal["checks"]["strict_source_verified"])
            self.assertFalse(non_strict_formal["passed"])
            self.assertFalse(non_strict_formal["claim_eligible"])
        finally:
            if output.exists():
                shutil.rmtree(output)


if __name__ == "__main__":
    unittest.main()
