from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = (
    REPO_ROOT
    / "research"
    / "iclr2027"
    / "scripts"
    / "d17_d19_build_canonical_from_export.py"
)
MODULE_NAME = "_lifeline_d17_d19_build_canonical_from_export_tested"
SPEC = importlib.util.spec_from_file_location(MODULE_NAME, SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load canonical recovery adapter: {SCRIPT_PATH}")
adapter = importlib.util.module_from_spec(SPEC)
sys.modules[MODULE_NAME] = adapter
SPEC.loader.exec_module(adapter)


MANIFEST_PATH = (
    REPO_ROOT / "research" / "iclr2027" / "configs" / "d17_d19_formal_manifest.json"
)
BUNDLE_DIRECTORY = (
    REPO_ROOT
    / "research"
    / "iclr2027"
    / "results"
    / "formal"
    / "d17_d19"
    / "run_20260829_p0_v5"
    / "task_bundle"
)
EXPECTED_CURRENT_CANONICAL_SHA256 = (
    "f26e3745a5f28a7575fce66517b1c2d0cb8c2b4fcc9ec3c4d416926b5a10dd19"
)
TEMPORARY_PARENT = REPO_ROOT / "local_artifacts" / "d17_d19_canonical_recovery_tests"


class TemporaryWorkspace:
    def __init__(self) -> None:
        TEMPORARY_PARENT.mkdir(parents=True, exist_ok=True)
        self.path = Path(
            tempfile.mkdtemp(prefix=f"case-{uuid.uuid4().hex}-", dir=TEMPORARY_PARENT)
        )

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback
        shutil.rmtree(self.path)


def _fixture_task_directories() -> list[str]:
    return [f"task_{index:03d}" for index in range(adapter.EXPECTED_TASKS)]


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _build_export_fixture(root: Path) -> list[str]:
    root.mkdir(parents=True, exist_ok=False)
    task_directories = _fixture_task_directories()
    relatives = adapter._expected_export_relatives(task_directories)
    entries = []
    for relative in relatives:
        path = root / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((f"fixture:{relative}\n").encode("utf-8"))
        entries.append(
            {
                "path": f"/immutable/export/{relative}",
                "sha256": adapter._sha256_file(path),
            }
        )
    _write_json(
        root / adapter.EXPORT_MANIFEST_NAME,
        {
            "schema_name": "lifeline-d17-d19-lightweight-export",
            "schema_version": 1,
            "source_run_root": "/immutable/formal_run",
            "files": entries,
            "pair_scratch_exported": False,
            "created_at_utc": "2026-08-31T00:00:00Z",
        },
    )
    return task_directories


def _tree_fingerprint(root: Path) -> dict[str, str]:
    _, files = adapter._scan_regular_tree(root)
    return {relative: adapter._sha256_file(path) for relative, path in files.items()}


def _json_strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _json_strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _json_strings(nested)


def _export_only_context(
    export: Path,
    task_directories: list[str],
    *,
    additional_roles: dict[str, Path] | None = None,
) -> adapter.RecoveryContext:
    inventory = adapter._validate_export_manifest(
        export, task_directories=task_directories
    )
    roles = {
        f"export:{relative}": path for relative, path in sorted(inventory.paths.items())
    }
    roles["export:export_manifest.json"] = (
        inventory.root / adapter.EXPORT_MANIFEST_NAME
    ).resolve(strict=True)
    if additional_roles is not None:
        roles.update(additional_roles)
    fingerprints = adapter._fingerprint(tuple(roles.values()))
    return adapter.RecoveryContext(
        manifest_path=inventory.root / adapter.EXPORT_MANIFEST_NAME,
        bundle_directory=inventory.root,
        manifest={},
        tasks=(),
        games=(),
        metadata={},
        ledger_status={},
        execution_summary={},
        mapped_receipts={},
        export=inventory,
        bindings={"formal_source_hash": "f" * 64},
        counts={"gate_failed_tasks": 22},
        input_roles=roles,
        input_fingerprints=fingerprints,
        input_fingerprint_sha256=adapter._fingerprint_digest(roles, fingerprints),
    )


class ExportManifestContractTests(unittest.TestCase):
    def test_raw_manifest_and_bundle_are_lstatted_before_any_resolve(self) -> None:
        with TemporaryWorkspace() as temporary:
            manifest = temporary / "manifest-alias.json"
            bundle = temporary / "bundle-alias"
            with (
                mock.patch.object(
                    adapter,
                    "_reject_link_or_reparse",
                    side_effect=[None, adapter.RecoveryError("bundle alias rejected")],
                ) as reject,
                mock.patch.object(adapter.Path, "resolve") as resolve,
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "bundle alias"):
                    adapter._validate_all_inputs(
                        manifest_path=manifest,
                        bundle_directory=bundle,
                        export_directory=temporary / "export",
                    )
            self.assertEqual(reject.call_count, 2)
            self.assertEqual(reject.call_args_list[0].kwargs["expect_directory"], False)
            self.assertEqual(reject.call_args_list[1].kwargs["expect_directory"], True)
            resolve.assert_not_called()

    def test_complete_259_entry_fixture_is_accepted_without_input_writes(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            before = _tree_fingerprint(export)
            inventory = adapter._validate_export_manifest(
                export, task_directories=task_directories
            )
            after = _tree_fingerprint(export)
            self.assertEqual(before, after)
            self.assertEqual(len(inventory.paths), adapter.EXPECTED_EXPORT_ENTRIES)
            self.assertEqual(len(inventory.all_input_paths), 260)
            self.assertEqual(inventory.remote_export_root, "/immutable/export")
            self.assertRegex(inventory.payload_tree_sha256, r"^[0-9a-f]{64}$")

    def test_payload_hash_tamper_is_fail_closed(self) -> None:
        targets = (
            "execution_metadata.json",
            "result_receipts.jsonl",
            "tasks/task_000/games.jsonl",
        )
        for relative in targets:
            with self.subTest(relative=relative), TemporaryWorkspace() as temporary:
                export = temporary / "export"
                task_directories = _build_export_fixture(export)
                (export / Path(relative)).write_bytes(b"tampered\n")
                with self.assertRaisesRegex(adapter.RecoveryError, "SHA-256 mismatch"):
                    adapter._validate_export_manifest(
                        export, task_directories=task_directories
                    )

    def test_source_run_root_must_match_execution_metadata(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            inventory = adapter._validate_export_manifest(
                export, task_directories=task_directories
            )
            adapter._validate_export_run_root_binding(
                inventory, {"run_root": "/immutable/formal_run"}
            )
            with self.assertRaisesRegex(adapter.RecoveryError, "does not match"):
                adapter._validate_export_run_root_binding(
                    inventory, {"run_root": "/immutable/other_run"}
                )

    def test_non_export_input_mutation_is_fail_closed(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            dependency = temporary / "frozen_dependency.py"
            dependency.write_text("VALUE = 1\n", encoding="utf-8", newline="\n")
            context = _export_only_context(
                export,
                task_directories,
                additional_roles={"dependency": dependency},
            )
            dependency.write_text("VALUE = 2\n", encoding="utf-8", newline="\n")
            with self.assertRaisesRegex(adapter.RecoveryError, "input changed"):
                adapter._assert_inputs_unchanged(context)

    def test_extra_and_missing_files_are_fail_closed(self) -> None:
        for mode in ("extra", "missing"):
            with self.subTest(mode=mode), TemporaryWorkspace() as temporary:
                export = temporary / "export"
                task_directories = _build_export_fixture(export)
                if mode == "extra":
                    (export / "unexpected.json").write_text("{}\n", encoding="utf-8")
                else:
                    (export / "execution_summary.json").unlink()
                with self.assertRaisesRegex(
                    adapter.RecoveryError, "file set is not exact"
                ):
                    adapter._validate_export_manifest(
                        export, task_directories=task_directories
                    )

    def test_manifest_path_escape_is_fail_closed(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            manifest_path = export / adapter.EXPORT_MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"][0]["path"] = (
                "/immutable/export/../execution_metadata.json"
            )
            _write_json(manifest_path, manifest)
            with self.assertRaisesRegex(
                adapter.RecoveryError, "escaping path component"
            ):
                adapter._validate_export_manifest(
                    export, task_directories=task_directories
                )

    def test_symlink_or_reparse_payload_is_fail_closed_when_supported(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            target = export / "execution_metadata.json"
            source = export / "execution_summary.json"
            target.unlink()
            try:
                os.symlink(source, target)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(
                    f"platform cannot create a test symlink/reparse point: {exc}"
                )
            with self.assertRaisesRegex(adapter.RecoveryError, "symlink/reparse"):
                adapter._validate_export_manifest(
                    export, task_directories=task_directories
                )


class AtomicPublicationContractTests(unittest.TestCase):
    def test_atomic_success_publishes_exactly_two_files_and_preserves_input(
        self,
    ) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            _build_export_fixture(export)
            before = _tree_fingerprint(export)
            output = temporary / "new-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(
                    stage / adapter.CANONICAL_NAME,
                    {"source": adapter._sha256_file(export / "export_manifest.json")},
                )
                adapter._write_json_new(
                    stage / adapter.DERIVATION_RECEIPT_NAME, {"formal_ready": False}
                )
                return {"formal_ready": False}

            result = adapter._publish_new_directory(output, builder)
            self.assertEqual(result, {"formal_ready": False})
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {adapter.CANONICAL_NAME, adapter.DERIVATION_RECEIPT_NAME},
            )
            self.assertEqual(before, _tree_fingerprint(export))
            self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])
            self.assertEqual(list(temporary.glob(f".{output.name}.verified-*")), [])

    def test_builder_failure_leaves_private_staging_quarantine(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(
                    stage / adapter.CANONICAL_NAME, {"partial": True}
                )
                raise adapter.RecoveryError("injected failure")

            with self.assertRaisesRegex(adapter.RecoveryError, "injected failure"):
                adapter._publish_new_directory(output, builder)
            self.assertFalse(output.exists())
            staged = list(temporary.glob(f".{output.name}.staging-*"))
            self.assertEqual(len(staged), 1)
            self.assertTrue(
                (staged[0] / adapter.CANONICAL_NAME).is_file(),
            )

    def test_replaced_staging_directory_is_not_deleted(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"
            moved_stage = temporary / "original-stage"

            def builder(stage: Path) -> dict[str, object]:
                stage.rename(moved_stage)
                stage.mkdir()
                (stage / "foreign.txt").write_text(
                    "do not delete\n", encoding="utf-8", newline="\n"
                )
                return {"built": True}

            with self.assertRaisesRegex(adapter.RecoveryError, "identity changed"):
                adapter._publish_new_directory(output, builder)

            staged = list(temporary.glob(f".{output.name}.staging-*"))
            self.assertEqual(len(staged), 1)
            self.assertEqual(
                (staged[0] / "foreign.txt").read_text(encoding="utf-8"),
                "do not delete\n",
            )
            self.assertTrue(moved_stage.is_dir())
            self.assertFalse(output.exists())

    def test_existing_output_is_rejected_before_builder_or_input_access(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "existing"
            output.mkdir()
            builder = mock.Mock()
            with self.assertRaisesRegex(adapter.RecoveryError, "refusing to reuse"):
                adapter._publish_new_directory(output, builder)
            builder.assert_not_called()
            with self.assertRaisesRegex(adapter.RecoveryError, "refusing to reuse"):
                adapter.recover_canonical(
                    manifest_path=temporary / "missing-manifest.json",
                    bundle_directory=temporary / "missing-bundle",
                    export_directory=temporary / "missing-export",
                    output_directory=output,
                )

    def test_write_json_raced_destination_is_not_replaced(self) -> None:
        with TemporaryWorkspace() as temporary:
            destination = temporary / "artifact.json"
            original_publish = adapter._rename_path_no_replace

            def create_raced_file(source: Path, target: Path) -> None:
                self.assertEqual(target, destination)
                target.write_text("foreign\n", encoding="utf-8", newline="\n")
                original_publish(source, target)

            with mock.patch.object(
                adapter,
                "_rename_path_no_replace",
                side_effect=create_raced_file,
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "raced destination"):
                    adapter._write_json_new(destination, {"owned": True})

            self.assertEqual(destination.read_text(encoding="utf-8"), "foreign\n")
            quarantined = list(temporary.glob(f".{destination.name}.*.tmp"))
            self.assertEqual(len(quarantined), 1)
            self.assertEqual(
                json.loads(quarantined[0].read_text(encoding="utf-8")),
                {"owned": True},
            )

    def test_raced_empty_destination_is_not_replaced(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "raced-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(stage / "owned.json", {"owned": True})
                return {"built": True}

            original_publish = adapter._rename_path_no_replace
            race_observed = False

            def create_raced_destination(source: Path, destination: Path) -> None:
                nonlocal race_observed
                if destination == output:
                    destination.mkdir()
                    race_observed = True
                original_publish(source, destination)

            with mock.patch.object(
                adapter,
                "_rename_path_no_replace",
                side_effect=create_raced_destination,
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "raced destination"):
                    adapter._publish_new_directory(output, builder)

            self.assertTrue(race_observed)
            self.assertTrue(output.is_dir())
            self.assertEqual(list(output.iterdir()), [])
            self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])
            candidates = list(temporary.glob(f".{output.name}.verified-*"))
            self.assertEqual(len(candidates), 1)
            self.assertTrue((candidates[0] / "owned.json").is_file())

    def test_committed_output_is_reconciled_after_helper_base_exception(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(stage / "owned.json", {"owned": True})
                return {"built": True}

            original_publish = adapter._rename_path_no_replace

            def publish_then_raise(source: Path, destination: Path) -> None:
                original_publish(source, destination)
                if destination == output:
                    self.assertTrue(destination.is_dir())
                    raise KeyboardInterrupt()

            def validate(published: Path) -> None:
                self.assertEqual(
                    json.loads((published / "owned.json").read_text(encoding="utf-8")),
                    {"owned": True},
                )

            with mock.patch.object(
                adapter,
                "_rename_path_no_replace",
                side_effect=publish_then_raise,
            ):
                result = adapter._publish_new_directory(
                    output,
                    builder,
                    post_publish=validate,
                )

            self.assertEqual(result, {"built": True})
            self.assertTrue((output / "owned.json").is_file())
            self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])
            self.assertEqual(list(temporary.glob(f".{output.name}.verified-*")), [])

    def test_helper_exception_without_validator_is_not_reconciled(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(stage / "owned.json", {"owned": True})
                return {"built": True}

            original_publish = adapter._rename_path_no_replace

            def publish_then_raise(source: Path, destination: Path) -> None:
                original_publish(source, destination)
                if destination == output:
                    raise RuntimeError("injected without validator")

            with mock.patch.object(
                adapter,
                "_rename_path_no_replace",
                side_effect=publish_then_raise,
            ):
                with self.assertRaisesRegex(RuntimeError, "without validator"):
                    adapter._publish_new_directory(output, builder)

            self.assertTrue((output / "owned.json").is_file())
            self.assertEqual(list(temporary.glob(f".{output.name}.verified-*")), [])

    def test_final_commit_noop_is_fail_closed_with_candidate_quarantine(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(stage / "owned.json", {"owned": True})
                return {"built": True}

            original_publish = adapter._rename_path_no_replace

            def skip_final_commit(source: Path, destination: Path) -> None:
                if destination == output:
                    return
                original_publish(source, destination)

            def validate(published: Path) -> None:
                self.assertTrue((published / "owned.json").is_file())

            with mock.patch.object(
                adapter,
                "_rename_path_no_replace",
                side_effect=skip_final_commit,
            ):
                with self.assertRaisesRegex(
                    adapter.RecoveryError, "candidate still exists"
                ):
                    adapter._publish_new_directory(
                        output,
                        builder,
                        post_publish=validate,
                    )

            self.assertFalse(output.exists())
            candidates = list(temporary.glob(f".{output.name}.verified-*"))
            self.assertEqual(len(candidates), 1)
            self.assertTrue((candidates[0] / "owned.json").is_file())

    def test_output_parent_must_preexist_and_dangling_output_is_rejected(self) -> None:
        with TemporaryWorkspace() as temporary:
            with mock.patch.object(
                adapter,
                "_reject_link_or_reparse",
                wraps=adapter._reject_link_or_reparse,
            ) as reject:
                target = adapter._prepare_new_output_target(
                    temporary / "identity-checked-output"
                )
            self.assertEqual(target.parent, temporary.resolve(strict=True))
            self.assertEqual(reject.call_count, 2)
            self.assertTrue(
                all(call.kwargs["expect_directory"] for call in reject.call_args_list)
            )

            missing_parent_output = temporary / "missing-parent" / "output"
            builder = mock.Mock()
            with self.assertRaisesRegex(adapter.RecoveryError, "must already exist"):
                adapter._publish_new_directory(missing_parent_output, builder)
            builder.assert_not_called()

            dangling_output = temporary / "dangling-output"
            real_lexists = adapter.os.path.lexists

            def injected_lexists(path: object) -> bool:
                if Path(path) == dangling_output:
                    return True
                return real_lexists(path)

            with mock.patch.object(
                adapter.os.path, "lexists", side_effect=injected_lexists
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "refusing to reuse"):
                    adapter._publish_new_directory(dangling_output, builder)
            builder.assert_not_called()

    def test_canonical_output_alias_inside_export_is_rejected_before_validation(
        self,
    ) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            output_parent = export / "outputs"
            output_parent.mkdir(parents=True)
            bundle = temporary / "bundle"
            bundle.mkdir()
            with self.assertRaisesRegex(adapter.RecoveryError, "disjoint"):
                adapter.recover_canonical(
                    manifest_path=temporary / "missing-manifest.json",
                    bundle_directory=bundle,
                    export_directory=export,
                    output_directory=output_parent / "new-output",
                )

    def test_recovery_receipt_binds_stable_before_and_after_fingerprints(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            context = _export_only_context(export, task_directories)
            bundle = temporary / "bundle"
            bundle.mkdir()
            manifest = temporary / "manifest.json"
            _write_json(manifest, {})
            output = temporary / "new-output"

            def fake_canonical(
                observed_context: adapter.RecoveryContext, canonical_path: Path
            ) -> dict[str, object]:
                self.assertIs(observed_context, context)
                adapter._write_json_new(canonical_path, {"fixture": True})
                return {"comparison_rows": adapter.EXPECTED_COMPARISON_ROWS}

            with (
                mock.patch.object(
                    adapter, "_validate_all_inputs", return_value=context
                ),
                mock.patch.object(
                    adapter, "_run_frozen_canonical", side_effect=fake_canonical
                ),
            ):
                result = adapter.recover_canonical(
                    manifest_path=manifest,
                    bundle_directory=bundle,
                    export_directory=export,
                    output_directory=output,
                )

            receipt = json.loads(
                (output / adapter.DERIVATION_RECEIPT_NAME).read_text(encoding="utf-8")
            )
            receipt_text = (output / adapter.DERIVATION_RECEIPT_NAME).read_text(
                encoding="utf-8"
            )
            self.assertEqual(
                set(receipt),
                {
                    "schema_name",
                    "schema_version",
                    "bundle_id",
                    "status",
                    "formal_ready",
                    "formal_source_hash",
                    "independent_numeric_consumed",
                    "read_only_inputs",
                    "frozen_runner_canonical_aggregate_reused",
                    "input_fingerprint_before_aggregate_sha256",
                    "input_fingerprint_after_aggregate_sha256",
                    "created_at_utc",
                    "outputs",
                    "bindings",
                    "counts",
                    "claims",
                },
            )
            self.assertEqual(
                receipt["claims"],
                {
                    "execution_complete": True,
                    "formal_task_gates_all_passed": False,
                    "independent_verification_passed": False,
                    "publication_ready": False,
                },
            )
            self.assertEqual(
                receipt["outputs"],
                {
                    "canonical_numeric": adapter.CANONICAL_NAME,
                    "canonical_numeric_sha256": result["canonical_numeric_sha256"],
                },
            )
            self.assertEqual(set(receipt["bindings"]), {"formal_source_hash"})
            self.assertTrue(
                all(
                    adapter._valid_sha256(digest)
                    for digest in receipt["bindings"].values()
                )
            )
            self.assertEqual(receipt["counts"], {"gate_failed_tasks": 22})
            self.assertEqual(
                adapter._require_utc(receipt["created_at_utc"], label="created_at_utc"),
                receipt["created_at_utc"],
            )
            for value in _json_strings(receipt):
                self.assertFalse(value.startswith(("/", "\\\\")))
                self.assertFalse(
                    len(value) >= 3 and value[1] == ":" and value[2] in {"/", "\\"}
                )
            self.assertEqual(receipt["bundle_id"], adapter.runner.BUNDLE_EXPERIMENT_ID)
            self.assertEqual(receipt["formal_source_hash"], "f" * 64)
            self.assertEqual(
                receipt["input_fingerprint_before_aggregate_sha256"],
                context.input_fingerprint_sha256,
            )
            self.assertEqual(
                receipt["input_fingerprint_after_aggregate_sha256"],
                context.input_fingerprint_sha256,
            )
            self.assertFalse(receipt["formal_ready"])
            self.assertFalse(receipt["claims"]["formal_task_gates_all_passed"])
            self.assertFalse(receipt["claims"]["independent_verification_passed"])
            self.assertFalse(receipt["claims"]["publication_ready"])
            for forbidden in (
                str(temporary),
                "C:\\",
                "/root/",
                "zcz",
                "af4a68c8",
                "autodl",
            ):
                self.assertNotIn(forbidden, receipt_text)
            self.assertEqual(
                result["canonical_comparison_rows"],
                adapter.EXPECTED_COMPARISON_ROWS,
            )

    def test_non_export_input_change_during_aggregate_leaves_no_output(self) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            dependency = temporary / "frozen_dependency.py"
            dependency.write_text("VALUE = 1\n", encoding="utf-8", newline="\n")
            context = _export_only_context(
                export,
                task_directories,
                additional_roles={"dependency": dependency},
            )
            bundle = temporary / "bundle"
            bundle.mkdir()
            manifest = temporary / "manifest.json"
            _write_json(manifest, {})
            output = temporary / "new-output"

            def fake_canonical(
                observed_context: adapter.RecoveryContext, canonical_path: Path
            ) -> dict[str, object]:
                self.assertIs(observed_context, context)
                adapter._write_json_new(canonical_path, {"fixture": True})
                dependency.write_text("VALUE = 2\n", encoding="utf-8", newline="\n")
                return {"comparison_rows": adapter.EXPECTED_COMPARISON_ROWS}

            with (
                mock.patch.object(
                    adapter, "_validate_all_inputs", return_value=context
                ),
                mock.patch.object(
                    adapter, "_run_frozen_canonical", side_effect=fake_canonical
                ),
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "input changed"):
                    adapter.recover_canonical(
                        manifest_path=manifest,
                        bundle_directory=bundle,
                        export_directory=export,
                        output_directory=output,
                    )

            self.assertFalse(output.exists())
            staged = list(temporary.glob(f".{output.name}.staging-*"))
            self.assertEqual(len(staged), 1)
            self.assertTrue((staged[0] / adapter.CANONICAL_NAME).is_file())

    def test_post_rename_non_export_change_quarantines_verified_candidate(
        self,
    ) -> None:
        with TemporaryWorkspace() as temporary:
            export = temporary / "export"
            task_directories = _build_export_fixture(export)
            dependency = temporary / "frozen_dependency.py"
            dependency.write_text("VALUE = 1\n", encoding="utf-8", newline="\n")
            context = _export_only_context(
                export,
                task_directories,
                additional_roles={"dependency": dependency},
            )
            bundle = temporary / "bundle"
            bundle.mkdir()
            manifest = temporary / "manifest.json"
            _write_json(manifest, {})
            output = temporary / "new-output"

            def fake_canonical(
                observed_context: adapter.RecoveryContext, canonical_path: Path
            ) -> dict[str, object]:
                self.assertIs(observed_context, context)
                adapter._write_json_new(canonical_path, {"fixture": True})
                return {"comparison_rows": adapter.EXPECTED_COMPARISON_ROWS}

            original_publish = adapter._rename_path_no_replace
            publish_rename_observed = False

            def publish_then_inject(source: Path, destination: Path) -> None:
                nonlocal publish_rename_observed
                original_publish(source, destination)
                if destination.parent == output.parent and destination.name.startswith(
                    f".{output.name}.verified-"
                ):
                    publish_rename_observed = True
                    self.assertTrue(destination.is_dir())
                    dependency.write_text("VALUE = 2\n", encoding="utf-8", newline="\n")

            with (
                mock.patch.object(
                    adapter, "_validate_all_inputs", return_value=context
                ),
                mock.patch.object(
                    adapter, "_run_frozen_canonical", side_effect=fake_canonical
                ),
                mock.patch.object(
                    adapter,
                    "_rename_path_no_replace",
                    side_effect=publish_then_inject,
                ),
            ):
                with self.assertRaisesRegex(adapter.RecoveryError, "input changed"):
                    adapter.recover_canonical(
                        manifest_path=manifest,
                        bundle_directory=bundle,
                        export_directory=export,
                        output_directory=output,
                    )

            self.assertTrue(publish_rename_observed)
            self.assertFalse(output.exists())
            self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])
            candidates = list(temporary.glob(f".{output.name}.verified-*"))
            self.assertEqual(len(candidates), 1)

    def test_post_rename_output_byte_change_quarantines_verified_candidate(
        self,
    ) -> None:
        for changed_name in (
            adapter.CANONICAL_NAME,
            adapter.DERIVATION_RECEIPT_NAME,
        ):
            with (
                self.subTest(changed_name=changed_name),
                TemporaryWorkspace() as temporary,
            ):
                export = temporary / "export"
                task_directories = _build_export_fixture(export)
                context = _export_only_context(export, task_directories)
                bundle = temporary / "bundle"
                bundle.mkdir()
                manifest = temporary / "manifest.json"
                _write_json(manifest, {})
                output = temporary / "new-output"

                def fake_canonical(
                    observed_context: adapter.RecoveryContext, canonical_path: Path
                ) -> dict[str, object]:
                    self.assertIs(observed_context, context)
                    adapter._write_json_new(canonical_path, {"fixture": True})
                    return {"comparison_rows": adapter.EXPECTED_COMPARISON_ROWS}

                original_publish = adapter._rename_path_no_replace
                publish_rename_observed = False

                def publish_then_tamper(source: Path, destination: Path) -> None:
                    nonlocal publish_rename_observed
                    original_publish(source, destination)
                    if (
                        destination.parent == output.parent
                        and destination.name.startswith(f".{output.name}.verified-")
                    ):
                        publish_rename_observed = True
                        changed_path = destination / changed_name
                        changed_path.write_bytes(changed_path.read_bytes() + b"\n")

                with (
                    mock.patch.object(
                        adapter, "_validate_all_inputs", return_value=context
                    ),
                    mock.patch.object(
                        adapter, "_run_frozen_canonical", side_effect=fake_canonical
                    ),
                    mock.patch.object(
                        adapter,
                        "_rename_path_no_replace",
                        side_effect=publish_then_tamper,
                    ),
                ):
                    with self.assertRaisesRegex(
                        adapter.RecoveryError, "hashes changed"
                    ):
                        adapter.recover_canonical(
                            manifest_path=manifest,
                            bundle_directory=bundle,
                            export_directory=export,
                            output_directory=output,
                        )

                self.assertTrue(publish_rename_observed)
                self.assertFalse(output.exists())
                self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])
                candidates = list(temporary.glob(f".{output.name}.verified-*"))
                self.assertEqual(len(candidates), 1)

    def test_final_commit_output_tamper_is_fail_closed_without_deletion(self) -> None:
        for changed_name in (
            adapter.CANONICAL_NAME,
            adapter.DERIVATION_RECEIPT_NAME,
        ):
            with (
                self.subTest(changed_name=changed_name),
                TemporaryWorkspace() as temporary,
            ):
                export = temporary / "export"
                task_directories = _build_export_fixture(export)
                context = _export_only_context(export, task_directories)
                bundle = temporary / "bundle"
                bundle.mkdir()
                manifest = temporary / "manifest.json"
                _write_json(manifest, {})
                output = temporary / "new-output"

                def fake_canonical(
                    observed_context: adapter.RecoveryContext,
                    canonical_path: Path,
                ) -> dict[str, object]:
                    self.assertIs(observed_context, context)
                    adapter._write_json_new(canonical_path, {"fixture": True})
                    return {"comparison_rows": adapter.EXPECTED_COMPARISON_ROWS}

                original_publish = adapter._rename_path_no_replace

                def commit_then_tamper(source: Path, destination: Path) -> None:
                    original_publish(source, destination)
                    if destination == output:
                        changed_path = destination / changed_name
                        changed_path.write_bytes(changed_path.read_bytes() + b"\n")

                with (
                    mock.patch.object(
                        adapter, "_validate_all_inputs", return_value=context
                    ),
                    mock.patch.object(
                        adapter, "_run_frozen_canonical", side_effect=fake_canonical
                    ),
                    mock.patch.object(
                        adapter,
                        "_rename_path_no_replace",
                        side_effect=commit_then_tamper,
                    ),
                ):
                    with self.assertRaisesRegex(
                        adapter.RecoveryError, "hashes changed"
                    ):
                        adapter.recover_canonical(
                            manifest_path=manifest,
                            bundle_directory=bundle,
                            export_directory=export,
                            output_directory=output,
                        )

                self.assertTrue(output.is_dir())
                self.assertEqual(list(temporary.glob(f".{output.name}.verified-*")), [])
                self.assertEqual(list(temporary.glob(f".{output.name}.staging-*")), [])

    def test_wrong_published_directory_identity_is_not_deleted(self) -> None:
        with TemporaryWorkspace() as temporary:
            output = temporary / "new-output"
            moved_output = temporary / "moved-original-output"
            replaced_candidate: Path | None = None

            def builder(stage: Path) -> dict[str, object]:
                adapter._write_json_new(stage / "owned.json", {"owned": True})
                return {"built": True}

            def replace_with_unknown_directory(published: Path) -> None:
                nonlocal replaced_candidate
                replaced_candidate = published
                published.rename(moved_output)
                published.mkdir()
                (published / "foreign.txt").write_text(
                    "do not delete\n", encoding="utf-8", newline="\n"
                )

            with self.assertRaisesRegex(adapter.RecoveryError, "identity changed"):
                adapter._publish_new_directory(
                    output,
                    builder,
                    post_publish=replace_with_unknown_directory,
                )

            self.assertIsNotNone(replaced_candidate)
            assert replaced_candidate is not None
            self.assertEqual(
                (replaced_candidate / "foreign.txt").read_text(encoding="utf-8"),
                "do not delete\n",
            )
            self.assertTrue((moved_output / "owned.json").is_file())
            self.assertFalse(output.exists())

    def test_runner_monkeypatch_is_restored_on_exception(self) -> None:
        with TemporaryWorkspace() as temporary:
            root = temporary / "export"
            root.mkdir()
            inventory = adapter.ExportInventory(
                root=root,
                manifest={},
                manifest_sha256="0" * 64,
                remote_export_root="/immutable/export",
                paths={},
                hashes={},
                payload_tree_sha256="0" * 64,
                all_input_paths=(),
            )
            context = adapter.RecoveryContext(
                manifest_path=temporary / "manifest.json",
                bundle_directory=temporary / "bundle",
                manifest={},
                tasks=(),
                games=(),
                metadata={},
                ledger_status={},
                execution_summary={},
                mapped_receipts={},
                export=inventory,
                bindings={},
                counts={},
                input_roles={},
                input_fingerprints={},
                input_fingerprint_sha256=adapter._canonical_sha256([]),
            )
            originals = (
                adapter.runner._read_json,
                adapter.runner._execution_metadata,
                adapter.runner._finalize_ledger,
            )
            with self.assertRaisesRegex(RuntimeError, "injected"):
                with adapter._frozen_runner_export_view(context):
                    self.assertIsNot(adapter.runner._read_json, originals[0])
                    raise RuntimeError("injected")
            self.assertIs(adapter.runner._read_json, originals[0])
            self.assertIs(adapter.runner._execution_metadata, originals[1])
            self.assertIs(adapter.runner._finalize_ledger, originals[2])

    def test_cli_does_not_accept_independent_numeric_input(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            adapter._parser().parse_args(
                [
                    "--manifest",
                    "manifest.json",
                    "--bundle-dir",
                    "bundle",
                    "--export-dir",
                    "export",
                    "--output-dir",
                    "output",
                    "--independent-numeric",
                    "forbidden.json",
                ]
            )
        self.assertEqual(raised.exception.code, 2)


class LinuxNoReplaceContractTests(unittest.TestCase):
    def test_linux_renameat2_success_uses_exact_noreplace_contract(self) -> None:
        source = Path("source-path")
        destination = Path("destination-path")
        renameat2 = mock.Mock(return_value=0)
        library = mock.Mock()
        library.renameat2 = renameat2
        with (
            mock.patch.object(adapter.os, "name", "posix"),
            mock.patch.object(adapter.sys, "platform", "linux"),
            mock.patch.object(
                adapter.ctypes, "CDLL", return_value=library
            ) as load_library,
            mock.patch.object(adapter.ctypes, "set_errno") as set_errno,
        ):
            adapter._rename_path_no_replace(source, destination)

        load_library.assert_called_once_with(None, use_errno=True)
        set_errno.assert_called_once_with(0)
        renameat2.assert_called_once_with(
            adapter.AT_FDCWD,
            os.fsencode(source),
            adapter.AT_FDCWD,
            os.fsencode(destination),
            adapter.RENAME_NOREPLACE,
        )
        self.assertEqual(
            renameat2.argtypes,
            (
                adapter.ctypes.c_int,
                adapter.ctypes.c_char_p,
                adapter.ctypes.c_int,
                adapter.ctypes.c_char_p,
                adapter.ctypes.c_uint,
            ),
        )
        self.assertIs(renameat2.restype, adapter.ctypes.c_int)

    def test_linux_renameat2_missing_runtime_or_symbol_is_fail_closed(self) -> None:
        source = Path("source")
        destination = Path("destination")
        for mode in ("runtime", "symbol"):
            with self.subTest(mode=mode):
                cdll_patch = (
                    mock.patch.object(
                        adapter.ctypes,
                        "CDLL",
                        side_effect=OSError("runtime unavailable"),
                    )
                    if mode == "runtime"
                    else mock.patch.object(
                        adapter.ctypes,
                        "CDLL",
                        return_value=object(),
                    )
                )
                with (
                    mock.patch.object(adapter.os, "name", "posix"),
                    mock.patch.object(adapter.sys, "platform", "linux"),
                    cdll_patch,
                ):
                    with self.assertRaisesRegex(
                        adapter.RecoveryError, "publication is unavailable"
                    ):
                        adapter._rename_path_no_replace(source, destination)

    def test_linux_renameat2_collision_errnos_map_to_recovery_error(self) -> None:
        source = Path("source")
        destination = Path("destination")
        for error_number in (adapter.errno.EEXIST, adapter.errno.ENOTEMPTY):
            with self.subTest(error_number=error_number):
                renameat2 = mock.Mock(return_value=-1)
                library = mock.Mock()
                library.renameat2 = renameat2
                with (
                    mock.patch.object(adapter.os, "name", "posix"),
                    mock.patch.object(adapter.sys, "platform", "linux"),
                    mock.patch.object(adapter.ctypes, "CDLL", return_value=library),
                    mock.patch.object(
                        adapter.ctypes, "get_errno", return_value=error_number
                    ),
                    mock.patch.object(adapter.ctypes, "set_errno"),
                ):
                    with self.assertRaisesRegex(
                        adapter.RecoveryError, "raced destination"
                    ):
                        adapter._rename_path_no_replace(source, destination)

    def test_linux_renameat2_other_errnos_remain_os_errors(self) -> None:
        source = Path("source")
        destination = Path("destination")
        error_numbers = {
            0,
            adapter.errno.ENOSYS,
            adapter.errno.EINVAL,
            adapter.errno.EPERM,
            getattr(adapter.errno, "EOPNOTSUPP", adapter.errno.ENOSYS),
        }
        for error_number in sorted(error_numbers):
            with self.subTest(error_number=error_number):
                renameat2 = mock.Mock(return_value=-1)
                library = mock.Mock()
                library.renameat2 = renameat2
                with (
                    mock.patch.object(adapter.os, "name", "posix"),
                    mock.patch.object(adapter.sys, "platform", "linux"),
                    mock.patch.object(adapter.ctypes, "CDLL", return_value=library),
                    mock.patch.object(
                        adapter.ctypes, "get_errno", return_value=error_number
                    ),
                    mock.patch.object(adapter.ctypes, "set_errno"),
                ):
                    with self.assertRaises(OSError) as raised:
                        adapter._rename_path_no_replace(source, destination)
                self.assertEqual(raised.exception.errno, error_number)


class CurrentEvidenceIntegrationTests(unittest.TestCase):
    def test_current_export_end_to_end_when_explicitly_configured(self) -> None:
        configured = os.environ.get("LIFELINE_D17_D19_EXPORT")
        if not configured:
            self.skipTest("set LIFELINE_D17_D19_EXPORT for the 130 MB integration test")
        export = Path(configured).resolve(strict=True)
        before_manifest = adapter._sha256_file(export / adapter.EXPORT_MANIFEST_NAME)
        before_ledger = adapter._sha256_file(export / "result_receipts.jsonl")
        originals = (
            adapter.runner._read_json,
            adapter.runner._execution_metadata,
            adapter.runner._finalize_ledger,
        )
        with TemporaryWorkspace() as temporary:
            output = temporary / "canonical-recovery"
            result = adapter.recover_canonical(
                manifest_path=MANIFEST_PATH,
                bundle_directory=BUNDLE_DIRECTORY,
                export_directory=export,
                output_directory=output,
            )
            self.assertEqual(
                result["canonical_numeric_sha256"],
                EXPECTED_CURRENT_CANONICAL_SHA256,
            )
            self.assertFalse(result["formal_ready"])
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {adapter.CANONICAL_NAME, adapter.DERIVATION_RECEIPT_NAME},
            )
            receipt_path = output / adapter.DERIVATION_RECEIPT_NAME
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertFalse(receipt["formal_ready"])
            self.assertFalse(receipt["independent_numeric_consumed"])
            self.assertEqual(receipt["bundle_id"], adapter.runner.BUNDLE_EXPERIMENT_ID)
            self.assertEqual(
                receipt["formal_source_hash"],
                receipt["bindings"]["formal_source_hash"],
            )
            self.assertEqual(
                receipt["input_fingerprint_before_aggregate_sha256"],
                receipt["input_fingerprint_after_aggregate_sha256"],
            )
            self.assertEqual(receipt["counts"]["task_receipts"], 85)
            self.assertEqual(receipt["counts"]["game_rows"], 8_320)
            self.assertEqual(receipt["counts"]["gate_failed_tasks"], 22)
            receipt_text = receipt_path.read_text(encoding="utf-8")
            for forbidden in ("C:\\", "/root/", "zcz", "af4a68c8", "autodl-tmp"):
                self.assertNotIn(forbidden, receipt_text)
        self.assertEqual(
            before_manifest,
            adapter._sha256_file(export / adapter.EXPORT_MANIFEST_NAME),
        )
        self.assertEqual(
            before_ledger, adapter._sha256_file(export / "result_receipts.jsonl")
        )
        self.assertIs(adapter.runner._read_json, originals[0])
        self.assertIs(adapter.runner._execution_metadata, originals[1])
        self.assertIs(adapter.runner._finalize_ledger, originals[2])


if __name__ == "__main__":
    unittest.main()
