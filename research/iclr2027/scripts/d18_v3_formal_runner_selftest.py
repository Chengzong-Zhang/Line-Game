#!/usr/bin/env python3
"""Zero-execution structural self-tests for ``d18_v3_formal_runner``."""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_formal_runner as formal  # noqa: E402


class D18V3FormalRunnerStructuralTests(unittest.TestCase):
    def test_formal_confirmation_fails_before_input_access(self) -> None:
        with self.assertRaisesRegex(formal.FormalExecutionError, "--confirm-formal"):
            formal.run_bundle(
                Path("missing-manifest"),
                Path("missing-bundle"),
                Path("missing-run"),
                device="cuda",
                continue_on_error=False,
                export_directory=None,
                confirm_formal=False,
                throughput_profile=None,
            )

    def test_gpu_smoke_is_inference_only(self) -> None:
        smoke_source = inspect.getsource(formal.gpu_smoke)
        lane_source = inspect.getsource(formal._run_gpu_smoke_lane)
        source = smoke_source + lane_source
        for forbidden in (
            ".backward(",
            "Adam",
            "autocast(",
            "GradScaler",
            "_repeat_tensor_batch",
            "batch_candidates",
        ):
            self.assertNotIn(forbidden, source)
        self.assertIn("torch.inference_mode()", source)
        self.assertIn("select_action", source)
        self.assertIn('"optimizer_steps": 0', source)
        self.assertIn('"formal_numeric_path_match": True', source)
        self.assertIn("_ScalarLaneExecutor", smoke_source)
        self.assertIn("_ScalarLaneExecutor", inspect.getsource(formal.run_bundle))

    def test_status_is_read_only_and_fail_closed(self) -> None:
        for source in (
            inspect.getsource(formal.read_only_status),
            inspect.getsource(formal._current_status),
        ):
            for forbidden in ("_atomic_", "write_text", "mkdir(", "copy2("):
                self.assertNotIn(forbidden, source)
        self.assertIn(
            '"formal_ready": False', inspect.getsource(formal._current_status)
        )

    def test_cli_surface_uses_cuda_and_no_auto_batch(self) -> None:
        parser = formal._parser()
        smoke = parser.parse_args(["gpu-smoke", "--bundle-dir", "bundle"])
        self.assertFalse(hasattr(smoke, "batch_candidates"))
        with self.assertRaises(SystemExit):
            parser.parse_args(
                ["run", "--bundle-dir", "bundle", "--run-root", "run"]
            )
        run = parser.parse_args(
            [
                "run",
                "--bundle-dir",
                "bundle",
                "--run-root",
                "run",
                "--throughput-profile",
                "smoke.json",
            ]
        )
        self.assertEqual(run.device, "cuda")
        self.assertFalse(run.confirm_formal)
        self.assertEqual(run.throughput_profile, Path("smoke.json"))

    def test_dual_runner_hashes_are_distinct(self) -> None:
        prep_hash = formal.sha256_file(formal.prep.SCRIPT_PATH)
        formal_hash = formal.sha256_file(formal.SCRIPT_PATH)
        self.assertEqual(len(prep_hash), 64)
        self.assertEqual(len(formal_hash), 64)
        self.assertNotEqual(prep_hash, formal_hash)

    def test_budget_and_instance_are_frozen(self) -> None:
        self.assertEqual(formal.MAX_RUNTIME_SECONDS, 11_520)
        self.assertEqual(formal.POLICY_MAX_DELIVERY_BYTES, 512 * 1024 * 1024)
        self.assertEqual(
            formal.WORKER_RUN_METADATA_RESERVE_BYTES, 64 * 1024 * 1024
        )
        self.assertEqual(formal.MAX_EXPORT_BYTES, 448 * 1024 * 1024)
        self.assertEqual(formal.EXPORT_MANIFEST_RESERVE_BYTES, 4 * 1024 * 1024)
        self.assertEqual(formal.INSTANCE_UUID, "pro-788096a9e3b2")
        self.assertEqual(formal.GPU_SPEC, "5090-p")
        self.assertEqual(formal.IMAGE_UUID, "base-image-ec1e9vdbd3")

    def test_capacity_projection_is_v4_empirical_sustained_lane_and_fail_closed(self) -> None:
        self.assertEqual(formal.SCALAR_LANE_COUNT, 12)
        self.assertEqual(
            formal.THROUGHPUT_PROFILE_SCHEMA,
            "lifeline-d18-v3-gpu-smoke-v4",
        )
        self.assertEqual(formal.THROUGHPUT_PROFILE_SCHEMA_VERSION, 4)
        evidence = formal._validated_empirical_capacity_evidence()
        self.assertEqual(
            {
                size: row["empirical_planning_plies"]
                for size, row in evidence["sizes"].items()
            },
            {"5": 32, "7": 84, "9": 138},
        )
        projection_source = inspect.getsource(formal._formal_capacity_projection)
        self.assertIn("sustained_seconds", projection_source)
        self.assertIn("puct_decisions", projection_source)
        self.assertIn("critical_seconds_per_decision", projection_source)
        self.assertIn("slowest_single_decision_seconds", projection_source)
        self.assertIn("empirical_planning_plies", projection_source)
        smoke_source = inspect.getsource(formal.gpu_smoke)
        self.assertLess(
            smoke_source.index("_require_capacity_projection"),
            smoke_source.index('profile = {'),
        )
        self.assertIn("FormalCapacityError", inspect.getsource(formal.main))

    def test_dependency_lock_is_frozen_into_stage_and_job(self) -> None:
        self.assertEqual(
            formal.sha256_file(formal.DEPENDENCY_LOCK_PATH),
            "8476a85f5dfd94751bdd645358e481a5d108ba4cbad80c47c98c8f83370edae5",
        )
        self.assertIn(
            "DEPENDENCY_LOCK_PATH",
            inspect.getsource(formal._execution_dependency_paths),
        )
        self.assertIn(
            "DEPENDENCY_LOCK_PATH", inspect.getsource(formal.prepare_autodl_stage)
        )
        job_source = inspect.getsource(formal.generate_job)
        self.assertIn("dependency_lock_relative", job_source)
        self.assertIn("d18-v3-stage-", job_source)
        self.assertIn("validate-autodl-stage", job_source)
        self.assertIn("_require_stage_matches_local_closure", job_source)
        stage_source = inspect.getsource(formal._validated_autodl_stage)
        self.assertIn("stage manifest file_count differs", stage_source)
        self.assertIn("AutoDL stage file closure differs", stage_source)
        self.assertIn("stage semantic binding differs", stage_source)

    def test_numeric_aggregation_binds_task_only_group_fail_closed(self) -> None:
        numeric_source = inspect.getsource(formal._runner_numeric_artifact)
        self.assertIn("tasks", inspect.signature(formal._runner_numeric_artifact).parameters)
        self.assertIn("_runner_bind_inference_groups", numeric_source)
        self.assertIn(
            "tasks=tasks",
            inspect.getsource(formal._preflight_existing_terminal_artifacts),
        )
        self.assertIn("tasks=tasks", inspect.getsource(formal.run_bundle))

        task = {
            "task_id": "task-a",
            "inference_group_id": "d16-v3.padded_cnn_vs_grid_gnn.n5",
            "model_pair": ["padded_cnn", "grid_gnn"],
            "eval_size": 5,
        }
        record = {"task_id": "task-a"}
        bound = formal._runner_bind_inference_groups([record], [task])
        self.assertNotIn("inference_group_id", record)
        self.assertEqual(
            bound[0]["inference_group_id"], task["inference_group_id"]
        )

        conflicting = {
            **record,
            "inference_group_id": "d16-v3.grid_gnn_vs_resmlp.n5",
        }
        with self.assertRaisesRegex(
            formal.FormalExecutionError,
            "game inference group conflicts with its task",
        ):
            formal._runner_bind_inference_groups([conflicting], [task])


if __name__ == "__main__":
    unittest.main(verbosity=2)
