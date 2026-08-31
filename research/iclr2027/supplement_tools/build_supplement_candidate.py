from __future__ import annotations

import argparse
import ast
import codecs
import csv
import hashlib
import html
import io
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tokenize
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any, Iterable, Mapping, Sequence


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import subject_binding  # noqa: E402


STATUS = "candidate_only_not_approved"
CLAIM_COMPLETE_PACKAGE_NAME = "lifeline_rl_claim_complete_candidate"
SUBJECT_BOUND_RECEIPT_SOURCE = (
    "research/iclr2027/supplement_tools/derived_claim_complete/"
    "ANONYMIZATION_DERIVATION.json"
)
SUBJECT_BOUND_RECEIPT_DESTINATION = (
    "research/iclr2027/results/validation/ANONYMIZATION_DERIVATION.json"
)
SUBJECT_BOUND_RECEIPT_CATEGORY = "transformation_receipt"
SCHEMA_VERSION = 1
SCANNER_VERSION = 4
README_NAME = "README.md"
TREE_NAME = "CANDIDATE_TREE.txt"
MANIFEST_NAME = "SHA256_MANIFEST.json"
SCAN_NAME = "PRIVACY_SCAN.json"
METADATA_NAMES = (README_NAME, TREE_NAME, MANIFEST_NAME, SCAN_NAME)

SAFE_PATH_RE = re.compile(r"[A-Za-z0-9._/-]+")
SAFE_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
CREDENTIAL_FIELD_RE = re.compile(
    r"(?i)^(?:api[_ -]?key|access[_ -]?key|client[_ -]?secret|password|passwd|secret|auth[_ -]?token)$"
)
JS_SENSITIVE_IDENTIFIER_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_$])(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|auth[_-]?token)(?![A-Za-z0-9_$])"
)
JS_SENSITIVE_BINDING_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_$])(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|auth[_-]?token)(?![A-Za-z0-9_$])\s*[:=]"
)
CONFIG_SENSITIVE_BINDING_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_$])(?P<quote>[\"']?)(?:api[ _-]?key|access[ _-]?key|client[ _-]?secret|password|passwd|secret|auth[ _-]?token)(?P=quote)\s*[:=]"
)
CONFIG_SEMANTIC_SUFFIXES = frozenset({".cfg", ".ini", ".toml", ".yaml", ".yml"})
PYTHON_TYPE_PARAMETER_AST_TYPES = tuple(
    node_type
    for name in ("ParamSpec", "TypeVar", "TypeVarTuple")
    if (node_type := getattr(ast, name, None)) is not None
)
JS_REGEX_PREFIX_CHARS = frozenset("=(:,[!&|?{;+-*%^~<>/")
JS_REGEX_PREFIX_KEYWORDS = frozenset(
    {
        "await",
        "break",
        "case",
        "continue",
        "default",
        "delete",
        "debugger",
        "do",
        "else",
        "extends",
        "in",
        "instanceof",
        "new",
        "of",
        "return",
        "throw",
        "typeof",
        "void",
        "yield",
    }
)
JS_CONTEXTUAL_REGEX_PREFIX_KEYWORDS = frozenset({"await", "of", "yield"})
JS_SIMPLE_ESCAPE_VALUES = {
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    '"': '"',
    "'": "'",
    "`": "`",
}
JS_CONTROL_HEAD_KEYWORDS = frozenset({"catch", "for", "if", "switch", "while", "with"})
JS_BLOCK_PREFIX_KEYWORDS = frozenset({"do", "else", "finally", "try"})
JS_REGEX_FLAGS = frozenset("dgimsuvy")
WINDOWS_RESERVED_DEVICE_NAMES = frozenset(
    {
        "aux",
        "con",
        "nul",
        "prn",
        *(f"com{index}" for index in range(1, 10)),
        *(f"lpt{index}" for index in range(1, 10)),
    }
)
MAX_IDENTITY_FILE_BYTES = 64 * 1024
HARD_MAX_FILE_BYTES = 16 * 1024 * 1024
HARD_MAX_TOTAL_BYTES = 64 * 1024 * 1024
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

FORBIDDEN_COMPONENTS = {
    ".git",
    ".hg",
    ".svn",
    ".tox",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    "cache",
    "caches",
    "checkpoints",
    "local_artifacts",
    "logs",
    "node_modules",
    "paper",
    "private",
    "raw_games",
    "submission",
    "tmp",
    "temp",
    "venv",
}
FORBIDDEN_SOURCE_PREFIXES = (
    "research/iclr2027/results/formal/",
    "research/iclr2027/results/pilot/",
    "research/iclr2027/results/smoke/",
)
CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS = frozenset(
    {
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json",
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl",
    }
)
CLAIM_COMPLETE_FORMAL_DESTINATION_EXCEPTIONS = CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS
CLAIM_COMPLETE_CHECKPOINT_EXCEPTIONS = {
    "source": frozenset(
        {
            "research/iclr2027/lifeline_rl/alphazero/checkpoint.py",
            "research/iclr2027/tests/test_alphazero_checkpoint.py",
        }
    ),
    "destination": frozenset(
        {
            "research/iclr2027/lifeline_rl/alphazero/checkpoint.py",
            "research/iclr2027/tests/test_alphazero_checkpoint.py",
        }
    ),
}
FORBIDDEN_SUFFIXES = {
    ".7z",
    ".avi",
    ".bz2",
    ".ckpt",
    ".db",
    ".gif",
    ".gz",
    ".joblib",
    ".log",
    ".mov",
    ".mp4",
    ".npz",
    ".onnx",
    ".pdf",
    ".pickle",
    ".pkl",
    ".pt",
    ".pth",
    ".rar",
    ".safetensors",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".webm",
    ".xz",
    ".zip",
}
FORBIDDEN_BASENAMES = {
    ".env",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
}
ALLOWED_TEXT_SUFFIXES = {
    ".cfg",
    ".csv",
    ".ini",
    ".js",
    ".json",
    ".jsonl",
    ".md",
    ".mjs",
    ".py",
    ".toml",
    ".tsv",
    ".txt",
    ".yaml",
    ".yml",
}

GENERIC_SCAN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "windows_absolute_path",
        re.compile(
            r"(?i)(?:(?<![A-Za-z0-9+.-])[a-z]:[\\/]"
            r"|(?<![A-Za-z0-9+.\\-])\\\\[^\\/\s]+[\\/][^\s]+)"
        ),
    ),
    (
        "unix_absolute_path",
        re.compile(
            r"(?i)(?<![A-Za-z0-9_.-])/(?:home|users|root|mnt|tmp|var|etc|opt|srv)/[^\s\"'<>]+"
        ),
    ),
    ("file_uri", re.compile(r"(?i)file://(?:/|[a-z]:)")),
    (
        "email_address",
        re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    ),
    (
        "private_key_material",
        re.compile(r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----"),
    ),
    (
        "known_token_shape",
        re.compile(
            r"(?i)(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})"
        ),
    ),
    ("credential_assignment", CONFIG_SENSITIVE_BINDING_RE),
    (
        "credential_in_url",
        re.compile(r"(?i)https?://[^\s/:@]+:[^\s/@]+@"),
    ),
    (
        "git_remote_or_owner_url",
        re.compile(r"(?i)(?:git@|ssh://|https?://(?:www\.)?(?:github|gitlab)\.com/)"),
    ),
    (
        "private_network_or_internal_host",
        re.compile(
            r"(?i)(?:\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b|\bautodl\b|\.internal\b)"
        ),
    ),
    (
        "identity_metadata_field",
        re.compile(
            r"(?im)(?:^|[{,\s])(?:author|authors|affiliation|institution|orcid|student[_ -]?id|姓名|作者|学号|单位)\s*[\"']?\s*[:=]"
        ),
    ),
)


class CandidateError(RuntimeError):
    """Fail-closed validation error with no matched secret material."""


class _StrictJsonError(ValueError):
    """Internal JSON-contract error whose message never contains source data."""


class _JavaScriptLexError(ValueError):
    """Internal fail-closed JavaScript lexical-goal error."""


@dataclass(frozen=True)
class AllowlistEntry:
    source: str
    destination: str
    category: str
    expected_sha256: str | None


@dataclass(frozen=True)
class AllowlistConfig:
    package_name: str
    purpose: str
    require_git_tracked: bool
    max_file_bytes: int
    max_total_bytes: int
    files: tuple[AllowlistEntry, ...]
    raw_sha256: str


@dataclass(frozen=True)
class IdentityProfile:
    terms: tuple[str, ...]
    normalized_terms: tuple[str, ...]
    digest: str


@dataclass(frozen=True)
class CandidateSnapshot:
    documents: Mapping[str, bytes]
    directories: frozenset[str]
    sha256: str


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _reject_json_constant(_value: str) -> None:
    raise _StrictJsonError("non-standard JSON numeric constant")


def _parse_finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise _StrictJsonError("non-finite JSON number")
    return parsed


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _StrictJsonError("duplicate JSON object key")
        result[key] = value
    return result


def _strict_json_loads(text: str) -> Any:
    return json.loads(
        text,
        object_pairs_hook=_reject_duplicate_json_keys,
        parse_constant=_reject_json_constant,
        parse_float=_parse_finite_json_float,
    )


def _strict_json_from_bytes(data: bytes, error_message: str) -> Any:
    try:
        text = data.decode("utf-8")
        return _strict_json_loads(text)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _StrictJsonError,
        RecursionError,
        ValueError,
    ):
        raise CandidateError(error_message) from None


def _normalize_identity(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _is_reparse(path: Path) -> bool:
    info = os.lstat(path)
    return path.is_symlink() or bool(
        getattr(info, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT
    )


def _require_plain_file(path: Path, label: str, max_bytes: int) -> bytes:
    if not path.exists() and not path.is_symlink():
        raise CandidateError(f"{label} is missing")
    if _is_reparse(path):
        raise CandidateError(f"{label} is a symlink, junction, or reparse point")
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode):
        raise CandidateError(f"{label} is not a regular file")
    if before.st_size > max_bytes:
        raise CandidateError(f"{label} exceeds the configured size limit")
    data = path.read_bytes()
    after = os.lstat(path)
    identity_before = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )
    identity_after = (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    )
    if identity_before != identity_after or len(data) != after.st_size:
        raise CandidateError(f"{label} changed while it was being read")
    return data


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], label: str
) -> None:
    observed = set(value)
    if observed != expected:
        missing = sorted(expected - observed)
        unknown = sorted(observed - expected)
        raise CandidateError(
            f"{label} keys do not match schema (missing={missing}, unknown={unknown})"
        )


def _safe_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CandidateError(f"{label} must be a non-empty string")
    if "\\" in value or not SAFE_PATH_RE.fullmatch(value):
        raise CandidateError(f"{label} must be an ASCII POSIX relative path")
    pure = PurePosixPath(value)
    if pure.is_absolute() or pure.as_posix() != value:
        raise CandidateError(f"{label} must be a normalized relative path")
    if any(part in {"", ".", ".."} for part in pure.parts):
        raise CandidateError(f"{label} cannot contain empty, dot, or parent segments")
    for part in pure.parts:
        if ":" in part:
            raise CandidateError(f"{label} cannot contain a Windows ADS separator")
        if part.endswith((".", " ")):
            raise CandidateError(f"{label} cannot contain a trailing dot or space")
        device_stem = part.split(".", 1)[0].casefold()
        if device_stem in WINDOWS_RESERVED_DEVICE_NAMES:
            raise CandidateError(f"{label} contains a Windows reserved device name")
    return value


def _check_artifact_policy(relative: str, label: str) -> None:
    lowered = relative.casefold()
    parts = tuple(part.casefold() for part in PurePosixPath(relative).parts)
    if any(part in FORBIDDEN_COMPONENTS for part in parts):
        raise CandidateError(
            f"allowlisted {label} uses a forbidden directory: {relative}"
        )
    forbidden_result_tree = any(
        lowered.startswith(prefix) for prefix in FORBIDDEN_SOURCE_PREFIXES
    )
    exact_formal_exception = (
        label == "source" and lowered in CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS
    ) or (
        label == "destination"
        and lowered in CLAIM_COMPLETE_FORMAL_DESTINATION_EXCEPTIONS
    )
    if forbidden_result_tree and not exact_formal_exception:
        raise CandidateError(
            f"allowlisted {label} uses a forbidden result tree: {relative}"
        )
    name = parts[-1]
    if name in FORBIDDEN_BASENAMES or name.startswith(".env."):
        raise CandidateError(
            f"allowlisted {label} uses a forbidden filename: {relative}"
        )
    suffix = PurePosixPath(lowered).suffix
    if suffix in FORBIDDEN_SUFFIXES:
        raise CandidateError(
            f"allowlisted {label} uses a forbidden file class: {relative}"
        )
    if suffix not in ALLOWED_TEXT_SUFFIXES:
        raise CandidateError(
            f"allowlisted {label} is not an approved text file class: {relative}"
        )
    suspicious_tokens = ("checkpoint", "raw_trajectory", "raw-game", "raw_game")
    if any(token in name for token in suspicious_tokens) and lowered not in (
        CLAIM_COMPLETE_CHECKPOINT_EXCEPTIONS.get(label) or frozenset()
    ):
        raise CandidateError(
            f"allowlisted {label} name is a forbidden artifact class: {relative}"
        )


def load_allowlist(path: Path) -> AllowlistConfig:
    data = _require_plain_file(path, "allowlist", 1024 * 1024)
    raw = _strict_json_from_bytes(data, "allowlist must be valid UTF-8 JSON")
    if not isinstance(raw, dict):
        raise CandidateError("allowlist root must be an object")
    _require_exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "package_name",
            "purpose",
            "require_git_tracked",
            "limits",
            "files",
        },
        "allowlist",
    )
    if raw["schema_version"] != SCHEMA_VERSION:
        raise CandidateError("unsupported allowlist schema_version")
    if raw["status"] != STATUS:
        raise CandidateError(f"allowlist status must be {STATUS!r}")
    package_name = raw["package_name"]
    if not isinstance(package_name, str) or not SAFE_SLUG_RE.fullmatch(package_name):
        raise CandidateError("package_name must be a safe lowercase slug")
    purpose = raw["purpose"]
    if (
        not isinstance(purpose, str)
        or not purpose
        or len(purpose) > 160
        or any(ord(char) < 32 for char in purpose)
    ):
        raise CandidateError("purpose must be a short non-empty line")
    require_git_tracked = raw["require_git_tracked"]
    if not isinstance(require_git_tracked, bool):
        raise CandidateError("require_git_tracked must be boolean")

    limits = raw["limits"]
    if not isinstance(limits, dict):
        raise CandidateError("limits must be an object")
    _require_exact_keys(limits, {"max_file_bytes", "max_total_bytes"}, "limits")
    max_file_bytes = limits["max_file_bytes"]
    max_total_bytes = limits["max_total_bytes"]
    if (
        not isinstance(max_file_bytes, int)
        or isinstance(max_file_bytes, bool)
        or not 1 <= max_file_bytes <= HARD_MAX_FILE_BYTES
    ):
        raise CandidateError("max_file_bytes is outside the hard safety bound")
    if (
        not isinstance(max_total_bytes, int)
        or isinstance(max_total_bytes, bool)
        or not max_file_bytes <= max_total_bytes <= HARD_MAX_TOTAL_BYTES
    ):
        raise CandidateError("max_total_bytes is outside the hard safety bound")

    file_rows = raw["files"]
    if not isinstance(file_rows, list) or not file_rows:
        raise CandidateError("files must be a non-empty explicit allowlist")
    entries: list[AllowlistEntry] = []
    subject_bound_rows = 0
    seen_sources: set[str] = set()
    seen_destinations: set[str] = {name.casefold() for name in METADATA_NAMES}
    for index, row in enumerate(file_rows):
        if not isinstance(row, dict):
            raise CandidateError(f"files[{index}] must be an object")
        _require_exact_keys(
            row,
            {"source", "destination", "category", "expected_sha256"},
            f"files[{index}]",
        )
        source = _safe_relative_path(row["source"], f"files[{index}].source")
        destination = _safe_relative_path(
            row["destination"], f"files[{index}].destination"
        )
        _check_artifact_policy(source, "source")
        _check_artifact_policy(destination, "destination")
        category = row["category"]
        if not isinstance(category, str) or not SAFE_SLUG_RE.fullmatch(category):
            raise CandidateError(f"files[{index}].category must be a safe slug")
        expected_sha256 = row["expected_sha256"]
        if expected_sha256 is None:
            if (
                package_name != CLAIM_COMPLETE_PACKAGE_NAME
                or source != SUBJECT_BOUND_RECEIPT_SOURCE
                or destination != SUBJECT_BOUND_RECEIPT_DESTINATION
                or category != SUBJECT_BOUND_RECEIPT_CATEGORY
            ):
                raise CandidateError(
                    "only the exact claim-complete transformation receipt may "
                    "use expected_sha256=null"
                )
            subject_bound_rows += 1
        elif not isinstance(expected_sha256, str) or not SHA256_RE.fullmatch(
            expected_sha256
        ):
            raise CandidateError(
                f"files[{index}].expected_sha256 must be lowercase SHA-256 or "
                "the unique subject-bound receipt null"
            )
        source_key = source.casefold()
        destination_key = destination.casefold()
        if source_key in seen_sources:
            raise CandidateError(f"duplicate source in allowlist: {source}")
        if destination_key in seen_destinations:
            raise CandidateError(f"duplicate or reserved destination: {destination}")
        seen_sources.add(source_key)
        seen_destinations.add(destination_key)
        entries.append(AllowlistEntry(source, destination, category, expected_sha256))

    if package_name == CLAIM_COMPLETE_PACKAGE_NAME and subject_bound_rows != 1:
        raise CandidateError(
            "claim-complete allowlist must contain exactly one subject-bound receipt"
        )
    if package_name != CLAIM_COMPLETE_PACKAGE_NAME and subject_bound_rows:
        raise CandidateError("non-claim allowlists cannot contain subject-bound rows")

    return AllowlistConfig(
        package_name=package_name,
        purpose=purpose,
        require_git_tracked=require_git_tracked,
        max_file_bytes=max_file_bytes,
        max_total_bytes=max_total_bytes,
        files=tuple(entries),
        raw_sha256=_sha256(data),
    )


def _identity_profile_from_bytes(data: bytes) -> IdentityProfile:
    raw = _strict_json_from_bytes(data, "identity terms file must be valid UTF-8 JSON")
    if not isinstance(raw, list) or not raw:
        raise CandidateError("identity terms file must be a non-empty JSON string list")
    if len(raw) > 100:
        raise CandidateError("identity terms file has too many entries")
    terms: list[str] = []
    normalized: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(raw):
        if (
            not isinstance(value, str)
            or value != value.strip()
            or not 3 <= len(value) <= 128
            or any(unicodedata.category(char) in {"Cc", "Cf"} for char in value)
        ):
            raise CandidateError(f"identity term {index} is invalid")
        folded = _normalize_identity(value)
        if folded in seen:
            raise CandidateError(
                "identity terms contain a duplicate after normalization"
            )
        seen.add(folded)
        terms.append(value)
        normalized.append(folded)
    digest = _sha256(_canonical_json_bytes(sorted(normalized)))
    return IdentityProfile(tuple(terms), tuple(normalized), digest)


def load_identity_profile(path: Path) -> IdentityProfile:
    data = _require_plain_file(path, "identity terms file", MAX_IDENTITY_FILE_BYTES)
    return _identity_profile_from_bytes(data)


def _iter_json_semantic_strings(value: Any) -> Iterable[tuple[str, bool]]:
    stack: list[tuple[Any, bool]] = [(value, False)]
    while stack:
        current, is_key = stack.pop()
        if isinstance(current, str):
            yield current, is_key
        elif isinstance(current, dict):
            for key, item in reversed(tuple(current.items())):
                stack.append((item, False))
                stack.append((key, True))
        elif isinstance(current, list):
            for item in reversed(current):
                stack.append((item, False))


def _strict_json_values_for_scan(relative: str, text: str) -> list[Any] | None:
    suffix = PurePosixPath(relative).suffix.casefold()
    if suffix == ".json":
        return [_strict_json_loads(text)]
    if suffix != ".jsonl":
        return None

    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise _StrictJsonError("empty JSON Lines document")
    values: list[Any] = []
    for line in lines:
        if line.endswith("\r"):
            line = line[:-1]
        if not line:
            raise _StrictJsonError("blank JSON Lines record")
        values.append(_strict_json_loads(line))
    return values


def _record_text_controls(
    relative: str,
    text: str,
    findings: set[tuple[str, str]],
) -> None:
    if any(unicodedata.category(char) == "Cf" for char in text):
        findings.add((relative, "unicode_format_control"))
    if any(
        unicodedata.category(char) == "Cc" and char not in {"\t", "\n", "\r"}
        for char in text
    ):
        findings.add((relative, "unicode_control_character"))
    if any(unicodedata.category(char) == "Cs" for char in text):
        findings.add((relative, "unicode_surrogate_codepoint"))


def _record_pattern_and_identity_findings(
    relative: str,
    text: str,
    identity: IdentityProfile,
    findings: set[tuple[str, str]],
    *,
    identity_text: str | None = None,
) -> None:
    normalized_text = _normalize_identity(text)
    for rule, pattern in GENERIC_SCAN_PATTERNS:
        if pattern.search(text) or (
            rule == "credential_assignment" and pattern.search(normalized_text)
        ):
            findings.add((relative, rule))
    folded = _normalize_identity(text if identity_text is None else identity_text)
    for index, term in enumerate(identity.normalized_terms):
        if term in folded:
            findings.add((relative, f"private_identity_term_{index + 1}"))


def _decode_source_character_escapes(
    text: str,
    *,
    simple_escapes: Mapping[str, str] | None = None,
    discard_unknown_backslash: bool = False,
) -> str:
    """Build a conservative scan-only view of Python/JavaScript-style escapes."""

    def fixed_hex(start: int, length: int) -> tuple[int, int] | None:
        end = start + length
        if end > len(text):
            return None
        digits = text[start:end]
        if not re.fullmatch(r"[0-9a-fA-F]+", digits):
            return None
        return int(digits, 16), end

    decoded: list[str] = []
    index = 0
    while index < len(text):
        if text[index] != "\\":
            decoded.append(text[index])
            index += 1
            continue

        run_start = index
        while index < len(text) and text[index] == "\\":
            index += 1
        run_length = index - run_start
        decoded.append("\\" * (run_length // 2))
        if run_length % 2 == 0:
            continue
        if index >= len(text):
            decoded.append("\\")
            break

        if text.startswith("\r\n", index):
            index += 2
            continue
        if text[index] in "\r\n\u2028\u2029":
            index += 1
            continue

        marker = text[index]
        if marker == "N" and index + 1 < len(text) and text[index + 1] == "{":
            end = text.find("}", index + 2)
            if end >= 0:
                try:
                    decoded.append(unicodedata.lookup(text[index + 2 : end]))
                except KeyError:
                    pass
                else:
                    index = end + 1
                    continue
        elif marker == "u":
            if index + 1 < len(text) and text[index + 1] == "{":
                end = text.find("}", index + 2)
                digits = text[index + 2 : end] if end >= 0 else ""
                if digits and re.fullmatch(r"[0-9a-fA-F]+", digits):
                    significant = digits.lstrip("0") or "0"
                    codepoint = (
                        int(significant, 16) if len(significant) <= 6 else 0x110000
                    )
                    if codepoint <= 0x10FFFF:
                        decoded.append(chr(codepoint))
                        index = end + 1
                        continue
            else:
                parsed = fixed_hex(index + 1, 4)
                if parsed is not None:
                    codepoint, end = parsed
                    if 0xD800 <= codepoint <= 0xDBFF and text.startswith("\\u", end):
                        low = fixed_hex(end + 2, 4)
                        if low is not None and 0xDC00 <= low[0] <= 0xDFFF:
                            decoded.append(
                                chr(
                                    0x10000
                                    + ((codepoint - 0xD800) << 10)
                                    + (low[0] - 0xDC00)
                                )
                            )
                            index = low[1]
                            continue
                    decoded.append(chr(codepoint))
                    index = end
                    continue
        elif marker == "U":
            parsed = fixed_hex(index + 1, 8)
            if parsed is not None and parsed[0] <= 0x10FFFF:
                decoded.append(chr(parsed[0]))
                index = parsed[1]
                continue
        elif marker == "x":
            parsed = fixed_hex(index + 1, 2)
            if parsed is not None:
                decoded.append(chr(parsed[0]))
                index = parsed[1]
                continue
        elif marker in "01234567":
            end = index
            while end < len(text) and end < index + 3 and text[end] in "01234567":
                end += 1
            decoded.append(chr(int(text[index:end], 8)))
            index = end
            continue

        if simple_escapes is not None and marker in simple_escapes:
            decoded.append(simple_escapes[marker])
            index += 1
            continue
        if discard_unknown_backslash:
            # JavaScript's NonEscapeCharacter production cooks ``\_`` as ``_``.
            decoded.append(marker)
            index += 1
            continue

        decoded.append("\\")

    return "".join(decoded)


def _decode_js_character_escapes(text: str) -> str:
    return _decode_source_character_escapes(
        text,
        simple_escapes=JS_SIMPLE_ESCAPE_VALUES,
        discard_unknown_backslash=True,
    )


def _static_python_value(node: ast.AST, depth: int = 0) -> str | bytes | None:
    if depth > 64:
        raise _StrictJsonError("Python static expression nesting is too deep")
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for item in node.values:
            if isinstance(item, ast.Constant) and isinstance(item.value, str):
                parts.append(item.value)
                continue
            if isinstance(item, ast.FormattedValue) and item.conversion in {
                -1,
                ord("s"),
            }:
                format_spec = (
                    None
                    if item.format_spec is None
                    else _static_python_value(item.format_spec, depth + 1)
                )
                value = _static_python_value(item.value, depth + 1)
                if isinstance(value, str) and format_spec in {None, ""}:
                    parts.append(value)
                    continue
            return None
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        stack: list[ast.AST] = [node]
        parts: list[str | bytes] = []
        visited = 0
        total_length = 0
        while stack:
            current = stack.pop()
            visited += 1
            if visited > 100_000:
                raise _StrictJsonError("Python static expression is too large")
            if isinstance(current, ast.BinOp) and isinstance(current.op, ast.Add):
                stack.append(current.right)
                stack.append(current.left)
                continue
            value = _static_python_value(current, depth + 1)
            if not isinstance(value, (str, bytes)):
                return None
            total_length += len(value)
            if total_length > HARD_MAX_FILE_BYTES:
                raise _StrictJsonError("Python static value is too large")
            parts.append(value)
        if not parts:
            return None
        if all(isinstance(part, str) for part in parts):
            return "".join(part for part in parts if isinstance(part, str))
        if all(isinstance(part, bytes) for part in parts):
            return b"".join(part for part in parts if isinstance(part, bytes))
        return None
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "decode"
        and not node.keywords
    ):
        payload = _static_python_value(node.func.value, depth + 1)
        if not isinstance(payload, bytes) or len(node.args) > 1:
            return None
        encoding = "utf-8"
        if node.args:
            candidate = _static_python_value(node.args[0], depth + 1)
            if not isinstance(candidate, str):
                return None
            encoding = candidate
        if encoding.casefold().replace("_", "-") not in {"utf-8", "utf8"}:
            return None
        try:
            return payload.decode("utf-8")
        except UnicodeDecodeError:
            return None
    return None


def _static_python_key_text(node: ast.AST) -> str | None:
    value = _static_python_value(node)
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            raise _StrictJsonError("Python static key is not valid UTF-8") from None
    return None


def _python_semantic_scan_views(text: str) -> list[tuple[str, bool]]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        raise _StrictJsonError("invalid Python source") from None

    nodes = tuple(ast.walk(tree))
    nested_add_nodes = {
        id(child)
        for node in nodes
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)
        for child in (node.left, node.right)
        if isinstance(child, ast.BinOp) and isinstance(child.op, ast.Add)
    }
    views: list[tuple[str, bool]] = []
    for node in nodes:
        value = None if id(node) in nested_add_nodes else _static_python_value(node)
        if isinstance(value, str):
            views.append((value, False))
        elif isinstance(value, bytes):
            try:
                views.append((value.decode("utf-8"), False))
            except UnicodeDecodeError:
                pass
        if isinstance(node, ast.Dict):
            for key in node.keys:
                if key is None:
                    continue
                decoded_key = _static_python_key_text(key)
                if decoded_key is not None:
                    views.append((decoded_key, True))
        if isinstance(node, ast.DictComp):
            decoded_key = _static_python_key_text(node.key)
            if decoded_key is not None:
                views.append((decoded_key, True))
        if isinstance(node, ast.Subscript):
            decoded_key = _static_python_key_text(node.slice)
            if decoded_key is not None:
                views.append((decoded_key, True))
        if isinstance(node, ast.Name):
            views.append((node.id, True))
        elif isinstance(node, ast.Attribute):
            views.append((node.attr, True))
        elif isinstance(node, ast.keyword) and node.arg is not None:
            views.append((node.arg, True))
        elif isinstance(node, ast.arg):
            views.append((node.arg, True))
        elif isinstance(node, ast.alias):
            views.append(((node.asname or node.name.split(".", 1)[0]), True))
        elif isinstance(node, ast.ExceptHandler) and node.name is not None:
            views.append((node.name, True))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            views.append((node.name, True))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            views.extend((name, True) for name in node.names)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name is not None:
            views.append((node.name, True))
        elif isinstance(node, ast.MatchMapping):
            if node.rest is not None:
                views.append((node.rest, True))
            for key in node.keys:
                decoded_key = _static_python_key_text(key)
                if decoded_key is not None:
                    views.append((decoded_key, True))
        elif isinstance(node, ast.MatchClass):
            views.extend((attribute, True) for attribute in node.kwd_attrs)
        elif PYTHON_TYPE_PARAMETER_AST_TYPES and isinstance(
            node, PYTHON_TYPE_PARAMETER_AST_TYPES
        ):
            views.append((node.name, True))
    return views


def _python_source_uses_utf8(data: bytes) -> bool:
    try:
        encoding, _lines = tokenize.detect_encoding(io.BytesIO(data).readline)
        canonical = codecs.lookup(encoding).name
    except (LookupError, SyntaxError, UnicodeDecodeError):
        return False
    return canonical in {"utf-8", "utf-8-sig"}


def _js_quoted_literal_end(text: str, start: int, quote: str) -> int:
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 1
            if index < len(text) and text[index] == "\r":
                index += 1
                if index < len(text) and text[index] == "\n":
                    index += 1
            elif index < len(text):
                index += 1
            continue
        if char in "\r\n\u2028\u2029":
            raise _JavaScriptLexError("unterminated JavaScript string literal")
        index += 1
        if char == quote:
            return index
    raise _JavaScriptLexError("unterminated JavaScript string literal")


def _js_template_expression_end(text: str, start: int, depth: int) -> int:
    if depth > 64:
        raise _JavaScriptLexError("JavaScript template nesting is too deep")
    brace_depth = 1
    index = start
    while index < len(text):
        char = text[index]
        if char in {'"', "'"}:
            index = _js_quoted_literal_end(text, index, char)
            continue
        if char == "`":
            index, _expressions = _js_template_literal_parts(text, index, depth + 1)
            continue
        if text.startswith("//", index):
            index += 2
            while index < len(text) and text[index] not in "\r\n\u2028\u2029":
                index += 1
            continue
        if text.startswith("/*", index):
            terminator = text.find("*/", index + 2)
            if terminator < 0:
                raise _JavaScriptLexError("unterminated JavaScript block comment")
            index = terminator + 2
            continue
        if char == "/":
            raise _JavaScriptLexError(
                "ambiguous slash inside JavaScript template expression"
            )
        if char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth -= 1
            if brace_depth == 0:
                return index
        index += 1
    raise _JavaScriptLexError("unterminated JavaScript template expression")


def _js_template_literal_parts(
    text: str,
    start: int,
    depth: int = 0,
) -> tuple[int, list[str]]:
    if depth > 64:
        raise _JavaScriptLexError("JavaScript template nesting is too deep")
    expressions: list[str] = []
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "`":
            return index + 1, expressions
        if char == "$" and index + 1 < len(text) and text[index + 1] == "{":
            expression_start = index + 2
            expression_end = _js_template_expression_end(
                text,
                expression_start,
                depth + 1,
            )
            expressions.append(text[expression_start:expression_end])
            index = expression_end + 1
            continue
        index += 1
    raise _JavaScriptLexError("unterminated JavaScript template literal")


def _js_regex_can_start(
    last_significant: str | None,
    last_token: str | None,
) -> bool | None:
    if last_token == "unknown_brace_close":
        return None
    if last_token == "block_close":
        # A closing function/class expression body is an operand, while a closed
        # statement block can precede a regex. The lightweight lexer does not
        # prove that distinction, so a following slash is deliberately rejected.
        return None
    if last_token in JS_CONTEXTUAL_REGEX_PREFIX_KEYWORDS:
        # These words are also legal identifier references in context. Treating
        # every following slash as a regex can hide a sensitive division operand.
        return None
    if last_token in {"control_head_close", "spread"}:
        return True
    if last_token in JS_REGEX_PREFIX_KEYWORDS:
        return True
    if last_token in {
        "++",
        "--",
        "identifier",
        "literal",
        "number",
        "object_close",
        ")",
        "]",
    }:
        return False
    return last_significant is None or last_significant in JS_REGEX_PREFIX_CHARS


def _js_regex_literal_end(text: str, start: int) -> int:
    index = start + 1
    in_character_class = False
    while index < len(text):
        char = text[index]
        if char in "\r\n\u2028\u2029":
            raise _JavaScriptLexError("unterminated JavaScript regex literal")
        if char == "\\":
            if index + 1 >= len(text) or text[index + 1] in "\r\n\u2028\u2029":
                raise _JavaScriptLexError("unterminated JavaScript regex escape")
            index += 2
            continue
        if char == "[" and not in_character_class:
            in_character_class = True
            index += 1
            continue
        if char == "]" and in_character_class:
            in_character_class = False
            index += 1
            continue
        if char == "/" and not in_character_class:
            index += 1
            flags_start = index
            while index < len(text) and (text[index].isalnum() or text[index] in "_$"):
                index += 1
            flags = text[flags_start:index]
            if (
                any(flag not in JS_REGEX_FLAGS for flag in flags)
                or len(set(flags)) != len(flags)
                or {"u", "v"}.issubset(flags)
                or (index < len(text) and text[index] == "\\")
            ):
                raise _JavaScriptLexError("invalid JavaScript regex flags")
            return index
        index += 1
    raise _JavaScriptLexError("unterminated JavaScript regex literal")


def _js_brace_context(
    last_significant: str | None,
    last_token: str | None,
    previous_token: str | None,
) -> bool | None:
    if last_token in {"control_head_close", ")", "=>", "block_close"}:
        return True
    if last_token in JS_BLOCK_PREFIX_KEYWORDS:
        return True
    if last_token == "class" or previous_token in {"class", "extends"}:
        return True
    if last_token is None:
        return None
    if last_significant == ":":
        return None
    if last_token in JS_REGEX_PREFIX_KEYWORDS or last_significant in "=,([?":
        return False
    return None


def _js_lex_source(text: str) -> tuple[list[tuple[str, int, int]], str]:
    literals: list[tuple[str, int, int]] = []
    masked = list(text)
    index = 0
    last_significant: str | None = None
    last_token: str | None = None
    previous_token: str | None = None
    parenthesis_contexts: list[bool] = []
    brace_contexts: list[bool | None] = []

    def record_token(token: str, significant: str) -> None:
        nonlocal last_significant, last_token, previous_token
        previous_token = last_token
        last_token = token
        last_significant = significant

    while index < len(text):
        char = text[index]
        if char == "`":
            start = index
            index, _expressions = _js_template_literal_parts(text, index)
            literals.append((text[start:index], start, index))
            masked[start:index] = " " * (index - start)
            record_token("literal", char)
            continue
        if char in {'"', "'"}:
            start = index
            quote = char
            index = _js_quoted_literal_end(text, index, quote)
            literals.append((text[start:index], start, index))
            masked[start:index] = " " * (index - start)
            record_token("literal", quote)
            continue
        if text.startswith("<!--", index):
            # Annex B treats this as a line comment only under the Script goal;
            # Module goal rejects it. The candidate scanner does not infer goal.
            raise _JavaScriptLexError("unsupported JavaScript HTML-open comment")
        if text.startswith("-->", index):
            # Annex B's exact line-prefix rules include trivia that this lexer
            # intentionally masks. Reject every unquoted occurrence rather than
            # risk treating a Script-only close comment as ordinary operators.
            raise _JavaScriptLexError("unsupported JavaScript HTML-close comment")
        if char == "/" and index + 1 < len(text) and text[index + 1] == "/":
            start = index
            index += 2
            while index < len(text) and text[index] not in "\r\n\u2028\u2029":
                index += 1
            masked[start:index] = " " * (index - start)
            continue
        if char == "/" and index + 1 < len(text) and text[index + 1] == "*":
            start = index
            terminator = text.find("*/", index + 2)
            if terminator < 0:
                raise _JavaScriptLexError("unterminated JavaScript block comment")
            index = terminator + 2
            masked[start:index] = " " * (index - start)
            continue
        if char == "/":
            regex_goal = _js_regex_can_start(last_significant, last_token)
            if regex_goal is None:
                raise _JavaScriptLexError("ambiguous JavaScript slash lexical goal")
            if regex_goal:
                regex_end = _js_regex_literal_end(text, index)
                masked[index:regex_end] = " " * (regex_end - index)
                index = regex_end
                record_token("literal", "/")
                continue
            record_token("/", "/")
            index += 1
            continue
        if char.isspace():
            index += 1
            continue
        if text.startswith("...", index):
            record_token("spread", ".")
            index += 3
            continue
        if text.startswith("?.", index):
            record_token("member_access", ".")
            index += 2
            continue
        if char == ".":
            record_token("member_access", char)
            index += 1
            continue
        if char == "#":
            record_token("member_access", char)
            index += 1
            continue
        if char.isalpha() or char in "_$":
            start = index
            index += 1
            while index < len(text) and (text[index].isalnum() or text[index] in "_$"):
                index += 1
            word = text[start:index]
            if last_token == "member_access":
                token = "identifier"
            elif word == "await" and last_token == "for":
                token = "for_await"
            else:
                token = word
            record_token(token, text[index - 1])
            continue
        if char.isdigit():
            record_token("number", char)
            index += 1
            continue
        if text.startswith("=>", index):
            record_token("=>", ">")
            index += 2
            continue
        if text.startswith(("++", "--"), index):
            record_token(text[index : index + 2], char)
            index += 2
            continue
        if char == "(":
            parenthesis_contexts.append(
                last_token in JS_CONTROL_HEAD_KEYWORDS or last_token == "for_await"
            )
            record_token(char, char)
            index += 1
            continue
        if char == ")":
            closes_control_head = bool(
                parenthesis_contexts and parenthesis_contexts.pop()
            )
            record_token("control_head_close" if closes_control_head else char, char)
            index += 1
            continue
        if char == "{":
            brace_contexts.append(
                _js_brace_context(last_significant, last_token, previous_token)
            )
            record_token(char, char)
            index += 1
            continue
        if char == "}":
            context = brace_contexts.pop() if brace_contexts else None
            if context is True:
                token = "block_close"
            elif context is False:
                token = "object_close"
            else:
                token = "unknown_brace_close"
            record_token(token, char)
            index += 1
            continue
        record_token(char, char)
        index += 1
    return literals, "".join(masked)


def _js_template_expression_code_views(
    text: str,
    depth: int = 0,
) -> list[str]:
    if depth > 64:
        raise _JavaScriptLexError("JavaScript template nesting is too deep")
    literals, _code_only = _js_lex_source(text)
    views: list[str] = []
    for token, _start, _end in literals:
        if not token.startswith("`"):
            continue
        _closing, expressions = _js_template_literal_parts(token, 0, depth + 1)
        for expression in expressions:
            _nested_literals, code_only = _js_lex_source(expression)
            views.append(code_only)
            views.extend(_js_template_expression_code_views(expression, depth + 1))
    return views


def _skip_js_whitespace_and_comments(text: str, start: int = 0) -> int:
    index = start
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if text.startswith("//", index):
            index += 2
            while index < len(text) and text[index] not in "\r\n\u2028\u2029":
                index += 1
            continue
        if text.startswith("/*", index):
            terminator = text.find("*/", index + 2)
            if terminator < 0:
                raise _JavaScriptLexError("unterminated JavaScript block comment")
            index = terminator + 2
            continue
        break
    return index


def _js_static_expression_separator(text: str) -> bool:
    index = 0
    while index < len(text):
        index = _skip_js_whitespace_and_comments(text, index)
        if index < len(text) and text[index] in "+()":
            index += 1
            continue
        return index == len(text)
    return True


def _static_js_literal_expression_value(
    text: str,
    depth: int,
) -> str | None:
    if depth > 64:
        raise _JavaScriptLexError("JavaScript static expression nesting is too deep")
    literals, _code_only = _js_lex_source(text)
    if not literals:
        return None
    cursor = 0
    parts: list[str] = []
    for token, start, end in literals:
        if not _js_static_expression_separator(text[cursor:start]):
            return None
        parts.append(_decode_js_literal(token, depth + 1))
        cursor = end
    if not _js_static_expression_separator(text[cursor:]):
        return None
    return "".join(parts)


def _decode_js_template_literal(token: str, depth: int) -> str:
    if depth > 64:
        raise _JavaScriptLexError("JavaScript template nesting is too deep")
    output: list[str] = []
    index = 1
    quasi_start = index
    closing = len(token) - 1
    while index < closing:
        char = token[index]
        if char == "\\":
            index += 2
            continue
        if char == "$" and index + 1 < closing and token[index + 1] == "{":
            output.append(_decode_js_character_escapes(token[quasi_start:index]))
            expression_start = index + 2
            expression_end = _js_template_expression_end(
                token,
                expression_start,
                depth + 1,
            )
            expression = token[expression_start:expression_end]
            static_value = _static_js_literal_expression_value(
                expression,
                depth + 1,
            )
            if static_value is None:
                output.append(token[index : expression_end + 1])
            else:
                output.append(static_value)
            index = expression_end + 1
            quasi_start = index
            continue
        index += 1
    output.append(_decode_js_character_escapes(token[quasi_start:closing]))
    return "".join(output)


def _decode_js_literal(token: str, depth: int = 0) -> str:
    if token.startswith("`"):
        return _decode_js_template_literal(token, depth)
    return _decode_js_character_escapes(token[1:-1])


def _js_static_key_suffix(text: str, start: int = 0) -> bool:
    index = _skip_js_whitespace_and_comments(text, start)
    direct_trivia = text[start:index]
    closed_parentheses = 0
    while index < len(text) and text[index] == ")":
        closed_parentheses += 1
        index = _skip_js_whitespace_and_comments(text, index + 1)
    if index < len(text) and text[index] == "]":
        return True
    if index < len(text) and text[index] == "(":
        return True
    if index < len(text) and text[index] == ":":
        return True
    if closed_parentheses == 0 and index < len(text) and text[index] in ",;}":
        return True
    if closed_parentheses == 0 and any(
        line_break in direct_trivia for line_break in ("\r", "\n", "\u2028", "\u2029")
    ):
        return True
    keyword = re.match(r"[A-Za-z_$][A-Za-z0-9_$]*", text[index:])
    if keyword is not None and keyword.group(0) in {"as", "from", "in"}:
        return True
    if text.startswith(("==", "=>"), index):
        return False
    return any(
        text.startswith(operator, index)
        for operator in (
            ">>>=",
            "&&=",
            "**=",
            "<<=",
            ">>=",
            "??=",
            "||=",
            "%=",
            "&=",
            "*=",
            "+=",
            "-=",
            "/=",
            "=",
            "^=",
            "|=",
            "++",
            "--",
        )
    )


def _conservative_js_join_target(text: str, start: int) -> int:
    index = start
    while index < len(text):
        index = _skip_js_whitespace_and_comments(text, index)
        if index < len(text) and text[index] in "+()":
            index += 1
            continue
        return index
    return index


def _conservative_js_literal_scan_views(text: str) -> list[tuple[str, bool]]:
    delimiter_positions: dict[str, list[int]] = {'"': [], "'": [], "`": []}
    backslash_run = 0
    for index, char in enumerate(text):
        if char in delimiter_positions and backslash_run % 2 == 0:
            delimiter_positions[char].append(index)
        if char == "\\":
            backslash_run += 1
        else:
            backslash_run = 0

    candidates: list[tuple[str, int, int]] = []
    for quote, positions in delimiter_positions.items():
        for start, closing in zip(positions, positions[1:]):
            end = closing + 1
            if quote == "`":
                decoded = _decode_js_literal(text[start:end])
            else:
                decoded = _decode_js_character_escapes(text[start + 1 : closing])
            candidates.append((decoded, start, end))
    candidates.sort(key=lambda item: (item[1], item[2]))

    by_start = {start: index for index, (_value, start, _end) in enumerate(candidates)}
    successor: dict[int, int] = {}
    predecessors: set[int] = set()
    views: list[tuple[str, bool]] = []
    for candidate_index, (decoded, _start, end) in enumerate(candidates):
        views.append((decoded, _js_static_key_suffix(text, end)))
        target = _conservative_js_join_target(text, end)
        next_index = by_start.get(target)
        if next_index is not None and candidates[next_index][1] >= end:
            successor[candidate_index] = next_index
            predecessors.add(next_index)

    for candidate_index in range(len(candidates)):
        if candidate_index in predecessors or candidate_index not in successor:
            continue
        pieces: list[str] = []
        current = candidate_index
        seen: set[int] = set()
        while current not in seen:
            seen.add(current)
            decoded, _start, end = candidates[current]
            pieces.append(decoded)
            next_index = successor.get(current)
            if next_index is None:
                break
            current = next_index
        views.append(("".join(pieces), _js_static_key_suffix(text, end)))
    return views


def _source_literal_scan_views(text: str) -> list[tuple[str, bool]]:
    literals, _code_only = _js_lex_source(text)
    views: list[tuple[str, bool]] = []
    chain: list[str] = []
    previous_end: int | None = None
    for token, start, end in literals:
        decoded = _decode_js_literal(token)
        is_key = _js_static_key_suffix(text, end)
        views.append((decoded, is_key))
        if previous_end is not None and _js_static_join_separator(
            text[previous_end:start]
        ):
            chain.append(decoded)
        else:
            if len(chain) > 1 and previous_end is not None:
                views.append(
                    ("".join(chain), _js_static_key_suffix(text, previous_end))
                )
            chain = [decoded]
        previous_end = end
    if len(chain) > 1 and previous_end is not None:
        views.append(("".join(chain), _js_static_key_suffix(text, previous_end)))
    return views


def _js_static_join_separator(text: str) -> bool:
    _literals, code_only = _js_lex_source(text)
    return re.fullmatch(r"[\s+()]*", code_only) is not None


def _record_noncode_credential_keys(
    relative: str,
    suffix: str,
    text: str,
    findings: set[tuple[str, str]],
) -> None:
    decoded = _decode_source_character_escapes(text)
    if suffix in CONFIG_SEMANTIC_SUFFIXES and CONFIG_SENSITIVE_BINDING_RE.search(
        decoded
    ):
        findings.add((relative, "credential_assignment"))
    if suffix in {".toml", ".yaml", ".yml"} and re.search(
        r"\\[ \t]*(?:\r\n|[\n\r\u0085\u2028\u2029])",
        text,
    ):
        # YAML double-quoted scalars and TOML multiline basic strings can remove
        # both the escaped line ending and following indentation. A lexical scan
        # cannot safely reconstruct every parser-specific value, so reject this
        # syntax instead of claiming that split private text was absent.
        findings.add((relative, "unsupported_structured_line_continuation"))
    if suffix in {".toml", ".yaml", ".yml"} and "\\" in text:
        # Both formats assign parser-specific meaning to backslashes in quoted
        # scalars. The clean verifier intentionally carries no TOML/YAML parser,
        # so even escapes that look harmless are outside its proof boundary.
        findings.add((relative, "unsupported_structured_string_escape"))
    if suffix == ".toml" and ('"""' in text or "'''" in text):
        findings.add((relative, "unsupported_toml_multiline_string"))
    if suffix in {".yaml", ".yml"} and "''" in text:
        findings.add((relative, "unsupported_yaml_doubled_quote"))
    if suffix in {".yaml", ".yml"} and re.search(
        r"(?m)(?:^|[ \t\[{,:?-])!(?=\S)",
        text,
    ):
        # Explicit tags can invoke parser-level conversions such as !!binary,
        # exposing decoded private bytes that are absent from the source text.
        findings.add((relative, "unsupported_yaml_tag"))
    if suffix in {".yaml", ".yml"} and re.search(
        r"(?m)(?:^|[ \t\[{,:?-])[&*](?=\S)",
        text,
    ):
        # Anchors and aliases can promote an otherwise harmless scalar into a
        # mapping key after parser resolution, including credential-shaped keys.
        findings.add((relative, "unsupported_yaml_anchor_or_alias"))
    if suffix in {".cfg", ".ini"} and ("%(" in text or "${" in text):
        # ConfigParser interpolation can assemble a private value from otherwise
        # harmless-looking option fragments. This scanner does not execute either
        # interpolation dialect, so their placeholders are fail-closed.
        findings.add((relative, "unsupported_config_interpolation"))
    if suffix in {".yaml", ".yml"}:
        for line in text.splitlines():
            stripped = line.lstrip()
            semantic_prefix = stripped
            while semantic_prefix.startswith("- "):
                semantic_prefix = semantic_prefix[2:].lstrip()
            if semantic_prefix == "?" or semantic_prefix.startswith("? "):
                findings.add((relative, "unsupported_yaml_explicit_key"))
            if semantic_prefix.startswith(('"', "'")) and line.rstrip().endswith("\\"):
                findings.add((relative, "unsupported_yaml_multiline_key"))
    if suffix in {".cfg", ".ini", ".toml"}:
        for line in decoded.splitlines():
            stripped = line.lstrip()
            if not stripped.startswith("["):
                continue
            array_table = suffix == ".toml" and stripped.startswith("[[")
            opening_width = 2 if array_table else 1
            closing = "]]" if array_table else "]"
            closing_index = stripped.find(closing, opening_width)
            if closing_index < 0:
                findings.add((relative, "invalid_structured_section_header"))
                continue
            header = stripped[opening_width:closing_index]
            if suffix == ".toml":
                parts: list[str] = []
                current: list[str] = []
                quote: str | None = None
                escaped = False
                for char in header:
                    if quote is not None:
                        current.append(char)
                        if escaped:
                            escaped = False
                        elif char == "\\" and quote == '"':
                            escaped = True
                        elif char == quote:
                            quote = None
                    elif char in {'"', "'"}:
                        quote = char
                        current.append(char)
                    elif char == ".":
                        parts.append("".join(current))
                        current = []
                    else:
                        current.append(char)
                parts.append("".join(current))
                if quote is not None:
                    findings.add((relative, "invalid_structured_section_header"))
            else:
                parts = [header]
            for part in parts:
                normalized = _normalize_identity(part).strip().strip("\"'")
                if CREDENTIAL_FIELD_RE.fullmatch(normalized):
                    findings.add((relative, "credential_assignment"))
    if suffix not in {".csv", ".tsv"}:
        return
    first_nonblank_line = next(
        (line for line in decoded.splitlines() if line.strip()),
        "",
    )
    if suffix == ".csv" and re.fullmatch(
        r"(?i)\s*sep\s*=\s*.\s*",
        first_nonblank_line,
    ):
        # Excel consumes this non-RFC preamble and promotes the following row to
        # the header. Reject it rather than silently scanning the directive as it.
        findings.add((relative, "unsupported_delimited_sep_directive"))
    header: list[str] | None = None
    try:
        reader = csv.reader(
            io.StringIO(decoded),
            delimiter="\t" if suffix == ".tsv" else ",",
            strict=True,
        )
        for row in reader:
            if any(cell.strip() for cell in row):
                header = row
                break
    except csv.Error:
        findings.add((relative, "invalid_delimited_text"))
    physical_header = first_nonblank_line
    conservative_cells = re.split(r"[,;\t|]", physical_header)
    semantic_cells = (header or []) + conservative_cells
    if any(
        CREDENTIAL_FIELD_RE.fullmatch(_normalize_identity(cell).strip().strip("\"'"))
        for cell in semantic_cells
    ):
        findings.add((relative, "credential_assignment"))


class _MarkdownHTMLTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.joined_parts: list[str] = []
        self.spaced_parts: list[str] = []
        self.unsupported = False

    def handle_data(self, data: str) -> None:
        self.joined_parts.append(data)
        self.spaced_parts.append(data)

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        del tag, attrs
        self.spaced_parts.append(" ")

    def handle_startendtag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        del tag
        self.spaced_parts.append(" ")

    def handle_decl(self, decl: str) -> None:
        del decl
        self.unsupported = True

    def handle_pi(self, data: str) -> None:
        del data
        self.unsupported = True

    def unknown_decl(self, data: str) -> None:
        del data
        self.unsupported = True


def _markdown_link_target_end(text: str, start: int) -> int:
    opener = text[start]
    if opener not in {"(", "["}:
        raise AssertionError("Markdown link target must start with a delimiter")
    closer = ")" if opener == "(" else "]"
    depth = 1
    quote: str | None = None
    angle = False
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if opener == "(" and angle:
            if char == ">":
                angle = False
            index += 1
            continue
        if quote is not None:
            if char == quote:
                quote = None
            index += 1
            continue
        if opener == "(" and char == "<":
            angle = True
        elif opener == "(" and char in {'"', "'"}:
            quote = char
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise _StrictJsonError("unterminated Markdown link target")


def _markdown_link_label_view(text: str) -> str:
    output: list[str] = []
    index = 0
    while index < len(text):
        if text.startswith("![", index):
            # The exclamation mark is image syntax, not displayed alt text.
            index += 1
            continue
        char = text[index]
        output.append(char)
        index += 1
        if char != "]":
            continue
        gap_start = index
        while index < len(text) and text[index] in " \t\r\n":
            index += 1
        if index < len(text) and text[index] in {"(", "["}:
            index = _markdown_link_target_end(text, index)
            continue
        output.append(text[gap_start:index])
    return "".join(output)


def _markdown_semantic_scan_text(text: str) -> str:
    def unescape_ascii_punctuation(match: re.Match[str]) -> str:
        char = match.group(1)
        if char.isascii() and not char.isalnum() and not char.isspace():
            return char
        return match.group(0)

    # Keep this source-level entity view distinct from parsed HTML. An encoded
    # literal such as ``&lt;B&gt;`` is displayed punctuation, while a source
    # ``<B>`` is markup; decoding before parsing would incorrectly erase it.
    entity_source = html.unescape(text)
    entity_unescaped = re.sub(
        r"\\(.)",
        unescape_ascii_punctuation,
        entity_source,
    )
    semantic = _markdown_link_label_view(text)
    semantic = re.sub(r"\\[ \t]*(?:\r\n|[\r\n])", "\n", semantic)
    semantic = re.sub(r"\\(.)", unescape_ascii_punctuation, semantic)

    parser = _MarkdownHTMLTextParser()
    parser.feed(semantic)
    parser.close()
    if parser.unsupported:
        raise _StrictJsonError("unsupported Markdown HTML construct")
    translation = str.maketrans("", "", "`*_~[]")
    joined = "".join(parser.joined_parts)
    spaced = "".join(parser.spaced_parts)
    stripped_joined = joined.translate(translation)
    stripped_spaced = spaced.translate(translation)
    return "\n".join(
        (
            entity_source,
            entity_unescaped,
            joined,
            re.sub(r"\s+", " ", joined),
            re.sub(r"\s+", " ", spaced),
            stripped_joined,
            re.sub(r"\s+", " ", stripped_joined),
            re.sub(r"\s+", " ", stripped_spaced),
        )
    )


def _scan_documents(
    documents: Iterable[tuple[str, bytes]], identity: IdentityProfile
) -> dict[str, Any]:
    finding_keys: set[tuple[str, str]] = set()
    scanned_files = 0
    scanned_bytes = 0
    for relative, data in sorted(documents, key=lambda item: item[0]):
        scanned_files += 1
        scanned_bytes += len(data)
        suffix = PurePosixPath(relative).suffix.casefold()
        if suffix == ".py" and not _python_source_uses_utf8(data):
            finding_keys.add((relative, "unsupported_python_source_encoding"))
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            finding_keys.add((relative, "non_utf8_content"))
            continue
        # A single UTF-8 BOM at byte/character zero is tolerated for a source file
        # that is otherwise ordinary UTF-8 text. Any later BOM or other Unicode
        # format control remains a fail-closed finding.
        scan_text = text[1:] if text.startswith("\ufeff") else text
        _record_text_controls(relative, scan_text, finding_keys)
        search_text = relative + "\n" + scan_text
        _record_pattern_and_identity_findings(
            relative, search_text, identity, finding_keys
        )

        _record_noncode_credential_keys(
            relative,
            suffix,
            scan_text,
            finding_keys,
        )
        if suffix == ".md":
            try:
                markdown_text = _markdown_semantic_scan_text(scan_text)
            except (AssertionError, _StrictJsonError):
                finding_keys.add((relative, "unsupported_markdown_construct"))
                markdown_text = scan_text
            _record_text_controls(relative, markdown_text, finding_keys)
            _record_pattern_and_identity_findings(
                relative,
                markdown_text,
                identity,
                finding_keys,
            )
            for line in markdown_text.splitlines():
                if "|" not in line:
                    continue
                cells = line.strip().strip("|").split("|")
                if any(
                    CREDENTIAL_FIELD_RE.fullmatch(
                        _normalize_identity(cell).strip().strip("\"'")
                    )
                    for cell in cells
                ):
                    finding_keys.add((relative, "credential_assignment"))
        if suffix not in {".json", ".jsonl", ".py", ".js", ".mjs"}:
            decoded_search_text = _decode_source_character_escapes(search_text)
            if decoded_search_text != search_text:
                _record_text_controls(relative, decoded_search_text, finding_keys)
                _record_pattern_and_identity_findings(
                    relative,
                    decoded_search_text,
                    identity,
                    finding_keys,
                )
            if suffix in CONFIG_SEMANTIC_SUFFIXES:
                whitespace_folded_text = re.sub(r"\s+", " ", decoded_search_text)
                _record_pattern_and_identity_findings(
                    relative,
                    whitespace_folded_text,
                    identity,
                    finding_keys,
                )

        source_views: list[tuple[str, bool]] = []
        if suffix == ".py":
            try:
                source_views = _python_semantic_scan_views(scan_text)
            except _StrictJsonError:
                finding_keys.add((relative, "invalid_python_source"))
        elif suffix in {".js", ".mjs"}:
            decoded_source_text = _decode_source_character_escapes(scan_text)
            _record_text_controls(relative, decoded_source_text, finding_keys)
            _record_pattern_and_identity_findings(
                relative,
                decoded_source_text,
                identity,
                finding_keys,
            )
            if JS_SENSITIVE_BINDING_RE.search(_normalize_identity(decoded_source_text)):
                finding_keys.add((relative, "credential_assignment"))
            try:
                source_views.extend(_conservative_js_literal_scan_views(scan_text))
            except _JavaScriptLexError:
                finding_keys.add((relative, "invalid_or_ambiguous_javascript_source"))
            try:
                _literals, code_only = _js_lex_source(scan_text)
                decoded_code_only = _decode_source_character_escapes(code_only)
                if JS_SENSITIVE_IDENTIFIER_RE.search(
                    _normalize_identity(decoded_code_only)
                ):
                    finding_keys.add((relative, "credential_assignment"))
                for template_code in _js_template_expression_code_views(scan_text):
                    decoded_template_code = _decode_source_character_escapes(
                        template_code
                    )
                    if JS_SENSITIVE_IDENTIFIER_RE.search(
                        _normalize_identity(decoded_template_code)
                    ):
                        finding_keys.add((relative, "credential_assignment"))
                source_views.extend(_source_literal_scan_views(scan_text))
            except _JavaScriptLexError:
                finding_keys.add((relative, "invalid_or_ambiguous_javascript_source"))
        for semantic_text, is_key in source_views:
            _record_text_controls(relative, semantic_text, finding_keys)
            normalized_semantic = _normalize_identity(semantic_text).strip()
            if is_key and CREDENTIAL_FIELD_RE.fullmatch(normalized_semantic):
                finding_keys.add((relative, "credential_assignment"))
            _record_pattern_and_identity_findings(
                relative,
                semantic_text + (":" if is_key else ""),
                identity,
                finding_keys,
                identity_text=semantic_text,
            )

        try:
            json_values = _strict_json_values_for_scan(relative, scan_text)
        except (
            json.JSONDecodeError,
            _StrictJsonError,
            RecursionError,
            ValueError,
        ):
            rule = (
                "invalid_jsonl_content"
                if suffix == ".jsonl"
                else "invalid_json_content"
            )
            finding_keys.add((relative, rule))
            json_values = None
        for value in json_values or []:
            for semantic_text, is_key in _iter_json_semantic_strings(value):
                _record_text_controls(relative, semantic_text, finding_keys)
                if is_key and CREDENTIAL_FIELD_RE.fullmatch(
                    _normalize_identity(semantic_text).strip()
                ):
                    finding_keys.add((relative, "credential_assignment"))
                _record_pattern_and_identity_findings(
                    relative,
                    semantic_text + (":" if is_key else ""),
                    identity,
                    finding_keys,
                    identity_text=semantic_text,
                )

    findings = [
        {"path": path, "rule": rule}
        for path, rule in sorted(finding_keys, key=lambda item: (item[0], item[1]))
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "scanner_version": SCANNER_VERSION,
        "status": "PASS" if not findings else "FAIL",
        "candidate_status": STATUS,
        "scanned_file_count": scanned_files,
        "scanned_bytes": scanned_bytes,
        # The identity list is deliberately private.  Publishing either its
        # size or an unsalted deterministic digest would let a reviewer test
        # low-entropy guesses (names, affiliations, user names, and e-mail
        # variants) offline.  Verification still requires the private input
        # and recomputes the complete scan, but no public candidate byte is a
        # commitment to that input.
        "identity_input": "private_supplied_not_fingerprinted",
        "findings": findings,
    }


def _raise_for_scan(scan: Mapping[str, Any], label: str) -> None:
    findings = scan.get("findings")
    if scan.get("status") == "PASS" and findings == []:
        return
    safe_summary = ", ".join(
        f"{item.get('path', '?')}:{item.get('rule', '?')}" for item in findings or []
    )
    raise CandidateError(f"{label} privacy scan failed ({safe_summary})")


def _assert_no_reparse_chain(root: Path, relative: str) -> Path:
    if _is_reparse(root):
        raise CandidateError("source root is a symlink, junction, or reparse point")
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        if not current.exists() and not current.is_symlink():
            raise CandidateError(f"allowlisted source is missing: {relative}")
        if _is_reparse(current):
            raise CandidateError(
                f"allowlisted source crosses a symlink, junction, or reparse point: {relative}"
            )
    return current


def _require_git_tracked(root: Path, sources: Sequence[str]) -> None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise CandidateError("git tracked-file check could not run") from exc
    if completed.returncode != 0:
        raise CandidateError("git tracked-file check failed")
    try:
        tracked = {
            item.replace("\\", "/")
            for item in completed.stdout.decode("utf-8").split("\0")
            if item
        }
    except UnicodeDecodeError as exc:
        raise CandidateError("git tracked-file list was not UTF-8") from exc
    missing = sorted(set(sources) - tracked)
    if missing:
        raise CandidateError(f"allowlisted sources are not Git-tracked: {missing}")


def _subject_snapshot_for_config(
    config: AllowlistConfig,
    allowlist_path: Path,
    payload_source_root: Path | None,
    subject_root: Path | None,
    subject_commit: str | None,
    subject_tree: str | None,
) -> subject_binding.SubjectSnapshot | None:
    supplied = (subject_root, subject_commit, subject_tree)
    required = config.package_name == CLAIM_COMPLETE_PACKAGE_NAME or any(
        value is not None for value in supplied
    )
    if not required:
        return None
    if any(value is None for value in supplied):
        raise CandidateError(
            "subject root, commit, and tree are all required for a subject-bound candidate"
        )
    assert subject_root is not None
    assert subject_commit is not None
    assert subject_tree is not None
    try:
        allowlist_relative = subject_binding.canonical_repo_relative(
            subject_root, allowlist_path, "candidate allowlist"
        )
        frozen_paths = {allowlist_relative}
        if config.require_git_tracked:
            if payload_source_root is None:
                raise CandidateError(
                    "tracked candidate verification requires a source root"
                )
            if payload_source_root.absolute() != subject_root.absolute():
                raise CandidateError(
                    "tracked candidate payload root must equal the subject source root"
                )
            frozen_paths.update(entry.source for entry in config.files)
        snapshot = subject_binding.verify_subject_repository(
            subject_root,
            subject_commit,
            subject_tree,
            frozen_paths=frozen_paths,
            tool_paths=(Path(__file__), Path(subject_binding.__file__)),
        )
        subject_files = {item.relative: item for item in snapshot.files}
        allowlist_snapshot = subject_files.get(allowlist_relative)
        if allowlist_snapshot is None or allowlist_snapshot.sha256 != config.raw_sha256:
            raise CandidateError(
                "parsed allowlist bytes do not match the subject commit blob"
            )
        return snapshot
    except subject_binding.SubjectBindingError as exc:
        raise CandidateError(str(exc)) from exc


def _validate_subject_bound_receipt(
    entry: AllowlistEntry,
    data: bytes,
    binding: subject_binding.SubjectBinding | None,
) -> None:
    if entry.expected_sha256 is not None:
        return
    if binding is None:
        raise CandidateError("subject-bound receipt lacks an explicit subject")
    value = _strict_json_from_bytes(
        data, "subject-bound derivation receipt must be valid UTF-8 JSON"
    )
    if not isinstance(value, dict):
        raise CandidateError("subject-bound derivation receipt must be a JSON object")
    required = {
        "subject_commit": binding.commit,
        "subject_tree": binding.tree,
        "subject_binding_verified": True,
    }
    for key, expected in required.items():
        observed = value.get(key)
        if type(observed) is not type(expected) or observed != expected:
            raise CandidateError(f"subject-bound derivation receipt drifted at {key}")
    if data != _canonical_json_bytes(value):
        raise CandidateError(
            "subject-bound derivation receipt is not exact canonical UTF-8 JSON"
        )


def _load_payload(
    source_root: Path,
    config: AllowlistConfig,
    identity: IdentityProfile,
    binding: subject_binding.SubjectBinding | None = None,
) -> list[tuple[AllowlistEntry, bytes]]:
    root = source_root.absolute()
    if not root.is_dir():
        raise CandidateError("source root is not an existing directory")
    if config.require_git_tracked:
        _require_git_tracked(root, [entry.source for entry in config.files])
    payload: list[tuple[AllowlistEntry, bytes]] = []
    total = 0
    for entry in config.files:
        source = _assert_no_reparse_chain(root, entry.source)
        data = _require_plain_file(
            source, f"allowlisted source {entry.source}", config.max_file_bytes
        )
        observed = _sha256(data)
        if entry.expected_sha256 is not None and observed != entry.expected_sha256:
            raise CandidateError(f"source hash drifted: {entry.source}")
        _validate_subject_bound_receipt(entry, data, binding)
        total += len(data)
        if total > config.max_total_bytes:
            raise CandidateError("allowlisted payload exceeds max_total_bytes")
        payload.append((entry, data))
    source_scan = _scan_documents(
        ((entry.destination, data) for entry, data in payload), identity
    )
    _raise_for_scan(source_scan, "allowlisted payload")
    return payload


def _readme_bytes(config: AllowlistConfig) -> bytes:
    if config.package_name == "lifeline_rl_claim_complete_candidate":
        text = (
            "# LIFELINE-RL claim-complete supplement candidate\n\n"
            f"Status: `{STATUS}`; author approval is required.\n\n"
            f"Purpose: {config.purpose}.\n\n"
            "This exact allowlist is a deterministic anonymous technical release candidate for\n"
            "claims C1 through C10. It includes the admitted claim ledger, reference and neural\n"
            "implementation, targeted tests and verifiers, frozen protocols/configuration, five\n"
            "formal aggregate views, three immutable task-definition files, a 330-row compact\n"
            "receipt projection, portable environment/Superko receipts, and independent audits.\n\n"
            "The seed/pair audit is explicitly descriptive-only and authorizes no significance,\n"
            "confidence, global ranking, causal representation, sample-efficiency, or unseen-size\n"
            "inference. `formal_ready` in a D14--D16 receipt means artifact completeness only.\n\n"
            "Excluded are per-task execution trees, raw games or trajectories, model/checkpoint\n"
            "bytes, logs, caches, databases, credentials, host paths, Git metadata/remotes, paper\n"
            "and PDF files, review/submission prose, and all later extension artifacts. The\n"
            "environment receipt and lock are hash-bound, but no clean-install execution is\n"
            "claimed by this candidate.\n\n"
            "## Local verification\n\n"
            "From the source repository, verify these exact candidate bytes with the same private\n"
            "identity-term file used during the build:\n\n"
            "```text\n"
            "python -B research/iclr2027/supplement_tools/verify_claim_complete.py "
            "--source-root <repo-root> --subject-commit <full-subject-commit> "
            "--subject-tree <full-subject-tree> --candidate <candidate-dir> "
            "--identity-file <private-identity-terms.json>\n"
            "```\n\n"
            "A technical PASS establishes only this allowlist, hash, transformation, claim-coverage,\n"
            "and configured privacy-scan contract. It is not author approval, a final submission\n"
            "package, or acceptance of any scientific claim beyond the admitted ledger. The scan\n"
            "does not execute source or prove absence of arbitrarily computed runtime identifiers;\n"
            "source inclusion and the complete identity-term list still require author review.\n"
        )
        return text.encode("utf-8")
    text = (
        "# LIFELINE-RL supplement candidate\n\n"
        f"Status: `{STATUS}`.\n\n"
        f"Purpose: {config.purpose}.\n\n"
        "This directory is a deterministic, allowlisted review candidate. It is not a\n"
        "release decision, an approved submission package, or evidence that any scientific\n"
        "or reproducibility gate has passed. No release-claim document is generated.\n\n"
        "The default scope is deliberately narrow: a dependency-free reference rules and\n"
        "search-agent implementation plus targeted deterministic tests. It excludes paper\n"
        "files, formal result trees, raw trajectories, checkpoints, logs, caches, databases,\n"
        "archives, credentials, and host-specific paths.\n\n"
        "## Local verification\n\n"
        "From the repository root, verify these exact candidate bytes with the same private\n"
        "identity-term file used during the build:\n\n"
        "```text\n"
        "python -B research/iclr2027/supplement_tools/build_supplement_candidate.py verify --candidate <candidate-dir> --identity-file <private-identity-terms.json>\n"
        "```\n\n"
        "Inside this candidate, the included dependency-free checks can be run with:\n\n"
        "```text\n"
        "python -B -m unittest discover -s tests -t . -p test_*.py\n"
        "```\n\n"
        "A passing verification only establishes file-set, hash, path-class, and configured\n"
        "privacy-scan consistency for this candidate. Human review and an independent\n"
        "submission gate remain mandatory.\n"
    )
    return text.encode("utf-8")


def _expected_paths(config: AllowlistConfig) -> set[str]:
    return {entry.destination for entry in config.files} | set(METADATA_NAMES)


def _tree_bytes(config: AllowlistConfig) -> bytes:
    return ("\n".join(sorted(_expected_paths(config))) + "\n").encode("utf-8")


def _manifest_object(
    config: AllowlistConfig,
    documents: Mapping[str, bytes],
    binding: subject_binding.SubjectBinding | None = None,
) -> dict[str, Any]:
    categories = {entry.destination: entry.category for entry in config.files}
    categories[README_NAME] = "candidate_readme"
    categories[TREE_NAME] = "candidate_tree"
    manifest_paths = sorted(
        {entry.destination for entry in config.files} | {README_NAME, TREE_NAME}
    )
    rows = [
        {
            "path": path,
            "category": categories[path],
            "size_bytes": len(documents[path]),
            "sha256": _sha256(documents[path]),
        }
        for path in manifest_paths
    ]
    result = {
        "schema_version": SCHEMA_VERSION,
        "status": STATUS,
        "package_name": config.package_name,
        "purpose": config.purpose,
        "allowlist_sha256": config.raw_sha256,
        "manifest_scope": (
            "README.md, CANDIDATE_TREE.txt, and every allowlisted payload file; "
            "the manifest and privacy report are excluded to avoid self-reference."
        ),
        "file_count": len(rows),
        "total_bytes": sum(row["size_bytes"] for row in rows),
        "files": rows,
    }
    if binding is not None:
        result.update(binding.public_fields())
        result["subject_binding_verified"] = True
    return result


def _write_exclusive(root: Path, relative: str, data: bytes) -> None:
    destination = root.joinpath(*PurePosixPath(relative).parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as handle:
        handle.write(data)


def _walk_candidate(root: Path) -> tuple[dict[str, Path], set[str]]:
    if not root.exists() and not root.is_symlink():
        raise CandidateError("candidate directory is missing")
    if _is_reparse(root) or not root.is_dir():
        raise CandidateError("candidate root must be a plain directory")
    files: dict[str, Path] = {}
    directories: set[str] = set()
    stack = [root]
    while stack:
        current = stack.pop()
        with os.scandir(current) as iterator:
            for entry in iterator:
                path = Path(entry.path)
                relative = path.relative_to(root).as_posix()
                if entry.is_symlink() or _is_reparse(path):
                    raise CandidateError(
                        f"candidate contains a symlink, junction, or reparse point: {relative}"
                    )
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    directories.add(relative)
                    stack.append(path)
                elif stat.S_ISREG(info.st_mode):
                    files[relative] = path
                else:
                    raise CandidateError(
                        f"candidate contains a special file: {relative}"
                    )
    return files, directories


def _expected_directories(config: AllowlistConfig) -> set[str]:
    expected: set[str] = set()
    for relative in _expected_paths(config):
        parent = PurePosixPath(relative).parent
        while parent.as_posix() != ".":
            expected.add(parent.as_posix())
            parent = parent.parent
    return expected


def _candidate_snapshot_sha256(documents: Mapping[str, bytes]) -> str:
    rows = (
        f"{relative}\t{len(documents[relative])}\t{_sha256(documents[relative])}\n"
        for relative in sorted(documents)
    )
    return _sha256("".join(rows).encode("utf-8"))


def _candidate_snapshot_from_documents(
    documents: Mapping[str, bytes],
    config: AllowlistConfig,
    directories: Iterable[str] | None = None,
) -> CandidateSnapshot:
    try:
        items = tuple(documents.items())
    except (AttributeError, RuntimeError, TypeError) as exc:
        raise CandidateError("candidate documents must be a stable mapping") from exc
    frozen_documents: dict[str, bytes] = {}
    for relative, data in items:
        if type(relative) is not str or type(data) is not bytes:
            raise CandidateError("candidate document keys and values must be str/bytes")
        if relative in frozen_documents:
            raise CandidateError("candidate documents contain duplicate paths")
        frozen_documents[relative] = data
    expected_paths = _expected_paths(config)
    observed_paths = set(frozen_documents)
    if observed_paths != expected_paths:
        raise CandidateError(
            "candidate file set differs from the allowlist "
            f"(missing={sorted(expected_paths - observed_paths)}, "
            f"extra={sorted(observed_paths - expected_paths)})"
        )
    expected_directories = _expected_directories(config)
    if directories is None:
        observed_directories = frozenset(expected_directories)
    else:
        observed_directories = frozenset(directories)
        if any(type(relative) is not str for relative in observed_directories):
            raise CandidateError("candidate directory paths must be strings")
    if set(observed_directories) != expected_directories:
        raise CandidateError(
            "candidate directory set differs from the allowlist "
            f"(missing={sorted(expected_directories - set(observed_directories))}, "
            f"extra={sorted(set(observed_directories) - expected_directories)})"
        )
    immutable_documents = MappingProxyType(frozen_documents)
    return CandidateSnapshot(
        documents=immutable_documents,
        directories=observed_directories,
        sha256=_candidate_snapshot_sha256(immutable_documents),
    )


def _capture_candidate_snapshot(
    candidate: Path, config: AllowlistConfig
) -> CandidateSnapshot:
    files, directories = _walk_candidate(candidate)
    documents = {
        relative: _require_plain_file(
            path,
            f"candidate file {relative}",
            config.max_file_bytes,
        )
        for relative, path in files.items()
    }
    return _candidate_snapshot_from_documents(documents, config, directories)


def _verify_candidate_snapshot(
    snapshot: CandidateSnapshot,
    config: AllowlistConfig,
    identity: IdentityProfile,
    binding: subject_binding.SubjectBinding | None = None,
) -> dict[str, Any]:
    if type(snapshot) is not CandidateSnapshot:
        raise CandidateError("candidate verification requires a frozen byte snapshot")
    if type(snapshot.documents) is not MappingProxyType:
        raise CandidateError("candidate byte snapshot must be immutable")
    if type(snapshot.directories) is not frozenset:
        raise CandidateError("candidate directory snapshot must be immutable")
    if (
        type(snapshot.sha256) is not str
        or not SHA256_RE.fullmatch(snapshot.sha256)
        or snapshot.sha256 != _candidate_snapshot_sha256(snapshot.documents)
    ):
        raise CandidateError("candidate byte snapshot hash is invalid")
    documents = snapshot.documents
    expected_paths = _expected_paths(config)
    observed_paths = set(documents)
    if observed_paths != expected_paths:
        raise CandidateError(
            "candidate file set differs from the allowlist "
            f"(missing={sorted(expected_paths - observed_paths)}, "
            f"extra={sorted(observed_paths - expected_paths)})"
        )
    expected_directories = _expected_directories(config)
    if set(snapshot.directories) != expected_directories:
        raise CandidateError(
            "candidate directory set differs from the allowlist "
            f"(missing={sorted(expected_directories - set(snapshot.directories))}, "
            f"extra={sorted(set(snapshot.directories) - expected_directories)})"
        )
    for relative, data in documents.items():
        if type(relative) is not str or type(data) is not bytes:
            raise CandidateError("candidate byte snapshot has invalid value types")
        if len(data) > config.max_file_bytes:
            raise CandidateError(
                f"candidate file exceeds the configured size limit: {relative}"
            )
    entry_by_destination = {entry.destination: entry for entry in config.files}
    for destination, entry in entry_by_destination.items():
        if (
            entry.expected_sha256 is not None
            and _sha256(documents[destination]) != entry.expected_sha256
        ):
            raise CandidateError(f"candidate payload hash mismatch: {destination}")
        _validate_subject_bound_receipt(entry, documents[destination], binding)

    expected_readme = _readme_bytes(config)
    expected_tree = _tree_bytes(config)
    if documents[README_NAME] != expected_readme:
        raise CandidateError(
            "candidate README does not match the deterministic template"
        )
    if documents[TREE_NAME] != expected_tree:
        raise CandidateError("candidate tree does not match the exact file set")

    expected_manifest = _manifest_object(
        config,
        {
            **{
                entry.destination: documents[entry.destination]
                for entry in config.files
            },
            README_NAME: expected_readme,
            TREE_NAME: expected_tree,
        },
        binding,
    )
    observed_manifest = _strict_json_from_bytes(
        documents[MANIFEST_NAME],
        "candidate manifest is not valid UTF-8 JSON",
    )
    if observed_manifest != expected_manifest:
        raise CandidateError("candidate manifest does not match recomputed hashes")
    if documents[MANIFEST_NAME] != _canonical_json_bytes(expected_manifest):
        raise CandidateError("candidate manifest is not exact canonical UTF-8 JSON")

    scan_documents = [
        (relative, data)
        for relative, data in documents.items()
        if relative != SCAN_NAME
    ]
    expected_scan = _scan_documents(scan_documents, identity)
    _raise_for_scan(expected_scan, "candidate")
    observed_scan = _strict_json_from_bytes(
        documents[SCAN_NAME],
        "privacy scan report is not valid UTF-8 JSON",
    )
    if observed_scan != expected_scan:
        raise CandidateError("privacy scan report does not match a fresh scan")
    if documents[SCAN_NAME] != _canonical_json_bytes(expected_scan):
        raise CandidateError("privacy scan report is not exact canonical UTF-8 JSON")

    result = {
        "status": "PASS",
        "candidate_status": STATUS,
        "package_name": config.package_name,
        "file_count": len(documents),
        "manifest_file_count": expected_manifest["file_count"],
        "manifest_total_bytes": expected_manifest["total_bytes"],
        "privacy_scan": expected_scan["status"],
        "candidate_snapshot_sha256": snapshot.sha256,
    }
    if binding is not None:
        result.update(binding.public_fields())
        result["subject_binding_verified"] = True
    return result


def _verify_candidate(
    candidate: Path,
    config: AllowlistConfig,
    identity: IdentityProfile,
    binding: subject_binding.SubjectBinding | None = None,
) -> dict[str, Any]:
    snapshot = _capture_candidate_snapshot(candidate, config)
    return _verify_candidate_snapshot(snapshot, config, identity, binding)


def build_candidate(
    source_root: Path,
    allowlist_path: Path,
    output: Path,
    identity_file: Path,
    *,
    subject_root: Path | None = None,
    subject_commit: str | None = None,
    subject_tree: str | None = None,
) -> dict[str, Any]:
    config = load_allowlist(allowlist_path)
    identity = load_identity_profile(identity_file)
    subject_snapshot = _subject_snapshot_for_config(
        config,
        allowlist_path,
        source_root,
        subject_root,
        subject_commit,
        subject_tree,
    )
    binding = subject_snapshot.binding if subject_snapshot is not None else None
    payload = _load_payload(source_root, config, identity, binding)
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise CandidateError("output path already exists; overwrite is forbidden")
    if not output.parent.is_dir() or _is_reparse(output.parent):
        raise CandidateError("output parent must be an existing plain directory")

    output.mkdir()
    created = True
    try:
        payload_documents: dict[str, bytes] = {}
        for entry, data in payload:
            _write_exclusive(output, entry.destination, data)
            payload_documents[entry.destination] = data
        readme = _readme_bytes(config)
        tree = _tree_bytes(config)
        _write_exclusive(output, README_NAME, readme)
        _write_exclusive(output, TREE_NAME, tree)
        manifest = _manifest_object(
            config,
            {
                **payload_documents,
                README_NAME: readme,
                TREE_NAME: tree,
            },
            binding,
        )
        manifest_bytes = _canonical_json_bytes(manifest)
        _write_exclusive(output, MANIFEST_NAME, manifest_bytes)
        scan = _scan_documents(
            [
                *payload_documents.items(),
                (README_NAME, readme),
                (TREE_NAME, tree),
                (MANIFEST_NAME, manifest_bytes),
            ],
            identity,
        )
        _raise_for_scan(scan, "candidate")
        _write_exclusive(output, SCAN_NAME, _canonical_json_bytes(scan))
        result = _verify_candidate(output, config, identity, binding)
        if subject_snapshot is not None:
            try:
                subject_binding.assert_subject_snapshot_unchanged(subject_snapshot)
            except subject_binding.SubjectBindingError as exc:
                raise CandidateError(str(exc)) from exc
        created = False
        return result
    finally:
        if created and output.exists() and not output.is_symlink():
            shutil.rmtree(output)


def verify_candidate(
    candidate: Path,
    allowlist_path: Path,
    identity_file: Path,
    *,
    subject_root: Path | None = None,
    subject_commit: str | None = None,
    subject_tree: str | None = None,
    _expected_identity_profile: IdentityProfile | None = None,
) -> dict[str, Any]:
    config = load_allowlist(allowlist_path)
    identity = load_identity_profile(identity_file)
    if (
        _expected_identity_profile is not None
        and identity != _expected_identity_profile
    ):
        raise CandidateError("identity terms file does not match the workflow snapshot")
    if _expected_identity_profile is not None:
        identity = _expected_identity_profile
    subject_snapshot = _subject_snapshot_for_config(
        config,
        allowlist_path,
        subject_root,
        subject_root,
        subject_commit,
        subject_tree,
    )
    binding = subject_snapshot.binding if subject_snapshot is not None else None
    result = _verify_candidate(candidate.absolute(), config, identity, binding)
    if subject_snapshot is not None:
        try:
            subject_binding.assert_subject_snapshot_unchanged(subject_snapshot)
        except subject_binding.SubjectBindingError as exc:
            raise CandidateError(str(exc)) from exc
    return result


def _default_allowlist() -> Path:
    return Path(__file__).with_name("supplement_allowlist.json")


def _default_source_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build or verify a fail-closed supplement candidate directory."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="build a new candidate directory")
    build.add_argument("--source-root", type=Path, default=_default_source_root())
    build.add_argument("--allowlist", type=Path, default=_default_allowlist())
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--identity-file", type=Path, required=True)
    build.add_argument("--subject-root", type=Path)
    build.add_argument("--subject-commit")
    build.add_argument("--subject-tree")
    verify = subparsers.add_parser("verify", help="verify an existing candidate")
    verify.add_argument("--allowlist", type=Path, default=_default_allowlist())
    verify.add_argument("--candidate", type=Path, required=True)
    verify.add_argument("--identity-file", type=Path, required=True)
    verify.add_argument("--subject-root", type=Path)
    verify.add_argument("--subject-commit")
    verify.add_argument("--subject-tree")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build_candidate(
                args.source_root,
                args.allowlist,
                args.output,
                args.identity_file,
                subject_root=args.subject_root,
                subject_commit=args.subject_commit,
                subject_tree=args.subject_tree,
            )
        else:
            result = verify_candidate(
                args.candidate,
                args.allowlist,
                args.identity_file,
                subject_root=args.subject_root,
                subject_commit=args.subject_commit,
                subject_tree=args.subject_tree,
            )
    except CandidateError as exc:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "candidate_status": STATUS,
                    "error": str(exc),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
