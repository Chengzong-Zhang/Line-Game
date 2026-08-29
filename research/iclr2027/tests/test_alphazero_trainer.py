from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame, Player

try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class AlphaZeroTrainerTests(unittest.TestCase):
    @staticmethod
    def _experiences(count: int):
        from lifeline_rl.alphazero.replay import Experience

        game = LifelineGame(5)
        legal_points = set(game.legal_moves())
        mask = tuple(int(point in legal_points) for point in game.valid_positions) + (1,)
        visits = tuple(1 if legal else 0 for legal in mask)
        return tuple(
            Experience(
                grid_size=5,
                observation_mode="grid_graph",
                board=tuple(game.grid),
                physical_edges=game.physical_edges,
                logical_edges=(
                    tuple(sorted(game.edges[Player.BLACK])),
                    tuple(sorted(game.edges[Player.WHITE])),
                ),
                current_player=game.current_player.value,
                consecutive_skips=game.consecutive_skips,
                legal_action_mask=mask,
                root_visits=visits,
                z=1.0 if index % 2 else -1.0,
                state_fingerprint=game.state_fingerprint(),
                provenance={"game_index": 0, "ply": index},
            )
            for index in range(count)
        )

    def test_next_update_is_identical_after_full_checkpoint_resume(self) -> None:
        from lifeline_rl.alphazero.config import AlphaZeroConfig
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

        config = AlphaZeroConfig(
            board_sizes=(5,),
            iterations=2,
            games_per_iteration=1,
            puct_simulations=1,
            replay_capacity=16,
            batch_size=2,
            training_steps_per_iteration=1,
            hidden_channels=8,
            message_passing_layers=1,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            uninterrupted = AlphaZeroTrainer(config, root / "uninterrupted", device="cpu")
            uninterrupted.replay_buffer.add_game(self._experiences(4))
            uninterrupted.train_batch()
            uninterrupted.save()

            expected_metrics = uninterrupted.train_batch()
            expected_parameters = {
                name: parameter.detach().clone()
                for name, parameter in uninterrupted.model.state_dict().items()
            }
            expected_counters = uninterrupted.counters.to_dict()

            resumed = AlphaZeroTrainer(config, root / "resumed", device="cpu")
            resumed.resume(root / "uninterrupted" / "checkpoints")
            actual_metrics = resumed.train_batch()

            self.assertEqual(actual_metrics, expected_metrics)
            self.assertEqual(resumed.counters.to_dict(), expected_counters)
            self.assertEqual(len(resumed.replay_buffer), len(uninterrupted.replay_buffer))
            for name, parameter in resumed.model.state_dict().items():
                self.assertTrue(torch.equal(parameter, expected_parameters[name]), name)


if __name__ == "__main__":
    unittest.main()
