#!/usr/bin/env python3
"""Focused fail-closed tests for the D17--D19 runner and AutoDL contract.

The suite materializes the real 85-task/8,320-game schedule in a temporary
directory, but it never executes a formal game, CUDA work, or an AutoDL API
operation.
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import shutil
import sys
import unittest
import uuid
from collections import Counter
from pathlib import Path
from unittest import mock

import d17_d19_runner as runner
import d17_d19_experiments as experiments


SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_ROOT = SCRIPT_DIR.parent
MANIFEST_PATH = RESEARCH_ROOT / "configs" / "d17_d19_formal_manifest.json"
TEMPORARY_ROOT = RESEARCH_ROOT / "results" / "formal" / "d17_d19"


def _ledger_stub() -> dict[str, object]:
    return {
        "complete_tasks": 0,
        "failed_tasks": 0,
        "gate_failed_tasks": 0,
        "missing_tasks": 1,
        "execution_complete": False,
        "formal_ready": False,
    }


class RunnerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        TEMPORARY_ROOT.mkdir(parents=True, exist_ok=True)
        cls.root = TEMPORARY_ROOT / f"runner_selftest_{uuid.uuid4().hex}"
        cls.root.mkdir(parents=False, exist_ok=False)
        cls.manifest = runner.load_manifest(MANIFEST_PATH)
        cls.bundle = cls.root / "task_bundle"
        runner.write_task_bundle(cls.manifest, cls.bundle)
        _, cls.tasks, cls.games = runner.load_task_bundle(cls.manifest, cls.bundle)
        cls.dry_run = cls.root / "exact_dry_run.synthetic-valid.json"
        runner._atomic_json(
            cls.dry_run,
            cls._valid_dry_run_payload(),
            overwrite=False,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root)

    @classmethod
    def _valid_dry_run_payload(cls) -> dict[str, object]:
        runner_path = Path(runner.__file__).resolve()
        materialized = runner.materialize_manifest(cls.manifest)
        task_bindings = runner._task_shaped_learned_bindings(materialized)
        checkpoint_audits = []
        for binding in task_bindings:
            spec = binding["spec"]
            receipt_path = runner.resolve_manifest_path(
                str(spec["source_receipt_path"]), manifest_path=MANIFEST_PATH
            )
            checkpoint_audits.append(
                {
                    "task_id": binding["task_id"],
                    "task_agent_spec_sha256": runner.canonical_sha256(spec),
                    "source_receipt_path": str(receipt_path),
                    "source_receipt_sha256": spec["source_receipt_sha256"],
                }
            )
        return {
            "schema_name": "lifeline-d17-d19-exact-dry-run",
            "schema_version": runner.SCHEMA_VERSION,
            "status": "PASS",
            "manifest_sha256": runner.manifest_hash(cls.manifest),
            "protocol_sha256": cls.manifest["protocol_sha256"],
            "runner_sha256": runner.sha256_file(runner_path),
            "experiments_sha256": runner.sha256_file(
                runner_path.with_name("d17_d19_experiments.py")
            ),
            "checkpoint_count": 15,
            "task_shaped_checkpoint_bindings": 15,
            "checkpoint_target_size_cells": 65,
            "checkpoint_target_size_forward_cases": 195,
            "fixture_forward_puct_checks": 195,
            "gen_size_fixture_forward_puct_checks": 60,
            "d16_v2_fixture_forward_puct_checks": 135,
            "forward_cases": [
                {"case_index": index, "puct_checked": True}
                for index in range(195)
            ],
            "formal_tasks_executed": 0,
            "checkpoints": checkpoint_audits,
            "checks": {
                "checkpoint_binding": True,
                "state_round_trip": True,
                "legal_mask_and_pass": True,
                "relation_consumption": True,
                "puct_legality_and_replay": True,
                "task_shaped_agent_specs": True,
                "source_training_receipt_sha256": True,
            },
        }

    def test_real_bundle_is_exact_immutable_and_tamper_evident(self) -> None:
        self.assertEqual(len(self.tasks), 85)
        self.assertEqual(len(self.games), 8_320)
        with self.assertRaisesRegex(runner.ProtocolError, "refusing to reuse"):
            runner.write_task_bundle(self.manifest, self.bundle)

        tampered = self.root / "tampered_bundle"
        shutil.copytree(self.bundle, tampered)
        tasks_path = tampered / "tasks.jsonl"
        rows = tasks_path.read_text(encoding="utf-8").splitlines()
        first = json.loads(rows[0])
        first["task_id"] += ".tampered"
        rows[0] = runner.canonical_json(first)
        tasks_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(runner.ProtocolError, "task manifest is stale"):
            runner.load_task_bundle(self.manifest, tampered)

    def test_every_task_binds_current_runner_and_runner_drift_is_fail_closed(self) -> None:
        current_runner_sha256 = runner.sha256_file(Path(runner.__file__).resolve())
        self.assertEqual(
            {task["runner_sha256"] for task in self.tasks},
            {current_runner_sha256},
        )
        original_sha256_file = experiments.sha256_file

        def drifted_sha256(path):
            if Path(path).resolve() == experiments.RUNNER_PATH.resolve():
                return "0" * 64
            return original_sha256_file(path)

        with mock.patch.object(
            experiments, "sha256_file", side_effect=drifted_sha256
        ):
            with self.assertRaisesRegex(runner.ProtocolError, "task manifest is stale"):
                runner.load_task_bundle(self.manifest, self.bundle)

    def test_pair_plan_game_id_tampering_is_fail_closed(self) -> None:
        for target in ("game_plan", "game_ids"):
            tasks = copy.deepcopy(self.tasks)
            pair = tasks[0]["pair_plan"][0]
            if target == "game_plan":
                pair["game_plan"][0]["game_id"] += ".tampered"
                expected_error = "game binding mismatch for game_id"
            else:
                pair["game_ids"][0] += ".tampered"
                expected_error = "game_ids disagree with game_plan"
            with self.subTest(target=target):
                with self.assertRaisesRegex(runner.ProtocolError, expected_error):
                    experiments.generate_game_manifest(tasks)

    def test_exact_fixture_plan_is_60_plus_135(self) -> None:
        materialized = runner.materialize_manifest(self.manifest)
        plan = runner._exact_dry_run_fixture_plan(
            self.manifest, materialized, self.manifest["checkpoints"]
        )
        counts = Counter(row["fixture_kind"] for row in plan)
        self.assertEqual(len(plan), 195)
        self.assertEqual(counts["gen_size_registered_state"], 60)
        self.assertEqual(counts["d16_v2_registered_opening"], 135)

    def test_real_task_learned_spec_builds_on_cpu_and_binds_source_receipt(self) -> None:
        materialized = runner.materialize_manifest(self.manifest)
        bindings = runner._task_shaped_learned_bindings(materialized)
        self.assertEqual(len(bindings), 15)
        binding = next(
            row
            for row in bindings
            if row["spec"]["model_kind"] == "grid_gnn"
            and row["spec"]["training_seed"] == 20260825
        )
        spec = binding["spec"]
        receipt_path = runner.resolve_manifest_path(
            str(spec["source_receipt_path"]), manifest_path=MANIFEST_PATH
        )
        with mock.patch.object(
            runner, "sha256_file", wraps=runner.sha256_file
        ) as digest_mock:
            agent = runner._build_agent_from_spec(
                spec,
                manifest=self.manifest,
                manifest_path=MANIFEST_PATH,
                device="cpu",
                arm_name=str(binding["arm_name"]),
                cache={},
            )
        digested_paths = {
            Path(call.args[0]).resolve()
            for call in digest_mock.call_args_list
            if call.args
        }
        self.assertIn(receipt_path.resolve(), digested_paths)
        self.assertEqual(
            runner.sha256_file(receipt_path), spec["source_receipt_sha256"]
        )
        forward = runner._forward_case(
            agent,
            checkpoint=binding["checkpoint"],
            size=10,
            opening=None,
        )
        self.assertEqual(forward["status"], "PASS")

    def test_task_learned_spec_source_receipt_failures_are_explicit(self) -> None:
        materialized = runner.materialize_manifest(self.manifest)
        binding = runner._task_shaped_learned_bindings(materialized)[0]
        missing = copy.deepcopy(binding["spec"])
        missing.pop("source_receipt_path")
        with self.assertRaisesRegex(runner.ProtocolError, "missing source_receipt_path"):
            runner._build_agent_from_spec(
                missing,
                manifest=self.manifest,
                manifest_path=MANIFEST_PATH,
                device="cpu",
                arm_name=str(binding["arm_name"]),
                cache={},
            )
        tampered = copy.deepcopy(binding["spec"])
        tampered["source_receipt_sha256"] = "0" * 64
        with self.assertRaisesRegex(runner.ProtocolError, "source receipt SHA-256 mismatch"):
            runner._build_agent_from_spec(
                tampered,
                manifest=self.manifest,
                manifest_path=MANIFEST_PATH,
                device="cpu",
                arm_name=str(binding["arm_name"]),
                cache={},
            )

    def test_dependency_free_puct_action_is_normalized_as_an_index(self) -> None:
        class DummyGame:
            num_points = 3
            valid_positions = [(0, 0), (1, 0), (1, 1)]

        game = DummyGame()
        self.assertEqual(runner._search_action_index(game, 1), (1, [1, 0]))
        self.assertEqual(runner._search_action_index(game, 3), (3, None))
        with self.assertRaisesRegex(runner.ProtocolError, "non-integer"):
            runner._search_action_index(game, (1, 0))
        with self.assertRaisesRegex(runner.ProtocolError, "out-of-range"):
            runner._search_action_index(game, 4)

    def test_playable_game_copy_is_independent_and_accepts_actions(self) -> None:
        from lifeline_rl import LifelineGame

        original = LifelineGame(5, superko_mode="enforce")
        cloned = runner._playable_game_copy(original)
        legal_point = original.legal_moves()[0]
        runner._apply_action_index(cloned, original.point_to_index[legal_point])
        self.assertEqual(original.turn_count, 0)
        self.assertEqual(cloned.turn_count, 1)

    def test_dry_run_rejects_runner_and_protocol_drift(self) -> None:
        for field in ("runner_sha256", "protocol_sha256"):
            payload = self._valid_dry_run_payload()
            payload[field] = "0" * 64
            path = self.root / f"stale-{field}.json"
            runner._atomic_json(path, payload, overwrite=False)
            with self.subTest(field=field):
                with self.assertRaisesRegex(runner.ProtocolError, "stale, incomplete"):
                    runner._validate_dry_run_evidence(path, self.manifest)

    def test_formal_cli_requires_explicit_confirmation(self) -> None:
        run_root = self.root / "confirmation-lock-run"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            return_code = runner.main(
                [
                    "run",
                    "--manifest",
                    str(MANIFEST_PATH),
                    "--bundle-dir",
                    str(self.bundle),
                    "--run-root",
                    str(run_root),
                    "--dry-run-evidence",
                    str(self.dry_run),
                ]
            )
        self.assertEqual(return_code, 2)
        self.assertIn("formal execution is locked", stderr.getvalue())
        self.assertFalse(run_root.exists())

    def test_pair_recovery_reuses_immutable_pair_without_replay(self) -> None:
        task_directory = self.root / "pair-recovery"
        schedules = [
            {
                "task_id": "pair-recovery-task",
                "pair_id": "pair-recovery-pair",
                "pair_index": 0,
                "pair_member": 0,
            },
            {
                "task_id": "pair-recovery-task",
                "pair_id": "pair-recovery-pair",
                "pair_index": 0,
                "pair_member": 1,
            },
        ]

        def play(schedule, *, agent_a, agent_b):
            del agent_a, agent_b
            return {"pair_member": schedule["pair_member"], "token": "original"}

        def validate(payload, expected_schedules):
            del expected_schedules
            return sorted(payload["games"], key=lambda row: row["pair_member"])

        with mock.patch.object(runner, "_play_manifest_game", side_effect=play) as play_mock:
            with mock.patch.object(runner, "_validate_pair", side_effect=validate):
                first = runner._load_or_run_pair(
                    schedules,
                    task_directory=task_directory,
                    agent_a=object(),
                    agent_b=object(),
                )
                artifact = runner._pair_artifact_path(task_directory, 0)
                original_bytes = artifact.read_bytes()
                second = runner._load_or_run_pair(
                    schedules,
                    task_directory=task_directory,
                    agent_a=object(),
                    agent_b=object(),
                )
        self.assertEqual(first, second)
        self.assertEqual(play_mock.call_count, 2)
        self.assertEqual(artifact.read_bytes(), original_bytes)

    def test_execution_failure_requires_explicit_retry(self) -> None:
        task = {"task_id": "retry-task", "evaluation_kind": "gen_size"}
        games = [{"task_id": "retry-task", "game_index": 0}]
        run_root = self.root / "retry-run"
        metadata = {"identity": "stable"}

        def failed_attempt(task_directory, **kwargs):
            del kwargs
            path = task_directory / "attempts" / "attempt_0001.failed.json"
            runner._atomic_json(path, {"status": "failed_attempt"}, overwrite=False)
            return path

        with mock.patch.object(runner, "_execution_metadata", return_value=metadata):
            with mock.patch.object(runner, "_finalize_ledger", return_value=_ledger_stub()):
                with mock.patch.object(runner, "_write_failed_attempt", side_effect=failed_attempt):
                    with mock.patch.object(
                        runner, "_run_task", side_effect=RuntimeError("synthetic failure")
                    ) as run_mock:
                        first = runner.run_bundle(
                            {},
                            [task],
                            games,
                            manifest_path=MANIFEST_PATH,
                            bundle_directory=self.bundle,
                            run_root=run_root,
                            device="cpu",
                        )
                    self.assertEqual(first["execution_failures_this_invocation"], 1)

                    with mock.patch.object(runner, "_run_task") as run_mock:
                        second = runner.run_bundle(
                            {},
                            [task],
                            games,
                            manifest_path=MANIFEST_PATH,
                            bundle_directory=self.bundle,
                            run_root=run_root,
                            device="cpu",
                        )
                    run_mock.assert_not_called()
                    self.assertEqual(second["skipped_failed"], 1)

                    completed = {
                        "status": "complete",
                        "execution_status": "complete",
                        "gate_status": "passed",
                        "failure_reason": None,
                        "completed_at_utc": "2026-08-29T00:00:00Z",
                    }
                    with mock.patch.object(runner, "_run_task", return_value=completed) as run_mock:
                        third = runner.run_bundle(
                            {},
                            [task],
                            games,
                            manifest_path=MANIFEST_PATH,
                            bundle_directory=self.bundle,
                            run_root=run_root,
                            device="cpu",
                            retry_failed=True,
                        )
                    run_mock.assert_called_once()

        state = runner._read_json(runner._task_directory(run_root, "retry-task") / "state.json")
        self.assertEqual(state["attempts"], 2)
        self.assertEqual(state["status"], "complete")
        self.assertNotIn("failure_reason", state)
        self.assertEqual(third["execution_failures_this_invocation"], 0)

    def test_complete_gate_failure_is_not_retried(self) -> None:
        task = {"task_id": "gate-task", "evaluation_kind": "gen_size"}
        games = [{"task_id": "gate-task", "game_index": 0}]
        run_root = self.root / "gate-skip-run"
        task_directory = runner._task_directory(run_root, "gate-task")
        runner._atomic_json(
            task_directory / "receipt.json",
            {
                "status": "complete",
                "execution_status": "complete",
                "gate_status": "failed",
            },
            overwrite=False,
        )
        with mock.patch.object(runner, "_execution_metadata", return_value={"id": "stable"}):
            with mock.patch.object(runner, "validate_task_receipt"):
                with mock.patch.object(runner, "_finalize_ledger", return_value=_ledger_stub()):
                    with mock.patch.object(runner, "_run_task") as run_mock:
                        summary = runner.run_bundle(
                            {},
                            [task],
                            games,
                            manifest_path=MANIFEST_PATH,
                            bundle_directory=self.bundle,
                            run_root=run_root,
                            device="cpu",
                            retry_failed=True,
                        )
        run_mock.assert_not_called()
        self.assertEqual(summary["skipped_complete"], 1)
        self.assertEqual(summary["skipped_gate_failed"], 1)

    def test_ledger_keeps_gate_failed_numeric_evidence(self) -> None:
        task = {"task_id": "gate-evidence"}
        run_root = self.root / "gate-ledger-run"
        receipt = {
            "task_id": "gate-evidence",
            "status": "complete",
            "execution_status": "complete",
            "gate_status": "failed",
            "formal_gate": {"passed": False},
            "truncated_games": 0,
        }
        runner._atomic_json(
            runner._task_directory(run_root, "gate-evidence") / "receipt.json",
            receipt,
            overwrite=False,
        )
        metadata = {
            "manifest_sha256": "m",
            "protocol_sha256": "p",
            "runner_sha256": "r",
            "experiments_sha256": "e",
            "task_manifest_sha256": "t",
            "game_manifest_sha256": "g",
        }
        with mock.patch.object(runner, "validate_task_receipt"):
            with mock.patch.object(
                runner, "_independent_verification_passed", return_value=(False, None)
            ):
                status = runner._finalize_ledger(
                    [task],
                    {"gate-evidence": []},
                    run_root=run_root,
                    metadata=metadata,
                )
        self.assertTrue(status["execution_complete"])
        self.assertEqual(status["complete_tasks"], 1)
        self.assertEqual(status["failed_tasks"], 0)
        self.assertEqual(status["gate_failed_tasks"], 1)
        self.assertFalse(status["formal_ready"])
        self.assertTrue((run_root / "result_receipts.jsonl").is_file())

    def test_canonical_aggregate_fails_closed_on_incomplete_execution(self) -> None:
        run_root = self.root / "canonical-fail-closed"
        runner._atomic_json(
            run_root / "execution_metadata.json", {"identity": "stable"}, overwrite=False
        )
        output = run_root / "canonical_numeric.json"
        with mock.patch.object(
            runner, "_execution_metadata", return_value={"identity": "stable"}
        ):
            with mock.patch.object(runner, "_finalize_ledger", return_value=_ledger_stub()):
                with self.assertRaisesRegex(
                    runner.ProtocolError, "requires 85/85 complete tasks"
                ):
                    runner.canonical_aggregate(
                        {},
                        [],
                        [],
                        manifest_path=MANIFEST_PATH,
                        bundle_directory=self.bundle,
                        run_root=run_root,
                        output=output,
                    )
        self.assertFalse(output.exists())

    def test_execution_metadata_drift_is_rejected(self) -> None:
        run_root = self.root / "metadata-drift"
        runner._atomic_json(
            run_root / "execution_metadata.json", {"identity": "old"}, overwrite=False
        )
        with mock.patch.object(
            runner, "_execution_metadata", return_value={"identity": "new"}
        ):
            with self.assertRaisesRegex(runner.ProtocolError, "belongs to another"):
                runner.run_bundle(
                    {},
                    [{"task_id": "never-run", "evaluation_kind": "gen_size"}],
                    [{"task_id": "never-run", "game_index": 0}],
                    manifest_path=MANIFEST_PATH,
                    bundle_directory=self.bundle,
                    run_root=run_root,
                    device="cpu",
                )

    def test_bootstrap_settings_use_literal_frozen_seeds(self) -> None:
        settings = runner._canonical_bootstrap_settings(self.manifest)
        self.assertEqual(
            settings[runner.GEN_SIZE_EXPERIMENT_ID], (20_000, 202608299901)
        )
        self.assertEqual(
            settings[runner.D16_V2_EXPERIMENT_ID], (20_000, 202608299902)
        )

    def test_autodl_stage_and_job_are_review_only_and_work_export_separated(self) -> None:
        stage = self.root / "autodl_stage"
        stage_result = runner.prepare_autodl_stage(
            manifest_path=MANIFEST_PATH,
            bundle_directory=self.bundle,
            dry_run_evidence=self.dry_run,
            output=stage,
        )
        self.assertEqual(stage_result["status"], "prepared_not_run")
        self.assertFalse(stage_result["paid_action_performed"])
        self.assertTrue(
            (stage / "research/iclr2027/scripts/d17_d19_runner.py").is_file()
        )
        self.assertTrue(
            (stage / "research/iclr2027/results/formal/d17_d19" / self.root.name
             / "task_bundle/tasks.jsonl").is_file()
        )
        with self.assertRaisesRegex(runner.ProtocolError, "refusing to reuse"):
            runner.prepare_autodl_stage(
                manifest_path=MANIFEST_PATH,
                bundle_directory=self.bundle,
                dry_run_evidence=self.dry_run,
                output=stage,
            )

        job_path = self.root / "d17_d19_job.toml"
        job = runner.generate_job_toml(
            manifest_path=MANIFEST_PATH,
            bundle_directory=self.bundle,
            output=job_path,
            code_path=stage,
            image_uuid="REPLACE_WITH_COMPATIBLE_PYTORCH_IMAGE_UUID",
            local_python=Path(sys.executable),
            remote_python="python3",
            max_runtime_seconds=14_400,
            dry_run_evidence=self.dry_run,
        )
        text = job_path.read_text(encoding="utf-8")
        self.assertEqual(job["status"], "job_toml_generated_not_run")
        self.assertFalse(job["paid_action_performed"])
        self.assertIn("readiness_command =", text)
        self.assertIn("gpu_smoke_command =", text)
        self.assertIn("min_gpu_utilization_percent = 50", text)
        self.assertIn("$AUTODL_WORK_DIR", text)
        self.assertIn("$AUTODL_EXPORT_DIR", text)
        self.assertIn("--continue-on-error", job["formal_command"])
        self.assertIn("--confirm-formal", job["formal_command"])
        self.assertNotIn("$AUTODL_EXPORT_DIR", job["gpu_smoke_command"])
        self.assertIn("$AUTODL_WORK_DIR", job["gpu_smoke_command"])
        self.assertIn("auto_release = false", text)
        self.assertIn('instance_reuse = "prefer"', text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
