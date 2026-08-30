#!/usr/bin/env python3
"""Self-tests for the D18-v3 zero-formal-game preparation package."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_generate_openings as openings  # noqa: E402
import d18_v3_runner as runner  # noqa: E402


class D18V3PreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.opening_manifest = openings.load_json(openings.DEFAULT_OUTPUT)
        cls.formal_manifest = runner.load_json(runner.DEFAULT_MANIFEST)
        cls.opening_report = openings.validate_manifest(
            cls.opening_manifest,
            generator_path=openings.SCRIPT_PATH,
            v1_path=openings.DEFAULT_V1_OPENINGS,
        )
        cls.formal_report = runner.validate_formal_manifest(
            cls.formal_manifest, manifest_path=runner.DEFAULT_MANIFEST
        )
        cls.bundle = runner.materialize_bundle(
            manifest=cls.formal_manifest, manifest_path=runner.DEFAULT_MANIFEST
        )

    def test_opening_contract(self) -> None:
        self.assertEqual(self.opening_report["opening_count"], 192)
        self.assertEqual(self.opening_report["openings_per_size"], 64)
        self.assertEqual(self.opening_report["strata_per_size"], 32)
        self.assertEqual(self.opening_report["variants_per_stratum"], 2)
        self.assertEqual(self.opening_report["formal_games_executed"], 0)
        self.assertTrue(self.opening_manifest["audit"]["prefix_hashes_unique"])
        self.assertTrue(self.opening_manifest["audit"]["state_hashes_unique"])
        self.assertTrue(
            self.opening_manifest["audit"]["prefix_hashes_disjoint_from_v1"]
        )
        self.assertTrue(
            self.opening_manifest["audit"]["state_hashes_disjoint_from_v1"]
        )

    def test_formal_manifest_contract(self) -> None:
        self.assertEqual(self.formal_report["status"], "passed")
        self.assertEqual(len(self.formal_manifest["checkpoints"]), 15)
        self.assertEqual(self.formal_manifest["training_seeds"], list(runner.TRAINING_SEEDS))
        self.assertEqual(
            self.formal_manifest["search"],
            {
                "add_root_noise": False,
                "c_puct": 1.5,
                "simulations": 16,
                "temperature": 0.0,
            },
        )
        self.assertFalse(
            self.formal_manifest["zero_execution"][
                "formal_execution_command_available"
            ]
        )

    def test_bundle_exact_counts_and_hashes(self) -> None:
        report = runner.validate_materialized_bundle(self.bundle)
        self.assertEqual(report["task_count"], 45)
        self.assertEqual(report["game_count"], 5760)
        self.assertEqual(report["color_pairs_per_task"], 64)
        self.assertEqual(report["formal_games_executed"], 0)
        self.assertEqual(
            self.bundle["summary"]["task_manifest_sha256"],
            runner.sha256_text(self.bundle["task_text"]),
        )
        self.assertEqual(
            self.bundle["summary"]["game_manifest_sha256"],
            runner.sha256_text(self.bundle["game_text"]),
        )

    def test_policy_seed_cross_and_color_swap(self) -> None:
        task = self.bundle["task_rows"][0]
        by_stratum: dict[int, list[dict[str, object]]] = {}
        for pair in task["pair_plan"]:
            by_stratum.setdefault(int(pair["stratum_index"]), []).append(pair)
        self.assertEqual(len(by_stratum), 32)
        for pairs in by_stratum.values():
            self.assertEqual(len(pairs), 2)
            by_variant = {int(pair["variant_index"]): pair for pair in pairs}
            self.assertEqual(by_variant[0]["policy_seed_a"], by_variant[1]["policy_seed_b"])
            self.assertEqual(by_variant[0]["policy_seed_b"], by_variant[1]["policy_seed_a"])
        games = [
            row for row in self.bundle["game_rows"] if row["task_id"] == task["task_id"]
        ]
        for pair_id in {row["pair_id"] for row in games}:
            members = sorted(
                (row for row in games if row["pair_id"] == pair_id),
                key=lambda row: row["pair_member"],
            )
            self.assertEqual([row["black_slot"] for row in members], ["A", "B"])
            self.assertEqual([row["white_slot"] for row in members], ["B", "A"])

    def test_cli_has_no_formal_execution_command(self) -> None:
        parser = runner.build_parser()
        subparser_actions = [
            action
            for action in parser._actions
            if action.__class__.__name__ == "_SubParsersAction"
        ]
        self.assertEqual(len(subparser_actions), 1)
        self.assertEqual(
            set(subparser_actions[0].choices),
            {"freeze-manifest", "prepare-bundle", "readiness", "dry-run", "show-contract"},
        )
        self.assertNotIn("run-formal", subparser_actions[0].choices)
        self.assertNotIn("run", subparser_actions[0].choices)

    def test_readiness_and_dry_run_remain_zero(self) -> None:
        readiness = runner.readiness_report(
            manifest_path=runner.DEFAULT_MANIFEST, verify_checkpoints=False
        )
        dry_run = runner.dry_run_report(manifest_path=runner.DEFAULT_MANIFEST)
        for report in (readiness, dry_run):
            self.assertEqual(report["formal_games_executed"], 0)
            self.assertEqual(report["gpu_actions"], 0)
            self.assertEqual(report["external_actions"], 0)
            self.assertEqual(report["paid_actions"], 0)
            self.assertEqual(report["model_forward_calls"], 0)

    def test_bundle_writer_refuses_nonempty_target(self) -> None:
        sentinel = runner.DEFAULT_PROTOCOL
        before = runner.sha256_file(sentinel)
        with self.assertRaises(runner.PreparationError):
            runner.write_bundle(self.bundle, runner.RESEARCH_ROOT)
        self.assertEqual(runner.sha256_file(sentinel), before)

    def test_opening_tamper_fails_closed(self) -> None:
        tampered = copy.deepcopy(self.opening_manifest)
        tampered["openings"][0]["opening_actions"][0] = tampered["openings"][0][
            "pass_index"
        ]
        with self.assertRaises(openings.PreparationError):
            openings.validate_manifest(
                tampered,
                generator_path=openings.SCRIPT_PATH,
                v1_path=openings.DEFAULT_V1_OPENINGS,
            )

    def test_v1_bindings_are_read_only_hashes(self) -> None:
        self.assertEqual(
            self.opening_manifest["v1_opening_binding"]["sha256"],
            openings.sha256_file(openings.DEFAULT_V1_OPENINGS),
        )
        source = self.formal_manifest["checkpoint_selection"]
        self.assertEqual(
            source["source_manifest_sha256"], runner.sha256_file(runner.DEFAULT_V1_FORMAL)
        )
        self.assertTrue(self.formal_manifest["immutable_output_policy"]["may_write_d17_d19_v1"] is False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
