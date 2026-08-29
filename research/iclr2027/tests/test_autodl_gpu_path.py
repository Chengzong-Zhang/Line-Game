from __future__ import annotations

import math
import random
import tempfile
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame
from lifeline_rl.alphazero.puct import PUCTConfig, PolicyValue
from lifeline_rl.alphazero.replay import ReplayBuffer
from lifeline_rl.alphazero.self_play import SelfPlayConfig
from lifeline_rl_autodl.batched_puct import BatchedPUCTSearch
from lifeline_rl_autodl.multi_actor import play_multi_actor_self_play

try:
    import torch
except ImportError:
    torch = None


class CountingBatchEvaluator:
    def __init__(self, *, pass_only: bool = False):
        self.pass_only = pass_only
        self.batch_sizes: list[int] = []

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        raise AssertionError("multi-actor search must not use scalar inference")

    def evaluate_batch(self, games):
        games = tuple(games)
        self.batch_sizes.append(len(games))
        results = []
        for game in games:
            if game.game_over:
                raise AssertionError("terminal game reached the evaluator")
            if self.pass_only:
                priors = (0.0,) * game.num_points + (1.0,)
            else:
                priors = (1.0,) * (game.num_points + 1)
            results.append(PolicyValue(0.0, priors))
        return tuple(results)


class AutoDLBatchedPUCTTests(unittest.TestCase):
    def test_mixed_size_roots_batch_leaves_and_remain_immutable(self) -> None:
        games = tuple(LifelineGame(size) for size in (5, 6, 7))
        snapshots = tuple(game.clone() for game in games)
        evaluator = CountingBatchEvaluator()
        search = BatchedPUCTSearch(
            evaluator,
            PUCTConfig(simulations=3, dirichlet_epsilon=0.0),
        )
        results = search.search_batch(
            games,
            tuple(random.Random(100 + index) for index in range(len(games))),
            temperatures=(1.0, 1.0, 1.0),
            add_root_noise=False,
        )

        self.assertEqual(evaluator.batch_sizes[0], 3)
        self.assertTrue(all(size == 3 for size in evaluator.batch_sizes))
        self.assertEqual([sum(result.visits) for result in results], [3, 3, 3])
        self.assertEqual(
            [len(result.priors) for result in results],
            [game.num_points + 1 for game in games],
        )
        self.assertEqual(tuple(game.clone() for game in games), snapshots)

    def test_pass_biased_multi_actor_games_commit_together(self) -> None:
        evaluator = CountingBatchEvaluator(pass_only=True)
        search = BatchedPUCTSearch(
            evaluator,
            PUCTConfig(simulations=2, dirichlet_epsilon=0.0),
        )
        replay = ReplayBuffer(capacity=32, seed=7)
        configs = tuple(
            SelfPlayConfig(
                grid_size=size,
                max_plies=4,
                add_root_noise=False,
            )
            for size in (5, 6)
        )
        results = play_multi_actor_self_play(
            search,
            configs,
            (11, 12),
            game_indices=(20, 21),
            replay_buffer=replay,
        )

        self.assertEqual([result.plies for result in results], [2, 2])
        self.assertTrue(all(result.terminated for result in results))
        self.assertTrue(all(result.added_to_replay for result in results))
        self.assertEqual(len(replay), 4)
        self.assertIn(2, evaluator.batch_sizes)

    def test_legacy_formal_source_identity_is_unchanged(self) -> None:
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

        self.assertEqual(
            AlphaZeroTrainer.current_source_hash(),
            "21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c",
        )

    def test_stage_payload_covers_v2_checkpoint_source_identity(self) -> None:
        from lifeline_rl_autodl.trainer import BatchedAlphaZeroTrainer
        from scripts.prepare_autodl_game_stage import (
            INCLUDE,
            RESEARCH_ROOT,
            _source_files,
        )

        staged_files = {
            path.resolve()
            for relative in INCLUDE
            for path in _source_files(RESEARCH_ROOT / relative)
        }
        required_files = {
            path.resolve() for path in BatchedAlphaZeroTrainer.source_files()
        }
        self.assertEqual(required_files - staged_files, set())


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class AutoDLBatchedNetworkTests(unittest.TestCase):
    def test_mixed_size_batch_relocates_pass_and_matches_single_rows(self) -> None:
        from lifeline_rl.alphazero.network import (
            NetworkConfig,
            TopologyGNNPolicyValueNetwork,
        )
        from lifeline_rl_autodl.batched_network import (
            BatchedTorchPolicyValueEvaluator,
        )

        torch.manual_seed(4)
        model = TopologyGNNPolicyValueNetwork(NetworkConfig(8, 1))
        evaluator = BatchedTorchPolicyValueEvaluator(model, "topology", "cpu")
        games = (LifelineGame(5), LifelineGame(7))
        batched = evaluator.evaluate_batch(games)
        singles = tuple(evaluator.evaluate(game) for game in games)

        self.assertEqual([len(item.priors) for item in batched], [16, 29])
        for batch_item, single_item in zip(batched, singles):
            self.assertAlmostEqual(sum(batch_item.priors), 1.0, places=6)
            self.assertAlmostEqual(batch_item.value, single_item.value, places=6)
            for observed, expected in zip(batch_item.priors, single_item.priors):
                self.assertTrue(math.isclose(observed, expected, abs_tol=1e-6))

    def test_v2_trainer_runs_two_actors_and_binds_its_own_source(self) -> None:
        from lifeline_rl.alphazero.config import AlphaZeroConfig
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
        from lifeline_rl_autodl.trainer import (
            AutoDLRuntimeConfig,
            BatchedAlphaZeroTrainer,
        )

        config = AlphaZeroConfig(
            board_sizes=(5,),
            iterations=1,
            games_per_iteration=2,
            puct_simulations=1,
            max_plies=2,
            replay_capacity=32,
            batch_size=2,
            training_steps_per_iteration=0,
            hidden_channels=8,
            message_passing_layers=1,
        )
        with tempfile.TemporaryDirectory() as temporary:
            trainer = BatchedAlphaZeroTrainer(
                config,
                Path(temporary) / "run",
                device="cpu",
                runtime=AutoDLRuntimeConfig(actor_count=2, inference_amp=False),
            )
            metrics = trainer.run_iteration()
            self.assertEqual(metrics["actor_count"], 2)
            self.assertEqual(metrics["counters"]["games_attempted"], 2)
            self.assertEqual(metrics["execution_path"], "autodl_batched_v2")
            self.assertNotEqual(
                trainer.current_source_hash(),
                AlphaZeroTrainer.current_source_hash(),
            )


if __name__ == "__main__":
    unittest.main()
