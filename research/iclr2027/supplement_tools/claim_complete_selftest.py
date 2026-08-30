from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import unittest
import uuid
from dataclasses import replace
from pathlib import Path, PurePosixPath


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[2]
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import build_supplement_candidate as builder  # noqa: E402
import derive_claim_complete_payload as derivation  # noqa: E402
import verify_claim_complete as verifier  # noqa: E402


FORMAL_EXCEPTIONS = {
    "research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json",
    "research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv",
    "research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv",
    "research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv",
    "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv",
    "research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl",
    "research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json",
    "research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl",
}
CHECKPOINT_EXCEPTIONS = {
    "research/iclr2027/lifeline_rl/alphazero/checkpoint.py",
    "research/iclr2027/tests/test_alphazero_checkpoint.py",
}


def _file_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


class ClaimCompleteSelfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = TOOL_DIR / (
            f"_claim_complete_selftest_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        )
        cls.profile_path = TOOL_DIR / "claim_complete_profile.json"
        cls.allowlist_path = TOOL_DIR / "supplement_claim_complete_allowlist.json"
        cls.identity_file = cls.root / "dummy_identity.json"
        cls.staging_a = cls.root / "staging-a"
        cls.staging_b = cls.root / "staging-b"
        cls.candidate = cls.root / "candidate"
        cls.root.mkdir()
        cls.identity_file.write_text(
            json.dumps(["SELFTEST_ONLY_PRIVATE_IDENTITY_998877"]),
            encoding="utf-8",
        )
        try:
            cls.first_derivation = derivation.derive_payload(
                REPO_ROOT,
                cls.profile_path,
                cls.staging_a,
                cls.allowlist_path,
            )
            cls.second_derivation = derivation.derive_payload(
                REPO_ROOT,
                cls.profile_path,
                cls.staging_b,
                cls.allowlist_path,
            )
            cls.build_result = builder.build_candidate(
                cls.staging_a,
                cls.allowlist_path,
                cls.candidate,
                cls.identity_file,
            )
            cls.profile = derivation._load_profile(cls.profile_path)
        except Exception:
            cls._remove_root()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls._remove_root()

    @classmethod
    def _remove_root(cls) -> None:
        root = getattr(cls, "root", None)
        if root is None or not root.exists():
            return
        if (
            root.parent != TOOL_DIR
            or not root.name.startswith("_claim_complete_selftest_")
        ):
            raise RuntimeError("refusing unsafe claim-complete self-test cleanup target")
        shutil.rmtree(root)

    def _candidate_copy(self, name: str) -> Path:
        destination = self.root / name
        shutil.copytree(self.candidate, destination)
        return destination

    def _write_profile(self, name: str, value: object) -> Path:
        path = self.root / name
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return path

    def _write_allowlist(self, name: str, value: object) -> Path:
        path = self.root / name
        path.write_bytes(derivation._canonical_json_bytes(value))
        return path

    def test_end_to_end_dual_derivation_build_and_verify(self) -> None:
        self.assertEqual(self.first_derivation["status"], "PASS")
        self.assertEqual(self.second_derivation["status"], "PASS")
        self.assertEqual(self.first_derivation["staged_file_count"], 115)
        self.assertEqual(self.first_derivation["staged_total_bytes"], 3_186_772)
        self.assertEqual(_file_bytes(self.staging_a), _file_bytes(self.staging_b))
        self.assertEqual(self.build_result["status"], "PASS")
        self.assertEqual(self.build_result["file_count"], 119)

        result = verifier.verify_claim_complete(
            self.candidate,
            self.identity_file,
            REPO_ROOT,
            self.profile_path,
            self.allowlist_path,
        )
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["claim_coverage"], list(derivation.CLAIM_IDS))
        self.assertEqual(result["compact_receipts"], 330)
        self.assertEqual(
            result["source_regeneration"],
            "PASS_TWO_BYTE_IDENTICAL_DERIVATIONS",
        )
        self.assertTrue(result["game_engine_byte_identical"])
        self.assertTrue(result["later_extension_labels_absent"])

        readme = (self.candidate / builder.README_NAME).read_text(encoding="utf-8")
        self.assertIn(builder.STATUS, readme)
        self.assertIn("author approval is required", readme)
        self.assertIn("no clean-install execution is", readme)
        self.assertIn("not author approval", readme)

    def test_default_narrow_allowlist_routing_is_unchanged(self) -> None:
        narrow_path = TOOL_DIR / "supplement_allowlist.json"
        self.assertEqual(builder._default_allowlist(), narrow_path)
        self.assertEqual(derivation._default_allowlist(), self.allowlist_path)
        narrow = builder.load_allowlist(narrow_path)
        claim_complete = builder.load_allowlist(self.allowlist_path)
        self.assertEqual(narrow.package_name, "lifeline_rl_supplement_candidate")
        self.assertEqual(
            claim_complete.package_name,
            "lifeline_rl_claim_complete_candidate",
        )
        self.assertTrue(narrow.require_git_tracked)
        self.assertFalse(claim_complete.require_git_tracked)
        self.assertFalse(
            any(
                entry.source.startswith(derivation.DERIVED_PREFIX)
                for entry in narrow.files
            )
        )

    def test_unicode_repo_source_maps_to_ascii_candidate_path(self) -> None:
        entries = [
            entry for entry in self.profile.entries if entry.mode == "game_engine_copy"
        ]
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.inputs[0][0], "web/web前端/GameEngine.js")
        self.assertFalse(entry.inputs[0][0].isascii())
        self.assertEqual(entry.destination, "web/GameEngine.js")
        self.assertTrue(entry.destination.isascii())
        source = REPO_ROOT.joinpath(*PurePosixPath(entry.inputs[0][0]).parts)
        candidate = self.candidate.joinpath(*PurePosixPath(entry.destination).parts)
        self.assertEqual(source.read_bytes(), candidate.read_bytes())

        trace_entry = next(
            item for item in self.profile.entries if item.mode == "reference_trace"
        )
        trace = self.candidate.joinpath(
            *PurePosixPath(trace_entry.destination).parts
        ).read_text(encoding="utf-8")
        self.assertIn("../../../web/GameEngine.js", trace)
        self.assertNotIn("../../../web/web前端/GameEngine.js", trace)

    def test_formal_result_exceptions_are_exact(self) -> None:
        self.assertEqual(
            set(builder.CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS),
            FORMAL_EXCEPTIONS,
        )
        self.assertEqual(
            set(builder.CLAIM_COMPLETE_FORMAL_DESTINATION_EXCEPTIONS),
            FORMAL_EXCEPTIONS,
        )
        profile_sources = {
            entry.source
            for entry in self.profile.entries
            if entry.source.startswith("research/iclr2027/results/formal/")
        }
        self.assertEqual(profile_sources, FORMAL_EXCEPTIONS)
        formal_inputs, _checkpoint_inputs = derivation._special_input_paths(
            self.profile.entries
        )
        self.assertEqual(
            formal_inputs,
            set(derivation.CLAIM_COMPLETE_FORMAL_INPUT_EXCEPTIONS),
        )

        for label in ("source", "destination"):
            for path in sorted(FORMAL_EXCEPTIONS):
                with self.subTest(label=label, exact=path):
                    builder._check_artifact_policy(path, label)
                pure = PurePosixPath(path)
                neighbour = (pure.parent / f"nearby_{pure.name}").as_posix()
                with self.subTest(label=label, neighbour=neighbour):
                    with self.assertRaises(builder.CandidateError):
                        builder._check_artifact_policy(neighbour, label)

        entry = next(item for item in self.profile.entries if item.mode == "claim_ledger")
        extra = (
            "research/iclr2027/results/formal/d14_d16/run_v1/nearby_receipts.jsonl",
            "f" * 64,
        )
        mutated_entry = replace(entry, inputs=entry.inputs + (extra,))
        mutated_profile = replace(
            self.profile,
            entries=tuple(
                mutated_entry if item is entry else item for item in self.profile.entries
            ),
        )
        with self.assertRaisesRegex(verifier.VerificationError, "exact ten"):
            verifier._verify_exact_special_sources(mutated_profile)

    def test_checkpoint_exceptions_are_exact(self) -> None:
        self.assertEqual(
            set(builder.CLAIM_COMPLETE_CHECKPOINT_EXCEPTIONS["source"]),
            CHECKPOINT_EXCEPTIONS,
        )
        self.assertEqual(
            set(builder.CLAIM_COMPLETE_CHECKPOINT_EXCEPTIONS["destination"]),
            CHECKPOINT_EXCEPTIONS,
        )
        profile_sources = {
            entry.source
            for entry in self.profile.entries
            if "checkpoint" in PurePosixPath(entry.source).name.casefold()
        }
        self.assertEqual(profile_sources, CHECKPOINT_EXCEPTIONS)
        _formal_inputs, checkpoint_inputs = derivation._special_input_paths(
            self.profile.entries
        )
        self.assertEqual(
            checkpoint_inputs,
            set(derivation.CLAIM_COMPLETE_CHECKPOINT_INPUT_EXCEPTIONS),
        )

        for label in ("source", "destination"):
            for path in sorted(CHECKPOINT_EXCEPTIONS):
                with self.subTest(label=label, exact=path):
                    builder._check_artifact_policy(path, label)
                pure = PurePosixPath(path)
                neighbour = pure.with_name(f"{pure.stem}_nearby.py").as_posix()
                with self.subTest(label=label, neighbour=neighbour):
                    with self.assertRaises(builder.CandidateError):
                        builder._check_artifact_policy(neighbour, label)

        entry = next(item for item in self.profile.entries if item.mode == "claim_ledger")
        extra = (
            "research/iclr2027/lifeline_rl/alphazero/checkpoint_nearby.py",
            "f" * 64,
        )
        mutated_entry = replace(entry, inputs=entry.inputs + (extra,))
        mutated_profile = replace(
            self.profile,
            entries=tuple(
                mutated_entry if item is entry else item for item in self.profile.entries
            ),
        )
        with self.assertRaisesRegex(verifier.VerificationError, "exact two"):
            verifier._verify_exact_special_sources(mutated_profile)

    def test_later_extension_labels_are_rejected(self) -> None:
        clean = self.root / "later-label-clean"
        clean.mkdir()
        (clean / "safe.txt").write_text(
            "no later extension label is present\n",
            encoding="utf-8",
        )
        verifier._verify_no_extension_labels(clean)
        for index, label in enumerate(("D17", "D18", "D19", "d17", "d18", "d19")):
            directory = self.root / f"later-label-{index}"
            directory.mkdir()
            (directory / "payload.txt").write_text(
                f"prohibited experiment {label}\n",
                encoding="utf-8",
            )
            with self.subTest(label=label):
                with self.assertRaises(verifier.VerificationError):
                    verifier._verify_no_extension_labels(directory)

    def test_unknown_profile_field_is_rejected(self) -> None:
        value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        value["unknown_selftest_field"] = True
        path = self._write_profile("unknown-profile-field.json", value)
        with self.assertRaisesRegex(derivation.DerivationError, "unknown"):
            derivation._load_profile(path)

    def test_windows_path_and_casefold_collisions_are_rejected(self) -> None:
        unsafe_paths = (
            "CON.json",
            "safe/NUL.txt",
            "safe/AUX.md",
            "safe/PRN",
            "safe/COM1.txt",
            "safe/LPT9.py",
            "safe./payload.txt",
            "safe/payload.",
            "safe/payload.txt ",
            "safe/payload.txt:stream",
        )
        for unsafe in unsafe_paths:
            with self.subTest(loader="allowlist", path=unsafe):
                with self.assertRaises(builder.CandidateError):
                    builder._safe_relative_path(unsafe, "selftest path")
            with self.subTest(loader="profile-input", path=unsafe):
                with self.assertRaises(derivation.DerivationError):
                    derivation._safe_repo_relative_path(unsafe, "selftest path")

        profile_value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        ordinary_copy_rows = [
            row
            for row in profile_value["files"]
            if row["mode"] == "copy"
            and not row["source"].startswith(derivation.FORMAL_INPUT_PREFIX)
            and "checkpoint" not in PurePosixPath(row["source"]).name.casefold()
        ]
        self.assertGreaterEqual(len(ordinary_copy_rows), 2)

        for safe in ("COM10.txt", "LPT0.py", "CONSOLE.json", "safe/payload.txt"):
            with self.subTest(loader="allowlist-positive", path=safe):
                self.assertEqual(builder._safe_relative_path(safe, "selftest path"), safe)
            with self.subTest(loader="profile-input-positive", path=safe):
                self.assertEqual(
                    derivation._safe_repo_relative_path(safe, "selftest path"), safe
                )

        source_collision = json.loads(
            self.profile_path.read_text(encoding="utf-8")
        )
        source_rows = [
            row
            for row in source_collision["files"]
            if row["mode"] == "copy"
            and not row["source"].startswith(derivation.FORMAL_INPUT_PREFIX)
            and "checkpoint" not in PurePosixPath(row["source"]).name.casefold()
        ]
        source_rows[1]["source"] = source_rows[0]["source"].upper()
        source_rows[1]["inputs"][0]["path"] = source_rows[1]["source"]
        profile_path = self._write_profile("profile-source-casefold.json", source_collision)
        with self.assertRaisesRegex(derivation.DerivationError, "unique"):
            derivation._load_profile(profile_path)

        destination_collision = json.loads(
            self.profile_path.read_text(encoding="utf-8")
        )
        destination_rows = [
            row
            for row in destination_collision["files"]
            if row["mode"] == "copy"
            and not row["source"].startswith(derivation.FORMAL_INPUT_PREFIX)
            and "checkpoint" not in PurePosixPath(row["source"]).name.casefold()
        ]
        destination_rows[1]["destination"] = destination_rows[0][
            "destination"
        ].upper()
        profile_path = self._write_profile(
            "profile-destination-casefold.json", destination_collision
        )
        with self.assertRaisesRegex(derivation.DerivationError, "unique"):
            derivation._load_profile(profile_path)

        allowlist_value = json.loads(self.allowlist_path.read_text(encoding="utf-8"))
        allowlist_value["files"][1]["source"] = allowlist_value["files"][0][
            "source"
        ].upper()
        allowlist_path = self._write_allowlist(
            "allowlist-source-casefold.json", allowlist_value
        )
        with self.assertRaisesRegex(builder.CandidateError, "duplicate source"):
            builder.load_allowlist(allowlist_path)

        allowlist_value = json.loads(self.allowlist_path.read_text(encoding="utf-8"))
        allowlist_value["files"][1]["destination"] = allowlist_value["files"][0][
            "destination"
        ].upper()
        allowlist_path = self._write_allowlist(
            "allowlist-destination-casefold.json", allowlist_value
        )
        with self.assertRaisesRegex(builder.CandidateError, "duplicate or reserved"):
            builder.load_allowlist(allowlist_path)

        allowlist_value = json.loads(self.allowlist_path.read_text(encoding="utf-8"))
        allowlist_value["files"][0]["destination"] = "readme.md"
        allowlist_path = self._write_allowlist(
            "allowlist-metadata-casefold.json", allowlist_value
        )
        with self.assertRaisesRegex(builder.CandidateError, "reserved destination"):
            builder.load_allowlist(allowlist_path)

        descriptive_collision = json.loads(
            self.profile_path.read_text(encoding="utf-8")
        )
        descriptive_collision["descriptive_only_destinations"].append(
            descriptive_collision["descriptive_only_destinations"][0].upper()
        )
        profile_path = self._write_profile(
            "profile-descriptive-casefold.json", descriptive_collision
        )
        with self.assertRaisesRegex(derivation.DerivationError, "duplicates"):
            derivation._load_profile(profile_path)

    def test_required_derived_modes_are_exactly_once(self) -> None:
        value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        row = next(item for item in value["files"] if item["mode"] == "reference_trace")
        row["mode"] = "game_engine_copy"
        path = self._write_profile("derived-mode-count-drift.json", value)
        with self.assertRaisesRegex(derivation.DerivationError, "exactly once"):
            derivation._load_profile(path)

        value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        row = next(item for item in value["files"] if item["mode"] == "reference_trace")
        row["mode"] = []
        path = self._write_profile("derived-mode-type-drift.json", value)
        with self.assertRaisesRegex(derivation.DerivationError, "unsupported"):
            derivation._load_profile(path)

    def test_claim_allowlist_contract_and_canonical_bytes_are_fixed(self) -> None:
        raw = self.allowlist_path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
        self.assertEqual(raw, derivation._canonical_json_bytes(value))
        config, observed = derivation._load_allowlist_shape(self.allowlist_path)
        self.assertEqual(observed, raw)
        derivation._validate_allowlist_shape(self.profile, config)

        mutations = {
            "package": ("package_name", "lifeline_rl_claim_complete_candidate_v2"),
            "purpose": ("purpose", "different but syntactically valid purpose"),
        }
        for label, (key, replacement) in mutations.items():
            mutated = json.loads(raw.decode("utf-8"))
            mutated[key] = replacement
            path = self._write_allowlist(f"allowlist-{label}-drift.json", mutated)
            loaded, _bytes = derivation._load_allowlist_shape(path)
            with self.subTest(label=label):
                with self.assertRaisesRegex(derivation.DerivationError, "drifted"):
                    derivation._validate_allowlist_shape(self.profile, loaded)

        mutated = json.loads(raw.decode("utf-8"))
        mutated["limits"]["max_file_bytes"] += 1
        path = self._write_allowlist("allowlist-limits-drift.json", mutated)
        loaded, _bytes = derivation._load_allowlist_shape(path)
        with self.assertRaisesRegex(derivation.DerivationError, "limits drifted"):
            derivation._validate_allowlist_shape(self.profile, loaded)

        mutated = json.loads(raw.decode("utf-8"))
        mutated["limits"]["max_total_bytes"] += 1
        path = self._write_allowlist("allowlist-total-limit-drift.json", mutated)
        loaded, _bytes = derivation._load_allowlist_shape(path)
        with self.assertRaisesRegex(derivation.DerivationError, "limits drifted"):
            derivation._validate_allowlist_shape(self.profile, loaded)

        mutated = json.loads(raw.decode("utf-8"))
        mutated["require_git_tracked"] = True
        path = self._write_allowlist("allowlist-git-policy-drift.json", mutated)
        loaded, _bytes = derivation._load_allowlist_shape(path)
        with self.assertRaisesRegex(derivation.DerivationError, "false"):
            derivation._validate_allowlist_shape(self.profile, loaded)

        crlf_path = self.root / "allowlist-crlf.json"
        crlf_path.write_bytes(raw.replace(b"\n", b"\r\n"))
        with self.assertRaisesRegex(derivation.DerivationError, "canonical"):
            derivation._load_allowlist_shape(crlf_path)

        extra_newline_path = self.root / "allowlist-extra-newline.json"
        extra_newline_path.write_bytes(raw + b"\n")
        with self.assertRaisesRegex(derivation.DerivationError, "canonical"):
            derivation._load_allowlist_shape(extra_newline_path)

        bom_path = self.root / "allowlist-bom.json"
        bom_path.write_bytes(b"\xef\xbb\xbf" + raw)
        with self.assertRaises(derivation.DerivationError):
            derivation._load_allowlist_shape(bom_path)

        nan_path = self.root / "allowlist-nan.json"
        nan_path.write_bytes(
            raw.replace(b'"max_file_bytes": 1048576', b'"max_file_bytes": NaN')
        )
        with self.assertRaises(derivation.DerivationError):
            derivation._load_allowlist_shape(nan_path)

    def test_bootstrap_mode_requires_output_and_is_not_pass(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            return_code = derivation.main(
                [
                    "--source-root",
                    str(REPO_ROOT),
                    "--profile",
                    str(self.profile_path),
                    "--output",
                    str(self.root / "bootstrap-missing-output-stage"),
                    "--without-allowlist-check",
                ]
            )
        self.assertEqual(return_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        failure = json.loads(stderr.getvalue())
        self.assertEqual(failure["status"], "FAIL")
        self.assertIn("bootstrap", failure["error"])

        staging = self.root / "bootstrap-only-stage"
        observed_allowlist = self.root / "bootstrap-only-allowlist.json"
        result = derivation.derive_payload(
            REPO_ROOT,
            self.profile_path,
            staging,
            None,
            observed_allowlist,
        )
        self.assertEqual(result["status"], "BOOTSTRAP_ONLY")
        self.assertEqual(
            result["allowlist_validation"], "BOOTSTRAP_ONLY_NOT_HASH_PINNED"
        )
        self.assertIsNone(result["allowlist_sha256"])
        self.assertTrue(observed_allowlist.is_file())

        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            return_code = derivation.main(
                [
                    "--source-root",
                    str(REPO_ROOT),
                    "--profile",
                    str(self.profile_path),
                    "--output",
                    str(self.root / "bootstrap-cli-stage"),
                    "--without-allowlist-check",
                    "--bootstrap-allowlist-output",
                    str(self.root / "bootstrap-cli-allowlist.json"),
                ]
            )
        self.assertEqual(return_code, 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(json.loads(stdout.getvalue())["status"], "BOOTSTRAP_ONLY")

    def test_verify_cli_business_failure_is_stderr_json(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            return_code = verifier.main(
                [
                    "--candidate",
                    str(self.root / "missing-candidate"),
                    "--identity-file",
                    str(self.identity_file),
                    "--source-root",
                    str(REPO_ROOT),
                    "--profile",
                    str(self.profile_path),
                    "--allowlist",
                    str(self.allowlist_path),
                ]
            )
        self.assertEqual(return_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        failure = json.loads(stderr.getvalue())
        self.assertEqual(failure["status"], "FAIL")

    def test_malformed_transform_and_semantic_rows_use_domain_errors(self) -> None:
        transform_cases = (
            (derivation._superko_config, b"[]"),
            (derivation._superko_config, b"{}"),
            (derivation._superko_verification, b"[]"),
            (derivation._environment_receipt, b"[]"),
            (derivation._compact_ledger, b"[]\n"),
        )
        for function, data in transform_cases:
            with self.subTest(transform=function.__name__):
                with self.assertRaises(derivation.DerivationError):
                    function(data)

        source_by_mode = {
            entry.mode: REPO_ROOT.joinpath(
                *PurePosixPath(entry.inputs[0][0]).parts
            ).read_bytes()
            for entry in self.profile.entries
            if entry.mode
            in {"superko_config", "superko_verification", "environment_receipt"}
        }
        superko_config = json.loads(source_by_mode["superko_config"].decode("utf-8"))
        superko_config.pop("attempt2_preflight")
        with self.assertRaises(derivation.DerivationError):
            derivation._superko_config(derivation._canonical_json_bytes(superko_config))

        superko_config = json.loads(source_by_mode["superko_config"].decode("utf-8"))
        superko_config["checkpoint"].pop("path")
        with self.assertRaises(derivation.DerivationError):
            derivation._superko_config(derivation._canonical_json_bytes(superko_config))

        superko_verification = json.loads(
            source_by_mode["superko_verification"].decode("utf-8")
        )
        superko_verification.pop("claim_boundary")
        with self.assertRaises(derivation.DerivationError):
            derivation._superko_verification(
                derivation._canonical_json_bytes(superko_verification)
            )

        environment = json.loads(source_by_mode["environment_receipt"].decode("utf-8"))
        environment.pop("observed")
        with self.assertRaises(derivation.DerivationError):
            derivation._environment_receipt(
                derivation._canonical_json_bytes(environment)
            )

        claim_candidate = self._candidate_copy("malformed-claim-row")
        claim_entry = next(
            item for item in self.profile.entries if item.mode == "claim_ledger"
        )
        claim_path = claim_candidate.joinpath(
            *PurePosixPath(claim_entry.destination).parts
        )
        claim_value = json.loads(claim_path.read_text(encoding="utf-8"))
        claim_value["claims"][0] = []
        claim_path.write_bytes(derivation._canonical_json_bytes(claim_value))
        with self.assertRaises(verifier.VerificationError):
            verifier._verify_claim_ledger(claim_candidate, claim_entry)

        receipt_candidate = self._candidate_copy("malformed-compact-row")
        receipt_entry = next(
            item for item in self.profile.entries if item.mode == "compact_ledger"
        )
        receipt_path = receipt_candidate.joinpath(
            *PurePosixPath(receipt_entry.destination).parts
        )
        lines = receipt_path.read_bytes().splitlines()
        lines[0] = b"[]"
        receipt_path.write_bytes(b"\n".join(lines) + b"\n")
        with self.assertRaises(verifier.VerificationError):
            verifier._verify_compact_ledger(receipt_candidate, receipt_entry)

    def test_transform_input_paths_are_strict_repo_relative(self) -> None:
        value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        row_index = next(
            index
            for index, item in enumerate(value["files"])
            if item["mode"] not in {"copy", "derivation_receipt"}
        )
        cases = {
            "ads": "a:b/x",
            "drive": "C:/x",
            "unc": "//server/share",
            "leading-dot": "./x",
            "parent": "a/../x",
            "middle-dot": "a/./x",
            "format-control": "a/\u200b/x",
            "control": "a/\u0001/x",
        }
        for label, unsafe in cases.items():
            mutated = json.loads(self.profile_path.read_text(encoding="utf-8"))
            mutated["files"][row_index]["inputs"][0]["path"] = unsafe
            path = self._write_profile(f"unsafe-input-{label}.json", mutated)
            with self.subTest(label=label, path=unsafe):
                with self.assertRaises(derivation.DerivationError):
                    derivation._load_profile(path)

        valid = "web/web前端/GameEngine.js"
        self.assertEqual(
            derivation._read_repo_file(REPO_ROOT, valid),
            REPO_ROOT.joinpath(*PurePosixPath(valid).parts).read_bytes(),
        )

    def test_extra_formal_or_checkpoint_transform_input_is_rejected(self) -> None:
        cases = {
            "formal": (
                "research/iclr2027/results/formal/d14_d16/run_v1/nearby_receipts.jsonl",
                "exact ten",
            ),
            "checkpoint": (
                "research/iclr2027/lifeline_rl/alphazero/checkpoint_nearby.py",
                "exact two",
            ),
        }
        for label, (extra, message) in cases.items():
            value = json.loads(self.profile_path.read_text(encoding="utf-8"))
            row = next(item for item in value["files"] if item["mode"] == "claim_ledger")
            row["inputs"].append(
                {"path": extra, "expected_sha256": "f" * 64}
            )
            path = self._write_profile(f"extra-special-input-{label}.json", value)
            with self.subTest(label=label):
                with self.assertRaisesRegex(derivation.DerivationError, message):
                    derivation._load_profile(path)

    def test_transform_source_hash_drift_is_rejected(self) -> None:
        value = json.loads(self.profile_path.read_text(encoding="utf-8"))
        row = next(
            item
            for item in value["files"]
            if item["mode"] not in {"copy", "derivation_receipt"}
        )
        row["inputs"][0]["expected_sha256"] = "f" * 64
        path = self._write_profile("source-hash-drift.json", value)
        with self.assertRaisesRegex(derivation.DerivationError, "hash drifted"):
            derivation.derive_payload(
                REPO_ROOT,
                path,
                self.root / "source-hash-drift-output",
                None,
                self.root / "source-hash-drift-bootstrap.json",
            )

    def test_allowlist_payload_hash_drift_is_rejected(self) -> None:
        value = json.loads(self.allowlist_path.read_text(encoding="utf-8"))
        value["files"][0]["expected_sha256"] = "f" * 64
        path = self.root / "allowlist-hash-drift.json"
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(builder.CandidateError, "hash drifted"):
            builder.build_candidate(
                self.staging_a,
                path,
                self.root / "allowlist-hash-drift-candidate",
                self.identity_file,
            )

    def test_staging_and_candidate_overwrite_are_rejected(self) -> None:
        staging = self.root / "existing-staging"
        staging.mkdir()
        staging_sentinel = staging / "sentinel.txt"
        staging_sentinel.write_text("preserve staging\n", encoding="utf-8")
        with self.assertRaisesRegex(derivation.DerivationError, "overwrite"):
            derivation.derive_payload(
                REPO_ROOT,
                self.profile_path,
                staging,
                self.allowlist_path,
            )
        self.assertEqual(
            staging_sentinel.read_text(encoding="utf-8"),
            "preserve staging\n",
        )

        candidate = self.root / "existing-candidate"
        candidate.mkdir()
        candidate_sentinel = candidate / "sentinel.txt"
        candidate_sentinel.write_text("preserve candidate\n", encoding="utf-8")
        with self.assertRaisesRegex(builder.CandidateError, "overwrite"):
            builder.build_candidate(
                self.staging_a,
                self.allowlist_path,
                candidate,
                self.identity_file,
            )
        self.assertEqual(
            candidate_sentinel.read_text(encoding="utf-8"),
            "preserve candidate\n",
        )

    def test_candidate_payload_tamper_and_extra_file_are_rejected(self) -> None:
        tampered = self._candidate_copy("tampered-candidate")
        first_destination = self.profile.entries[0].destination
        target = tampered.joinpath(*PurePosixPath(first_destination).parts)
        target.write_bytes(target.read_bytes() + b"\nselftest tamper\n")
        with self.assertRaises(builder.CandidateError):
            verifier.verify_claim_complete(
                tampered,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
            )

        extra = self._candidate_copy("extra-file-candidate")
        (extra / "unexpected.txt").write_text("unexpected\n", encoding="utf-8")
        with self.assertRaises(builder.CandidateError):
            verifier.verify_claim_complete(
                extra,
                self.identity_file,
                REPO_ROOT,
                self.profile_path,
                self.allowlist_path,
            )

    def test_identity_hit_is_rejected_without_disclosing_the_term(self) -> None:
        term = "author approval is required"
        identity = self.root / "matching-identity.json"
        identity.write_text(json.dumps([term]), encoding="utf-8")
        with self.assertRaises(builder.CandidateError) as caught:
            builder.verify_candidate(self.candidate, self.allowlist_path, identity)
        self.assertIn("private_identity_term_1", str(caught.exception))
        self.assertNotIn(term, str(caught.exception))

    def test_bom_and_path_scanner_boundaries(self) -> None:
        identity = builder.load_identity_profile(self.identity_file)

        leading_bom = builder._scan_documents(
            [("leading-bom.txt", "\ufeffsafe\n".encode())],
            identity,
        )
        self.assertEqual(leading_bom["status"], "PASS")

        for label, text in (
            ("middle-bom", "safe\ufeffunsafe\n"),
            ("zero-width", "safe\u200bunsafe\n"),
        ):
            with self.subTest(label=label):
                scan = builder._scan_documents(
                    [(f"{label}.txt", text.encode())],
                    identity,
                )
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "unicode_format_control"
                        for finding in scan["findings"]
                    )
                )

        escaped_relative = builder._scan_documents(
            [("relative.txt", b".\\research\\iclr2027\\safe.txt\n")],
            identity,
        )
        self.assertEqual(escaped_relative["status"], "PASS")
        for label, data in (
            ("drive", b"C:\\private\\file.txt\n"),
            ("unc", b"\\\\server\\share\\file.txt\n"),
        ):
            with self.subTest(label=label):
                scan = builder._scan_documents(
                    [(f"{label}.txt", data)],
                    identity,
                )
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "windows_absolute_path"
                        for finding in scan["findings"]
                    )
                )

    def test_transform_contract_rejects_input_mutation_and_redirection(self) -> None:
        for label in (
            "prepend-input",
            "append-input",
            "swap-inputs",
            "redirect-source",
            "redirect-destination",
        ):
            value = json.loads(self.profile_path.read_text(encoding="utf-8"))

            def row(mode: str) -> dict[str, object]:
                return next(item for item in value["files"] if item["mode"] == mode)

            if label in {"prepend-input", "append-input"}:
                extra = {"path": "README.md", "expected_sha256": "f" * 64}
                inputs = row("reference_trace")["inputs"]
                self.assertIsInstance(inputs, list)
                if label == "prepend-input":
                    inputs.insert(0, extra)
                else:
                    inputs.append(extra)
            elif label == "swap-inputs":
                compact = row("compact_ledger")
                status = row("ledger_status")
                compact["inputs"], status["inputs"] = (
                    status["inputs"],
                    compact["inputs"],
                )
            elif label == "redirect-source":
                row("reference_trace")["source"] = (
                    derivation.DERIVED_PREFIX + "redirected_reference_trace.mjs"
                )
            else:
                row("reference_trace")["destination"] = (
                    "research/iclr2027/scripts/redirected_reference_trace.mjs"
                )

            path = self._write_profile(f"transform-contract-{label}.json", value)
            with self.subTest(label=label):
                with self.assertRaises(derivation.DerivationError):
                    derivation._load_profile(path)

    def test_nonfinite_and_duplicate_projected_receipt_fields_are_rejected(
        self,
    ) -> None:
        entry = next(
            item for item in self.profile.entries if item.mode == "compact_ledger"
        )
        source_path = REPO_ROOT.joinpath(*PurePosixPath(entry.inputs[0][0]).parts)
        source_lines = source_path.read_bytes().splitlines()
        self.assertEqual(len(source_lines), 330)
        self.assertTrue(source_lines[0].endswith(b"}"))
        self.assertEqual(
            json.loads(source_lines[0].decode("utf-8"))["status"], "complete"
        )

        def inject(line: bytes, members: bytes) -> bytes:
            self.assertTrue(line.endswith(b"}"))
            return line[:-1] + b"," + members + b"}"

        valid_lines = list(source_lines)
        valid_lines[0] = inject(
            valid_lines[0], b'"selftest_projected_away":"safe"'
        )
        compact, _details = derivation._compact_ledger(
            b"\n".join(valid_lines) + b"\n"
        )
        compact_first = derivation._strict_json_loads(
            compact.splitlines()[0], "self-test compact receipt"
        )
        self.assertNotIn("selftest_projected_away", compact_first)

        attacks = {
            "nan": b'"selftest_projected_away":NaN',
            "infinity": b'"selftest_projected_away":Infinity',
            "negative-infinity": b'"selftest_projected_away":-Infinity',
            "overflowing-exponent": b'"selftest_projected_away":1e999',
            "duplicate-retained-key": b'"status":"complete"',
            "duplicate-projected-key": (
                b'"selftest_projected_away":"first",'
                b'"selftest_projected_away":"second"'
            ),
        }
        for label, members in attacks.items():
            mutated_lines = list(source_lines)
            mutated_lines[0] = inject(mutated_lines[0], members)
            with self.subTest(stage="derivation", label=label):
                with self.assertRaises(derivation.DerivationError):
                    derivation._compact_ledger(b"\n".join(mutated_lines) + b"\n")

        candidate = self._candidate_copy("strict-json-compact-candidate")
        compact_path = candidate.joinpath(*PurePosixPath(entry.destination).parts)
        original = compact_path.read_bytes()
        candidate_lines = original.splitlines()
        try:
            for label, members in attacks.items():
                mutated_lines = list(candidate_lines)
                mutated_lines[0] = inject(mutated_lines[0], members)
                compact_path.write_bytes(b"\n".join(mutated_lines) + b"\n")
                with self.subTest(stage="verification", label=label):
                    with self.assertRaises(verifier.VerificationError):
                        verifier._verify_compact_ledger(candidate, entry)
        finally:
            compact_path.write_bytes(original)
        verifier._verify_compact_ledger(candidate, entry)

    def test_json_privacy_scan_rejects_escaped_identity_controls_and_malformed_documents(
        self,
    ) -> None:
        term = "SELFTEST_ONLY_\u8eab\u4efd_887766"
        identity_path = self.root / "semantic-identity.json"
        identity_path.write_text(
            json.dumps([term], ensure_ascii=False),
            encoding="utf-8",
        )
        identity = builder.load_identity_profile(identity_path)

        escaped_documents = {
            "escaped-key.json": json.dumps(
                {term: {"safe": "value"}}, ensure_ascii=True
            ).encode("utf-8"),
            "escaped-value.json": json.dumps(
                {"outer": [{"inner": term}]}, ensure_ascii=True
            ).encode("utf-8"),
            "escaped-key.jsonl": (
                json.dumps({term: "value"}, ensure_ascii=True) + "\n"
            ).encode("utf-8"),
            "escaped-value.jsonl": (
                json.dumps({"value": term}, ensure_ascii=True) + "\n"
            ).encode("utf-8"),
        }
        for relative, data in escaped_documents.items():
            self.assertNotIn(term.encode("utf-8"), data)
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="escaped-identity", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "private_identity_term_1"
                        for finding in scan["findings"]
                    )
                )
                with self.assertRaises(builder.CandidateError) as caught:
                    builder._raise_for_scan(scan, "self-test")
                self.assertNotIn(term, str(caught.exception))

        control_documents = {
            "nul.txt": b"safe\x00unsafe\n",
            "backspace.txt": b"safe\x08unsafe\n",
            "escaped-nul.json": json.dumps(
                {"value": "safe\x00unsafe"}, ensure_ascii=True
            ).encode("utf-8"),
            "escaped-backspace.json": json.dumps(
                {"value": "safe\x08unsafe"}, ensure_ascii=True
            ).encode("utf-8"),
        }
        for relative, data in control_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="control", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "unicode_control_character"
                        for finding in scan["findings"]
                    )
                )

        safe_controls = builder._scan_documents(
            [("safe-controls.txt", b"tab\tok\r\nline\n")], identity
        )
        self.assertEqual(safe_controls["status"], "PASS")

        escaped_term = json.dumps(term, ensure_ascii=True).encode("utf-8")[1:-1]
        malformed_documents = {
            "malformed.json": b'{"value":"' + escaped_term + b'"',
            "malformed.jsonl": b'{}\n{"value":"' + escaped_term + b'"\n',
        }
        for relative, data in malformed_documents.items():
            self.assertNotIn(term.encode("utf-8"), data)
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="malformed", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                with self.assertRaises(builder.CandidateError) as caught:
                    builder._raise_for_scan(scan, "self-test")
                self.assertNotIn(term, str(caught.exception))

    def test_candidate_metadata_requires_exact_canonical_bytes(self) -> None:
        for metadata_name in (builder.MANIFEST_NAME, builder.SCAN_NAME):
            candidate = self._candidate_copy(
                f"metadata-canonical-{PurePosixPath(metadata_name).stem.casefold()}"
            )
            path = candidate / metadata_name
            original = path.read_bytes()
            value = json.loads(original.decode("utf-8"))
            first_key = next(iter(value))
            duplicate_line = (
                "  "
                + json.dumps(first_key, ensure_ascii=False)
                + ": "
                + json.dumps(value[first_key], ensure_ascii=False, separators=(",", ":"))
                + ",\n"
            ).encode("utf-8")
            duplicate = original.replace(b"{\n", b"{\n" + duplicate_line, 1)
            self.assertEqual(json.loads(duplicate.decode("utf-8")), value)

            mutations = {
                "minified": json.dumps(
                    value,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
                "crlf": original.replace(b"\n", b"\r\n"),
                "bom": b"\xef\xbb\xbf" + original,
                "extra-whitespace": original + b" ",
                "duplicate-key": duplicate,
            }
            try:
                for label, mutated in mutations.items():
                    path.write_bytes(mutated)
                    with self.subTest(metadata=metadata_name, mutation=label):
                        with self.assertRaises(builder.CandidateError):
                            builder.verify_candidate(
                                candidate,
                                self.allowlist_path,
                                self.identity_file,
                            )
            finally:
                path.write_bytes(original)
            self.assertEqual(
                builder.verify_candidate(
                    candidate,
                    self.allowlist_path,
                    self.identity_file,
                )["status"],
                "PASS",
            )

    def test_hash_flattening_rejects_ambiguous_paths(self) -> None:
        entry = next(
            item for item in self.profile.entries if item.mode == "compact_ledger"
        )
        source_path = REPO_ROOT.joinpath(*PurePosixPath(entry.inputs[0][0]).parts)
        source_lines = source_path.read_bytes().splitlines()
        first = json.loads(source_lines[0].decode("utf-8"))
        self.assertNotIn("a", first)
        self.assertNotIn("a.b_sha256", first)
        nested = b'"a":{"b_sha256":"' + b"a" * 64 + b'"}'
        literal = b'"a.b_sha256":"' + b"b" * 64 + b'"'

        for label, members in (
            ("nested-first", nested + b"," + literal),
            ("literal-first", literal + b"," + nested),
        ):
            mutated_lines = list(source_lines)
            self.assertTrue(mutated_lines[0].endswith(b"}"))
            mutated_lines[0] = mutated_lines[0][:-1] + b"," + members + b"}"
            with self.subTest(order=label):
                with self.assertRaises(derivation.DerivationError):
                    derivation._compact_ledger(b"\n".join(mutated_lines) + b"\n")

        with self.assertRaises(derivation.DerivationError):
            derivation._flatten_hashes(
                {
                    "a": [{"b_sha256": "a" * 64}],
                    "a[0]": {"b_sha256": "b" * 64},
                }
            )

        repeated_digest = derivation._flatten_hashes(
            {
                "first_sha256": "c" * 64,
                "second_sha256": "c" * 64,
            }
        )
        self.assertEqual(len(repeated_digest), 2)
        self.assertEqual(set(repeated_digest.values()), {"c" * 64})

    def test_code_unicode_escapes_cannot_hide_identity(self) -> None:
        term = "SELFTEST_ONLY_\u8eab\u4efd_776655"
        identity_path = self.root / "code-escape-identity.json"
        identity_path.write_text(
            json.dumps([term], ensure_ascii=False),
            encoding="utf-8",
        )
        identity = builder.load_identity_profile(identity_path)
        escaped_literal = json.dumps(term, ensure_ascii=True).encode("utf-8")
        byte_escapes = "".join(f"\\x{byte:02x}" for byte in term.encode("utf-8"))
        js_prefix = "".join(f"\\x{byte:02x}" for byte in b"SELFTEST_ONLY_")
        js_suffix = "".join(f"\\x{byte:02x}" for byte in b"_776655")
        identity_documents = {
            "escaped-identity.js": b"const owner = " + escaped_literal + b";\n",
            "leading-zero-braced-identity.js": (
                b'const owner="\\u{00000053}ELFTEST_ONLY_'
                b'\\u{00008eab}\\u{00004efd}_776655";\n'
            ),
            "leading-zero-braced-template-identity.js": (
                b"const owner=`\\u{00000053}ELFTEST_ONLY_"
                b"\\u{00008eab}\\u{00004efd}_776655`;\n"
            ),
            "leading-zero-braced-identifier.js": (
                b"const \\u{00000053}ELFTEST_ONLY_"
                b"\\u{00008eab}\\u{00004efd}_776655=1;\n"
            ),
            "escaped-identity.py": b"owner = " + escaped_literal + b"\n",
            "named-escape-identity.py": (
                'owner = "SELFTEST_ONLY_'
                "\\N{CJK UNIFIED IDEOGRAPH-8EAB}"
                "\\N{CJK UNIFIED IDEOGRAPH-4EFD}"
                '_776655"\n'
            ).encode("utf-8"),
            "adjacent-literal-identity.py": (
                'owner = "SELFTEST_ONLY_\u8eab" "\u4efd_776655"\n'
            ).encode("utf-8"),
            "bytes-decode-identity.py": (
                f'owner = b"{byte_escapes}".decode()\n'
            ).encode("utf-8"),
            "deep-concatenated-identity.py": (
                "owner = "
                + " + ".join(
                    ['"SELFTEST_ONLY_"']
                    + ['""'] * 128
                    + ['"\\u8eab\\u4efd_776655"']
                )
                + "\n"
            ).encode("utf-8"),
            "concatenated-identity.js": (
                f'const owner = "{js_prefix}" + "\\u8eab" + "\\u4efd" '
                f'+ "{js_suffix}";\n'
            ).encode("utf-8"),
            "concatenated-identity.mjs": (
                f'export const owner = "{js_prefix}" + "\\u{{8eab}}" '
                f'+ "\\u4efd" + "{js_suffix}";\n'
            ).encode("utf-8"),
            "block-comment-concatenated-identity.js": (
                f'const owner = "{js_prefix}" /* "noise" */ + /* second */ '
                f'"\\u8eab" + /* third */ "\\u4efd" + "{js_suffix}";\n'
            ).encode("utf-8"),
            "line-continuation-identity.js": (
                b'const owner = "'
                + js_prefix.encode("ascii")
                + b"\\u8eab\\\n\\u4efd"
                + js_suffix.encode("ascii")
                + b'";\n'
            ),
            "line-separator-continuation-identity.js": (
                f'const owner = "{js_prefix}\\u8eab\\\u2028\\u4efd{js_suffix}";\n'
            ).encode("utf-8"),
            "paragraph-separator-continuation-identity.js": (
                f'const owner = "{js_prefix}\\u8eab\\\u2029\\u4efd{js_suffix}";\n'
            ).encode("utf-8"),
            "template-expression-identity.js": (
                b"const owner = `"
                + js_prefix.encode("ascii")
                + b"\\u8eab${''}\\u4efd"
                + js_suffix.encode("ascii")
                + b"`;\n"
            ),
            "template-comment-expression-identity.js": (
                b"const owner = `"
                + js_prefix.encode("ascii")
                + b'\\u8eab${/* "noise" */""}\\u4efd'
                + js_suffix.encode("ascii")
                + b"`;\n"
            ),
            "template-parenthesized-expression-identity.js": (
                b'const owner=`SELFTEST_ONLY_\\u8eab${("\\u4efd")}_776655`;\n'
            ),
            "function-regex-before-concatenated-identity.js": (
                br'function f(){} /https?:\/\//.test("x"); '
                + f'const owner="{js_prefix}"+"\\u8eab"+"\\u4efd"'
                f'+"{js_suffix}";\n'.encode("utf-8")
            ),
        }
        for relative, data in identity_documents.items():
            self.assertNotIn(term.encode("utf-8"), data)
            if relative.endswith(".py"):
                compile(data.decode("utf-8"), relative, "exec")
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="identity", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "private_identity_term_1"
                        for finding in scan["findings"]
                    )
                )
                with self.assertRaises(builder.CandidateError) as caught:
                    builder._raise_for_scan(scan, "self-test")
                self.assertNotIn(term, str(caught.exception))

        fstring_term = "\u7532\u4e59\u4e19"
        fstring_identity_path = self.root / "fstring-escape-identity.json"
        fstring_identity_path.write_text(
            json.dumps([fstring_term], ensure_ascii=False),
            encoding="utf-8",
        )
        fstring_identity = builder.load_identity_profile(fstring_identity_path)
        fstring_source = 'owner = f"\u7532{\'\'}\u4e59\u4e19"\n'.encode("utf-8")
        self.assertNotIn(fstring_term.encode("utf-8"), fstring_source)
        compile(fstring_source.decode("utf-8"), "fstring-identity.py", "exec")
        fstring_scan = builder._scan_documents(
            [("fstring-identity.py", fstring_source)], fstring_identity
        )
        self.assertEqual(fstring_scan["status"], "FAIL")
        self.assertTrue(
            any(
                finding["rule"] == "private_identity_term_1"
                for finding in fstring_scan["findings"]
            )
        )

        utf7_source = b'# coding: utf-7\nowner = "+dTJOWU4Z"\n'
        utf7_code = compile(utf7_source, "utf7-identity.py", "exec")
        self.assertIn(fstring_term, utf7_code.co_consts)
        utf7_scan = builder._scan_documents(
            [("utf7-identity.py", utf7_source)],
            fstring_identity,
        )
        self.assertEqual(utf7_scan["status"], "FAIL")
        self.assertTrue(
            any(
                finding["rule"] == "unsupported_python_source_encoding"
                for finding in utf7_scan["findings"]
            )
        )
        safe_utf8_cookie = b"# coding: utf-8\nowner = 'public'\n"
        compile(safe_utf8_cookie, "utf8-cookie.py", "exec")
        self.assertEqual(
            builder._scan_documents(
                [("utf8-cookie.py", safe_utf8_cookie)],
                fstring_identity,
            )["status"],
            "PASS",
        )

        formatted_fstring_source = 'owner = f"\u7532{\'\':}\u4e59\u4e19"\n'.encode(
            "utf-8"
        )
        self.assertNotIn(fstring_term.encode("utf-8"), formatted_fstring_source)
        compile(
            formatted_fstring_source.decode("utf-8"),
            "formatted-fstring-identity.py",
            "exec",
        )
        formatted_fstring_scan = builder._scan_documents(
            [("formatted-fstring-identity.py", formatted_fstring_source)],
            fstring_identity,
        )
        self.assertEqual(formatted_fstring_scan["status"], "FAIL")
        self.assertTrue(
            any(
                finding["rule"] == "private_identity_term_1"
                for finding in formatted_fstring_scan["findings"]
            )
        )

        private_use_prefix = "".join(chr(value) for value in range(0xF0000, 0xFFFFE))
        exhaustive_prefix_source = (
            'const owner = "'
            + private_use_prefix
            + "\\u7532\\u4e59\\u4e19"
            + '";\n'
        ).encode("utf-8")
        self.assertNotIn(fstring_term.encode("utf-8"), exhaustive_prefix_source)
        exhaustive_prefix_scan = builder._scan_documents(
            [("exhaustive-private-use-prefix.js", exhaustive_prefix_source)],
            fstring_identity,
        )
        self.assertEqual(exhaustive_prefix_scan["status"], "FAIL")
        self.assertTrue(
            any(
                finding["rule"] == "private_identity_term_1"
                for finding in exhaustive_prefix_scan["findings"]
            )
        )

        credential_documents = {
            "adjacent-credential.py": (
                'secrets = {("api" "\\x5f" "key"): '
                '("self" "test" "credential" "998877")}\n'
            ).encode("utf-8"),
            "concatenated-credential.js": (
                'const secrets = {["\\x61\\x70" + "\\u0069" + "\\x5f" '
                '+ "\\u006b\\u0065\\u0079"]: '
                '"\\x73\\x65\\x6c\\x66" + "\\u0074\\u0065\\u0073\\u0074"};\n'
            ).encode("utf-8"),
            "concatenated-credential.mjs": (
                'export const secrets = {["\\x63\\x6c\\x69" '
                '+ "\\u0065\\u006e\\u0074" + "\\x5f" '
                '+ "\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074"]: '
                '"\\x76\\x61\\x6c\\x75\\x65" + "\\u0039\\u0039\\u0038\\u0038"};\n'
            ).encode("utf-8"),
            "deep-concatenated-credential.py": (
                "secrets = {"
                + " + ".join(['"api"'] + ['""'] * 128 + ['"_key"'])
                + ": None}\n"
            ).encode("utf-8"),
            "leading-zero-braced-credential.js": (
                b'const secrets={"\\u{00000061}pi_key":null};\n'
            ),
            "leading-zero-braced-template-credential.js": (
                b"const secrets={[`\\u{00000061}pi_key`]:null};\n"
            ),
        }
        for relative, data in credential_documents.items():
            self.assertNotIn(b"api_key", data)
            self.assertNotIn(b"client_secret", data)
            if relative.endswith(".py"):
                compile(data.decode("utf-8"), relative, "exec")
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="credential", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "credential_assignment"
                        for finding in scan["findings"]
                    )
                )
                with self.assertRaises(builder.CandidateError) as caught:
                    builder._raise_for_scan(scan, "self-test")
                self.assertNotIn(term, str(caught.exception))

        javascript_identifier_credentials = {
            "unquoted-api-key.js": b"const secrets = {api_key:null};\n",
            "unquoted-empty-password.js": b'const secrets = {password:""};\n',
            "regex-before-unquoted-api-key.js": (
                br"const r=/https?:\/\//; const secrets={api_key:null};" + b"\n"
            ),
            "control-regex-before-unquoted-api-key.js": (
                br"if (ready) /[\"`//]/.test(value); "
                b"const secrets={api_key:null};\n"
            ),
            "block-regex-before-computed-api-key.js": (
                br'if(false){} /https?:\/\//.test("x"); '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "spread-regex-before-computed-api-key.js": (
                br'const a=[.../\//.exec(value)]; '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "for-await-regex-before-computed-api-key.js": (
                br'async function f(xs){for await(const v of xs) /\//.test(v); '
                b'const secrets={["api"+"_"+"key"]:null};}\n'
            ),
            "export-default-regex-before-computed-api-key.mjs": (
                br'export default /\//; '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "debugger-asi-regex-before-computed-api-key.js": (
                b"debugger\n"
                br'/https?:\/\//.test("x"); '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "var-asi-regex-before-computed-api-key.js": (
                b"var value\n"
                br'/https?:\/\//.test("x"); '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "import-asi-regex-before-computed-api-key.mjs": (
                b'import "module"\n'
                br'/https?:\/\//.test("x"); '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "label-block-regex-before-computed-api-key.js": (
                br'label:{} /https?:\/\//.test("x"); '
                b'const secrets={["api"+"_"+"key"]:null};\n'
            ),
            "private-member-division-computed-api-key.js": (
                b'class C{#return=1;f(){return this.#return/'
                b'({["api"+"_"+"key"]:null})/g;}}\n'
            ),
            "template-computed-api-key.js": (
                b'const value=`${({["api"+"_"+"key"]:null})}`;\n'
            ),
            "subscript-computed-api-key.js": (
                b'object["api"+"_"+"key"]=null;\n'
            ),
            "subscript-postfix-api-key.js": b'object["api_key"]++;\n',
            "subscript-prefix-api-key.js": b'++object["api_key"];\n',
            "subscript-for-of-api-key.js": (
                b'for(object["api_key"] of values){}\n'
            ),
            "subscript-destructure-api-key.js": (
                b'[object["api_key"]]=values;\n'
            ),
            "class-field-computed-api-key.js": (
                b'class C{["api"+"_"+"key"]=null;}\n'
            ),
            "class-field-string-api-key.js": (
                b'class C{"\\x61pi\\x5fkey";}\n'
            ),
            "object-method-computed-api-key.js": (
                b'const value={["api"+"_"+"key"](){}};\n'
            ),
            "class-getter-computed-api-key.js": (
                b'class C{get ["api_key"](){return null;}}\n'
            ),
            "static-template-computed-api-key.js": (
                b'const secrets={[`\\u0061${"pi"}_${"key"}`]:null};\n'
            ),
            "template-identifier-api-key.js": b"const value=`${api_key}`;\n",
            "tagged-template-password.js": b"tag`${password}`;\n",
            "nested-template-client-secret.js": (
                b"const value=`outer ${`inner ${object.client_secret}`}`;\n"
            ),
            "non-escape-quoted-api-key.js": (
                b'const secrets={"api\\_key":null};\n'
            ),
            "non-escape-template-api-key.js": (
                b"const secrets={[`api\\_key`]:null};\n"
            ),
            "leading-zero-identifier-api-key.js": (
                b"const api\\u{0000005f}key=null;\n"
            ),
            "nfkc-method-api-key.js": (
                b"const o={\\uFF41\\uFF50\\uFF49\\uFF3F"
                b"\\uFF4B\\uFF45\\uFF59(){return 1}};\n"
            ),
            "export-string-name-api-key.mjs": (
                b'const x=1; export {x as "\\x61pi\\x5fkey"};\n'
            ),
            "export-comma-string-name-api-key.mjs": (
                b'const x=1,y=2; export {x as "\\x61pi\\x5fkey",y};\n'
            ),
            "export-trailing-comma-string-name-api-key.mjs": (
                b'const x=1; export {x as "\\x61pi\\x5fkey",};\n'
            ),
            "export-from-string-name-api-key.mjs": (
                b'export * as "\\x61pi\\x5fkey" from "pkg";\n'
            ),
            "in-string-name-api-key.js": (
                b'const o={}; const present="\\x61pi\\x5fkey" in o;\n'
            ),
            "escaped-unquoted-api-key.js": (
                b'const secrets = {api\\u005fkey:"selftestvalue998877"};\n'
            ),
            "escaped-variable-api-key.js": (
                b'const api\\u005fkey="selftestvalue998877";\n'
            ),
            "quoted-comment-api-key.js": (
                b'const secrets = {"api_key" /* "noise" */:null};\n'
            ),
            "computed-comment-api-key.js": (
                b'const secrets = {["api" + "_key"] /* "noise" */:null};\n'
            ),
            "long-comment-quoted-api-key.js": (
                b'const secrets = {"api_key"/*'
                + b"x" * 10000
                + b"*/:null};\n"
            ),
            "long-comment-computed-api-key.js": (
                b'const secrets = {["api" + "_key"]/*'
                + b"x" * 10000
                + b"*/:null};\n"
            ),
        }
        for relative, data in javascript_identifier_credentials.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="javascript-identifier-credential", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "credential_assignment"
                        for finding in scan["findings"]
                    )
                )

        ambiguous_javascript_documents = {
            "html-open-comment-identity-join.js": (
                b'const owner="SELFTEST_ONLY_" <!-- harmless comment\n'
                b' + "\\u8eab\\u4efd_776655";\n'
            ),
            "unicode-space-html-close-comment.js": (
                "let value=1;\n\u00a0--> harmless comment\nvoid value;\n".encode(
                    "utf-8"
                )
            ),
            "block-comment-html-close-comment.js": (
                b"let value=1;\n/* trivia */ --> harmless comment\nvoid value;\n"
            ),
            "function-expression-division.js": (
                b"const ratio=function(){} / api_key / value;\n"
            ),
            "named-function-expression-division.js": (
                b"const ratio=function named(){} / api_key / value;\n"
            ),
            "async-function-expression-division.js": (
                b"const ratio=async function(){} / api_key / value;\n"
            ),
            "class-expression-division.js": (
                b"const ratio=class {} / api_key / value;\n"
            ),
            "named-class-expression-division.js": (
                b"const ratio=class Named {} / api_key / value;\n"
            ),
            "yield-identifier-division.js": (
                b"var yield=1; const ratio=yield / api_key / value;\n"
            ),
            "await-identifier-division.js": (
                b"var await=1; const ratio=await / api_key / value;\n"
            ),
            "of-identifier-division.js": (
                b"var of=1; const ratio=of / api_key / value;\n"
            ),
        }
        for relative, data in ambiguous_javascript_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="ambiguous-javascript", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"]
                        == "invalid_or_ambiguous_javascript_source"
                        for finding in scan["findings"]
                    )
                )

        python_identifier_credentials = {
            "empty-api-key-assignment.py": b"api_key = ''\n",
            "annotated-empty-client-secret.py": b"client_secret: str = ''\n",
            "bytes-dict-api-key.py": b'{b"api_key": b"abcdefghijkl"}\n',
            "bytes-subscript-api-key.py": b'object[b"api_key"] = b"abcdefghijkl"\n',
            "bytes-concatenated-api-key.py": (
                b'{b"api" + b"_" + b"key": b"abcdefghijkl"}\n'
            ),
            "subscript-computed-api-key.py": (
                b'object["api"+"_"+"key"]: str = ""\n'
            ),
            "subscript-read-api-key.py": b'print(object["api_key"])\n',
            "name-read-api-key.py": b"print(api_key)\n",
            "attribute-read-client-secret.py": b"print(object.client_secret)\n",
            "delete-api-key.py": b"del api_key\n",
            "dict-comprehension-api-key.py": (
                b'{"api"+"_"+"key": value for value in values}\n'
            ),
            "function-api-key-argument.py": b"def f(api_key=None): pass\n",
            "lambda-password-argument.py": b"f=lambda password=None: None\n",
            "import-api-key-alias.py": b"import harmless as api_key\n",
            "except-client-secret-binding.py": (
                b"try: pass\nexcept Exception as client_secret: pass\n"
            ),
            "match-api-key-capture.py": b"match value:\n case api_key: pass\n",
        }
        for relative, data in python_identifier_credentials.items():
            compile(data.decode("utf-8"), relative, "exec")
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="python-identifier-credential", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "credential_assignment"
                        for finding in scan["findings"]
                    )
                )

        if builder.PYTHON_TYPE_PARAMETER_AST_TYPES:
            pep695_source = b"def f[api_key](value: api_key): ...\n"
            compile(pep695_source.decode("utf-8"), "pep695-api-key.py", "exec")
            pep695_scan = builder._scan_documents(
                [("pep695-api-key.py", pep695_source)],
                identity,
            )
            self.assertEqual(pep695_scan["status"], "FAIL")
            self.assertTrue(
                any(
                    finding["rule"] == "credential_assignment"
                    for finding in pep695_scan["findings"]
                )
            )

        surrogate_documents = {
            "lone-high-surrogate.js": b'const value="\\uD800";\n',
            "reversed-surrogates.js": b'const value="\\uDC00\\uD800";\n',
        }
        for relative, data in surrogate_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="javascript-surrogate", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "unicode_surrogate_codepoint"
                        for finding in scan["findings"]
                    )
                )

        safe_javascript_documents = {
            "credential-word-value.js": b'console.log("password");\n',
            "double-backslash-literal.js": b'const literal="\\\\u0000";\n',
            "credential-word-regex.js": b"const pattern=/api_key/;\n",
            "ordinary-division.js": b"const ratio=left/(middle+one)/right;\n",
        }
        for relative, data in safe_javascript_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="safe-javascript", path=relative):
                self.assertEqual(scan["status"], "PASS")
                self.assertFalse(
                    any(
                        finding["rule"]
                        in {"credential_assignment", "unicode_control_character"}
                        for finding in scan["findings"]
                    )
                )

        literal_count = 4096
        linear_literal_source = "const value=" + "+".join(
            ['"x"'] * literal_count
        )
        linear_literal_views = builder._source_literal_scan_views(
            linear_literal_source
        )
        self.assertEqual(len(linear_literal_views), literal_count + 1)
        self.assertEqual(
            sum(len(value) for value, _is_key in linear_literal_views),
            literal_count * 2,
        )

    def test_json_semantic_credential_key_value_is_rejected(self) -> None:
        identity = builder.load_identity_profile(self.identity_file)
        documents = {
            "semantic-credential.json": (
                b'{"outer":{"api\\u005fkey":"selftestcredentialvalue998877"}}'
            ),
            "semantic-credential.jsonl": (
                b'{"outer":{"api\\u005fkey":"selftestcredentialvalue998877"}}\n'
            ),
        }
        for relative, data in documents.items():
            self.assertNotIn(b"api_key", data)
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "credential_assignment"
                        for finding in scan["findings"]
                    )
                )

        structured_documents = {
            "empty-api-key.toml": b'api_key = ""\n',
            "quoted-api-key.toml": b'"api_key" = "abcdefghijkl"\n',
            "api-key-table.toml": b'[auth.api_key]\nvalue="abcdefghijkl"\n',
            "client-secret-array-table.toml": (
                b'[[client_secret]]\nvalue="abcdefghijkl"\n'
            ),
            "null-api-key.yaml": b"api_key: null\n",
            "quoted-client-secret.yml": b"'client_secret': ''\n",
            "empty-api-key.ini": b"[auth]\napi_key=\n",
            "api-key-section.ini": b"[api_key]\nvalue=abcdefghijkl\n",
            "fullwidth-api-key-section.cfg": (
                "[\uff41\uff50\uff49\uff3f\uff4b\uff45\uff59]\nvalue=abcdefghijkl\n".encode(
                    "utf-8"
                )
            ),
            "quoted-password.cfg": b'"password"="abcdefghijkl"\n',
            "quoted-api-key.md": b'"api_key": "abcdefghijkl"\n',
            "bold-api-key.md": b'**api_key**: "abcdefghijkl"\n',
            "inline-code-api-key.md": b'`api_key`: `abcdefghijkl`\n',
            "html-code-api-key.md": b'<code>api_key</code>: abcdefghijkl\n',
            "html-comment-api-key.md": b'api_key<!--note-->: abcdefghijkl\n',
            "table-api-key.md": b'| api_key | value |\n| --- | --- |\n',
            "escaped-api-key.md": b'api\\_key: abcdefghijkl\n',
            "entity-api-key.md": b'api&#95;key: abcdefghijkl\n',
            "multiword-password.txt": (
                b'password: "correct horse battery staple"\n'
            ),
            "fullwidth-api-key.md": (
                '"\uff41\uff50\uff49\uff3f\uff4b\uff45\uff59": "abcdefghijkl"\n'.encode(
                    "utf-8"
                )
            ),
            "credential-header.csv": b"api_key,value\n,1\n",
            "leading-empty-credential-header.csv": b"\napi_key,value\n,1\n",
            "malformed-credential-header.csv": b'"api_key,value\n,1\n',
            "semicolon-credential-header.csv": b"api_key;value\n;1\n",
            "credential-header.tsv": b"client_secret\tvalue\n\t1\n",
        }
        for relative, data in structured_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="structured-credential", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "credential_assignment"
                        for finding in scan["findings"]
                    )
                )

        unsupported_structured_documents = {
            "yaml-explicit-key.yaml": b"? api_key # comment\n: abcdefghijkl\n",
            "yaml-sequence-explicit-key.yaml": (
                b"- - ? api_key # comment\n    : abcdefghijkl\n"
            ),
            "yaml-multiline-key.yml": (
                b'"api_\\\n  key": abcdefghijkl\n'
            ),
            "yaml-alias-credential-key.yaml": (
                b"holder: &k api_key\n*k: abcdefghijkl\n"
            ),
            "yaml-value-line-continuation.yaml": (
                'owner: "\u7532\\\n  \u4e59\u4e19"\n'.encode("utf-8")
            ),
            "toml-value-line-continuation.toml": (
                'owner = """\u7532\\\n    \u4e59\u4e19"""\n'.encode("utf-8")
            ),
            "toml-spaced-line-continuation.toml": (
                'owner = """\u7532\\   \n    \u4e59\u4e19"""\n'.encode("utf-8")
            ),
            "ini-basic-interpolation.ini": (
                "[owner]\nfirst=\u7532\nrest=\u4e59\u4e19\nfull=%(first)s%(rest)s\n".encode(
                    "utf-8"
                )
            ),
            "ini-parenthesized-key-interpolation.ini": (
                "[owner]\na(=\u7532\nb(=\u4e59\u4e19\nfull=%(a()s%(b()s\n".encode(
                    "utf-8"
                )
            ),
            "ini-extended-interpolation.cfg": (
                "[owner]\nfirst=\u7532\nrest=\u4e59\u4e19\nfull=${first}${rest}\n".encode(
                    "utf-8"
                )
            ),
            "csv-excel-separator-directive.csv": (
                b"sep=;\napi_key;value\n;1\n"
            ),
        }
        for relative, data in unsupported_structured_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="unsupported-structured", path=relative):
                self.assertEqual(scan["status"], "FAIL")

        safe_structured_documents = {
            "safe.toml": b'title = "password"\n',
            "safe.yaml": b"owner: Alice Jones\n",
            "safe-star.yaml": b"note: 2*3\n",
            "safe.csv": b"metric,value\npassword,1\n",
            "safe.md": b'The field name is "api_key".\n',
            "safe-percent.ini": b"[metrics]\ncompletion=100%\n",
        }
        for relative, data in safe_structured_documents.items():
            scan = builder._scan_documents([(relative, data)], identity)
            with self.subTest(kind="safe-structured", path=relative):
                self.assertEqual(scan["status"], "PASS")

        markdown_identity = "\u7532\u4e59\u4e19"
        markdown_identity_path = self.root / "markdown-semantic-identity.json"
        markdown_identity_path.write_text(
            json.dumps(
                [markdown_identity, "\u7532\u4e59x\u4e19"],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        markdown_identity_profile = builder.load_identity_profile(
            markdown_identity_path
        )
        markdown_identity_documents = {
            "bold-identity.md": "\u7532**\u4e59**\u4e19\n",
            "inline-code-identity.md": "\u7532`\u4e59`\u4e19\n",
            "html-tag-identity.md": "\u7532<span>\u4e59</span>\u4e19\n",
            "quoted-angle-html-tag-identity.md": (
                '\u7532<span title=">">\u4e59</span>\u4e19\n'
            ),
            "multiline-html-tag-identity.md": (
                '\u7532<span\n title="note">\u4e59</span>\u4e19\n'
            ),
            "html-comment-identity.md": "\u7532<!--note-->\u4e59\u4e19\n",
            "inline-link-identity.md": "\u7532[\u4e59](https://example.com)\u4e19\n",
            "balanced-link-identity.md": (
                "\u7532[\u4e59](https://example.com/a_(b))\u4e19\n"
            ),
            "angle-link-identity.md": (
                "\u7532[\u4e59](<https://example.com/a(b)>)\u4e19\n"
            ),
            "reference-link-identity.md": "\u7532[\u4e59][ref]\u4e19\n\n[ref]: /safe\n",
            "reference-image-identity.md": "\u7532![\u4e59][ref]\u4e19\n\n[ref]: /safe\n",
        }
        for relative, source in markdown_identity_documents.items():
            data = source.encode("utf-8")
            self.assertNotIn(markdown_identity.encode("utf-8"), data)
            scan = builder._scan_documents(
                [(relative, data)],
                markdown_identity_profile,
            )
            with self.subTest(kind="markdown-identity", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"] == "private_identity_term_1"
                        for finding in scan["findings"]
                    )
                )

        nested_label_source = "\u7532[\u4e59[x]](https://x)\u4e19\n".encode("utf-8")
        nested_label_scan = builder._scan_documents(
            [("nested-label-identity.md", nested_label_source)],
            markdown_identity_profile,
        )
        self.assertEqual(nested_label_scan["status"], "FAIL")
        self.assertTrue(
            any(
                finding["rule"] == "private_identity_term_2"
                for finding in nested_label_scan["findings"]
            )
        )

        escaped_identity_path = self.root / "markdown-escaped-identity.json"
        escaped_identity_path.write_text(
            json.dumps(
                [
                    "O'Connor",
                    "A@B",
                    "A_B",
                    "A*B",
                    "A[B]C",
                    "A<B>C",
                    "A<!--B-->C",
                    "John Doe",
                ]
            ),
            encoding="utf-8",
        )
        escaped_identity_profile = builder.load_identity_profile(
            escaped_identity_path
        )
        escaped_identity_documents = {
            "apostrophe-escape.md": "O\\'Connor\n",
            "at-sign-escape.md": "A\\@B\n",
            "underscore-escape.md": "A\\_B\n",
            "underscore-entity.md": "A&#95;B\n",
            "asterisk-escape.md": "A\\*B\n",
            "bracket-escape.md": "A\\[B\\]C\n",
            "angle-entity.md": "A&lt;B&gt;C\n",
            "comment-entity.md": "A&lt;!--B--&gt;C\n",
            "angle-escape.md": "A\\<B\\>C\n",
            "attribute-entity.md": '<span data-owner="A&#95;B">safe</span>\n',
            "hidden-comment-entity.md": "<!-- A&#95;B -->\n",
            "hidden-target-escape.md": "[safe](https://x/A\\_B)\n",
            "soft-break-identity.md": "John\nDoe\n",
            "two-space-hard-break-identity.md": "John  \nDoe\n",
            "backslash-hard-break-identity.md": "John\\\nDoe\n",
            "html-break-identity.md": "John<br>Doe\n",
        }
        for relative, source in escaped_identity_documents.items():
            data = source.encode("utf-8")
            scan = builder._scan_documents(
                [(relative, data)],
                escaped_identity_profile,
            )
            with self.subTest(kind="markdown-escaped-identity", path=relative):
                self.assertEqual(scan["status"], "FAIL")
                self.assertTrue(
                    any(
                        finding["rule"].startswith("private_identity_term_")
                        for finding in scan["findings"]
                    )
                )

        structured_identity_path = self.root / "structured-semantic-identity.json"
        structured_identity_path.write_text(
            json.dumps(["Alice Smith", 'O"Connor', "O'Connor"]),
            encoding="utf-8",
        )
        structured_identity_profile = builder.load_identity_profile(
            structured_identity_path
        )
        structured_identity_documents = {
            "yaml-folded-identity.yaml": "owner: >-\n  Alice\n  Smith\n",
            "yaml-multiline-quoted-identity.yaml": (
                'owner: "Alice\n  Smith"\n'
            ),
            "yaml-plain-multiline-identity.yaml": "owner: Alice\n  Smith\n",
            "yaml-escaped-space-identity.yaml": 'owner: "Alice\\ Smith"\n',
            "yaml-escaped-quote-identity.yaml": 'owner: "O\\"Connor"\n',
            "yaml-doubled-quote-identity.yaml": "owner: 'O''Connor'\n",
            "yaml-binary-tag-identity.yaml": (
                "owner: !!binary QWxpY2UgU21pdGg=\n"
            ),
            "yaml-custom-tag-identity.yaml": (
                "owner: !-foo QWxpY2UgU21pdGg=\n"
            ),
            "toml-escaped-quote-identity.toml": 'owner = "O\\"Connor"\n',
        }
        for relative, source in structured_identity_documents.items():
            scan = builder._scan_documents(
                [(relative, source.encode("utf-8"))],
                structured_identity_profile,
            )
            with self.subTest(kind="structured-identity", path=relative):
                self.assertEqual(scan["status"], "FAIL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
