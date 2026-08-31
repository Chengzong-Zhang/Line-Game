from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import uuid
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import build_supplement_candidate as builder  # noqa: E402
import derive_claim_complete_payload as derivation  # noqa: E402
import subject_binding  # noqa: E402


STATUS = builder.STATUS
APPROVAL = derivation.APPROVAL
CLAIM_IDS = derivation.CLAIM_IDS


class VerificationError(RuntimeError):
    """Fail-closed semantic verification error for a claim-complete candidate."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _candidate_file(candidate: Path, relative: str) -> Path:
    return candidate.joinpath(*PurePosixPath(relative).parts)


def _document_bytes(documents: Mapping[str, bytes], relative: str) -> bytes:
    try:
        data = documents[relative]
    except KeyError as exc:
        raise VerificationError(f"candidate document is missing: {relative}") from exc
    if type(data) is not bytes:
        raise VerificationError(f"candidate document is not frozen bytes: {relative}")
    return data


def _read_json(documents: Mapping[str, bytes], relative: str) -> Any:
    data = _document_bytes(documents, relative)
    try:
        return derivation._strict_json_loads(data, f"candidate JSON {relative}")
    except derivation.DerivationError as exc:
        raise VerificationError(f"candidate JSON is invalid: {relative}") from exc


def _entry_by_mode(
    profile: derivation.ClaimCompleteProfile, mode: str
) -> derivation.ProfileEntry:
    matches = [entry for entry in profile.entries if entry.mode == mode]
    if len(matches) != 1:
        raise VerificationError(f"profile must contain exactly one {mode} entry")
    return matches[0]


def _verify_claim_ledger(
    documents: Mapping[str, bytes], entry: derivation.ProfileEntry
) -> None:
    value = _read_json(documents, entry.destination)
    if not isinstance(value, dict):
        raise VerificationError("admitted claim ledger must be an object")
    if (
        value.get("candidate_status") != STATUS
        or value.get("approval") != APPROVAL
        or value.get("scope") != "admitted_only"
        or value.get("claim_ids") != list(CLAIM_IDS)
        or value.get("claim_count") != 10
    ):
        raise VerificationError("admitted claim ledger status or coverage drifted")
    claims = value.get("claims")
    if (
        not isinstance(claims, list)
        or any(not isinstance(item, dict) for item in claims)
        or [item.get("id") for item in claims] != list(CLAIM_IDS)
    ):
        raise VerificationError("admitted claim rows do not cover C1-C10 exactly")
    expected_claims = {
        claim_id: candidate_text
        for claim_id, (_source_text, candidate_text) in (
            derivation.CLAIM_LEDGER_CLAIM_REWRITES.items()
        )
    }
    expected_limitations = {
        claim_id: candidate_text
        for claim_id, (_source_text, candidate_text) in (
            derivation.CLAIM_LEDGER_LIMITATION_REWRITES.items()
        )
    }
    evidence_paths: Counter[str] = Counter()
    non_path_evidence: set[str] = set()
    ledger_parent = PurePosixPath(entry.destination).parent
    for item in claims:
        if not all(
            isinstance(item.get(key), str) and item[key]
            for key in (
                "claim",
                "authoritative_evidence",
                "required_limitation",
                "paper_locations",
            )
        ):
            raise VerificationError(
                "an admitted claim is missing evidence or limitation text"
            )
        claim_id = item["id"]
        expected_claim = expected_claims.get(claim_id)
        if expected_claim is not None and item["claim"] != expected_claim:
            raise VerificationError(f"{claim_id} candidate claim rewrite drifted")
        expected_limitation = expected_limitations.get(claim_id)
        if (
            expected_limitation is not None
            and item["required_limitation"] != expected_limitation
        ):
            raise VerificationError(f"{claim_id} candidate limitation rewrite drifted")

        claim_path_count = 0
        claim_path_keys: set[str] = set()
        for clause in (
            value.strip() for value in item["authoritative_evidence"].split(";")
        ):
            match = derivation.CLAIM_LEDGER_PATH_CLAUSE_RE.fullmatch(clause)
            if match is None:
                if clause not in derivation.CLAIM_LEDGER_NON_PATH_EVIDENCE:
                    raise VerificationError(
                        f"{claim_id} authoritative evidence clause is not classified"
                    )
                non_path_evidence.add(clause)
                continue
            try:
                evidence_path = derivation._safe_repo_relative_path(
                    match.group(1), f"{claim_id} authoritative evidence path"
                )
            except derivation.DerivationError as exc:
                raise VerificationError(
                    f"{claim_id} authoritative evidence path is unsafe"
                ) from exc
            evidence_key = evidence_path.casefold()
            if evidence_key in claim_path_keys:
                raise VerificationError(
                    f"{claim_id} authoritative evidence paths collide"
                )
            claim_path_keys.add(evidence_key)
            claim_path_count += 1
            evidence_paths[evidence_path] += 1
            candidate_relative = ledger_parent.joinpath(
                *PurePosixPath(evidence_path).parts
            ).as_posix()
            if candidate_relative not in documents:
                raise VerificationError(
                    f"{claim_id} authoritative evidence path is missing: "
                    f"{evidence_path}"
                )
        if claim_path_count == 0:
            raise VerificationError(
                f"{claim_id} has no path-bound authoritative evidence"
            )

    if non_path_evidence != set(derivation.CLAIM_LEDGER_NON_PATH_EVIDENCE):
        raise VerificationError(
            "claim ledger non-path authoritative-evidence clauses drifted"
        )
    for source_path, candidate_path in derivation.CLAIM_LEDGER_EVIDENCE_PATH_REWRITES:
        if evidence_paths[source_path] != 0 or evidence_paths[candidate_path] != 1:
            raise VerificationError(
                "claim ledger authoritative-evidence path rewrite drifted"
            )
    seed_audit_path = derivation.CLAIM_LEDGER_SEED_AUDIT_PATH
    if evidence_paths[seed_audit_path] != len(
        derivation.CLAIM_LEDGER_EVIDENCE_ADDITIONS
    ):
        raise VerificationError("claim ledger seed-audit evidence coverage drifted")


def _verify_strict_json_documents(documents: Mapping[str, bytes]) -> None:
    for relative, data in sorted(documents.items()):
        if PurePosixPath(relative).suffix.casefold() not in {".json", ".jsonl"}:
            continue
        try:
            derivation._validate_json_document_bytes(data, relative)
        except derivation.DerivationError as exc:
            raise VerificationError(
                f"candidate JSON/JSONL document is invalid: {relative}"
            ) from exc


def _verify_compact_ledger(
    documents: Mapping[str, bytes], entry: derivation.ProfileEntry
) -> None:
    data = _document_bytes(documents, entry.destination)
    lines = data.splitlines()
    if len(lines) != 330 or not data.endswith(b"\n"):
        raise VerificationError("compact receipt ledger must contain 330 newline rows")
    kinds: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    hash_bindings = 0
    for line_number, raw_line in enumerate(lines, start=1):
        try:
            row = derivation._strict_json_loads(
                raw_line, f"compact receipt line {line_number}"
            )
        except derivation.DerivationError as exc:
            raise VerificationError(
                f"compact receipt line {line_number} is invalid"
            ) from exc
        if not isinstance(row, dict):
            raise VerificationError(
                f"compact receipt line {line_number} is not an object"
            )
        if row.get("source_receipt_line") != line_number:
            raise VerificationError("compact receipt source-line sequence drifted")
        source_line_hash = row.get("source_receipt_sha256")
        if not isinstance(source_line_hash, str) or not builder.SHA256_RE.fullmatch(
            source_line_hash
        ):
            raise VerificationError("compact receipt source-line binding is invalid")
        bindings = row.get("hash_bindings")
        try:
            hash_bindings += derivation._validate_hash_bindings(
                bindings, f"compact receipt line {line_number} hash bindings"
            )
        except derivation.DerivationError as exc:
            raise VerificationError(
                "compact receipt hash bindings are invalid or collide"
            ) from exc
        kinds[str(row.get("result_kind"))] += 1
        statuses[str(row.get("status"))] += 1
    if kinds != {"training": 15, "evaluation": 315}:
        raise VerificationError(f"compact receipt kind counts drifted: {dict(kinds)}")
    if statuses != {"complete": 330} or hash_bindings != 4695:
        raise VerificationError(
            "compact receipt completion or retained hash-binding count drifted"
        )


def _verify_derived_statuses(
    documents: Mapping[str, bytes], profile: derivation.ClaimCompleteProfile
) -> None:
    json_modes = {
        "claim_ledger",
        "ledger_status",
        "superko_config",
        "superko_verification",
        "environment_receipt",
        "derivation_receipt",
    }
    for entry in profile.entries:
        if entry.mode not in json_modes:
            continue
        value = _read_json(documents, entry.destination)
        if not isinstance(value, dict):
            raise VerificationError(
                f"derived JSON is not an object: {entry.destination}"
            )
        if value.get("candidate_status") != STATUS or value.get("approval") != APPROVAL:
            raise VerificationError(
                f"derived candidate boundary is missing: {entry.destination}"
            )


def _verify_environment_bindings(
    documents: Mapping[str, bytes], profile: derivation.ClaimCompleteProfile
) -> None:
    entry = _entry_by_mode(profile, "environment_receipt")
    value = _read_json(documents, entry.destination)
    metadata = _read_json(documents, derivation.ENVIRONMENT_METADATA_PATH)
    if not isinstance(value, dict) or not isinstance(metadata, dict):
        raise VerificationError("environment receipt or metadata is not an object")

    formal_metadata = value.get("formal_execution_metadata")
    lock = value.get("lock")
    verifier = value.get("verifier")
    expected_command = [
        "python",
        "-B",
        derivation.ENVIRONMENT_VERIFIER_PATH,
        "--lock",
        derivation.ENVIRONMENT_LOCK_PATH,
        "--metadata",
        derivation.ENVIRONMENT_METADATA_PATH,
        "--output",
        derivation.ENVIRONMENT_RECEIPT_PATH,
    ]
    lock_bytes = _document_bytes(documents, derivation.ENVIRONMENT_LOCK_PATH)
    metadata_bytes = _document_bytes(documents, derivation.ENVIRONMENT_METADATA_PATH)
    verifier_bytes = _document_bytes(documents, derivation.ENVIRONMENT_VERIFIER_PATH)
    if (
        value.get("ok") is not True
        or value.get("errors") != []
        or not isinstance(formal_metadata, dict)
        or formal_metadata.get("path") != derivation.ENVIRONMENT_METADATA_PATH
        or formal_metadata.get("sha256") != _sha256(metadata_bytes)
        or formal_metadata.get("source_execution_metadata_sha256")
        != metadata.get("source_execution_metadata_sha256")
        or not isinstance(lock, dict)
        or lock.get("path") != derivation.ENVIRONMENT_LOCK_PATH
        or lock.get("sha256") != _sha256(lock_bytes)
        or not isinstance(verifier, dict)
        or verifier.get("path") != derivation.ENVIRONMENT_VERIFIER_PATH
        or verifier.get("sha256") != _sha256(verifier_bytes)
        or verifier.get("semantic_command") != expected_command
        or value.get("acquisition_boundary")
        != (
            "hash-bound environment receipt and lock only; "
            "no clean-install execution is claimed"
        )
    ):
        raise VerificationError(
            "environment receipt does not bind the included lock, metadata, and verifier"
        )


def _verify_derivation_receipt(
    documents: Mapping[str, bytes],
    profile: derivation.ClaimCompleteProfile,
    entry: derivation.ProfileEntry,
    binding: subject_binding.SubjectBinding,
) -> None:
    value = _read_json(documents, entry.destination)
    if not isinstance(value, dict):
        raise VerificationError("anonymization receipt must be a JSON object")
    required_subject = {
        "subject_commit": binding.commit,
        "subject_tree": binding.tree,
        "subject_binding_verified": True,
    }
    for key, expected in required_subject.items():
        observed = value.get(key)
        if type(observed) is not type(expected) or observed != expected:
            raise VerificationError(f"anonymization receipt subject drifted at {key}")
    rows = value.get("source_bindings") if isinstance(value, dict) else None
    if not isinstance(rows, list) or len(rows) != len(profile.entries) - 1:
        raise VerificationError("anonymization receipt has incomplete source bindings")
    entries_by_destination = {
        item.destination: item
        for item in profile.entries
        if item.mode != "derivation_receipt"
    }
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise VerificationError("anonymization source binding is not an object")
        destination = row.get("candidate_path")
        if destination not in entries_by_destination or destination in seen:
            raise VerificationError("anonymization source binding destination drifted")
        seen.add(destination)
        profile_entry = entries_by_destination[destination]
        if (
            row.get("staging_source") != profile_entry.source
            or row.get("category") != profile_entry.category
            or row.get("mode") != profile_entry.mode
        ):
            raise VerificationError(
                f"anonymization source binding contract drifted: {destination}"
            )
        data = _document_bytes(documents, destination)
        if row.get("derived_size_bytes") != len(data) or row.get(
            "derived_sha256"
        ) != _sha256(data):
            raise VerificationError(
                f"anonymization derived binding mismatch: {destination}"
            )
        inputs = row.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            raise VerificationError(
                f"anonymization source inputs missing: {destination}"
            )
        for item in inputs:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("path"), str)
                or not isinstance(item.get("size_bytes"), int)
                or not isinstance(item.get("sha256"), str)
                or not builder.SHA256_RE.fullmatch(item["sha256"])
            ):
                raise VerificationError(
                    f"anonymization source input is invalid: {destination}"
                )
        if (
            profile_entry.mode == "claim_ledger"
            and row.get("transformations") != derivation._claim_ledger_transformations()
        ):
            raise VerificationError(
                "claim-ledger derivation receipt rewrite details drifted"
            )
    if seen != set(entries_by_destination):
        raise VerificationError(
            "anonymization receipt does not cover every payload entry"
        )


def _verify_descriptive_boundary(
    documents: Mapping[str, bytes], profile: derivation.ClaimCompleteProfile
) -> None:
    destinations = set(profile.descriptive_only_destinations)
    json_destinations = [path for path in destinations if path.endswith(".json")]
    if len(json_destinations) != 1:
        raise VerificationError("profile must declare one descriptive audit JSON")
    value = _read_json(documents, json_destinations[0])
    if not isinstance(value, dict) or value.get("status") != (
        "PASS_DESCRIPTIVE_ONLY_NO_INFERENCE"
    ):
        raise VerificationError("seed/pair audit lost descriptive-only status")
    for destination in destinations:
        try:
            text = _document_bytes(documents, destination).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise VerificationError(
                f"descriptive-only destination is not UTF-8: {destination}"
            ) from exc
        if "descriptive" not in text.casefold() and "DESCRIPTIVE_ONLY" not in text:
            raise VerificationError(
                f"descriptive-only destination lacks an explicit boundary: {destination}"
            )


def _verify_exact_special_sources(
    profile: derivation.ClaimCompleteProfile,
) -> None:
    formal_sources = {
        entry.source
        for entry in profile.entries
        if entry.source.startswith("research/iclr2027/results/formal/")
    }
    if formal_sources != set(builder.CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS):
        raise VerificationError(
            "formal-source exceptions differ from the exact eight files"
        )
    checkpoint_sources = {
        entry.source
        for entry in profile.entries
        if "checkpoint" in PurePosixPath(entry.source).name.casefold()
    }
    expected_checkpoint_sources = {
        "research/iclr2027/lifeline_rl/alphazero/checkpoint.py",
        "research/iclr2027/tests/test_alphazero_checkpoint.py",
    }
    if checkpoint_sources != expected_checkpoint_sources:
        raise VerificationError(
            "checkpoint source exceptions differ from the exact two files"
        )
    formal_inputs, checkpoint_inputs = derivation._special_input_paths(profile.entries)
    if formal_inputs != set(derivation.CLAIM_COMPLETE_FORMAL_INPUT_EXCEPTIONS):
        raise VerificationError(
            "formal transform-input exceptions differ from the exact ten files"
        )
    if checkpoint_inputs != set(derivation.CLAIM_COMPLETE_CHECKPOINT_INPUT_EXCEPTIONS):
        raise VerificationError(
            "checkpoint transform-input exceptions differ from the exact two files"
        )


def _verify_no_extension_labels(documents: Mapping[str, bytes]) -> None:
    for relative, data in sorted(documents.items()):
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise VerificationError(f"candidate file is not UTF-8: {relative}") from exc
        if derivation.PROHIBITED_EXTENSION_RE.search(relative + "\n" + text):
            raise VerificationError(
                f"prohibited later-extension label is present: {relative}"
            )


def _capture_subject_snapshot(
    source_root: Path,
    profile_path: Path,
    allowlist_path: Path,
    profile: derivation.ClaimCompleteProfile,
    allowlist: builder.AllowlistConfig,
    subject_commit: str,
    subject_tree: str,
) -> subject_binding.SubjectSnapshot:
    try:
        frozen_paths = {
            relative for entry in profile.entries for relative, _digest in entry.inputs
        }
        profile_relative = subject_binding.canonical_repo_relative(
            source_root, profile_path, "claim-complete profile"
        )
        allowlist_relative = subject_binding.canonical_repo_relative(
            source_root, allowlist_path, "claim-complete allowlist"
        )
        frozen_paths.add(profile_relative)
        frozen_paths.add(allowlist_relative)
        snapshot = subject_binding.verify_subject_repository(
            source_root,
            subject_commit,
            subject_tree,
            frozen_paths=frozen_paths,
            tool_paths=(
                Path(__file__),
                Path(builder.__file__),
                Path(derivation.__file__),
                Path(subject_binding.__file__),
            ),
        )
        subject_files = {item.relative: item for item in snapshot.files}
        profile_snapshot = subject_files.get(profile_relative)
        allowlist_snapshot = subject_files.get(allowlist_relative)
        if profile_snapshot is None or profile_snapshot.sha256 != profile.raw_sha256:
            raise VerificationError(
                "parsed claim-complete profile does not match the subject commit blob"
            )
        if (
            allowlist_snapshot is None
            or allowlist_snapshot.sha256 != allowlist.raw_sha256
        ):
            raise VerificationError(
                "parsed claim-complete allowlist does not match the subject commit blob"
            )
        return snapshot
    except subject_binding.SubjectBindingError as exc:
        raise VerificationError(str(exc)) from exc


def _compare_regenerated_sources(
    candidate_root: Path,
    documents: Mapping[str, bytes],
    source_root: Path,
    profile_path: Path,
    allowlist_path: Path,
    profile: derivation.ClaimCompleteProfile,
    subject_commit: str,
    subject_tree: str,
) -> None:
    temp_root = candidate_root.parent / f".lifeline-claim-complete-{uuid.uuid4().hex}"
    if temp_root.exists() or temp_root.is_symlink():
        raise VerificationError("exclusive regeneration directory already exists")
    temp_root.mkdir()
    try:
        first = temp_root / "staging-a"
        second = temp_root / "staging-b"
        derivation.derive_payload(
            source_root,
            profile_path,
            first,
            allowlist_path,
            subject_commit,
            subject_tree,
        )
        derivation.derive_payload(
            source_root,
            profile_path,
            second,
            allowlist_path,
            subject_commit,
            subject_tree,
        )
        for entry in profile.entries:
            first_data = _candidate_file(first, entry.source).read_bytes()
            second_data = _candidate_file(second, entry.source).read_bytes()
            candidate_data = _document_bytes(documents, entry.destination)
            if first_data != second_data:
                raise VerificationError(
                    f"derivation is non-deterministic: {entry.source}"
                )
            if candidate_data != first_data:
                raise VerificationError(
                    f"candidate differs from freshly derived source: {entry.destination}"
                )
    finally:
        safe_parent = candidate_root.parent.absolute()
        if temp_root.absolute().parent != safe_parent or not temp_root.name.startswith(
            ".lifeline-claim-complete-"
        ):
            raise VerificationError("refusing unsafe regeneration cleanup target")
        if temp_root.exists() and not temp_root.is_symlink():
            shutil.rmtree(temp_root)


def verify_claim_complete(
    candidate: Path,
    identity_file: Path,
    source_root: Path,
    profile_path: Path,
    allowlist_path: Path,
    subject_commit: str,
    subject_tree: str,
    *,
    _expected_identity_profile: builder.IdentityProfile | None = None,
    _candidate_snapshot: builder.CandidateSnapshot | None = None,
) -> dict[str, Any]:
    candidate = candidate.absolute()
    profile = derivation._load_profile(profile_path)
    allowlist, _allowlist_bytes = derivation._load_allowlist_shape(allowlist_path)
    derivation._validate_allowlist_shape(profile, allowlist)
    subject_snapshot = _capture_subject_snapshot(
        source_root,
        profile_path,
        allowlist_path,
        profile,
        allowlist,
        subject_commit,
        subject_tree,
    )
    identity = builder.load_identity_profile(identity_file)
    if (
        _expected_identity_profile is not None
        and identity != _expected_identity_profile
    ):
        raise VerificationError(
            "identity terms file does not match the workflow snapshot"
        )
    if _expected_identity_profile is not None:
        identity = _expected_identity_profile
    if _candidate_snapshot is None:
        candidate_snapshot = builder._capture_candidate_snapshot(candidate, allowlist)
    else:
        if type(_candidate_snapshot) is not builder.CandidateSnapshot:
            raise VerificationError("injected candidate snapshot has the wrong type")
        candidate_snapshot = _candidate_snapshot
    base_result = builder._verify_candidate_snapshot(
        candidate_snapshot,
        allowlist,
        identity,
        subject_snapshot.binding,
    )
    documents = candidate_snapshot.documents
    _verify_strict_json_documents(documents)
    _verify_exact_special_sources(profile)
    _verify_claim_ledger(documents, _entry_by_mode(profile, "claim_ledger"))
    _verify_compact_ledger(documents, _entry_by_mode(profile, "compact_ledger"))
    _verify_derived_statuses(documents, profile)
    _verify_environment_bindings(documents, profile)
    _verify_derivation_receipt(
        documents,
        profile,
        _entry_by_mode(profile, "derivation_receipt"),
        subject_snapshot.binding,
    )
    _verify_descriptive_boundary(documents, profile)
    _verify_no_extension_labels(documents)
    _compare_regenerated_sources(
        candidate,
        documents,
        source_root.absolute(),
        profile_path,
        allowlist_path,
        profile,
        subject_commit,
        subject_tree,
    )

    game_engine_entries = [
        entry for entry in profile.entries if entry.mode == "game_engine_copy"
    ]
    if len(game_engine_entries) != 1:
        raise VerificationError("GameEngine.js byte-copy entry is missing")
    engine_entry = game_engine_entries[0]
    if (
        len(engine_entry.inputs) != 1
        or engine_entry.inputs[0][0] != derivation.GAME_ENGINE_SOURCE
    ):
        raise VerificationError("GameEngine.js source binding is ambiguous")
    subject_files = {item.relative: item for item in subject_snapshot.files}
    source_engine_snapshot = subject_files.get(derivation.GAME_ENGINE_SOURCE)
    if source_engine_snapshot is None or type(source_engine_snapshot.data) is not bytes:
        raise VerificationError("GameEngine.js is missing from the subject snapshot")
    source_engine = source_engine_snapshot.data
    candidate_engine = _document_bytes(documents, engine_entry.destination)
    if candidate_engine != source_engine:
        raise VerificationError(
            "GameEngine.js is not byte-identical to the tracked source"
        )

    try:
        readme = _document_bytes(documents, builder.README_NAME).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VerificationError("candidate README is not UTF-8") from exc
    if STATUS not in readme or "author approval is required" not in readme:
        raise VerificationError(
            "candidate README lost the candidate-only approval boundary"
        )
    if "five\nformal aggregate views" not in readme:
        raise VerificationError(
            "candidate README no longer describes the exact formal projection"
        )

    try:
        subject_binding.assert_subject_snapshot_unchanged(subject_snapshot)
    except subject_binding.SubjectBindingError as exc:
        raise VerificationError(str(exc)) from exc

    return {
        **base_result,
        "approval": APPROVAL,
        **subject_snapshot.binding.public_fields(),
        "subject_binding_verified": True,
        "claim_coverage": list(CLAIM_IDS),
        "claim_count": len(CLAIM_IDS),
        "source_regeneration": "PASS_TWO_BYTE_IDENTICAL_DERIVATIONS",
        "game_engine_byte_identical": True,
        "formal_source_exception_count": len(
            builder.CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS
        ),
        "compact_receipts": 330,
        "descriptive_only": True,
        "later_extension_labels_absent": True,
    }


def _default_source_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify a claim-complete anonymous supplement candidate in one command."
    )
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--identity-file", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=_default_source_root())
    parser.add_argument("--profile", type=Path, default=derivation._default_profile())
    parser.add_argument(
        "--allowlist", type=Path, default=derivation._default_allowlist()
    )
    parser.add_argument("--subject-commit", required=True)
    parser.add_argument("--subject-tree", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = verify_claim_complete(
            args.candidate,
            args.identity_file,
            args.source_root,
            args.profile,
            args.allowlist,
            args.subject_commit,
            args.subject_tree,
        )
        rendered = derivation._pretty_json(result)
    except (
        builder.CandidateError,
        derivation.DerivationError,
        VerificationError,
    ) as exc:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "candidate_status": STATUS,
                    "approval": APPROVAL,
                    "error": str(exc),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
                allow_nan=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
