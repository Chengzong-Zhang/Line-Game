from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


OBJECT_ID_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
MAX_SUBJECT_FILE_BYTES = 16 * 1024 * 1024
MAX_SUBJECT_TOTAL_BYTES = 64 * 1024 * 1024
GIT_TIMEOUT_SECONDS = 60
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


class SubjectBindingError(RuntimeError):
    """Fail-closed Git subject verification error."""


@dataclass(frozen=True)
class SubjectBinding:
    commit: str
    tree: str

    def public_fields(self) -> dict[str, str]:
        return {
            "subject_commit": self.commit,
            "subject_tree": self.tree,
        }


@dataclass(frozen=True)
class SubjectFileSnapshot:
    relative: str
    blob_oid: str
    sha256: str
    size_bytes: int
    data: bytes


@dataclass(frozen=True)
class SubjectSnapshot:
    repo_root: Path
    binding: SubjectBinding
    git_executable: Path
    git_executable_sha256: str
    git_executable_size_bytes: int
    files: tuple[SubjectFileSnapshot, ...]
    tool_relatives: tuple[str, ...]

    def public_fields(self) -> dict[str, Any]:
        return {
            **self.binding.public_fields(),
            "subject_binding_verified": True,
            "subject_fixed_input_count": len(self.files),
            "subject_tool_source_count": len(self.tool_relatives),
        }


def parse_subject_binding(commit: Any, tree: Any) -> SubjectBinding:
    if type(commit) is not str or OBJECT_ID_RE.fullmatch(commit) is None:
        raise SubjectBindingError(
            "subject commit must be a full lowercase 40- or 64-hex object id"
        )
    if type(tree) is not str or OBJECT_ID_RE.fullmatch(tree) is None:
        raise SubjectBindingError(
            "subject tree must be a full lowercase 40- or 64-hex object id"
        )
    if len(commit) != len(tree):
        raise SubjectBindingError("subject commit and tree object-id widths differ")
    return SubjectBinding(commit=commit, tree=tree)


def _is_reparse(path: Path) -> bool:
    try:
        metadata = os.lstat(path)
    except OSError:
        return True
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


def _plain_repo_root(path: Path) -> Path:
    try:
        absolute = path.absolute()
        resolved = absolute.resolve(strict=True)
        metadata = os.lstat(absolute)
    except OSError as exc:
        raise SubjectBindingError("subject source root is unavailable") from exc
    if (
        absolute != resolved
        or not stat.S_ISDIR(metadata.st_mode)
        or _is_reparse(absolute)
    ):
        raise SubjectBindingError(
            "subject source root must be a canonical plain directory"
        )
    return resolved


def _safe_relative(value: Any, label: str) -> str:
    if type(value) is not str or not value or "\\" in value or "\x00" in value:
        raise SubjectBindingError(f"{label} must be a non-empty POSIX path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or path.as_posix() != value
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise SubjectBindingError(
            f"{label} is not a canonical repository-relative path"
        )
    if any(part.casefold() == ".git" for part in path.parts):
        raise SubjectBindingError(f"{label} enters forbidden Git metadata")
    return value


def _relative_tool_path(repo_root: Path, path: Path, label: str) -> str:
    try:
        declared = path.absolute()
        resolved = declared.resolve(strict=True)
        relative = resolved.relative_to(repo_root).as_posix()
    except (OSError, ValueError) as exc:
        raise SubjectBindingError(
            f"{label} is not inside the subject source root"
        ) from exc
    if declared != resolved:
        raise SubjectBindingError(f"{label} is not at its canonical repository path")
    return _safe_relative(relative, label)


def canonical_repo_relative(repo_root: Path, path: Path, label: str) -> str:
    """Return a canonical repository-relative path without exposing it publicly."""
    return _relative_tool_path(_plain_repo_root(repo_root), path, label)


def _controlled_git_environment() -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("GIT_")
    }
    environment.update(CONTROLLED_GIT_ENVIRONMENT)
    return environment


def _resolve_git_executable() -> tuple[Path, int, str]:
    git_name = shutil.which("git")
    if git_name is None:
        raise SubjectBindingError("required executable is not on PATH: git")
    try:
        declared = Path(git_name).absolute()
        executable = declared.resolve(strict=True)
        metadata = os.lstat(declared)
    except OSError as exc:
        raise SubjectBindingError("resolved Git executable is unavailable") from exc
    if (
        declared != executable
        or not stat.S_ISREG(metadata.st_mode)
        or _is_reparse(declared)
    ):
        raise SubjectBindingError(
            "resolved Git executable must be a canonical plain file"
        )
    data = _read_plain_file(executable, "Git executable", MAX_SUBJECT_FILE_BYTES)
    return executable, len(data), hashlib.sha256(data).hexdigest()


def _run_git(
    executable: Path,
    repo_root: Path,
    args: Sequence[str],
    *,
    allowed_returncodes: frozenset[int] = frozenset({0}),
) -> subprocess.CompletedProcess[bytes]:
    argv = [
        str(executable),
        "--no-pager",
        "--no-replace-objects",
        "-C",
        str(repo_root),
        *args,
    ]
    try:
        completed = subprocess.run(
            argv,
            cwd=str(repo_root),
            env=_controlled_git_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SubjectBindingError("could not verify the Git subject checkout") from exc
    if completed.returncode not in allowed_returncodes:
        raise SubjectBindingError(
            f"Git subject verification failed with exit code {completed.returncode}"
        )
    return completed


def _single_ascii_line(
    completed: subprocess.CompletedProcess[bytes], label: str
) -> str:
    try:
        text = completed.stdout.decode("ascii", errors="strict")
    except UnicodeDecodeError as exc:
        raise SubjectBindingError(f"Git returned a non-ASCII {label}") from exc
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise SubjectBindingError(f"Git did not return exactly one {label}")
    return lines[0]


def _stat_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        metadata.st_size,
        metadata.st_mtime_ns,
    )


def _read_plain_file(path: Path, label: str, limit: int) -> bytes:
    try:
        declared = path.absolute()
        resolved = declared.resolve(strict=True)
        declared_metadata = os.lstat(declared)
        if (
            declared != resolved
            or not stat.S_ISREG(declared_metadata.st_mode)
            or _is_reparse(declared)
        ):
            raise SubjectBindingError(f"{label} must be a canonical plain file")
        before = resolved.stat()
        if before.st_size > limit:
            raise SubjectBindingError(f"{label} exceeds the subject file size limit")
        with resolved.open("rb") as handle:
            opened_before = os.fstat(handle.fileno())
            data = handle.read(limit + 1)
            opened_after = os.fstat(handle.fileno())
        after = resolved.stat()
    except SubjectBindingError:
        raise
    except OSError as exc:
        raise SubjectBindingError(f"{label} could not be read safely") from exc
    if len(data) > limit:
        raise SubjectBindingError(f"{label} exceeds the subject file size limit")
    if (
        not (
            _stat_signature(before)
            == _stat_signature(opened_before)
            == _stat_signature(opened_after)
            == _stat_signature(after)
        )
        or len(data) != before.st_size
    ):
        raise SubjectBindingError(f"{label} changed while being read")
    return data


def _parse_ls_tree(data: bytes) -> dict[str, tuple[str, str, str]]:
    result: dict[str, tuple[str, str, str]] = {}
    for record in data.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", maxsplit=1)
            mode, object_type, object_id = metadata.decode("ascii").split()
            relative = raw_path.decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise SubjectBindingError(
                "Git subject tree output could not be parsed"
            ) from exc
        relative = _safe_relative(relative, "Git subject tree path")
        if relative in result or OBJECT_ID_RE.fullmatch(object_id) is None:
            raise SubjectBindingError(
                "Git subject tree returned duplicate or invalid data"
            )
        result[relative] = (mode, object_type, object_id)
    return result


def _parse_index(data: bytes) -> dict[str, tuple[str, str, int]]:
    result: dict[str, tuple[str, str, int]] = {}
    for record in data.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", maxsplit=1)
            mode, object_id, stage_text = metadata.decode("ascii").split()
            stage = int(stage_text)
            relative = raw_path.decode("utf-8", errors="strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise SubjectBindingError("Git index output could not be parsed") from exc
        relative = _safe_relative(relative, "Git index path")
        if (
            relative in result
            or stage != 0
            or OBJECT_ID_RE.fullmatch(object_id) is None
        ):
            raise SubjectBindingError(
                "Git index returned duplicate, unmerged, or invalid data"
            )
        result[relative] = (mode, object_id, stage)
    return result


def _git_blob_oid(data: bytes, width: int) -> str:
    payload = f"blob {len(data)}\0".encode("ascii") + data
    if width == 40:
        return hashlib.sha1(payload, usedforsecurity=False).hexdigest()
    if width == 64:
        return hashlib.sha256(payload).hexdigest()
    raise SubjectBindingError("unsupported Git object-id width")


def _verify_with_executable(
    repo_root: Path,
    binding: SubjectBinding,
    relative_paths: Sequence[str],
    tool_relatives: Sequence[str],
    git_executable: Path,
    git_size: int,
    git_sha256: str,
) -> SubjectSnapshot:
    top = _single_ascii_line(
        _run_git(git_executable, repo_root, ["rev-parse", "--show-toplevel"]),
        "repository root",
    )
    try:
        observed_root = Path(top).resolve(strict=True)
    except OSError as exc:
        raise SubjectBindingError("Git repository root could not be resolved") from exc
    if observed_root != repo_root:
        raise SubjectBindingError("subject source root is not the Git repository root")

    head = _single_ascii_line(
        _run_git(git_executable, repo_root, ["rev-parse", "--verify", "HEAD"]),
        "HEAD object id",
    )
    if head != binding.commit:
        raise SubjectBindingError("repository HEAD does not match the subject commit")
    commit_type = _single_ascii_line(
        _run_git(git_executable, repo_root, ["cat-file", "-t", binding.commit]),
        "subject commit type",
    )
    if commit_type != "commit":
        raise SubjectBindingError("subject commit object is not a commit")
    resolved_tree = _single_ascii_line(
        _run_git(
            git_executable,
            repo_root,
            ["rev-parse", "--verify", f"{binding.commit}^{{tree}}"],
        ),
        "subject tree object id",
    )
    if resolved_tree != binding.tree:
        raise SubjectBindingError("subject commit tree does not match the subject tree")
    tree_type = _single_ascii_line(
        _run_git(git_executable, repo_root, ["cat-file", "-t", binding.tree]),
        "subject tree type",
    )
    if tree_type != "tree":
        raise SubjectBindingError("subject tree object is not a tree")

    tree_rows = _parse_ls_tree(
        _run_git(
            git_executable,
            repo_root,
            ["ls-tree", "-z", "--full-tree", binding.commit, "--", *relative_paths],
        ).stdout
    )
    expected = set(relative_paths)
    if set(tree_rows) != expected:
        raise SubjectBindingError(
            "not all fixed subject inputs are tracked by the commit"
        )
    if any(
        object_type != "blob" or mode not in {"100644", "100755"}
        for mode, object_type, _oid in tree_rows.values()
    ):
        raise SubjectBindingError("a fixed subject input is not a regular tracked blob")

    index_rows = _parse_index(
        _run_git(
            git_executable,
            repo_root,
            ["ls-files", "-s", "-z", "--", *relative_paths],
        ).stdout
    )
    if set(index_rows) != expected:
        raise SubjectBindingError(
            "not all fixed subject inputs are present in the index"
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
            binding.commit,
            "--",
            *relative_paths,
        ],
        allowed_returncodes=frozenset({0, 1}),
    )
    if index_diff.returncode == 1:
        raise SubjectBindingError("fixed subject input index differs from the commit")
    worktree_diff = _run_git(
        git_executable,
        repo_root,
        [
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            binding.commit,
            "--",
            *relative_paths,
        ],
        allowed_returncodes=frozenset({0, 1}),
    )
    if worktree_diff.returncode == 1:
        raise SubjectBindingError(
            "fixed subject input worktree differs from the commit"
        )

    snapshots: list[SubjectFileSnapshot] = []
    total_bytes = 0
    for relative in relative_paths:
        mode, _object_type, blob_oid = tree_rows[relative]
        index_mode, index_oid, _stage = index_rows[relative]
        if index_mode != mode or index_oid != blob_oid:
            raise SubjectBindingError(
                "fixed subject input index blob differs from the commit"
            )
        size_text = _single_ascii_line(
            _run_git(
                git_executable,
                repo_root,
                ["cat-file", "-s", blob_oid],
            ),
            "Git blob size",
        )
        if re.fullmatch(r"(?:0|[1-9][0-9]*)", size_text) is None:
            raise SubjectBindingError("Git returned an invalid fixed-input blob size")
        blob_size = int(size_text)
        if blob_size > MAX_SUBJECT_FILE_BYTES:
            raise SubjectBindingError("fixed subject input exceeds the file size limit")
        if total_bytes + blob_size > MAX_SUBJECT_TOTAL_BYTES:
            raise SubjectBindingError(
                "fixed subject inputs exceed the total size limit"
            )
        blob = _run_git(
            git_executable,
            repo_root,
            ["cat-file", "blob", blob_oid],
        ).stdout
        if len(blob) != blob_size:
            raise SubjectBindingError("Git blob size differs from its object metadata")
        if _git_blob_oid(blob, len(blob_oid)) != blob_oid:
            raise SubjectBindingError(
                "Git blob bytes do not match the tracked object id"
            )
        worktree = _read_plain_file(
            repo_root.joinpath(*PurePosixPath(relative).parts),
            f"fixed subject input {relative}",
            MAX_SUBJECT_FILE_BYTES,
        )
        if worktree != blob:
            raise SubjectBindingError(
                "fixed subject input bytes differ from the commit blob"
            )
        total_bytes += blob_size
        snapshots.append(
            SubjectFileSnapshot(
                relative=relative,
                blob_oid=blob_oid,
                sha256=hashlib.sha256(blob).hexdigest(),
                size_bytes=len(blob),
                data=blob,
            )
        )

    head_after = _single_ascii_line(
        _run_git(git_executable, repo_root, ["rev-parse", "--verify", "HEAD"]),
        "post-verification HEAD object id",
    )
    if head_after != binding.commit:
        raise SubjectBindingError("repository HEAD changed during subject verification")
    current_git = _read_plain_file(
        git_executable, "Git executable", MAX_SUBJECT_FILE_BYTES
    )
    if (
        len(current_git) != git_size
        or hashlib.sha256(current_git).hexdigest() != git_sha256
    ):
        raise SubjectBindingError("Git executable changed during subject verification")
    return SubjectSnapshot(
        repo_root=repo_root,
        binding=binding,
        git_executable=git_executable,
        git_executable_sha256=git_sha256,
        git_executable_size_bytes=git_size,
        files=tuple(snapshots),
        tool_relatives=tuple(tool_relatives),
    )


def verify_subject_repository(
    repo_root: Path,
    commit: Any,
    tree: Any,
    *,
    frozen_paths: Iterable[str],
    tool_paths: Iterable[Path],
) -> SubjectSnapshot:
    binding = parse_subject_binding(commit, tree)
    root = _plain_repo_root(repo_root)
    tool_relatives = tuple(
        _relative_tool_path(root, Path(path), f"tool source {index}")
        for index, path in enumerate(tool_paths)
    )
    paths = [
        *(_safe_relative(value, "fixed subject input") for value in frozen_paths),
        *tool_relatives,
    ]
    if not paths:
        raise SubjectBindingError("subject verification requires fixed input paths")
    if len({path.casefold() for path in paths}) != len(paths):
        raise SubjectBindingError("fixed subject input paths contain a duplicate")
    ordered_paths = tuple(sorted(paths))
    ordered_tools = tuple(sorted(tool_relatives))
    git_executable, git_size, git_sha256 = _resolve_git_executable()
    return _verify_with_executable(
        root,
        binding,
        ordered_paths,
        ordered_tools,
        git_executable,
        git_size,
        git_sha256,
    )


def assert_subject_snapshot_unchanged(snapshot: SubjectSnapshot) -> None:
    observed = _verify_with_executable(
        snapshot.repo_root,
        snapshot.binding,
        tuple(item.relative for item in snapshot.files),
        snapshot.tool_relatives,
        snapshot.git_executable,
        snapshot.git_executable_size_bytes,
        snapshot.git_executable_sha256,
    )
    if observed != snapshot:
        raise SubjectBindingError("Git subject inputs changed during the workflow")
