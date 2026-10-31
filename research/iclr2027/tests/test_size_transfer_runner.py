from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra is not installed")
class SizeTransferRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        root = Path(__file__).resolve().parents[1]
        draft_path = root / "scripts" / "size_transfer_draft.py"
        runner_path = root / "scripts" / "size_transfer_runner.py"
        draft_spec = importlib.util.spec_from_file_location("size_transfer_draft_runner_test", draft_path)
        cls.draft = importlib.util.module_from_spec(draft_spec)
        draft_spec.loader.exec_module(cls.draft)
        runner_spec = importlib.util.spec_from_file_location("size_transfer_runner_test", runner_path)
        cls.runner = importlib.util.module_from_spec(runner_spec)
        runner_spec.loader.exec_module(cls.runner)
        from lifeline_rl.alphazero.config import AlphaZeroConfig
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        source_dir = root / "source"
        cls.config = AlphaZeroConfig(
            seed=2026092201,
            board_sizes=(5,),
            model_kind="grid_gnn",
            hidden_channels=4,
            message_passing_layers=1,
            iterations=1,
            games_per_iteration=1,
            puct_simulations=1,
            max_plies=96,
            temperature_moves=96,
            initial_temperature=1.0,
            final_temperature=1.0,
            replay_capacity=256,
            batch_size=1,
            training_steps_per_iteration=1,
            checkpoint_every=1,
        )
        source_trainer = AlphaZeroTrainer(cls.config, source_dir, device="cpu")
        manifest = source_trainer.save()
        cls.source = source_dir / "checkpoints" / manifest["checkpoint"]
        cls.source_sha = manifest["sha256"]
        cls.template = root / "initialized-template"
        cls.draft.initialize(cls.config, cls.template, source=cls.source, source_sha256=cls.source_sha)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.draft = type(self).draft
        self.runner = type(self).runner
        self.config = type(self).config

    def _make_run(self, name: str) -> Path:
        run = Path(self.temporary.name) / name
        shutil.copytree(self.template, run)
        return run

    def _fake_game(self, searcher, config, seed, *, game_index=0, replay_buffer=None):
        del searcher, replay_buffer
        from lifeline_rl import LifelineGame, Player
        from lifeline_rl.alphazero.replay import Experience

        game = LifelineGame(config.grid_size, start_player=config.start_player, superko_mode=config.superko_mode)
        legal_points = set(game.legal_moves())
        mask = tuple(int(point in legal_points) for point in game.valid_positions) + (1,)
        visits = tuple(1 if legal else 0 for legal in mask)
        experience = Experience(
            grid_size=config.grid_size,
            observation_mode=config.observation_mode,
            board=tuple(game.grid),
            physical_edges=game.physical_edges,
            logical_edges=(tuple(sorted(game.edges[Player.BLACK])), tuple(sorted(game.edges[Player.WHITE]))),
            current_player=game.current_player.value,
            consecutive_skips=game.consecutive_skips,
            legal_action_mask=mask,
            root_visits=visits,
            z=1.0,
            state_fingerprint=game.state_fingerprint(),
            provenance={"source": "cpu-recovery-fixture", "game_index": game_index, "seed": seed},
        )

        class FakeResult:
            terminated = True
            truncated = False
            experiences = (experience,)
            actions = (object(),)

            def to_dict(self):
                return {
                    "schema_version": 1,
                    "game_index": game_index,
                    "seed": seed,
                    "grid_size": config.grid_size,
                    "superko_mode": config.superko_mode,
                    "start_player": config.start_player,
                    "terminated": True,
                    "truncated": False,
                    "final_state_fingerprint": experience.state_fingerprint,
                    "winner": "BLACK",
                    "rewards": {"BLACK": 1.0, "WHITE": -1.0},
                    "plies": 1,
                    "added_to_replay": False,
                    "sample_count": 1,
                    "actions": [],
                }

        return FakeResult()

    def _run_fault_and_recover(self, event: str) -> dict:
        run = self._make_run("fault-" + event)
        def install_fast_batch(worker):
            def fast_batch():
                worker.trainer.counters.gradient_steps += 1
                worker.trainer.counters.examples_seen += 1
                return {"loss": 0.0, "policy_loss": 0.0, "value_loss": 0.0, "gradient_norm": 0.0}
            worker.trainer.train_batch = fast_batch
        with patch.object(self.runner, "play_self_play_game", self._fake_game):
            with self.assertRaises(self.runner.InjectedCrash):
                worker = self.runner.RecoverableRunner(run, fault_after=event)
                # Keep the six-boundary matrix focused on transaction recovery;
                # a real optimizer step here makes this fault-injection test
                # needlessly slow and vulnerable to external interruption.
                install_fast_batch(worker)
                worker.run()
            recovery = self.runner.RecoverableRunner(run)
            install_fast_batch(recovery)
            result = recovery.run()
        self.assertEqual(result, "COMPLETE_NOT_FORMAL")
        return self.runner._read_json(run / "stage_receipt.json")

    def test_fault_injection_recovery_for_each_commit_boundary(self):
        receipts = [
            self._run_fault_and_recover(event)
            for event in (
                "game_prepare",
                "game_checkpoint",
                "update_prepare",
                "update_checkpoint",
                "iteration_prepare",
                "iteration_checkpoint",
            )
        ]
        for receipt in receipts:
            self.assertEqual(receipt["counters"]["iteration"], 1)
            self.assertEqual(receipt["counters"]["next_game_id"], 1)
            self.assertEqual(receipt["counters"]["gradient_steps"], 1)
        # Each recovery path commits the same stable game/update/iteration units.
        game_counts = []
        update_counts = []
        for event in ("game_prepare", "game_checkpoint", "update_prepare", "update_checkpoint", "iteration_prepare", "iteration_checkpoint"):
            run = Path(self.temporary.name) / ("fault-" + event)
            game_counts.append(len(self.runner._read_jsonl(run / "committed_games.jsonl")))
            update_counts.append(len(self.runner._read_jsonl(run / "committed_updates.jsonl")))
        self.assertEqual(game_counts, [1] * 6)
        self.assertEqual(update_counts, [1] * 6)
        self.assertEqual(
            [
                self.runner._read_jsonl(
                    Path(self.temporary.name) / ("fault-" + event) / "committed_metrics.jsonl"
                )[0]["gradient_steps_this_iteration"]
                for event in (
                    "game_prepare",
                    "game_checkpoint",
                    "update_prepare",
                    "update_checkpoint",
                    "iteration_prepare",
                    "iteration_checkpoint",
                )
            ],
            [1] * 6,
        )

    def test_manifest_replace_failure_preserves_old_checkpoint_and_recovers(self):
        run = self._make_run("manifest-replace-failure")
        checkpoint_module = importlib.import_module("lifeline_rl.alphazero.checkpoint")
        checkpoints = run / "checkpoints"
        old_manifest_path = checkpoints / "latest.json"
        old_manifest_bytes = old_manifest_path.read_bytes()
        old_manifest = self.runner._read_json(old_manifest_path)
        old_checkpoint = checkpoints / old_manifest["checkpoint"]
        old_checkpoint_sha = checkpoint_module._sha256_file(old_checkpoint)
        real_replace = checkpoint_module.os.replace

        def fail_latest_replace(source, destination):
            if Path(destination).name == "latest.json":
                raise PermissionError("injected latest manifest replacement failure")
            return real_replace(source, destination)

        with patch.object(self.runner, "play_self_play_game", self._fake_game):
            with self.assertRaisesRegex(checkpoint_module.CheckpointError, "latest manifest update failed"):
                with patch.object(checkpoint_module.os, "replace", side_effect=fail_latest_replace):
                    worker = self.runner.RecoverableRunner(run)

                    def fast_batch():
                        worker.trainer.counters.gradient_steps += 1
                        worker.trainer.counters.examples_seen += 1
                        return {"loss": 0.0, "policy_loss": 0.0, "value_loss": 0.0, "gradient_norm": 0.0}

                    worker.trainer.train_batch = fast_batch
                    worker.run()

            self.assertEqual(old_manifest_path.read_bytes(), old_manifest_bytes)
            self.assertEqual(checkpoint_module._sha256_file(old_checkpoint), old_checkpoint_sha)
            new_checkpoints = [path for path in checkpoints.glob("runner-*.pt")]
            self.assertEqual(len(new_checkpoints), 1)

            recovery = self.runner.RecoverableRunner(run)

            def fast_recovery_batch():
                recovery.trainer.counters.gradient_steps += 1
                recovery.trainer.counters.examples_seen += 1
                return {"loss": 0.0, "policy_loss": 0.0, "value_loss": 0.0, "gradient_norm": 0.0}

            recovery.trainer.train_batch = fast_recovery_batch
            self.assertEqual(recovery.run(), "COMPLETE_NOT_FORMAL")

        receipt = self.runner._read_json(run / "stage_receipt.json")
        self.assertEqual(receipt["counters"]["iteration"], 1)
        self.assertEqual(len(self.runner._read_jsonl(run / "committed_games.jsonl")), 1)
        self.assertEqual(len(self.runner._read_jsonl(run / "committed_updates.jsonl")), 1)

    def test_clean_run_and_supervisor_have_durable_receipts(self):
        run = self._make_run("clean")
        with patch.object(self.runner, "play_self_play_game", self._fake_game):
            worker = self.runner.RecoverableRunner(run)
            def fast_batch():
                worker.trainer.counters.gradient_steps += 1
                worker.trainer.counters.examples_seen += 1
                return {"loss": 0.0, "policy_loss": 0.0, "value_loss": 0.0, "gradient_norm": 0.0}
            worker.trainer.train_batch = fast_batch
            self.assertEqual(worker.run(), "COMPLETE_NOT_FORMAL")
        with patch.object(
            self.runner.subprocess,
            "run",
            return_value=self.runner.subprocess.CompletedProcess([], 0),
        ) as child:
            self.assertEqual(self.runner.supervise(run, device="cuda"), "COMPLETE_NOT_FORMAL")
        child.assert_called_once()
        self.assertEqual(child.call_args.args[0][-1], "cuda")
        self.assertIn(
            str(Path(__file__).resolve().parents[1]),
            child.call_args.kwargs["env"]["PYTHONPATH"],
        )
        receipt = self.runner._read_json(run / "stage_receipt.json")
        self.assertFalse(receipt["formal_ready"])
        self.assertEqual(receipt["counters"]["iteration"], 1)
        self.assertEqual(len(self.runner._read_jsonl(run / "committed_games.jsonl")), 1)
        self.assertEqual(len(self.runner._read_jsonl(run / "committed_updates.jsonl")), 1)
        self.assertEqual(len(self.runner._read_jsonl(run / "committed_metrics.jsonl")), 1)

    def test_corrupt_transaction_fails_closed_and_lock_blocks_duplicate_worker(self):
        run = self._make_run("integrity")
        first = self.runner.RecoverableRunner(run)
        with self.runner.WorkerLock(run / ".worker.lock"):
            with self.assertRaises(self.runner.RunnerIntegrityError):
                self.runner.RecoverableRunner(run).run()
        with patch.object(self.runner, "play_self_play_game", self._fake_game):
            def fast_batch():
                first.trainer.counters.gradient_steps += 1
                first.trainer.counters.examples_seen += 1
                return {"loss": 0.0, "policy_loss": 0.0, "value_loss": 0.0, "gradient_norm": 0.0}
            first.trainer.train_batch = fast_batch
            first.run()
        transaction = sorted((run / "transactions").glob("*.json"))[0]
        transaction.write_text(transaction.read_text(encoding="utf-8") + "\n{}\n", encoding="utf-8")
        with self.assertRaises(self.runner.RunnerIntegrityError):
            self.runner.RecoverableRunner(run)

    @unittest.skipUnless(os.name == "nt", "Windows PID probe regression")
    def test_windows_pid_probe_does_not_send_a_console_signal(self):
        with patch.object(self.runner.os, "kill", side_effect=AssertionError("signal probe is unsafe on Windows")):
            self.assertTrue(self.runner._pid_is_alive(os.getpid()))
            self.assertFalse(self.runner._pid_is_alive(0))
            self.assertFalse(self.runner._pid_is_alive(0xFFFFFFFE))

    def test_pause_stop_and_evaluation_append_are_explicit(self):
        run = self._make_run("controls")
        (run / "PAUSE").write_text("operator pause\n", encoding="utf-8")
        self.assertEqual(self.runner.RecoverableRunner(run).run(), "PAUSED")
        (run / "PAUSE").unlink()
        (run / "STOP").write_text("operator stop\n", encoding="utf-8")
        self.assertEqual(self.runner.RecoverableRunner(run).run(), "STOPPED")
        record = {"evaluation_id": "dev-n5-random-000", "status": "COMPLETE", "game_ids": ["g0", "g1"]}
        self.runner.append_evaluation_record(run, record)
        self.runner.append_evaluation_record(run, record)
        with self.assertRaises(self.runner.RunnerIntegrityError):
            self.runner.append_evaluation_record(run, {**record, "status": "TAMPERED"})


if __name__ == "__main__":
    unittest.main()
