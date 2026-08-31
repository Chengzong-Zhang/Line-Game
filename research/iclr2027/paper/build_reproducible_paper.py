#!/usr/bin/env python3
"""Build the ICLR paper from its nine release inputs and emit a receipt."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import ntpath
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, BinaryIO, Sequence


SOURCE_DATE_EPOCH = 1788115675
FIXED_ENVIRONMENT = {
    "SOURCE_DATE_EPOCH": str(SOURCE_DATE_EPOCH),
    "FORCE_SOURCE_DATE": "1",
    "TZ": "UTC",
}
SCRUBBED_TEX_ENVIRONMENT_VARIABLES = (
    "BIBINPUTS",
    "BSTINPUTS",
    "ENCFONTS",
    "LUAINPUTS",
    "MFINPUTS",
    "OPENTYPEFONTS",
    "T1FONTS",
    "TEXINPUTS",
    "TEXMFCNF",
    "TEXMFCONFIG",
    "TEXMFDBS",
    "TEXMFHOME",
    "TEXMFOUTPUT",
    "TEXMFVAR",
    "TFMFONTS",
    "TTFONTS",
    "VFFONTS",
)
CONTROLLED_GIT_ENVIRONMENT = {
    "GIT_CONFIG_COUNT": "0",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_NO_REPLACE_OBJECTS": "1",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_PAGER": "cat",
    "GIT_TERMINAL_PROMPT": "0",
}
SOURCE_INPUTS = (
    "fancyhdr.sty",
    "figures/fig1_lifeline_logical_edges.pdf",
    "figures/fig2_checkpoint_curves.pdf",
    "figures/fig3_model_size_opponent_heatmap.pdf",
    "iclr2027_conference.bst",
    "iclr2027_conference.sty",
    "main.tex",
    "natbib.sty",
    "references.bib",
)
CANONICAL_PAPER_PREFIX = "research/iclr2027/paper/"
CANONICAL_PAPER_PATH = CANONICAL_PAPER_PREFIX.rstrip("/")
CANONICAL_BUILD_TOOL_PATH = "research/iclr2027/paper/build_reproducible_paper.py"
CANONICAL_INPUT_PATHS = tuple(
    f"{CANONICAL_PAPER_PREFIX}{relative}" for relative in SOURCE_INPUTS
)
STABILITY_FILES = (
    "main.aux",
    "main.bbl",
    "main.lof",
    "main.lot",
    "main.out",
    "main.pdf",
    "main.toc",
)
ALLOWED_RUNTIME_WORK_INPUTS = frozenset(
    (
        *SOURCE_INPUTS,
        "main.aux",
        "main.bbl",
        "main.lof",
        "main.lot",
        "main.out",
        "main.toc",
    )
)
MIKTEX_RUNTIME_ROOT_ROLES = (
    "miktex_install",
    "miktex_user_data",
)
HEX_OBJECT_ID = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")
HEX_SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")


class BuildError(RuntimeError):
    """A fail-closed paper build error."""


@dataclass(frozen=True)
class _RuntimeRoot:
    root_role: str
    path: Path


@dataclass(frozen=True)
class _RuntimeFile:
    absolute_path: Path
    root_role: str
    relative_path: str
    size_bytes: int
    sha256: str

    def public_record(self) -> dict[str, Any]:
        return {
            "relative_path": self.relative_path,
            "root_role": self.root_role,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
        }


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_blob_oid(data: bytes, object_id_length: int) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    if object_id_length == 40:
        return hashlib.sha1(header + data, usedforsecurity=False).hexdigest()
    if object_id_length == 64:
        return hashlib.sha256(header + data).hexdigest()
    raise BuildError("unsupported Git object id length")


def _canonical_json_bytes(value: Any) -> bytes:
    text = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return (text + "\n").encode("utf-8")


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _native_path_flavor() -> str:
    return "windows" if os.name == "nt" else "posix"


def _pure_path(value: str, flavor: str) -> PureWindowsPath | PurePosixPath:
    if flavor == "windows":
        return PureWindowsPath(value)
    if flavor == "posix":
        return PurePosixPath(value)
    raise BuildError("unsupported path flavor")


def _path_module(flavor: str) -> Any:
    if flavor == "windows":
        return ntpath
    if flavor == "posix":
        return posixpath
    raise BuildError("unsupported path flavor")


def _absolute_path_flavor(value: str) -> str | None:
    if PureWindowsPath(value).is_absolute():
        return "windows"
    if PurePosixPath(value).is_absolute():
        return "posix"
    return None


def _path_comparison_key(value: str, flavor: str) -> str:
    normalized = _path_module(flavor).normpath(value)
    return normalized.casefold() if flavor == "windows" else normalized


def _normalize_absolute_lexical(
    value: str, *, expected_flavor: str | None = None
) -> tuple[str, str]:
    if not value or "\x00" in value or "\r" in value or "\n" in value:
        raise BuildError("runtime recorder contains an invalid path")
    flavor = _absolute_path_flavor(value)
    if flavor is None:
        raise BuildError("runtime recorder path is not absolute")
    if expected_flavor is not None and flavor != expected_flavor:
        raise BuildError("runtime recorder path uses an unexpected path flavor")
    pure = _pure_path(value, flavor)
    if ".." in pure.parts:
        raise BuildError("runtime recorder path contains a parent traversal")
    normalized = _path_module(flavor).normpath(str(pure))
    if not _pure_path(normalized, flavor).is_absolute():
        raise BuildError("runtime recorder path normalization lost its root")
    return flavor, normalized


def _join_runtime_path(raw_path: str, pwd: str, flavor: str) -> str:
    absolute_flavor = _absolute_path_flavor(raw_path)
    if absolute_flavor is not None:
        return _normalize_absolute_lexical(raw_path, expected_flavor=flavor)[1]
    pure = _pure_path(raw_path, flavor)
    if pure.anchor or ".." in pure.parts:
        raise BuildError(
            "runtime recorder relative path is rooted or traverses a parent"
        )
    joined = _path_module(flavor).join(pwd, str(pure))
    return _normalize_absolute_lexical(joined, expected_flavor=flavor)[1]


def _relative_lexical(child: str, root: str, flavor: str) -> str | None:
    child_flavor, child_normalized = _normalize_absolute_lexical(
        child, expected_flavor=flavor
    )
    root_flavor, root_normalized = _normalize_absolute_lexical(
        root, expected_flavor=flavor
    )
    if child_flavor != root_flavor:
        return None
    path_module = _path_module(flavor)
    try:
        common = path_module.commonpath([child_normalized, root_normalized])
    except ValueError:
        return None
    if _path_comparison_key(common, flavor) != _path_comparison_key(
        root_normalized, flavor
    ):
        return None
    relative = path_module.relpath(child_normalized, root_normalized)
    if relative in {"", "."}:
        return ""
    pure_relative = _pure_path(relative, flavor)
    if (
        pure_relative.is_absolute()
        or pure_relative.anchor
        or ".." in pure_relative.parts
    ):
        raise BuildError("runtime recorder relative identity is unsafe")
    return PurePosixPath(*pure_relative.parts).as_posix()


def _metadata_is_link_like(metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


def _stat_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        metadata.st_size,
        metadata.st_mtime_ns,
    )


def _object_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode)


def _stable_plain_file_bytes(path: Path, label: str) -> tuple[bytes, os.stat_result]:
    try:
        before = path.lstat()
        if _metadata_is_link_like(before) or not stat.S_ISREG(before.st_mode):
            raise BuildError(f"{label} is not a plain file")
        with path.open("rb") as handle:
            opened_before = os.fstat(handle.fileno())
            data = handle.read()
            opened_after = os.fstat(handle.fileno())
        after = path.lstat()
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError(f"{label} is unavailable") from exc
    if (
        _metadata_is_link_like(after)
        or not stat.S_ISREG(after.st_mode)
        or not (
            _stat_signature(before)
            == _stat_signature(opened_before)
            == _stat_signature(opened_after)
            == _stat_signature(after)
        )
        or len(data) != before.st_size
    ):
        raise BuildError(f"{label} changed while being read")
    return data, before


def _plain_directory_identity(
    path: Path, label: str
) -> tuple[Path, tuple[int, int, int]]:
    try:
        metadata = path.lstat()
        if _metadata_is_link_like(metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise BuildError(f"{label} is not a plain directory")
        resolved = path.resolve(strict=True)
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError(f"{label} is unavailable") from exc
    if resolved != path:
        raise BuildError(f"{label} path identity is ambiguous")
    return resolved, _object_identity(metadata)


def _verify_plain_directory_identity(
    path: Path,
    expected: tuple[Path, tuple[int, int, int]],
    label: str,
) -> None:
    if _plain_directory_identity(path, label) != expected:
        raise BuildError(f"{label} identity changed during the build")


def _verify_bound_plain_file(
    path: Path,
    *,
    label: str,
    expected_resolved: Path,
    expected_identity: tuple[int, int, int],
    expected_size: int,
    expected_sha256: str,
) -> bytes:
    try:
        resolved_before = path.resolve(strict=True)
    except OSError as exc:
        raise BuildError(f"{label} is unavailable") from exc
    data, metadata = _stable_plain_file_bytes(path, label)
    try:
        resolved_after = path.resolve(strict=True)
    except OSError as exc:
        raise BuildError(f"{label} is unavailable") from exc
    if (
        resolved_before != expected_resolved
        or resolved_after != expected_resolved
        or _object_identity(metadata) != expected_identity
    ):
        raise BuildError(f"{label} identity changed during the build")
    if len(data) != expected_size or _sha256_bytes(data) != expected_sha256:
        raise BuildError(f"{label} changed during the build")
    return data


def _verify_final_pdf_unchanged(
    path: Path,
    *,
    expected_resolved: Path,
    expected_identity: tuple[int, int, int],
    expected_size: int,
    expected_sha256: str,
) -> None:
    _verify_bound_plain_file(
        path,
        label="final PDF",
        expected_resolved=expected_resolved,
        expected_identity=expected_identity,
        expected_size=expected_size,
        expected_sha256=expected_sha256,
    )


def _verify_written_receipt(
    path: Path,
    expected_bytes: bytes,
    *,
    expected_resolved: Path,
    expected_identity: tuple[int, int, int],
) -> None:
    observed = _verify_bound_plain_file(
        path,
        label="build receipt",
        expected_resolved=expected_resolved,
        expected_identity=expected_identity,
        expected_size=len(expected_bytes),
        expected_sha256=_sha256_bytes(expected_bytes),
    )
    if observed != expected_bytes:
        raise BuildError("build receipt bytes are not canonical")


def _assert_no_link_components(path: Path, root: Path, relative_path: str) -> None:
    current = root
    for part in PurePosixPath(relative_path).parts:
        current = current / part
        try:
            metadata = current.lstat()
        except OSError as exc:
            raise BuildError("runtime dependency is unavailable") from exc
        if _metadata_is_link_like(metadata):
            raise BuildError("runtime dependency traverses a symlink or reparse point")
    if path.resolve(strict=True) != current.resolve(strict=True):
        raise BuildError("runtime dependency has an ambiguous normalized identity")


def _verified_runtime_root(raw_path: str, root_role: str) -> _RuntimeRoot:
    flavor, normalized = _normalize_absolute_lexical(
        raw_path, expected_flavor=_native_path_flavor()
    )
    path = Path(normalized)
    try:
        metadata = path.lstat()
        if _metadata_is_link_like(metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise BuildError(f"{root_role} root is not a plain directory")
        resolved = path.resolve(strict=True)
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError(f"{root_role} root is unavailable") from exc
    if _path_comparison_key(str(resolved), flavor) != _path_comparison_key(
        normalized, flavor
    ):
        raise BuildError(f"{root_role} root contains a path alias or symlink")
    return _RuntimeRoot(root_role=root_role, path=resolved)


def _validate_runtime_roots(roots: Sequence[_RuntimeRoot]) -> None:
    if len({root.root_role for root in roots}) != len(roots):
        raise BuildError("runtime roots contain duplicate roles")
    for index, left in enumerate(roots):
        for right in roots[index + 1 :]:
            if (
                _is_within(left.path, right.path)
                or _is_within(right.path, left.path)
                or left.path == right.path
            ):
                raise BuildError("runtime roots overlap or alias one another")


def _parse_miktex_runtime_roots(
    report_output: bytes,
    *,
    pdflatex_executable: Path,
    initexmf_executable: Path,
) -> tuple[_RuntimeRoot, ...]:
    try:
        report = report_output.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise BuildError("MiKTeX root report is not UTF-8") from exc
    values: dict[str, str] = {}
    configured_roots: list[str] = []
    for line in report.splitlines():
        match = re.fullmatch(r"(Root\d+|UserInstall|UserData):\s*(.+?)\s*", line)
        if match is None:
            continue
        key, value = match.groups()
        if key in values:
            raise BuildError("MiKTeX root report contains duplicate fields")
        values[key] = value
        if key.startswith("Root"):
            configured_roots.append(value)
    if set(("UserInstall", "UserData")) - set(values):
        raise BuildError("MiKTeX root report omits required root roles")

    flavor = _native_path_flavor()
    configured_keys = {
        _path_comparison_key(
            _normalize_absolute_lexical(value, expected_flavor=flavor)[1], flavor
        )
        for value in configured_roots
    }
    role_values = {
        "miktex_install": values["UserInstall"],
        "miktex_user_data": values["UserData"],
    }
    roots = tuple(
        _verified_runtime_root(role_values[role], role)
        for role in MIKTEX_RUNTIME_ROOT_ROLES
    )
    if any(
        _path_comparison_key(str(root.path), flavor) not in configured_keys
        for root in roots
    ):
        raise BuildError("MiKTeX role root is not a configured TEXMF root")
    _validate_runtime_roots(roots)
    install_root = next(root for root in roots if root.root_role == "miktex_install")
    for executable in (pdflatex_executable, initexmf_executable):
        if not _is_within(executable.resolve(strict=True), install_root.path):
            raise BuildError("MiKTeX executable is outside the reported install root")
    return roots


def _runtime_tree(records: Sequence[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        records,
        key=lambda record: (str(record["root_role"]), str(record["relative_path"])),
    )
    rows = b"".join(
        (
            f"{record['root_role']}\t{record['relative_path']}\t"
            f"{record['size_bytes']}\t{record['sha256']}\n"
        ).encode("utf-8")
        for record in ordered
    )
    return {
        "file_count": len(ordered),
        "files": ordered,
        "hash_algorithm": (
            "sha256(concat(sorted(root_role<TAB>relative_path<TAB>"
            "size_bytes<TAB>sha256<LF>)))"
        ),
        "sha256": _sha256_bytes(rows),
        "size_bytes": sum(int(record["size_bytes"]) for record in ordered),
    }


def _relative_identity_key(root_role: str, relative_path: str) -> tuple[str, str]:
    normalized = PurePosixPath(relative_path).as_posix()
    if _native_path_flavor() == "windows":
        normalized = normalized.casefold()
    return root_role, normalized


def _runtime_root_layout(
    *,
    work_dir: Path,
    repo_root: Path,
    external_roots: Sequence[_RuntimeRoot],
) -> tuple[_RuntimeRoot, ...]:
    work = _RuntimeRoot("work", work_dir.resolve(strict=True))
    repository = _RuntimeRoot("repository", repo_root.resolve(strict=True))
    if not _is_within(work.path, repository.path) and work.path != repository.path:
        # Outputs outside the repository are also supported; the roots remain disjoint.
        pass
    for external in external_roots:
        for internal in (work, repository):
            if (
                _is_within(external.path, internal.path)
                or _is_within(internal.path, external.path)
                or external.path == internal.path
            ):
                raise BuildError("MiKTeX runtime root overlaps a build-owned root")
    return (work, repository, *external_roots)


def _runtime_file_from_path(
    absolute_lexical: str,
    *,
    roots: Sequence[_RuntimeRoot],
) -> _RuntimeFile:
    flavor = _native_path_flavor()
    matches: list[tuple[_RuntimeRoot, str]] = []
    for root in roots:
        relative = _relative_lexical(absolute_lexical, str(root.path), flavor)
        if relative is not None:
            matches.append((root, relative))

    work_matches = [match for match in matches if match[0].root_role == "work"]
    if work_matches:
        matches = work_matches
    else:
        repository_matches = [
            match for match in matches if match[0].root_role == "repository"
        ]
        if repository_matches:
            matches = repository_matches
    if len(matches) != 1:
        if not matches:
            raise BuildError("runtime dependency is outside all approved roots")
        raise BuildError("runtime dependency has an ambiguous root identity")
    root, lexical_relative = matches[0]
    if not lexical_relative:
        raise BuildError("runtime dependency names a root directory")
    lexical_candidate = (
        lexical_relative.casefold() if flavor == "windows" else lexical_relative
    )
    if root.root_role == "work":
        allowed = {
            value.casefold() if flavor == "windows" else value
            for value in ALLOWED_RUNTIME_WORK_INPUTS
        }
        if lexical_candidate not in allowed:
            raise BuildError("runtime dependency is not an approved work input")
    elif root.root_role == "repository":
        allowed = {
            value.casefold() if flavor == "windows" else value
            for value in CANONICAL_INPUT_PATHS
        }
        if lexical_candidate not in allowed:
            raise BuildError("runtime dependency is not a fixed repository input")
    elif root.root_role not in MIKTEX_RUNTIME_ROOT_ROLES:
        raise BuildError("runtime dependency uses an unknown external root role")

    path = Path(absolute_lexical)
    _assert_no_link_components(path, root.path, lexical_relative)
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise BuildError("runtime dependency could not be resolved") from exc
    if not _is_within(resolved, root.path):
        raise BuildError("runtime dependency escapes its approved root")
    resolved_relative = resolved.relative_to(root.path).as_posix()
    if _relative_identity_key(
        root.root_role, lexical_relative
    ) != _relative_identity_key(root.root_role, resolved_relative):
        raise BuildError("runtime dependency has duplicate relative identities")

    if root.root_role == "work":
        allowed = {
            value.casefold() if flavor == "windows" else value
            for value in ALLOWED_RUNTIME_WORK_INPUTS
        }
        candidate = (
            resolved_relative.casefold() if flavor == "windows" else resolved_relative
        )
        if candidate not in allowed:
            raise BuildError("runtime dependency is not an approved work input")
    elif root.root_role == "repository":
        allowed = {
            value.casefold() if flavor == "windows" else value
            for value in CANONICAL_INPUT_PATHS
        }
        candidate = (
            resolved_relative.casefold() if flavor == "windows" else resolved_relative
        )
        if candidate not in allowed:
            raise BuildError("runtime dependency is not a fixed repository input")
    elif root.root_role not in MIKTEX_RUNTIME_ROOT_ROLES:
        raise BuildError("runtime dependency uses an unknown external root role")

    data, metadata = _stable_plain_file_bytes(path, "runtime dependency")
    return _RuntimeFile(
        absolute_path=resolved,
        root_role=root.root_role,
        relative_path=resolved_relative,
        size_bytes=metadata.st_size,
        sha256=_sha256_bytes(data),
    )


def _parse_runtime_fls_bytes(
    fls_bytes: bytes,
    *,
    work_dir: Path,
    roots: Sequence[_RuntimeRoot],
) -> tuple[tuple[_RuntimeFile, ...], int]:
    try:
        text = fls_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise BuildError("main.fls is not UTF-8") from exc
    pwd_rows: list[str] = []
    input_rows: list[str] = []
    for line in text.splitlines():
        if line.startswith("PWD "):
            pwd_rows.append(line[4:])
        elif line.startswith("INPUT "):
            input_rows.append(line[6:])
        elif line.startswith("OUTPUT "):
            if not line[7:]:
                raise BuildError("main.fls contains an empty OUTPUT row")
        else:
            raise BuildError("main.fls contains an unsupported recorder row")
    if len(pwd_rows) != 1:
        raise BuildError("main.fls must contain exactly one PWD row")
    if not input_rows:
        raise BuildError("main.fls contains no INPUT rows")

    flavor, pwd = _normalize_absolute_lexical(
        pwd_rows[0], expected_flavor=_native_path_flavor()
    )
    _, expected_pwd = _normalize_absolute_lexical(
        str(work_dir.resolve(strict=True)), expected_flavor=flavor
    )
    if _path_comparison_key(pwd, flavor) != _path_comparison_key(expected_pwd, flavor):
        raise BuildError("main.fls PWD does not match the build work directory")

    by_absolute: dict[str, _RuntimeFile] = {}
    by_identity: dict[tuple[str, str], _RuntimeFile] = {}
    for raw_path in input_rows:
        absolute = _join_runtime_path(raw_path, pwd, flavor)
        absolute_key = _path_comparison_key(absolute, flavor)
        runtime_file = by_absolute.get(absolute_key)
        if runtime_file is None:
            runtime_file = _runtime_file_from_path(absolute, roots=roots)
            by_absolute[absolute_key] = runtime_file
        identity = _relative_identity_key(
            runtime_file.root_role, runtime_file.relative_path
        )
        previous = by_identity.get(identity)
        if (
            previous is not None
            and previous.absolute_path != runtime_file.absolute_path
        ):
            raise BuildError("runtime recorder contains duplicate relative identities")
        by_identity[identity] = runtime_file
    return (
        tuple(
            sorted(
                by_identity.values(),
                key=lambda item: (item.root_role, item.relative_path),
            )
        ),
        len(input_rows),
    )


def _snapshot_local_diagnostic(
    source_path: Path,
    destination_path: Path,
    label: str,
    *,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    data, metadata = _stable_plain_file_bytes(source_path, label)
    data_sha256 = _sha256_bytes(data)
    if expected_sha256 is not None and data_sha256 != expected_sha256:
        raise BuildError(f"{label} changed before local diagnostic preservation")
    try:
        with destination_path.open("xb") as handle:
            handle.write(data)
    except OSError as exc:
        raise BuildError(f"could not preserve {label}") from exc
    if (
        destination_path.stat().st_size != metadata.st_size
        or _sha256_file(destination_path) != data_sha256
    ):
        raise BuildError(f"preserved {label} failed verification")
    return {
        "path": destination_path.parent.name + "/" + destination_path.name,
        "privacy_class": "local_diagnostic_may_contain_host_paths",
    }


def _remove_stale_recorder_artifacts(work_dir: Path) -> None:
    for name in ("main.fls", "main.log"):
        path = work_dir / name
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise BuildError(f"could not inspect stale {name}") from exc
        if _metadata_is_link_like(metadata) or not stat.S_ISREG(metadata.st_mode):
            raise BuildError(f"stale {name} is not a plain file")
        path.unlink()


def _merge_runtime_pass(
    files: Sequence[_RuntimeFile],
    *,
    union: dict[tuple[str, str], _RuntimeFile],
    stable: dict[tuple[str, str], _RuntimeFile],
) -> None:
    for runtime_file in files:
        identity = _relative_identity_key(
            runtime_file.root_role, runtime_file.relative_path
        )
        previous = union.get(identity)
        if (
            previous is not None
            and previous.absolute_path != runtime_file.absolute_path
        ):
            raise BuildError("runtime dependency relative identity is duplicated")
        is_generated_work = (
            runtime_file.root_role == "work"
            and runtime_file.relative_path not in SOURCE_INPUTS
        )
        if not is_generated_work:
            stable_previous = stable.get(identity)
            if (
                stable_previous is not None
                and stable_previous.public_record() != runtime_file.public_record()
            ):
                raise BuildError("runtime dependency changed between LaTeX passes")
            stable[identity] = runtime_file
        union[identity] = runtime_file


def _verify_runtime_dependencies_unchanged(
    stable: dict[tuple[str, str], _RuntimeFile],
) -> None:
    for runtime_file in stable.values():
        data, metadata = _stable_plain_file_bytes(
            runtime_file.absolute_path, "runtime dependency recheck"
        )
        if (
            metadata.st_size != runtime_file.size_bytes
            or _sha256_bytes(data) != runtime_file.sha256
        ):
            raise BuildError("runtime dependency changed before receipt generation")


def _validate_identifier(value: str, label: str) -> str:
    if HEX_OBJECT_ID.fullmatch(value) is None:
        raise BuildError(f"{label} must be a full 40- or 64-hex object id")
    return value.lower()


def _validate_expected_sha256(value: str | None) -> str | None:
    if value is None:
        return None
    if HEX_SHA256.fullmatch(value) is None:
        raise BuildError("expected PDF SHA-256 must contain exactly 64 hex digits")
    return value.lower()


def _input_records(paper_dir: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for relative in SOURCE_INPUTS:
        path = paper_dir / Path(relative)
        try:
            metadata = path.lstat()
        except OSError as exc:
            raise BuildError(
                f"required paper input is unavailable: {relative}"
            ) from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise BuildError(f"required paper input is not a plain file: {relative}")
        if not _is_within(path.resolve(strict=True), paper_dir):
            raise BuildError(
                f"required paper input escapes the paper directory: {relative}"
            )
        records.append(
            {
                "path": relative,
                "sha256": _sha256_file(path),
                "size_bytes": metadata.st_size,
            }
        )
    return records


def _tree_sha256(records: Sequence[dict[str, Any]], *, path_prefix: str = "") -> str:
    rows = b"".join(
        (
            f"{path_prefix}{record['path']}\t{record['size_bytes']}\t"
            f"{record['sha256']}\n"
        ).encode("ascii")
        for record in sorted(records, key=lambda item: str(item["path"]))
    )
    return _sha256_bytes(rows)


def _copy_inputs(
    paper_dir: Path, work_dir: Path, records: Sequence[dict[str, Any]]
) -> None:
    for record in records:
        relative = Path(str(record["path"]))
        destination = work_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with (
            (paper_dir / relative).open("rb") as source,
            destination.open("xb") as target,
        ):
            shutil.copyfileobj(source, target)
        if _sha256_file(destination) != record["sha256"]:
            raise BuildError(
                f"copied paper input failed verification: {record['path']}"
            )


def _verify_snapshot(root: Path, records: Sequence[dict[str, Any]], label: str) -> None:
    if _input_records(root) != list(records):
        raise BuildError(f"{label} paper inputs changed during the build")


def _stability_sha256(work_dir: Path) -> str:
    records = []
    for name in STABILITY_FILES:
        path = work_dir / name
        if path.is_file():
            records.append(
                {
                    "path": name,
                    "sha256": _sha256_file(path),
                    "size_bytes": path.stat().st_size,
                }
            )
    required = {"main.aux", "main.bbl", "main.pdf"}
    if not required.issubset({row["path"] for row in records}):
        raise BuildError("LaTeX did not produce main.aux, main.bbl, and main.pdf")
    return _tree_sha256(records)


def _informational_pdf_page_count(path: Path) -> int | None:
    data = path.read_bytes()
    if not data.startswith(b"%PDF-"):
        return None
    pages = len(re.findall(rb"/Type\s*/Page\b", data))
    return pages if pages > 0 else None


def _version_banner(output: bytes) -> str:
    text = output.decode("utf-8", errors="replace")
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def _public_version_banner(output: bytes, executable: Path, name: str) -> str:
    """Return one useful version line without exposing host-local paths."""
    banner = _version_banner(output)
    for private in {str(executable), executable.as_posix()}:
        banner = re.sub(re.escape(private), name, banner, flags=re.IGNORECASE)
    banner = re.sub(r"(?i)\b[A-Z]:[\\/][^\s]+", "<absolute-path>", banner)
    banner = re.sub(r"\\\\[^\\\s]+\\[^\s]+", "<absolute-path>", banner)
    banner = re.sub(r"(?<![\w.])/(?:[^/\s]+/)*[^/\s]+", "<absolute-path>", banner)
    return banner


def _distribution(output: bytes) -> str:
    lowered = output.lower()
    if b"miktex" in lowered:
        return "miktex"
    if b"tex live" in lowered:
        return "tex-live"
    return "unknown"


class _CommandRecorder:
    def __init__(
        self,
        log: BinaryIO,
        *,
        cwd: Path,
        environment: dict[str, str],
        timeout_seconds: int,
    ) -> None:
        self.log = log
        self.cwd = cwd
        self.environment = environment
        self.timeout_seconds = timeout_seconds
        self.commands: list[dict[str, Any]] = []
        self.output_hash = hashlib.sha256()
        self.output_size = 0

    def run(
        self,
        phase: str,
        argv: Sequence[str],
        *,
        receipt_argv: Sequence[str] | None = None,
        persist_output: bool = True,
        record_command: bool = True,
    ) -> bytes:
        if persist_output and not record_command:
            raise BuildError("an unrecorded command cannot append to the public log")
        execution_argv = list(argv)
        try:
            process = subprocess.run(
                execution_argv,
                cwd=str(self.cwd),
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                shell=False,
                timeout=self.timeout_seconds,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise BuildError(f"could not run {phase}: {exc}") from exc
        output = process.stdout or b""
        if isinstance(output, str):
            output = output.encode("utf-8")
        if persist_output:
            self.log.write(output)
            self.log.flush()
            self.output_hash.update(output)
            self.output_size += len(output)
        row = {
            "argv": list(receipt_argv) if receipt_argv is not None else execution_argv,
            "exit_code": int(process.returncode),
            "phase": phase,
            "sequence": len(self.commands) + 1,
        }
        if persist_output:
            row.update(
                {
                    "combined_output_sha256": _sha256_bytes(output),
                    "combined_output_size_bytes": len(output),
                }
            )
        else:
            row["output_persistence"] = "ephemeral_private_not_logged"
        if record_command:
            self.commands.append(row)
        if process.returncode != 0:
            raise BuildError(f"{phase} exited with code {process.returncode}")
        return output


def _process_stdout(process: subprocess.CompletedProcess[Any]) -> bytes:
    output = process.stdout or b""
    return output.encode("utf-8") if isinstance(output, str) else output


def _controlled_git_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("GIT_")
    }
    environment.update(CONTROLLED_GIT_ENVIRONMENT)
    return environment


def _run_git(
    executable: Path,
    cwd: Path,
    args: Sequence[str],
    *,
    timeout_seconds: int,
    allowed_returncodes: frozenset[int] = frozenset({0}),
) -> subprocess.CompletedProcess[Any]:
    argv = [str(executable), *args]
    try:
        process = subprocess.run(
            argv,
            cwd=str(cwd),
            env=_controlled_git_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise BuildError("could not verify the Git subject checkout") from exc
    if process.returncode not in allowed_returncodes:
        raise BuildError(
            f"Git subject verification failed with exit code {process.returncode}"
        )
    return process


def _single_git_line(process: subprocess.CompletedProcess[Any], label: str) -> str:
    try:
        text = _process_stdout(process).decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise BuildError(f"Git returned a non-UTF-8 {label}") from exc
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise BuildError(f"Git did not return exactly one {label}")
    return lines[0]


def _parse_git_ls_tree(
    process: subprocess.CompletedProcess[Any], label: str
) -> dict[str, tuple[str, str, str]]:
    tracked: dict[str, tuple[str, str, str]] = {}
    for entry in _process_stdout(process).split(b"\0"):
        if not entry:
            continue
        try:
            metadata, raw_path = entry.split(b"\t", maxsplit=1)
            mode, object_type, object_id = metadata.decode("ascii").split()
            tracked_path = raw_path.decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise BuildError(f"Git {label} ls-tree output could not be parsed") from exc
        if tracked_path in tracked:
            raise BuildError(f"Git subject contains a duplicate {label} path")
        if HEX_OBJECT_ID.fullmatch(object_id) is None:
            raise BuildError(f"Git {label} ls-tree returned an invalid object id")
        tracked[tracked_path] = (mode, object_type, object_id.lower())
    return tracked


def _read_executing_build_tool_source() -> bytes:
    """Read the source bytes backing this executing module without path disclosure."""
    declared_path = Path(__file__)
    try:
        declared_metadata = declared_path.lstat()
        if stat.S_ISLNK(declared_metadata.st_mode) or not stat.S_ISREG(
            declared_metadata.st_mode
        ):
            raise BuildError("executing build tool source is not a plain file")
        source_path = declared_path.resolve(strict=True)
        before = source_path.stat()
        with source_path.open("rb") as handle:
            opened_before = os.fstat(handle.fileno())
            data = handle.read()
            opened_after = os.fstat(handle.fileno())
        after = source_path.stat()
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError("executing build tool source is unavailable") from exc

    def signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
        return (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_mode,
            metadata.st_size,
            metadata.st_mtime_ns,
        )

    if (
        not (
            signature(before)
            == signature(opened_before)
            == signature(opened_after)
            == signature(after)
        )
        or len(data) != before.st_size
    ):
        raise BuildError("executing build tool source changed while being read")
    return data


def _verify_build_tool_source_binding(
    git_executable: Path,
    repo_root: Path,
    commit: str,
    *,
    timeout_seconds: int,
) -> dict[str, Any]:
    """Bind the executing builder bytes to its canonical commit blob when tracked."""
    ls_tree = _run_git(
        git_executable,
        repo_root,
        [
            "ls-tree",
            "-z",
            "--full-tree",
            commit,
            "--",
            CANONICAL_BUILD_TOOL_PATH,
        ],
        timeout_seconds=timeout_seconds,
    )
    tracked = _parse_git_ls_tree(ls_tree, "build tool source")
    if not tracked:
        return {
            "path": CANONICAL_BUILD_TOOL_PATH,
            "reason": "not_tracked",
        }
    if set(tracked) != {CANONICAL_BUILD_TOOL_PATH}:
        raise BuildError("Git subject returned an unexpected build tool source path")
    mode, object_type, blob_oid = tracked[CANONICAL_BUILD_TOOL_PATH]
    if object_type != "blob" or mode not in {"100644", "100755"}:
        raise BuildError("tracked build tool source is not a regular blob")
    try:
        executing_path = Path(__file__).resolve(strict=True)
        canonical_path = (repo_root / CANONICAL_BUILD_TOOL_PATH).resolve(strict=True)
    except OSError as exc:
        raise BuildError("build tool source paths could not be resolved") from exc
    if executing_path != canonical_path:
        raise BuildError("executing build tool is not at its canonical repository path")
    blob = _process_stdout(
        _run_git(
            git_executable,
            repo_root,
            ["cat-file", "blob", f"{commit}:{CANONICAL_BUILD_TOOL_PATH}"],
            timeout_seconds=timeout_seconds,
        )
    )
    if _git_blob_oid(blob, len(blob_oid)) != blob_oid:
        raise BuildError("build tool blob bytes do not match its tracked object id")
    executing_source = _read_executing_build_tool_source()
    if executing_source != blob:
        raise BuildError("executing build tool source does not match the subject blob")
    return {
        "blob_oid": blob_oid,
        "path": CANONICAL_BUILD_TOOL_PATH,
        "sha256": _sha256_bytes(blob),
        "size_bytes": len(blob),
    }


def _verify_git_subject(
    paper_root: Path,
    commit: str,
    tree: str,
    *,
    timeout_seconds: int,
) -> dict[str, Any]:
    """Bind the nine worktree inputs to one clean, canonical Git subject."""
    git_name = shutil.which("git")
    if git_name is None:
        raise BuildError("required executable is not on PATH: git")
    git_executable = Path(git_name).resolve(strict=True)
    if not git_executable.is_file():
        raise BuildError("resolved executable is not a file: git")
    git_size = git_executable.stat().st_size
    git_sha256 = _sha256_file(git_executable)
    repo_line = _single_git_line(
        _run_git(
            git_executable,
            paper_root,
            ["rev-parse", "--show-toplevel"],
            timeout_seconds=timeout_seconds,
        ),
        "repository root",
    )
    try:
        repo_root = Path(repo_line).resolve(strict=True)
        canonical_paper = (repo_root / CANONICAL_PAPER_PATH).resolve(strict=True)
    except OSError as exc:
        raise BuildError("Git repository paths could not be resolved") from exc
    if not repo_root.is_dir():
        raise BuildError("Git repository root is not a directory")
    if paper_root != canonical_paper:
        raise BuildError(
            f"paper directory must be the repository's {CANONICAL_PAPER_PATH}"
        )

    head = _single_git_line(
        _run_git(
            git_executable,
            repo_root,
            ["rev-parse", "--verify", "HEAD"],
            timeout_seconds=timeout_seconds,
        ),
        "HEAD object id",
    ).lower()
    if HEX_OBJECT_ID.fullmatch(head) is None or head != commit:
        raise BuildError("repository HEAD does not match the subject commit")

    resolved_tree = _single_git_line(
        _run_git(
            git_executable,
            repo_root,
            ["rev-parse", "--verify", f"{commit}^{{tree}}"],
            timeout_seconds=timeout_seconds,
        ),
        "subject tree object id",
    ).lower()
    if HEX_OBJECT_ID.fullmatch(resolved_tree) is None or resolved_tree != tree:
        raise BuildError("subject commit tree does not match the subject tree")

    ls_tree = _run_git(
        git_executable,
        repo_root,
        ["ls-tree", "-z", "--full-tree", commit, "--", *CANONICAL_INPUT_PATHS],
        timeout_seconds=timeout_seconds,
    )
    tracked = _parse_git_ls_tree(ls_tree, "fixed paper input")
    expected_paths = set(CANONICAL_INPUT_PATHS)
    if set(tracked) != expected_paths:
        raise BuildError("not all nine fixed paper inputs are tracked by the subject")
    if any(
        object_type != "blob" or mode not in {"100644", "100755"}
        for mode, object_type, _object_id in tracked.values()
    ):
        raise BuildError("a fixed paper input is not a regular tracked blob")

    build_tool_source = _verify_build_tool_source_binding(
        git_executable,
        repo_root,
        commit,
        timeout_seconds=timeout_seconds,
    )

    fixed_input_blobs = []
    for canonical_path in CANONICAL_INPUT_PATHS:
        blob = _process_stdout(
            _run_git(
                git_executable,
                repo_root,
                ["cat-file", "blob", f"{commit}:{canonical_path}"],
                timeout_seconds=timeout_seconds,
            )
        )
        blob_oid = tracked[canonical_path][2]
        if _git_blob_oid(blob, len(blob_oid)) != blob_oid:
            raise BuildError("Git blob bytes do not match the tracked blob object id")
        fixed_input_blobs.append(
            {
                "blob_oid": blob_oid,
                "path": canonical_path.removeprefix(CANONICAL_PAPER_PREFIX),
                "sha256": _sha256_bytes(blob),
                "size_bytes": len(blob),
            }
        )

    index_diff = _run_git(
        git_executable,
        repo_root,
        [
            "diff",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            commit,
            "--",
            *CANONICAL_INPUT_PATHS,
        ],
        timeout_seconds=timeout_seconds,
        allowed_returncodes=frozenset({0, 1}),
    )
    if index_diff.returncode == 1:
        raise BuildError("paper input index differs from the subject commit")
    worktree_diff = _run_git(
        git_executable,
        repo_root,
        [
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            commit,
            "--",
            *CANONICAL_INPUT_PATHS,
        ],
        timeout_seconds=timeout_seconds,
        allowed_returncodes=frozenset({0, 1}),
    )
    if worktree_diff.returncode == 1:
        raise BuildError("paper input worktree differs from the subject commit")

    head_after = _single_git_line(
        _run_git(
            git_executable,
            repo_root,
            ["rev-parse", "--verify", "HEAD"],
            timeout_seconds=timeout_seconds,
        ),
        "post-verification HEAD object id",
    ).lower()
    if head_after != commit:
        raise BuildError("repository HEAD changed during subject verification")
    if (
        git_executable.stat().st_size != git_size
        or _sha256_file(git_executable) != git_sha256
    ):
        raise BuildError("git executable changed during subject verification")
    return {
        "build_tool_source": build_tool_source,
        "canonical_paper_path": CANONICAL_PAPER_PATH,
        "fixed_input_count": len(CANONICAL_INPUT_PATHS),
        "fixed_input_blobs": fixed_input_blobs,
        "fixed_inputs_tracked_by_commit": True,
        "git_executable": {
            "filename": git_executable.name,
            "sha256": git_sha256,
            "size_bytes": git_size,
        },
        "git_environment_policy": "caller_GIT_*_variables_removed",
        "head_matches_commit": True,
        "index_matches_commit": True,
        "tree_matches_commit": True,
        "worktree_matches_commit": True,
    }


def _tool_record_for_path(
    name: str, executable_path: Path, recorder: _CommandRecorder
) -> tuple[dict[str, Any], str, Path]:
    try:
        declared_metadata = executable_path.lstat()
        if _metadata_is_link_like(declared_metadata) or not stat.S_ISREG(
            declared_metadata.st_mode
        ):
            raise BuildError(f"resolved executable is not a plain file: {name}")
        executable_path = executable_path.resolve(strict=True)
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError(f"resolved executable is unavailable: {name}") from exc
    executable_size = executable_path.stat().st_size
    executable_sha256 = _sha256_file(executable_path)
    output = recorder.run(
        f"{name}-version",
        [str(executable_path), "--version"],
        receipt_argv=[name, "--version"],
    )
    if (
        executable_path.stat().st_size != executable_size
        or _sha256_file(executable_path) != executable_sha256
    ):
        raise BuildError(f"{name} executable changed during version inspection")
    distribution = _distribution(output)
    if distribution == "unknown":
        raise BuildError(f"unsupported TeX distribution reported by {name}")
    return (
        {
            "distribution": distribution,
            "executable_filename": executable_path.name,
            "executable_sha256": executable_sha256,
            "executable_size_bytes": executable_size,
            "version_banner": _public_version_banner(output, executable_path, name),
            "version_output_sha256": _sha256_bytes(output),
            "version_output_size_bytes": len(output),
        },
        distribution,
        executable_path,
    )


def _tool_record(
    name: str, recorder: _CommandRecorder
) -> tuple[dict[str, Any], str, Path]:
    executable = shutil.which(name)
    if executable is None:
        raise BuildError(f"required executable is not on PATH: {name}")
    return _tool_record_for_path(name, Path(executable), recorder)


def _verify_tool_unchanged(
    name: str, executable_path: Path, record: dict[str, Any]
) -> None:
    try:
        resolved_before = executable_path.resolve(strict=True)
        data, metadata = _stable_plain_file_bytes(executable_path, f"{name} executable")
        resolved_after = executable_path.resolve(strict=True)
        unchanged = (
            resolved_before == executable_path
            and resolved_after == executable_path
            and metadata.st_size == record["executable_size_bytes"]
            and _sha256_bytes(data) == record["executable_sha256"]
        )
    except BuildError:
        raise
    except OSError as exc:
        raise BuildError(f"{name} executable became unavailable") from exc
    if not unchanged:
        raise BuildError(
            f"{name} executable identity or bytes changed during the build"
        )


def _run_bound_tool(
    recorder: _CommandRecorder,
    *,
    name: str,
    executable_path: Path,
    tool_record: dict[str, Any],
    phase: str,
    argv: Sequence[str],
    persist_output: bool = True,
    record_command: bool = True,
) -> bytes:
    _verify_tool_unchanged(name, executable_path, tool_record)
    output = recorder.run(
        phase,
        argv,
        receipt_argv=_public_tool_argv(name, argv),
        persist_output=persist_output,
        record_command=record_command,
    )
    _verify_tool_unchanged(name, executable_path, tool_record)
    return output


def _miktex_initexmf_record(
    pdflatex_executable: Path, recorder: _CommandRecorder
) -> tuple[dict[str, Any], Path]:
    suffix = pdflatex_executable.suffix
    candidate = pdflatex_executable.with_name(f"initexmf{suffix}")
    record, distribution, executable = _tool_record_for_path(
        "initexmf", candidate, recorder
    )
    if distribution != "miktex":
        raise BuildError("initexmf does not report MiKTeX")
    if executable.parent != pdflatex_executable.parent:
        raise BuildError("initexmf is not colocated with pdflatex")
    return record, executable


def _discover_miktex_runtime_roots(
    recorder: _CommandRecorder,
    *,
    pdflatex_executable: Path,
    initexmf_executable: Path,
    initexmf_record: dict[str, Any],
    record_command: bool = True,
) -> tuple[_RuntimeRoot, ...]:
    report_output = _run_bound_tool(
        recorder,
        name="initexmf",
        executable_path=initexmf_executable,
        tool_record=initexmf_record,
        phase="initexmf-private-root-report",
        argv=[
            str(initexmf_executable),
            "--disable-installer",
            "--report",
        ],
        persist_output=False,
        record_command=record_command,
    )
    return _parse_miktex_runtime_roots(
        report_output,
        pdflatex_executable=pdflatex_executable,
        initexmf_executable=initexmf_executable,
    )


def _latex_argv(executable: Path, miktex: bool) -> list[str]:
    argv = [str(executable)]
    if miktex:
        argv.append("--disable-installer")
    argv.extend(
        [
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-no-shell-escape",
            "-recorder",
            "main.tex",
        ]
    )
    return argv


def _bibtex_argv(executable: Path, miktex: bool) -> list[str]:
    argv = [str(executable)]
    if miktex:
        argv.append("--disable-installer")
    argv.append("main")
    return argv


def _public_tool_argv(name: str, argv: Sequence[str]) -> list[str]:
    if not argv:
        raise BuildError("cannot record an empty tool command")
    return [name, *argv[1:]]


def _assert_receipt_has_no_private_paths(
    receipt: dict[str, Any], private_paths: Sequence[Path]
) -> None:
    def strings(value: Any) -> list[str]:
        if isinstance(value, str):
            return [value]
        if isinstance(value, dict):
            return [
                item
                for key, child in value.items()
                for item in (*strings(key), *strings(child))
            ]
        if isinstance(value, (list, tuple)):
            return [item for child in value for item in strings(child)]
        return []

    public_strings = [value.replace("\\", "/").lower() for value in strings(receipt)]
    for private_path in private_paths:
        candidate = str(private_path.resolve(strict=False)).replace("\\", "/").lower()
        if candidate and any(candidate in value for value in public_strings):
            raise BuildError("receipt would expose a host-local absolute path")


def _run_latex_with_runtime_capture(
    recorder: _CommandRecorder,
    *,
    executable_path: Path,
    tool_record: dict[str, Any],
    phase: str,
    argv: Sequence[str],
    work_dir: Path,
    runtime_records_dir: Path,
    runtime_roots: Sequence[_RuntimeRoot],
    runtime_union: dict[tuple[str, str], _RuntimeFile],
    stable_runtime_files: dict[tuple[str, str], _RuntimeFile],
) -> dict[str, Any]:
    _remove_stale_recorder_artifacts(work_dir)
    _run_bound_tool(
        recorder,
        name="pdflatex",
        executable_path=executable_path,
        tool_record=tool_record,
        phase=phase,
        argv=argv,
    )
    fls_path = work_dir / "main.fls"
    fls_bytes, _fls_metadata = _stable_plain_file_bytes(fls_path, "main.fls")
    runtime_files, input_event_count = _parse_runtime_fls_bytes(
        fls_bytes,
        work_dir=work_dir,
        roots=runtime_roots,
    )
    _merge_runtime_pass(
        runtime_files,
        union=runtime_union,
        stable=stable_runtime_files,
    )
    raw_fls = _snapshot_local_diagnostic(
        fls_path,
        runtime_records_dir / f"{phase}.fls",
        "main.fls",
        expected_sha256=_sha256_bytes(fls_bytes),
    )
    raw_log = _snapshot_local_diagnostic(
        work_dir / "main.log",
        runtime_records_dir / f"{phase}.log",
        "main.log",
    )
    return {
        "canonical_input_tree": _runtime_tree(
            [runtime_file.public_record() for runtime_file in runtime_files]
        ),
        "input_event_count": input_event_count,
        "phase": phase,
        "raw_fls": raw_fls,
        "raw_log": raw_log,
    }


def build_paper(
    *,
    paper_dir: Path,
    output_dir: Path,
    subject_commit: str,
    subject_tree: str,
    expected_pdf_sha256: str | None = None,
    max_post_bibtex_passes: int = 6,
    timeout_seconds: int = 300,
) -> Path:
    """Build into a new output directory and return its receipt path."""
    commit = _validate_identifier(subject_commit, "subject commit")
    tree = _validate_identifier(subject_tree, "subject tree")
    expected = _validate_expected_sha256(expected_pdf_sha256)
    if max_post_bibtex_passes < 2:
        raise BuildError("at least two post-BibTeX LaTeX passes are required")
    if timeout_seconds < 1:
        raise BuildError("command timeout must be positive")

    paper_root = paper_dir.resolve(strict=True)
    if not paper_root.is_dir():
        raise BuildError("paper directory is not a directory")
    output_root = output_dir.resolve(strict=False)
    if output_root.exists():
        raise BuildError("output directory must not already exist")
    if _is_within(output_root, paper_root) or _is_within(paper_root, output_root):
        raise BuildError("output directory must be disjoint from the paper directory")
    if not output_root.parent.is_dir():
        raise BuildError("output directory parent must already exist")

    git_subject = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    repo_root = paper_root
    for _part in Path(CANONICAL_PAPER_PATH).parts:
        repo_root = repo_root.parent
    input_records = _input_records(paper_root)
    committed_input_records = [
        {
            "path": record["path"],
            "sha256": record["sha256"],
            "size_bytes": record["size_bytes"],
        }
        for record in git_subject["fixed_input_blobs"]
    ]
    if input_records != committed_input_records:
        raise BuildError("paper input bytes do not match the subject commit blobs")
    input_tree_sha256 = _tree_sha256(input_records, path_prefix=CANONICAL_PAPER_PREFIX)
    output_root.mkdir(exist_ok=False)
    output_root_identity = _plain_directory_identity(output_root, "output directory")
    work_dir = output_root / "work"
    work_dir.mkdir()
    runtime_records_dir = output_root / "runtime_records"
    runtime_records_dir.mkdir()
    _copy_inputs(paper_root, work_dir, input_records)

    scrubbed_tex_names = set(SCRUBBED_TEX_ENVIRONMENT_VARIABLES)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in scrubbed_tex_names
    }
    environment.update(FIXED_ENVIRONMENT)
    log_path = output_root / "combined_subprocess_output.log"
    runtime_passes: list[dict[str, Any]] = []
    runtime_union: dict[tuple[str, str], _RuntimeFile] = {}
    stable_runtime_files: dict[tuple[str, str], _RuntimeFile] = {}
    with log_path.open("xb") as log:
        recorder = _CommandRecorder(
            log,
            cwd=work_dir,
            environment=environment,
            timeout_seconds=timeout_seconds,
        )
        (
            pdflatex_tool,
            pdflatex_distribution,
            pdflatex_executable,
        ) = _tool_record("pdflatex", recorder)
        bibtex_tool, bibtex_distribution, bibtex_executable = _tool_record(
            "bibtex", recorder
        )
        if pdflatex_distribution != bibtex_distribution:
            raise BuildError("pdflatex and bibtex report different TeX distributions")
        if pdflatex_distribution != "miktex":
            raise BuildError("TeX runtime closure currently requires MiKTeX")
        is_miktex = True
        initexmf_tool, initexmf_executable = _miktex_initexmf_record(
            pdflatex_executable, recorder
        )
        external_runtime_roots = _discover_miktex_runtime_roots(
            recorder,
            pdflatex_executable=pdflatex_executable,
            initexmf_executable=initexmf_executable,
            initexmf_record=initexmf_tool,
        )
        runtime_roots = _runtime_root_layout(
            work_dir=work_dir,
            repo_root=repo_root,
            external_roots=external_runtime_roots,
        )

        latex_argv = _latex_argv(pdflatex_executable, is_miktex)
        bibtex_argv = _bibtex_argv(bibtex_executable, is_miktex)
        runtime_passes.append(
            _run_latex_with_runtime_capture(
                recorder,
                executable_path=pdflatex_executable,
                tool_record=pdflatex_tool,
                phase="latex-initial",
                argv=latex_argv,
                work_dir=work_dir,
                runtime_records_dir=runtime_records_dir,
                runtime_roots=runtime_roots,
                runtime_union=runtime_union,
                stable_runtime_files=stable_runtime_files,
            )
        )
        _run_bound_tool(
            recorder,
            name="bibtex",
            executable_path=bibtex_executable,
            tool_record=bibtex_tool,
            phase="bibtex",
            argv=bibtex_argv,
        )
        previous_fingerprint: str | None = None
        stable_fingerprint: str | None = None
        post_bibtex_passes = 0
        for pass_number in range(1, max_post_bibtex_passes + 1):
            runtime_passes.append(
                _run_latex_with_runtime_capture(
                    recorder,
                    executable_path=pdflatex_executable,
                    tool_record=pdflatex_tool,
                    phase=f"latex-post-bibtex-{pass_number}",
                    argv=latex_argv,
                    work_dir=work_dir,
                    runtime_records_dir=runtime_records_dir,
                    runtime_roots=runtime_roots,
                    runtime_union=runtime_union,
                    stable_runtime_files=stable_runtime_files,
                )
            )
            post_bibtex_passes = pass_number
            fingerprint = _stability_sha256(work_dir)
            if pass_number >= 2 and fingerprint == previous_fingerprint:
                stable_fingerprint = fingerprint
                break
            previous_fingerprint = fingerprint
        if stable_fingerprint is None:
            raise BuildError("LaTeX outputs did not stabilize within the pass limit")
    if (
        _sha256_file(log_path) != recorder.output_hash.hexdigest()
        or log_path.stat().st_size != recorder.output_size
    ):
        raise BuildError("combined subprocess output log failed verification")

    source_rechecks = 0
    tool_rechecks = 0
    git_rechecks = 0
    runtime_rechecks = 0
    root_rechecks = 0

    _verify_snapshot(paper_root, input_records, "source")
    _verify_snapshot(work_dir, input_records, "copied")
    source_rechecks += 1
    _verify_runtime_dependencies_unchanged(stable_runtime_files)
    runtime_rechecks += 1
    _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
    _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
    _verify_tool_unchanged("initexmf", initexmf_executable, initexmf_tool)
    tool_rechecks += 1
    git_subject_after = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    if git_subject_after != git_subject:
        raise BuildError("Git subject verification changed during the build")
    git_rechecks += 1
    built_pdf = work_dir / "main.pdf"
    built_pdf_bytes, _built_pdf_metadata = _stable_plain_file_bytes(
        built_pdf, "built PDF"
    )
    pdf_sha256 = _sha256_bytes(built_pdf_bytes)
    if expected is not None and pdf_sha256 != expected:
        raise BuildError(
            f"built PDF SHA-256 {pdf_sha256} does not match expected {expected}"
        )
    _verify_plain_directory_identity(
        output_root, output_root_identity, "output directory"
    )
    final_pdf = output_root / "main.pdf"
    with final_pdf.open("xb") as target:
        target.write(built_pdf_bytes)
        target.flush()
        final_pdf_identity = _object_identity(os.fstat(target.fileno()))
    final_pdf_resolved = final_pdf
    final_pdf_size = len(built_pdf_bytes)
    _verify_final_pdf_unchanged(
        final_pdf,
        expected_resolved=final_pdf_resolved,
        expected_identity=final_pdf_identity,
        expected_size=final_pdf_size,
        expected_sha256=pdf_sha256,
    )

    _verify_snapshot(paper_root, input_records, "source")
    _verify_snapshot(work_dir, input_records, "copied")
    source_rechecks += 1
    _verify_runtime_dependencies_unchanged(stable_runtime_files)
    runtime_rechecks += 1
    _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
    _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
    _verify_tool_unchanged("initexmf", initexmf_executable, initexmf_tool)
    tool_rechecks += 1
    git_subject_claim = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    if git_subject_claim != git_subject:
        raise BuildError("Git subject verification changed before claim construction")
    git_rechecks += 1
    external_runtime_roots_claim = _discover_miktex_runtime_roots(
        recorder,
        pdflatex_executable=pdflatex_executable,
        initexmf_executable=initexmf_executable,
        initexmf_record=initexmf_tool,
    )
    if external_runtime_roots_claim != external_runtime_roots:
        raise BuildError("MiKTeX runtime roots changed during the build")
    root_rechecks += 1

    runtime_records = [
        runtime_file.public_record() for runtime_file in runtime_union.values()
    ]
    work_runtime_records = [
        record for record in runtime_records if record["root_role"] == "work"
    ]
    repository_runtime_records = [
        record for record in runtime_records if record["root_role"] == "repository"
    ]
    external_runtime_records = [
        record
        for record in runtime_records
        if record["root_role"] in MIKTEX_RUNTIME_ROOT_ROLES
    ]
    all_runtime_passes_parsed = len(runtime_passes) == post_bibtex_passes + 1
    pdflatex_recorder_input_closure_verified = (
        expected is not None
        and all_runtime_passes_parsed
        and source_rechecks >= 2
        and tool_rechecks >= 2
        and git_rechecks >= 2
        and runtime_rechecks >= 2
        and root_rechecks >= 1
    )

    release_timestamp = (
        dt.datetime.fromtimestamp(SOURCE_DATE_EPOCH, tz=dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    receipt = {
        "build": {
            "automatic_miktex_install_disabled": is_miktex,
            "combined_output": {
                "concatenation": "raw stdout+stderr bytes in command order",
                "path": "combined_subprocess_output.log",
                "private_command_outputs_excluded": ["initexmf-private-root-report"],
                "privacy_class": "local_diagnostic_may_contain_host_paths",
                "sha256": recorder.output_hash.hexdigest(),
                "size_bytes": recorder.output_size,
            },
            "commands": recorder.commands,
            "environment_controls": {
                "fixed": FIXED_ENVIRONMENT,
                "scrubbed_caller_variables": list(SCRUBBED_TEX_ENVIRONMENT_VARIABLES),
            },
            "fixed_environment": FIXED_ENVIRONMENT,
            "post_bibtex_latex_passes": post_bibtex_passes,
            "release_timestamp_utc": release_timestamp,
            "stable_output_tree_sha256": stable_fingerprint,
        },
        "final_pdf": {
            "page_count": _informational_pdf_page_count(final_pdf),
            "page_count_evidence_class": "informational_non_gating",
            "page_count_method": "count of uncompressed /Type /Page PDF dictionaries",
            "path": "main.pdf",
            "sha256": pdf_sha256,
            "size_bytes": final_pdf_size,
        },
        "input_tree": {
            "canonical_path_prefix": CANONICAL_PAPER_PREFIX,
            "file_count": len(input_records),
            "files": input_records,
            "hash_algorithm": (
                "sha256(concat(sorted(path<TAB>size_bytes<TAB>sha256<LF>)))"
            ),
            "sha256": input_tree_sha256,
        },
        "schema_name": "lifeline-iclr-paper-build-receipt",
        "schema_version": 3,
        "scope_claims": {
            "author_approval_verified": False,
            "bibtex_runtime_input_closure_verified": False,
            "build_tool_source_commit_binding_verified": (
                "blob_oid" in git_subject["build_tool_source"]
            ),
            "exact_pdf_reproduction_verified": expected is not None,
            "expected_pdf_sha256": expected,
            "scientific_claims_verified": False,
            "submission_readiness_verified": False,
            "subject_fixed_paper_inputs_verified": True,
            "subject_checkout_identity_verified": True,
            "subject_checkout_identity_verified_scope": (
                "nine_fixed_paper_inputs_only"
            ),
            "pdflatex_recorder_input_closure_verified": (
                pdflatex_recorder_input_closure_verified
            ),
            "pdflatex_recorder_input_closure_verified_scope": (
                "pdflatex_recorder_INPUT_rows_across_every_latex_pass"
            ),
            "tex_runtime_dependency_closure_verified": False,
            "tex_runtime_dependency_closure_verified_scope": (
                "complete_pdflatex_and_bibtex_runtime_input_closure_not_verified"
            ),
        },
        "subject": {
            "commit": commit,
            "identifier_source": "explicit command-line arguments",
            "tree": tree,
            "verification": git_subject,
        },
        "tex_runtime": {
            "all_latex_passes_parsed": all_runtime_passes_parsed,
            "approved_external_root_roles": list(MIKTEX_RUNTIME_ROOT_ROLES),
            "canonical_runtime_tree": _runtime_tree(runtime_records),
            "external_input_tree": _runtime_tree(external_runtime_records),
            "input_union_semantics": (
                "unique_root_role_plus_relative_path_with_last_observed_work_"
                "generated_bytes_and_exact_per_pass_trees"
            ),
            "passes": runtime_passes,
            "raw_artifact_policy": {
                "archive_eligibility": "excluded_local_only",
                "file_count": 2 * len(runtime_passes),
                "files": [
                    artifact["path"]
                    for runtime_pass in runtime_passes
                    for artifact in (
                        runtime_pass["raw_fls"],
                        runtime_pass["raw_log"],
                    )
                ],
                "privacy_class": "local_diagnostic_may_contain_host_paths",
                "reason": "raw TeX recorder and log paths may identify the host",
            },
            "repository_input_tree": _runtime_tree(repository_runtime_records),
            "root_discovery": {
                "command": ["initexmf", "--disable-installer", "--report"],
                "private_report_persisted": False,
                "required_report_roles": ["UserInstall", "UserData"],
            },
            "verification_rechecks_completed_before_claim": {
                "git_subject": git_rechecks,
                "miktex_roots": root_rechecks,
                "runtime_dependencies": runtime_rechecks,
                "source_and_copied_inputs": source_rechecks,
                "tool_executables": tool_rechecks,
            },
            "work_input_tree": _runtime_tree(work_runtime_records),
        },
        "tools": {
            "bibtex": bibtex_tool,
            "initexmf": initexmf_tool,
            "pdflatex": pdflatex_tool,
        },
    }
    _assert_receipt_has_no_private_paths(
        receipt,
        (
            paper_root,
            output_root,
            Path(__file__),
            pdflatex_executable,
            bibtex_executable,
            initexmf_executable,
            *(root.path for root in external_runtime_roots),
        ),
    )
    _verify_snapshot(paper_root, input_records, "source")
    _verify_snapshot(work_dir, input_records, "copied")
    _verify_runtime_dependencies_unchanged(stable_runtime_files)
    _verify_plain_directory_identity(
        output_root, output_root_identity, "output directory"
    )
    _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
    _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
    _verify_tool_unchanged("initexmf", initexmf_executable, initexmf_tool)
    external_runtime_roots_final = _discover_miktex_runtime_roots(
        recorder,
        pdflatex_executable=pdflatex_executable,
        initexmf_executable=initexmf_executable,
        initexmf_record=initexmf_tool,
    )
    if external_runtime_roots_final != external_runtime_roots:
        raise BuildError("MiKTeX runtime roots changed before receipt write")
    _verify_final_pdf_unchanged(
        final_pdf,
        expected_resolved=final_pdf_resolved,
        expected_identity=final_pdf_identity,
        expected_size=final_pdf_size,
        expected_sha256=pdf_sha256,
    )
    git_subject_final = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    if git_subject_final != git_subject:
        raise BuildError("Git subject verification changed before receipt write")
    recorded_command_count = len(recorder.commands)
    canonical_receipt_bytes = _canonical_json_bytes(receipt)
    receipt_path = output_root / "build_receipt.json"
    with receipt_path.open("xb") as handle:
        handle.write(canonical_receipt_bytes)
        handle.flush()
        receipt_identity = _object_identity(os.fstat(handle.fileno()))
    receipt_resolved = receipt_path
    try:
        _verify_plain_directory_identity(
            output_root, output_root_identity, "output directory"
        )
        _verify_written_receipt(
            receipt_path,
            canonical_receipt_bytes,
            expected_resolved=receipt_resolved,
            expected_identity=receipt_identity,
        )
        _verify_final_pdf_unchanged(
            final_pdf,
            expected_resolved=final_pdf_resolved,
            expected_identity=final_pdf_identity,
            expected_size=final_pdf_size,
            expected_sha256=pdf_sha256,
        )
        _verify_snapshot(paper_root, input_records, "source")
        _verify_snapshot(work_dir, input_records, "copied")
        _verify_runtime_dependencies_unchanged(stable_runtime_files)
        _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
        _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
        _verify_tool_unchanged("initexmf", initexmf_executable, initexmf_tool)
        git_subject_after_receipt = _verify_git_subject(
            paper_root,
            commit,
            tree,
            timeout_seconds=timeout_seconds,
        )
        if git_subject_after_receipt != git_subject:
            raise BuildError("Git subject verification changed after receipt write")
        external_runtime_roots_after_receipt = _discover_miktex_runtime_roots(
            recorder,
            pdflatex_executable=pdflatex_executable,
            initexmf_executable=initexmf_executable,
            initexmf_record=initexmf_tool,
            record_command=False,
        )
        if external_runtime_roots_after_receipt != external_runtime_roots:
            raise BuildError("MiKTeX runtime roots changed after receipt write")
        if len(recorder.commands) != recorded_command_count:
            raise BuildError("post-write private root check polluted public commands")
        _verify_final_pdf_unchanged(
            final_pdf,
            expected_resolved=final_pdf_resolved,
            expected_identity=final_pdf_identity,
            expected_size=final_pdf_size,
            expected_sha256=pdf_sha256,
        )
        _verify_written_receipt(
            receipt_path,
            canonical_receipt_bytes,
            expected_resolved=receipt_resolved,
            expected_identity=receipt_identity,
        )
        _verify_plain_directory_identity(
            output_root, output_root_identity, "output directory"
        )
    except (BuildError, OSError):
        try:
            receipt_path.unlink()
        except OSError as cleanup_error:
            raise BuildError(
                "post-write verification failed and the receipt could not be removed"
            ) from cleanup_error
        raise
    return receipt_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--paper-dir", type=Path, default=Path(__file__).resolve().parent
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--subject-commit", required=True)
    parser.add_argument("--subject-tree", required=True)
    parser.add_argument("--expected-pdf-sha256")
    parser.add_argument("--max-post-bibtex-passes", type=int, default=6)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        receipt = build_paper(
            paper_dir=args.paper_dir,
            output_dir=args.output_dir,
            subject_commit=args.subject_commit,
            subject_tree=args.subject_tree,
            expected_pdf_sha256=args.expected_pdf_sha256,
            max_post_bibtex_passes=args.max_post_bibtex_passes,
            timeout_seconds=args.timeout_seconds,
        )
    except (BuildError, OSError) as exc:
        print(f"paper build failed: {exc}", file=sys.stderr)
        return 2
    print(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
