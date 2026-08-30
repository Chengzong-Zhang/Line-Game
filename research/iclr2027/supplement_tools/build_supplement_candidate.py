from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


STATUS = "candidate_only_not_approved"
SCHEMA_VERSION = 1
SCANNER_VERSION = 1
README_NAME = "README.md"
TREE_NAME = "CANDIDATE_TREE.txt"
MANIFEST_NAME = "SHA256_MANIFEST.json"
SCAN_NAME = "PRIVACY_SCAN.json"
METADATA_NAMES = (README_NAME, TREE_NAME, MANIFEST_NAME, SCAN_NAME)

SAFE_PATH_RE = re.compile(r"[A-Za-z0-9._/-]+")
SAFE_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
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
    ".json",
    ".jsonl",
    ".md",
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
            r"|\\\\[^\\/\s]+[\\/][^\s]+)"
        ),
    ),
    (
        "unix_absolute_path",
        re.compile(r"(?i)(?<![A-Za-z0-9_.-])/(?:home|users|root|mnt|tmp|var|etc|opt|srv)/[^\s\"'<>]+"),
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
    (
        "credential_assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|auth[_-]?token)\b\s*[:=]\s*[\"']?[^\s\"',;}]{8,}"
        ),
    ),
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


@dataclass(frozen=True)
class AllowlistEntry:
    source: str
    destination: str
    category: str
    expected_sha256: str


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
    return value


def _check_artifact_policy(relative: str, label: str) -> None:
    lowered = relative.casefold()
    parts = tuple(part.casefold() for part in PurePosixPath(relative).parts)
    if any(part in FORBIDDEN_COMPONENTS for part in parts):
        raise CandidateError(
            f"allowlisted {label} uses a forbidden directory: {relative}"
        )
    if any(lowered.startswith(prefix) for prefix in FORBIDDEN_SOURCE_PREFIXES):
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
    if any(token in name for token in suspicious_tokens):
        raise CandidateError(
            f"allowlisted {label} name is a forbidden artifact class: {relative}"
        )


def load_allowlist(path: Path) -> AllowlistConfig:
    data = _require_plain_file(path, "allowlist", 1024 * 1024)
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CandidateError("allowlist must be valid UTF-8 JSON") from exc
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
    seen_sources: set[str] = set()
    seen_destinations: set[str] = set(METADATA_NAMES)
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
        if not isinstance(expected_sha256, str) or not SHA256_RE.fullmatch(
            expected_sha256
        ):
            raise CandidateError(
                f"files[{index}].expected_sha256 must be lowercase SHA-256"
            )
        if source in seen_sources:
            raise CandidateError(f"duplicate source in allowlist: {source}")
        if destination in seen_destinations:
            raise CandidateError(f"duplicate or reserved destination: {destination}")
        seen_sources.add(source)
        seen_destinations.add(destination)
        entries.append(
            AllowlistEntry(source, destination, category, expected_sha256)
        )

    return AllowlistConfig(
        package_name=package_name,
        purpose=purpose,
        require_git_tracked=require_git_tracked,
        max_file_bytes=max_file_bytes,
        max_total_bytes=max_total_bytes,
        files=tuple(entries),
        raw_sha256=_sha256(data),
    )


def load_identity_profile(path: Path) -> IdentityProfile:
    data = _require_plain_file(path, "identity terms file", MAX_IDENTITY_FILE_BYTES)
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CandidateError("identity terms file must be valid UTF-8 JSON") from exc
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
            raise CandidateError("identity terms contain a duplicate after normalization")
        seen.add(folded)
        terms.append(value)
        normalized.append(folded)
    digest = _sha256(_canonical_json_bytes(sorted(normalized)))
    return IdentityProfile(tuple(terms), tuple(normalized), digest)


def _scan_documents(
    documents: Iterable[tuple[str, bytes]], identity: IdentityProfile
) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    scanned_files = 0
    scanned_bytes = 0
    for relative, data in sorted(documents, key=lambda item: item[0]):
        scanned_files += 1
        scanned_bytes += len(data)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            findings.append({"path": relative, "rule": "non_utf8_content"})
            continue
        if any(unicodedata.category(char) == "Cf" for char in text):
            findings.append({"path": relative, "rule": "unicode_format_control"})
        search_text = relative + "\n" + text
        for rule, pattern in GENERIC_SCAN_PATTERNS:
            if pattern.search(search_text):
                findings.append({"path": relative, "rule": rule})
        folded = _normalize_identity(search_text)
        for index, term in enumerate(identity.normalized_terms):
            if term in folded:
                findings.append(
                    {"path": relative, "rule": f"private_identity_term_{index + 1}"}
                )
    findings.sort(key=lambda item: (item["path"], item["rule"]))
    return {
        "schema_version": SCHEMA_VERSION,
        "scanner_version": SCANNER_VERSION,
        "status": "PASS" if not findings else "FAIL",
        "candidate_status": STATUS,
        "scanned_file_count": scanned_files,
        "scanned_bytes": scanned_bytes,
        "identity_term_count": len(identity.terms),
        "identity_terms_sha256": identity.digest,
        "findings": findings,
    }


def _raise_for_scan(scan: Mapping[str, Any], label: str) -> None:
    findings = scan.get("findings")
    if scan.get("status") == "PASS" and findings == []:
        return
    safe_summary = ", ".join(
        f"{item.get('path', '?')}:{item.get('rule', '?')}"
        for item in findings or []
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


def _load_payload(
    source_root: Path,
    config: AllowlistConfig,
    identity: IdentityProfile,
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
        if observed != entry.expected_sha256:
            raise CandidateError(f"source hash drifted: {entry.source}")
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
    config: AllowlistConfig, documents: Mapping[str, bytes]
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
    return {
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
                    raise CandidateError(f"candidate contains a special file: {relative}")
    return files, directories


def _expected_directories(config: AllowlistConfig) -> set[str]:
    expected: set[str] = set()
    for relative in _expected_paths(config):
        parent = PurePosixPath(relative).parent
        while parent.as_posix() != ".":
            expected.add(parent.as_posix())
            parent = parent.parent
    return expected


def _verify_candidate(
    candidate: Path,
    config: AllowlistConfig,
    identity: IdentityProfile,
) -> dict[str, Any]:
    files, directories = _walk_candidate(candidate)
    expected_paths = _expected_paths(config)
    observed_paths = set(files)
    if observed_paths != expected_paths:
        raise CandidateError(
            "candidate file set differs from the allowlist "
            f"(missing={sorted(expected_paths - observed_paths)}, "
            f"extra={sorted(observed_paths - expected_paths)})"
        )
    expected_directories = _expected_directories(config)
    if directories != expected_directories:
        raise CandidateError(
            "candidate directory set differs from the allowlist "
            f"(missing={sorted(expected_directories - directories)}, "
            f"extra={sorted(directories - expected_directories)})"
        )

    documents = {
        relative: _require_plain_file(
            path,
            f"candidate file {relative}",
            HARD_MAX_FILE_BYTES,
        )
        for relative, path in files.items()
    }
    entry_by_destination = {entry.destination: entry for entry in config.files}
    for destination, entry in entry_by_destination.items():
        if _sha256(documents[destination]) != entry.expected_sha256:
            raise CandidateError(f"candidate payload hash mismatch: {destination}")

    expected_readme = _readme_bytes(config)
    expected_tree = _tree_bytes(config)
    if documents[README_NAME] != expected_readme:
        raise CandidateError("candidate README does not match the deterministic template")
    if documents[TREE_NAME] != expected_tree:
        raise CandidateError("candidate tree does not match the exact file set")

    expected_manifest = _manifest_object(
        config,
        {
            **{entry.destination: documents[entry.destination] for entry in config.files},
            README_NAME: expected_readme,
            TREE_NAME: expected_tree,
        },
    )
    try:
        observed_manifest = json.loads(documents[MANIFEST_NAME].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CandidateError("candidate manifest is not valid UTF-8 JSON") from exc
    if observed_manifest != expected_manifest:
        raise CandidateError("candidate manifest does not match recomputed hashes")

    scan_documents = [
        (relative, data)
        for relative, data in documents.items()
        if relative != SCAN_NAME
    ]
    expected_scan = _scan_documents(scan_documents, identity)
    _raise_for_scan(expected_scan, "candidate")
    try:
        observed_scan = json.loads(documents[SCAN_NAME].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CandidateError("privacy scan report is not valid UTF-8 JSON") from exc
    if observed_scan != expected_scan:
        raise CandidateError("privacy scan report does not match a fresh scan")

    return {
        "status": "PASS",
        "candidate_status": STATUS,
        "package_name": config.package_name,
        "file_count": len(files),
        "manifest_file_count": expected_manifest["file_count"],
        "manifest_total_bytes": expected_manifest["total_bytes"],
        "privacy_scan": expected_scan["status"],
    }


def build_candidate(
    source_root: Path,
    allowlist_path: Path,
    output: Path,
    identity_file: Path,
) -> dict[str, Any]:
    config = load_allowlist(allowlist_path)
    identity = load_identity_profile(identity_file)
    payload = _load_payload(source_root, config, identity)
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
        result = _verify_candidate(output, config, identity)
        created = False
        return result
    finally:
        if created and output.exists() and not output.is_symlink():
            shutil.rmtree(output)


def verify_candidate(
    candidate: Path, allowlist_path: Path, identity_file: Path
) -> dict[str, Any]:
    config = load_allowlist(allowlist_path)
    identity = load_identity_profile(identity_file)
    return _verify_candidate(candidate.absolute(), config, identity)


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
    verify = subparsers.add_parser("verify", help="verify an existing candidate")
    verify.add_argument("--allowlist", type=Path, default=_default_allowlist())
    verify.add_argument("--candidate", type=Path, required=True)
    verify.add_argument("--identity-file", type=Path, required=True)
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
            )
        else:
            result = verify_candidate(
                args.candidate,
                args.allowlist,
                args.identity_file,
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
