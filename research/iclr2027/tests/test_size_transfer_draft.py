from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

try:
    import torch
except ImportError:
    torch = None


@unittest.skipUnless(torch is not None, "PyTorch training extra required")
class SizeTransferDraftTests(unittest.TestCase):
    def setUp(self):
        from lifeline_rl.alphazero.config import AlphaZeroConfig
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
        torch.set_num_threads(1)
        path = Path(__file__).resolve().parents[1] / "scripts" / "size_transfer_draft.py"
        spec = importlib.util.spec_from_file_location("size_transfer_draft", path)
        self.draft = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.draft)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = AlphaZeroConfig(board_sizes=(5, 7, 9), model_kind="grid_gnn",
                                      hidden_channels=8, message_passing_layers=1,
                                      batch_size=2, puct_simulations=1)
        self.source_trainer = AlphaZeroTrainer(self.config, self.root / "old")
        self.source_trainer.counters.gradient_steps = 7
        with torch.no_grad():
            next(self.source_trainer.model.parameters()).add_(0.125)
        manifest = self.source_trainer.save()
        self.source = self.root / "old" / "checkpoints" / manifest["checkpoint"]
        self.digest = manifest["sha256"]
        self.target = self.config.with_overrides(board_sizes=tuple(range(5, 16)), seed=123)

    def test_transfer_preserves_weights_but_resets_state_and_can_resume(self):
        from lifeline_rl.alphazero.checkpoint import CheckpointConfigError
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
        destination = self.root / "new"
        self.draft.initialize(self.target, destination, source=self.source,
                              source_sha256=self.digest)
        resumed = AlphaZeroTrainer(self.target, destination)
        resumed.resume(destination / "checkpoints")
        self.assertEqual(resumed.counters.gradient_steps, 0)
        self.assertEqual(resumed.counters.iteration, 0)
        self.assertEqual(len(resumed.replay_buffer), 0)
        self.assertEqual(len(resumed.optimizer.state), 0)
        for name, tensor in resumed.model.state_dict().items():
            self.assertTrue(torch.equal(tensor, self.source_trainer.model.state_dict()[name]))
        self.assertEqual(self.draft.sha256_file(self.source), self.digest)
        with self.assertRaises(CheckpointConfigError):
            wrong = AlphaZeroTrainer(self.config, self.root / "wrong")
            wrong.resume(destination / "checkpoints")

    def test_rejects_digest_mismatch_before_creating_output(self):
        destination = self.root / "bad"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.draft.initialize(self.target, destination, source=self.source,
                                  source_sha256="0" * 64)
        self.assertFalse(destination.exists())

    def test_rejects_architecture_and_superko_change(self):
        for change in ({"hidden_channels": 12}, {"superko_mode": "observe"}):
            with self.assertRaisesRegex(ValueError, "migration changes"):
                self.draft.initialize(self.target.with_overrides(**change),
                                      self.root / "bad", source=self.source,
                                      source_sha256=self.digest)
        self.assertFalse((self.root / "bad").exists())

    def test_dry_run_and_existing_output(self):
        destination = self.root / "new"
        receipt = self.draft.initialize(self.target, destination, source=self.source,
                                        source_sha256=self.digest, dry_run=True)
        self.assertEqual(receipt["status"], "PREFLIGHT_OK")
        self.assertFalse(destination.exists())
        destination.mkdir()
        (destination / "sentinel").write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.draft.initialize(self.target, destination)
        self.assertEqual((destination / "sentinel").read_text(), "keep")

    def test_random_initialization_and_source_argument_pair(self):
        destination = self.root / "random"
        with self.assertRaises(ValueError):
            self.draft.initialize(self.target, destination, source=self.source)
        result = self.draft.initialize(self.target, destination)
        self.assertEqual(result["initialization"], "random")
        self.assertIsNone(result["source"])

    def test_plan_is_matched_and_dependencies_are_explicit(self):
        plan = self.draft.generate_plan(self.source, self.digest, self.root / "plan")
        self.assertEqual(len(plan["tasks"]), 27)
        self.assertEqual(plan["total_game_attempt_cap"], 1728)
        seen = set()
        for task in plan["tasks"]:
            parent = task["initialize_from"]
            self.assertTrue(parent in seen or parent in ("source", "random"))
            seen.add(task["id"])
            config = self.draft.AlphaZeroConfig.load(self.root / "plan" / task["config"])
            self.assertEqual(config.fingerprint(), task["config_hash"])
            self.assertEqual(config.games_per_iteration, 1)
            if task["stage"] == 3:
                self.assertEqual(config.board_sizes, tuple(range(5, 16)))
        self.assertFalse(plan["formal_ready"])
        with self.assertRaises(FileExistsError):
            self.draft.generate_plan(self.source, self.digest, self.root / "plan")

    def test_probe_all_sizes_both_players_and_successors(self):
        result = self.draft.probe(self.source, self.digest)
        self.assertEqual(len(result["positions"]), 44)
        self.assertFalse(result["strength_evaluated"])
        self.assertEqual({record["size"] for record in result["positions"]}, set(range(5, 16)))

    def test_rejects_nonfinite_source_weights(self):
        payload = torch.load(self.source, map_location="cpu", weights_only=False)
        next(iter(payload["model_state_dict"].values())).view(-1)[0] = float("nan")
        invalid = self.root / "nonfinite.pt"
        torch.save(payload, invalid)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            self.draft.load_source(invalid, self.draft.sha256_file(invalid))


if __name__ == "__main__":
    unittest.main()
