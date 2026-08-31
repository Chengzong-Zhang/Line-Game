#!/usr/bin/env python3
"""Build the ICLR paper from its nine release inputs and emit a receipt."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
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
HEX_OBJECT_ID = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")
HEX_SHA256 = re.compile(r"[0-9a-fA-F]{64}\Z")


class BuildError(RuntimeError):
    """A fail-closed paper build error."""


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
    ) -> bytes:
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
        self.log.write(output)
        self.log.flush()
        self.output_hash.update(output)
        self.output_size += len(output)
        row = {
            "argv": list(receipt_argv) if receipt_argv is not None else execution_argv,
            "combined_output_sha256": _sha256_bytes(output),
            "combined_output_size_bytes": len(output),
            "exit_code": int(process.returncode),
            "phase": phase,
            "sequence": len(self.commands) + 1,
        }
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


def _tool_record(
    name: str, recorder: _CommandRecorder
) -> tuple[dict[str, Any], str, Path]:
    executable = shutil.which(name)
    if executable is None:
        raise BuildError(f"required executable is not on PATH: {name}")
    executable_path = Path(executable).resolve(strict=True)
    if not executable_path.is_file():
        raise BuildError(f"resolved executable is not a file: {name}")
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


def _verify_tool_unchanged(
    name: str, executable_path: Path, record: dict[str, Any]
) -> None:
    try:
        unchanged = (
            executable_path.stat().st_size == record["executable_size_bytes"]
            and _sha256_file(executable_path) == record["executable_sha256"]
        )
    except OSError as exc:
        raise BuildError(f"{name} executable became unavailable") from exc
    if not unchanged:
        raise BuildError(f"{name} executable changed during the build")


def _run_bound_tool(
    recorder: _CommandRecorder,
    *,
    name: str,
    executable_path: Path,
    tool_record: dict[str, Any],
    phase: str,
    argv: Sequence[str],
) -> bytes:
    _verify_tool_unchanged(name, executable_path, tool_record)
    output = recorder.run(
        phase,
        argv,
        receipt_argv=_public_tool_argv(name, argv),
    )
    _verify_tool_unchanged(name, executable_path, tool_record)
    return output


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
    work_dir = output_root / "work"
    work_dir.mkdir()
    _copy_inputs(paper_root, work_dir, input_records)

    scrubbed_tex_names = set(SCRUBBED_TEX_ENVIRONMENT_VARIABLES)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in scrubbed_tex_names
    }
    environment.update(FIXED_ENVIRONMENT)
    log_path = output_root / "combined_subprocess_output.log"
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
        is_miktex = pdflatex_distribution == "miktex"

        latex_argv = _latex_argv(pdflatex_executable, is_miktex)
        bibtex_argv = _bibtex_argv(bibtex_executable, is_miktex)
        _run_bound_tool(
            recorder,
            name="pdflatex",
            executable_path=pdflatex_executable,
            tool_record=pdflatex_tool,
            phase="latex-initial",
            argv=latex_argv,
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
            _run_bound_tool(
                recorder,
                name="pdflatex",
                executable_path=pdflatex_executable,
                tool_record=pdflatex_tool,
                phase=f"latex-post-bibtex-{pass_number}",
                argv=latex_argv,
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

    _verify_snapshot(paper_root, input_records, "source")
    _verify_snapshot(work_dir, input_records, "copied")
    git_subject_after = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    if git_subject_after != git_subject:
        raise BuildError("Git subject verification changed during the build")
    built_pdf = work_dir / "main.pdf"
    pdf_sha256 = _sha256_file(built_pdf)
    if expected is not None and pdf_sha256 != expected:
        raise BuildError(
            f"built PDF SHA-256 {pdf_sha256} does not match expected {expected}"
        )
    final_pdf = output_root / "main.pdf"
    with built_pdf.open("rb") as source, final_pdf.open("xb") as target:
        shutil.copyfileobj(source, target)
    final_pdf_size = final_pdf.stat().st_size
    if _sha256_file(final_pdf) != pdf_sha256:
        raise BuildError("final PDF copy failed verification")

    _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
    _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
    if (
        final_pdf.stat().st_size != final_pdf_size
        or _sha256_file(final_pdf) != pdf_sha256
    ):
        raise BuildError("final PDF changed before receipt generation")

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
        "schema_version": 1,
        "scope_claims": {
            "author_approval_verified": False,
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
            "tex_runtime_dependency_closure_verified": False,
        },
        "subject": {
            "commit": commit,
            "identifier_source": "explicit command-line arguments",
            "tree": tree,
            "verification": git_subject,
        },
        "tools": {
            "bibtex": bibtex_tool,
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
        ),
    )
    _verify_tool_unchanged("pdflatex", pdflatex_executable, pdflatex_tool)
    _verify_tool_unchanged("bibtex", bibtex_executable, bibtex_tool)
    if (
        final_pdf.stat().st_size != final_pdf_size
        or _sha256_file(final_pdf) != pdf_sha256
    ):
        raise BuildError("final PDF changed immediately before receipt write")
    git_subject_final = _verify_git_subject(
        paper_root,
        commit,
        tree,
        timeout_seconds=timeout_seconds,
    )
    if git_subject_final != git_subject:
        raise BuildError("Git subject verification changed before receipt write")
    receipt_path = output_root / "build_receipt.json"
    with receipt_path.open("xb") as handle:
        handle.write(_canonical_json_bytes(receipt))
    try:
        git_subject_after_receipt = _verify_git_subject(
            paper_root,
            commit,
            tree,
            timeout_seconds=timeout_seconds,
        )
        if git_subject_after_receipt != git_subject:
            raise BuildError("Git subject verification changed after receipt write")
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
