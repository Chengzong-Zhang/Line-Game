"""Checkpoint integrity and deterministic-resume tests.

The reference environment has no mandatory ML dependency, so this module is
importable under the standard-library test runner and skips cleanly when Torch
is not installed.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import random
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None

if TORCH_AVAILABLE:
    import torch

    from lifeline_rl.alphazero.checkpoint import (
        CheckpointConfigError,
        CheckpointIntegrityError,
        CheckpointSchemaError,
        CheckpointSourceError,
        canonical_config_hash,
        canonical_config_json,
        compute_source_hash,
        load_checkpoint,
        save_checkpoint,
    )

try:
    import numpy as np
except ImportError:  # pragma: no cover - the rl310 verification environment has NumPy
    np = None


class _Stateful:
    def __init__(self, state):
        self.state = state

    def state_dict(self):
        return dict(self.state)

    def load_state_dict(self, state):
        self.state = dict(state)


class _Buffer:
    def __init__(self, values):
        self.values = list(values)
        self.total_added = len(self.values)

    def state_dict(self):
        return {
            "schema_version": 1,
            "capacity": 8,
            "samples": list(self.values),
            "total_added": self.total_added,
            "rng_state": random.Random(91).getstate(),
        }

    def load_state_dict(self, state):
        if state["schema_version"] != 1:
            raise ValueError("unsupported buffer schema")
        self.values = list(state["samples"])
        self.total_added = int(state["total_added"])


@unittest.skipUnless(TORCH_AVAILABLE, "AlphaZero checkpoint tests require torch")
class AlphaZeroCheckpointTests(unittest.TestCase):
    SOURCE_HASH = "3d34db867f5b41c24f9f16fbe38b347e57ea3d89749992b2581a3f337a43d1d4"

    def _components(self):
        torch.manual_seed(7)
        model = torch.nn.Sequential(
            torch.nn.Linear(3, 4),
            torch.nn.Tanh(),
            torch.nn.Linear(4, 2),
        )
        optimizer = torch.optim.Adam(model.parameters(), lr=0.01)
        scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=2, gamma=0.5)
        inputs = torch.tensor([[1.0, -1.0, 0.5]])
        loss = model(inputs).square().sum()
        loss.backward()
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        scheduler.step()
        scaler = _Stateful({"scale": 512.0, "growth_tracker": 3})
        buffer = _Buffer([{"sample": 1}, {"sample": 2}])
        return model, optimizer, scheduler, scaler, buffer

    def _save(self, directory: Path, *, config=None):
        model, optimizer, scheduler, scaler, buffer = self._components()
        config = config or {
            "seed": 20260825,
            "model": {"hidden": 4, "mode": "grid_graph"},
            "sizes": (5, 7, 9),
        }
        local_rngs = {
            "self_play": random.Random(1234),
            "torch_sampler": torch.Generator(device="cpu").manual_seed(5678),
        }
        if np is not None:
            local_rngs["numpy_sampler"] = np.random.default_rng(9012)
        path = directory / "checkpoint_000003.pt"
        manifest = save_checkpoint(
            path,
            model=model,
            optimizer=optimizer,
            scheduler=scheduler,
            scaler=scaler,
            buffer=buffer,
            trainer_state={"phase": "train", "last_loss": 0.125},
            counters={"iteration": 3, "games": 8, "updates": 13, "env_steps": 55},
            local_rngs=local_rngs,
            config=config,
            source_hash=self.SOURCE_HASH,
            metadata={"run_id": "checkpoint-test"},
        )
        return (
            path,
            manifest,
            config,
            local_rngs,
            model,
            optimizer,
            scheduler,
            scaler,
            buffer,
        )

    def test_canonical_config_and_source_hash_are_stable(self):
        @dataclass(frozen=True)
        class Config:
            sizes: tuple[int, ...]
            output: Path
            enabled: bool = True

        first = Config((5, 7, 9), Path("runs/smoke"))
        second = {"enabled": True, "output": "runs/smoke", "sizes": [5, 7, 9]}
        self.assertEqual(canonical_config_json(first), canonical_config_json(second))
        self.assertEqual(canonical_config_hash(first), canonical_config_hash(second))
        with self.assertRaises(CheckpointConfigError):
            canonical_config_hash({"learning_rate": float("nan")})

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            alpha = root / "alpha.py"
            beta = root / "beta.py"
            alpha.write_text("alpha = 1\n", encoding="utf-8")
            beta.write_text("beta = 2\n", encoding="utf-8")
            forward = compute_source_hash([alpha, beta], root=root)
            reverse = compute_source_hash([beta, alpha], root=root)
            self.assertEqual(forward, reverse)
            beta.write_text("beta = 3\n", encoding="utf-8")
            self.assertNotEqual(forward, compute_source_hash([alpha, beta], root=root))

    def test_round_trip_restores_components_counters_and_all_rngs(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)

            random.seed(101)
            if np is not None:
                np.random.seed(102)
            torch.manual_seed(103)
            (
                path,
                manifest,
                config,
                local_rngs,
                model,
                optimizer,
                scheduler,
                scaler,
                buffer,
            ) = self._save(directory)

            expected_model = {
                key: value.detach().clone() for key, value in model.state_dict().items()
            }
            expected_global_python = random.random()
            expected_global_numpy = None if np is None else float(np.random.random())
            expected_global_torch = torch.rand(4)
            expected_local_python = local_rngs["self_play"].random()
            expected_local_torch = torch.rand(4, generator=local_rngs["torch_sampler"])
            expected_local_numpy = (
                None
                if np is None
                else float(local_rngs["numpy_sampler"].random())
            )

            self.assertEqual(manifest["checkpoint"], path.name)
            self.assertEqual(manifest["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            latest = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(latest, manifest)
            self.assertFalse(list(directory.glob(".*.tmp")))

            with torch.no_grad():
                for parameter in model.parameters():
                    parameter.zero_()
            optimizer.state.clear()
            scheduler.last_epoch = 99
            scaler.state = {"scale": 1.0}
            buffer.values = []
            buffer.total_added = 0
            random.seed(1)
            if np is not None:
                np.random.seed(2)
            torch.manual_seed(3)
            local_rngs["self_play"].seed(4)
            local_rngs["torch_sampler"].manual_seed(5)
            if np is not None:
                local_rngs["numpy_sampler"] = np.random.default_rng(6)

            payload = load_checkpoint(
                directory,
                model=model,
                optimizer=optimizer,
                scheduler=scheduler,
                scaler=scaler,
                buffer=buffer,
                local_rngs=local_rngs,
                expected_config=config,
                expected_source_hash=self.SOURCE_HASH,
                map_location="cpu",
            )

            for key, expected in expected_model.items():
                torch.testing.assert_close(model.state_dict()[key], expected)
            self.assertTrue(optimizer.state)
            for state in optimizer.state.values():
                for value in state.values():
                    if torch.is_tensor(value):
                        self.assertEqual(value.device.type, "cpu")
            self.assertEqual(scheduler.last_epoch, 1)
            self.assertEqual(scaler.state, {"scale": 512.0, "growth_tracker": 3})
            self.assertEqual(buffer.values, [{"sample": 1}, {"sample": 2}])
            self.assertEqual(buffer.total_added, 2)
            self.assertEqual(payload["trainer_state"]["phase"], "train")
            self.assertEqual(
                payload["counters"],
                {"iteration": 3, "games": 8, "updates": 13, "env_steps": 55},
            )
            self.assertEqual(random.random(), expected_global_python)
            if np is not None:
                self.assertEqual(float(np.random.random()), expected_global_numpy)
            torch.testing.assert_close(torch.rand(4), expected_global_torch)
            self.assertEqual(local_rngs["self_play"].random(), expected_local_python)
            torch.testing.assert_close(
                torch.rand(4, generator=local_rngs["torch_sampler"]),
                expected_local_torch,
            )
            if np is not None:
                self.assertEqual(
                    float(local_rngs["numpy_sampler"].random()),
                    expected_local_numpy,
                )

    def test_digest_config_and_source_validation_precede_model_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path, _, config, _, model, optimizer, _, _, _ = self._save(directory)

            with torch.no_grad():
                for parameter in model.parameters():
                    parameter.zero_()
            zero_state = {
                key: value.detach().clone() for key, value in model.state_dict().items()
            }

            with self.assertRaises(CheckpointConfigError):
                load_checkpoint(
                    path,
                    model=model,
                    optimizer=optimizer,
                    expected_config={**config, "seed": 1},
                    expected_source_hash=self.SOURCE_HASH,
                    restore_global_rng=False,
                )
            for key, expected in zero_state.items():
                torch.testing.assert_close(model.state_dict()[key], expected)

            with self.assertRaises(CheckpointSourceError):
                load_checkpoint(
                    path,
                    model=model,
                    optimizer=optimizer,
                    expected_config=config,
                    expected_source_hash="different-source",
                    restore_global_rng=False,
                )
            with self.assertRaises(CheckpointSourceError):
                load_checkpoint(
                    path,
                    model=model,
                    expected_config=config,
                    restore_global_rng=False,
                )

            payload = load_checkpoint(
                path,
                model=model,
                optimizer=optimizer,
                expected_config=config,
                strict_source=False,
                restore_global_rng=False,
            )
            self.assertEqual(payload["source_hash"], self.SOURCE_HASH)

            with path.open("ab") as handle:
                handle.write(b"corruption")
            with self.assertRaisesRegex(CheckpointIntegrityError, "digest mismatch"):
                load_checkpoint(
                    directory,
                    model=model,
                    strict_source=False,
                    restore_global_rng=False,
                )

    def test_unsupported_checkpoint_schema_is_rejected_after_valid_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path, _, config, _, model, _, _, _, _ = self._save(directory)
            payload = torch.load(path, map_location="cpu", weights_only=False)
            payload["schema"]["version"] = 999
            torch.save(payload, path)
            manifest_path = directory / "latest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest["size_bytes"] = path.stat().st_size
            manifest_path.write_text(
                json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(CheckpointSchemaError, "unsupported checkpoint"):
                load_checkpoint(
                    directory,
                    model=model,
                    expected_config=config,
                    expected_source_hash=self.SOURCE_HASH,
                    restore_global_rng=False,
                )


if __name__ == "__main__":
    unittest.main()
