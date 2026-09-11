from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame
from scripts.d19_v2_matched_history_contract import (
    ARM_FEATURES,
    BASE_NODE_FEATURES,
    EXPECTED_TRAINABLE_PARAMETERS,
    ContractError,
    build_arm_batch,
    compact_history_plane_from_snapshot,
    instantiate_matched_model,
    model_state_sha256,
    replay_actions,
    validate_manifest,
)
from scripts.verify_d19_v2_matched_history_preflight import run_preflight

try:
    import torch
except ImportError:  # Core-only environments must still collect static checks.
    torch = None


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
CANDIDATE_PATH = (
    ROOT
    / "results"
    / "validation"
    / "targeted_history_twin_n6_stage5_search_25k_v1.json"
)


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _witness_games() -> tuple[LifelineGame, LifelineGame, tuple[int, int]]:
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    witness = candidate["result"]["witness"]
    action = tuple(witness["candidate_action"])
    reference = replay_actions(6, witness["reference_history"])
    twin = replay_actions(6, witness["twin_history"])
    return reference, twin, action


class D19V2StaticContractTests(unittest.TestCase):
    def test_manifest_is_append_only_preflight_and_source_bound(self) -> None:
        summary = validate_manifest(_manifest(), verify_source_bindings=True)
        self.assertEqual(summary["arms"], 4)
        self.assertEqual(summary["training_seeds"], 5)
        self.assertEqual(
            summary["expected_parameter_count_each"],
            EXPECTED_TRAINABLE_PARAMETERS,
        )
        self.assertFalse(summary["training_authorized"])
        self.assertFalse(summary["evaluation_authorized"])

    def test_parameter_drift_is_rejected_not_tolerated(self) -> None:
        changed = copy.deepcopy(_manifest())
        changed["matched_backbone"]["trainable_parameter_count_each_arm"] += 1
        with self.assertRaisesRegex(ContractError, "matched backbone"):
            validate_manifest(changed, verify_source_bindings=False)

    def test_arm_specific_schedule_or_module_fields_are_rejected(self) -> None:
        changed = copy.deepcopy(_manifest())
        changed["arms"][0]["optimizer_ref"] = "arm_specific_optimizer"
        with self.assertRaisesRegex(ContractError, "does not share optimizer_ref"):
            validate_manifest(changed, verify_source_bindings=False)

        changed = copy.deepcopy(_manifest())
        changed["arms"][0]["dummy_parameter_count"] = 64
        with self.assertRaisesRegex(ContractError, "only gates and shared refs"):
            validate_manifest(changed, verify_source_bindings=False)

    def test_training_and_formal_execution_cannot_be_enabled(self) -> None:
        changed = copy.deepcopy(_manifest())
        changed["execution_boundary"]["training_authorized"] = True
        with self.assertRaisesRegex(ContractError, "execution boundary"):
            validate_manifest(changed, verify_source_bindings=False)


@unittest.skipUnless(torch is not None, "D19-v2 CPU tensor preflight requires PyTorch")
class D19V2TensorContractTests(unittest.TestCase):
    def test_four_arms_have_exactly_equal_parameters_and_initial_bytes(self) -> None:
        models = {
            arm_id: instantiate_matched_model(202608250019) for arm_id in ARM_FEATURES
        }
        self.assertEqual(
            {model.parameter_count for model in models.values()},
            {EXPECTED_TRAINABLE_PARAMETERS},
        )
        self.assertEqual(
            {model_state_sha256(model) for model in models.values()},
            {model_state_sha256(next(iter(models.values())))},
        )
        signatures = {
            tuple(
                (name, tuple(tensor.shape))
                for name, tensor in model.state_dict().items()
            )
            for model in models.values()
        }
        self.assertEqual(len(signatures), 1)

    def test_feature_axes_only_zero_their_preallocated_channels(self) -> None:
        reference, twin, action = _witness_games()
        games = [reference, twin, LifelineGame(5), LifelineGame(9)]
        batches = {
            arm_id: build_arm_batch(
                games,
                logical_edges_enabled=features[0],
                compact_history_enabled=features[1],
            )
            for arm_id, features in ARM_FEATURES.items()
        }
        full = batches["edge1_history1"]
        for arm_id, (logical_enabled, history_enabled) in ARM_FEATURES.items():
            batch = batches[arm_id]
            self.assertEqual(batch.node_features.shape, full.node_features.shape)
            self.assertEqual(batch.adjacency.shape, full.adjacency.shape)
            self.assertTrue(
                torch.equal(
                    batch.node_features[:, :, :BASE_NODE_FEATURES],
                    full.node_features[:, :, :BASE_NODE_FEATURES],
                )
            )
            self.assertTrue(torch.equal(batch.adjacency[:, 0], full.adjacency[:, 0]))
            self.assertTrue(
                torch.equal(batch.legal_action_mask, full.legal_action_mask)
            )
            if logical_enabled:
                self.assertTrue(
                    torch.equal(batch.adjacency[:, 1:], full.adjacency[:, 1:])
                )
            else:
                self.assertEqual(int(torch.count_nonzero(batch.adjacency[:, 1:])), 0)
            if history_enabled:
                self.assertTrue(
                    torch.equal(
                        batch.node_features[:, :, -1],
                        full.node_features[:, :, -1],
                    )
                )
            else:
                self.assertEqual(
                    int(torch.count_nonzero(batch.node_features[:, :, -1])),
                    0,
                )

        action_index = reference.point_to_index[action]
        self.assertEqual(float(full.node_features[0, action_index, -1]), 1.0)
        self.assertEqual(float(full.node_features[1, action_index, -1]), 0.0)
        self.assertNotEqual(
            bool(full.legal_action_mask[0, action_index]),
            bool(full.legal_action_mask[1, action_index]),
        )

    def test_compact_history_is_determined_by_the_frozen_complete_snapshot(
        self,
    ) -> None:
        reference, _, _ = _witness_games()
        snapshot = reference.clone()
        before = compact_history_plane_from_snapshot(6, snapshot)
        self.assertEqual(len(before), reference.num_points)
        legal_move = reference.legal_moves()[0]
        self.assertTrue(reference.play_move(legal_move).success)
        after_original_mutation = compact_history_plane_from_snapshot(6, snapshot)
        self.assertEqual(before, after_original_mutation)

    def test_preflight_passes_without_training_or_formal_result(self) -> None:
        receipt = run_preflight(MANIFEST_PATH)
        self.assertEqual(receipt["status"], "PASS")
        self.assertEqual(receipt["evidence_tier"], "cpu_contract_preflight_only")
        self.assertEqual(
            set(receipt["tensor_and_model_checks"]["parameter_counts"].values()),
            {EXPECTED_TRAINABLE_PARAMETERS},
        )
        self.assertTrue(
            receipt["tensor_and_model_checks"]["initial_parameter_bytes_identical"]
        )
        self.assertFalse(receipt["witness_check"]["same_implemented_legal_mask"])
        self.assertEqual(
            set(receipt["execution_counts"].values()),
            {0},
        )
        self.assertEqual(receipt["claim_boundary"]["formal_result_status"], "ABSENT")
        self.assertEqual(
            receipt["claim_boundary"]["construct_validity_blocker_status"],
            "OPEN",
        )


if __name__ == "__main__":
    unittest.main()
