#!/usr/bin/env python3
"""Recover the frozen D17/D18-v1 canonical numeric artifact from an export.

This adapter is deliberately narrow.  It accepts only the frozen manifest,
the deterministic task bundle, and a complete lightweight runner export.  It
does not consume independent-verifier output and it never writes to any input.

The export is completely authenticated before the frozen runner is invoked.
The runner's canonical aggregation implementation is then used under a small,
explicit, and always-restored read-only adapter: remote receipt artifact paths
are mapped to their authenticated local export copies and ledger finalization
is replaced by the already-validated immutable ledger status so that the
runner cannot update the export.
"""

from __future__ import annotations

import argparse
import builtins
import contextlib
import copy
import ctypes
import errno
import hashlib
import importlib
import importlib.abc
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import types
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
SCRIPT_DIRECTORY = SCRIPT_PATH.parent
RESEARCH_ROOT = SCRIPT_DIRECTORY.parent
REPOSITORY_ROOT = RESEARCH_ROOT.parents[1]
RUNNER_PATH = SCRIPT_DIRECTORY / "d17_d19_runner.py"
EXPERIMENTS_PATH = SCRIPT_DIRECTORY / "d17_d19_experiments.py"


EXPECTED_RUNNER_SHA256 = (
    "d128dfe4a2480b4523ca6bc37642bc393bead4c7ba0d037dc692808fc3d52991"
)
EXPECTED_EXPERIMENTS_SHA256 = (
    "34d4aba6d38d51b1af1602745aaee8a234c611ed9eff985fe218f68fc83feb05"
)
EXPECTED_FORMAL_SOURCE_HASH = (
    "21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c"
)
EXPECTED_LIFELINE_SOURCE_FILES = 25
PRIVATE_RUNNER_MODULE = "_lifeline_d17_d19_canonical_runner"
PRIVATE_EXPERIMENTS_MODULE = "_lifeline_d17_d19_canonical_experiments"
PRIVATE_LIFELINE_PACKAGE = "_lifeline_d17_d19_canonical_lifeline_rl"
RUNTIME_MODULE_FILES = {
    PRIVATE_RUNNER_MODULE: "scripts/d17_d19_runner.py",
    PRIVATE_EXPERIMENTS_MODULE: "scripts/d17_d19_experiments.py",
    PRIVATE_LIFELINE_PACKAGE: "lifeline_rl/__init__.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.arena": "lifeline_rl/arena.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.core": "lifeline_rl/core.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.encoding": "lifeline_rl/encoding.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.env": "lifeline_rl/env.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents": "lifeline_rl/agents/__init__.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.base": "lifeline_rl/agents/base.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.cycle_seeking": (
        "lifeline_rl/agents/cycle_seeking.py"
    ),
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.factory": "lifeline_rl/agents/factory.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.greedy": "lifeline_rl/agents/greedy.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.heuristic": ("lifeline_rl/agents/heuristic.py"),
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.mcts": "lifeline_rl/agents/mcts.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.minimax": "lifeline_rl/agents/minimax.py",
    f"{PRIVATE_LIFELINE_PACKAGE}.agents.random_agent": (
        "lifeline_rl/agents/random_agent.py"
    ),
}
EXPECTED_EXPORT_ENTRIES = 259
EXPECTED_TASKS = 85
EXPECTED_TASK_ARTIFACTS = 85
EXPECTED_GAME_ROWS = 8_320
EXPECTED_COMPARISON_ROWS = 17
ROOT_EXPORT_FILES = (
    "execution_metadata.json",
    "execution_summary.json",
    "result_ledger_status.json",
    "result_receipts.jsonl",
)
TASK_EXPORT_FILES = ("receipt.json", "summary.json", "games.jsonl")
EXPORT_MANIFEST_NAME = "export_manifest.json"
CANONICAL_NAME = "canonical_numeric.json"
DERIVATION_RECEIPT_NAME = "canonical_derivation_receipt.json"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
WINDOWS_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:/")
REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
AT_FDCWD = -100
RENAME_NOREPLACE = 1


class RecoveryError(ValueError):
    """Raised when any recovery precondition or immutable binding fails."""


@dataclass(frozen=True)
class ExportInventory:
    root: Path
    manifest: dict[str, Any]
    manifest_sha256: str
    remote_export_root: str
    paths: dict[str, Path]
    hashes: dict[str, str]
    payload_tree_sha256: str
    all_input_paths: tuple[Path, ...]


@dataclass(frozen=True)
class RecoveryContext:
    manifest_path: Path
    bundle_directory: Path
    manifest: dict[str, Any]
    tasks: tuple[dict[str, Any], ...]
    games: tuple[dict[str, Any], ...]
    metadata: dict[str, Any]
    ledger_status: dict[str, Any]
    execution_summary: dict[str, Any]
    mapped_receipts: dict[Path, dict[str, Any]]
    export: ExportInventory
    bindings: dict[str, str]
    counts: dict[str, int]
    input_roles: dict[str, Path]
    input_fingerprints: dict[Path, str]
    input_fingerprint_sha256: str


@dataclass(frozen=True)
class NewOutputTarget:
    path: Path
    parent: Path
    parent_identity: tuple[int, int]


@dataclass(frozen=True)
class FrozenSourceFile:
    relative_path: str
    path: Path
    payload: bytes
    sha256: str


@dataclass(frozen=True)
class AuthenticatedSource:
    module_name: str
    source: FrozenSourceFile
    code: types.CodeType
    is_package: bool


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _reject_constant(token: str) -> None:
    raise RecoveryError(f"non-finite JSON number is forbidden: {token}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RecoveryError(f"duplicate JSON object key is forbidden: {key!r}")
        result[key] = value
    return result


def _strict_json_text(text: str, *, label: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise RecoveryError(f"invalid strict JSON in {label}: {exc}") from exc


def _load_json(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    try:
        text = source.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RecoveryError(f"cannot read JSON artifact {source}: {exc}") from exc
    value = _strict_json_text(text, label=str(source))
    if not isinstance(value, dict):
        raise RecoveryError(f"JSON artifact must contain an object: {source}")
    return value


def _load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    source = Path(path)
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RecoveryError(f"cannot read JSONL artifact {source}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line:
            raise RecoveryError(f"blank JSONL line at {source}:{line_number}")
        value = _strict_json_text(line, label=f"{source}:{line_number}")
        if not isinstance(value, dict):
            raise RecoveryError(
                f"JSONL line must contain an object at {source}:{line_number}"
            )
        rows.append(value)
    return rows


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def _require_sha256(value: Any, *, label: str) -> str:
    if not _valid_sha256(value):
        raise RecoveryError(f"{label} must be a lowercase SHA-256 digest")
    return str(value)


def _require_int(value: Any, *, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RecoveryError(f"{label} must be an integer >= {minimum}")
    return value


def _require_utc(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise RecoveryError(f"{label} must be a UTC timestamp ending in Z")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise RecoveryError(f"{label} is not a valid UTC timestamp") from exc
    return value


def _has_reparse_attribute(stat_result: os.stat_result) -> bool:
    attributes = int(getattr(stat_result, "st_file_attributes", 0))
    return bool(attributes & REPARSE_ATTRIBUTE)


def _reject_link_or_reparse(path: Path, *, expect_directory: bool | None) -> None:
    try:
        result = os.lstat(path)
    except OSError as exc:
        raise RecoveryError(f"cannot lstat input {path}: {exc}") from exc
    if stat.S_ISLNK(result.st_mode) or _has_reparse_attribute(result):
        raise RecoveryError(f"symlink/reparse input is forbidden: {path}")
    if expect_directory is True and not stat.S_ISDIR(result.st_mode):
        raise RecoveryError(f"expected an input directory: {path}")
    if expect_directory is False and not stat.S_ISREG(result.st_mode):
        raise RecoveryError(f"expected a regular input file: {path}")


def _scan_regular_tree(root: Path) -> tuple[Path, dict[str, Path]]:
    raw_root = Path(os.path.abspath(root))
    _reject_link_or_reparse(raw_root, expect_directory=True)
    resolved_root = raw_root.resolve(strict=True)
    files: dict[str, Path] = {}

    def visit(directory: Path, relative_parts: tuple[str, ...]) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError as exc:
            raise RecoveryError(
                f"cannot enumerate input directory {directory}: {exc}"
            ) from exc
        for entry in entries:
            path = Path(entry.path)
            try:
                result = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise RecoveryError(f"cannot lstat export entry {path}: {exc}") from exc
            if (
                entry.is_symlink()
                or stat.S_ISLNK(result.st_mode)
                or _has_reparse_attribute(result)
            ):
                raise RecoveryError(
                    f"symlink/reparse export entry is forbidden: {path}"
                )
            parts = (*relative_parts, entry.name)
            if entry.is_dir(follow_symlinks=False):
                visit(path, parts)
            elif entry.is_file(follow_symlinks=False) and stat.S_ISREG(result.st_mode):
                resolved = path.resolve(strict=True)
                try:
                    resolved.relative_to(resolved_root)
                except ValueError as exc:
                    raise RecoveryError(
                        f"export path escapes its root: {path}"
                    ) from exc
                relative = "/".join(parts)
                if relative in files:
                    raise RecoveryError(f"duplicate export-relative path: {relative}")
                files[relative] = resolved
            else:
                raise RecoveryError(f"non-regular export entry is forbidden: {path}")

    visit(resolved_root, ())
    return resolved_root, files


def _normalise_foreign_absolute_path(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise RecoveryError(f"{label} must be a non-empty absolute path string")
    raw = value.replace("\\", "/")
    if raw.startswith("//"):
        raise RecoveryError(f"{label} must not use an ambiguous UNC/network root")
    if raw.startswith("/"):
        prefix = "/"
        tail = raw[1:]
    elif WINDOWS_DRIVE_PATTERN.match(raw):
        prefix = raw[:3]
        tail = raw[3:]
    else:
        raise RecoveryError(f"{label} must be an absolute POSIX or drive path")
    parts = tail.split("/") if tail else []
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise RecoveryError(f"{label} contains an empty or escaping path component")
    normalised = "/".join(parts)
    return prefix + normalised


def _foreign_parent(path: str) -> str:
    return path.rsplit("/", 1)[0]


def _foreign_join(root: str, relative: str) -> str:
    return root.rstrip("/") + "/" + relative


def _expected_export_relatives(task_directories: Sequence[str]) -> list[str]:
    relatives = list(ROOT_EXPORT_FILES)
    for directory in sorted(task_directories):
        relatives.extend(f"tasks/{directory}/{name}" for name in TASK_EXPORT_FILES)
    if len(relatives) != EXPECTED_EXPORT_ENTRIES:
        raise RecoveryError(
            f"internal expected export matrix has {len(relatives)} files, "
            f"expected {EXPECTED_EXPORT_ENTRIES}"
        )
    return relatives


def _validate_export_manifest(
    export_directory: str | Path, *, task_directories: Sequence[str]
) -> ExportInventory:
    root, local_files = _scan_regular_tree(Path(export_directory))
    expected_relatives = _expected_export_relatives(task_directories)
    expected_tree = set(expected_relatives) | {EXPORT_MANIFEST_NAME}
    observed_tree = set(local_files)
    if observed_tree != expected_tree:
        missing = sorted(expected_tree - observed_tree)[:10]
        extra = sorted(observed_tree - expected_tree)[:10]
        raise RecoveryError(
            "lightweight export file set is not exact: "
            f"missing={missing}, extra={extra}"
        )
    manifest_path = local_files[EXPORT_MANIFEST_NAME]
    manifest = _load_json(manifest_path)
    if set(manifest) != {
        "schema_name",
        "schema_version",
        "source_run_root",
        "files",
        "pair_scratch_exported",
        "created_at_utc",
    }:
        raise RecoveryError("export_manifest.json has an unexpected top-level schema")
    if (
        manifest.get("schema_name") != "lifeline-d17-d19-lightweight-export"
        or manifest.get("schema_version") != 1
        or manifest.get("pair_scratch_exported") is not False
    ):
        raise RecoveryError("export manifest schema or pair-scratch policy is invalid")
    _normalise_foreign_absolute_path(
        manifest.get("source_run_root"), label="export_manifest.source_run_root"
    )
    _require_utc(manifest.get("created_at_utc"), label="export_manifest.created_at_utc")
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != EXPECTED_EXPORT_ENTRIES:
        raise RecoveryError(
            "export manifest must contain exactly "
            f"{EXPECTED_EXPORT_ENTRIES} file entries"
        )
    remote_paths: list[str] = []
    declared_hashes: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise RecoveryError(f"export_manifest.files[{index}] has invalid schema")
        remote_paths.append(
            _normalise_foreign_absolute_path(
                entry.get("path"), label=f"export_manifest.files[{index}].path"
            )
        )
        declared_hashes.append(
            _require_sha256(
                entry.get("sha256"), label=f"export_manifest.files[{index}].sha256"
            )
        )
    remote_export_root = _foreign_parent(remote_paths[0])
    for index, (relative, remote_path) in enumerate(
        zip(expected_relatives, remote_paths, strict=True)
    ):
        expected_remote = _foreign_join(remote_export_root, relative)
        if remote_path != expected_remote:
            raise RecoveryError(
                f"export manifest path/order mismatch at entry {index}: "
                f"expected suffix {relative!r}"
            )
    if len(set(remote_paths)) != EXPECTED_EXPORT_ENTRIES:
        raise RecoveryError("export manifest contains duplicate paths")
    hashes: dict[str, str] = {}
    paths: dict[str, Path] = {}
    for index, relative in enumerate(expected_relatives):
        path = local_files[relative]
        observed = _sha256_file(path)
        if observed != declared_hashes[index]:
            raise RecoveryError(f"export payload SHA-256 mismatch: {relative}")
        hashes[relative] = observed
        paths[relative] = path
    payload_tree = _canonical_sha256(
        [
            {"path": relative, "sha256": hashes[relative]}
            for relative in expected_relatives
        ]
    )
    return ExportInventory(
        root=root,
        manifest=manifest,
        manifest_sha256=_sha256_file(manifest_path),
        remote_export_root=remote_export_root,
        paths=paths,
        hashes=hashes,
        payload_tree_sha256=payload_tree,
        all_input_paths=tuple(paths[relative] for relative in expected_relatives)
        + (manifest_path,),
    )


def _validate_strict_bundle_inputs(
    manifest_path: Path, bundle_directory: Path
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
    tuple[Path, ...],
    dict[Path, str],
]:
    _reject_link_or_reparse(manifest_path, expect_directory=False)
    _reject_link_or_reparse(bundle_directory, expect_directory=True)
    required_names = (
        "manifest_snapshot.json",
        "materialized_manifest_snapshot.json",
        "tasks.jsonl",
        "game_manifest.jsonl",
        "bundle_summary.json",
    )
    bundle_paths = tuple(bundle_directory / name for name in required_names)
    for path in bundle_paths:
        _reject_link_or_reparse(path, expect_directory=False)
    inputs = (manifest_path, *bundle_paths)
    initial_fingerprints = _fingerprint(inputs)
    strict_manifest = _load_json(manifest_path)
    _load_json(bundle_paths[0])
    _load_json(bundle_paths[1])
    strict_tasks = _load_jsonl(bundle_paths[2])
    strict_games = _load_jsonl(bundle_paths[3])
    _load_json(bundle_paths[4])
    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    try:
        manifest = runner.load_manifest(manifest_path)
        _, tasks, games = runner.load_task_bundle(manifest, bundle_directory)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RecoveryError(
            f"frozen manifest/task bundle validation failed: {exc}"
        ) from exc
    if strict_manifest != manifest or strict_tasks != tasks or strict_games != games:
        raise RecoveryError("strict bundle parse disagrees with frozen runner parse")
    if len(tasks) != EXPECTED_TASKS or len(games) != EXPECTED_GAME_ROWS:
        raise RecoveryError(
            f"task bundle must contain {EXPECTED_TASKS} tasks and "
            f"{EXPECTED_GAME_ROWS} game schedules"
        )
    if _fingerprint(inputs) != initial_fingerprints:
        raise RecoveryError("manifest/task bundle changed while it was validated")
    return manifest, tasks, games, inputs, initial_fingerprints


def _validate_execution_metadata(
    metadata: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    bundle_directory: Path,
) -> dict[str, str]:
    expected_keys = {
        "schema_name",
        "schema_version",
        "experiment_id",
        "manifest_path",
        "manifest_sha256",
        "protocol_path",
        "protocol_sha256",
        "source_files_verified",
        "bundle_directory",
        "task_manifest_sha256",
        "game_manifest_sha256",
        "run_root",
        "runner_path",
        "runner_sha256",
        "experiments_sha256",
        "python_version",
        "torch_version",
        "cuda_runtime_version",
        "cudnn_version",
        "device",
        "device_name",
        "formal_source_hash",
    }
    if set(metadata) != expected_keys:
        raise RecoveryError("execution_metadata.json has an unexpected schema")
    _assert_authenticated_runtime_unchanged()
    runner_sha256 = _AUTHENTICATED_RUNTIME_SOURCES[PRIVATE_RUNNER_MODULE].source.sha256
    experiments_sha256 = _AUTHENTICATED_RUNTIME_SOURCES[
        PRIVATE_EXPERIMENTS_MODULE
    ].source.sha256
    task_sha256 = _sha256_file(bundle_directory / "tasks.jsonl")
    game_sha256 = _sha256_file(bundle_directory / "game_manifest.jsonl")
    protocol_path = runner.resolve_manifest_path(
        str(manifest["protocol_path"]), manifest_path=manifest_path
    )
    _reject_link_or_reparse(protocol_path, expect_directory=False)
    protocol_sha256 = _sha256_file(protocol_path)
    try:
        source_files_verified = runner._validate_manifest_source_files(
            manifest, manifest_path=manifest_path
        )
        formal_source_hash = _validate_frozen_source_identity(
            runner._checkpoint_rows(manifest)
        )
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RecoveryError(
            f"execution source binding validation failed: {exc}"
        ) from exc
    semantic_expected = {
        "schema_name": runner.RUN_SCHEMA_NAME,
        "schema_version": runner.SCHEMA_VERSION,
        "experiment_id": runner.BUNDLE_EXPERIMENT_ID,
        "manifest_sha256": runner.manifest_hash(manifest),
        "protocol_sha256": protocol_sha256,
        "source_files_verified": source_files_verified,
        "task_manifest_sha256": task_sha256,
        "game_manifest_sha256": game_sha256,
        "runner_sha256": runner_sha256,
        "experiments_sha256": experiments_sha256,
        "formal_source_hash": formal_source_hash,
    }
    for field, expected in semantic_expected.items():
        if metadata.get(field) != expected:
            raise RecoveryError(f"execution metadata semantic mismatch for {field}")
    expected_basenames = {
        "manifest_path": manifest_path.name,
        "protocol_path": protocol_path.name,
        "bundle_directory": bundle_directory.name,
        "run_root": "formal_run",
        "runner_path": Path(runner.__file__).name,
    }
    for field, basename in expected_basenames.items():
        normalised = _normalise_foreign_absolute_path(
            metadata.get(field), label=f"execution_metadata.{field}"
        )
        if normalised.rsplit("/", 1)[-1] != basename:
            raise RecoveryError(f"execution metadata path mismatch for {field}")
    for field in ("python_version", "torch_version", "device"):
        if not isinstance(metadata.get(field), str) or not metadata[field]:
            raise RecoveryError(f"execution_metadata.{field} must be non-empty")
    if str(metadata["device"]).startswith("cuda") and (
        not isinstance(metadata.get("device_name"), str) or not metadata["device_name"]
    ):
        raise RecoveryError("CUDA execution metadata must bind a device name")
    return {
        "runner_sha256": runner_sha256,
        "experiments_sha256": experiments_sha256,
        "protocol_sha256": protocol_sha256,
        "protocol_file_sha256": protocol_sha256,
        "task_manifest_sha256": task_sha256,
        "game_manifest_sha256": game_sha256,
        "manifest_canonical_sha256": runner.manifest_hash(manifest),
        "formal_source_hash": formal_source_hash,
    }


def _remote_task_artifact(
    metadata: Mapping[str, Any], task_directory: str, filename: str
) -> str:
    run_root = _normalise_foreign_absolute_path(
        metadata.get("run_root"), label="execution_metadata.run_root"
    )
    return _foreign_join(run_root, f"tasks/{task_directory}/{filename}")


def _validate_export_run_root_binding(
    inventory: ExportInventory, metadata: Mapping[str, Any]
) -> None:
    metadata_run_root = _normalise_foreign_absolute_path(
        metadata.get("run_root"), label="execution_metadata.run_root"
    )
    manifest_run_root = _normalise_foreign_absolute_path(
        inventory.manifest.get("source_run_root"),
        label="export_manifest.source_run_root",
    )
    if manifest_run_root != metadata_run_root:
        raise RecoveryError(
            "export source_run_root does not match execution metadata run_root"
        )


def _mapped_receipt(
    receipt: Mapping[str, Any], *, games_path: Path, summary_path: Path
) -> dict[str, Any]:
    mapped = copy.deepcopy(dict(receipt))
    mapped["games_path"] = str(games_path)
    mapped["arena_games_path"] = str(games_path)
    mapped["arena_summary_path"] = str(summary_path)
    return mapped


def _validate_ledger_status_and_summary(
    status: Mapping[str, Any],
    summary: Mapping[str, Any],
    *,
    metadata: Mapping[str, Any],
    ledger_sha256: str,
    receipts: Sequence[Mapping[str, Any]],
) -> None:
    status_keys = {
        "schema_name",
        "schema_version",
        "bundle_id",
        "manifest_sha256",
        "protocol_sha256",
        "runner_sha256",
        "experiments_sha256",
        "task_manifest_sha256",
        "game_manifest_sha256",
        "receipts_present",
        "receipt_count",
        "complete_tasks",
        "failed_tasks",
        "execution_failed_tasks",
        "execution_failed_preview",
        "gate_failed_tasks",
        "gate_failed_preview",
        "missing_tasks",
        "missing_preview",
        "execution_complete",
        "independent_verification_passed",
        "independent_verification_path",
        "formal_ready",
        "result_ledger",
        "result_ledger_sha256",
        "ledger_sha256",
        "result_receipts_sha256",
        "updated_at_utc",
    }
    summary_only = {
        "attempted_this_invocation",
        "failures_this_invocation",
        "execution_failures_this_invocation",
        "gate_failures_this_invocation",
        "skipped_complete",
        "skipped_failed",
        "skipped_gate_failed",
        "device",
    }
    if set(status) != status_keys or set(summary) != status_keys | summary_only:
        raise RecoveryError("ledger status or execution summary schema is unexpected")
    for field in status_keys:
        if summary.get(field) != status.get(field):
            raise RecoveryError(
                f"execution summary disagrees with ledger status: {field}"
            )
    gate_failed = [
        str(receipt["task_id"])
        for receipt in receipts
        if receipt.get("gate_status") == "failed"
    ]
    expected_values = {
        "schema_name": runner.RUN_SCHEMA_NAME,
        "schema_version": runner.SCHEMA_VERSION,
        "bundle_id": runner.BUNDLE_EXPERIMENT_ID,
        "receipts_present": EXPECTED_TASKS,
        "receipt_count": EXPECTED_TASKS,
        "complete_tasks": EXPECTED_TASKS,
        "failed_tasks": 0,
        "execution_failed_tasks": 0,
        "execution_failed_preview": [],
        "gate_failed_tasks": len(gate_failed),
        "gate_failed_preview": gate_failed[:10],
        "missing_tasks": 0,
        "missing_preview": [],
        "execution_complete": True,
        "independent_verification_passed": False,
        "independent_verification_path": None,
        "formal_ready": False,
        "result_ledger_sha256": ledger_sha256,
        "ledger_sha256": ledger_sha256,
        "result_receipts_sha256": ledger_sha256,
    }
    for field in (
        "manifest_sha256",
        "protocol_sha256",
        "runner_sha256",
        "experiments_sha256",
        "task_manifest_sha256",
        "game_manifest_sha256",
    ):
        expected_values[field] = metadata[field]
    for field, expected in expected_values.items():
        if status.get(field) != expected:
            raise RecoveryError(f"ledger status mismatch for {field}")
    expected_ledger = _foreign_join(
        _normalise_foreign_absolute_path(
            metadata.get("run_root"), label="execution_metadata.run_root"
        ),
        "result_receipts.jsonl",
    )
    if (
        _normalise_foreign_absolute_path(
            status.get("result_ledger"), label="result_ledger_status.result_ledger"
        )
        != expected_ledger
    ):
        raise RecoveryError("ledger status result path is not bound to the run root")
    _require_utc(
        status.get("updated_at_utc"), label="result_ledger_status.updated_at_utc"
    )
    invocation_counts = {
        name: _require_int(summary.get(name), label=f"execution_summary.{name}")
        for name in (
            "attempted_this_invocation",
            "failures_this_invocation",
            "execution_failures_this_invocation",
            "gate_failures_this_invocation",
            "skipped_complete",
            "skipped_failed",
            "skipped_gate_failed",
        )
    }
    if (
        invocation_counts["failures_this_invocation"]
        != invocation_counts["execution_failures_this_invocation"]
    ):
        raise RecoveryError("execution summary failure aliases disagree")
    if invocation_counts["execution_failures_this_invocation"] != 0:
        raise RecoveryError("complete export records an execution failure")
    if (
        invocation_counts["attempted_this_invocation"]
        + invocation_counts["skipped_complete"]
        + invocation_counts["skipped_failed"]
        != EXPECTED_TASKS
    ):
        raise RecoveryError("execution summary does not account for all 85 tasks")
    if invocation_counts["gate_failures_this_invocation"] + invocation_counts[
        "skipped_gate_failed"
    ] != len(gate_failed):
        raise RecoveryError("execution summary does not account for gate failures")
    if summary.get("device") != metadata.get("device"):
        raise RecoveryError("execution summary device disagrees with metadata")


def _fingerprint(paths: Sequence[Path]) -> dict[Path, str]:
    fingerprints: dict[Path, str] = {}
    for path in paths:
        _reject_link_or_reparse(path, expect_directory=False)
        resolved = path.resolve(strict=True)
        if resolved in fingerprints:
            continue
        _reject_link_or_reparse(resolved, expect_directory=False)
        fingerprints[resolved] = _sha256_file(resolved)
    return fingerprints


def _record_expected_hash(
    expected: dict[Path, str], path: Path, digest: str, *, label: str
) -> Path:
    _reject_link_or_reparse(path, expect_directory=False)
    resolved = path.resolve(strict=True)
    _reject_link_or_reparse(resolved, expect_directory=False)
    digest = _require_sha256(digest, label=label)
    observed = _sha256_file(resolved)
    if observed != digest:
        raise RecoveryError(f"input SHA-256 mismatch for {label}")
    previous = expected.get(resolved)
    if previous is not None and previous != digest:
        raise RecoveryError(f"conflicting expected hashes for input {label}")
    expected[resolved] = digest
    return resolved


def _bind_stable_input_role(
    roles: dict[str, Path],
    expected: dict[Path, str],
    *,
    role: str,
    path: Path,
    digest: str,
) -> None:
    if role in roles:
        raise RecoveryError(f"duplicate stable input role: {role}")
    resolved = _record_expected_hash(expected, path, digest, label=role)
    if resolved in roles.values():
        return
    roles[role] = resolved


def _read_source_payload(path: Path, *, relative_path: str) -> FrozenSourceFile:
    normalized = Path(relative_path).as_posix()
    if (
        not normalized
        or normalized.startswith("/")
        or "\\" in relative_path
        or any(part in {"", ".", ".."} for part in normalized.split("/"))
    ):
        raise RecoveryError(f"invalid authenticated source label: {relative_path!r}")
    _reject_link_or_reparse(path, expect_directory=False)
    resolved = path.resolve(strict=True)
    _reject_link_or_reparse(resolved, expect_directory=False)
    try:
        before = os.stat(resolved, follow_symlinks=False)
        payload = resolved.read_bytes()
        after = os.stat(resolved, follow_symlinks=False)
    except OSError as exc:
        raise RecoveryError(
            f"cannot read authenticated source {resolved}: {exc}"
        ) from exc
    identity_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(
        getattr(before, field) != getattr(after, field) for field in identity_fields
    ):
        raise RecoveryError(f"authenticated source changed while read: {resolved}")
    return FrozenSourceFile(
        relative_path=normalized,
        path=resolved,
        payload=payload,
        sha256=hashlib.sha256(payload).hexdigest(),
    )


def _read_formal_source_snapshot() -> tuple[FrozenSourceFile, ...]:
    research_root = RESEARCH_ROOT.resolve(strict=True)
    lifeline_root = research_root / "lifeline_rl"
    _reject_link_or_reparse(lifeline_root, expect_directory=True)
    python_paths: list[Path] = []
    for raw_directory, raw_directories, raw_files in os.walk(
        lifeline_root, topdown=True, followlinks=False
    ):
        directory = Path(raw_directory)
        _reject_link_or_reparse(directory, expect_directory=True)
        raw_directories.sort()
        raw_files.sort()
        for name in raw_directories:
            _reject_link_or_reparse(directory / name, expect_directory=True)
        for name in raw_files:
            if Path(name).suffix == ".py":
                python_paths.append(directory / name)
    if len(python_paths) != EXPECTED_LIFELINE_SOURCE_FILES:
        raise RecoveryError(
            "formal source tree must contain exactly "
            f"{EXPECTED_LIFELINE_SOURCE_FILES} lifeline_rl Python files; "
            f"found {len(python_paths)}"
        )
    paths = [
        *python_paths,
        research_root / "pyproject.toml",
        research_root / "scripts" / "train_alphazero.py",
    ]
    snapshot: list[FrozenSourceFile] = []
    labels: set[str] = set()
    for path in paths:
        _reject_link_or_reparse(path, expect_directory=False)
        resolved = path.resolve(strict=True)
        try:
            label = resolved.relative_to(research_root).as_posix()
        except ValueError as exc:
            raise RecoveryError(
                f"formal source file is outside research root: {resolved}"
            ) from exc
        if label in labels:
            raise RecoveryError(f"duplicate formal source path label: {label}")
        labels.add(label)
        snapshot.append(_read_source_payload(resolved, relative_path=label))
    return tuple(sorted(snapshot, key=lambda item: item.relative_path))


def _formal_source_hash(snapshot: Sequence[FrozenSourceFile]) -> str:
    if not snapshot:
        raise RecoveryError("formal source snapshot is empty")
    digest = hashlib.sha256()
    labels: set[str] = set()
    for source in sorted(snapshot, key=lambda item: item.relative_path):
        if source.relative_path in labels:
            raise RecoveryError(
                f"duplicate formal source label: {source.relative_path}"
            )
        labels.add(source.relative_path)
        encoded_label = source.relative_path.encode("utf-8")
        digest.update(len(encoded_label).to_bytes(8, "big"))
        digest.update(encoded_label)
        digest.update(source.payload)
    return digest.hexdigest()


def _prepare_authenticated_runtime_sources(
    formal_snapshot: Sequence[FrozenSourceFile],
) -> dict[str, AuthenticatedSource]:
    formal_hash = _formal_source_hash(formal_snapshot)
    if formal_hash != EXPECTED_FORMAL_SOURCE_HASH:
        raise RecoveryError(
            f"formal source hash is {formal_hash}, expected {EXPECTED_FORMAL_SOURCE_HASH}"
        )
    runner_source = _read_source_payload(
        RUNNER_PATH, relative_path=RUNTIME_MODULE_FILES[PRIVATE_RUNNER_MODULE]
    )
    experiments_source = _read_source_payload(
        EXPERIMENTS_PATH,
        relative_path=RUNTIME_MODULE_FILES[PRIVATE_EXPERIMENTS_MODULE],
    )
    if runner_source.sha256 != EXPECTED_RUNNER_SHA256:
        raise RecoveryError(
            "frozen runner SHA-256 mismatch; refusing authenticated bootstrap"
        )
    if experiments_source.sha256 != EXPECTED_EXPERIMENTS_SHA256:
        raise RecoveryError(
            "frozen experiments SHA-256 mismatch; refusing authenticated bootstrap"
        )
    formal_by_label = {source.relative_path: source for source in formal_snapshot}
    if len(formal_by_label) != len(formal_snapshot):
        raise RecoveryError("formal source snapshot contains duplicate labels")
    runtime_files: dict[str, FrozenSourceFile] = {
        PRIVATE_RUNNER_MODULE: runner_source,
        PRIVATE_EXPERIMENTS_MODULE: experiments_source,
    }
    for module_name, label in RUNTIME_MODULE_FILES.items():
        if module_name in runtime_files:
            continue
        try:
            runtime_files[module_name] = formal_by_label[label]
        except KeyError as exc:
            raise RecoveryError(
                f"authenticated runtime source is missing: {label}"
            ) from exc
    if set(runtime_files) != set(RUNTIME_MODULE_FILES):
        raise RecoveryError("authenticated runtime module closure is not exact")

    authenticated: dict[str, AuthenticatedSource] = {}
    for module_name in RUNTIME_MODULE_FILES:
        source = runtime_files[module_name]
        try:
            code = compile(
                source.payload,
                str(source.path),
                "exec",
                dont_inherit=True,
            )
        except (SyntaxError, ValueError, TypeError) as exc:
            raise RecoveryError(
                f"cannot compile authenticated runtime source {source.relative_path}: {exc}"
            ) from exc
        authenticated[module_name] = AuthenticatedSource(
            module_name=module_name,
            source=source,
            code=code,
            is_package=source.relative_path.endswith("/__init__.py"),
        )
    return authenticated


def _authenticated_private_import(
    name: str,
    globals: Mapping[str, Any] | None = None,
    locals: Mapping[str, Any] | None = None,
    fromlist: Sequence[str] = (),
    level: int = 0,
) -> Any:
    mapped = name
    if level == 0:
        if name in {"d17_d19_experiments", "scripts.d17_d19_experiments"}:
            mapped = PRIVATE_EXPERIMENTS_MODULE
        elif name == "lifeline_rl" or name.startswith("lifeline_rl."):
            mapped = PRIVATE_LIFELINE_PACKAGE + name[len("lifeline_rl") :]
    return builtins.__import__(mapped, globals, locals, fromlist, level)


def _is_private_runtime_name(name: str) -> bool:
    return any(
        name == root or name.startswith(root + ".")
        for root in (
            PRIVATE_RUNNER_MODULE,
            PRIVATE_EXPERIMENTS_MODULE,
            PRIVATE_LIFELINE_PACKAGE,
        )
    )


class _AuthenticatedRuntimeLoader(importlib.abc.Loader):
    def __init__(self, sources: Mapping[str, AuthenticatedSource]) -> None:
        self.sources = dict(sources)
        self.module_objects: dict[str, types.ModuleType] = {}

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> None:
        del spec
        return None

    def exec_module(self, module: types.ModuleType) -> None:
        try:
            source = self.sources[module.__name__]
        except KeyError as exc:
            raise ModuleNotFoundError(
                f"undeclared authenticated runtime module: {module.__name__}",
                name=module.__name__,
            ) from exc
        self.module_objects[module.__name__] = module
        module.__file__ = str(source.source.path)
        module.__cached__ = None
        if module.__spec__ is None or module.__spec__.loader is not self:
            raise ImportError(f"authenticated module spec drifted: {module.__name__}")
        module.__spec__.cached = None
        local_builtins = dict(vars(builtins))
        local_builtins["__import__"] = _authenticated_private_import
        module.__dict__["__builtins__"] = local_builtins
        builtins.exec(source.code, module.__dict__)


class _AuthenticatedRuntimeFinder(importlib.abc.MetaPathFinder):
    def __init__(self, sources: Mapping[str, AuthenticatedSource]) -> None:
        self.sources = dict(sources)
        self.loader = _AuthenticatedRuntimeLoader(self.sources)

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: types.ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        del path, target
        if not _is_private_runtime_name(fullname):
            return None
        source = self.sources.get(fullname)
        if source is None:
            raise ModuleNotFoundError(
                f"undeclared authenticated private module is forbidden: {fullname}",
                name=fullname,
            )
        spec = importlib.util.spec_from_loader(
            fullname,
            self.loader,
            origin=str(source.source.path),
            is_package=source.is_package,
        )
        if spec is None:
            raise ImportError(f"cannot create authenticated module spec: {fullname}")
        spec.cached = None
        return spec


def _loaded_authenticated_runtime_bindings(
    finder: _AuthenticatedRuntimeFinder,
    module_objects: Mapping[str, types.ModuleType],
    sources: Mapping[str, AuthenticatedSource],
) -> dict[str, str]:
    expected_names = set(sources)
    if set(module_objects) != expected_names:
        raise RecoveryError("loaded authenticated runtime closure is incomplete")
    observed_names = {name for name in sys.modules if _is_private_runtime_name(name)}
    if observed_names != expected_names:
        raise RecoveryError(
            "loaded authenticated runtime closure is not exact: "
            f"missing={sorted(expected_names - observed_names)}, "
            f"extra={sorted(observed_names - expected_names)}"
        )
    if sum(item is finder for item in sys.meta_path) != 1:
        raise RecoveryError("authenticated runtime finder identity changed")
    bindings: dict[str, str] = {}
    for name in sorted(expected_names):
        module = module_objects[name]
        source = sources[name]
        if sys.modules.get(name) is not module:
            raise RecoveryError(f"authenticated runtime module was replaced: {name}")
        if module.__loader__ is not finder.loader:
            raise RecoveryError(
                f"authenticated runtime loader identity changed: {name}"
            )
        spec = module.__spec__
        if spec is None or spec.loader is not finder.loader or spec.cached is not None:
            raise RecoveryError(f"authenticated runtime module spec changed: {name}")
        if getattr(module, "__cached__", object()) is not None:
            raise RecoveryError(
                f"authenticated runtime bytecode cache is forbidden: {name}"
            )
        if Path(str(module.__file__)) != source.source.path:
            raise RecoveryError(f"authenticated runtime source path changed: {name}")
        module_builtins = module.__dict__.get("__builtins__")
        if (
            not isinstance(module_builtins, dict)
            or module_builtins.get("__import__") is not _authenticated_private_import
        ):
            raise RecoveryError(f"authenticated runtime import guard changed: {name}")
        bindings[name] = source.source.sha256
    return bindings


def _load_authenticated_runner(
    sources: Mapping[str, AuthenticatedSource],
) -> tuple[
    types.ModuleType,
    _AuthenticatedRuntimeFinder,
    dict[str, types.ModuleType],
]:
    if set(sources) != set(RUNTIME_MODULE_FILES):
        raise RecoveryError("authenticated runtime source closure is not exact")
    occupied = sorted(name for name in sys.modules if _is_private_runtime_name(name))
    if occupied:
        raise RecoveryError(
            f"authenticated runtime private namespace is already occupied: {occupied}"
        )
    canonical_before = {
        name: module
        for name, module in sys.modules.items()
        if name in {"d17_d19_experiments", "scripts.d17_d19_experiments"}
        or name == "lifeline_rl"
        or name.startswith("lifeline_rl.")
    }
    finder = _AuthenticatedRuntimeFinder(sources)
    sys.meta_path.insert(0, finder)
    original_sys_path = list(sys.path)
    try:
        for name in RUNTIME_MODULE_FILES:
            importlib.import_module(name)
        modules = dict(finder.loader.module_objects)
        _loaded_authenticated_runtime_bindings(finder, modules, sources)
        canonical_after = {
            name: module
            for name, module in sys.modules.items()
            if name in {"d17_d19_experiments", "scripts.d17_d19_experiments"}
            or name == "lifeline_rl"
            or name.startswith("lifeline_rl.")
        }
        if canonical_after != canonical_before:
            raise RecoveryError(
                "authenticated runtime polluted canonical module bindings"
            )
        return modules[PRIVATE_RUNNER_MODULE], finder, modules
    except BaseException as exc:
        for name, module in tuple(finder.loader.module_objects.items()):
            if sys.modules.get(name) is module:
                del sys.modules[name]
        sys.meta_path[:] = [item for item in sys.meta_path if item is not finder]
        if isinstance(exc, RecoveryError):
            raise
        if isinstance(exc, Exception):
            raise RecoveryError(
                f"authenticated runtime bootstrap failed: {exc}"
            ) from exc
        raise
    finally:
        sys.path[:] = original_sys_path


def _assert_authenticated_runtime_unchanged() -> dict[str, str]:
    bindings = _loaded_authenticated_runtime_bindings(
        _AUTHENTICATED_RUNTIME_FINDER,
        _AUTHENTICATED_RUNTIME_MODULES,
        _AUTHENTICATED_RUNTIME_SOURCES,
    )
    for name, expected in _AUTHENTICATED_RUNTIME_SOURCES.items():
        observed = _read_source_payload(
            expected.source.path,
            relative_path=expected.source.relative_path,
        )
        if (
            observed.path != expected.source.path
            or observed.sha256 != expected.source.sha256
            or observed.payload != expected.source.payload
        ):
            raise RecoveryError(f"authenticated runtime source changed: {name}")
    return bindings


def _assert_formal_source_snapshot_unchanged() -> str:
    observed = _read_formal_source_snapshot()
    observed_rows = [
        (source.relative_path, source.path, source.sha256) for source in observed
    ]
    expected_rows = [
        (source.relative_path, source.path, source.sha256)
        for source in _FORMAL_SOURCE_SNAPSHOT
    ]
    if observed_rows != expected_rows:
        raise RecoveryError("formal source snapshot changed during canonical recovery")
    observed_hash = _formal_source_hash(observed)
    if observed_hash != EXPECTED_FORMAL_SOURCE_HASH:
        raise RecoveryError("formal source hash changed during canonical recovery")
    return observed_hash


def _validate_frozen_source_identity(
    checkpoints: Sequence[Mapping[str, Any]],
) -> str:
    _assert_authenticated_runtime_unchanged()
    formal_source_hash = _assert_formal_source_snapshot_unchanged()
    declared = {str(checkpoint.get("source_hash", "")) for checkpoint in checkpoints}
    if declared != {formal_source_hash}:
        raise RecoveryError(
            "frozen checkpoint source hash does not match the authenticated source snapshot"
        )
    return formal_source_hash


_FORMAL_SOURCE_SNAPSHOT = _read_formal_source_snapshot()
if _formal_source_hash(_FORMAL_SOURCE_SNAPSHOT) != EXPECTED_FORMAL_SOURCE_HASH:
    raise RecoveryError("current formal source snapshot does not match the frozen hash")
_AUTHENTICATED_RUNTIME_SOURCES = _prepare_authenticated_runtime_sources(
    _FORMAL_SOURCE_SNAPSHOT
)
(
    runner,
    _AUTHENTICATED_RUNTIME_FINDER,
    _AUTHENTICATED_RUNTIME_MODULES,
) = _load_authenticated_runner(_AUTHENTICATED_RUNTIME_SOURCES)


def _validated_dependency_roles(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    adapter_sha256: str,
) -> tuple[dict[str, Path], dict[Path, str]]:
    roles: dict[str, Path] = {}
    expected: dict[Path, str] = {}

    def bind(role: str, path: Path, digest: str) -> None:
        _bind_stable_input_role(
            roles,
            expected,
            role=role,
            path=path,
            digest=digest,
        )

    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    bind("adapter", SCRIPT_PATH, adapter_sha256)
    for module_name in RUNTIME_MODULE_FILES:
        source = _AUTHENTICATED_RUNTIME_SOURCES[module_name].source
        bind(
            f"authenticated-runtime:{module_name}",
            source.path,
            source.sha256,
        )
    for source in _FORMAL_SOURCE_SNAPSHOT:
        bind(
            f"formal-source:{source.relative_path}",
            source.path,
            source.sha256,
        )

    source_hashes = manifest.get("source_hashes")
    if not isinstance(source_hashes, Mapping) or not source_hashes:
        raise RecoveryError("manifest source_hashes are missing")
    for raw_path, raw_digest in sorted(
        source_hashes.items(), key=lambda item: str(item[0])
    ):
        path = runner.resolve_manifest_path(str(raw_path), manifest_path=manifest_path)
        bind(
            f"manifest-source:{raw_path}",
            path,
            _require_sha256(raw_digest, label=f"source_hashes[{raw_path!r}]"),
        )

    readonly = manifest.get("readonly_bindings")
    if not isinstance(readonly, list):
        raise RecoveryError("manifest readonly_bindings must be an array")
    readonly_map: dict[str, str] = {}
    for index, row in enumerate(readonly):
        if not isinstance(row, Mapping) or set(row) != {"path", "sha256"}:
            raise RecoveryError(f"readonly_bindings[{index}] has invalid schema")
        raw_path = row.get("path")
        if not isinstance(raw_path, str) or not raw_path or raw_path in readonly_map:
            raise RecoveryError("readonly_bindings contains an invalid/duplicate path")
        readonly_map[raw_path] = _require_sha256(
            row.get("sha256"), label=f"readonly_bindings[{index}].sha256"
        )
    if readonly_map != {str(key): str(value) for key, value in source_hashes.items()}:
        raise RecoveryError("readonly_bindings do not exactly match source_hashes")

    d16_v2 = manifest.get("d16_v2")
    opening_binding = (
        d16_v2.get("opening_manifest") if isinstance(d16_v2, Mapping) else None
    )
    if not isinstance(opening_binding, Mapping):
        raise RecoveryError("manifest d16_v2 opening_manifest binding is missing")
    opening_raw_path = opening_binding.get("path")
    if not isinstance(opening_raw_path, str) or not opening_raw_path:
        raise RecoveryError("opening manifest path binding is invalid")
    opening_path = runner.resolve_manifest_path(
        opening_raw_path, manifest_path=manifest_path
    )
    bind(
        "opening-manifest",
        opening_path,
        _require_sha256(
            opening_binding.get("sha256"), label="d16_v2.opening_manifest.sha256"
        ),
    )

    checkpoints = runner._checkpoint_rows(manifest)
    if len(checkpoints) != 15:
        raise RecoveryError("manifest must bind exactly 15 checkpoints")
    for checkpoint in checkpoints:
        checkpoint_id = str(checkpoint.get("checkpoint_id", ""))
        if not checkpoint_id:
            raise RecoveryError("checkpoint id is missing")
        try:
            checkpoint_path, config_path = runner._validate_checkpoint_files(
                checkpoint, manifest_path=manifest_path
            )
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise RecoveryError(
                f"checkpoint dependency validation failed for {checkpoint_id}: {exc}"
            ) from exc
        receipt_path = runner.resolve_manifest_path(
            str(checkpoint["source_receipt_path"]), manifest_path=manifest_path
        )
        bind(
            f"checkpoint:{checkpoint_id}:weights",
            checkpoint_path,
            str(checkpoint["sha256"]),
        )
        bind(
            f"checkpoint:{checkpoint_id}:config",
            config_path,
            str(checkpoint["config_file_sha256"]),
        )
        bind(
            f"checkpoint:{checkpoint_id}:source-receipt",
            receipt_path,
            str(checkpoint["source_receipt_sha256"]),
        )
    if len(roles) != len(expected) or set(roles.values()) != set(expected):
        raise RecoveryError("stable input roles and files are not one-to-one")
    return roles, expected


def _fingerprint_digest(
    roles: Mapping[str, Path], fingerprints: Mapping[Path, str]
) -> str:
    rows = []
    resolved_paths: set[Path] = set()
    for role, path in sorted(roles.items()):
        resolved = path.resolve(strict=True)
        if resolved in resolved_paths:
            raise RecoveryError(
                f"multiple stable input roles resolve to one file: {resolved}"
            )
        resolved_paths.add(resolved)
        try:
            digest = fingerprints[resolved]
        except KeyError as exc:
            raise RecoveryError(
                f"input role is missing from fingerprints: {role}"
            ) from exc
        rows.append({"role": role, "sha256": digest})
    if resolved_paths != set(fingerprints):
        raise RecoveryError(
            "stable input roles and fingerprinted files are not one-to-one"
        )
    return _canonical_sha256(rows)


def _validate_all_inputs(
    *,
    manifest_path: str | Path,
    bundle_directory: str | Path,
    export_directory: str | Path,
) -> RecoveryContext:
    raw_manifest = Path(os.path.abspath(manifest_path))
    raw_bundle = Path(os.path.abspath(bundle_directory))
    _reject_link_or_reparse(raw_manifest, expect_directory=False)
    _reject_link_or_reparse(raw_bundle, expect_directory=True)
    manifest_file = raw_manifest.resolve(strict=True)
    bundle = raw_bundle.resolve(strict=True)
    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    adapter_sha256 = _sha256_file(SCRIPT_PATH)
    (
        manifest,
        tasks_list,
        games_list,
        bundle_inputs,
        bundle_fingerprints,
    ) = _validate_strict_bundle_inputs(manifest_file, bundle)
    dependency_roles, dependency_expected = _validated_dependency_roles(
        manifest,
        manifest_path=manifest_file,
        adapter_sha256=adapter_sha256,
    )
    task_directories = [
        runner._task_directory(Path("immutable-export"), str(task["task_id"])).name
        for task in tasks_list
    ]
    if (
        len(task_directories) != EXPECTED_TASKS
        or len(set(task_directories)) != EXPECTED_TASKS
    ):
        raise RecoveryError(
            "frozen task ids do not map to 85 unique export directories"
        )
    inventory = _validate_export_manifest(
        export_directory, task_directories=task_directories
    )
    input_roles = dict(dependency_roles)
    expected_fingerprints = dict(dependency_expected)

    def add_input(role: str, path: Path, digest: str) -> None:
        resolved = path.resolve(strict=True)
        digest = _require_sha256(digest, label=role)
        previous = expected_fingerprints.get(resolved)
        if previous is not None and previous != digest:
            raise RecoveryError(f"conflicting input fingerprint for role {role}")
        if role in input_roles:
            if input_roles[role] != resolved:
                raise RecoveryError(f"conflicting stable input role: {role}")
            return
        if previous is not None:
            return
        input_roles[role] = resolved
        expected_fingerprints[resolved] = digest

    for index, path in enumerate(bundle_inputs):
        role = "manifest" if index == 0 else f"bundle:{path.name}"
        add_input(role, path, bundle_fingerprints[path.resolve(strict=True)])
    for relative, path in sorted(inventory.paths.items()):
        add_input(f"export:{relative}", path, inventory.hashes[relative])
    export_manifest_path = inventory.root / EXPORT_MANIFEST_NAME
    add_input(
        "export:export_manifest.json",
        export_manifest_path,
        inventory.manifest_sha256,
    )
    if len(input_roles) != len(expected_fingerprints):
        raise RecoveryError("stable input roles and expected files are not one-to-one")
    initial_fingerprints = _fingerprint(tuple(input_roles.values()))
    if initial_fingerprints != expected_fingerprints:
        raise RecoveryError(
            "first complete input fingerprint disagrees with authenticated hashes"
        )
    initial_fingerprint_sha256 = _fingerprint_digest(input_roles, initial_fingerprints)

    # Only begin semantic export/replay validation after the complete immutable
    # input set has been authenticated in one stable snapshot.
    metadata_path = inventory.paths["execution_metadata.json"]
    summary_path = inventory.paths["execution_summary.json"]
    status_path = inventory.paths["result_ledger_status.json"]
    ledger_path = inventory.paths["result_receipts.jsonl"]
    metadata = _load_json(metadata_path)
    _validate_export_run_root_binding(inventory, metadata)
    semantic_bindings = _validate_execution_metadata(
        metadata,
        manifest=manifest,
        manifest_path=manifest_file,
        bundle_directory=bundle,
    )
    schedules_by_task = runner._group_game_manifest(games_list)
    if set(schedules_by_task) != {str(task["task_id"]) for task in tasks_list}:
        raise RecoveryError("game manifest task coverage is incomplete")
    original_receipts: list[dict[str, Any]] = []
    mapped_receipts: dict[Path, dict[str, Any]] = {}
    total_game_rows = 0
    for task, task_directory in zip(tasks_list, task_directories, strict=True):
        task_id = str(task["task_id"])
        receipt_relative = f"tasks/{task_directory}/receipt.json"
        summary_relative = f"tasks/{task_directory}/summary.json"
        games_relative = f"tasks/{task_directory}/games.jsonl"
        receipt_path = inventory.paths[receipt_relative]
        task_summary_path = inventory.paths[summary_relative]
        task_games_path = inventory.paths[games_relative]
        receipt = _load_json(receipt_path)
        task_summary = _load_json(task_summary_path)
        records = _load_jsonl(task_games_path)
        total_game_rows += len(records)
        schedules = schedules_by_task[task_id]
        if len(records) != len(schedules):
            raise RecoveryError(f"{task_id}: exported games row count mismatch")
        expected_remote_games = _remote_task_artifact(
            metadata, task_directory, "games.jsonl"
        )
        expected_remote_summary = _remote_task_artifact(
            metadata, task_directory, "summary.json"
        )
        for field in ("games_path", "arena_games_path"):
            if (
                _normalise_foreign_absolute_path(
                    receipt.get(field), label=f"{task_id}.{field}"
                )
                != expected_remote_games
            ):
                raise RecoveryError(f"{task_id}: receipt {field} path mismatch")
        if (
            _normalise_foreign_absolute_path(
                receipt.get("arena_summary_path"),
                label=f"{task_id}.arena_summary_path",
            )
            != expected_remote_summary
        ):
            raise RecoveryError(f"{task_id}: receipt summary path mismatch")
        games_sha256 = _sha256_file(task_games_path)
        task_summary_sha256 = _sha256_file(task_summary_path)
        if (
            receipt.get("games_sha256") != games_sha256
            or receipt.get("arena_games_sha256") != games_sha256
            or receipt.get("arena_summary_sha256") != task_summary_sha256
        ):
            raise RecoveryError(f"{task_id}: receipt artifact hash mismatch")
        receipt_projection = dict(receipt)
        for field in (
            "arena_games_path",
            "arena_games_sha256",
            "arena_summary_path",
            "arena_summary_sha256",
            "completed_at_utc",
        ):
            receipt_projection.pop(field, None)
        if receipt_projection != task_summary:
            raise RecoveryError(
                f"{task_id}: summary is not the exact receipt projection"
            )
        _require_utc(
            receipt.get("completed_at_utc"), label=f"{task_id}.completed_at_utc"
        )
        mapped = _mapped_receipt(
            receipt, games_path=task_games_path, summary_path=task_summary_path
        )
        try:
            runner.validate_task_receipt(task, schedules, mapped, metadata=metadata)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise RecoveryError(
                f"{task_id}: frozen receipt validation failed: {exc}"
            ) from exc
        original_receipts.append(receipt)
        mapped_receipts[receipt_path.resolve(strict=True)] = mapped
    if total_game_rows != EXPECTED_GAME_ROWS:
        raise RecoveryError(
            f"exported game rows total {total_game_rows}, expected {EXPECTED_GAME_ROWS}"
        )
    ledger_rows = _load_jsonl(ledger_path)
    if len(ledger_rows) != EXPECTED_TASKS or ledger_rows != original_receipts:
        raise RecoveryError(
            "result receipt ledger is not the exact 85-receipt task order"
        )
    expected_ledger_text = runner._jsonl_text(original_receipts)
    try:
        observed_ledger_text = ledger_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RecoveryError(f"cannot reread result ledger: {exc}") from exc
    if observed_ledger_text != expected_ledger_text:
        raise RecoveryError(
            "result receipt ledger bytes are not canonical runner JSONL"
        )
    ledger_sha256 = _sha256_file(ledger_path)
    ledger_status = _load_json(status_path)
    execution_summary = _load_json(summary_path)
    _validate_ledger_status_and_summary(
        ledger_status,
        execution_summary,
        metadata=metadata,
        ledger_sha256=ledger_sha256,
        receipts=original_receipts,
    )
    gate_failed = sum(
        receipt.get("gate_status") == "failed" for receipt in original_receipts
    )
    post_validation_fingerprints = _fingerprint(tuple(input_roles.values()))
    if post_validation_fingerprints != initial_fingerprints:
        raise RecoveryError("an input changed during semantic recovery validation")
    post_validation_digest = _fingerprint_digest(
        input_roles, post_validation_fingerprints
    )
    if post_validation_digest != initial_fingerprint_sha256:
        raise RecoveryError("stable input-role digest changed during validation")
    bindings = {
        "adapter_sha256": adapter_sha256,
        "runner_sha256": semantic_bindings["runner_sha256"],
        "experiments_sha256": semantic_bindings["experiments_sha256"],
        "export_manifest_sha256": inventory.manifest_sha256,
        "export_payload_tree_sha256": inventory.payload_tree_sha256,
        "manifest_file_sha256": initial_fingerprints[manifest_file],
        "manifest_canonical_sha256": semantic_bindings["manifest_canonical_sha256"],
        "protocol_sha256": semantic_bindings["protocol_sha256"],
        "task_manifest_sha256": semantic_bindings["task_manifest_sha256"],
        "game_manifest_sha256": semantic_bindings["game_manifest_sha256"],
        "result_ledger_sha256": ledger_sha256,
        "execution_metadata_sha256": inventory.hashes["execution_metadata.json"],
        "result_ledger_status_sha256": inventory.hashes["result_ledger_status.json"],
        "execution_summary_sha256": inventory.hashes["execution_summary.json"],
        "formal_source_hash": semantic_bindings["formal_source_hash"],
    }
    counts = {
        "export_manifest_entries": len(inventory.paths),
        "export_payload_files": len(inventory.paths),
        "task_receipts": len(original_receipts),
        "task_summaries": EXPECTED_TASK_ARTIFACTS,
        "task_game_files": EXPECTED_TASK_ARTIFACTS,
        "game_rows": total_game_rows,
        "complete_tasks": int(ledger_status["complete_tasks"]),
        "gate_failed_tasks": gate_failed,
        "comparison_rows": EXPECTED_COMPARISON_ROWS,
    }
    counts["fingerprinted_input_files"] = len(initial_fingerprints)
    counts["stable_input_roles"] = len(input_roles)
    return RecoveryContext(
        manifest_path=manifest_file,
        bundle_directory=bundle,
        manifest=manifest,
        tasks=tuple(tasks_list),
        games=tuple(games_list),
        metadata=metadata,
        ledger_status=ledger_status,
        execution_summary=execution_summary,
        mapped_receipts=mapped_receipts,
        export=inventory,
        bindings=bindings,
        counts=counts,
        input_roles=input_roles,
        input_fingerprints=initial_fingerprints,
        input_fingerprint_sha256=initial_fingerprint_sha256,
    )


def _assert_inputs_unchanged(context: RecoveryContext) -> str:
    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    observed_root, observed_export = _scan_regular_tree(context.export.root)
    expected_export = dict(context.export.paths)
    expected_export[EXPORT_MANIFEST_NAME] = (
        context.export.root / EXPORT_MANIFEST_NAME
    ).resolve(strict=True)
    if len(expected_export) != EXPECTED_EXPORT_ENTRIES + 1:
        raise RecoveryError("internal export inventory does not contain 260 files")
    if observed_root != context.export.root.resolve(strict=True):
        raise RecoveryError("export root identity changed during canonical recovery")
    if set(observed_export) != set(expected_export):
        missing = sorted(set(expected_export) - set(observed_export))[:10]
        extra = sorted(set(observed_export) - set(expected_export))[:10]
        raise RecoveryError(
            "lightweight export file set changed during canonical recovery: "
            f"missing={missing}, extra={extra}"
        )
    for relative, expected_path in expected_export.items():
        if observed_export[relative] != expected_path.resolve(strict=True):
            raise RecoveryError(
                f"export path identity changed during canonical recovery: {relative}"
            )

    observed = _fingerprint(tuple(context.input_roles.values()))
    if observed != context.input_fingerprints:
        raise RecoveryError("an input changed during canonical recovery")
    digest = _fingerprint_digest(context.input_roles, observed)
    if digest != context.input_fingerprint_sha256:
        raise RecoveryError(
            "stable input-role digest changed during canonical recovery"
        )
    return digest


@contextlib.contextmanager
def _frozen_runner_export_view(context: RecoveryContext) -> Iterator[None]:
    """Temporarily expose authenticated export copies to the frozen runner."""

    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    original_read_json = runner._read_json
    original_execution_metadata = runner._execution_metadata
    original_finalize_ledger = runner._finalize_ledger
    export_root = context.export.root.resolve(strict=True)

    def read_json(path: Path) -> dict[str, Any]:
        candidate = Path(path).resolve(strict=True)
        mapped = context.mapped_receipts.get(candidate)
        if mapped is not None:
            return copy.deepcopy(mapped)
        return original_read_json(path)

    def execution_metadata(
        manifest: Mapping[str, Any],
        *,
        manifest_path: Path,
        bundle_directory: Path,
        run_root: Path,
        device: str,
    ) -> dict[str, Any]:
        del manifest_path, bundle_directory, device
        if manifest is not context.manifest and dict(manifest) != context.manifest:
            raise RecoveryError("canonical runner received a different manifest")
        if Path(run_root).resolve(strict=True) != export_root:
            raise RecoveryError("canonical runner received a different export root")
        return copy.deepcopy(context.metadata)

    def finalize_ledger(
        tasks: Sequence[Mapping[str, Any]],
        grouped_games: Mapping[str, Sequence[Mapping[str, Any]]],
        *,
        run_root: Path,
        metadata: Mapping[str, Any],
    ) -> dict[str, Any]:
        if [str(task["task_id"]) for task in tasks] != [
            str(task["task_id"]) for task in context.tasks
        ]:
            raise RecoveryError("canonical runner task order drifted")
        if sum(len(rows) for rows in grouped_games.values()) != EXPECTED_GAME_ROWS:
            raise RecoveryError("canonical runner game schedule coverage drifted")
        if Path(run_root).resolve(strict=True) != export_root:
            raise RecoveryError("canonical runner ledger root drifted")
        if dict(metadata) != context.metadata:
            raise RecoveryError("canonical runner metadata drifted")
        # The original function always writes result_ledger_status.json.  The
        # export status was comprehensively validated above, so returning a
        # copy is the only permitted behavior in this read-only adapter.
        return copy.deepcopy(context.ledger_status)

    runner._read_json = read_json
    runner._execution_metadata = execution_metadata
    runner._finalize_ledger = finalize_ledger
    try:
        yield
    finally:
        runner._read_json = original_read_json
        runner._execution_metadata = original_execution_metadata
        runner._finalize_ledger = original_finalize_ledger
        _assert_authenticated_runtime_unchanged()
        _assert_formal_source_snapshot_unchanged()


def _run_frozen_canonical(context: RecoveryContext, output: Path) -> dict[str, Any]:
    _assert_authenticated_runtime_unchanged()
    _assert_formal_source_snapshot_unchanged()
    with _frozen_runner_export_view(context):
        try:
            result = runner.canonical_aggregate(
                context.manifest,
                context.tasks,
                context.games,
                manifest_path=context.manifest_path,
                bundle_directory=context.bundle_directory,
                run_root=context.export.root,
                output=output,
            )
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise RecoveryError(f"frozen canonical aggregation failed: {exc}") from exc
        _assert_authenticated_runtime_unchanged()
        _assert_formal_source_snapshot_unchanged()
    numeric = _load_json(output)
    expected_numeric = {
        "schema_name": runner.NUMERIC_SCHEMA_NAME,
        "schema_version": runner.SCHEMA_VERSION,
        "bundle_id": runner.BUNDLE_EXPERIMENT_ID,
        "manifest_sha256": context.metadata["manifest_sha256"],
        "protocol_sha256": context.metadata["protocol_sha256"],
        "runner_sha256": EXPECTED_RUNNER_SHA256,
        "experiments_sha256": context.metadata["experiments_sha256"],
        "task_manifest_sha256": context.metadata["task_manifest_sha256"],
        "game_manifest_sha256": context.metadata["game_manifest_sha256"],
    }
    for field, expected in expected_numeric.items():
        if numeric.get(field) != expected:
            raise RecoveryError(f"canonical numeric output mismatch for {field}")
    comparison_rows = numeric.get("comparison_rows")
    if (
        not isinstance(comparison_rows, list)
        or len(comparison_rows) != EXPECTED_COMPARISON_ROWS
    ):
        raise RecoveryError("canonical numeric output must contain 17 comparison rows")
    if result.get("formal_ready") is not False:
        raise RecoveryError(
            "frozen canonical result unexpectedly claims formal readiness"
        )
    if result.get("canonical_numeric_sha256") != _sha256_file(output):
        raise RecoveryError("frozen canonical result output hash mismatch")
    return result


def _write_json_new(path: Path, payload: Mapping[str, Any]) -> None:
    if os.path.lexists(path):
        raise RecoveryError(f"refusing to overwrite output artifact: {path}")
    text = (
        json.dumps(
            payload,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    )
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.lexists(path):
            raise RecoveryError(f"refusing to overwrite output artifact: {path}")
        _rename_path_no_replace(temporary, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise


def _directory_identity(path: Path) -> tuple[int, int]:
    try:
        result = os.lstat(path)
    except OSError as exc:
        raise RecoveryError(f"cannot identify output directory {path}: {exc}") from exc
    if (
        stat.S_ISLNK(result.st_mode)
        or _has_reparse_attribute(result)
        or not stat.S_ISDIR(result.st_mode)
    ):
        raise RecoveryError(
            f"published output is not the original regular directory: {path}"
        )
    return int(result.st_dev), int(result.st_ino)


def _prepare_new_output_target(output_directory: str | Path) -> NewOutputTarget:
    raw_output = Path(os.path.abspath(output_directory))
    if os.path.lexists(raw_output):
        raise RecoveryError(f"refusing to reuse existing output path: {raw_output}")
    raw_parent = raw_output.parent
    if not os.path.lexists(raw_parent):
        raise RecoveryError(f"output parent must already exist: {raw_parent}")
    _reject_link_or_reparse(raw_parent, expect_directory=True)
    parent = raw_parent.resolve(strict=True)
    _reject_link_or_reparse(parent, expect_directory=True)
    output = parent / raw_output.name
    if os.path.lexists(output):
        raise RecoveryError(f"refusing to reuse existing output path: {output}")
    return NewOutputTarget(
        path=output,
        parent=parent,
        parent_identity=_directory_identity(parent),
    )


def _rename_path_no_replace(source: Path, destination: Path) -> None:
    """Atomically move a file or directory only when destination is absent."""

    if os.name == "nt":
        try:
            os.rename(source, destination)
        except FileExistsError as exc:
            raise RecoveryError(
                f"refusing to replace raced destination path: {destination}"
            ) from exc
        return

    if sys.platform.startswith("linux"):
        try:
            library = ctypes.CDLL(None, use_errno=True)
        except OSError as exc:
            raise RecoveryError(
                "atomic no-replace directory publication is unavailable"
            ) from exc
        renameat2 = getattr(library, "renameat2", None)
        if renameat2 is None:
            raise RecoveryError(
                "atomic no-replace directory publication is unavailable"
            )
        renameat2.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        renameat2.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = renameat2(
            AT_FDCWD,
            os.fsencode(source),
            AT_FDCWD,
            os.fsencode(destination),
            RENAME_NOREPLACE,
        )
        if result == 0:
            return
        error_number = ctypes.get_errno()
        if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
            raise RecoveryError(
                f"refusing to replace raced destination path: {destination}"
            )
        raise OSError(
            error_number,
            os.strerror(error_number),
            str(destination),
        )

    raise RecoveryError(
        f"atomic no-replace directory publication is unsupported on {sys.platform}"
    )


def _publish_new_directory(
    output_directory: str | Path,
    builder: Callable[[Path], dict[str, Any]],
    *,
    expected_target: NewOutputTarget | None = None,
    pre_publish: Callable[[Path], None] | None = None,
    post_publish: Callable[[Path], None] | None = None,
) -> dict[str, Any]:
    """Verify under a hidden candidate name, then atomically commit once.

    Failures before the final commit deliberately leave the private staging or
    verified-candidate directory for inspection.  Recursive path-based cleanup
    is forbidden because it cannot be bound atomically to a directory identity
    on every supported host.  A detected post-commit interference can leave the
    requested output path in place; after any exception that path is quarantine
    only.  Path existence never substitutes for a normal return plus downstream
    hash verification.
    """

    target = _prepare_new_output_target(output_directory)
    if expected_target is not None and target != expected_target:
        raise RecoveryError("canonical output target or parent identity changed")
    output = target.path
    if _directory_identity(target.parent) != target.parent_identity:
        raise RecoveryError("output parent identity changed before staging")
    candidate = target.parent / f".{output.name}.verified-{uuid.uuid4().hex}"
    if os.path.lexists(candidate):
        raise RecoveryError(f"private verification path already exists: {candidate}")
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=target.parent))
    stage_identity = _directory_identity(stage)
    if stage.parent.resolve(strict=True) != target.parent:
        raise RecoveryError("staging directory escaped the canonical output parent")
    if _directory_identity(stage) != stage_identity:
        raise RecoveryError("staging directory identity changed before build")
    result = builder(stage)
    if _directory_identity(stage) != stage_identity:
        raise RecoveryError("staging directory identity changed during build")
    if pre_publish is not None:
        pre_publish(stage)
    if _directory_identity(stage) != stage_identity:
        raise RecoveryError(
            "staging directory identity changed before verification rename"
        )
    if _directory_identity(target.parent) != target.parent_identity:
        raise RecoveryError("output parent identity changed before verification rename")
    _rename_path_no_replace(stage, candidate)
    if _directory_identity(candidate) != stage_identity:
        raise RecoveryError("verified candidate identity changed after atomic rename")
    if post_publish is not None:
        post_publish(candidate)
    if _directory_identity(target.parent) != target.parent_identity:
        raise RecoveryError("output parent identity changed during candidate checks")
    if _directory_identity(candidate) != stage_identity:
        raise RecoveryError("verified candidate identity changed after validation")
    if os.path.lexists(output):
        raise RecoveryError(f"refusing to reuse existing output path: {output}")
    if _directory_identity(target.parent) != target.parent_identity:
        raise RecoveryError("output parent identity changed before final commit")

    def validate_committed_output(*, require_payload_validator: bool) -> None:
        if os.path.lexists(candidate):
            raise RecoveryError("verified candidate still exists after final commit")
        if not os.path.lexists(output):
            raise RecoveryError("final output is absent after final commit")
        if _directory_identity(target.parent) != target.parent_identity:
            raise RecoveryError("output parent identity changed during final commit")
        if _directory_identity(output) != stage_identity:
            raise RecoveryError("final output directory identity is not the candidate")
        if require_payload_validator and post_publish is None:
            raise RecoveryError("final commit cannot be reconciled without a validator")
        if post_publish is not None:
            post_publish(output)
        if _directory_identity(target.parent) != target.parent_identity:
            raise RecoveryError("output parent identity changed after final validation")
        if _directory_identity(output) != stage_identity:
            raise RecoveryError("final output identity changed after validation")

    try:
        _rename_path_no_replace(candidate, output)
    except BaseException as commit_error:
        try:
            validate_committed_output(require_payload_validator=True)
        except BaseException as reconciliation_error:
            raise commit_error from reconciliation_error
        return result
    validate_committed_output(require_payload_validator=False)
    return result


def _paths_overlap(first: Path, second: Path) -> bool:
    try:
        first.relative_to(second)
        return True
    except ValueError:
        pass
    try:
        second.relative_to(first)
        return True
    except ValueError:
        return False


def recover_canonical(
    *,
    manifest_path: str | Path,
    bundle_directory: str | Path,
    export_directory: str | Path,
    output_directory: str | Path,
) -> dict[str, Any]:
    """Validate immutable inputs and publish exactly two new output files.

    Callers must treat every path left by an exceptional return as quarantine,
    including the requested output path.  Only a normal return and subsequent
    independent hash verification establish a consumable artifact.
    """

    output_target = _prepare_new_output_target(output_directory)
    output = output_target.path
    raw_export = Path(os.path.abspath(export_directory))
    raw_bundle = Path(os.path.abspath(bundle_directory))
    _reject_link_or_reparse(raw_export, expect_directory=True)
    _reject_link_or_reparse(raw_bundle, expect_directory=True)
    export_root = raw_export.resolve(strict=True)
    bundle_root = raw_bundle.resolve(strict=True)
    if _paths_overlap(output, export_root) or _paths_overlap(output, bundle_root):
        raise RecoveryError("output directory must be disjoint from every input tree")
    context = _validate_all_inputs(
        manifest_path=manifest_path,
        bundle_directory=bundle_directory,
        export_directory=export_directory,
    )
    expected_output_payloads: dict[str, dict[str, Any]] = {}
    built_output_hashes: dict[str, str] = {}
    expected_output_hashes: dict[str, str] = {}

    def build(stage: Path) -> dict[str, Any]:
        canonical_path = stage / CANONICAL_NAME
        canonical_result = _run_frozen_canonical(context, canonical_path)
        after_aggregate_fingerprint = _assert_inputs_unchanged(context)
        canonical_sha256 = _sha256_file(canonical_path)
        receipt = {
            "schema_name": "lifeline-d17-d19-canonical-derivation-receipt",
            "schema_version": 1,
            "bundle_id": runner.BUNDLE_EXPERIMENT_ID,
            "status": "canonical_numeric_recovered_awaiting_independent_verification",
            "formal_ready": False,
            "formal_source_hash": context.bindings["formal_source_hash"],
            "independent_numeric_consumed": False,
            "read_only_inputs": True,
            "frozen_runner_canonical_aggregate_reused": True,
            "input_fingerprint_before_aggregate_sha256": (
                context.input_fingerprint_sha256
            ),
            "input_fingerprint_after_aggregate_sha256": (after_aggregate_fingerprint),
            "created_at_utc": _utc_now(),
            "outputs": {
                "canonical_numeric": CANONICAL_NAME,
                "canonical_numeric_sha256": canonical_sha256,
            },
            "bindings": dict(sorted(context.bindings.items())),
            "counts": dict(sorted(context.counts.items())),
            "claims": {
                "execution_complete": True,
                "formal_task_gates_all_passed": context.counts["gate_failed_tasks"]
                == 0,
                "independent_verification_passed": False,
                "publication_ready": False,
            },
        }
        receipt_path = stage / DERIVATION_RECEIPT_NAME
        _write_json_new(receipt_path, receipt)
        expected_output_payloads[CANONICAL_NAME] = _load_json(canonical_path)
        expected_output_payloads[DERIVATION_RECEIPT_NAME] = copy.deepcopy(receipt)
        built_output_hashes[CANONICAL_NAME] = canonical_sha256
        built_output_hashes[DERIVATION_RECEIPT_NAME] = _sha256_file(receipt_path)
        if set(path.name for path in stage.iterdir()) != {
            CANONICAL_NAME,
            DERIVATION_RECEIPT_NAME,
        }:
            raise RecoveryError("staging directory contains an unexpected output")
        return {
            "status": receipt["status"],
            "formal_ready": False,
            "output_directory": str(output),
            "canonical_numeric_sha256": canonical_sha256,
            "canonical_comparison_rows": canonical_result["comparison_rows"],
            "derivation_receipt": DERIVATION_RECEIPT_NAME,
        }

    def validate_output_pair(directory: Path, *, label: str) -> dict[str, str]:
        _, files = _scan_regular_tree(directory)
        expected_names = {CANONICAL_NAME, DERIVATION_RECEIPT_NAME}
        if set(files) != expected_names:
            raise RecoveryError(
                f"{label} directory does not contain the exact output pair"
            )
        if set(expected_output_payloads) != expected_names:
            raise RecoveryError("expected output schemas were not recorded")
        hashes: dict[str, str] = {}
        for name in sorted(expected_names):
            payload = _load_json(files[name])
            if payload != expected_output_payloads[name]:
                raise RecoveryError(f"{label} output schema/content mismatch: {name}")
            hashes[name] = _sha256_file(files[name])
        declared_canonical = (
            expected_output_payloads[DERIVATION_RECEIPT_NAME]
            .get("outputs", {})
            .get("canonical_numeric_sha256")
        )
        if declared_canonical != hashes[CANONICAL_NAME]:
            raise RecoveryError(
                f"{label} output hashes changed: canonical hash disagrees with its receipt"
            )
        return hashes

    def final_pre_publish_check(stage: Path) -> None:
        observed = validate_output_pair(stage, label="staging")
        if observed != built_output_hashes:
            raise RecoveryError("staging output hashes changed before publication")
        expected_output_hashes.clear()
        expected_output_hashes.update(observed)
        _assert_inputs_unchanged(context)

    def final_post_publish_check(published: Path) -> None:
        observed = validate_output_pair(published, label="published")
        if observed != expected_output_hashes:
            raise RecoveryError("published output hashes changed after atomic rename")
        _assert_inputs_unchanged(context)

    return _publish_new_directory(
        output,
        build,
        expected_target=output_target,
        pre_publish=final_pre_publish_check,
        post_publish=final_post_publish_check,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Recover the frozen D17/D18-v1 canonical numeric artifact from a "
            "complete authenticated lightweight export. Independent numeric "
            "artifacts are intentionally not accepted."
        )
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--export-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = recover_canonical(
            manifest_path=args.manifest,
            bundle_directory=args.bundle_dir,
            export_directory=args.export_dir,
            output_directory=args.output_dir,
        )
    except (RecoveryError, OSError) as exc:
        print(f"FAIL_CLOSED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
