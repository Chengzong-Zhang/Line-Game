from __future__ import annotations

import importlib.util
import io
import json
import random
import shutil
import unittest
from copy import deepcopy
from pathlib import Path
from contextlib import redirect_stdout


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None

if TORCH_AVAILABLE:
    import torch

    from lifeline_rl import LifelineGame
    from lifeline_rl.alphazero.checkpoint import (
        CheckpointConfigError,
        CheckpointSourceError,
        save_checkpoint,
    )
    from lifeline_rl.alphazero.config import AlphaZeroConfig
    from lifeline_rl.alphazero.network import (
        NetworkConfig,
        PolicyValueNetwork,
        build_policy_value_network,
    )
    from lifeline_rl.alphazero.neural_agent import (
        CheckpointRepresentationError,
        NeuralPUCTAgent,
        NeuralPUCTSearchConfig,
    )


@unittest.skipUnless(TORCH_AVAILABLE, "neural arena tests require torch")
class AlphaZeroNeuralAgentTests(unittest.TestCase):
    SOURCE_HASH = "b" * 64

    def setUp(self) -> None:
        self.temporary = Path(__file__).parent / "_neural_agent_checkpoint_test"
        if self.temporary.exists():
            shutil.rmtree(self.temporary)
        self.temporary.mkdir()

    def tearDown(self) -> None:
        if self.temporary.exists():
            shutil.rmtree(self.temporary)

    @staticmethod
    def _config(**changes) -> AlphaZeroConfig:
        config = AlphaZeroConfig(
            model_kind="grid_gnn",
            observation_mode="grid_graph",
            board_sizes=(5,),
            puct_simulations=2,
            hidden_channels=8,
            message_passing_layers=1,
        )
        return config.with_overrides(**changes) if changes else config

    def _save_new_checkpoint(self, config: AlphaZeroConfig):
        run = self.temporary / "run"
        checkpoints = run / "checkpoints"
        checkpoints.mkdir(parents=True)
        raw = config.to_dict()
        (run / "resolved_config.json").write_text(
            json.dumps(raw, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        torch.manual_seed(71)
        network_config = NetworkConfig(
            config.hidden_channels,
            config.message_passing_layers,
        )
        model = build_policy_value_network(config.model_kind, network_config)
        state = {
            key: value.detach().clone() for key, value in model.state_dict().items()
        }
        path = checkpoints / "checkpoint_000003.pt"
        manifest = save_checkpoint(
            path,
            model=model,
            config=json.loads(config.canonical_json(resume_critical=True)),
            source_hash=self.SOURCE_HASH,
            counters={
                "iteration": 3,
                "games_completed": 7,
                "gradient_steps": 11,
            },
            metadata={
                "model_kind": config.model_kind,
                "observation_mode": config.observation_mode,
                "network_config": network_config.to_dict(),
                "parameter_count": model.parameter_count,
            },
        )
        return run, path, manifest, state

    def test_checkpoint_loader_preserves_rng_and_exposes_provenance(self) -> None:
        config = self._config()
        run, path, manifest, expected_state = self._save_new_checkpoint(config)
        torch.manual_seed(991)
        rng_before = torch.get_rng_state().clone()

        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            device="cpu",
            expected_model_kind="grid_gnn",
            expected_observation_mode="grid_graph",
            expected_source_hash=self.SOURCE_HASH,
            search_config=NeuralPUCTSearchConfig(simulations=2),
        )

        torch.testing.assert_close(torch.get_rng_state(), rng_before)
        for key, expected in expected_state.items():
            torch.testing.assert_close(agent.model.state_dict()[key], expected)
        self.assertEqual(agent.checkpoint_identity.path, str(path.resolve()))
        self.assertEqual(agent.checkpoint_identity.sha256, manifest["sha256"])
        self.assertEqual(agent.config.model_kind, "grid_gnn")
        self.assertEqual(agent.config.observation_mode, "grid_graph")
        self.assertEqual(agent.config.checkpoint.iteration, 3)
        self.assertEqual(agent.config.checkpoint.games_completed, 7)
        self.assertEqual(agent.config.checkpoint.gradient_steps, 11)
        self.assertIsNone(agent.config.legacy_architecture)

    def test_agent_returns_legal_action_without_mutating_arena_game(self) -> None:
        run, _, _, _ = self._save_new_checkpoint(self._config())
        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_source_hash=self.SOURCE_HASH,
            search_config=NeuralPUCTSearchConfig(
                simulations=2,
                c_puct=1.25,
                temperature=0.0,
            ),
        )
        game = LifelineGame(5)
        before = game.clone()
        action = agent.select_action(game, random.Random(17))

        self.assertEqual(game.clone(), before)
        self.assertIn(action, [*game.legal_moves(), None])
        diagnostics = agent.diagnostics()
        self.assertEqual(diagnostics["algorithm"], "neural_puct")
        self.assertEqual(diagnostics["simulations"], 2)
        self.assertEqual(diagnostics["checkpoint_sha256"], agent.checkpoint_identity.sha256)

    def test_expected_representation_and_sidecar_config_are_enforced(self) -> None:
        config = self._config()
        run, _, _, _ = self._save_new_checkpoint(config)
        with self.assertRaises(CheckpointRepresentationError):
            NeuralPUCTAgent.from_checkpoint(
                run,
                expected_model_kind="topology_gnn",
                expected_source_hash=self.SOURCE_HASH,
            )

        tampered = config.with_overrides(seed=config.seed + 1)
        (run / "resolved_config.json").write_text(
            json.dumps(tampered.to_dict(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(CheckpointConfigError):
            NeuralPUCTAgent.from_checkpoint(
                run,
                expected_source_hash=self.SOURCE_HASH,
            )

    def test_superko_protocol_mismatch_requires_explicit_evaluation_override(self) -> None:
        run, _, _, _ = self._save_new_checkpoint(self._config(superko_mode="enforce"))
        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_source_hash=self.SOURCE_HASH,
            search_config=NeuralPUCTSearchConfig(simulations=1),
        )
        with self.assertRaises(CheckpointRepresentationError):
            agent.search(LifelineGame(5, superko_mode="observe"), random.Random(0))

        override_agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_source_hash=self.SOURCE_HASH,
            search_config=NeuralPUCTSearchConfig(simulations=1),
            allow_superko_mode_override=True,
        )
        observe_game = LifelineGame(5, superko_mode="observe")
        before = observe_game.clone()
        action = override_agent.select_action(observe_game, random.Random(0))

        self.assertIn(action, [*observe_game.legal_moves(), None])
        self.assertEqual(observe_game.clone(), before)
        self.assertEqual(override_agent.config.train_superko_mode, "enforce")
        self.assertEqual(override_agent.config.superko_mode, "enforce")
        self.assertTrue(override_agent.config.allow_superko_mode_override)
        self.assertEqual(
            override_agent.metadata_dict()["train_superko_mode"], "enforce"
        )
        self.assertNotIn("superko_mode", override_agent.metadata_dict())
        diagnostics = override_agent.diagnostics()
        self.assertEqual(diagnostics["train_superko_mode"], "enforce")
        self.assertEqual(diagnostics["eval_superko_mode"], "observe")
        self.assertTrue(diagnostics["superko_mode_override"])
        self.assertTrue(diagnostics["allow_superko_mode_override"])

    def test_superko_evaluation_override_flag_requires_boolean(self) -> None:
        run, _, _, _ = self._save_new_checkpoint(self._config())
        with self.assertRaises(TypeError):
            NeuralPUCTAgent.from_checkpoint(
                run,
                expected_source_hash=self.SOURCE_HASH,
                allow_superko_mode_override=1,
            )

    def test_legacy_gridgraph_checkpoint_uses_three_relation_architecture(self) -> None:
        config = self._config()
        raw = config.to_dict()
        raw.pop("model_kind")
        run = self.temporary / "legacy"
        checkpoints = run / "checkpoints"
        checkpoints.mkdir(parents=True)
        (run / "resolved_config.json").write_text(
            json.dumps(raw, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        network_config = NetworkConfig(
            config.hidden_channels,
            config.message_passing_layers,
        )
        model = PolicyValueNetwork(network_config)
        expected_parameters = model.parameter_count
        resume_config = dict(raw)
        resume_config.pop("iterations")
        resume_config.pop("checkpoint_every")
        save_checkpoint(
            checkpoints / "checkpoint_000001.pt",
            model=model,
            config=resume_config,
            source_hash=self.SOURCE_HASH,
            counters={"iteration": 1},
            metadata={
                "observation_mode": "grid_graph",
                "parameter_count": expected_parameters,
            },
        )

        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_source_hash=self.SOURCE_HASH,
            expected_model_kind="grid_gnn",
            search_config=NeuralPUCTSearchConfig(simulations=1),
        )
        self.assertEqual(
            agent.config.legacy_architecture,
            "d9_d10_three_relation_gnn_v0",
        )
        self.assertEqual(agent.config.parameter_count, expected_parameters)
        self.assertEqual(agent.config.observation_mode, "grid_graph")

    def test_neural_arena_cli_writes_artifacts_that_recompute(self) -> None:
        from scripts.run_neural_arena import main as run_neural_arena
        from scripts.verify_neural_arena_results import main as verify_neural_arena

        run, _, _, _ = self._save_new_checkpoint(self._config())
        output = self.temporary / "arena"
        captured = io.StringIO()
        with redirect_stdout(captured):
            exit_code = run_neural_arena(
                [
                    "--checkpoint-a",
                    str(run),
                    "--allow-source-mismatch",
                    "--gate-kind",
                    "beat_random",
                    "--evidence-tier",
                    "smoke",
                    "--games",
                    "2",
                    "--grid-size",
                    "5",
                    "--puct-simulations",
                    "1",
                    "--max-plies",
                    "20",
                    "--output-dir",
                    str(output),
                ]
            )
        self.assertEqual(exit_code, 0)
        for name in ("summary.json", "games.jsonl", "games.csv", "gate.json"):
            self.assertTrue((output / name).is_file())
        with redirect_stdout(captured):
            self.assertEqual(verify_neural_arena([str(output)]), 0)

        from scripts.verify_neural_arena_results import (
            verify_neural_arena_directory,
        )

        portable = verify_neural_arena_directory(
            output,
            skip_checkpoint_files=True,
        )
        self.assertTrue(portable["checkpoint_file_verification_skipped"])

    def test_persisted_verifier_rejects_checkpoint_identity_tampering(self) -> None:
        from scripts.verify_neural_arena_results import _verify_checkpoint

        run, _, _, _ = self._save_new_checkpoint(self._config())
        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_source_hash=self.SOURCE_HASH,
            search_config=NeuralPUCTSearchConfig(simulations=1),
        )
        metadata = {
            "class": "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent",
            "config": agent.metadata_dict(),
        }
        verified = _verify_checkpoint(
            metadata,
            "A",
            evidence_tier="smoke",
            gate_kind="beat_random",
        )
        self.assertEqual(verified["sha256"], agent.checkpoint_identity.sha256)

        tampered = deepcopy(metadata)
        tampered["config"]["checkpoint"]["config_hash"] = "f" * 64
        with self.assertRaises(CheckpointConfigError):
            _verify_checkpoint(
                tampered,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        wrong_sha = deepcopy(metadata)
        wrong_sha["config"]["checkpoint"]["sha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            _verify_checkpoint(
                wrong_sha,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        wrong_source = deepcopy(metadata)
        wrong_source["config"]["checkpoint"]["source_hash"] = "d" * 64
        with self.assertRaises(CheckpointSourceError):
            _verify_checkpoint(
                wrong_source,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        wrong_model = deepcopy(metadata)
        wrong_model["config"]["model_kind"] = "topology_gnn"
        with self.assertRaisesRegex(ValueError, "model_kind mismatch"):
            _verify_checkpoint(
                wrong_model,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        wrong_counter = deepcopy(metadata)
        wrong_counter["config"]["checkpoint"]["gradient_steps"] += 1
        with self.assertRaisesRegex(ValueError, "counter 'gradient_steps' mismatch"):
            _verify_checkpoint(
                wrong_counter,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        spoofed = deepcopy(metadata)
        spoofed["class"] = "evil.NeuralPUCTAgent"
        self.assertIsNone(
            _verify_checkpoint(
                spoofed,
                "A",
                evidence_tier="smoke",
                gate_kind="beat_random",
            )
        )

    def test_formal_verifier_forbids_skipping_checkpoint_files(self) -> None:
        from lifeline_rl.alphazero.evaluation import ArenaGateConfig
        from scripts.verify_neural_arena_results import verify_neural_arena_directory

        output = self.temporary / "formal_skip_rejected"
        output.mkdir()
        (output / "gate.json").write_text(
            json.dumps({"config": ArenaGateConfig.formal_beat_random().to_dict()}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "cannot skip checkpoint"):
            verify_neural_arena_directory(output, skip_checkpoint_files=True)

    def test_formal_checkpoint_verifier_loads_model_and_current_source(self) -> None:
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
        from scripts.verify_neural_arena_results import _verify_checkpoint

        config = AlphaZeroConfig(
            model_kind="topology_gnn",
            observation_mode="topology",
            board_sizes=(5,),
            hidden_channels=8,
            message_passing_layers=1,
        )
        run = self.temporary / "formal_checkpoint"
        trainer = AlphaZeroTrainer(config, run, device="cpu")
        trainer.counters.games_attempted = 100
        trainer.counters.games_completed = 100
        trainer.counters.gradient_steps = 200
        trainer.counters.next_game_id = 100
        (run / "resolved_config.json").write_text(
            json.dumps(config.to_dict(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        trainer.save(run / "checkpoints" / "checkpoint_000001.pt")
        agent = NeuralPUCTAgent.from_checkpoint(
            run,
            expected_model_kind="topology_gnn",
            search_config=NeuralPUCTSearchConfig(simulations=16),
        )
        metadata = {
            "class": "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent",
            "config": agent.metadata_dict(),
        }
        identity = _verify_checkpoint(
            metadata,
            "A",
            evidence_tier="formal",
            gate_kind="beat_random",
        )
        self.assertEqual(identity["games_completed"], 100)
        self.assertEqual(identity["gradient_steps"], 200)

    def test_d13_formal_cli_arguments_are_frozen(self) -> None:
        from scripts.run_neural_arena import (
            _parser,
            _validate_formal_protocol_args,
        )

        base = [
            "--checkpoint-a", "unused",
            "--gate-kind", "beat_random",
            "--evidence-tier", "formal",
            "--games", "200",
            "--grid-size", "5",
            "--max-plies", "256",
            "--seed", "20260825",
            "--puct-simulations", "16",
            "--c-puct", "1.5",
            "--temperature", "0",
            "--superko-mode", "enforce",
        ]
        args = _parser().parse_args(base)
        _validate_formal_protocol_args(args)

        relaxed = _parser().parse_args([*base, "--puct-simulations", "64"])
        with self.assertRaisesRegex(SystemExit, "protocol is frozen"):
            _validate_formal_protocol_args(relaxed)
        source_override = _parser().parse_args(
            [*base, "--expected-source-hash-a", "a" * 64]
        )
        with self.assertRaisesRegex(SystemExit, "overrides are forbidden"):
            _validate_formal_protocol_args(source_override)
        overwrite = _parser().parse_args([*base, "--overwrite"])
        with self.assertRaisesRegex(SystemExit, "overwrite is forbidden"):
            _validate_formal_protocol_args(overwrite)


if __name__ == "__main__":
    unittest.main()
