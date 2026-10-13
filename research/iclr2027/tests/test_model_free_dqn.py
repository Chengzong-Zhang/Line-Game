from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame

try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class ModelFreeDQNTests(unittest.TestCase):
    def test_encoder_masks_native_pass_and_checkpoint_resume(self) -> None:
        from lifeline_rl.model_free.dqn import ACTION_COUNT, DQNConfig, DQNTrainer, encode_game

        game = LifelineGame(5)
        _, mask = encode_game(game)
        self.assertEqual(mask.shape[0], ACTION_COUNT)
        self.assertTrue(bool(mask[game.num_points]))
        self.assertFalse(bool(mask[game.num_points + 1]))
        config = DQNConfig(
            board_sizes=(5,), episodes=2, max_plies=24, replay_capacity=64,
            batch_size=4, warmup_transitions=4, updates_per_episode=1,
            target_sync_episodes=1, checkpoint_every_episodes=1, hidden_channels=32,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trainer = DQNTrainer(config, root, device="cpu")
            first = trainer.run_episode()
            self.assertGreater(first["transitions"], 0)
            checkpoint = trainer.save()
            resumed = DQNTrainer(config, root / "resumed", device="cpu")
            resumed.resume(checkpoint)
            self.assertEqual(resumed.episode, trainer.episode)
            self.assertEqual(resumed.environment_steps, trainer.environment_steps)
            self.assertEqual(len(resumed.replay), len(trainer.replay))
            next_metrics = next(resumed.run(additional_episodes=1))
            self.assertEqual(next_metrics["episode"], trainer.episode + 1)


if __name__ == "__main__":
    unittest.main()
