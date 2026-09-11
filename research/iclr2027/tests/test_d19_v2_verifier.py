from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import verify_d19_v2_evidence as verifier  # noqa: E402


try:
    import torch as _torch_for_tests
except ImportError:  # pragma: no cover - exercised in the core-only env
    _torch_for_tests = None


class _FakeTensor:
    def __init__(self, shape: tuple[int, ...], *, device: str = "cpu") -> None:
        self.shape = shape
        self.device = SimpleNamespace(type=device)

    def numel(self) -> int:
        count = 1
        for dimension in self.shape:
            count *= dimension
        return count


class D19V2EvidenceVerifierTests(unittest.TestCase):
    def test_checkpoint_state_dict_contract_is_loaded_on_cpu(self) -> None:
        state_dict = {
            name: _FakeTensor(shape)
            for name, shape in verifier.EXPECTED_MODEL_STATE_DICT_SHAPES.items()
        }
        fake_torch = mock.Mock()
        fake_torch.is_tensor.side_effect = lambda value: isinstance(
            value, _FakeTensor
        )
        fake_torch.load.return_value = {"model_state_dict": state_dict}
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "checkpoint.pt"
            path.write_bytes(b"fixture")
            with mock.patch.dict(sys.modules, {"torch": fake_torch}):
                result = verifier._validate_checkpoint_state_dict(
                    path, label="fixture.checkpoint"
                )
        fake_torch.load.assert_called_once_with(
            path,
            map_location="cpu",
            weights_only=True,
        )
        self.assertEqual(result["parameter_count"], 63_235)
        self.assertEqual(result["state_dict_entry_count"], 35)

    def test_checkpoint_state_dict_shape_mismatch_fails_closed(self) -> None:
        state_dict = {
            name: _FakeTensor(shape)
            for name, shape in verifier.EXPECTED_MODEL_STATE_DICT_SHAPES.items()
        }
        state_dict["input_projection.weight"] = _FakeTensor((64, 13))
        fake_torch = mock.Mock()
        fake_torch.is_tensor.side_effect = lambda value: isinstance(
            value, _FakeTensor
        )
        fake_torch.load.return_value = {"model_state_dict": state_dict}
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "checkpoint.pt"
            path.write_bytes(b"fixture")
            with mock.patch.dict(sys.modules, {"torch": fake_torch}):
                with self.assertRaisesRegex(
                    verifier.VerificationError, "state-dict shape mismatch"
                ):
                    verifier._validate_checkpoint_state_dict(
                        path, label="fixture.checkpoint"
                    )

    def test_checkpoint_state_dict_parameter_count_is_exact(self) -> None:
        state_dict = {
            name: _FakeTensor(shape)
            for name, shape in verifier.EXPECTED_MODEL_STATE_DICT_SHAPES.items()
        }
        fake_torch = mock.Mock()
        fake_torch.is_tensor.side_effect = lambda value: isinstance(
            value, _FakeTensor
        )
        fake_torch.load.return_value = {"model_state_dict": state_dict}
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "checkpoint.pt"
            path.write_bytes(b"fixture")
            with mock.patch.dict(sys.modules, {"torch": fake_torch}):
                with mock.patch.object(
                    verifier,
                    "EXPECTED_STATE_DICT_PARAMETER_COUNT",
                    63_236,
                ):
                    with self.assertRaisesRegex(
                        verifier.VerificationError, "parameter count mismatch"
                    ):
                        verifier._validate_checkpoint_state_dict(
                            path, label="fixture.checkpoint"
                        )

    @unittest.skipUnless(
        _torch_for_tests is not None,
        "PyTorch is unavailable in the core-only test environment",
    )
    def test_real_torch_checkpoint_state_dict_round_trip_is_cpu_only(self) -> None:
        state_dict = {
            name: _torch_for_tests.zeros(shape, device="cpu")
            for name, shape in verifier.EXPECTED_MODEL_STATE_DICT_SHAPES.items()
        }
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "checkpoint.pt"
            _torch_for_tests.save({"model_state_dict": state_dict}, path)
            result = verifier._validate_checkpoint_state_dict(
                path, label="real-fixture.checkpoint"
            )
        self.assertEqual(result["parameter_count"], 63_235)
        self.assertEqual(result["state_dict_entry_count"], 35)

    def test_strict_json_rejects_duplicate_and_nonfinite_values(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "bad.json"
            path.write_text('{"a": 1, "a": 2}\n', encoding="utf-8")
            with self.assertRaisesRegex(verifier.VerificationError, "duplicate JSON"):
                verifier.load_json(path)
            path.write_text('{"a": NaN}\n', encoding="utf-8")
            with self.assertRaisesRegex(verifier.VerificationError, "non-finite"):
                verifier.load_json(path)

    def test_path_resolution_is_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            safe = root / "safe.json"
            safe.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(verifier.VerificationError):
                verifier._run_path(root, "../safe.json", label="fixture")
            with self.assertRaises(verifier.VerificationError):
                verifier._run_path(root, str(safe), label="fixture")

    def test_feature_contract_is_exact_and_arm_specific(self) -> None:
        expected = verifier._feature_contract("edge1_history1")
        self.assertEqual(expected["node_feature_width"], 12)
        self.assertEqual(expected["relation_count"], 3)
        self.assertTrue(expected["logical_edges_enabled"])
        self.assertTrue(expected["compact_history_enabled"])
        changed = copy.deepcopy(expected)
        changed["legal_mask_replaced"] = True
        self.assertNotEqual(changed, expected)

    def test_aggregate_uses_five_seed_units_and_exact_factorial_contrasts(self) -> None:
        rows: list[dict[str, object]] = []
        for arm_index, (arm, _, _) in enumerate(verifier.ARMS):
            for seed_index, seed in enumerate(verifier.TRAINING_SEEDS):
                for game_index in range(verifier.GAMES_PER_TASK):
                    score = 1.0 if (arm_index + seed_index) % 2 == 0 else 0.0
                    rows.append({
                        "arm_id": arm,
                        "training_seed": seed,
                        "eval_size": 9,
                        "opponent": "random",
                        "score": score,
                    })
        # The helper intentionally requires all six size/opponent strata.  A
        # temporary fixture can fill the remaining cells with neutral scores.
        for size in verifier.EVAL_SIZES:
            for opponent in verifier.OPPONENTS:
                if size == 9 and opponent == "random":
                    continue
                for arm, _, _ in verifier.ARMS:
                    for seed in verifier.TRAINING_SEEDS:
                        rows.extend({"arm_id": arm, "training_seed": seed, "eval_size": size, "opponent": opponent, "score": 0.5} for _ in range(verifier.GAMES_PER_TASK))
        numeric = verifier._aggregate(rows)
        self.assertEqual(numeric["primary_statistical_unit"], "training_seed")
        self.assertFalse(numeric["pooled_games_are_independent"])
        first = numeric["comparison_rows"][0]
        self.assertEqual(first["training_seed_units"], 5)
        self.assertEqual(first["factorial_contrasts"]["interaction"]["degrees_of_freedom"], 4)

    def test_missing_formal_fixture_fails_closed_without_writing_results(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            paths = {name: root / name for name in ("tasks.jsonl", "games.jsonl", "receipts.jsonl", "metadata.json", "summary.json")}
            for path in paths.values():
                path.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(verifier.VerificationError):
                verifier.verify_evidence(
                    manifest_path=ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json",
                    task_manifest_path=paths["tasks.jsonl"],
                    game_manifest_path=paths["games.jsonl"],
                    receipts_path=paths["receipts.jsonl"],
                    execution_metadata_path=paths["metadata.json"],
                    execution_summary_path=paths["summary.json"],
                )

    def test_numeric_equal_rejects_pooled_inference_or_numeric_tampering(self) -> None:
        left = {"primary_statistical_unit": "training_seed", "pooled_games_are_independent": False, "x": [0.5]}
        verifier._numeric_equal(left, copy.deepcopy(left))
        tampered = copy.deepcopy(left)
        tampered["x"][0] = 0.5001
        with self.assertRaisesRegex(verifier.VerificationError, "numeric mismatch"):
            verifier._numeric_equal(left, tampered)


if __name__ == "__main__":
    unittest.main()
