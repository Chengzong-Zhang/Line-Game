from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import stat
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import build_supplement_candidate as builder  # noqa: E402
import derive_claim_complete_payload as derivation  # noqa: E402
import verify_claim_complete as claim_verifier  # noqa: E402


SCHEMA_VERSION = 1
STATUS = builder.STATUS
APPROVAL = derivation.APPROVAL
ANONYMITY_STATUS = "anonymity_coverage_not_established"
ARCHIVE_ROOT = "lifeline_rl_claim_complete_candidate"
ARCHIVE_NAME = f"{ARCHIVE_ROOT}.zip"
ARCHIVE_RECEIPT_NAME = "ARCHIVE_RECEIPT.json"
EXTRACTION_RECEIPT_NAME = "EXTRACTION_RECEIPT.json"
ARCHIVE_FORMAT = "zip_stored_deterministic_v1"
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
FILE_MODE = stat.S_IFREG | 0o644
FILE_EXTERNAL_ATTR = FILE_MODE << 16
ZIP_VERSION = 20
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_ARCHIVE_OVERHEAD_BYTES = 8 * 1024 * 1024
OWNER_MARKER_NAME = ".claim-complete-archive-owner"
EOCD = struct.Struct("<4s4H2LH")
EOCD_SIGNATURE = b"PK\x05\x06"
DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")
WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


class ArchiveError(RuntimeError):
    """Fail-closed deterministic archive or extraction error."""


@dataclass(frozen=True)
class ArchiveInspection:
    documents: Mapping[str, bytes]
    archive_sha256: str
    archive_size_bytes: int
    tree_sha256: str
    total_uncompressed_bytes: int


@dataclass(frozen=True)
class WorkflowFileSnapshot:
    label: str
    path: Path
    limit: int
    data: bytes
    public_binding: str | None


@dataclass(frozen=True)
class WorkflowSnapshot:
    files: tuple[WorkflowFileSnapshot, ...]
    public_bindings: tuple[tuple[str, str], ...]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _plain_file_bytes(path: Path, label: str, limit: int) -> bytes:
    try:
        return builder._require_plain_file(path, label, limit)
    except builder.CandidateError as exc:
        raise ArchiveError(str(exc)) from exc


def _capture_workflow_snapshot(
    identity_file: Path,
    profile_path: Path,
    allowlist_path: Path,
) -> WorkflowSnapshot:
    specs = (
        (
            "identity terms file",
            identity_file,
            builder.MAX_IDENTITY_FILE_BYTES,
            None,
        ),
        (
            "claim-complete profile",
            profile_path,
            builder.HARD_MAX_FILE_BYTES,
            "profile_sha256",
        ),
        (
            "claim-complete allowlist",
            allowlist_path,
            builder.HARD_MAX_FILE_BYTES,
            "allowlist_sha256",
        ),
        (
            "archive tool",
            Path(__file__),
            builder.HARD_MAX_FILE_BYTES,
            "archive_tool_sha256",
        ),
        (
            "candidate builder and scanner",
            Path(builder.__file__),
            builder.HARD_MAX_FILE_BYTES,
            "builder_scanner_sha256",
        ),
        (
            "claim-complete derivation tool",
            Path(derivation.__file__),
            builder.HARD_MAX_FILE_BYTES,
            "derivation_tool_sha256",
        ),
        (
            "claim-complete verifier",
            Path(claim_verifier.__file__),
            builder.HARD_MAX_FILE_BYTES,
            "claim_verifier_sha256",
        ),
    )
    files: list[WorkflowFileSnapshot] = []
    public_bindings: list[tuple[str, str]] = []
    for label, path, limit, public_binding in specs:
        absolute = Path(path).absolute()
        data = _plain_file_bytes(absolute, label, limit)
        files.append(WorkflowFileSnapshot(label, absolute, limit, data, public_binding))
        if public_binding is not None:
            public_bindings.append((public_binding, _sha256(data)))
    return WorkflowSnapshot(tuple(files), tuple(public_bindings))


def _assert_workflow_snapshot_unchanged(snapshot: WorkflowSnapshot) -> None:
    for item in snapshot.files:
        current = _plain_file_bytes(item.path, item.label, item.limit)
        if current != item.data:
            raise ArchiveError(f"{item.label} changed during the archive workflow")


def _validate_plain_directory_chain(path: Path, label: str) -> Path:
    absolute = path.absolute()
    chain = [absolute]
    while chain[-1].parent != chain[-1]:
        chain.append(chain[-1].parent)
    for directory in reversed(chain):
        if not directory.exists() and not directory.is_symlink():
            raise ArchiveError(f"{label} has a missing ancestor: {directory}")
        try:
            info = os.lstat(directory)
            is_reparse = builder._is_reparse(directory)
        except OSError as exc:
            raise ArchiveError(
                f"{label} ancestor cannot be inspected safely: {directory}"
            ) from exc
        if is_reparse or not stat.S_ISDIR(info.st_mode):
            raise ArchiveError(
                f"{label} ancestor must be a plain directory: {directory}"
            )
    return absolute


def _validate_new_directory(path: Path, label: str) -> Path:
    target = path.absolute()
    if target.exists() or target.is_symlink():
        raise ArchiveError(f"{label} already exists; overwrite is forbidden")
    _validate_plain_directory_chain(target.parent, f"{label} parent")
    return target


def _require_disjoint_output(
    output: Path,
    protected_root: Path,
    output_label: str,
    protected_label: str,
) -> None:
    try:
        protected = protected_root.absolute().resolve(strict=True)
        target = output.parent.resolve(strict=True) / output.name
    except OSError as exc:
        raise ArchiveError(
            f"cannot resolve {output_label} and {protected_label} safely"
        ) from exc
    if (
        target == protected
        or target in protected.parents
        or protected in target.parents
    ):
        raise ArchiveError(
            f"{output_label} must not overlap the {protected_label} tree"
        )


def _mkdir_owned_staging(staging: Path) -> None:
    if os.name == "nt":
        staging.mkdir()
    else:
        staging.mkdir(mode=0o700)


def _create_owned_staging(output: Path) -> tuple[Path, str]:
    parent = _validate_plain_directory_chain(
        output.parent, "archive-workflow staging parent"
    )
    token = secrets.token_hex(32)
    for _attempt in range(32):
        staging = parent / f".{output.name}.staging-{secrets.token_hex(16)}"
        try:
            _mkdir_owned_staging(staging)
        except FileExistsError:
            continue
        try:
            builder._write_exclusive(
                staging, OWNER_MARKER_NAME, f"{token}\n".encode("ascii")
            )
        except Exception:
            try:
                staging.rmdir()
            except OSError:
                pass
            raise
        return staging, token
    raise ArchiveError("could not allocate a unique owned staging directory")


def _assert_owned_directory(
    path: Path, expected_parent: Path, owner_token: str
) -> Path:
    absolute = path.absolute()
    parent = _validate_plain_directory_chain(
        expected_parent, "archive-workflow owned-directory parent"
    )
    if absolute.parent != parent:
        raise ArchiveError("refusing archive-workflow directory outside its parent")
    if not absolute.exists() and not absolute.is_symlink():
        raise ArchiveError("archive-workflow owned directory is missing")
    try:
        info = os.lstat(absolute)
        is_reparse = builder._is_reparse(absolute)
    except OSError as exc:
        raise ArchiveError(
            "archive-workflow owned directory cannot be inspected safely"
        ) from exc
    if is_reparse or not stat.S_ISDIR(info.st_mode):
        raise ArchiveError("archive-workflow owned directory is not a plain directory")
    marker = _plain_file_bytes(
        absolute / OWNER_MARKER_NAME,
        "archive-workflow ownership marker",
        256,
    )
    if marker != f"{owner_token}\n".encode("ascii"):
        raise ArchiveError("archive-workflow ownership marker mismatch")
    return absolute


def _cleanup_owned_directory(
    path: Path, expected_parent: Path, owner_token: str
) -> None:
    if not path.exists() and not path.is_symlink():
        return
    absolute = _assert_owned_directory(path, expected_parent, owner_token)
    before = os.lstat(absolute)
    _assert_owned_directory(absolute, expected_parent, owner_token)
    after = os.lstat(absolute)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise ArchiveError("archive-workflow cleanup target changed during validation")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ArchiveError(
            "automatic recursive cleanup is not symlink-safe on this runtime; "
            f"the owner-marked directory was retained for manual review: {absolute}"
        )
    shutil.rmtree(absolute)


def _cleanup_after_error(
    path: Path,
    expected_parent: Path,
    owner_token: str,
    original: Exception,
) -> None:
    try:
        _cleanup_owned_directory(path, expected_parent, owner_token)
    except ArchiveError as cleanup_error:
        raise ArchiveError(
            f"{original}; automatic cleanup was refused: {cleanup_error}"
        ) from original


def _verify_owned_top_level(
    root: Path,
    expected_parent: Path,
    owner_token: str,
    expected_files: set[str],
    expected_directories: set[str],
) -> None:
    absolute = _assert_owned_directory(root, expected_parent, owner_token)
    observed_files: set[str] = set()
    observed_directories: set[str] = set()
    with os.scandir(absolute) as iterator:
        for entry in iterator:
            path = Path(entry.path)
            if entry.is_symlink() or builder._is_reparse(path):
                raise ArchiveError(
                    f"archive-workflow output contains a reparse point: {entry.name}"
                )
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                observed_files.add(entry.name)
            elif stat.S_ISDIR(info.st_mode):
                observed_directories.add(entry.name)
            else:
                raise ArchiveError(
                    f"archive-workflow output contains a special file: {entry.name}"
                )
    if observed_files != expected_files | {OWNER_MARKER_NAME}:
        raise ArchiveError("archive-workflow output top-level file set drifted")
    if observed_directories != expected_directories:
        raise ArchiveError("archive-workflow output top-level directory set drifted")


def _publish_owned_staging(
    staging: Path,
    output: Path,
    owner_token: str,
    final_verifier: Any,
) -> None:
    parent = output.parent
    published = False
    owned_path = staging
    try:
        _validate_new_directory(output, "archive-workflow publication directory")
        _assert_owned_directory(staging, parent, owner_token)
        try:
            _rename_directory_noreplace(staging, output)
        except OSError as exc:
            raise ArchiveError(
                "could not publish the verified staging directory without overwrite"
            ) from exc
        published = True
        owned_path = output
        _assert_owned_directory(output, parent, owner_token)
        final_verifier(output)
        (output / OWNER_MARKER_NAME).unlink()
    except Exception as exc:
        if owned_path.exists() or owned_path.is_symlink():
            _cleanup_after_error(owned_path, parent, owner_token, exc)
        raise
    if not published:
        raise ArchiveError("verified staging directory was not published")


def _rename_directory_noreplace(source: Path, target: Path) -> None:
    """Atomically rename a directory while refusing an existing target."""

    source_bytes = os.fsencode(source)
    target_bytes = os.fsencode(target)
    if os.name == "nt":
        # MoveFileEx without MOVEFILE_REPLACE_EXISTING is the behavior exposed
        # by os.rename on Windows.
        os.rename(source, target)
        return
    if sys.platform.startswith("linux"):
        renameat2 = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
        if renameat2 is None:
            raise ArchiveError(
                "atomic no-overwrite directory publication is unavailable"
            )
        renameat2.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        renameat2.restype = ctypes.c_int
        if renameat2(-100, source_bytes, -100, target_bytes, 1) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(target))
        return
    if sys.platform == "darwin":
        renamex_np = getattr(ctypes.CDLL(None, use_errno=True), "renamex_np", None)
        if renamex_np is None:
            raise ArchiveError(
                "atomic no-overwrite directory publication is unavailable"
            )
        renamex_np.argtypes = (
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        renamex_np.restype = ctypes.c_int
        if renamex_np(source_bytes, target_bytes, 0x00000004) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), str(target))
        return
    raise ArchiveError("atomic no-overwrite directory publication is unavailable")


def _validate_ascii_archive_name(name: str) -> tuple[str, ...]:
    if not name or "\x00" in name or "\\" in name:
        raise ArchiveError(
            "archive member name is empty, NUL-bearing, or uses backslashes"
        )
    try:
        name.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ArchiveError(
            "archive member names must use the frozen ASCII path profile"
        ) from exc
    if name.startswith("/") or name.startswith("//") or DRIVE_PREFIX_RE.match(name):
        raise ArchiveError(
            f"archive member path is absolute or drive-qualified: {name}"
        )
    pure = PurePosixPath(name)
    parts = pure.parts
    if pure.as_posix() != name or len(parts) < 2:
        raise ArchiveError(f"archive member path is non-canonical: {name}")
    for part in parts:
        if (
            part in {"", ".", ".."}
            or part.endswith((" ", "."))
            or ":" in part
            or any(ord(char) < 32 or ord(char) == 127 for char in part)
        ):
            raise ArchiveError(f"archive member path has an unsafe segment: {name}")
        stem = part.split(".", 1)[0].casefold()
        if stem in WINDOWS_RESERVED_NAMES:
            raise ArchiveError(f"archive member path uses a reserved name: {name}")
    if parts[0] != ARCHIVE_ROOT:
        raise ArchiveError(f"archive member is outside the fixed root: {name}")
    return parts


def _tree_sha256(documents: Mapping[str, bytes]) -> str:
    rows = b"".join(
        (
            f"{relative}\t{len(documents[relative])}\t{_sha256(documents[relative])}\n"
        ).encode("ascii")
        for relative in sorted(documents)
    )
    return _sha256(rows)


def _zip_info(member_name: str) -> zipfile.ZipInfo:
    _validate_ascii_archive_name(member_name)
    info = zipfile.ZipInfo(member_name, date_time=FIXED_DATE_TIME)
    info.compress_type = zipfile.ZIP_STORED
    info.comment = b""
    info.extra = b""
    info.create_system = 3
    info.create_version = ZIP_VERSION
    info.extract_version = ZIP_VERSION
    info.reserved = 0
    info.flag_bits = 0
    info.volume = 0
    info.internal_attr = 0
    info.external_attr = FILE_EXTERNAL_ATTR
    return info


def _canonical_archive_bytes(documents: Mapping[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(
        buffer,
        mode="w",
        compression=zipfile.ZIP_STORED,
        allowZip64=False,
        strict_timestamps=True,
    ) as archive:
        archive.comment = b""
        for relative in sorted(documents):
            member_name = f"{ARCHIVE_ROOT}/{relative}"
            archive.writestr(
                _zip_info(member_name),
                documents[relative],
                compress_type=zipfile.ZIP_STORED,
            )
    return buffer.getvalue()


def _preflight_eocd(archive_bytes: bytes, expected_member_count: int) -> None:
    if len(archive_bytes) < EOCD.size:
        raise ArchiveError("archive is too short to contain a canonical ZIP EOCD")
    (
        signature,
        disk_number,
        central_directory_disk,
        entries_on_disk,
        total_entries,
        central_directory_size,
        central_directory_offset,
        comment_size,
    ) = EOCD.unpack(archive_bytes[-EOCD.size :])
    if signature != EOCD_SIGNATURE or comment_size != 0:
        raise ArchiveError("archive EOCD or comment differs from the frozen profile")
    if (
        entries_on_disk == 0xFFFF
        or total_entries == 0xFFFF
        or central_directory_size == 0xFFFFFFFF
        or central_directory_offset == 0xFFFFFFFF
    ):
        raise ArchiveError("ZIP64 archives are forbidden")
    if disk_number != 0 or central_directory_disk != 0:
        raise ArchiveError("multi-disk archives are forbidden")
    if (
        entries_on_disk != expected_member_count
        or total_entries != expected_member_count
    ):
        raise ArchiveError("archive EOCD entry count differs from the allowlist")
    if central_directory_offset + central_directory_size + EOCD.size != len(
        archive_bytes
    ):
        raise ArchiveError("archive central-directory bounds are non-canonical")


def _verify_documents_in_memory(
    documents: Mapping[str, bytes],
    config: builder.AllowlistConfig,
    identity: builder.IdentityProfile,
) -> dict[str, Any]:
    expected_paths = builder._expected_paths(config)
    observed_paths = set(documents)
    if observed_paths != expected_paths:
        raise ArchiveError(
            "archive file set differs from the allowlist "
            f"(missing={sorted(expected_paths - observed_paths)}, "
            f"extra={sorted(observed_paths - expected_paths)})"
        )
    total_bytes = 0
    for relative, data in documents.items():
        if len(data) > config.max_file_bytes:
            raise ArchiveError(
                f"archive member exceeds the configured size limit: {relative}"
            )
        total_bytes += len(data)
    if total_bytes > config.max_total_bytes:
        raise ArchiveError("archive members exceed the configured total-size limit")

    for entry in config.files:
        if _sha256(documents[entry.destination]) != entry.expected_sha256:
            raise ArchiveError(f"archive payload hash mismatch: {entry.destination}")

    expected_readme = builder._readme_bytes(config)
    expected_tree = builder._tree_bytes(config)
    if documents[builder.README_NAME] != expected_readme:
        raise ArchiveError("archive README does not match the deterministic template")
    if documents[builder.TREE_NAME] != expected_tree:
        raise ArchiveError("archive candidate tree does not match the allowlist")

    expected_manifest = builder._manifest_object(
        config,
        {
            **{
                entry.destination: documents[entry.destination]
                for entry in config.files
            },
            builder.README_NAME: expected_readme,
            builder.TREE_NAME: expected_tree,
        },
    )
    expected_manifest_bytes = builder._canonical_json_bytes(expected_manifest)
    if documents[builder.MANIFEST_NAME] != expected_manifest_bytes:
        raise ArchiveError("archive manifest does not match recomputed canonical bytes")

    scan_inputs = [
        (relative, data)
        for relative, data in documents.items()
        if relative != builder.SCAN_NAME
    ]
    expected_scan = builder._scan_documents(scan_inputs, identity)
    try:
        builder._raise_for_scan(expected_scan, "archive")
    except builder.CandidateError as exc:
        raise ArchiveError(str(exc)) from exc
    expected_scan_bytes = builder._canonical_json_bytes(expected_scan)
    if documents[builder.SCAN_NAME] != expected_scan_bytes:
        raise ArchiveError(
            "archive privacy receipt does not match a fresh canonical scan"
        )

    return {
        "file_count": len(documents),
        "total_bytes": total_bytes,
        "manifest_file_count": expected_manifest["file_count"],
        "manifest_total_bytes": expected_manifest["total_bytes"],
        "privacy_scan": expected_scan["status"],
    }


def _candidate_documents(
    candidate: Path,
    allowlist_path: Path,
    identity_file: Path,
) -> tuple[builder.AllowlistConfig, builder.IdentityProfile, dict[str, bytes]]:
    config = builder.load_allowlist(allowlist_path)
    identity = builder.load_identity_profile(identity_file)
    builder.verify_candidate(candidate, allowlist_path, identity_file)
    files, _directories = builder._walk_candidate(candidate.absolute())
    documents = {
        relative: _plain_file_bytes(
            path,
            f"candidate file {relative}",
            config.max_file_bytes,
        )
        for relative, path in files.items()
    }
    _verify_documents_in_memory(documents, config, identity)
    return config, identity, documents


def _assert_candidate_snapshot_matches(
    initial_config: builder.AllowlistConfig,
    initial_identity: builder.IdentityProfile,
    initial_documents: Mapping[str, bytes],
    observed_config: builder.AllowlistConfig,
    observed_identity: builder.IdentityProfile,
    observed_documents: Mapping[str, bytes],
    label: str,
) -> None:
    if (
        observed_config != initial_config
        or observed_identity != initial_identity
        or observed_documents != initial_documents
    ):
        raise ArchiveError(f"{label} differs from the verified byte snapshot")


def _inspect_archive_bytes(
    archive_bytes: bytes,
    config: builder.AllowlistConfig,
    identity: builder.IdentityProfile,
) -> ArchiveInspection:
    expected_relatives = builder._expected_paths(config)
    expected_members = {f"{ARCHIVE_ROOT}/{relative}" for relative in expected_relatives}
    _preflight_eocd(archive_bytes, len(expected_members))
    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
            if archive.comment != b"":
                raise ArchiveError("archive comment must be empty")
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ArchiveError("archive contains duplicate member names")
            folded_names = [name.casefold() for name in names]
            if len(folded_names) != len(set(folded_names)):
                raise ArchiveError("archive member names collide after case folding")

            documents: dict[str, bytes] = {}
            observed_members: set[str] = set()
            total_uncompressed = 0
            for info in infos:
                parts = _validate_ascii_archive_name(info.filename)
                if info.is_dir() or info.filename.endswith("/"):
                    raise ArchiveError("archive directory entries are forbidden")
                if info.flag_bits & 0x1:
                    raise ArchiveError("encrypted archive members are forbidden")
                if info.flag_bits != 0:
                    raise ArchiveError(
                        "archive member flags differ from the frozen profile"
                    )
                if (
                    info.date_time != FIXED_DATE_TIME
                    or info.compress_type != zipfile.ZIP_STORED
                    or info.comment != b""
                    or info.extra != b""
                    or info.create_system != 3
                    or info.create_version != ZIP_VERSION
                    or info.extract_version != ZIP_VERSION
                    or info.reserved != 0
                    or info.volume != 0
                    or info.internal_attr != 0
                    or info.external_attr != FILE_EXTERNAL_ATTR
                ):
                    raise ArchiveError(
                        f"archive member metadata drifted: {info.filename}"
                    )
                mode = info.external_attr >> 16
                if stat.S_IFMT(mode) != stat.S_IFREG or stat.S_IMODE(mode) != 0o644:
                    raise ArchiveError(
                        f"archive member is not a fixed-mode regular file: {info.filename}"
                    )
                if (
                    info.file_size > config.max_file_bytes
                    or info.compress_size != info.file_size
                ):
                    raise ArchiveError(
                        f"archive member size or storage mode is invalid: {info.filename}"
                    )
                total_uncompressed += info.file_size
                if total_uncompressed > config.max_total_bytes:
                    raise ArchiveError(
                        "archive total uncompressed size exceeds the limit"
                    )
                try:
                    data = archive.read(info)
                except (
                    RuntimeError,
                    OSError,
                    UnicodeDecodeError,
                    ValueError,
                    NotImplementedError,
                    zipfile.BadZipFile,
                ) as exc:
                    raise ArchiveError(
                        f"archive member cannot be read safely: {info.filename}"
                    ) from exc
                relative = PurePosixPath(*parts[1:]).as_posix()
                documents[relative] = data
                observed_members.add(info.filename)

            if observed_members != expected_members:
                raise ArchiveError(
                    "archive member set differs from the fixed-root allowlist "
                    f"(missing={sorted(expected_members - observed_members)}, "
                    f"extra={sorted(observed_members - expected_members)})"
                )
            corrupt = archive.testzip()
            if corrupt is not None:
                raise ArchiveError(f"archive CRC verification failed: {corrupt}")
    except (
        UnicodeDecodeError,
        ValueError,
        NotImplementedError,
        zipfile.BadZipFile,
    ) as exc:
        raise ArchiveError("archive ZIP metadata cannot be parsed safely") from exc

    _verify_documents_in_memory(documents, config, identity)
    canonical = _canonical_archive_bytes(documents)
    if canonical != archive_bytes:
        raise ArchiveError(
            "archive bytes differ from the canonical deterministic encoding"
        )
    return ArchiveInspection(
        documents=documents,
        archive_sha256=_sha256(archive_bytes),
        archive_size_bytes=len(archive_bytes),
        tree_sha256=_tree_sha256(documents),
        total_uncompressed_bytes=total_uncompressed,
    )


def _read_and_inspect_archive(
    archive_path: Path,
    config: builder.AllowlistConfig,
    identity: builder.IdentityProfile,
) -> tuple[bytes, ArchiveInspection]:
    limit = config.max_total_bytes + MAX_ARCHIVE_OVERHEAD_BYTES
    archive_bytes = _plain_file_bytes(archive_path, "claim-complete archive", limit)
    return archive_bytes, _inspect_archive_bytes(archive_bytes, config, identity)


def _same_json_type_and_value(observed: Any, expected: Any) -> bool:
    if type(observed) is not type(expected):
        return False
    if isinstance(expected, list):
        return len(observed) == len(expected) and all(
            _same_json_type_and_value(left, right)
            for left, right in zip(observed, expected, strict=True)
        )
    if isinstance(expected, dict):
        return set(observed) == set(expected) and all(
            _same_json_type_and_value(observed[key], value)
            for key, value in expected.items()
        )
    return observed == expected


def _verification_summary(result: Mapping[str, Any]) -> dict[str, Any]:
    required = {
        "status": "PASS",
        "candidate_status": STATUS,
        "approval": APPROVAL,
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
    }
    for key, expected in required.items():
        if not _same_json_type_and_value(result.get(key), expected):
            raise ArchiveError(f"claim-complete verifier result drifted at {key}")
    counts: dict[str, int] = {}
    for key in ("file_count", "manifest_file_count", "manifest_total_bytes"):
        observed = result.get(key)
        if type(observed) is not int or observed < 0:
            raise ArchiveError(f"claim-complete verifier result drifted at {key}")
        counts[key] = observed
    return {
        **required,
        **counts,
    }


def _archive_receipt(
    archive_bytes: bytes,
    inspection: ArchiveInspection,
    config: builder.AllowlistConfig,
    workflow_snapshot: WorkflowSnapshot,
    verification_result: Mapping[str, Any],
) -> dict[str, Any]:
    summary = _verification_summary(verification_result)
    documents = inspection.documents
    manifest = builder._strict_json_from_bytes(
        documents[builder.MANIFEST_NAME],
        "verified candidate manifest must be valid UTF-8 JSON",
    )
    if (
        not isinstance(manifest, dict)
        or summary["file_count"] != len(documents)
        or summary["manifest_file_count"] != manifest.get("file_count")
        or summary["manifest_total_bytes"] != manifest.get("total_bytes")
    ):
        raise ArchiveError(
            "claim-complete verifier counts differ from archive contents"
        )
    public_bindings = dict(workflow_snapshot.public_bindings)
    if public_bindings.get("allowlist_sha256") != config.raw_sha256:
        raise ArchiveError("allowlist changed between parsing and workflow snapshot")
    return {
        "schema_version": SCHEMA_VERSION,
        "status": STATUS,
        "approval": APPROVAL,
        "anonymity_coverage": ANONYMITY_STATUS,
        "archive": {
            "filename": ARCHIVE_NAME,
            "format": ARCHIVE_FORMAT,
            "root": ARCHIVE_ROOT,
            "sha256": _sha256(archive_bytes),
            "size_bytes": len(archive_bytes),
            "member_count": len(documents),
            "total_uncompressed_bytes": inspection.total_uncompressed_bytes,
            "tree_sha256": inspection.tree_sha256,
            "compression": "stored",
            "fixed_member_timestamp": "1980-01-01T00:00:00",
            "regular_file_mode": "0644",
        },
        "bindings": {
            **public_bindings,
            "manifest_sha256": _sha256(documents[builder.MANIFEST_NAME]),
            "privacy_scan_sha256": _sha256(documents[builder.SCAN_NAME]),
        },
        "verification": summary,
        "claims": {
            "author_approved": False,
            "anonymity_coverage_established": False,
            "clean_install_verified": False,
            "final_archive": False,
            "submission_ready": False,
        },
        "scope": (
            "Deterministic candidate archive integrity and safe extraction only; "
            "real identity coverage, author approval, clean installation, and "
            "submission readiness remain outside this receipt."
        ),
    }


def _load_receipt(path: Path) -> tuple[bytes, Any]:
    data = _plain_file_bytes(path, "archive receipt", MAX_RECEIPT_BYTES)
    try:
        value = builder._strict_json_from_bytes(
            data, "archive receipt must be valid UTF-8 JSON"
        )
    except builder.CandidateError as exc:
        raise ArchiveError(str(exc)) from exc
    if data != _canonical_json_bytes(value):
        raise ArchiveError("archive receipt is not canonical UTF-8/LF JSON")
    return data, value


def _extract_documents(output: Path, documents: Mapping[str, bytes]) -> Path:
    candidate = output / ARCHIVE_ROOT
    candidate.mkdir()
    for relative in sorted(documents):
        builder._write_exclusive(candidate, relative, documents[relative])
    return candidate


def build_archive(
    candidate: Path,
    output: Path,
    identity_file: Path,
    source_root: Path,
    profile_path: Path,
    allowlist_path: Path,
) -> dict[str, Any]:
    output = _validate_new_directory(output, "archive output directory")
    _require_disjoint_output(
        output,
        candidate,
        "archive output directory",
        "candidate",
    )
    workflow_snapshot = _capture_workflow_snapshot(
        identity_file, profile_path, allowlist_path
    )
    config, identity, documents = _candidate_documents(
        candidate.absolute(), allowlist_path, identity_file
    )
    _assert_workflow_snapshot_unchanged(workflow_snapshot)
    verification_result = claim_verifier.verify_claim_complete(
        candidate.absolute(),
        identity_file,
        source_root.absolute(),
        profile_path,
        allowlist_path,
    )
    _assert_workflow_snapshot_unchanged(workflow_snapshot)
    final_config, final_identity, final_documents = _candidate_documents(
        candidate.absolute(), allowlist_path, identity_file
    )
    _assert_workflow_snapshot_unchanged(workflow_snapshot)
    _assert_candidate_snapshot_matches(
        config,
        identity,
        documents,
        final_config,
        final_identity,
        final_documents,
        "candidate tree after claim verification",
    )
    archive_bytes = _canonical_archive_bytes(documents)
    inspection = _inspect_archive_bytes(archive_bytes, config, identity)
    receipt = _archive_receipt(
        archive_bytes,
        inspection,
        config,
        workflow_snapshot,
        verification_result,
    )
    receipt_bytes = _canonical_json_bytes(receipt)

    staging: Path | None = None
    owner_token = ""

    def verify_bundle(root: Path) -> None:
        _assert_workflow_snapshot_unchanged(workflow_snapshot)
        _verify_owned_top_level(
            root,
            output.parent,
            owner_token,
            {ARCHIVE_NAME, ARCHIVE_RECEIPT_NAME},
            set(),
        )
        written_archive, written_inspection = _read_and_inspect_archive(
            root / ARCHIVE_NAME, config, identity
        )
        if written_archive != archive_bytes or written_inspection != inspection:
            raise ArchiveError(
                "written archive differs from the verified archive bytes"
            )
        loaded_receipt_bytes, _loaded_receipt = _load_receipt(
            root / ARCHIVE_RECEIPT_NAME
        )
        if loaded_receipt_bytes != receipt_bytes:
            raise ArchiveError("written archive receipt differs from canonical bytes")
        _assert_workflow_snapshot_unchanged(workflow_snapshot)

    staging, owner_token = _create_owned_staging(output)
    try:
        builder._write_exclusive(staging, ARCHIVE_NAME, archive_bytes)
        builder._write_exclusive(staging, ARCHIVE_RECEIPT_NAME, receipt_bytes)
        verify_bundle(staging)
    except Exception as exc:
        if staging.exists() or staging.is_symlink():
            _cleanup_after_error(staging, output.parent, owner_token, exc)
        raise
    _publish_owned_staging(
        staging,
        output,
        owner_token,
        verify_bundle,
    )

    return {
        "status": "PASS",
        "candidate_status": STATUS,
        "approval": APPROVAL,
        "anonymity_coverage": ANONYMITY_STATUS,
        "archive_filename": ARCHIVE_NAME,
        "archive_sha256": inspection.archive_sha256,
        "archive_size_bytes": inspection.archive_size_bytes,
        "archive_receipt_filename": ARCHIVE_RECEIPT_NAME,
        "archive_receipt_sha256": _sha256(receipt_bytes),
        "member_count": len(documents),
        "tree_sha256": inspection.tree_sha256,
        "final_archive": False,
        "submission_ready": False,
    }


def verify_extract_archive(
    archive_path: Path,
    receipt_path: Path,
    output: Path,
    identity_file: Path,
    source_root: Path,
    profile_path: Path,
    allowlist_path: Path,
) -> dict[str, Any]:
    output = _validate_new_directory(output, "extraction output directory")
    workflow_snapshot = _capture_workflow_snapshot(
        identity_file, profile_path, allowlist_path
    )
    config = builder.load_allowlist(allowlist_path)
    identity = builder.load_identity_profile(identity_file)
    receipt_bytes, observed_receipt = _load_receipt(receipt_path)
    archive_bytes, inspection = _read_and_inspect_archive(
        archive_path, config, identity
    )
    _assert_workflow_snapshot_unchanged(workflow_snapshot)
    if not isinstance(observed_receipt, dict):
        raise ArchiveError("archive receipt must be a JSON object")
    archive_binding = observed_receipt.get("archive")
    if (
        not isinstance(archive_binding, dict)
        or type(archive_binding.get("sha256")) is not str
        or archive_binding.get("sha256") != inspection.archive_sha256
        or type(archive_binding.get("size_bytes")) is not int
        or archive_binding.get("size_bytes") != inspection.archive_size_bytes
    ):
        raise ArchiveError("archive receipt hash or size does not bind this archive")

    staging: Path | None = None
    owner_token = ""
    extraction_receipt_bytes = b""

    def verify_extraction_bundle(root: Path) -> None:
        _assert_workflow_snapshot_unchanged(workflow_snapshot)
        _verify_owned_top_level(
            root,
            output.parent,
            owner_token,
            {EXTRACTION_RECEIPT_NAME},
            {ARCHIVE_ROOT},
        )
        final_config, final_identity, final_documents = _candidate_documents(
            root / ARCHIVE_ROOT,
            allowlist_path,
            identity_file,
        )
        _assert_workflow_snapshot_unchanged(workflow_snapshot)
        _assert_candidate_snapshot_matches(
            config,
            identity,
            inspection.documents,
            final_config,
            final_identity,
            final_documents,
            "published extraction tree",
        )
        reloaded_bytes, _reloaded = _load_receipt(root / EXTRACTION_RECEIPT_NAME)
        if reloaded_bytes != extraction_receipt_bytes:
            raise ArchiveError(
                "written extraction receipt differs from canonical bytes"
            )
        _assert_workflow_snapshot_unchanged(workflow_snapshot)

    staging, owner_token = _create_owned_staging(output)
    try:
        extracted_candidate = _extract_documents(staging, inspection.documents)
        base_result = builder.verify_candidate(
            extracted_candidate, allowlist_path, identity_file
        )
        verification_result = claim_verifier.verify_claim_complete(
            extracted_candidate,
            identity_file,
            source_root.absolute(),
            profile_path,
            allowlist_path,
        )
        _assert_workflow_snapshot_unchanged(workflow_snapshot)
        expected_receipt = _archive_receipt(
            archive_bytes,
            inspection,
            config,
            workflow_snapshot,
            verification_result,
        )
        expected_receipt_bytes = _canonical_json_bytes(expected_receipt)
        if receipt_bytes != expected_receipt_bytes:
            raise ArchiveError(
                "archive receipt differs from the fully recomputed receipt"
            )
        extraction_receipt = {
            "schema_version": SCHEMA_VERSION,
            "status": STATUS,
            "approval": APPROVAL,
            "anonymity_coverage": ANONYMITY_STATUS,
            "archive_sha256": inspection.archive_sha256,
            "archive_receipt_sha256": _sha256(receipt_bytes),
            "extracted_root": ARCHIVE_ROOT,
            "file_count": base_result["file_count"],
            "total_uncompressed_bytes": inspection.total_uncompressed_bytes,
            "tree_sha256": inspection.tree_sha256,
            "verification": _verification_summary(verification_result),
            "claims": {
                "author_approved": False,
                "anonymity_coverage_established": False,
                "clean_install_verified": False,
                "final_archive": False,
                "submission_ready": False,
            },
        }
        extraction_receipt_bytes = _canonical_json_bytes(extraction_receipt)
        builder._write_exclusive(
            staging, EXTRACTION_RECEIPT_NAME, extraction_receipt_bytes
        )
        verify_extraction_bundle(staging)
    except Exception as exc:
        if staging.exists() or staging.is_symlink():
            _cleanup_after_error(staging, output.parent, owner_token, exc)
        raise
    _publish_owned_staging(
        staging,
        output,
        owner_token,
        verify_extraction_bundle,
    )

    return {
        "status": "PASS",
        "candidate_status": STATUS,
        "approval": APPROVAL,
        "anonymity_coverage": ANONYMITY_STATUS,
        "archive_sha256": inspection.archive_sha256,
        "archive_receipt_sha256": _sha256(receipt_bytes),
        "extracted_root": ARCHIVE_ROOT,
        "extraction_receipt_filename": EXTRACTION_RECEIPT_NAME,
        "extraction_receipt_sha256": _sha256(extraction_receipt_bytes),
        "file_count": len(inspection.documents),
        "tree_sha256": inspection.tree_sha256,
        "final_archive": False,
        "submission_ready": False,
    }


def _default_source_root() -> Path:
    return TOOL_DIR.parents[2]


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--identity-file", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=_default_source_root())
    parser.add_argument("--profile", type=Path, default=derivation._default_profile())
    parser.add_argument(
        "--allowlist", type=Path, default=derivation._default_allowlist()
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build or safely verify/extract a deterministic claim-complete "
            "candidate-only archive."
        )
    )
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="build a new archive output directory")
    build.add_argument("--candidate", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    _add_common_arguments(build)
    extract = commands.add_parser(
        "verify-extract", help="verify an archive and extract it without extractall"
    )
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--receipt", type=Path, required=True)
    extract.add_argument("--output", type=Path, required=True)
    _add_common_arguments(extract)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build_archive(
                args.candidate,
                args.output,
                args.identity_file,
                args.source_root,
                args.profile,
                args.allowlist,
            )
        else:
            result = verify_extract_archive(
                args.archive,
                args.receipt,
                args.output,
                args.identity_file,
                args.source_root,
                args.profile,
                args.allowlist,
            )
    except (
        ArchiveError,
        builder.CandidateError,
        derivation.DerivationError,
        claim_verifier.VerificationError,
        OSError,
    ) as exc:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "candidate_status": STATUS,
                    "approval": APPROVAL,
                    "anonymity_coverage": ANONYMITY_STATUS,
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
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
