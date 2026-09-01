"""Verify the tracked D14--D16 fresh-install contract without executing it.

This verifier is deliberately standard-library-only on CPython 3.10.  It
never creates an environment, installs or builds a package, accesses the
network, or runs tests, games, or training.  A PASS binds one internally
consistent contract to explicitly supplied Git commit/tree object IDs; it is
not a fresh-install execution PASS.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = RESEARCH_ROOT.parents[1]
DEFAULT_PROFILE = RESEARCH_ROOT / "configs" / "d14_d16_fresh_install_profile.json"
SUBJECT_BINDING_SOURCE = RESEARCH_ROOT / "supplement_tools" / "subject_binding.py"
PROFILE_SCHEMA_NAME = "lifeline-d14-d16-fresh-install-profile"
RECEIPT_SCHEMA_NAME = "lifeline-d14-d16-fresh-install-profile-verification"
SCHEMA_VERSION = 1
MAX_JSON_BYTES = 256 * 1024
MAX_BOUND_FILE_BYTES = 16 * 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}")
CATEGORY_RE = re.compile(r"[a-z][a-z0-9_]*")
PACKAGE_NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
VERSION_RE = re.compile(
    r"(?:0|[1-9][0-9]*)(?:\.(?:0|[0-9]+))*"
    r"(?:\+[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?"
)
KEY_RE = re.compile(r"[A-Za-z0-9_.-]+")
SECTION_RE = re.compile(r"\[([A-Za-z0-9_.-]+)\]")
EXPECTED_TARGET = {
    "implementation": "CPython",
    "platform_tag": "win_amd64",
    "python_version": "3.10.20",
}
EXPECTED_SCOPE = {
    "clean_install_executed": False,
    "contract_only": True,
    "environment_created": False,
    "gate_e_compact_independent_verifier_available": True,
    "network_accessed": False,
    "packages_built": False,
    "packages_installed": False,
    "retraining_reproduced": False,
    "tests_or_games_run": False,
}
EXPECTED_DIRECTIVES = [
    "--extra-index-url https://download.pytorch.org/whl/cu118",
]
EXPECTED_LOCK_PATH = "research/iclr2027/requirements-d14-d16-win-cu118.lock.txt"
EXPECTED_PYPROJECT_PATH = "research/iclr2027/pyproject.toml"
EXPECTED_LOCK_PINS = {
    "colorama": "0.4.6",
    "exceptiongroup": "1.3.1",
    "filelock": "3.25.2",
    "fsspec": "2026.2.0",
    "iniconfig": "2.3.0",
    "jinja2": "3.1.6",
    "markupsafe": "3.0.2",
    "mpmath": "1.3.0",
    "networkx": "3.4.2",
    "numpy": "2.2.6",
    "packaging": "25.0",
    "pluggy": "1.6.0",
    "pygments": "2.20.0",
    "pytest": "9.0.3",
    "setuptools": "80.10.2",
    "sympy": "1.14.0",
    "tomli": "2.4.1",
    "torch": "2.7.1+cu118",
    "typing-extensions": "4.15.0",
    "wheel": "0.46.3",
}
EXPECTED_INSTALLED_DISTRIBUTION_COUNT = 22
EXPECTED_BUILD_BACKEND = "setuptools.build_meta"
EXPECTED_DECLARED_BUILD_REQUIRES = ["setuptools>=68"]
EXPECTED_PROJECT_NAME = "lifeline-rl"
EXPECTED_PROJECT_VERSION = "0.1.0"
EXPECTED_REQUIRES_PYTHON = ">=3.10"
EXPECTED_DECLARED_RUNTIME_DEPENDENCIES: list[str] = []
EXPECTED_DECLARED_OPTIONAL_DEPENDENCIES = {"train": ["torch>=2.3"]}
EXPECTED_PACKAGE_DISCOVERY_ROOT = "research/iclr2027"
EXPECTED_WHEEL_SOURCE_ROOT = "research/iclr2027/lifeline_rl"
EXPECTED_WHEEL_SOURCE_SUFFIX = ".py"
EXPECTED_WHEEL_TOP_LEVEL_PACKAGES = ["lifeline_rl"]
EXPECTED_EXCLUDED_TOP_LEVEL_PACKAGES = ["lifeline_rl_autodl"]
EXPECTED_PACKAGE_DISCOVERY = {
    "include": ["lifeline_rl", "lifeline_rl.*"],
    "where": ["."],
}
EXPECTED_REFERENCE_SOURCE_COUNT = 25
EXPECTED_TEST_SUPPORT = ("research/iclr2027/tests/__init__.py",)
EXPECTED_TEST_GROUPS = {
    "d14_d16_protocol_receipt": (
        "research/iclr2027/tests/test_d14_d16_executor.py",
        "research/iclr2027/tests/test_d14_d16_experiment_protocol.py",
    ),
    "dependency_free_core_search_serialization": (
        "research/iclr2027/tests/test_agents.py",
        "research/iclr2027/tests/test_arena.py",
        "research/iclr2027/tests/test_core.py",
        "research/iclr2027/tests/test_cycle_seeking_agent.py",
        "research/iclr2027/tests/test_d6_aliasing.py",
        "research/iclr2027/tests/test_env.py",
        "research/iclr2027/tests/test_search_baselines.py",
        "research/iclr2027/tests/test_serialization.py",
        "research/iclr2027/tests/test_superko_ablation.py",
        "research/iclr2027/tests/test_superko_pilot.py",
        "research/iclr2027/tests/test_superko_policy_matrix.py",
        "research/iclr2027/tests/test_validation.py",
        "research/iclr2027/tests/test_verify_superko_policy_matrix.py",
    ),
    "pytorch_network_trainer": (
        "research/iclr2027/tests/test_alphazero_checkpoint.py",
        "research/iclr2027/tests/test_alphazero_config.py",
        "research/iclr2027/tests/test_alphazero_evaluation.py",
        "research/iclr2027/tests/test_alphazero_learning_health.py",
        "research/iclr2027/tests/test_alphazero_model_families.py",
        "research/iclr2027/tests/test_alphazero_network.py",
        "research/iclr2027/tests/test_alphazero_neural_agent.py",
        "research/iclr2027/tests/test_alphazero_puct.py",
        "research/iclr2027/tests/test_alphazero_replay.py",
        "research/iclr2027/tests/test_alphazero_self_play.py",
        "research/iclr2027/tests/test_alphazero_trainer.py",
    ),
    "retained_reproducibility": (
        "research/iclr2027/tests/test_d14_d16_fresh_install_preflight.py",
        "research/iclr2027/tests/test_verify_d14_d16_environment.py",
    ),
}
EXPECTED_TARGETED_TEST_PATHS = frozenset(
    {
        *EXPECTED_TEST_SUPPORT,
        *(path for paths in EXPECTED_TEST_GROUPS.values() for path in paths),
    }
)
EXPECTED_TARGETED_TEST_COUNT = 29
EXPECTED_CLAIM_DESCRIPTIVE_DESTINATIONS = [
    "research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.py",
    "research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.json",
    "research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.md",
]
EXPECTED_CLAIM_MODE_COUNTS = {
    "claim_ledger": 1,
    "compact_ledger": 1,
    "copy": 109,
    "d14_protocol": 1,
    "derivation_receipt": 1,
    "environment_receipt": 1,
    "game_engine_copy": 1,
    "ledger_status": 1,
    "reference_trace": 1,
    "superko_config": 1,
    "superko_verification": 1,
    "terminology_erratum": 1,
}
EXPECTED_CLAIM_ROW_COUNT = 120
EXPECTED_CLAIM_CATEGORY_COUNT = 28
EXPECTED_CLAIM_COPY_COUNT = 109
EXPECTED_CLAIM_DERIVATIVE_INPUT_COUNT = 10
EXPECTED_FUTURE_DERIVED_OUTPUT_COUNT = 11
EXPECTED_CLAIM_TRIPLE_SHA256 = (
    "95933b2b39d57495c9e945b95c6dd2f024270f1784d6221163540ec552a707f8"
)
CLAIM_ZERO_INPUT_EXCEPTION = {
    "category": "transformation_receipt",
    "destination": "research/iclr2027/results/validation/ANONYMIZATION_DERIVATION.json",
    "mode": "derivation_receipt",
    "source": "research/iclr2027/supplement_tools/derived_claim_complete/ANONYMIZATION_DERIVATION.json",
}
ALLOWLIST_NULL_HASH_EXCEPTION = {
    "category": "transformation_receipt",
    "destination": "research/iclr2027/results/validation/ANONYMIZATION_DERIVATION.json",
    "source": "research/iclr2027/supplement_tools/derived_claim_complete/ANONYMIZATION_DERIVATION.json",
}
EXPECTED_CRITICAL_PATHS = {
    "claim_complete_profile": "research/iclr2027/supplement_tools/claim_complete_profile.json",
    "compact_independent_receipt_auditor": "research/iclr2027/reviews/compact_independent_receipt_audit.py",
    "environment_verifier": "research/iclr2027/scripts/verify_d14_d16_environment.py",
    "fresh_install_preflight": "research/iclr2027/scripts/d14_d16_fresh_install_preflight.py",
    "fresh_install_preflight_doc": "research/iclr2027/D14_D16_FRESH_INSTALL_PREFLIGHT.md",
    "full_evidence_independent_auditor": "research/iclr2027/reviews/independent_receipt_audit.py",
    "portable_execution_metadata": "research/iclr2027/results/validation/d14_d16_execution_metadata_portable_20260831.json",
    "prior_independent_audit_receipt": "research/iclr2027/results/validation/d14_d16_independent_receipt_audit_20260831.json",
    "resolved_claim_allowlist": "research/iclr2027/supplement_tools/supplement_claim_complete_allowlist.json",
}
VERIFICATION_BOUNDARY = {
    "resists_same_user_adversarial_git_aba": False,
    "statement": (
        "Git executable bytes are assumed not to be adversarially ABA-swapped by "
        "a same-user process between verifier hash checks."
    ),
}
PUBLICATION_BOUNDARY = {
    "commit_point": "single_unbuffered_os_write_replacing_leading_bang_with_left_brace",
    "final_subject_recheck_before_create": True,
    "postcommit_durability": "best_effort_no_failure_downgrade_after_commit",
    "precommit_complete_invalid_payload_fsync_required": True,
    "resists_same_user_adversarial_output_aba": False,
    "resists_same_user_concurrent_mutation_during_output_write": False,
    "statement": (
        "Create-only publication commits by one unbuffered leading-byte write after "
        "a complete invalid payload is fsynced. Post-commit fsync and close are "
        "best-effort; the contract does not claim crash durability or resistance to "
        "same-user concurrent mutation or adversarial output-path ABA."
    ),
}
EXPECTED_COMPACT_VERIFIER_PATH = (
    "research/iclr2027/reviews/compact_independent_receipt_audit.py"
)
EXPECTED_COMPACT_VERIFIER_SHA256 = (
    "44a9e922aebd3ec8d30e40af35dbde459869a774971796251ab5317184583e7c"
)
EXPECTED_COMPACT_PUBLIC_VERDICT = "PASS_TRACKED_METADATA_CONSISTENCY_ONLY"
EXPECTED_COMPACT_LIMITATIONS = {
    "checkpoint_files_verified": False,
    "checkpoint_hashes_recomputed": False,
    "models_retrained": False,
    "raw_game_files_verified": False,
    "raw_game_hashes_recomputed": False,
    "receipt_declared_paths_opened": 0,
    "resists_same_user_adversarial_filesystem_aba": False,
    "resists_same_user_concurrent_input_substitution": False,
    "retraining_performed": False,
    "tracked_metadata_consistency_only": True,
    "training_logs_verified": False,
    "trajectory_records_opened": False,
    "trajectory_replay_performed": False,
    "verified_external_artifact_bytes": 0,
}
EXPECTED_COMPACT_BINDING_PATHS = frozenset(
    {
        "research/iclr2027/configs/d14_d16_formal_manifest.json",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv",
        "research/iclr2027/results/formal/d14_d16/run_v1/result_receipts.jsonl",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl",
        "research/iclr2027/results/validation/d14_d16_independent_receipt_audit_20260831.json",
    }
)
CONTROLLED_GIT_ENVIRONMENT = {
    "GIT_CONFIG_COUNT": "0",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_LITERAL_PATHSPECS": "1",
    "GIT_NO_LAZY_FETCH": "1",
    "GIT_NO_REPLACE_OBJECTS": "1",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_PAGER": "cat",
    "GIT_TERMINAL_PROMPT": "0",
}


try:
    from supplement_tools.subject_binding import (
        SubjectBindingError,
        assert_subject_snapshot_unchanged,
        parse_subject_binding,
        verify_subject_repository,
    )
except ModuleNotFoundError:
    sys.path.insert(0, str(RESEARCH_ROOT))
    from supplement_tools.subject_binding import (
        SubjectBindingError,
        assert_subject_snapshot_unchanged,
        parse_subject_binding,
        verify_subject_repository,
    )


class ContractError(RuntimeError):
    """Fail-closed contract validation error."""


@dataclass(frozen=True)
class ContractValidation:
    public: dict[str, object]
    frozen_paths: tuple[str, ...]
    future_derived_output_paths: tuple[str, ...]
    package_source_paths: tuple[str, ...]
    snapshots: tuple["FileSnapshot", ...]

    def assert_local_bytes_unchanged(self, repo_root: Path) -> None:
        _assert_snapshots_unchanged(
            repo_root,
            self.snapshots,
            "contract input bytes changed after subject verification",
        )

    def assert_future_outputs_absent(self, repo_root: Path) -> None:
        _assert_relative_paths_absent(repo_root, self.future_derived_output_paths)


@dataclass(frozen=True)
class FileSnapshot:
    relative: str
    data: bytes
    sha256: str
    size_bytes: int

    def public_fields(self) -> dict[str, object]:
        return {
            "path": self.relative,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
        }


class SnapshotReader:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root.resolve(strict=True)
        self._snapshots: dict[str, FileSnapshot] = {}

    def read(self, relative: str, label: str) -> FileSnapshot:
        safe = _safe_relative(relative, label)
        existing = self._snapshots.get(safe)
        if existing is not None:
            return existing
        data = _read_relative(self.repo_root, safe, label)
        snapshot = FileSnapshot(
            relative=safe,
            data=data,
            sha256=hashlib.sha256(data).hexdigest(),
            size_bytes=len(data),
        )
        self._snapshots[safe] = snapshot
        return snapshot

    def bind(self, relative: str, expected_sha256: object, label: str) -> FileSnapshot:
        if (
            type(expected_sha256) is not str
            or SHA256_RE.fullmatch(expected_sha256) is None
        ):
            raise ContractError(f"{label} has an invalid expected SHA-256")
        snapshot = self.read(relative, label)
        if snapshot.sha256 != expected_sha256:
            raise ContractError(f"{label} SHA-256 differs from the frozen contract")
        return snapshot

    def snapshots(self) -> tuple[FileSnapshot, ...]:
        return tuple(self._snapshots[path] for path in sorted(self._snapshots))


def _assert_snapshots_unchanged(
    repo_root: Path, snapshots: tuple[FileSnapshot, ...], message: str
) -> None:
    for snapshot in snapshots:
        observed = _read_relative(repo_root, snapshot.relative, "snapshot recheck")
        if observed != snapshot.data:
            raise ContractError(message)


def _assert_relative_paths_absent(
    repo_root: Path, relative_paths: tuple[str, ...]
) -> None:
    root = repo_root.resolve(strict=True)
    for relative in relative_paths:
        safe = _safe_relative(relative, "future derived output")
        declared = root.joinpath(*PurePosixPath(safe).parts).absolute()
        try:
            declared.relative_to(root)
        except ValueError as exc:
            raise ContractError(
                "future derived output is outside the repository"
            ) from exc
        try:
            os.lstat(declared)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ContractError("future derived output could not be inspected") from exc
        raise ContractError("future derived output is already present")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode(
        "utf-8"
    )


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError(f"JSON has duplicate key: {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ContractError(f"JSON contains forbidden non-finite constant: {value}")


def _reject_non_finite_numbers(value: object) -> None:
    if type(value) is float and not math.isfinite(value):
        raise ContractError("JSON contains a non-finite numeric value")
    if isinstance(value, dict):
        for item in value.values():
            _reject_non_finite_numbers(item)
    elif isinstance(value, list):
        for item in value:
            _reject_non_finite_numbers(item)


def _strict_json_object(
    data: bytes, *, canonical: bool, label: str
) -> dict[str, object]:
    if len(data) > MAX_JSON_BYTES:
        raise ContractError(f"{label} exceeds the size limit")
    try:
        value = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ContractError(f"{label} is not valid UTF-8 JSON") from exc
    _reject_non_finite_numbers(value)
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be a JSON object")
    if canonical and data != canonical_json_bytes(value):
        raise ContractError(f"{label} is not canonical UTF-8/LF JSON")
    return value


def _exact_keys(value: Mapping[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ContractError(f"{label} keys do not match schema v1")


def _typed_equal(observed: object, expected: object) -> bool:
    if type(observed) is not type(expected):
        return False
    if type(expected) is dict:
        observed_mapping = observed
        expected_mapping = expected
        assert isinstance(observed_mapping, dict)
        assert isinstance(expected_mapping, dict)
        return set(observed_mapping) == set(expected_mapping) and all(
            _typed_equal(observed_mapping[key], expected_mapping[key])
            for key in expected_mapping
        )
    if type(expected) is list:
        observed_list = observed
        expected_list = expected
        assert isinstance(observed_list, list)
        assert isinstance(expected_list, list)
        return len(observed_list) == len(expected_list) and all(
            _typed_equal(left, right)
            for left, right in zip(observed_list, expected_list)
        )
    return observed == expected


def _require_typed_equal(observed: object, expected: object, label: str) -> None:
    if not _typed_equal(observed, expected):
        raise ContractError(f"{label} value/type differs from schema v1")


def _safe_relative(value: object, label: str) -> str:
    if type(value) is not str or not value or "\\" in value or "\x00" in value:
        raise ContractError(f"{label} must be a canonical POSIX relative path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or path.as_posix() != value
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(part.casefold() == ".git" for part in path.parts)
    ):
        raise ContractError(f"{label} must be a canonical POSIX relative path")
    return value


def _is_reparse(path: Path) -> bool:
    metadata = os.lstat(path)
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


def _stat_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        metadata.st_size,
        metadata.st_mtime_ns,
    )


def _read_relative(repo_root: Path, relative: str, label: str) -> bytes:
    safe = _safe_relative(relative, label)
    root = repo_root.resolve(strict=True)
    declared = repo_root.joinpath(*PurePosixPath(safe).parts).absolute()
    try:
        resolved = declared.resolve(strict=True)
        metadata = os.lstat(declared)
        resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise ContractError(f"{label} is missing or outside the repository") from exc
    if (
        declared != resolved
        or not stat.S_ISREG(metadata.st_mode)
        or _is_reparse(declared)
        or metadata.st_size > MAX_BOUND_FILE_BYTES
    ):
        raise ContractError(f"{label} must be a bounded canonical plain file")
    try:
        before = resolved.stat()
        with resolved.open("rb") as stream:
            opened_before = os.fstat(stream.fileno())
            data = stream.read(MAX_BOUND_FILE_BYTES + 1)
            opened_after = os.fstat(stream.fileno())
        after = resolved.stat()
    except OSError as exc:
        raise ContractError(f"{label} could not be read") from exc
    if (
        len(data) > MAX_BOUND_FILE_BYTES
        or len(data) != before.st_size
        or not (
            _stat_signature(before)
            == _stat_signature(opened_before)
            == _stat_signature(opened_after)
            == _stat_signature(after)
        )
    ):
        raise ContractError(f"{label} changed while being read")
    return data


def canonical_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def parse_execution_lock(data: bytes) -> tuple[dict[str, str], list[str]]:
    """Parse only the frozen directive and exact, marker-free package pins."""

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ContractError("dependency lock is not UTF-8") from exc
    if "\r" in text or not text.endswith("\n"):
        raise ContractError("dependency lock must be LF-terminated")
    pins: dict[str, str] = {}
    directives: list[str] = []
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("--"):
            if line not in EXPECTED_DIRECTIVES:
                raise ContractError(
                    f"dependency lock line {line_number} has a forbidden directive"
                )
            if line in directives:
                raise ContractError(
                    f"dependency lock line {line_number} duplicates a directive"
                )
            directives.append(line)
            continue
        if any(token in line for token in (";", " #", " --", "@")):
            raise ContractError(
                f"dependency lock line {line_number} has forbidden syntax"
            )
        if line.count("==") != 1:
            raise ContractError(
                f"dependency lock line {line_number} is not one exact pin"
            )
        name, version = line.split("==", 1)
        if (
            PACKAGE_NAME_RE.fullmatch(name) is None
            or VERSION_RE.fullmatch(version) is None
        ):
            raise ContractError(
                f"dependency lock line {line_number} is not a portable exact pin"
            )
        package = canonical_package_name(name)
        if package in pins:
            raise ContractError(
                f"dependency lock line {line_number} duplicates package {package}"
            )
        pins[package] = version
    if directives != EXPECTED_DIRECTIVES:
        raise ContractError("dependency lock directive set/order is not frozen")
    if not pins:
        raise ContractError("dependency lock contains no exact package pins")
    return pins, directives


def parse_minimal_pyproject(data: bytes) -> dict[str, dict[str, object]]:
    """Parse the JSON-compatible TOML subset used by the frozen pyproject."""

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ContractError("pyproject is not UTF-8") from exc
    if "\r" in text or not text.endswith("\n"):
        raise ContractError("pyproject must be LF-terminated")
    sections: dict[str, dict[str, object]] = {}
    current: dict[str, object] | None = None
    pending_key: str | None = None
    pending_value: list[str] = []
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            raise ContractError("pyproject contract does not permit comments")
        section_match = SECTION_RE.fullmatch(line)
        if section_match is not None:
            if pending_key is not None:
                raise ContractError("pyproject has an unterminated array")
            section = section_match.group(1)
            if section in sections:
                raise ContractError(f"pyproject duplicates section {section}")
            current = {}
            sections[section] = current
            continue
        if current is None:
            raise ContractError(f"pyproject line {line_number} is outside a section")
        if pending_key is None:
            if "=" not in line:
                raise ContractError(
                    f"pyproject line {line_number} is not an assignment"
                )
            raw_key, raw_value = (part.strip() for part in line.split("=", 1))
            if KEY_RE.fullmatch(raw_key) is None or raw_key in current:
                raise ContractError(f"pyproject line {line_number} has an invalid key")
            pending_key = raw_key
            pending_value = [raw_value]
        else:
            pending_value.append(line)
        joined = " ".join(pending_value)
        if joined.startswith("[") and not joined.endswith("]"):
            continue
        joined = re.sub(r",\s*]$", "]", joined)
        try:
            parsed = json.loads(joined)
        except json.JSONDecodeError as exc:
            raise ContractError(
                f"pyproject value for {pending_key} is outside the supported subset"
            ) from exc
        current[pending_key] = parsed
        pending_key = None
        pending_value = []
    if pending_key is not None:
        raise ContractError("pyproject has an unterminated value")
    return sections


def _hash_bound_file(
    reader: SnapshotReader, relative: str, expected_sha256: object, label: str
) -> dict[str, object]:
    return reader.bind(relative, expected_sha256, label).public_fields()


def _validated_allowlist_rows(
    payload: Mapping[str, object],
) -> list[dict[str, object]]:
    files = payload.get("files")
    if not isinstance(files, list):
        raise ContractError("resolved claim allowlist files must be a list")
    rows: list[dict[str, object]] = []
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ContractError(f"resolved allowlist row {index} must be an object")
        _exact_keys(
            item,
            {"category", "destination", "expected_sha256", "source"},
            f"resolved allowlist row {index}",
        )
        category = item.get("category")
        if type(category) is not str or CATEGORY_RE.fullmatch(category) is None:
            raise ContractError(f"resolved allowlist row {index} has invalid category")
        source = _safe_relative(item.get("source"), f"allowlist row {index} source")
        destination = _safe_relative(
            item.get("destination"), f"allowlist row {index} destination"
        )
        digest = item.get("expected_sha256")
        identity = {
            "category": category,
            "destination": destination,
            "source": source,
        }
        if digest is None:
            if identity != ALLOWLIST_NULL_HASH_EXCEPTION:
                raise ContractError(
                    f"resolved allowlist row {index} has forbidden null SHA-256"
                )
        elif type(digest) is not str or SHA256_RE.fullmatch(digest) is None:
            raise ContractError(f"resolved allowlist row {index} has invalid SHA-256")
        rows.append(
            {
                "category": category,
                "destination": destination,
                "source": source,
                "sha256": digest,
            }
        )
    sources = [str(row["source"]).casefold() for row in rows]
    destinations = [str(row["destination"]).casefold() for row in rows]
    if len(sources) != len(set(sources)):
        raise ContractError("resolved allowlist source paths are globally duplicated")
    if len(destinations) != len(set(destinations)):
        raise ContractError(
            "resolved allowlist destination paths are globally duplicated"
        )
    return sorted(rows, key=lambda row: row["source"])


def _allowlist_rows(
    rows: list[dict[str, object]], category: str
) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    for row in rows:
        if row["category"] != category:
            continue
        if row["source"] != row["destination"]:
            raise ContractError(
                f"resolved allowlist {category} row is not identity-copy"
            )
        source = row["source"]
        digest = row["sha256"]
        if type(source) is not str or type(digest) is not str:
            raise ContractError(
                f"resolved allowlist {category} row lacks a concrete SHA-256"
            )
        selected.append({"path": source, "sha256": digest})
    return selected


def _validated_claim_profile_rows(
    payload: Mapping[str, object],
) -> list[dict[str, object]]:
    files = payload.get("files")
    if not isinstance(files, list):
        raise ContractError("claim-complete profile files must be a list")
    rows: list[dict[str, object]] = []
    mode_counts: dict[str, int] = {}
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ContractError(f"claim-complete row {index} must be an object")
        _exact_keys(
            item,
            {"category", "destination", "inputs", "mode", "source"},
            f"claim-complete row {index}",
        )
        category = item.get("category")
        if type(category) is not str or CATEGORY_RE.fullmatch(category) is None:
            raise ContractError(f"claim-complete row {index} has invalid category")
        source = _safe_relative(item.get("source"), f"claim profile row {index} source")
        destination = _safe_relative(
            item.get("destination"), f"claim profile row {index} destination"
        )
        mode = item.get("mode")
        if type(mode) is not str or mode not in EXPECTED_CLAIM_MODE_COUNTS:
            raise ContractError(f"claim-complete row {index} has invalid mode")
        mode_counts[mode] = mode_counts.get(mode, 0) + 1
        inputs = item.get("inputs")
        if not isinstance(inputs, list):
            raise ContractError(f"claim-complete row {index} inputs must be a list")
        normalized_inputs: list[dict[str, str]] = []
        identity = {
            "category": category,
            "destination": destination,
            "mode": mode,
            "source": source,
        }
        if mode == "copy":
            if source != destination or len(inputs) != 1:
                raise ContractError(
                    f"claim-complete copy row {index} is not one-input identity-copy"
                )
            input_binding = inputs[0]
            if not isinstance(input_binding, dict):
                raise ContractError(
                    f"claim-complete copy row {index} input must be an object"
                )
            _exact_keys(
                input_binding,
                {"expected_sha256", "path"},
                f"claim-complete copy row {index} input",
            )
            _require_typed_equal(
                input_binding,
                {"expected_sha256": "0" * 64, "path": source},
                f"claim-complete copy row {index} input",
            )
        elif mode == "derivation_receipt":
            if identity != CLAIM_ZERO_INPUT_EXCEPTION or inputs:
                raise ContractError(
                    "claim-complete derivation receipt exception differs from v1"
                )
        else:
            if source == destination or len(inputs) != 1:
                raise ContractError(
                    f"claim-complete derivative row {index} has invalid shape"
                )
            input_binding = inputs[0]
            if not isinstance(input_binding, dict):
                raise ContractError(
                    f"claim-complete derivative row {index} input must be an object"
                )
            _exact_keys(
                input_binding,
                {"expected_sha256", "path"},
                f"claim-complete derivative row {index} input",
            )
            _safe_relative(
                input_binding.get("path"),
                f"claim-complete derivative row {index} input path",
            )
            digest = input_binding.get("expected_sha256")
            if type(digest) is not str or SHA256_RE.fullmatch(digest) is None:
                raise ContractError(
                    f"claim-complete derivative row {index} input has invalid SHA-256"
                )
        for input_index, input_binding in enumerate(inputs):
            if not isinstance(input_binding, dict):
                raise ContractError(
                    f"claim-complete row {index} input {input_index} must be an object"
                )
            input_path = _safe_relative(
                input_binding.get("path"),
                f"claim-complete row {index} input {input_index} path",
            )
            input_digest = input_binding.get("expected_sha256")
            if (
                type(input_digest) is not str
                or SHA256_RE.fullmatch(input_digest) is None
            ):
                raise ContractError(
                    f"claim-complete row {index} input {input_index} has invalid SHA-256"
                )
            normalized_inputs.append({"path": input_path, "sha256": input_digest})
        rows.append(
            {
                "category": category,
                "destination": destination,
                "inputs": normalized_inputs,
                "mode": mode,
                "source": source,
            }
        )
    if mode_counts != EXPECTED_CLAIM_MODE_COUNTS:
        raise ContractError("claim-complete mode counts differ from schema v1")
    sources = [row["source"].casefold() for row in rows]
    destinations = [row["destination"].casefold() for row in rows]
    if len(sources) != len(set(sources)):
        raise ContractError("claim-complete source paths are globally duplicated")
    if len(destinations) != len(set(destinations)):
        raise ContractError("claim-complete destination paths are globally duplicated")
    return sorted(rows, key=lambda row: row["source"])


def _claim_profile_paths(rows: list[dict[str, object]], category: str) -> list[str]:
    paths = [row["source"] for row in rows if row["category"] == category]
    if any(type(path) is not str for path in paths):
        raise ContractError("claim profile contains a non-string source path")
    return sorted(str(path) for path in paths)


def _canonical_identity_rows(
    rows: list[dict[str, object]],
) -> list[dict[str, str]]:
    identities: list[dict[str, str]] = []
    for index, row in enumerate(rows):
        category = row.get("category")
        destination = row.get("destination")
        source = row.get("source")
        if not all(type(value) is str for value in (category, destination, source)):
            raise ContractError(f"identity row {index} is not a string triple")
        assert isinstance(category, str)
        assert isinstance(destination, str)
        assert isinstance(source, str)
        identities.append(
            {
                "category": category,
                "destination": destination,
                "source": source,
            }
        )
    return sorted(
        identities,
        key=lambda row: (
            row["source"].casefold(),
            row["destination"].casefold(),
            row["category"],
        ),
    )


def _canonical_identity_digest(rows: list[dict[str, object]]) -> str:
    return hashlib.sha256(
        canonical_json_bytes(_canonical_identity_rows(rows))
    ).hexdigest()


def _validate_package_source_paths(
    paths: list[str], source_root: str, suffix: str
) -> tuple[str, ...]:
    root = PurePosixPath(source_root)
    observed: set[str] = set()
    package_directories: set[PurePosixPath] = set()
    for index, value in enumerate(paths):
        safe = _safe_relative(value, f"wheel source row {index}")
        path = PurePosixPath(safe)
        try:
            relative = path.relative_to(root)
        except ValueError as exc:
            raise ContractError(
                "wheel source is outside the frozen package root"
            ) from exc
        if len(relative.parts) == 0 or path.suffix != suffix:
            raise ContractError(
                "wheel source is not a Python module below package root"
            )
        observed.add(path.as_posix())
        package_directories.add(path.parent)
    if not observed:
        raise ContractError("wheel source set is empty")
    required_initializers = {
        (directory / "__init__.py").as_posix() for directory in package_directories
    }
    if not required_initializers.issubset(observed):
        raise ContractError("wheel source package directory lacks __init__.py")
    return tuple(sorted(observed))


def _controlled_git_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("GIT_")
    }
    environment.update(CONTROLLED_GIT_ENVIRONMENT)
    return environment


def _subject_package_paths(
    git_executable: Path,
    repo_root: Path,
    subject_commit: str,
    project_root: str,
    package_discovery: Mapping[str, object],
    suffix: str,
) -> tuple[str, ...]:
    _require_typed_equal(
        dict(package_discovery),
        EXPECTED_PACKAGE_DISCOVERY,
        "subject package discovery rule",
    )
    safe_project_root = _safe_relative(project_root, "package discovery project root")
    try:
        completed = subprocess.run(
            [
                str(git_executable),
                "--no-pager",
                "--no-replace-objects",
                "-C",
                str(repo_root),
                "ls-tree",
                "-r",
                "-z",
                "--full-tree",
                subject_commit,
                "--",
                safe_project_root,
            ],
            cwd=str(repo_root),
            env=_controlled_git_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ContractError("could not enumerate subject package tree") from exc
    if completed.returncode != 0:
        raise ContractError("subject package tree enumeration failed")
    records: list[tuple[str, str, str]] = []
    for record in completed.stdout.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", maxsplit=1)
            mode, object_type, _object_id = metadata.decode("ascii").split()
            relative = raw_path.decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise ContractError(
                "subject package tree output could not be parsed"
            ) from exc
        safe = _safe_relative(relative, "subject package tree path")
        try:
            project_relative = PurePosixPath(safe).relative_to(
                PurePosixPath(safe_project_root)
            )
        except ValueError as exc:
            raise ContractError(
                "subject package tree escaped the project root"
            ) from exc
        records.append((safe, mode, object_type))
        if not project_relative.parts:
            raise ContractError("subject package tree returned the project root")
    all_paths = [path for path, _mode, _object_type in records]
    if len({path.casefold() for path in all_paths}) != len(all_paths):
        raise ContractError("subject package tree paths are duplicated")

    project = PurePosixPath(safe_project_root)
    included_package_directories: set[PurePosixPath] = set()
    for path, mode, object_type in records:
        relative = PurePosixPath(path).relative_to(project)
        if relative.name != "__init__.py" or len(relative.parts) < 2:
            continue
        package_name = ".".join(relative.parent.parts)
        included = package_name == "lifeline_rl" or package_name.startswith(
            "lifeline_rl."
        )
        if not included:
            continue
        if mode not in {"100644", "100755"} or object_type != "blob":
            raise ContractError("included package initializer is not a regular blob")
        included_package_directories.add(relative.parent)
    if PurePosixPath("lifeline_rl") not in included_package_directories:
        raise ContractError("subject package discovery omitted lifeline_rl")

    selected: list[str] = []
    for path, mode, object_type in records:
        relative = PurePosixPath(path).relative_to(project)
        if relative.parent not in included_package_directories:
            continue
        if mode not in {"100644", "100755"} or object_type != "blob":
            raise ContractError("subject package tree contains a non-regular blob")
        if relative.suffix != suffix:
            raise ContractError("subject package tree contains undeclared package data")
        if relative.parts[0] == "lifeline_rl_autodl":
            raise ContractError("excluded top-level package entered wheel closure")
        selected.append(path)
    return tuple(sorted(selected))


def _assert_subject_paths_absent(
    git_executable: Path,
    repo_root: Path,
    subject_commit: str,
    relative_paths: tuple[str, ...],
) -> None:
    safe_paths = tuple(
        _safe_relative(path, "future subject output") for path in relative_paths
    )
    try:
        completed = subprocess.run(
            [
                str(git_executable),
                "--no-pager",
                "--no-replace-objects",
                "-C",
                str(repo_root),
                "ls-tree",
                "-z",
                "--full-tree",
                subject_commit,
                "--",
                *safe_paths,
            ],
            cwd=str(repo_root),
            env=_controlled_git_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ContractError(
            "could not verify future subject outputs are absent"
        ) from exc
    if completed.returncode != 0 or completed.stdout:
        raise ContractError("future derived output is tracked by the subject commit")


def validate_contract(
    profile_path: Path, repo_root: Path = REPOSITORY_ROOT
) -> ContractValidation:
    """Validate all local bytes and return the exact subject path set."""

    root = repo_root.resolve(strict=True)
    reader = SnapshotReader(root)
    try:
        profile_relative = (
            profile_path.resolve(strict=True).relative_to(root).as_posix()
        )
    except (OSError, ValueError) as exc:
        raise ContractError("profile must be a repository file") from exc
    profile_snapshot = reader.read(profile_relative, "fresh-install profile")
    profile_bytes = profile_snapshot.data
    profile = _strict_json_object(
        profile_bytes, canonical=True, label="fresh-install profile"
    )
    _exact_keys(
        profile,
        {
            "critical_inputs",
            "dependency_lock",
            "independent_receipt_audit",
            "packaging",
            "schema_name",
            "schema_version",
            "scope_boundary",
            "status",
            "target",
            "tests",
        },
        "fresh-install profile",
    )
    _require_typed_equal(
        profile.get("schema_name"), PROFILE_SCHEMA_NAME, "profile schema_name"
    )
    _require_typed_equal(
        profile.get("schema_version"), SCHEMA_VERSION, "profile schema_version"
    )
    _require_typed_equal(
        profile.get("status"),
        "contract_only_not_executed",
        "profile status",
    )
    _require_typed_equal(profile.get("target"), EXPECTED_TARGET, "profile target")
    _require_typed_equal(
        profile.get("scope_boundary"), EXPECTED_SCOPE, "profile scope boundary"
    )

    lock = profile.get("dependency_lock")
    if not isinstance(lock, dict):
        raise ContractError("dependency_lock must be an object")
    _exact_keys(
        lock,
        {"allowed_directives", "expected_package_count", "path", "pins", "sha256"},
        "dependency_lock",
    )
    lock_path = _safe_relative(lock.get("path"), "dependency_lock.path")
    _require_typed_equal(lock_path, EXPECTED_LOCK_PATH, "dependency lock path")
    lock_snapshot = reader.bind(lock_path, lock.get("sha256"), "dependency lock")
    lock_facts = lock_snapshot.public_fields()
    parsed_pins, parsed_directives = parse_execution_lock(lock_snapshot.data)
    _require_typed_equal(
        parsed_pins,
        EXPECTED_LOCK_PINS,
        "dependency lock exact package/version closure",
    )
    _require_typed_equal(
        lock.get("allowed_directives"),
        EXPECTED_DIRECTIVES,
        "profile lock directives",
    )
    _require_typed_equal(
        parsed_directives,
        lock.get("allowed_directives"),
        "dependency lock directives",
    )
    declared_pins = lock.get("pins")
    if not isinstance(declared_pins, dict) or any(
        type(name) is not str or type(version) is not str
        for name, version in declared_pins.items()
    ):
        raise ContractError("profile pins must be a string mapping")
    if not _typed_equal(
        dict(sorted(declared_pins.items())), dict(sorted(parsed_pins.items()))
    ):
        raise ContractError("dependency lock pins differ from profile")
    _require_typed_equal(
        lock.get("expected_package_count"),
        len(EXPECTED_LOCK_PINS),
        "dependency lock package count",
    )

    packaging = profile.get("packaging")
    if not isinstance(packaging, dict):
        raise ContractError("packaging must be an object")
    _exact_keys(
        packaging,
        {
            "build_backend",
            "build_isolation",
            "build_tools",
            "declared_build_requires",
            "declared_optional_dependencies",
            "declared_runtime_dependencies",
            "excluded_top_level_packages",
            "install_project_with_no_deps",
            "installed_distribution_policy",
            "package_discovery",
            "package_discovery_root",
            "project_name",
            "project_version",
            "pyproject_path",
            "pyproject_sha256",
            "requires_python",
            "wheel_source_allowlist_category",
            "wheel_source_root",
            "wheel_source_suffix",
            "wheel_top_level_packages",
        },
        "packaging",
    )
    _require_typed_equal(
        {
            "build_backend": packaging.get("build_backend"),
            "declared_build_requires": packaging.get("declared_build_requires"),
            "declared_optional_dependencies": packaging.get(
                "declared_optional_dependencies"
            ),
            "declared_runtime_dependencies": packaging.get(
                "declared_runtime_dependencies"
            ),
            "excluded_top_level_packages": packaging.get("excluded_top_level_packages"),
            "package_discovery": packaging.get("package_discovery"),
            "package_discovery_root": packaging.get("package_discovery_root"),
            "project_name": packaging.get("project_name"),
            "project_version": packaging.get("project_version"),
            "requires_python": packaging.get("requires_python"),
        },
        {
            "build_backend": EXPECTED_BUILD_BACKEND,
            "declared_build_requires": EXPECTED_DECLARED_BUILD_REQUIRES,
            "declared_optional_dependencies": EXPECTED_DECLARED_OPTIONAL_DEPENDENCIES,
            "declared_runtime_dependencies": EXPECTED_DECLARED_RUNTIME_DEPENDENCIES,
            "excluded_top_level_packages": EXPECTED_EXCLUDED_TOP_LEVEL_PACKAGES,
            "package_discovery": EXPECTED_PACKAGE_DISCOVERY,
            "package_discovery_root": EXPECTED_PACKAGE_DISCOVERY_ROOT,
            "project_name": EXPECTED_PROJECT_NAME,
            "project_version": EXPECTED_PROJECT_VERSION,
            "requires_python": EXPECTED_REQUIRES_PYTHON,
        },
        "complete packaging semantics",
    )
    pyproject_path = _safe_relative(
        packaging.get("pyproject_path"), "packaging.pyproject_path"
    )
    _require_typed_equal(
        pyproject_path, EXPECTED_PYPROJECT_PATH, "packaging pyproject path"
    )
    pyproject_snapshot = reader.bind(
        pyproject_path, packaging.get("pyproject_sha256"), "pyproject"
    )
    pyproject_facts = pyproject_snapshot.public_fields()
    pyproject = parse_minimal_pyproject(pyproject_snapshot.data)
    expected_pyproject = {
        "build-system": {
            "build-backend": EXPECTED_BUILD_BACKEND,
            "requires": EXPECTED_DECLARED_BUILD_REQUIRES,
        },
        "project": {
            "dependencies": EXPECTED_DECLARED_RUNTIME_DEPENDENCIES,
            "description": "Dependency-free reference environment for topology-aware LIFELINE self-play",
            "name": EXPECTED_PROJECT_NAME,
            "requires-python": EXPECTED_REQUIRES_PYTHON,
            "version": EXPECTED_PROJECT_VERSION,
        },
        "project.optional-dependencies": EXPECTED_DECLARED_OPTIONAL_DEPENDENCIES,
        "tool.setuptools.packages.find": EXPECTED_PACKAGE_DISCOVERY,
    }
    _require_typed_equal(pyproject, expected_pyproject, "pyproject packaging semantics")
    if packaging.get("build_isolation") is not False:
        raise ContractError("packaging contract must disable build isolation")
    if packaging.get("install_project_with_no_deps") is not True:
        raise ContractError("packaging contract must install the project with no deps")
    _require_typed_equal(
        packaging.get("wheel_top_level_packages"),
        EXPECTED_WHEEL_TOP_LEVEL_PACKAGES,
        "project wheel top-level package set",
    )
    _require_typed_equal(
        packaging.get("package_discovery"),
        EXPECTED_PACKAGE_DISCOVERY,
        "project package discovery",
    )
    _require_typed_equal(
        packaging.get("package_discovery_root"),
        EXPECTED_PACKAGE_DISCOVERY_ROOT,
        "project package discovery root",
    )
    _require_typed_equal(
        packaging.get("excluded_top_level_packages"),
        EXPECTED_EXCLUDED_TOP_LEVEL_PACKAGES,
        "excluded top-level package set",
    )
    build_tools = packaging.get("build_tools")
    _require_typed_equal(
        build_tools,
        {
            "setuptools": EXPECTED_LOCK_PINS["setuptools"],
            "wheel": EXPECTED_LOCK_PINS["wheel"],
        },
        "exact build tools",
    )
    distribution_policy = packaging.get("installed_distribution_policy")
    expected_distribution_policy = {
        "expected_distribution_count": EXPECTED_INSTALLED_DISTRIBUTION_COUNT,
        "lock_pins_source": "dependency_lock.pins",
        "pip": {
            "pre_pinned": False,
            "receipt_binding_required": True,
            "version_policy": "record_exact_at_execution",
        },
        "project": {
            "name": EXPECTED_PROJECT_NAME,
            "version": EXPECTED_PROJECT_VERSION,
        },
        "unexpected_distribution_policy": "BLOCKED",
    }
    _require_typed_equal(
        distribution_policy,
        expected_distribution_policy,
        "installed distribution policy",
    )
    wheel_category = packaging.get("wheel_source_allowlist_category")
    _require_typed_equal(
        wheel_category,
        "reference_implementation",
        "wheel source allowlist category",
    )
    wheel_source_root = _safe_relative(
        packaging.get("wheel_source_root"), "packaging.wheel_source_root"
    )
    _require_typed_equal(
        wheel_source_root,
        EXPECTED_WHEEL_SOURCE_ROOT,
        "wheel source root",
    )
    _require_typed_equal(
        packaging.get("wheel_source_suffix"),
        EXPECTED_WHEEL_SOURCE_SUFFIX,
        "wheel source suffix",
    )

    critical = profile.get("critical_inputs")
    if not isinstance(critical, list):
        raise ContractError("critical_inputs must be a list")
    critical_facts: list[dict[str, object]] = []
    critical_by_role: dict[str, str] = {}
    for index, item in enumerate(critical):
        if not isinstance(item, dict):
            raise ContractError(f"critical input {index} must be an object")
        _exact_keys(item, {"path", "role", "sha256"}, f"critical input {index}")
        role = item.get("role")
        if type(role) is not str or role in critical_by_role:
            raise ContractError(f"critical input {index} has invalid/duplicate role")
        relative = _safe_relative(item.get("path"), f"critical input {index} path")
        critical_by_role[role] = relative
        critical_facts.append(
            {
                "role": role,
                **_hash_bound_file(
                    reader, relative, item.get("sha256"), f"critical input {role}"
                ),
            }
        )
    if critical_by_role != EXPECTED_CRITICAL_PATHS:
        raise ContractError("critical input role/path mapping differs from schema v1")
    if len({path.casefold() for path in critical_by_role.values()}) != len(critical):
        raise ContractError("critical input paths are duplicated")

    independent = profile.get("independent_receipt_audit")
    if not isinstance(independent, dict):
        raise ContractError("independent_receipt_audit must be an object")
    _exact_keys(
        independent,
        {
            "compact_verifier_contract",
            "compact_independent_verifier_status",
            "execution_ready",
            "frozen_prior_evidence",
            "full_evidence_runner",
        },
        "independent_receipt_audit",
    )
    _require_typed_equal(
        independent.get("compact_independent_verifier_status"),
        "implemented",
        "compact independent verifier status",
    )
    _require_typed_equal(
        independent.get("execution_ready"),
        True,
        "compact independent verifier execution readiness",
    )
    compact = independent.get("compact_verifier_contract")
    prior = independent.get("frozen_prior_evidence")
    full_runner = independent.get("full_evidence_runner")
    if (
        not isinstance(compact, dict)
        or not isinstance(prior, dict)
        or not isinstance(full_runner, dict)
    ):
        raise ContractError("independent receipt audit subcontracts must be objects")
    _exact_keys(
        compact,
        {
            "clean_copy_compatible",
            "expected_distinct_tracked_inputs",
            "expected_exit_code",
            "expected_manifest_byte_pin_enforced",
            "expected_public_verdict",
            "expected_skips",
            "limitations",
            "output_mode",
            "path",
            "scope",
            "sha256",
            "tracked_input_bindings",
        },
        "compact verifier contract",
    )
    _exact_keys(prior, {"path", "scope", "sha256"}, "frozen prior audit evidence")
    _exact_keys(
        full_runner,
        {"clean_copy_compatible", "path", "requires_ignored_raw_artifacts", "sha256"},
        "full-evidence audit runner",
    )
    compact_path = _safe_relative(compact.get("path"), "compact audit runner path")
    prior_path = _safe_relative(prior.get("path"), "frozen prior audit path")
    full_runner_path = _safe_relative(full_runner.get("path"), "full audit runner path")
    if (
        compact_path != critical_by_role["compact_independent_receipt_auditor"]
        or prior_path != critical_by_role["prior_independent_audit_receipt"]
        or full_runner_path != critical_by_role["full_evidence_independent_auditor"]
    ):
        raise ContractError("independent audit paths differ from critical inputs")
    _require_typed_equal(
        compact_path,
        EXPECTED_COMPACT_VERIFIER_PATH,
        "compact independent verifier path",
    )
    _require_typed_equal(
        compact.get("clean_copy_compatible"),
        True,
        "compact verifier clean-copy compatibility",
    )
    _require_typed_equal(
        compact.get("scope"),
        "tracked_metadata_consistency_only",
        "compact verifier scope",
    )
    _require_typed_equal(
        compact.get("expected_public_verdict"),
        EXPECTED_COMPACT_PUBLIC_VERDICT,
        "compact verifier public verdict",
    )
    _require_typed_equal(
        compact.get("expected_exit_code"), 0, "compact verifier exit code"
    )
    _require_typed_equal(
        compact.get("expected_skips"), 0, "compact verifier skip count"
    )
    _require_typed_equal(
        compact.get("expected_distinct_tracked_inputs"),
        11,
        "compact verifier distinct tracked input count",
    )
    _require_typed_equal(
        compact.get("expected_manifest_byte_pin_enforced"),
        True,
        "compact verifier manifest byte pin",
    )
    _require_typed_equal(
        compact.get("output_mode"),
        "capture_stdout_no_output_arg",
        "compact verifier output mode",
    )
    _require_typed_equal(
        compact.get("limitations"),
        EXPECTED_COMPACT_LIMITATIONS,
        "compact verifier limitations",
    )
    _require_typed_equal(
        prior.get("scope"),
        "prior_retained_environment_only_not_clean_copy_execution",
        "prior independent audit scope",
    )
    _require_typed_equal(
        full_runner.get("clean_copy_compatible"),
        False,
        "full-evidence runner clean-copy compatibility",
    )
    _require_typed_equal(
        full_runner.get("requires_ignored_raw_artifacts"),
        True,
        "full-evidence runner raw-artifact requirement",
    )
    prior_facts = _hash_bound_file(
        reader, prior_path, prior.get("sha256"), "frozen prior audit evidence"
    )
    full_runner_facts = _hash_bound_file(
        reader,
        full_runner_path,
        full_runner.get("sha256"),
        "full-evidence audit runner",
    )
    compact_verifier_facts = _hash_bound_file(
        reader,
        compact_path,
        compact.get("sha256"),
        "compact independent verifier",
    )
    _require_typed_equal(
        compact_verifier_facts["sha256"],
        EXPECTED_COMPACT_VERIFIER_SHA256,
        "compact independent verifier frozen SHA-256",
    )
    raw_bindings = compact.get("tracked_input_bindings")
    if not isinstance(raw_bindings, list) or not raw_bindings:
        raise ContractError("compact audit tracked bindings must be non-empty")
    compact_binding_facts: list[dict[str, object]] = []
    compact_binding_paths: list[str] = []
    for index, item in enumerate(raw_bindings):
        if not isinstance(item, dict):
            raise ContractError(f"compact audit binding {index} must be an object")
        _exact_keys(item, {"path", "sha256"}, f"compact audit binding {index}")
        relative = _safe_relative(
            item.get("path"), f"compact audit binding {index} path"
        )
        compact_binding_paths.append(relative)
        compact_binding_facts.append(
            _hash_bound_file(
                reader,
                relative,
                item.get("sha256"),
                f"compact audit binding {index}",
            )
        )
    if len({path.casefold() for path in compact_binding_paths}) != len(
        compact_binding_paths
    ):
        raise ContractError("compact audit tracked bindings are duplicated")
    if len(compact_binding_paths) != 11:
        raise ContractError("compact audit must bind exactly 11 distinct inputs")
    if set(compact_binding_paths) != EXPECTED_COMPACT_BINDING_PATHS:
        raise ContractError(
            "compact audit tracked bindings differ from the exact schema v1 path set"
        )

    tests = profile.get("tests")
    if not isinstance(tests, dict):
        raise ContractError("tests must be an object")
    _exact_keys(
        tests,
        {
            "allowlist_category",
            "allowlist_path",
            "claim_profile_path",
            "expected_allowlist_count",
            "expected_reference_source_count",
            "groups",
            "skip_policy",
            "support_files",
        },
        "tests",
    )
    allowlist_path = _safe_relative(tests.get("allowlist_path"), "tests.allowlist_path")
    claim_profile_path = _safe_relative(
        tests.get("claim_profile_path"), "tests.claim_profile_path"
    )
    if allowlist_path != critical_by_role["resolved_claim_allowlist"]:
        raise ContractError("tests allowlist path differs from critical input")
    if claim_profile_path != critical_by_role["claim_complete_profile"]:
        raise ContractError("tests claim profile path differs from critical input")
    _require_typed_equal(
        tests.get("allowlist_category"),
        "targeted_test",
        "tests allowlist category",
    )
    _require_typed_equal(
        tests.get("skip_policy"),
        {"allowed": [], "mode": "deny_all"},
        "test skip policy",
    )

    allowlist_snapshot = reader.read(allowlist_path, "resolved claim allowlist")
    allowlist = _strict_json_object(
        allowlist_snapshot.data,
        canonical=False,
        label="resolved claim allowlist",
    )
    _exact_keys(
        allowlist,
        {
            "files",
            "limits",
            "package_name",
            "purpose",
            "require_git_tracked",
            "schema_version",
            "status",
        },
        "resolved claim allowlist",
    )
    _require_typed_equal(
        allowlist.get("schema_version"), 1, "resolved allowlist schema_version"
    )
    _require_typed_equal(
        allowlist.get("status"),
        "candidate_only_not_approved",
        "resolved allowlist status",
    )
    _require_typed_equal(
        allowlist.get("require_git_tracked"),
        False,
        "resolved allowlist require_git_tracked",
    )
    _require_typed_equal(
        {
            "limits": allowlist.get("limits"),
            "package_name": allowlist.get("package_name"),
            "purpose": allowlist.get("purpose"),
        },
        {
            "limits": {
                "max_file_bytes": 1048576,
                "max_total_bytes": 8388608,
            },
            "package_name": "lifeline_rl_claim_complete_candidate",
            "purpose": (
                "anonymous C1-C10 code, protocol, aggregate, and verifier "
                "review candidate"
            ),
        },
        "resolved allowlist header",
    )
    all_allowlist_rows = _validated_allowlist_rows(allowlist)
    targeted_rows = _allowlist_rows(all_allowlist_rows, "targeted_test")
    assert isinstance(wheel_category, str)
    reference_rows = _allowlist_rows(all_allowlist_rows, wheel_category)
    _require_typed_equal(
        tests.get("expected_allowlist_count"),
        EXPECTED_TARGETED_TEST_COUNT,
        "targeted test count",
    )
    _require_typed_equal(
        tests.get("expected_reference_source_count"),
        EXPECTED_REFERENCE_SOURCE_COUNT,
        "reference source count",
    )
    targeted_paths = [row["path"] for row in targeted_rows]
    if (
        len(targeted_paths) != EXPECTED_TARGETED_TEST_COUNT
        or set(targeted_paths) != EXPECTED_TARGETED_TEST_PATHS
    ):
        raise ContractError("resolved allowlist targeted test closure differs from v1")
    if len(reference_rows) != EXPECTED_REFERENCE_SOURCE_COUNT:
        raise ContractError("resolved allowlist reference source count differs from v1")

    claim_profile_snapshot = reader.read(claim_profile_path, "claim-complete profile")
    claim_profile = _strict_json_object(
        claim_profile_snapshot.data,
        canonical=False,
        label="claim-complete profile",
    )
    _exact_keys(
        claim_profile,
        {
            "approval",
            "claim_ids",
            "descriptive_only_destinations",
            "files",
            "schema_version",
            "status",
        },
        "claim-complete profile",
    )
    _require_typed_equal(
        claim_profile.get("schema_version"), 1, "claim profile schema_version"
    )
    _require_typed_equal(
        claim_profile.get("status"),
        "candidate_only_not_approved",
        "claim profile status",
    )
    _require_typed_equal(
        claim_profile.get("approval"),
        "author_approval_required",
        "claim profile approval",
    )
    _require_typed_equal(
        claim_profile.get("claim_ids"),
        [f"C{index}" for index in range(1, 11)],
        "claim profile claim_ids",
    )
    _require_typed_equal(
        claim_profile.get("descriptive_only_destinations"),
        EXPECTED_CLAIM_DESCRIPTIVE_DESTINATIONS,
        "claim profile descriptive-only destinations",
    )
    claim_rows = _validated_claim_profile_rows(claim_profile)
    allowlist_identities = _canonical_identity_rows(all_allowlist_rows)
    claim_identities = _canonical_identity_rows(claim_rows)
    if len(allowlist_identities) != EXPECTED_CLAIM_ROW_COUNT:
        raise ContractError("resolved allowlist row count differs from schema v1")
    if len(claim_identities) != EXPECTED_CLAIM_ROW_COUNT:
        raise ContractError("claim profile row count differs from schema v1")
    if not _typed_equal(allowlist_identities, claim_identities):
        raise ContractError(
            "claim profile and resolved allowlist full identity triples differ"
        )
    allowlist_identity_digest = _canonical_identity_digest(all_allowlist_rows)
    claim_identity_digest = _canonical_identity_digest(claim_rows)
    if (
        allowlist_identity_digest != EXPECTED_CLAIM_TRIPLE_SHA256
        or claim_identity_digest != EXPECTED_CLAIM_TRIPLE_SHA256
    ):
        raise ContractError("claim/allowlist canonical identity digest differs from v1")
    categories = {row["category"] for row in claim_identities}
    if len(categories) != EXPECTED_CLAIM_CATEGORY_COUNT:
        raise ContractError("claim/allowlist category count differs from schema v1")

    allowlist_by_identity = {
        (row["category"], row["destination"], row["source"]): row
        for row in all_allowlist_rows
    }
    verified_copy_sources: list[dict[str, object]] = []
    verified_derivative_inputs: list[dict[str, object]] = []
    future_derived_outputs: list[dict[str, object]] = []
    for index, row in enumerate(claim_rows):
        category = row["category"]
        destination = row["destination"]
        source = row["source"]
        mode = row["mode"]
        inputs = row["inputs"]
        assert isinstance(category, str)
        assert isinstance(destination, str)
        assert isinstance(source, str)
        assert isinstance(mode, str)
        assert isinstance(inputs, list)
        allowlist_row = allowlist_by_identity[(category, destination, source)]
        expected_output_sha256 = allowlist_row["sha256"]
        if mode == "copy":
            if type(expected_output_sha256) is not str:
                raise ContractError(
                    f"claim-complete copy row {index} lacks an output/source hash"
                )
            input_binding = inputs[0]
            assert isinstance(input_binding, dict)
            declared_input_sha256 = input_binding["sha256"]
            assert declared_input_sha256 == "0" * 64
            source_facts = _hash_bound_file(
                reader,
                source,
                expected_output_sha256,
                f"claim-complete copy source {index}",
            )
            verified_copy_sources.append(
                {
                    **source_facts,
                    "claim_profile_input_sha256": declared_input_sha256,
                    "claim_profile_uses_subject_bound_hash_placeholder": (
                        declared_input_sha256 == "0" * 64
                    ),
                }
            )
            continue
        future_derived_outputs.append(
            {
                "category": category,
                "destination": destination,
                "expected_output_sha256": expected_output_sha256,
                "mode": mode,
                "path": source,
            }
        )
        if mode == "derivation_receipt":
            if expected_output_sha256 is not None or inputs:
                raise ContractError(
                    "derivation receipt must remain the unique null/zero-input exception"
                )
            continue
        if len(inputs) != 1:
            raise ContractError(
                f"claim-complete derivative row {index} must bind one input"
            )
        input_binding = inputs[0]
        if not isinstance(input_binding, dict):
            raise ContractError(
                f"claim-complete derivative row {index} input must be an object"
            )
        verified_derivative_inputs.append(
            _hash_bound_file(
                reader,
                str(input_binding["path"]),
                input_binding["sha256"],
                f"claim-complete derivative input {index}",
            )
        )
    if len(verified_copy_sources) != EXPECTED_CLAIM_COPY_COUNT:
        raise ContractError("claim-complete copy byte-binding count differs from v1")
    if len(verified_derivative_inputs) != EXPECTED_CLAIM_DERIVATIVE_INPUT_COUNT:
        raise ContractError("claim-complete derivative input count differs from v1")
    if len(future_derived_outputs) != EXPECTED_FUTURE_DERIVED_OUTPUT_COUNT:
        raise ContractError("future derived output count differs from schema v1")
    future_derived_output_paths = tuple(
        sorted(str(row["path"]) for row in future_derived_outputs)
    )
    _assert_relative_paths_absent(root, future_derived_output_paths)

    if _claim_profile_paths(claim_rows, "targeted_test") != targeted_paths:
        raise ContractError(
            "claim profile and resolved allowlist targeted tests differ"
        )
    reference_paths = [row["path"] for row in reference_rows]
    if _claim_profile_paths(claim_rows, wheel_category) != reference_paths:
        raise ContractError(
            "claim profile and resolved allowlist wheel source sets differ"
        )
    package_source_paths = _validate_package_source_paths(
        reference_paths, wheel_source_root, EXPECTED_WHEEL_SOURCE_SUFFIX
    )

    support = tests.get("support_files")
    groups = tests.get("groups")
    if not isinstance(support, list) or not isinstance(groups, dict):
        raise ContractError("test support/groups have invalid types")
    _require_typed_equal(
        support,
        list(EXPECTED_TEST_SUPPORT),
        "test support file closure",
    )
    _require_typed_equal(
        groups,
        {name: list(paths) for name, paths in EXPECTED_TEST_GROUPS.items()},
        "test group path closure",
    )
    selected: list[str] = []
    for index, value in enumerate(support):
        selected.append(_safe_relative(value, f"test support file {index}"))
    group_counts: dict[str, int] = {}
    for group_name in sorted(groups):
        paths = groups[group_name]
        if not isinstance(paths, list) or not paths:
            raise ContractError(f"test group {group_name} must be a non-empty list")
        group_counts[group_name] = len(paths)
        for index, value in enumerate(paths):
            selected.append(
                _safe_relative(value, f"test group {group_name} row {index}")
            )
    if len({path.casefold() for path in selected}) != len(selected):
        raise ContractError("selected test paths are duplicated across groups/support")
    if sorted(selected) != targeted_paths:
        raise ContractError("selected test paths differ from all 29 allowlist entries")

    verified_targeted: list[dict[str, object]] = []
    verified_reference: list[dict[str, object]] = []
    for row in targeted_rows:
        verified_targeted.append(
            _hash_bound_file(reader, row["path"], row["sha256"], "targeted test")
        )
    for row in reference_rows:
        verified_reference.append(
            _hash_bound_file(reader, row["path"], row["sha256"], "wheel source")
        )

    intended_frozen_paths = {
        profile_relative,
        lock_path,
        pyproject_path,
        *critical_by_role.values(),
        *compact_binding_paths,
        *targeted_paths,
        *package_source_paths,
        *(str(row["path"]) for row in verified_copy_sources),
        *(str(row["path"]) for row in verified_derivative_inputs),
    }
    snapshots = reader.snapshots()
    if {snapshot.relative for snapshot in snapshots} != intended_frozen_paths:
        raise ContractError("contract snapshot set differs from frozen subject paths")
    frozen_paths = tuple(sorted(intended_frozen_paths))
    return ContractValidation(
        public={
            "contract": {
                "path": profile_relative,
                "schema_name": PROFILE_SCHEMA_NAME,
                "schema_version": SCHEMA_VERSION,
                "sha256": profile_snapshot.sha256,
                "status": "contract_only_not_executed",
            },
            "critical_inputs": sorted(
                critical_facts, key=lambda item: str(item["role"])
            ),
            "dependency_lock": {
                **lock_facts,
                "allowed_directives": parsed_directives,
                "package_count": len(parsed_pins),
                "pins": dict(sorted(parsed_pins.items())),
            },
            "independent_receipt_audit": {
                "compact_independent_verifier_status": "implemented",
                "compact_verifier_contract": {
                    **compact_verifier_facts,
                    "clean_copy_compatible": True,
                    "distinct_tracked_inputs": len(compact_binding_paths),
                    "executed_by_contract_verifier": False,
                    "expected_distinct_tracked_inputs": 11,
                    "expected_exit_code": 0,
                    "expected_manifest_byte_pin_enforced": True,
                    "expected_public_verdict": EXPECTED_COMPACT_PUBLIC_VERDICT,
                    "expected_skips": 0,
                    "limitations": dict(EXPECTED_COMPACT_LIMITATIONS),
                    "manifest_byte_pin_enforced": True,
                    "output_mode": "capture_stdout_no_output_arg",
                    "scope": "tracked_metadata_consistency_only",
                    "tracked_input_bindings": compact_binding_facts,
                },
                "execution_ready": True,
                "frozen_prior_evidence": prior_facts,
                "full_evidence_runner": {
                    **full_runner_facts,
                    "clean_copy_compatible": False,
                    "requires_ignored_raw_artifacts": True,
                },
            },
            "claim_allowlist_closure": {
                "canonical_triple_sha256": EXPECTED_CLAIM_TRIPLE_SHA256,
                "category_count": len(categories),
                "copy_rows_with_verified_source_bytes": len(verified_copy_sources),
                "copy_source_bindings": verified_copy_sources,
                "derivative_input_bindings": verified_derivative_inputs,
                "derivative_rows_with_verified_input_bytes": len(
                    verified_derivative_inputs
                ),
                "future_derived_outputs": future_derived_outputs,
                "future_derived_outputs_generated": False,
                "future_derived_outputs_status": "future_contract_only_not_generated",
                "full_two_way_identity_equal": True,
                "row_count": len(claim_identities),
                "verified_derived_output_bytes": 0,
            },
            "packaging": {
                "build_backend": EXPECTED_BUILD_BACKEND,
                "build_isolation": False,
                "build_tools": build_tools,
                "declared_build_requires": EXPECTED_DECLARED_BUILD_REQUIRES,
                "declared_optional_dependencies": EXPECTED_DECLARED_OPTIONAL_DEPENDENCIES,
                "declared_runtime_dependencies": EXPECTED_DECLARED_RUNTIME_DEPENDENCIES,
                "excluded_top_level_packages": EXPECTED_EXCLUDED_TOP_LEVEL_PACKAGES,
                "install_project_with_no_deps": True,
                "installed_distribution_policy": distribution_policy,
                "package_discovery": EXPECTED_PACKAGE_DISCOVERY,
                "package_discovery_root": EXPECTED_PACKAGE_DISCOVERY_ROOT,
                "project_name": EXPECTED_PROJECT_NAME,
                "project_version": EXPECTED_PROJECT_VERSION,
                "pyproject": pyproject_facts,
                "requires_python": EXPECTED_REQUIRES_PYTHON,
                "subject_package_source_closure_verified": False,
                "wheel_source_count": len(verified_reference),
                "wheel_source_root": wheel_source_root,
                "wheel_source_suffix": EXPECTED_WHEEL_SOURCE_SUFFIX,
                "wheel_sources": verified_reference,
                "wheel_top_level_packages": EXPECTED_WHEEL_TOP_LEVEL_PACKAGES,
            },
            "target": dict(EXPECTED_TARGET),
            "tests": {
                "allowlist_sha256": allowlist_snapshot.sha256,
                "group_counts": group_counts,
                "skip_policy": {"allowed": [], "mode": "deny_all"},
                "support_file_count": len(support),
                "targeted_test_count": len(verified_targeted),
                "targeted_tests": verified_targeted,
            },
        },
        frozen_paths=frozen_paths,
        future_derived_output_paths=future_derived_output_paths,
        package_source_paths=package_source_paths,
        snapshots=snapshots,
    )


def portable_path(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(repo_root.resolve()).as_posix()
    except (OSError, ValueError):
        return "<external>"


def _canonical_plain_directory(path: Path, label: str) -> Path:
    try:
        declared = path.absolute()
        resolved = declared.resolve(strict=True)
        metadata = os.lstat(declared)
    except OSError as exc:
        raise ContractError(f"{label} must already exist") from exc
    if (
        declared != resolved
        or not stat.S_ISDIR(metadata.st_mode)
        or _is_reparse(declared)
    ):
        raise ContractError(f"{label} must be a canonical plain directory")
    return resolved


def validate_output_path(output: Path, repo_root: Path = REPOSITORY_ROOT) -> Path:
    if output.suffix != ".json":
        raise ContractError("output filename must have the exact .json suffix")
    declared = output.absolute()
    try:
        os.lstat(declared)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ContractError("output target could not be inspected") from exc
    else:
        raise ContractError("output target must not already exist")
    parent = _canonical_plain_directory(declared.parent, "output parent")
    candidate = parent / declared.name
    if candidate != declared:
        raise ContractError("output target must use a canonical parent path")
    root = repo_root.resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError:
        return candidate
    allowed_root = _canonical_plain_directory(
        root / "research" / "iclr2027" / "results" / "validation",
        "repository output root",
    )
    try:
        relative = candidate.relative_to(allowed_root)
    except ValueError as exc:
        raise ContractError(
            "repository output must be under research/iclr2027/results/validation"
        ) from exc
    if not relative.parts:
        raise ContractError("output target must name a JSON file")
    return candidate


def _repo_relative_tool(path: Path, repo_root: Path, label: str) -> str:
    try:
        return path.resolve(strict=True).relative_to(repo_root.resolve()).as_posix()
    except (OSError, ValueError) as exc:
        raise ContractError(f"{label} must be inside the repository") from exc


def build_report(
    profile_path: Path,
    subject_commit: str,
    subject_tree: str,
    *,
    repo_root: Path = REPOSITORY_ROOT,
    implementation_path: Path | None = None,
    subject_binding_path: Path | None = None,
) -> dict[str, object]:
    implementation = (implementation_path or Path(__file__)).resolve(strict=True)
    binding_source = (subject_binding_path or SUBJECT_BINDING_SOURCE).resolve(
        strict=True
    )
    root = repo_root.resolve(strict=True)
    try:
        binding = parse_subject_binding(subject_commit, subject_tree)
    except SubjectBindingError as exc:
        return {
            "blockers": [str(exc)],
            "implementation": None,
            "ok": False,
            "schema_name": RECEIPT_SCHEMA_NAME,
            "schema_version": SCHEMA_VERSION,
            "publication": dict(PUBLICATION_BOUNDARY),
            "scope_boundary": dict(EXPECTED_SCOPE),
            "status": "BLOCKED",
            "subject": {
                "subject_binding_verified": False,
                "subject_commit": None,
                "subject_tree": None,
            },
            "verification_boundary": dict(VERIFICATION_BOUNDARY),
        }
    tool_reader = SnapshotReader(root)
    implementation_relative = _repo_relative_tool(
        implementation, root, "profile verifier"
    )
    binding_relative = _repo_relative_tool(
        binding_source, root, "subject-binding source"
    )
    implementation_snapshot = tool_reader.read(
        implementation_relative, "profile verifier"
    )
    binding_snapshot = tool_reader.read(binding_relative, "subject-binding source")
    report: dict[str, object] = {
        "blockers": [],
        "implementation": {
            "profile_verifier": {
                **implementation_snapshot.public_fields(),
            },
            "subject_binding": {
                **binding_snapshot.public_fields(),
            },
        },
        "ok": False,
        "publication": dict(PUBLICATION_BOUNDARY),
        "schema_name": RECEIPT_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "scope_boundary": dict(EXPECTED_SCOPE),
        "status": "BLOCKED",
        "subject": {
            "subject_binding_verified": False,
            "subject_commit": binding.commit,
            "subject_tree": binding.tree,
        },
        "verification_boundary": dict(VERIFICATION_BOUNDARY),
    }
    blockers = report["blockers"]
    assert isinstance(blockers, list)
    try:
        validation = validate_contract(profile_path, root)
        report.update(validation.public)
        snapshot = verify_subject_repository(
            root,
            binding.commit,
            binding.tree,
            frozen_paths=validation.frozen_paths,
            tool_paths=[implementation, binding_source],
        )
        assert_subject_snapshot_unchanged(snapshot)
        validation.assert_future_outputs_absent(root)
        _assert_subject_paths_absent(
            snapshot.git_executable,
            root,
            binding.commit,
            validation.future_derived_output_paths,
        )
        packaging_report = report["packaging"]
        assert isinstance(packaging_report, dict)
        project_root = packaging_report["package_discovery_root"]
        package_discovery = packaging_report["package_discovery"]
        source_suffix = packaging_report["wheel_source_suffix"]
        assert isinstance(project_root, str)
        assert isinstance(package_discovery, dict)
        assert isinstance(source_suffix, str)
        first_subject_package_paths = _subject_package_paths(
            snapshot.git_executable,
            root,
            binding.commit,
            project_root,
            package_discovery,
            source_suffix,
        )
        if first_subject_package_paths != validation.package_source_paths:
            raise ContractError(
                "subject package tree differs from the exact wheel source closure"
            )
        assert_subject_snapshot_unchanged(snapshot)
        validation.assert_local_bytes_unchanged(root)
        validation.assert_future_outputs_absent(root)
        _assert_subject_paths_absent(
            snapshot.git_executable,
            root,
            binding.commit,
            validation.future_derived_output_paths,
        )
        _assert_snapshots_unchanged(
            root,
            tool_reader.snapshots(),
            "tool source bytes changed after first package enumeration",
        )
        second_subject_package_paths = _subject_package_paths(
            snapshot.git_executable,
            root,
            binding.commit,
            project_root,
            package_discovery,
            source_suffix,
        )
        if (
            second_subject_package_paths != first_subject_package_paths
            or second_subject_package_paths != validation.package_source_paths
        ):
            raise ContractError(
                "repeated subject package tree enumerations differ from closure"
            )
        assert_subject_snapshot_unchanged(snapshot)
        validation.assert_local_bytes_unchanged(root)
        validation.assert_future_outputs_absent(root)
        _assert_subject_paths_absent(
            snapshot.git_executable,
            root,
            binding.commit,
            validation.future_derived_output_paths,
        )
        _assert_snapshots_unchanged(
            root,
            tool_reader.snapshots(),
            "tool source bytes changed after final subject verification",
        )
        packaging_report["subject_package_source_closure_verified"] = True
        report["subject"] = {
            **snapshot.public_fields(),
            "git_executable_sha256": snapshot.git_executable_sha256,
            "git_executable_size_bytes": snapshot.git_executable_size_bytes,
        }
    except (
        ContractError,
        SubjectBindingError,
        OSError,
        UnicodeError,
        ValueError,
    ) as exc:
        blockers.append(str(exc))
    report["blockers"] = sorted(set(blockers))
    if not report["blockers"]:
        report["ok"] = True
        report["status"] = "PASS"
    return report


def render_report(report: Mapping[str, object]) -> str:
    return canonical_json_bytes(report).decode("utf-8")


def _blocked_publication_report(
    report: Mapping[str, object], blocker: str
) -> dict[str, object]:
    blocked = dict(report)
    raw_blockers = blocked.get("blockers")
    blockers = (
        [item for item in raw_blockers if isinstance(item, str)]
        if isinstance(raw_blockers, list)
        else []
    )
    blockers.append(blocker)
    blocked["blockers"] = sorted(set(blockers))
    blocked["ok"] = False
    blocked["status"] = "BLOCKED"
    return blocked


def _write_all_fd(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset:])
        if type(written) is not int or written <= 0:
            raise OSError("short output receipt write")
        offset += written


def _file_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode)


def _path_matches_created_plain_file(
    output_path: Path, created_identity: tuple[int, int, int]
) -> bool:
    try:
        metadata = os.lstat(output_path)
    except OSError:
        return False
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return (
        stat.S_ISREG(metadata.st_mode)
        and not stat.S_ISLNK(metadata.st_mode)
        and not bool(attributes & reparse_flag)
        and _file_identity(metadata) == created_identity
    )


def _invalidate_failed_publication(
    output_path: Path, created_identity: tuple[int, int, int]
) -> None:
    """Best-effort invalidation limited to the file this process created."""

    if not _path_matches_created_plain_file(output_path, created_identity):
        return
    try:
        output_path.unlink()
        return
    except OSError:
        pass

    descriptor: int | None = None
    try:
        descriptor = os.open(
            output_path,
            os.O_WRONLY | getattr(os, "O_BINARY", 0),
        )
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or _file_identity(opened) != created_identity
        ):
            return
        try:
            os.ftruncate(descriptor, 0)
        except OSError:
            try:
                os.lseek(descriptor, 0, os.SEEK_SET)
                os.write(descriptor, b"!")
            except OSError:
                pass
        try:
            os.fsync(descriptor)
        except OSError:
            pass
    except OSError:
        pass
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _publish_report_create_only(output_path: Path, rendered: str) -> None:
    parent = _canonical_plain_directory(output_path.parent, "output parent")
    if parent / output_path.name != output_path:
        raise ContractError("output target parent changed before publication")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    payload = rendered.encode("utf-8")
    if not payload.startswith(b"{"):
        raise ContractError("canonical output receipt must begin with a left brace")
    invalid_payload = b"!" + payload[1:]
    descriptor: int | None = None
    created_identity: tuple[int, int, int] | None = None
    try:
        descriptor = os.open(output_path, flags, 0o600)
    except FileExistsError as exc:
        raise ContractError(
            "output target appeared before create-only publication"
        ) from exc
    except OSError as exc:
        raise ContractError("output create-only publication failed") from exc
    try:
        created_metadata = os.fstat(descriptor)
        if not stat.S_ISREG(created_metadata.st_mode):
            raise OSError("created output receipt is not a regular file")
        created_identity = _file_identity(created_metadata)
        _write_all_fd(descriptor, invalid_payload)
        os.fsync(descriptor)
        if os.lseek(descriptor, 0, os.SEEK_SET) != 0:
            raise OSError("could not seek to output receipt commit byte")
        if os.write(descriptor, b"{") != 1:
            raise OSError("output receipt commit byte write was incomplete")
    except Exception as exc:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
            descriptor = None
        if created_identity is not None:
            _invalidate_failed_publication(output_path, created_identity)
        raise ContractError("output create-only publication failed") from exc
    # The one-byte write above is the commit point.  Durability work after this
    # point is deliberately best-effort and cannot retroactively turn a valid
    # published receipt into a reported failure.
    try:
        os.fsync(descriptor)
    except Exception:
        pass
    try:
        os.close(descriptor)
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--subject-commit", required=True)
    parser.add_argument("--subject-tree", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output_path: Path | None = None
    if args.output is not None:
        try:
            output_path = validate_output_path(args.output)
        except ContractError as exc:
            parser.error(str(exc))
    report = build_report(
        args.profile.resolve(strict=False), args.subject_commit, args.subject_tree
    )
    rendered = render_report(report)
    if output_path is not None:
        try:
            output_path = validate_output_path(output_path)
            second_report = build_report(
                args.profile.resolve(strict=False),
                args.subject_commit,
                args.subject_tree,
            )
            second_rendered = render_report(second_report)
            consistent = second_rendered == rendered
            output_path = validate_output_path(output_path)
            third_report = build_report(
                args.profile.resolve(strict=False),
                args.subject_commit,
                args.subject_tree,
            )
            third_rendered = render_report(third_report)
            consistent = consistent and third_rendered == second_rendered
            report = third_report
            if not consistent:
                report = _blocked_publication_report(
                    report,
                    "output publication rechecks did not reproduce one receipt",
                )
            rendered = render_report(report)
            output_path = validate_output_path(output_path)
            _publish_report_create_only(output_path, rendered)
        except Exception:
            report = _blocked_publication_report(
                report,
                "output publication failed before or during create-only commit",
            )
            rendered = render_report(report)
    sys.stdout.write(rendered)
    return 0 if json.loads(rendered)["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
