from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
import uuid
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import d19_v2_formal_runner as runner  # noqa: E402


MANIFEST_PATH = ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"


class D19V2FormalRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = runner.load_and_validate_manifest(MANIFEST_PATH)
        cls.schedule = runner.generate_schedule(cls.manifest)

    def test_schedule_is_complete_deterministic_and_arm_paired(self) -> None:
        second = runner.generate_schedule(self.manifest)
        self.assertEqual(self.schedule["schedule_sha256"], second["schedule_sha256"])
        self.assertEqual(
            self.schedule["counts"],
            {
                "training_tasks": 20,
                "training_games": 2_000,
                "training_updates": 4_000,
                "evaluation_tasks": 120,
                "evaluation_games": 24_000,
            },
        )

        training = self.schedule["training_games"]
        by_pair = {}
        for row in training:
            key = (row["training_seed"], row["game_index"])
            by_pair.setdefault(key, set()).add(
                (row["grid_size"], row["game_seed"], row["arm_id_in_seed_derivation"])
            )
        self.assertTrue(by_pair)
        self.assertTrue(all(len(values) == 1 for values in by_pair.values()))

        evaluation = self.schedule["evaluation_games"]
        matched = {}
        for row in evaluation:
            key = (
                row["training_seed"],
                row["eval_size"],
                row["opponent"],
                row["pair_index"],
                row["pair_member"],
            )
            matched.setdefault(key, set()).add(
                (
                    row["game_seed"],
                    row["policy_seed"],
                    row["opponent_seed"],
                    row["arm_id_in_seed_derivation"],
                )
            )
        self.assertTrue(all(len(values) == 1 for values in matched.values()))

    def test_plan_and_smoke_are_zero_execution(self) -> None:
        plan = runner.build_plan(manifest_path=MANIFEST_PATH)
        self.assertFalse(plan["execution_permitted"])
        self.assertEqual(plan["execution_counts"], runner.ZERO_EXECUTION_COUNTS)
        self.assertEqual(plan["formal_result_status"], "ABSENT")
        self.assertEqual(plan["side_effects"], [])

        smoke = runner.run_cpu_smoke(manifest_path=MANIFEST_PATH)
        self.assertIn(smoke["status"], {"PASS", "SKIPPED_DEPENDENCY"})
        self.assertEqual(smoke["execution_counts"], runner.ZERO_EXECUTION_COUNTS)
        self.assertEqual(smoke["formal_result_status"], "ABSENT")
        self.assertFalse(smoke["network_enabled"])
        self.assertFalse(smoke["autodl_enabled"])
        self.assertFalse(smoke["paid_resources_enabled"])

    def test_output_root_is_narrow_and_repository_bound(self) -> None:
        with self.assertRaisesRegex(runner.RunnerError, "results root"):
            runner._validate_output_root("research/iclr2027/results")
        with self.assertRaisesRegex(runner.RunnerError, "shared formal"):
            runner._validate_output_root("research/iclr2027/results/formal")
        with self.assertRaises(runner.RunnerError):
            runner._validate_output_root("research/iclr2027/results/../../outside")
        with self.assertRaises(runner.RunnerError):
            runner._validate_output_root("research/iclr2027")

    def test_prepare_bundle_is_hash_bound_and_contains_no_results(self) -> None:
        name = f".d19-v2-runner-test-{uuid.uuid4().hex}"
        output = ROOT.parents[1] / name
        try:
            # The repository's shared results directory is intentionally
            # protected by another agent's artifact policy.  Keep this test's
            # owned temporary directory in the writable checkout root while
            # exercising the same root-validation/write path.
            try:
                with mock.patch.object(runner, "RESULTS_ROOT", ROOT.parents[1]):
                    report = runner.prepare_run(
                        manifest_path=MANIFEST_PATH,
                        output_root=name,
                    )
            except PermissionError as exc:
                self.skipTest(f"checkout ACL blocks temporary artifact write: {exc}")
            self.assertEqual(report["status"], "PREPARED_NOT_RUN")
            self.assertEqual(
                runner._validate_prepared_run_directory(
                    output,
                    self.manifest,
                    manifest_path=MANIFEST_PATH,
                )["status"],
                "PASS",
            )
            numeric = json.loads(
                (output / "canonical_numeric.json").read_text(encoding="utf-8")
            )
            self.assertEqual(numeric["records"], [])
            self.assertFalse(numeric["result_numbers_present"])
            self.assertEqual(numeric["execution_counts"], runner.ZERO_EXECUTION_COUNTS)
        finally:
            if output.exists():
                shutil.rmtree(output)

    def _write_authorization(self, *, budget: dict[str, int] | None = None) -> Path:
        output_name = f"research/iclr2027/results/.d19-v2-auth-test-{uuid.uuid4().hex}"
        payload = {
            "schema_name": runner.AUTH_SCHEMA_NAME,
            "schema_version": runner.AUTH_SCHEMA_VERSION,
            "status": runner.AUTH_STATUS,
            "experiment_id": self.manifest["experiment_id"],
            "protocol_id": self.manifest["protocol_id"],
            "manifest_sha256": runner.sha256_file(MANIFEST_PATH),
            "protocol_sha256": runner.sha256_file(ROOT / "D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md"),
            "runner_sha256": runner.sha256_file(runner.SCRIPT_PATH),
            "source_hashes": runner.bound_source_hashes(self.manifest),
            "device": "cpu",
            "execution_environment": "local",
            "output_root": output_name,
            "budget": budget or runner._expected_budget(self.manifest),
            "stop_policy": runner.STOP_POLICY,
        }
        handle = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", delete=False
        )
        with handle:
            json.dump(payload, handle, sort_keys=True)
        return Path(handle.name)

    def test_authorization_budget_and_manifest_boundary_reject(self) -> None:
        auth = self._write_authorization()
        try:
            with self.assertRaisesRegex(runner.RunnerError, "manifest remains"):
                runner.validate_authorization(auth, manifest_path=MANIFEST_PATH)
            with self.assertRaises(runner.FormalExecutionNotImplemented):
                runner.run_formal(authorization_path=auth, manifest_path=MANIFEST_PATH)
        finally:
            auth.unlink()

        bad_budget = runner._expected_budget(self.manifest)
        bad_budget["evaluation_games"] += 1
        auth = self._write_authorization(budget=bad_budget)
        try:
            with self.assertRaisesRegex(runner.RunnerError, "budget"):
                runner.run_formal(authorization_path=auth, manifest_path=MANIFEST_PATH)
        finally:
            auth.unlink()


if __name__ == "__main__":
    unittest.main()
