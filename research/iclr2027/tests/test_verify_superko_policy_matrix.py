from __future__ import annotations

import argparse
import copy
import json
import unittest

from scripts import run_superko_policy_matrix as matrix
from scripts import verify_superko_policy_matrix as verifier


class VerifySuperkoPolicyMatrixTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        args = argparse.Namespace(
            minimax_move_cap=4,
            mcts_simulations=1,
            mcts_rollout_depth=0,
            mcts_exploration=2**0.5,
            cycle_max_depth=1,
            cycle_branch_limit=1,
            cycle_node_budget=1,
            max_plies=20,
        )
        block = matrix._run_block(
            policy="random",
            grid_size=6,
            master_seed=matrix.DRY_RUN_SEED,
            block_index=0,
            args=args,
            frozen_rl_agent=None,
        )
        bootstrap_resamples = 20
        report = {
            "schema_version": 1,
            "experiment": matrix.EXPERIMENT_VERSION,
            "purpose": "dry_run",
            "attempt_id": "portable-unit-test-random-only",
            "claim_boundary": matrix.CLAIM_BOUNDARY,
            "config": {
                "sizes": [6],
                "policies": ["random"],
                "master_seeds": [matrix.DRY_RUN_SEED],
                "uses_exact_frozen_seed_set": False,
                "blocks_per_seed": 1,
                "games_per_block": 4,
                "max_plies": args.max_plies,
                "minimax": {"depth": 2, "move_cap": args.minimax_move_cap},
                "mcts": {
                    "simulations": args.mcts_simulations,
                    "rollout_depth": args.mcts_rollout_depth,
                    "exploration": args.mcts_exploration,
                },
                "cycle_seeking": {
                    "max_depth": args.cycle_max_depth,
                    "branch_limit": args.cycle_branch_limit,
                    "node_budget": args.cycle_node_budget,
                    "fallback": "random",
                },
                "frozen_rl": {
                    "requested": False,
                    "checkpoint": None,
                    "simulations": 4,
                    "c_puct": 1.5,
                    "temperature": 0.0,
                    "root_noise": False,
                    "metadata": None,
                },
                "bootstrap_resamples": bootstrap_resamples,
                "source_sha256": matrix._source_hashes(),
                "formal_manifest": None,
            },
            "positive_control": matrix._positive_control(),
            "runtime": {"duration_seconds": 0.0},
            "conditions": [
                {
                    "policy": "random",
                    "grid_size": 6,
                    "summary": matrix._summarize_condition(
                        [block],
                        policy="random",
                        grid_size=6,
                        bootstrap_resamples=bootstrap_resamples,
                    ),
                    "blocks": [block],
                }
            ],
        }
        cls.preflight = json.loads(json.dumps(report, allow_nan=False))

    def _random_only_report(self) -> dict[str, object]:
        return copy.deepcopy(self.preflight)

    def _with_compact_checkpoint_metadata(self, report: dict[str, object]) -> None:
        frozen = report["config"]["frozen_rl"]
        frozen.update(
            {
                "requested": True,
                "checkpoint": "omitted-local-checkpoint",
                "device": "cpu",
                "metadata": {
                    "checkpoint": {
                        "path": "omitted-local-checkpoint.pt",
                        "sha256": verifier.EXPECTED_CHECKPOINT_SHA256,
                        "source_hash": verifier.EXPECTED_CHECKPOINT_SOURCE_HASH,
                        "config_hash": verifier.EXPECTED_CHECKPOINT_CONFIG_HASH,
                        "created_at_utc": "portable-test-fixture",
                        "games_completed": 1,
                        "gradient_steps": 1,
                        "iteration": 1,
                    },
                    "classification": "engineering_smoke_checkpoint_not_paper_baseline",
                    "model_kind": "topology_gnn",
                    "observation_mode": "topology",
                    "trained_board_sizes": [5],
                    "train_superko_mode": "enforce",
                    "eval_superko_modes": ["enforce", "observe"],
                    "source_migration_waiver": True,
                    "rule_mode_override": True,
                    "saved_source_hash_matches_current": False,
                    "current_source_hash": "f" * 64,
                    "search": {
                        "simulations": frozen["simulations"],
                        "c_puct": frozen["c_puct"],
                        "temperature": frozen["temperature"],
                    },
                },
            }
        )

    def test_generated_preflight_replays_without_smoke_fixture(self) -> None:
        result = verifier.verify_report(self.preflight)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["conditions_verified"], 1)
        self.assertEqual(result["blocks_verified"], 1)
        self.assertEqual(result["games_replayed"], 4)
        self.assertEqual(result["checkpoint_files_verified"], 0)

    def test_rejects_replayed_actor_tampering(self) -> None:
        report = self._random_only_report()
        action = report["conditions"][0]["blocks"][0]["orientations"][0]["enforce"]["actions"][0]
        action["actor"] = "WHITE" if action["actor"] == "BLACK" else "BLACK"
        with self.assertRaisesRegex(verifier.VerificationError, r"actions\[0\]\.actor"):
            verifier.verify_report(report)

    def test_rejects_summary_count_tampering(self) -> None:
        report = self._random_only_report()
        summary = report["conditions"][0]["summary"]["mode"]["observe"]
        summary["trigger_states"] += 1
        with self.assertRaisesRegex(verifier.VerificationError, r"trigger_states"):
            verifier.verify_report(report)

    def test_rejects_nonfinite_json_number(self) -> None:
        report = self._random_only_report()
        report["runtime"]["duration_seconds"] = float("nan")
        with self.assertRaisesRegex(verifier.VerificationError, r"non-finite"):
            verifier.verify_report(report)

    def test_rejects_positive_control_identity_tampering(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["positive_control"]["witness_sha256"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, r"witness_sha256"):
            verifier.verify_report(report)

    def test_rejects_checkpoint_metadata_identity_tampering(self) -> None:
        report = self._random_only_report()
        self._with_compact_checkpoint_metadata(report)
        result = verifier.verify_report(report, verify_checkpoint_files=False)
        self.assertTrue(result["checkpoint_file_verification_skipped"])
        report["config"]["frozen_rl"]["metadata"]["checkpoint"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, r"checkpoint\.sha256"):
            verifier.verify_report(report, verify_checkpoint_files=False)

    def test_formal_extension_requires_exact_fresh_seeds(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["purpose"] = "five_seed_extension"
        report["config"]["master_seeds"] = [*verifier.FORMAL_SEEDS[:-1], 123]
        report["config"]["uses_exact_frozen_seed_set"] = False
        with self.assertRaisesRegex(verifier.VerificationError, r"master_seeds"):
            verifier.verify_report(report, verify_formal_sidecars=False)

    def test_formal_cell_requires_five_blocks(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["purpose"] = "five_seed_extension"
        config = report["config"]
        config["sizes"] = list(verifier.FORMAL_SIZES)
        config["policies"] = list(verifier.FORMAL_POLICIES)
        config["master_seeds"] = list(verifier.FORMAL_SEEDS)
        config["uses_exact_frozen_seed_set"] = True
        config["max_plies"] = 120
        config["minimax"] = {"depth": 2, "move_cap": 20}
        config["mcts"] = {
            "simulations": 16,
            "rollout_depth": 24,
            "exploration": 2**0.5,
        }
        config["cycle_seeking"] = {
            "max_depth": 4,
            "branch_limit": 5,
            "node_budget": 1000,
            "fallback": "random",
        }
        config["bootstrap_resamples"] = 10_000
        config["formal_manifest"] = {
            "path": "omitted-portable-manifest.json",
            "sha256": "0" * 64,
        }
        self._with_compact_checkpoint_metadata(report)
        template = report["conditions"][0]
        report["conditions"] = [
            {
                "policy": policy,
                "grid_size": size,
                "summary": template["summary"],
                "blocks": template["blocks"],
            }
            for policy in verifier.FORMAL_POLICIES
            for size in verifier.FORMAL_SIZES
        ]
        with self.assertRaisesRegex(
            verifier.VerificationError, r"formal cell must contain exactly five blocks"
        ):
            verifier.verify_report(
                report,
                verify_checkpoint_files=False,
                verify_formal_sidecars=False,
            )


if __name__ == "__main__":
    unittest.main()
