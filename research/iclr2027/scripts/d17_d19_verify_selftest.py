#!/usr/bin/env python3
"""Focused fail-closed tests for the independent D17-D19 verifier."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import d17_d19_verify_evidence as verifier


class IndependentVerifierTests(unittest.TestCase):
    @staticmethod
    def _temporary_directory() -> tempfile.TemporaryDirectory[str]:
        return tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)

    @staticmethod
    def _write_json(path: Path, value: object) -> None:
        path.write_text(
            json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _synthetic_inputs(root: Path) -> dict[str, Path]:
        input_root = root / "inputs"
        input_root.mkdir()
        paths = {
            "manifest": input_root / "manifest.json",
            "tasks": input_root / "tasks.jsonl",
            "game_manifest": input_root / "game_manifest.jsonl",
            "receipts": input_root / "result_receipts.jsonl",
            "ledger_status": input_root / "result_ledger_status.json",
            "export_manifest": input_root / "export_manifest.json",
            "execution_metadata": input_root / "execution_metadata.json",
            "execution_summary": input_root / "execution_summary.json",
            "canonical": input_root / "canonical_numeric.json",
            "canonical_receipt": input_root / "canonical_derivation_receipt.json",
        }
        paths["manifest"].write_text(
            json.dumps({"protocol_sha256": "1" * 64, "source_hashes": {}}) + "\n",
            encoding="utf-8",
        )
        task = {
            "task_id": "synthetic-task",
            "experiment_id": verifier.D16_V2_ID,
            "eval_size": 9,
        }
        paths["tasks"].write_text(json.dumps(task) + "\n", encoding="utf-8")
        paths["game_manifest"].write_text("{}\n", encoding="utf-8")
        paths["receipts"].write_text(
            json.dumps(
                {
                    "task_id": "synthetic-task",
                    "status": "complete",
                    "gate_status": "passed",
                    "formal_gate": {"passed": True},
                    "failure_reason": None,
                    "source_hash": "5" * 64,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        for role in (
            "ledger_status",
            "execution_metadata",
            "execution_summary",
        ):
            paths[role].write_text("{}\n", encoding="utf-8")
        payload_paths = (
            paths["execution_metadata"],
            paths["execution_summary"],
            paths["ledger_status"],
            paths["receipts"],
        )
        IndependentVerifierTests._write_json(
            paths["export_manifest"],
            {
                "schema_name": "lifeline-d17-d19-lightweight-export",
                "schema_version": 1,
                "source_run_root": "/synthetic/formal_run",
                "files": [
                    {
                        "path": f"/synthetic/{verifier.BUNDLE_ID}/{path.name}",
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                    for path in payload_paths
                ],
                "pair_scratch_exported": False,
                "created_at_utc": "2026-09-01T00:00:00Z",
            },
        )
        return paths

    @staticmethod
    def _synthetic_core_patches(*, unique_gate: bool = True) -> ExitStack:
        task = {
            "task_id": "synthetic-task",
            "experiment_id": verifier.D16_V2_ID,
            "experiment_arm": "D16-v2",
            "inference_group_id": "synthetic-group",
            "training_seed": 20260825,
            "eval_size": 9,
            "games": 0,
        }
        audit = {
            "task_id": "synthetic-task",
            "experiment_id": verifier.D16_V2_ID,
            "experiment_arm": "D16-v2",
            "inference_group_id": "synthetic-group",
            "training_seed": 20260825,
            "eval_size": 9,
            "truncated_games": 0,
            "unique_full_color_aware": 0,
            "unique_full_sequence_ignoring_color": 0,
            "unique_continuation_ignoring_opening_and_color": 0,
            "opening_clusters": 1,
            "clusters_with_minimum_continuation_diversity": 0,
        }
        opening = {
            "opening_id": "opening-0",
            "opening_seed": 7,
            "opening_actions": [],
            "opening_prefix_hash": "2" * 64,
            "opening_state_hash": "3" * 64,
        }
        group = {
            "experiment_id": verifier.D16_V2_ID,
            "training_seed_units": verifier.EXPECTED_TRAINING_SEEDS_PER_GROUP,
            "training_seed_t_ci95": [0.0, 1.0],
            "crossed_seed_cluster_bootstrap_ci95": [0.0, 1.0],
        }
        stack = ExitStack()
        stack.enter_context(
            mock.patch.object(
                verifier, "_validate_manifest_identity", return_value=None
            )
        )
        stack.enter_context(
            mock.patch.object(
                verifier, "_manifest_checkpoint_registry", return_value={}
            )
        )
        stack.enter_context(
            mock.patch.object(verifier, "_verify_readonly_bindings", return_value=1)
        )
        stack.enter_context(
            mock.patch.object(verifier, "_verify_source_files", return_value=None)
        )
        stack.enter_context(
            mock.patch.object(verifier, "_load_lifeline_runtime", return_value=None)
        )
        stack.enter_context(
            mock.patch.object(
                verifier,
                "_validate_receipt_gate_declaration",
                return_value=False,
            )
        )
        stack.enter_context(
            mock.patch.object(verifier, "_RUNTIME_SOURCE_BINDING", None)
        )
        stack.enter_context(
            mock.patch.object(verifier, "_RUNTIME_DEPENDENCY_BINDING", None)
        )
        stack.enter_context(mock.patch.object(verifier, "_RUNTIME_FILE_BINDINGS", {}))
        stack.enter_context(
            mock.patch.object(
                verifier,
                "_bootstrap_settings",
                return_value={
                    verifier.GEN_SIZE_ID: (1, 11),
                    verifier.D16_V2_ID: (1, 12),
                },
            )
        )
        stack.enter_context(
            mock.patch.object(
                verifier, "_attach_game_manifest", side_effect=lambda rows, *_: rows
            )
        )
        stack.enter_context(
            mock.patch.object(
                verifier, "_validate_task_rows", return_value={"synthetic-task": task}
            )
        )
        stack.enter_context(
            mock.patch.object(verifier, "_audit_task", return_value=(audit, [], [], 1))
        )
        stack.enter_context(
            mock.patch.object(verifier, "_validate_ledger_status", return_value=None)
        )
        stack.enter_context(
            mock.patch.object(
                verifier,
                "_task_pair_plan",
                return_value=[opening, copy.deepcopy(opening)],
            )
        )
        stack.enter_context(
            mock.patch.object(verifier, "_unique_gate", return_value=unique_gate)
        )
        stack.enter_context(
            mock.patch.object(verifier, "_aggregate_groups", return_value=[group])
        )
        stack.enter_context(
            mock.patch.object(verifier, "EXPECTED_GROUPS", {verifier.D16_V2_ID: 1})
        )
        stack.enter_context(
            mock.patch.object(verifier, "EXPECTED_EXPORT_MANIFEST_ENTRIES", 4)
        )
        return stack

    @classmethod
    def _run_synthetic_verify(
        cls,
        paths: dict[str, Path],
        *,
        canonical: bool,
        canonical_sha256: str | None = None,
        ledger_status: bool = False,
        unique_gate: bool = True,
    ) -> tuple[dict[str, object], dict[str, object]]:
        with cls._synthetic_core_patches(unique_gate=unique_gate):
            return verifier.verify_evidence(
                manifest_path=paths["manifest"],
                task_manifest_path=paths["tasks"],
                game_manifest_path=paths["game_manifest"],
                receipts_path=paths["receipts"],
                ledger_status_path=(paths["ledger_status"] if ledger_status else None),
                canonical_numeric_path=paths["canonical"] if canonical else None,
                canonical_sha256=canonical_sha256,
                canonical_receipt_path=(
                    paths["canonical_receipt"] if canonical else None
                ),
            )

    @classmethod
    def _publish_synthetic_canonical(
        cls, paths: dict[str, Path], numeric: dict[str, object]
    ) -> str:
        cls._write_json(paths["canonical"], numeric)
        canonical_sha256 = hashlib.sha256(paths["canonical"].read_bytes()).hexdigest()

        def sha256(path: Path) -> str:
            return hashlib.sha256(path.read_bytes()).hexdigest()

        export_manifest = json.loads(
            paths["export_manifest"].read_text(encoding="utf-8")
        )
        export_tree_sha256 = verifier._canonical_sha256(
            [
                {
                    "path": entry["path"].rsplit(f"/{verifier.BUNDLE_ID}/", 1)[1],
                    "sha256": entry["sha256"],
                }
                for entry in export_manifest["files"]
            ]
        )
        formal_source_hash = "5" * 64
        cls._write_json(
            paths["canonical_receipt"],
            {
                "schema_name": "lifeline-d17-d19-canonical-derivation-receipt",
                "schema_version": 1,
                "bundle_id": verifier.BUNDLE_ID,
                "status": "canonical_numeric_recovered_awaiting_independent_verification",
                "formal_ready": False,
                "formal_source_hash": formal_source_hash,
                "independent_numeric_consumed": False,
                "read_only_inputs": True,
                "frozen_runner_canonical_aggregate_reused": True,
                "input_fingerprint_before_aggregate_sha256": "4" * 64,
                "input_fingerprint_after_aggregate_sha256": "4" * 64,
                "created_at_utc": "2026-09-01T00:00:00Z",
                "outputs": {
                    "canonical_numeric": paths["canonical"].name,
                    "canonical_numeric_sha256": canonical_sha256,
                },
                "bindings": {
                    "adapter_sha256": sha256(
                        Path(verifier.__file__).with_name(
                            "d17_d19_build_canonical_from_export.py"
                        )
                    ),
                    "runner_sha256": str(numeric["runner_sha256"]),
                    "experiments_sha256": str(numeric["experiments_sha256"]),
                    "export_manifest_sha256": sha256(paths["export_manifest"]),
                    "export_payload_tree_sha256": export_tree_sha256,
                    "manifest_file_sha256": sha256(paths["manifest"]),
                    "manifest_canonical_sha256": str(numeric["manifest_sha256"]),
                    "protocol_sha256": str(numeric["protocol_sha256"]),
                    "task_manifest_sha256": str(numeric["task_manifest_sha256"]),
                    "game_manifest_sha256": str(numeric["game_manifest_sha256"]),
                    "result_ledger_sha256": sha256(paths["receipts"]),
                    "execution_metadata_sha256": sha256(paths["execution_metadata"]),
                    "result_ledger_status_sha256": sha256(paths["ledger_status"]),
                    "execution_summary_sha256": sha256(paths["execution_summary"]),
                    "formal_source_hash": formal_source_hash,
                },
                "counts": {
                    "export_manifest_entries": 4,
                    "export_payload_files": 4,
                    "task_receipts": 85,
                    "task_summaries": 85,
                    "task_game_files": 85,
                    "game_rows": 8_320,
                    "complete_tasks": 85,
                    "gate_failed_tasks": 0,
                    "comparison_rows": 1,
                    "fingerprinted_input_files": 8,
                    "stable_input_roles": 8,
                },
                "claims": {
                    "execution_complete": True,
                    "formal_task_gates_all_passed": True,
                    "independent_verification_passed": False,
                    "publication_ready": False,
                },
            },
        )
        return canonical_sha256

    @staticmethod
    def _checkpoint_binding_fixture() -> dict[str, object]:
        return {
            "checkpoint_id": "grid_gnn_seed11_gs200",
            "model_kind": "grid_gnn",
            "training_seed": 11,
            "trained_board_sizes": [5, 7, 9],
            "gradient_steps": 200,
            "path": "checkpoint.pt",
            "sha256": "a" * 64,
            "config_path": "resolved_config.json",
            "config_hash": "b" * 64,
            "config_file_sha256": "c" * 64,
            "source_hash": "d" * 64,
            "source_receipt_path": "receipt.json",
            "source_receipt_sha256": "e" * 64,
        }

    @staticmethod
    def _pair_plan_fixture() -> tuple[dict[str, object], dict[str, object]]:
        task: dict[str, object] = {"task_id": "task-0"}
        plan: dict[str, object] = {
            "pair_id": "pair-3",
            "pair_index": 3,
            "policy_seed_block": "block-0",
            "policy_seed_a": 101,
            "policy_seed_b": 202,
            "policy_seed_assignment": 0,
            "game_ids": ["game-6", "game-7"],
            "game_plan": [
                {
                    "task_id": "task-0",
                    "game_id": "game-6",
                    "game_index": 6,
                    "pair_id": "pair-3",
                    "pair_index": 3,
                    "pair_member": 0,
                    "pair_color_orientation": 0,
                    "color_swap": 0,
                    "black_slot": "A",
                    "white_slot": "B",
                    "policy_seed_block": "block-0",
                    "policy_seed_a": 101,
                    "policy_seed_b": 202,
                    "policy_seed_assignment": 0,
                    "black_policy_seed": 101,
                    "white_policy_seed": 202,
                },
                {
                    "task_id": "task-0",
                    "game_id": "game-7",
                    "game_index": 7,
                    "pair_id": "pair-3",
                    "pair_index": 3,
                    "pair_member": 1,
                    "pair_color_orientation": 1,
                    "color_swap": 1,
                    "black_slot": "B",
                    "white_slot": "A",
                    "policy_seed_block": "block-0",
                    "policy_seed_a": 101,
                    "policy_seed_b": 202,
                    "policy_seed_assignment": 0,
                    "black_policy_seed": 202,
                    "white_policy_seed": 101,
                },
            ],
        }
        return task, plan

    def test_empty_manifest_is_a_hard_negative(self) -> None:
        with self.assertRaisesRegex(verifier.VerificationError, "manifest is empty"):
            verifier._validate_manifest_identity({})

    def test_runtime_import_requires_an_authenticated_active_snapshot(self) -> None:
        if verifier._RUNTIME_SOURCE_BINDING is None:
            self.assertNotIn("lifeline_rl", sys.modules)
        with self.assertRaisesRegex(
            verifier.VerificationError, "requires an active snapshot"
        ):
            verifier._load_lifeline_runtime({})

    def test_runtime_loaded_files_join_the_verified_snapshot(self) -> None:
        manifest_path = (
            Path(verifier.__file__).resolve().parents[1]
            / "configs"
            / "d17_d19_formal_manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        snapshot = verifier._InputSnapshot({"repository": verifier.REPOSITORY_ROOT})
        self.assertIsNone(verifier._ACTIVE_INPUT_SNAPSHOT)
        verifier._ACTIVE_INPUT_SNAPSHOT = snapshot
        try:
            verifier._verify_source_files(
                manifest["source_hashes"], label="runtime-test"
            )
            verifier._load_lifeline_runtime(manifest["source_hashes"])
            fingerprint = snapshot.verify_unchanged()
        finally:
            verifier._ACTIVE_INPUT_SNAPSHOT = None
        self.assertEqual(
            len(verifier._RUNTIME_FILE_BINDINGS),
            len(verifier.VERIFIER_RUNTIME_SOURCE_HASHES),
        )
        self.assertTrue(
            all(":source:" in key for key in verifier._RUNTIME_FILE_BINDINGS)
        )
        self.assertFalse(
            any(":bytecode:" in key for key in verifier._RUNTIME_FILE_BINDINGS)
        )
        self.assertEqual(
            verifier._RUNTIME_DEPENDENCY_BINDING,
            verifier._canonical_sha256(verifier.VERIFIER_RUNTIME_SOURCE_HASHES),
        )
        loaded_modules = {
            name
            for name in sys.modules
            if name == "lifeline_rl" or name.startswith("lifeline_rl.")
        }
        self.assertTrue(loaded_modules)
        self.assertTrue(
            all(
                getattr(sys.modules[name], "__cached__", None) is None
                for name in loaded_modules
            )
        )
        self.assertGreater(fingerprint["input_count"], len(manifest["source_hashes"]))

    def test_runtime_finder_rejects_every_undeclared_lifeline_module(self) -> None:
        snapshot = verifier._InputSnapshot({"repository": verifier.REPOSITORY_ROOT})
        self.assertIsNone(verifier._ACTIVE_INPUT_SNAPSHOT)
        verifier._ACTIVE_INPUT_SNAPSHOT = snapshot
        try:
            finder = verifier._AuthenticatedRuntimeFinder(
                verifier._authenticated_runtime_sources()
            )
            with self.assertRaisesRegex(
                verifier.VerificationError, "requested undeclared module"
            ):
                finder.find_spec("lifeline_rl.undeclared_selftest_probe", None)
        finally:
            verifier._ACTIVE_INPUT_SNAPSHOT = None

    def test_runtime_source_hash_drift_fails_before_import(self) -> None:
        drifted = dict(verifier.VERIFIER_RUNTIME_SOURCE_HASHES)
        first_name = next(iter(drifted))
        drifted[first_name] = "0" * 64
        snapshot = verifier._InputSnapshot({"repository": verifier.REPOSITORY_ROOT})
        self.assertIsNone(verifier._ACTIVE_INPUT_SNAPSHOT)
        verifier._ACTIVE_INPUT_SNAPSHOT = snapshot
        try:
            with (
                mock.patch.object(verifier, "VERIFIER_RUNTIME_SOURCE_HASHES", drifted),
                self.assertRaisesRegex(
                    verifier.VerificationError, "runtime source hash mismatch"
                ),
            ):
                verifier._authenticated_runtime_sources()
        finally:
            verifier._ACTIVE_INPUT_SNAPSHOT = None

    def test_runner_sha_binding_rejects_missing_or_drifted_value(self) -> None:
        current = "a" * 64
        verifier._require_runner_binding(
            {"runner_sha256": current}, current, label="task"
        )
        for row in ({}, {"runner_sha256": "b" * 64}):
            with self.subTest(row=row), self.assertRaises(verifier.VerificationError):
                verifier._require_runner_binding(row, current, label="task")

    def test_checkpoint_binding_requires_source_receipt_provenance(self) -> None:
        binding = self._checkpoint_binding_fixture()
        verifier._validate_checkpoint_binding_schema(binding, label="binding")
        for field in ("source_receipt_path", "source_receipt_sha256"):
            missing = dict(binding)
            missing.pop(field)
            with (
                self.subTest(field=field),
                self.assertRaises(verifier.VerificationError),
            ):
                verifier._validate_checkpoint_binding_schema(missing, label="binding")
        invalid = dict(binding)
        invalid["source_receipt_sha256"] = "not-a-sha"
        with self.assertRaises(verifier.VerificationError):
            verifier._validate_checkpoint_binding_schema(invalid, label="binding")

    def test_task_receipt_and_game_checkpoint_bindings_must_match_exactly(self) -> None:
        binding = self._checkpoint_binding_fixture()
        task = {
            "agent_specs": {
                "A": {"kind": "learned_checkpoint", **binding},
                "B": {"kind": "search_baseline", "agent_kind": "random"},
            },
            "checkpoint_bindings": {"A": binding, "B": None},
        }
        registry = {str(binding["checkpoint_id"]): binding}
        verifier._validate_task_checkpoint_bindings(
            task, checkpoint_registry=registry, label="task"
        )
        verifier._verify_receipt_checkpoint_bindings(
            task, {"checkpoint_bindings": copy.deepcopy(task["checkpoint_bindings"])}
        )
        verifier._verify_game_checkpoint_bindings(
            task,
            {"checkpoint_bindings": copy.deepcopy(task["checkpoint_bindings"])},
            label="game",
        )

        drifted = copy.deepcopy(task)
        drifted["agent_specs"]["A"]["source_receipt_sha256"] = "f" * 64
        with self.assertRaises(verifier.VerificationError):
            verifier._validate_task_checkpoint_bindings(
                drifted, checkpoint_registry=registry, label="task"
            )
        registry_drift = copy.deepcopy(task)
        registry_drift["agent_specs"]["A"]["source_receipt_sha256"] = "f" * 64
        registry_drift["checkpoint_bindings"]["A"]["source_receipt_sha256"] = "f" * 64
        with self.assertRaisesRegex(
            verifier.VerificationError, "frozen checkpoint registry"
        ):
            verifier._validate_task_checkpoint_bindings(
                registry_drift, checkpoint_registry=registry, label="task"
            )
        for verifier_call in (
            lambda: verifier._verify_receipt_checkpoint_bindings(
                task, {"checkpoint_bindings": {"A": None, "B": None}}
            ),
            lambda: verifier._verify_game_checkpoint_bindings(
                task,
                {"checkpoint_bindings": {"A": None, "B": None}},
                label="game",
            ),
        ):
            with self.assertRaises(verifier.VerificationError):
                verifier_call()

    def test_source_receipt_file_hash_is_recomputed(self) -> None:
        existing_file = Path(__file__).resolve()
        existing_sha256 = hashlib.sha256(existing_file.read_bytes()).hexdigest()
        binding = self._checkpoint_binding_fixture()
        binding.update(
            {
                "path": str(existing_file),
                "sha256": existing_sha256,
                "config_path": str(existing_file),
                "config_file_sha256": existing_sha256,
                "source_receipt_path": str(existing_file),
                "source_receipt_sha256": existing_sha256,
            }
        )
        self.assertEqual(verifier._verify_checkpoint_paths(binding, label="binding"), 3)
        binding["source_receipt_sha256"] = "0" * 64
        with self.assertRaisesRegex(
            verifier.VerificationError, "source receipt file hash mismatch"
        ):
            verifier._verify_checkpoint_paths(binding, label="binding")

    def test_autodl_export_artifact_paths_relocate_without_escape(self) -> None:
        with self._temporary_directory() as temporary:
            temporary_root = Path(temporary)
            export_root = temporary_root / "export"
            export_root.mkdir()
            delivered = export_root / "tasks" / "task-0" / "games.jsonl"
            delivered.parent.mkdir(parents=True)
            delivered.write_text("{}\n", encoding="utf-8")
            remote = (
                "/root/autodl-tmp/jobs/job-0/work/bundle/formal_run/"
                "tasks/task-0/games.jsonl"
            )
            self.assertEqual(
                verifier._resolve_artifact_path(
                    remote, base=export_root, label="receipt.games"
                ),
                delivered.resolve(),
            )
            escaping = (
                "/root/autodl-tmp/jobs/job-0/work/bundle/formal_run/../outside.jsonl"
            )
            with self.assertRaises(verifier.VerificationError):
                verifier._resolve_artifact_path(
                    escaping, base=export_root, label="receipt.games"
                )
            outside = temporary_root / "outside.jsonl"
            outside.write_text("{}\n", encoding="utf-8")
            for injected in ("../outside.jsonl", str(outside.resolve())):
                with (
                    self.subTest(injected=injected),
                    self.assertRaisesRegex(
                        verifier.VerificationError,
                        "parent path|foreign artifact",
                    ),
                ):
                    verifier._resolve_artifact_path(
                        injected, base=export_root, label="receipt.games"
                    )

    def test_symlink_and_windows_reparse_identities_are_rejected(self) -> None:
        symlink_stat = os.stat_result((stat.S_IFLNK,) + (0,) * 9)
        self.assertTrue(verifier._is_link_or_reparse(symlink_stat))

        class ReparseStat:
            st_mode = stat.S_IFREG
            st_file_attributes = verifier._WINDOWS_REPARSE_POINT

        self.assertTrue(verifier._is_link_or_reparse(ReparseStat()))

        with self._temporary_directory() as temporary:
            ancestor = Path(temporary) / "ancestor"
            root = ancestor / "root"
            root.mkdir(parents=True)
            original_lstat = Path.lstat

            def lstat_with_reparse(path: Path) -> os.stat_result | ReparseStat:
                if os.path.normcase(str(path)) == os.path.normcase(str(ancestor)):
                    return ReparseStat()
                return original_lstat(path)

            with (
                mock.patch.object(Path, "lstat", lstat_with_reparse),
                self.assertRaisesRegex(
                    verifier.VerificationError, "symlink/reparse ancestry"
                ),
            ):
                verifier._InputSnapshot({"synthetic_root": root})

    def test_pair_game_plan_accepts_only_exact_registered_plan(self) -> None:
        task, plan = self._pair_plan_fixture()
        rows = verifier._validate_pair_game_plan(task, plan, label="pair")
        self.assertEqual([row["game_id"] for row in rows], ["game-6", "game-7"])

    def test_game_ids_and_game_plan_tampering_fail_closed(self) -> None:
        task, valid_plan = self._pair_plan_fixture()
        mutations = (
            ("game_ids", lambda plan: plan["game_ids"].__setitem__(0, "tampered")),
            (
                "game_plan_game_id",
                lambda plan: plan["game_plan"][0].__setitem__("game_id", "tampered"),
            ),
            (
                "game_plan_slot",
                lambda plan: plan["game_plan"][0].__setitem__("black_slot", "B"),
            ),
            (
                "game_plan_policy_seed",
                lambda plan: plan["game_plan"][1].__setitem__("black_policy_seed", 999),
            ),
        )
        for name, mutate in mutations:
            plan = copy.deepcopy(valid_plan)
            mutate(plan)
            with self.subTest(name=name), self.assertRaises(verifier.VerificationError):
                verifier._validate_pair_game_plan(task, plan, label="pair")

    def test_game_manifest_identity_slot_and_seed_tampering_fail_closed(self) -> None:
        task, plan = self._pair_plan_fixture()
        valid_manifest = copy.deepcopy(plan["game_plan"])
        for name, member, field, value in (
            ("game_id", 0, "game_id", "tampered"),
            ("slot", 1, "white_slot", "B"),
            ("policy_seed", 1, "white_policy_seed", 999),
        ):
            manifest = copy.deepcopy(valid_manifest)
            manifest[member][field] = value
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(
                    verifier.VerificationError, "game manifest differs"
                ),
            ):
                verifier._verify_pair_against_game_manifest(
                    task, plan, manifest, label="pair"
                )

    def test_training_seed_t_interval_uses_seed_means(self) -> None:
        values = [0.2, 0.4, 0.6, 0.8, 1.0]
        interval = verifier._seed_t_interval(values)
        self.assertIsNotNone(interval)
        assert interval is not None
        self.assertLessEqual(interval[0], 0.6)
        self.assertGreaterEqual(interval[1], 0.6)

    def test_crossed_cluster_bootstrap_is_deterministic(self) -> None:
        cells = {
            1: {"c0": [0.0, 0.5], "c1": [1.0, 0.5]},
            2: {"c0": [0.5, 0.5], "c1": [1.0, 1.0]},
            3: {"c0": [0.0, 0.0], "c1": [0.5, 1.0]},
            4: {"c0": [1.0, 0.5], "c1": [0.0, 0.5]},
            5: {"c0": [0.5, 1.0], "c1": [0.5, 0.0]},
        }
        first = verifier._crossed_cluster_bootstrap_interval(
            cells, resamples=500, random_seed=17
        )
        second = verifier._crossed_cluster_bootstrap_interval(
            cells, resamples=500, random_seed=17
        )
        self.assertEqual(first, second)

    def test_aggregate_uses_literal_frozen_seed_and_is_deterministic(self) -> None:
        tasks = []
        games = []
        pairs = []
        for seed_index, seed in enumerate((11, 12, 13, 14, 15)):
            tasks.append(
                {
                    "inference_group_id": "gen_size.grid_gnn.n10.vs.random",
                    "experiment_id": verifier.GEN_SIZE_ID,
                    "experiment_arm": "GEN-SIZE",
                    "training_seed": seed,
                }
            )
            for cluster_index, cluster in enumerate(("p0", "p1")):
                score = float((seed_index + cluster_index) % 2)
                pairs.append(
                    {
                        "inference_group_id": "gen_size.grid_gnn.n10.vs.random",
                        "training_seed": seed,
                        "opening_cluster": "standard",
                        "crossed_cluster_id": cluster,
                        "pair_score": score,
                    }
                )
                games.append(
                    {
                        "inference_group_id": "gen_size.grid_gnn.n10.vs.random",
                        "outcome": "WIN" if score == 1.0 else "LOSS",
                        "trajectory_hashes": {
                            "full_color_aware": f"aware-{seed}-{cluster}",
                            "full_sequence_ignoring_color": f"sequence-{seed}-{cluster}",
                            "continuation_ignoring_color": f"continuation-{seed}-{cluster}",
                        },
                    }
                )
        settings = {
            verifier.GEN_SIZE_ID: (500, 202608299901),
            verifier.D16_V2_ID: (500, 202608299902),
        }
        first = verifier._aggregate_groups(
            task_rows=tasks,
            games=games,
            pairs=pairs,
            bootstrap_settings=settings,
            manifest_sha256="0" * 64,
        )
        second = verifier._aggregate_groups(
            task_rows=tasks,
            games=games,
            pairs=pairs,
            bootstrap_settings=settings,
            manifest_sha256="f" * 64,
        )
        self.assertEqual(first, second)
        self.assertEqual(first[0]["crossed_cluster_bootstrap_seed"], 202608299901)

    def test_bootstrap_settings_reject_nonprotocol_seed(self) -> None:
        manifest = {
            "statistics": {
                "gen_size_secondary_interval": {
                    "replicates": 20000,
                    "bootstrap_seed": 202608299900,
                },
                "d16_v2_primary_interval": {
                    "replicates": 20000,
                    "bootstrap_seed": 202608299902,
                },
            }
        }
        with self.assertRaisesRegex(verifier.VerificationError, "frozen protocol"):
            verifier._bootstrap_settings(manifest)

    def test_declared_numeric_and_fail_closed_report_interfaces_are_stable(
        self,
    ) -> None:
        core = verifier._numeric_core(
            {
                "schema_name": verifier.NUMERIC_SCHEMA,
                "schema_version": verifier.SCHEMA_VERSION,
                "bundle_id": verifier.BUNDLE_ID,
                "manifest_sha256": "a" * 64,
                "protocol_sha256": "d" * 64,
                "runner_sha256": "e" * 64,
                "experiments_sha256": "f" * 64,
                "task_manifest_sha256": "b" * 64,
                "game_manifest_sha256": "c" * 64,
                "comparison_rows": [],
                "producer_only_field": "ignored",
            }
        )
        self.assertEqual(
            tuple(core),
            (
                "schema_name",
                "schema_version",
                "bundle_id",
                "manifest_sha256",
                "protocol_sha256",
                "runner_sha256",
                "experiments_sha256",
                "task_manifest_sha256",
                "game_manifest_sha256",
                "comparison_rows",
            ),
        )
        report = verifier._failure_report(
            verifier.VerificationError("negative"), manifest_path=Path("empty.json")
        )
        self.assertFalse(report["formal_ready"])
        self.assertEqual(report["status"], "FAIL_CLOSED")
        self.assertEqual(tuple(report["gates"]), verifier.GATE_NAMES)
        self.assertTrue(all(value is False for value in report["gates"].values()))

    def test_crossed_bootstrap_rejects_seed_specific_cluster_sets(self) -> None:
        with self.assertRaisesRegex(
            verifier.VerificationError, "same registered cluster"
        ):
            verifier._crossed_cluster_bootstrap_interval(
                {1: {"c0": [0.5]}, 2: {"c1": [0.5]}},
                resamples=10,
                random_seed=1,
            )

    def test_slot_labels_cannot_satisfy_formal_diversity_gate(self) -> None:
        row = {
            "experiment_id": verifier.GEN_SIZE_ID,
            "unique_full_color_aware": 64,
            "unique_full_sequence_ignoring_color": 1,
        }
        self.assertFalse(verifier._unique_gate(row))

    def test_color_aware_hash_is_only_supplementary(self) -> None:
        common = {
            "grid_size": 5,
            "superko_mode": "enforce",
            "actions": [{"action": 0}, {"action": 15}],
        }
        a_black = verifier._trajectory_hashes(
            {**common, "black_slot": "A", "white_slot": "B"}, []
        )
        a_white = verifier._trajectory_hashes(
            {**common, "black_slot": "B", "white_slot": "A"}, []
        )
        self.assertNotEqual(a_black["full_color_aware"], a_white["full_color_aware"])
        self.assertEqual(
            a_black["full_sequence_ignoring_color"],
            a_white["full_sequence_ignoring_color"],
        )

    def test_numeric_interface_mismatch_fails(self) -> None:
        with self.assertRaisesRegex(verifier.VerificationError, "numeric mismatch"):
            verifier._numeric_equal({"wins": 1}, {"wins": 2})

    def test_verify_evidence_uses_derivation_receipt_hash_and_matches_numeric(
        self,
    ) -> None:
        with self._temporary_directory() as temporary:
            paths = self._synthetic_inputs(Path(temporary))
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            canonical_sha256 = self._publish_synthetic_canonical(paths, numeric)
            report, observed_numeric = self._run_synthetic_verify(paths, canonical=True)
        canonical = report["inputs"]["canonical_numeric"]
        self.assertEqual(observed_numeric, numeric)
        self.assertTrue(report["gates"]["canonical_derivation_receipt_bound"])
        self.assertTrue(report["gates"]["canonical_hash_verified"])
        self.assertTrue(report["gates"]["canonical_numeric_match"])
        self.assertEqual(canonical["expected_sha256"], canonical_sha256)
        self.assertEqual(
            canonical["hash_source"]["type"], "canonical_derivation_receipt"
        )
        fingerprint = report["closure_input_fingerprint"]
        self.assertTrue(fingerprint["verified_unchanged_after_verification"])
        self.assertRegex(fingerprint["complete_fingerprint_sha256"], r"^[0-9a-f]{64}$")
        self.assertGreaterEqual(fingerprint["input_count"], 8)
        external_payload = {
            "schema_name": fingerprint["schema_name"],
            "schema_version": fingerprint["schema_version"],
            "identity_scope": fingerprint["identity_scope"],
            "entries": fingerprint["entries"],
        }
        self.assertEqual(
            fingerprint["complete_fingerprint_sha256"],
            verifier._canonical_sha256(external_payload),
        )

    def test_verify_evidence_canonical_numeric_mismatch_is_fail_closed(self) -> None:
        with self._temporary_directory() as temporary:
            paths = self._synthetic_inputs(Path(temporary))
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            mismatched = copy.deepcopy(numeric)
            mismatched["comparison_rows"] = [{"tampered": True}]
            self._publish_synthetic_canonical(paths, mismatched)
            report, _ = self._run_synthetic_verify(paths, canonical=True)
        self.assertTrue(report["gates"]["canonical_hash_verified"])
        self.assertFalse(report["gates"]["canonical_numeric_match"])
        self.assertFalse(report["formal_ready"])
        self.assertEqual(report["status"], "FAIL_CLOSED")
        self.assertTrue(
            any("canonical numeric mismatch" in issue for issue in report["issues"])
        )

    def test_verify_evidence_rejects_cli_hash_that_disagrees_with_receipt(
        self,
    ) -> None:
        with self._temporary_directory() as temporary:
            paths = self._synthetic_inputs(Path(temporary))
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            self._publish_synthetic_canonical(paths, numeric)
            report, _ = self._run_synthetic_verify(
                paths, canonical=True, canonical_sha256="f" * 64
            )
        self.assertFalse(report["gates"]["canonical_hash_verified"])
        self.assertTrue(any("disagrees with" in issue for issue in report["issues"]))

    def test_canonical_receipt_bindings_counts_and_claims_fail_closed(self) -> None:
        with self._temporary_directory() as temporary:
            paths = self._synthetic_inputs(Path(temporary))
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            self._publish_synthetic_canonical(paths, numeric)
            valid = json.loads(paths["canonical_receipt"].read_text(encoding="utf-8"))
            mutations = {
                "adapter": lambda value: value["bindings"].__setitem__(
                    "adapter_sha256", "0" * 64
                ),
                "runner": lambda value: value["bindings"].__setitem__(
                    "runner_sha256", "0" * 64
                ),
                "count": lambda value: value["counts"].__setitem__("game_rows", 8_319),
                "derived_gate_count": lambda value: value["counts"].__setitem__(
                    "gate_failed_tasks", 22
                ),
                "derived_gate_claim": lambda value: value["claims"].__setitem__(
                    "formal_task_gates_all_passed", False
                ),
                "claim": lambda value: value["claims"].__setitem__(
                    "publication_ready", True
                ),
                "aggregate_reuse": lambda value: value.__setitem__(
                    "frozen_runner_canonical_aggregate_reused", False
                ),
            }
            for name, mutate in mutations.items():
                receipt = copy.deepcopy(valid)
                mutate(receipt)
                self._write_json(paths["canonical_receipt"], receipt)
                report, _ = self._run_synthetic_verify(paths, canonical=True)
                with self.subTest(name=name):
                    self.assertFalse(
                        report["gates"]["canonical_derivation_receipt_bound"]
                    )
                    self.assertFalse(report["gates"]["canonical_hash_verified"])
                    self.assertTrue(report["issues"])
            self._write_json(paths["canonical_receipt"], valid)

    def test_post_hash_canonical_mutation_fails_the_complete_snapshot(self) -> None:
        with self._temporary_directory() as temporary:
            paths = self._synthetic_inputs(Path(temporary))
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            self._publish_synthetic_canonical(paths, numeric)
            original_numeric_equal = verifier._numeric_equal

            def mutate_after_compare(
                left: object, right: object, **kwargs: object
            ) -> None:
                original_numeric_equal(left, right, **kwargs)
                paths["canonical"].write_text(
                    paths["canonical"].read_text(encoding="utf-8") + "\n",
                    encoding="utf-8",
                )

            with (
                self._synthetic_core_patches(),
                mock.patch.object(
                    verifier, "_numeric_equal", side_effect=mutate_after_compare
                ),
                self.assertRaisesRegex(verifier.VerificationError, "input changed"),
            ):
                verifier.verify_evidence(
                    manifest_path=paths["manifest"],
                    task_manifest_path=paths["tasks"],
                    game_manifest_path=paths["game_manifest"],
                    receipts_path=paths["receipts"],
                    ledger_status_path=None,
                    canonical_numeric_path=paths["canonical"],
                    canonical_sha256=None,
                    canonical_receipt_path=paths["canonical_receipt"],
                )

    def test_main_writes_exact_outputs_and_preserves_exit_semantics(self) -> None:
        for unique_gate, expected_exit in ((True, 0), (False, 2)):
            with (
                self.subTest(unique_gate=unique_gate),
                self._temporary_directory() as temporary,
            ):
                root = Path(temporary)
                paths = self._synthetic_inputs(root)
                _, numeric = self._run_synthetic_verify(paths, canonical=False)
                self._publish_synthetic_canonical(paths, numeric)
                output = root / "verification"
                with (
                    self._synthetic_core_patches(unique_gate=unique_gate),
                    redirect_stdout(io.StringIO()),
                    redirect_stderr(io.StringIO()),
                ):
                    exit_code = verifier.main(
                        [
                            "--manifest",
                            str(paths["manifest"]),
                            "--task-manifest",
                            str(paths["tasks"]),
                            "--receipts",
                            str(paths["receipts"]),
                            "--game-manifest",
                            str(paths["game_manifest"]),
                            "--ledger-status",
                            str(paths["ledger_status"]),
                            "--canonical-numeric",
                            str(paths["canonical"]),
                            "--output-dir",
                            str(output),
                        ]
                    )
                self.assertEqual(exit_code, expected_exit)
                self.assertEqual(
                    {path.name for path in output.iterdir()},
                    {"independent_numeric.json", "independent_verification.json"},
                )
                written = json.loads(
                    (output / "independent_verification.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertIs(written["formal_ready"], unique_gate)
                false_gates = {
                    name for name, passed in written["gates"].items() if not passed
                }
                self.assertEqual(
                    false_gates,
                    set() if unique_gate else {"unique_trajectory_thresholds_met"},
                )
                self.assertEqual(written["issues"], [])

    def test_output_pair_never_replaces_a_raced_target(self) -> None:
        with self._temporary_directory() as temporary:
            output = Path(temporary) / "output"
            numeric_path = output / "independent_numeric.json"
            report_path = output / "independent_verification.json"
            original_rename = verifier._rename_path_no_replace

            def race_directory(source: Path, target: Path) -> None:
                if target == output:
                    target.mkdir()
                    report_path.write_text("raced\n", encoding="utf-8")
                original_rename(source, target)

            with (
                mock.patch.object(
                    verifier, "_rename_path_no_replace", side_effect=race_directory
                ),
                self.assertRaisesRegex(
                    verifier.VerificationError,
                    "refusing to replace raced output directory",
                ),
            ):
                verifier._publish_output_pair(
                    output_directory=output,
                    numeric={"value": 1},
                    report={"formal_ready": True},
                )
            self.assertEqual(report_path.read_text(encoding="utf-8"), "raced\n")
            self.assertFalse(numeric_path.exists())
            self.assertEqual(
                {path.name for path in output.iterdir()}, {report_path.name}
            )
            isolated_stages = [
                path
                for path in output.parent.iterdir()
                if path.name.startswith(".output.staging-")
            ]
            self.assertEqual(len(isolated_stages), 1)
            self.assertEqual(
                {path.name for path in isolated_stages[0].iterdir()},
                {numeric_path.name, report_path.name},
            )

    def test_output_parent_identity_is_bound_from_preflight_to_commit(self) -> None:
        with self._temporary_directory() as temporary:
            root = Path(temporary)
            parent = root / "publish-parent"
            parent.mkdir()
            output = parent / "verification"
            expected_target = verifier._prepare_new_output_directory(output)
            original_parent = root / "publish-parent-original"
            parent.rename(original_parent)
            parent.mkdir()
            with self.assertRaisesRegex(
                verifier.VerificationError, "parent identity changed since preflight"
            ):
                verifier._publish_output_pair(
                    output_directory=output,
                    numeric={"value": 1},
                    report={"formal_ready": True},
                    expected_target=expected_target,
                )
            self.assertFalse(output.exists())
            self.assertEqual(list(parent.iterdir()), [])

    def test_main_rejects_output_inside_every_immutable_input_root(self) -> None:
        with self._temporary_directory() as temporary:
            root = Path(temporary)
            paths = self._synthetic_inputs(root)
            input_root = paths["receipts"].parent
            before_names = {path.name for path in input_root.iterdir()}
            output = input_root / "verification"
            with (
                mock.patch.object(verifier, "verify_evidence") as mocked_verify,
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                exit_code = verifier.main(
                    [
                        "--manifest",
                        str(paths["manifest"]),
                        "--task-manifest",
                        str(paths["tasks"]),
                        "--receipts",
                        str(paths["receipts"]),
                        "--game-manifest",
                        str(paths["game_manifest"]),
                        "--ledger-status",
                        str(paths["ledger_status"]),
                        "--canonical-numeric",
                        str(paths["canonical"]),
                        "--canonical-receipt",
                        str(paths["canonical_receipt"]),
                        "--output-dir",
                        str(output),
                    ]
                )
            self.assertEqual(exit_code, 2)
            mocked_verify.assert_not_called()
            self.assertFalse(output.exists())
            self.assertEqual({path.name for path in input_root.iterdir()}, before_names)

    def test_main_race_cannot_leave_a_mixed_output_pair(self) -> None:
        with self._temporary_directory() as temporary:
            root = Path(temporary)
            paths = self._synthetic_inputs(root)
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            self._publish_synthetic_canonical(paths, numeric)
            output = root / "verification"
            report_path = output / "independent_verification.json"
            numeric_path = output / "independent_numeric.json"
            original_rename = verifier._rename_path_no_replace

            def race_directory(source: Path, target: Path) -> None:
                if target == output:
                    target.mkdir()
                    report_path.write_text("raced\n", encoding="utf-8")
                original_rename(source, target)

            with (
                self._synthetic_core_patches(),
                mock.patch.object(
                    verifier, "_rename_path_no_replace", side_effect=race_directory
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                exit_code = verifier.main(
                    [
                        "--manifest",
                        str(paths["manifest"]),
                        "--task-manifest",
                        str(paths["tasks"]),
                        "--receipts",
                        str(paths["receipts"]),
                        "--game-manifest",
                        str(paths["game_manifest"]),
                        "--ledger-status",
                        str(paths["ledger_status"]),
                        "--canonical-numeric",
                        str(paths["canonical"]),
                        "--output-dir",
                        str(output),
                    ]
                )
            self.assertEqual(exit_code, 2)
            self.assertEqual(report_path.read_text(encoding="utf-8"), "raced\n")
            self.assertFalse(numeric_path.exists())
            self.assertEqual(
                {path.name for path in output.iterdir()}, {report_path.name}
            )

    def test_post_commit_output_tamper_is_fail_closed(self) -> None:
        with self._temporary_directory() as temporary:
            output = Path(temporary) / "output"
            report_path = output / "independent_verification.json"
            original_rename = verifier._rename_path_no_replace

            def tamper_after_commit(source: Path, target: Path) -> None:
                original_rename(source, target)
                if target == output:
                    report_path.write_text("tampered\n", encoding="utf-8")

            with (
                mock.patch.object(
                    verifier,
                    "_rename_path_no_replace",
                    side_effect=tamper_after_commit,
                ),
                self.assertRaisesRegex(
                    verifier.VerificationError, "identity or SHA changed"
                ),
            ):
                verifier._publish_output_pair(
                    output_directory=output,
                    numeric={"value": 1},
                    report={"formal_ready": True},
                )
            self.assertFalse(output.exists())
            quarantines = [
                path
                for path in output.parent.iterdir()
                if path.name.startswith(".output.quarantine-")
            ]
            self.assertEqual(len(quarantines), 1)
            self.assertEqual(
                (quarantines[0] / report_path.name).read_text(encoding="utf-8"),
                "tampered\n",
            )

    def test_main_revalidates_output_immediately_before_return(self) -> None:
        with self._temporary_directory() as temporary:
            root = Path(temporary)
            paths = self._synthetic_inputs(root)
            _, numeric = self._run_synthetic_verify(paths, canonical=False)
            self._publish_synthetic_canonical(paths, numeric)
            output = root / "verification"
            numeric_path = output / "independent_numeric.json"
            original_validate = verifier._validate_publication
            validation_calls = 0

            def tamper_before_final_validation(
                publication: dict[str, object],
            ) -> None:
                nonlocal validation_calls
                validation_calls += 1
                if validation_calls == 2:
                    numeric_path.write_text("tampered\n", encoding="utf-8")
                original_validate(publication)

            with (
                self._synthetic_core_patches(),
                mock.patch.object(
                    verifier,
                    "_validate_publication",
                    side_effect=tamper_before_final_validation,
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                exit_code = verifier.main(
                    [
                        "--manifest",
                        str(paths["manifest"]),
                        "--task-manifest",
                        str(paths["tasks"]),
                        "--receipts",
                        str(paths["receipts"]),
                        "--game-manifest",
                        str(paths["game_manifest"]),
                        "--ledger-status",
                        str(paths["ledger_status"]),
                        "--canonical-numeric",
                        str(paths["canonical"]),
                        "--output-dir",
                        str(output),
                    ]
                )
            self.assertEqual(validation_calls, 4)
            self.assertEqual(exit_code, 2)
            self.assertFalse(numeric_path.exists())
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {"independent_verification.json"},
            )
            quarantines = [
                path
                for path in output.parent.iterdir()
                if path.name.startswith(".verification.quarantine-")
            ]
            self.assertEqual(len(quarantines), 1)
            self.assertEqual(
                (quarantines[0] / numeric_path.name).read_text(encoding="utf-8"),
                "tampered\n",
            )

    def test_exception_publishes_one_exact_failure_report_directory(self) -> None:
        with self._temporary_directory() as temporary:
            root = Path(temporary)
            inputs = root / "inputs"
            inputs.mkdir()
            output = root / "verification"
            with (
                mock.patch.object(
                    verifier,
                    "verify_evidence",
                    side_effect=verifier.VerificationError("synthetic failure"),
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                exit_code = verifier.main(
                    [
                        "--manifest",
                        str(inputs / "manifest.json"),
                        "--receipts",
                        str(inputs / "receipts.jsonl"),
                        "--game-manifest",
                        str(inputs / "games.jsonl"),
                        "--output-dir",
                        str(output),
                    ]
                )
            self.assertEqual(exit_code, 2)
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {"independent_verification.json"},
            )
            report = json.loads(
                (output / "independent_verification.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["status"], "FAIL_CLOSED")
            self.assertFalse(report["formal_ready"])
            self.assertEqual(report["issues"], ["synthetic failure"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
