from __future__ import annotations

import io
import hashlib
import json
import os
import shutil
import stat
import struct
import sys
import unittest
import uuid
import warnings
import zipfile
from pathlib import Path, PurePosixPath
from unittest import mock


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[2]
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import archive_claim_complete_candidate as archiver  # noqa: E402
import build_supplement_candidate as builder  # noqa: E402
import derive_claim_complete_payload as derivation  # noqa: E402
import subject_binding  # noqa: E402


DUMMY_IDENTITY = "SELFTEST_ONLY_PRIVATE_IDENTITY_998877"
SELFTEST_OWNER_MARKER = ".archive-selftest-owner"
SUBJECT_COMMIT = "1" * 40
SUBJECT_TREE = "2" * 40


def _fake_subject_snapshot(
    repo_root: Path,
    commit: object,
    tree: object,
    *,
    frozen_paths: object,
    tool_paths: object,
) -> subject_binding.SubjectSnapshot:
    binding = subject_binding.parse_subject_binding(commit, tree)
    root = Path(repo_root).absolute()
    tool_relatives = tuple(
        Path(path).resolve(strict=True).relative_to(root).as_posix()
        for path in tool_paths
    )
    relatives = tuple(sorted({*frozen_paths, *tool_relatives}))
    files = []
    for relative in relatives:
        data = root.joinpath(*PurePosixPath(relative).parts).read_bytes()
        files.append(
            subject_binding.SubjectFileSnapshot(
                relative,
                "a" * 40,
                hashlib.sha256(data).hexdigest(),
                len(data),
                data,
            )
        )
    return subject_binding.SubjectSnapshot(
        repo_root=root,
        binding=binding,
        git_executable=Path(sys.executable),
        git_executable_sha256="c" * 64,
        git_executable_size_bytes=0,
        files=tuple(files),
        tool_relatives=tool_relatives,
    )


class ClaimCompleteArchiveSelfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.subject_verify_patcher = mock.patch.object(
            subject_binding,
            "verify_subject_repository",
            side_effect=_fake_subject_snapshot,
        )
        cls.subject_assert_patcher = mock.patch.object(
            subject_binding, "assert_subject_snapshot_unchanged", return_value=None
        )
        cls.subject_verify_patcher.start()
        cls.subject_assert_patcher.start()
        cls.addClassCleanup(cls.subject_assert_patcher.stop)
        cls.addClassCleanup(cls.subject_verify_patcher.stop)
        artifacts = REPO_ROOT / "local_artifacts"
        artifacts.mkdir(exist_ok=True)
        cls.root = artifacts / (
            f"_archive_claim_complete_selftest_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        )
        cls.root.mkdir()
        cls.root_owner_token = uuid.uuid4().hex
        cls.addClassCleanup(cls._remove_root)
        (cls.root / SELFTEST_OWNER_MARKER).write_text(
            cls.root_owner_token + "\n", encoding="ascii", newline="\n"
        )
        cls.identity_file = cls.root / "dummy_identity.json"
        cls.identity_file.write_text(json.dumps([DUMMY_IDENTITY]), encoding="utf-8")
        cls.profile_path = TOOL_DIR / "claim_complete_profile.json"
        cls.allowlist_path = TOOL_DIR / "supplement_claim_complete_allowlist.json"
        cls.stage_a = cls.root / "stage-a"
        cls.stage_b = cls.root / "stage-b"
        cls.candidate_a = cls.root / "candidate-a"
        cls.candidate_b = cls.root / "candidate-b"
        cls.archive_a = cls.root / "archive-a"
        cls.archive_b = cls.root / "archive-b"
        cls.extraction = cls.root / "extraction"
        derivation.derive_payload(
            REPO_ROOT,
            cls.profile_path,
            cls.stage_a,
            cls.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        derivation.derive_payload(
            REPO_ROOT,
            cls.profile_path,
            cls.stage_b,
            cls.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        builder.build_candidate(
            cls.stage_a,
            cls.allowlist_path,
            cls.candidate_a,
            cls.identity_file,
            subject_root=REPO_ROOT,
            subject_commit=SUBJECT_COMMIT,
            subject_tree=SUBJECT_TREE,
        )
        builder.build_candidate(
            cls.stage_b,
            cls.allowlist_path,
            cls.candidate_b,
            cls.identity_file,
            subject_root=REPO_ROOT,
            subject_commit=SUBJECT_COMMIT,
            subject_tree=SUBJECT_TREE,
        )
        cls.build_a = archiver.build_archive(
            cls.candidate_a,
            cls.archive_a,
            cls.identity_file,
            REPO_ROOT,
            cls.profile_path,
            cls.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        cls.build_b = archiver.build_archive(
            cls.candidate_b,
            cls.archive_b,
            cls.identity_file,
            REPO_ROOT,
            cls.profile_path,
            cls.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        cls.extract_result = archiver.verify_extract_archive(
            cls.archive_a / archiver.ARCHIVE_NAME,
            cls.archive_a / archiver.ARCHIVE_RECEIPT_NAME,
            cls.extraction,
            cls.identity_file,
            REPO_ROOT,
            cls.profile_path,
            cls.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        cls.config = builder.load_allowlist(cls.allowlist_path)
        cls.identity = builder.load_identity_profile(cls.identity_file)
        cls.binding = subject_binding.parse_subject_binding(
            SUBJECT_COMMIT, SUBJECT_TREE
        )
        _config, _identity, cls.documents, _snapshot = archiver._candidate_documents(
            cls.candidate_a,
            cls.allowlist_path,
            cls.identity_file,
            REPO_ROOT,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        cls.canonical_archive = (cls.archive_a / archiver.ARCHIVE_NAME).read_bytes()

    @classmethod
    def _remove_root(cls) -> None:
        root = getattr(cls, "root", None)
        if root is None or not root.exists():
            return
        expected_parent = REPO_ROOT / "local_artifacts"
        if (
            root.parent != expected_parent
            or not root.name.startswith("_archive_claim_complete_selftest_")
            or root.is_symlink()
            or builder._is_reparse(root)
            or not root.is_dir()
        ):
            raise RuntimeError("refusing unsafe archive self-test cleanup target")
        archiver._validate_plain_directory_chain(
            expected_parent, "archive self-test cleanup parent"
        )
        marker = root / SELFTEST_OWNER_MARKER
        if not marker.exists():
            if any(root.iterdir()):
                raise RuntimeError(
                    "archive self-test root lacks its marker and is not empty"
                )
            root.rmdir()
            return
        if marker.read_text(encoding="ascii") != cls.root_owner_token + "\n":
            raise RuntimeError("archive self-test ownership marker mismatch")
        shutil.rmtree(root)

    @staticmethod
    def _file_bytes(root: Path) -> dict[str, bytes]:
        return {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob("*")
            if path.is_file()
        }

    def _refresh_candidate_metadata(self, candidate: Path) -> None:
        payload = {
            entry.destination: candidate.joinpath(
                *PurePosixPath(entry.destination).parts
            ).read_bytes()
            for entry in self.config.files
        }
        readme = builder._readme_bytes(self.config)
        tree = builder._tree_bytes(self.config)
        manifest = builder._manifest_object(
            self.config,
            {
                **payload,
                builder.README_NAME: readme,
                builder.TREE_NAME: tree,
            },
            self.binding,
        )
        manifest_bytes = builder._canonical_json_bytes(manifest)
        scan = builder._scan_documents(
            [
                *payload.items(),
                (builder.README_NAME, readme),
                (builder.TREE_NAME, tree),
                (builder.MANIFEST_NAME, manifest_bytes),
            ],
            self.identity,
        )
        builder._raise_for_scan(scan, "archive ABA self-test candidate")
        candidate.joinpath(builder.MANIFEST_NAME).write_bytes(manifest_bytes)
        candidate.joinpath(builder.SCAN_NAME).write_bytes(
            builder._canonical_json_bytes(scan)
        )

    def _extra_receipt_candidate(self, name: str) -> tuple[Path, Path, bytes, bytes]:
        candidate = self.root / name
        shutil.copytree(self.candidate_a, candidate)
        receipt_entry = next(
            entry
            for entry in self.config.files
            if entry.destination == builder.SUBJECT_BOUND_RECEIPT_DESTINATION
        )
        receipt_path = candidate.joinpath(
            *PurePosixPath(receipt_entry.destination).parts
        )
        correct_receipt = receipt_path.read_bytes()
        extra_value = json.loads(correct_receipt.decode("utf-8"))
        extra_value["selftest_extra_field"] = "base-valid-but-not-regenerated"
        extra_receipt = builder._canonical_json_bytes(extra_value)
        receipt_path.write_bytes(extra_receipt)
        self._refresh_candidate_metadata(candidate)
        return candidate, receipt_path, correct_receipt, extra_receipt

    def _custom_zip(
        self,
        rows: list[tuple[str, bytes]],
        *,
        mutate_info: object | None = None,
    ) -> bytes:
        buffer = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(
                buffer,
                mode="w",
                compression=zipfile.ZIP_STORED,
                allowZip64=False,
            ) as archive:
                archive.comment = b""
                for index, (member_name, data) in enumerate(rows):
                    safe_name = f"{archiver.ARCHIVE_ROOT}/placeholder-{index}.txt"
                    info = archiver._zip_info(safe_name)
                    info.filename = member_name
                    if mutate_info is not None:
                        mutate_info(index, info)
                    archive.writestr(info, data, compress_type=zipfile.ZIP_STORED)
        return buffer.getvalue()

    def _canonical_rows(self) -> list[tuple[str, bytes]]:
        return [
            (f"{archiver.ARCHIVE_ROOT}/{relative}", self.documents[relative])
            for relative in sorted(self.documents)
        ]

    def _inspect_archive(self, data: bytes) -> archiver.ArchiveInspection:
        return archiver._inspect_archive_bytes(
            data, self.config, self.identity, self.binding
        )

    def _valid_verification_result(self) -> dict[str, object]:
        manifest = json.loads(self.documents[builder.MANIFEST_NAME])
        return {
            "status": "PASS",
            "candidate_status": builder.STATUS,
            "approval": derivation.APPROVAL,
            "privacy_scan": "PASS",
            "source_regeneration": "PASS_TWO_BYTE_IDENTICAL_DERIVATIONS",
            "game_engine_byte_identical": True,
            "compact_receipts": 330,
            "descriptive_only": True,
            "later_extension_labels_absent": True,
            "claim_count": len(derivation.CLAIM_IDS),
            "claim_coverage": list(derivation.CLAIM_IDS),
            "formal_source_exception_count": len(
                builder.CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS
            ),
            "subject_commit": SUBJECT_COMMIT,
            "subject_tree": SUBJECT_TREE,
            "subject_binding_verified": True,
            "file_count": len(self.documents),
            "manifest_file_count": manifest["file_count"],
            "manifest_total_bytes": manifest["total_bytes"],
            "candidate_snapshot_sha256": archiver._tree_sha256(self.documents),
        }

    def _first_central_directory_offset(self, data: bytes) -> int:
        offset = data.find(b"PK\x01\x02")
        self.assertGreaterEqual(offset, 0)
        return offset

    def test_a_b_archives_and_receipts_are_byte_identical(self) -> None:
        archive_a = (self.archive_a / archiver.ARCHIVE_NAME).read_bytes()
        archive_b = (self.archive_b / archiver.ARCHIVE_NAME).read_bytes()
        receipt_a = (self.archive_a / archiver.ARCHIVE_RECEIPT_NAME).read_bytes()
        receipt_b = (self.archive_b / archiver.ARCHIVE_RECEIPT_NAME).read_bytes()
        self.assertEqual(archive_a, archive_b)
        self.assertEqual(receipt_a, receipt_b)
        self.assertEqual(self.build_a["archive_sha256"], self.build_b["archive_sha256"])
        self.assertEqual(self.build_a["tree_sha256"], self.build_b["tree_sha256"])
        for observed in (self.build_a, self.build_b, self.extract_result):
            self.assertEqual(observed["subject_commit"], SUBJECT_COMMIT)
            self.assertEqual(observed["subject_tree"], SUBJECT_TREE)
            self.assertIs(observed["subject_binding_verified"], True)

    def test_verified_extraction_matches_candidate_tree(self) -> None:
        extracted = self.extraction / archiver.ARCHIVE_ROOT
        self.assertEqual(
            self._file_bytes(extracted), self._file_bytes(self.candidate_a)
        )
        self.assertEqual(self.extract_result["file_count"], len(self.documents))
        self.assertEqual(
            self.extract_result["tree_sha256"],
            archiver._tree_sha256(self.documents),
        )

    def test_receipts_preserve_candidate_and_identity_boundaries(self) -> None:
        archive_receipt_bytes = (
            self.archive_a / archiver.ARCHIVE_RECEIPT_NAME
        ).read_bytes()
        extraction_receipt_bytes = (
            self.extraction / archiver.EXTRACTION_RECEIPT_NAME
        ).read_bytes()
        archive_receipt = archive_receipt_bytes.decode("utf-8")
        extraction_receipt = extraction_receipt_bytes.decode("utf-8")
        combined = archive_receipt + extraction_receipt
        self.assertNotIn(DUMMY_IDENTITY, combined)
        self.assertNotIn(str(self.root), combined)
        self.assertNotIn(str(REPO_ROOT), combined)
        private_fingerprint = self.identity.digest.encode("ascii")
        public_bytes = (
            archive_receipt_bytes,
            extraction_receipt_bytes,
            self.canonical_archive,
        )
        for data in public_bytes:
            self.assertNotIn(DUMMY_IDENTITY.encode("utf-8"), data)
            self.assertNotIn(private_fingerprint, data)
            self.assertNotIn(b'"identity_term_count"', data)
            self.assertNotIn(b'"identity_terms_sha256"', data)
            self.assertNotIn(b'"identity_profile_sha256"', data)
        privacy_scan = json.loads(self.documents[builder.SCAN_NAME])
        self.assertEqual(
            privacy_scan["identity_input"],
            "private_supplied_not_fingerprinted",
        )
        for text in (archive_receipt, extraction_receipt):
            value = json.loads(text)
            self.assertEqual(value["status"], builder.STATUS)
            self.assertEqual(value["approval"], derivation.APPROVAL)
            self.assertEqual(value["subject_commit"], SUBJECT_COMMIT)
            self.assertEqual(value["subject_tree"], SUBJECT_TREE)
            self.assertIs(value["subject_binding_verified"], True)
            self.assertEqual(value["verification"]["subject_commit"], SUBJECT_COMMIT)
            self.assertEqual(value["verification"]["subject_tree"], SUBJECT_TREE)
            self.assertIs(value["verification"]["subject_binding_verified"], True)
            self.assertEqual(
                value["anonymity_coverage"],
                archiver.ANONYMITY_STATUS,
            )
            self.assertEqual(
                value["claims"],
                {
                    "author_approved": False,
                    "anonymity_coverage_established": False,
                    "clean_install_verified": False,
                    "final_archive": False,
                    "submission_ready": False,
                },
            )

        archive_value = json.loads(archive_receipt)
        self.assertEqual(
            set(archive_value["bindings"]),
            {
                "allowlist_sha256",
                "archive_tool_sha256",
                "builder_scanner_sha256",
                "derivation_tool_sha256",
                "manifest_sha256",
                "privacy_scan_sha256",
                "profile_sha256",
                "subject_binding_tool_sha256",
                "claim_verifier_sha256",
            },
        )

    def test_existing_build_output_is_refused_without_canary_change(self) -> None:
        output = self.root / "existing-build-output"
        output.mkdir()
        canary = output / "canary.txt"
        canary.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(archiver.ArchiveError, "already exists"):
            archiver.build_archive(
                self.candidate_a,
                output,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
                SUBJECT_COMMIT,
                SUBJECT_TREE,
            )
        self.assertEqual(canary.read_text(encoding="utf-8"), "keep")

    def test_build_output_must_not_overlap_candidate(self) -> None:
        before = self._file_bytes(self.candidate_a)
        output = self.candidate_a / "nested-archive-output"
        with self.assertRaisesRegex(archiver.ArchiveError, "must not overlap"):
            archiver.build_archive(
                self.candidate_a,
                output,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
                SUBJECT_COMMIT,
                SUBJECT_TREE,
            )
        self.assertFalse(output.exists())
        self.assertEqual(self._file_bytes(self.candidate_a), before)

    def test_output_parent_reparse_ancestor_is_rejected(self) -> None:
        ancestor = self.root / "simulated-reparse-ancestor"
        parent = ancestor / "plain-parent"
        parent.mkdir(parents=True)
        original = builder._is_reparse

        def is_reparse(path: Path) -> bool:
            return Path(path).absolute() == ancestor.absolute() or original(path)

        with mock.patch.object(builder, "_is_reparse", side_effect=is_reparse):
            with self.assertRaisesRegex(archiver.ArchiveError, "plain directory"):
                archiver._validate_new_directory(
                    parent / "new-output", "simulated output"
                )

    def test_existing_extraction_output_is_refused_without_canary_change(self) -> None:
        output = self.root / "existing-extraction-output"
        output.mkdir()
        canary = output / "canary.txt"
        canary.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(archiver.ArchiveError, "already exists"):
            archiver.verify_extract_archive(
                self.archive_a / archiver.ARCHIVE_NAME,
                self.archive_a / archiver.ARCHIVE_RECEIPT_NAME,
                output,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
                SUBJECT_COMMIT,
                SUBJECT_TREE,
            )
        self.assertEqual(canary.read_text(encoding="utf-8"), "keep")

    def test_duplicate_member_is_rejected(self) -> None:
        rows = self._canonical_rows()
        bad = self._custom_zip([*rows[:-1], rows[0]])
        with self.assertRaisesRegex(archiver.ArchiveError, "duplicate"):
            self._inspect_archive(bad)

    def test_extra_duplicate_member_is_rejected_by_eocd_count(self) -> None:
        rows = self._canonical_rows()
        bad = self._custom_zip([*rows, rows[0]])
        with self.assertRaisesRegex(archiver.ArchiveError, "entry count"):
            self._inspect_archive(bad)

    def test_unsafe_member_paths_are_rejected(self) -> None:
        first_data = self._canonical_rows()[0][1]
        unsafe = [
            "../escape.txt",
            "/absolute.txt",
            "C:/drive.txt",
            "\\\\server\\share.txt",
            f"{archiver.ARCHIVE_ROOT}\\backslash.txt",
            f"{archiver.ARCHIVE_ROOT}/../escape.txt",
            f"{archiver.ARCHIVE_ROOT}/CON.txt",
        ]
        for index, name in enumerate(unsafe):
            with self.subTest(name=name):
                bad = self._custom_zip([(name, first_data)])
                with self.assertRaises(archiver.ArchiveError):
                    self._inspect_archive(bad)

    def test_symlink_or_special_mode_is_rejected(self) -> None:
        rows = self._canonical_rows()

        def make_symlink(index: int, info: zipfile.ZipInfo) -> None:
            if index == 0:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16

        bad = self._custom_zip(rows, mutate_info=make_symlink)
        with self.assertRaisesRegex(archiver.ArchiveError, "metadata|regular file"):
            self._inspect_archive(bad)

    def test_missing_extra_and_tampered_members_are_rejected(self) -> None:
        rows = self._canonical_rows()
        variants = {
            "missing": rows[:-1],
            "extra": [
                *rows,
                (f"{archiver.ARCHIVE_ROOT}/unexpected.txt", b"extra"),
            ],
            "tampered": [
                (
                    name,
                    b"tampered" if name.endswith(builder.README_NAME) else data,
                )
                for name, data in rows
            ],
        }
        for label, variant in variants.items():
            with self.subTest(label=label):
                bad = self._custom_zip(variant)
                with self.assertRaises(archiver.ArchiveError):
                    self._inspect_archive(bad)

    def test_member_metadata_drift_is_rejected(self) -> None:
        rows = self._canonical_rows()

        def change_timestamp(index: int, info: zipfile.ZipInfo) -> None:
            if index == 0:
                info.date_time = (1981, 1, 1, 0, 0, 0)

        bad = self._custom_zip(rows, mutate_info=change_timestamp)
        with self.assertRaisesRegex(archiver.ArchiveError, "metadata"):
            self._inspect_archive(bad)

    def test_malformed_utf8_member_name_is_wrapped(self) -> None:
        bad = bytearray(self.canonical_archive)
        offset = self._first_central_directory_offset(bad)
        flags = struct.unpack_from("<H", bad, offset + 8)[0] | 0x0800
        struct.pack_into("<H", bad, offset + 8, flags)
        bad[offset + 46] = 0xFF
        with self.assertRaisesRegex(archiver.ArchiveError, "metadata"):
            self._inspect_archive(bytes(bad))

    def test_unsupported_extract_version_is_wrapped(self) -> None:
        bad = bytearray(self.canonical_archive)
        offset = self._first_central_directory_offset(bad)
        bad[offset + 6] = 0xFF
        with self.assertRaisesRegex(archiver.ArchiveError, "metadata"):
            self._inspect_archive(bytes(bad))

    def test_zip_parser_not_implemented_error_is_wrapped(self) -> None:
        with mock.patch.object(
            zipfile.ZipFile,
            "infolist",
            side_effect=NotImplementedError("unsupported ZIP metadata"),
        ):
            with self.assertRaisesRegex(archiver.ArchiveError, "metadata"):
                archiver._inspect_archive_bytes(
                    self.canonical_archive,
                    self.config,
                    self.identity,
                    self.binding,
                )

    def test_noncanonical_trailing_bytes_are_rejected(self) -> None:
        bad = self.canonical_archive + b"unexpected-trailer"
        with self.assertRaisesRegex(archiver.ArchiveError, "EOCD|canonical"):
            self._inspect_archive(bad)

    def test_eocd_count_drift_and_zip64_are_rejected_before_zip_parsing(self) -> None:
        eocd_offset = len(self.canonical_archive) - archiver.EOCD.size
        variants = {}
        count_drift = bytearray(self.canonical_archive)
        count_drift[eocd_offset + 8 : eocd_offset + 12] = b"\x00\x00\x00\x00"
        variants["entry count"] = bytes(count_drift)
        zip64 = bytearray(self.canonical_archive)
        zip64[eocd_offset + 8 : eocd_offset + 12] = b"\xff\xff\xff\xff"
        variants["ZIP64"] = bytes(zip64)

        for message, archive_bytes in variants.items():
            with self.subTest(message=message):
                with self.assertRaisesRegex(archiver.ArchiveError, message):
                    archiver._inspect_archive_bytes(
                        archive_bytes, self.config, self.identity, self.binding
                    )

    def test_receipt_archive_hash_tamper_is_rejected_before_output(self) -> None:
        receipt = json.loads(
            (self.archive_a / archiver.ARCHIVE_RECEIPT_NAME).read_text(encoding="utf-8")
        )
        receipt["archive"]["sha256"] = "0" * 64
        bad_receipt = self.root / "bad-receipt.json"
        bad_receipt.write_bytes(archiver._canonical_json_bytes(receipt))
        output = self.root / "bad-receipt-output"
        with self.assertRaisesRegex(archiver.ArchiveError, "does not bind"):
            archiver.verify_extract_archive(
                self.archive_a / archiver.ARCHIVE_NAME,
                bad_receipt,
                output,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
                SUBJECT_COMMIT,
                SUBJECT_TREE,
            )
        self.assertFalse(output.exists())

    def test_verifier_summary_rejects_python_equality_type_confusion(self) -> None:
        variants = {
            "game-engine-int": ("game_engine_byte_identical", 1),
            "descriptive-int": ("descriptive_only", 1),
            "compact-float": ("compact_receipts", 330.0),
            "claim-count-float": (
                "claim_count",
                float(len(derivation.CLAIM_IDS)),
            ),
            "file-count-bool": ("file_count", True),
            "snapshot-hash-bytes": (
                "candidate_snapshot_sha256",
                archiver._tree_sha256(self.documents).encode("ascii"),
            ),
        }
        for label, (key, value) in variants.items():
            with self.subTest(label=label):
                result = self._valid_verification_result()
                result[key] = value
                with self.assertRaisesRegex(archiver.ArchiveError, key):
                    archiver._verification_summary(
                        result,
                        self.binding,
                        archiver._tree_sha256(self.documents),
                    )

    def test_workflow_snapshot_detects_profile_drift_before_publication(self) -> None:
        profile_copy = self.root / "snapshot-profile.json"
        profile_copy.write_bytes(self.profile_path.read_bytes())
        snapshot = archiver._capture_workflow_snapshot(
            self.identity_file,
            REPO_ROOT,
            profile_copy,
            self.allowlist_path,
            SUBJECT_COMMIT,
            SUBJECT_TREE,
        )
        profile_copy.write_bytes(profile_copy.read_bytes() + b"\n")
        with self.assertRaisesRegex(archiver.ArchiveError, "changed during"):
            archiver._assert_workflow_snapshot_unchanged(snapshot)

    def test_workflow_snapshot_rejects_preparsed_profile_swap(self) -> None:
        original = self.profile_path.read_bytes()
        value = json.loads(original.decode("utf-8"))
        row = next(
            item
            for item in value["files"]
            if item["mode"] != "copy"
            and item["inputs"]
            and item["inputs"][0]["expected_sha256"] != "0" * 64
        )
        row["inputs"][0]["expected_sha256"] = "f" * 64
        profile_copy = self.root / "preparsed-workflow-profile.json"
        profile_copy.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        def restore_then_snapshot(*args: object, **kwargs: object) -> object:
            profile_copy.write_bytes(original)
            return _fake_subject_snapshot(*args, **kwargs)  # type: ignore[arg-type]

        with mock.patch.object(
            subject_binding,
            "verify_subject_repository",
            side_effect=restore_then_snapshot,
        ):
            with self.assertRaisesRegex(
                archiver.ArchiveError, "profile.*subject commit blob"
            ):
                archiver._capture_workflow_snapshot(
                    self.identity_file,
                    REPO_ROOT,
                    profile_copy,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )

    def test_workflow_snapshot_rejects_second_read_profile_swap(self) -> None:
        original = self.profile_path.read_bytes()
        value = json.loads(original.decode("utf-8"))
        copy_index = next(
            index for index, row in enumerate(value["files"]) if row["mode"] == "copy"
        )
        value["files"].pop(copy_index)
        narrowed_path = self.root / "second-read-narrowed-profile.json"
        narrowed_path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        narrowed_profile = derivation._load_profile(narrowed_path)
        profile_copy = self.root / "second-read-workflow-profile.json"
        profile_copy.write_bytes(original)

        with mock.patch.object(
            derivation,
            "_load_profile",
            return_value=narrowed_profile,
        ):
            with self.assertRaisesRegex(
                archiver.ArchiveError, "profile.*workflow byte snapshot"
            ):
                archiver._capture_workflow_snapshot(
                    self.identity_file,
                    REPO_ROOT,
                    profile_copy,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )

    def test_build_rejects_transient_identity_profile_swap(self) -> None:
        output = self.root / "identity-swap-build-output"
        swapped_identity = builder._identity_profile_from_bytes(
            json.dumps(["SELFTEST_ONLY_INNOCUOUS_IDENTITY"]).encode("utf-8")
        )
        with mock.patch.object(
            builder,
            "load_identity_profile",
            return_value=swapped_identity,
        ):
            with self.assertRaisesRegex(
                archiver.ArchiveError, "identity terms file.*workflow snapshot"
            ):
                archiver.build_archive(
                    self.candidate_a,
                    output,
                    self.identity_file,
                    REPO_ROOT,
                    self.profile_path,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )
        self.assertFalse(output.exists())

    def test_build_fails_if_verifier_changes_profile(self) -> None:
        profile_copy = self.root / "mutated-during-verification-profile.json"
        profile_copy.write_bytes(self.profile_path.read_bytes())
        output = self.root / "profile-drift-build-output"

        def mutate_profile(*_args: object, **_kwargs: object) -> dict[str, object]:
            profile_copy.write_bytes(profile_copy.read_bytes() + b"\n")
            return self._valid_verification_result()

        with mock.patch.object(
            archiver.claim_verifier,
            "verify_claim_complete",
            side_effect=mutate_profile,
        ):
            with self.assertRaisesRegex(archiver.ArchiveError, "changed during"):
                archiver.build_archive(
                    self.candidate_a,
                    output,
                    self.identity_file,
                    REPO_ROOT,
                    profile_copy,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )
        self.assertFalse(output.exists())

    def test_build_fails_if_verifier_changes_candidate_tree(self) -> None:
        candidate_copy = self.root / "mutated-during-verification-candidate"
        shutil.copytree(self.candidate_a, candidate_copy)
        output = self.root / "candidate-drift-build-output"

        def mutate_candidate(*_args: object, **_kwargs: object) -> dict[str, object]:
            readme = candidate_copy / builder.README_NAME
            readme.write_bytes(readme.read_bytes() + b"unexpected drift\n")
            return self._valid_verification_result()

        with mock.patch.object(
            archiver.claim_verifier,
            "verify_claim_complete",
            side_effect=mutate_candidate,
        ):
            with self.assertRaises((archiver.ArchiveError, builder.CandidateError)):
                archiver.build_archive(
                    candidate_copy,
                    output,
                    self.identity_file,
                    REPO_ROOT,
                    self.profile_path,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )
        self.assertFalse(output.exists())

    def test_build_rejects_candidate_aba_during_semantic_verification(self) -> None:
        candidate_copy, receipt_path, correct_receipt, extra_receipt = (
            self._extra_receipt_candidate("semantic-aba-candidate")
        )
        output = self.root / "semantic-aba-output"

        original_compare = archiver.claim_verifier._compare_regenerated_sources
        swaps = 0

        def transient_correct_receipt(*args: object, **kwargs: object) -> None:
            nonlocal swaps
            swaps += 1
            receipt_path.write_bytes(correct_receipt)
            try:
                original_compare(*args, **kwargs)
            finally:
                receipt_path.write_bytes(extra_receipt)

        with mock.patch.object(
            archiver.claim_verifier,
            "_compare_regenerated_sources",
            side_effect=transient_correct_receipt,
        ):
            with self.assertRaisesRegex(
                archiver.claim_verifier.VerificationError,
                "freshly derived source",
            ):
                archiver.build_archive(
                    candidate_copy,
                    output,
                    self.identity_file,
                    REPO_ROOT,
                    self.profile_path,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )
        self.assertEqual(swaps, 1)
        self.assertEqual(receipt_path.read_bytes(), extra_receipt)
        self.assertFalse(output.exists())

    def test_standalone_verifier_rejects_candidate_aba(self) -> None:
        candidate, receipt_path, correct_receipt, extra_receipt = (
            self._extra_receipt_candidate("standalone-semantic-aba-candidate")
        )
        original_compare = archiver.claim_verifier._compare_regenerated_sources
        swaps = 0

        def transient_correct_receipt(*args: object, **kwargs: object) -> None:
            nonlocal swaps
            swaps += 1
            receipt_path.write_bytes(correct_receipt)
            try:
                original_compare(*args, **kwargs)
            finally:
                receipt_path.write_bytes(extra_receipt)

        with mock.patch.object(
            archiver.claim_verifier,
            "_compare_regenerated_sources",
            side_effect=transient_correct_receipt,
        ):
            with self.assertRaisesRegex(
                archiver.claim_verifier.VerificationError,
                "freshly derived source",
            ):
                archiver.claim_verifier.verify_claim_complete(
                    candidate,
                    self.identity_file,
                    REPO_ROOT,
                    self.profile_path,
                    self.allowlist_path,
                    SUBJECT_COMMIT,
                    SUBJECT_TREE,
                )
        self.assertEqual(swaps, 1)
        self.assertEqual(receipt_path.read_bytes(), extra_receipt)

    def test_unsafe_recursive_cleanup_retains_owned_directory(self) -> None:
        output = self.root / "cleanup-probe-output"
        staging, token = archiver._create_owned_staging(output)
        canary = staging / "canary.txt"
        canary.write_text("keep", encoding="utf-8")
        with mock.patch.object(
            shutil.rmtree,
            "avoids_symlink_attacks",
            False,
        ):
            with self.assertRaisesRegex(archiver.ArchiveError, "retained"):
                archiver._cleanup_owned_directory(staging, self.root, token)
        self.assertEqual(canary.read_text(encoding="utf-8"), "keep")

    def test_atomic_publication_refuses_existing_target(self) -> None:
        source = self.root / "rename-source"
        target = self.root / "rename-target"
        source.mkdir()
        target.mkdir()
        canary = target / "canary.txt"
        canary.write_text("keep", encoding="utf-8")
        with self.assertRaises((OSError, archiver.ArchiveError)):
            archiver._rename_directory_noreplace(source, target)
        self.assertTrue(source.is_dir())
        self.assertEqual(canary.read_text(encoding="utf-8"), "keep")

    def test_receipt_subject_json_type_confusion_is_rejected(self) -> None:
        original = json.loads(
            (self.archive_a / archiver.ARCHIVE_RECEIPT_NAME).read_text(encoding="utf-8")
        )
        variants = {
            "commit-int": ("subject_commit", 1),
            "tree-list": ("subject_tree", []),
            "verified-int": ("subject_binding_verified", 1),
            "verified-string": ("subject_binding_verified", "true"),
        }
        for label, (field, replacement) in variants.items():
            with self.subTest(label=label):
                receipt = json.loads(json.dumps(original))
                receipt[field] = replacement
                bad_receipt = self.root / f"subject-type-confusion-{label}.json"
                bad_receipt.write_bytes(archiver._canonical_json_bytes(receipt))
                output = self.root / f"subject-type-confusion-output-{label}"
                with self.assertRaisesRegex(
                    archiver.ArchiveError, f"subject drifted at {field}"
                ):
                    archiver.verify_extract_archive(
                        self.archive_a / archiver.ARCHIVE_NAME,
                        bad_receipt,
                        output,
                        self.identity_file,
                        REPO_ROOT,
                        self.profile_path,
                        self.allowlist_path,
                        SUBJECT_COMMIT,
                        SUBJECT_TREE,
                    )
                self.assertFalse(output.exists())

    def test_receipt_json_type_confusion_is_rejected_before_publication(self) -> None:
        original = json.loads(
            (self.archive_a / archiver.ARCHIVE_RECEIPT_NAME).read_text(encoding="utf-8")
        )
        variants = {
            "schema-bool": ("schema_version", True),
            "claim-int": ("claims.final_archive", 0),
            "member-count-float": (
                "archive.member_count",
                float(original["archive"]["member_count"]),
            ),
        }
        verification_result = self._valid_verification_result()
        with mock.patch.object(
            archiver.claim_verifier,
            "verify_claim_complete",
            return_value=verification_result,
        ) as verify_mock:
            for label, (field, value) in variants.items():
                with self.subTest(label=label):
                    receipt = json.loads(json.dumps(original))
                    target = receipt
                    parts = field.split(".")
                    for part in parts[:-1]:
                        target = target[part]
                    target[parts[-1]] = value
                    bad_receipt = self.root / f"type-confusion-{label}.json"
                    bad_receipt.write_bytes(archiver._canonical_json_bytes(receipt))
                    output = self.root / f"type-confusion-output-{label}"
                    with self.assertRaisesRegex(
                        archiver.ArchiveError, "fully recomputed receipt"
                    ):
                        archiver.verify_extract_archive(
                            self.archive_a / archiver.ARCHIVE_NAME,
                            bad_receipt,
                            output,
                            self.identity_file,
                            REPO_ROOT,
                            self.profile_path,
                            self.allowlist_path,
                            SUBJECT_COMMIT,
                            SUBJECT_TREE,
                        )
                    self.assertFalse(output.exists())
                    retained = [
                        path
                        for path in self.root.iterdir()
                        if path.name.startswith(f".{output.name}.staging-")
                    ]
                    if shutil.rmtree.avoids_symlink_attacks:
                        self.assertEqual(retained, [])
                    else:
                        self.assertEqual(len(retained), 1)
                        self.assertTrue(
                            (retained[0] / archiver.OWNER_MARKER_NAME).is_file()
                        )
        self.assertEqual(verify_mock.call_count, len(variants))


class OwnedStagingMkdirTests(unittest.TestCase):
    def test_windows_staging_inherits_the_trusted_parent_acl(self) -> None:
        staging = Path("unused-windows-staging")
        with mock.patch.object(type(staging), "mkdir", autospec=True) as mkdir:
            with mock.patch.object(archiver.os, "name", "nt"):
                archiver._mkdir_owned_staging(staging)
        mkdir.assert_called_once_with(staging)

    def test_posix_staging_requests_owner_only_mode(self) -> None:
        staging = Path("unused-posix-staging")
        with mock.patch.object(type(staging), "mkdir", autospec=True) as mkdir:
            with mock.patch.object(archiver.os, "name", "posix"):
                archiver._mkdir_owned_staging(staging)
        mkdir.assert_called_once_with(staging, mode=0o700)


if __name__ == "__main__":
    unittest.main(verbosity=2)
