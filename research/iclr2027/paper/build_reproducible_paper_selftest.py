#!/usr/bin/env python3
"""Fast mocked-subprocess tests for build_reproducible_paper.py."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import unittest
import uuid
from pathlib import Path
from unittest import mock

import build_reproducible_paper as builder


COMMIT = "a" * 40
TREE = "b" * 40


class FakeTeX:
    def __init__(
        self,
        *,
        fail_phase: str | None = None,
        unstable: bool = False,
        mutate_tool: str | None = None,
    ):
        self.calls: list[tuple[list[str], dict[str, str], bool]] = []
        self.fail_phase = fail_phase
        self.unstable = unstable
        self.mutate_tool = mutate_tool
        self.tool_mutated = False
        self.latex_calls = 0

    def __call__(
        self, argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess:
        environment = kwargs["env"]
        assert isinstance(environment, dict)
        self.calls.append((list(argv), environment, bool(kwargs.get("shell"))))
        cwd = Path(str(kwargs["cwd"]))
        tool_name = Path(argv[0]).stem.lower()
        if argv[1:] == ["--version"]:
            output = f"{argv[0]} 1.0 (MiKTeX 25.1)\n".encode()
            return subprocess.CompletedProcess(argv, 0, stdout=output)
        if self.mutate_tool == tool_name and not self.tool_mutated:
            Path(argv[0]).write_bytes(b"mutated executable bytes")
            self.tool_mutated = True
        phase = "bibtex" if tool_name == "bibtex" else "latex"
        if self.fail_phase == phase:
            return subprocess.CompletedProcess(argv, 7, stdout=b"intentional failure\n")
        if phase == "bibtex":
            (cwd / "main.bbl").write_bytes(b"stable bibliography\n")
        else:
            self.latex_calls += 1
            marker = self.latex_calls if self.unstable else 1
            (cwd / "main.aux").write_text(f"aux {marker}\n", encoding="utf-8")
            (cwd / "main.out").write_bytes(b"stable outline\n")
            pdf = b"%PDF-1.4\n/Type /Page\n/Type /Page\n%%EOF\n"
            if self.unstable:
                pdf += str(marker).encode()
            (cwd / "main.pdf").write_bytes(pdf)
        return subprocess.CompletedProcess(argv, 0, stdout=f"{phase} ok\n".encode())


class FakeGit:
    def __init__(
        self,
        repo_root: Path,
        *,
        head: str = COMMIT,
        tree: str = TREE,
        dirty_index: bool = False,
        dirty_worktree: bool = False,
        omit_tracked_input: str | None = None,
        track_build_tool: bool = False,
        build_tool_blob: bytes | None = None,
        build_tool_mode: str = "100644",
        build_tool_type: str = "blob",
        build_tool_oid: str | None = None,
        after_first_verification: object | None = None,
    ) -> None:
        self.repo_root = repo_root.resolve()
        self.head = head
        self.tree = tree
        self.dirty_index = dirty_index
        self.dirty_worktree = dirty_worktree
        self.omit_tracked_input = omit_tracked_input
        self.track_build_tool = track_build_tool
        self.build_tool_blob = (
            Path(builder.__file__).read_bytes()
            if build_tool_blob is None
            else build_tool_blob
        )
        self.build_tool_mode = build_tool_mode
        self.build_tool_type = build_tool_type
        self.build_tool_oid = build_tool_oid or builder._git_blob_oid(
            self.build_tool_blob, 40
        )
        self.after_first_verification = after_first_verification
        self.head_calls = 0
        self.blobs = {
            path: (self.repo_root / path).read_bytes()
            for path in builder.CANONICAL_INPUT_PATHS
        }
        self.blob_oids = {
            path: builder._git_blob_oid(data, 40) for path, data in self.blobs.items()
        }
        self.calls: list[tuple[list[str], Path, bool, dict[str, str]]] = []

    def __call__(
        self, argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess:
        self.calls.append(
            (
                list(argv),
                Path(str(kwargs["cwd"])).resolve(),
                bool(kwargs.get("shell")),
                dict(kwargs["env"]),
            )
        )
        args = argv[1:]
        if args == ["rev-parse", "--show-toplevel"]:
            return subprocess.CompletedProcess(
                argv, 0, stdout=(str(self.repo_root) + "\n").encode()
            )
        if args == ["rev-parse", "--verify", "HEAD"]:
            self.head_calls += 1
            if self.head_calls == 2 and callable(self.after_first_verification):
                self.after_first_verification()
            return subprocess.CompletedProcess(
                argv, 0, stdout=(self.head + "\n").encode()
            )
        if args[:2] == ["rev-parse", "--verify"] and args[2].endswith("^{tree}"):
            return subprocess.CompletedProcess(
                argv, 0, stdout=(self.tree + "\n").encode()
            )
        if args[:3] == ["ls-tree", "-z", "--full-tree"]:
            requested_paths = args[args.index("--") + 1 :]
            if requested_paths == [builder.CANONICAL_BUILD_TOOL_PATH]:
                if not self.track_build_tool:
                    return subprocess.CompletedProcess(argv, 0, stdout=b"")
                row = (
                    f"{self.build_tool_mode} {self.build_tool_type} "
                    f"{self.build_tool_oid}\t{builder.CANONICAL_BUILD_TOOL_PATH}"
                ).encode() + b"\0"
                return subprocess.CompletedProcess(argv, 0, stdout=row)
            if requested_paths != list(builder.CANONICAL_INPUT_PATHS):
                raise AssertionError(f"unexpected ls-tree paths: {requested_paths!r}")
            rows = []
            for path in builder.CANONICAL_INPUT_PATHS:
                if path == self.omit_tracked_input:
                    continue
                rows.append(
                    f"100644 blob {self.blob_oids[path]}\t{path}".encode() + b"\0"
                )
            return subprocess.CompletedProcess(argv, 0, stdout=b"".join(rows))
        if args[:2] == ["cat-file", "blob"]:
            canonical_path = args[2].split(":", maxsplit=1)[1]
            if canonical_path == builder.CANONICAL_BUILD_TOOL_PATH:
                return subprocess.CompletedProcess(argv, 0, stdout=self.build_tool_blob)
            return subprocess.CompletedProcess(
                argv, 0, stdout=self.blobs[canonical_path]
            )
        if args and args[0] == "diff":
            dirty = self.dirty_index if "--cached" in args else self.dirty_worktree
            return subprocess.CompletedProcess(argv, int(dirty), stdout=b"")
        raise AssertionError(f"unexpected mocked Git command: {argv!r}")


class FakeSubprocess:
    def __init__(self, git: FakeGit, tex: FakeTeX) -> None:
        self.git = git
        self.tex = tex

    def __call__(
        self, argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess:
        if Path(argv[0]).stem.lower() == "git":
            return self.git(argv, **kwargs)
        return self.tex(argv, **kwargs)


class ReproduciblePaperBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        writable_temp_root = Path.cwd() / "local_artifacts"
        writable_temp_root.mkdir(exist_ok=True)
        self.root = writable_temp_root / (
            f"_paper_builder_selftest_{os.getpid()}_{uuid.uuid4().hex}"
        )
        self.root.mkdir()
        self.repo = self.root / "repo"
        self.paper = self.repo / Path(builder.CANONICAL_PAPER_PATH)
        self.paper.mkdir(parents=True)
        for relative in builder.SOURCE_INPUTS:
            path = self.paper / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"fixture:{relative}\n".encode())
        (self.paper / "main.pdf").write_bytes(b"committed PDF must not be copied")
        self.fixture_builder = self.repo / builder.CANONICAL_BUILD_TOOL_PATH
        self.fixture_builder.write_bytes(Path(builder.__file__).read_bytes())
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.executables = {}
        for name in ("pdflatex", "bibtex", "git"):
            path = self.bin_dir / f"{name}.exe"
            path.write_bytes(f"fake executable {name}".encode())
            self.executables[name] = str(path)

    def tearDown(self) -> None:
        expected_parent = (Path.cwd() / "local_artifacts").resolve()
        if (
            self.root.resolve().parent != expected_parent
            or not self.root.name.startswith("_paper_builder_selftest_")
        ):
            raise AssertionError("refusing unsafe self-test cleanup")

        def make_writable_and_retry(
            function: object, path: str, _exc_info: object
        ) -> None:
            os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
            if not callable(function):
                raise AssertionError("cleanup callback is not callable")
            function(path)

        try:
            shutil.rmtree(self.root, onexc=make_writable_and_retry)
        except TypeError:
            shutil.rmtree(self.root, onerror=make_writable_and_retry)

    def build(
        self,
        fake: FakeTeX,
        *,
        git: FakeGit | None = None,
        paper_dir: Path | None = None,
        output_dir: Path | None = None,
        output_name: str = "output",
        expected: str | None = None,
        max_passes: int = 6,
        subject_commit: str = COMMIT,
        subject_tree: str = TREE,
        executing_builder_path: Path | None = None,
    ) -> Path:
        fake_git = git or FakeGit(self.repo)
        bound_builder_path = executing_builder_path or (
            self.fixture_builder
            if fake_git.track_build_tool
            else Path(builder.__file__)
        )
        with (
            mock.patch.object(builder, "__file__", str(bound_builder_path)),
            mock.patch.object(
                builder.shutil, "which", side_effect=self.executables.get
            ),
            mock.patch.object(
                builder.subprocess,
                "run",
                side_effect=FakeSubprocess(fake_git, fake),
            ),
        ):
            return builder.build_paper(
                paper_dir=paper_dir or self.paper,
                output_dir=output_dir or self.root / output_name,
                subject_commit=subject_commit,
                subject_tree=subject_tree,
                expected_pdf_sha256=expected,
                max_post_bibtex_passes=max_passes,
            )

    def test_success_is_canonical_exact_and_offline(self) -> None:
        expected_pdf = b"%PDF-1.4\n/Type /Page\n/Type /Page\n%%EOF\n"
        expected_hash = hashlib.sha256(expected_pdf).hexdigest()
        fake = FakeTeX()
        receipt_path = self.build(fake, expected=expected_hash)

        receipt_bytes = receipt_path.read_bytes()
        receipt = json.loads(receipt_bytes)
        self.assertEqual(
            receipt_bytes,
            builder._canonical_json_bytes(receipt),
        )
        self.assertEqual(receipt["input_tree"]["file_count"], 9)
        expected_tree_rows = b"".join(
            (
                f"{builder.CANONICAL_PAPER_PREFIX}{row['path']}\t"
                f"{row['size_bytes']}\t{row['sha256']}\n"
            ).encode("ascii")
            for row in receipt["input_tree"]["files"]
        )
        self.assertEqual(
            receipt["input_tree"]["sha256"],
            hashlib.sha256(expected_tree_rows).hexdigest(),
        )
        self.assertEqual(
            [row["path"] for row in receipt["input_tree"]["files"]],
            list(builder.SOURCE_INPUTS),
        )
        self.assertNotIn(
            "main.pdf", [row["path"] for row in receipt["input_tree"]["files"]]
        )
        self.assertEqual(receipt["final_pdf"]["sha256"], expected_hash)
        self.assertEqual(receipt["final_pdf"]["page_count"], 2)
        self.assertTrue(receipt["scope_claims"]["exact_pdf_reproduction_verified"])
        self.assertFalse(receipt["scope_claims"]["scientific_claims_verified"])
        self.assertFalse(receipt["scope_claims"]["author_approval_verified"])
        self.assertFalse(receipt["scope_claims"]["submission_readiness_verified"])
        self.assertFalse(
            receipt["scope_claims"]["tex_runtime_dependency_closure_verified"]
        )
        self.assertTrue(receipt["scope_claims"]["subject_checkout_identity_verified"])
        self.assertTrue(receipt["scope_claims"]["subject_fixed_paper_inputs_verified"])
        self.assertFalse(
            receipt["scope_claims"]["build_tool_source_commit_binding_verified"]
        )
        self.assertEqual(
            receipt["subject"]["verification"]["build_tool_source"],
            {
                "path": builder.CANONICAL_BUILD_TOOL_PATH,
                "reason": "not_tracked",
            },
        )
        self.assertEqual(
            receipt["subject"]["verification"]["canonical_paper_path"],
            builder.CANONICAL_PAPER_PATH,
        )
        self.assertEqual(
            receipt["final_pdf"]["page_count_evidence_class"],
            "informational_non_gating",
        )
        self.assertEqual(receipt["build"]["post_bibtex_latex_passes"], 2)
        self.assertTrue(all(call[2] is False for call in fake.calls))
        build_calls = [call for call in fake.calls if call[0][1:] != ["--version"]]
        self.assertEqual(
            [call[0][0] for call in build_calls],
            [
                str(Path(self.executables["pdflatex"]).resolve()),
                str(Path(self.executables["bibtex"]).resolve()),
                str(Path(self.executables["pdflatex"]).resolve()),
                str(Path(self.executables["pdflatex"]).resolve()),
            ],
        )
        self.assertTrue(all("--disable-installer" in call[0] for call in build_calls))
        for _, environment, _ in fake.calls:
            self.assertEqual(
                {key: environment[key] for key in builder.FIXED_ENVIRONMENT},
                builder.FIXED_ENVIRONMENT,
            )
        self.assertFalse(
            (self.root / "output" / "work" / "main.pdf").read_bytes()
            == (self.paper / "main.pdf").read_bytes()
        )
        receipt_text = receipt_bytes.decode("utf-8")
        self.assertNotIn(str(self.root.resolve()), receipt_text)
        for tool in receipt["tools"].values():
            self.assertNotIn(str(self.root.resolve()), tool["version_banner"])
        self.assertEqual(
            [row["argv"][0] for row in receipt["build"]["commands"]],
            ["pdflatex", "bibtex", "pdflatex", "bibtex", "pdflatex", "pdflatex"],
        )

    def test_tracked_builder_blob_is_bound_without_private_path(self) -> None:
        source = Path(builder.__file__).read_bytes()
        git = FakeGit(self.repo, track_build_tool=True)
        receipt_path = self.build(
            FakeTeX(),
            git=git,
            output_name="tracked-builder",
        )
        receipt = json.loads(receipt_path.read_bytes())
        record = receipt["subject"]["verification"]["build_tool_source"]
        self.assertTrue(
            receipt["scope_claims"]["build_tool_source_commit_binding_verified"]
        )
        self.assertEqual(
            record,
            {
                "blob_oid": builder._git_blob_oid(source, 40),
                "path": builder.CANONICAL_BUILD_TOOL_PATH,
                "sha256": hashlib.sha256(source).hexdigest(),
                "size_bytes": len(source),
            },
        )
        self.assertNotIn(
            str(Path(builder.__file__).resolve()).replace("\\", "/").lower(),
            receipt_path.read_text(encoding="utf-8").replace("\\", "/").lower(),
        )

    def test_tracked_builder_mismatch_or_nonregular_blob_fails_closed(self) -> None:
        mismatch_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "does not match the subject"):
            self.build(
                mismatch_tex,
                git=FakeGit(
                    self.repo,
                    track_build_tool=True,
                    build_tool_blob=b"different committed builder bytes\n",
                ),
                output_name="builder-mismatch",
            )
        self.assertEqual(mismatch_tex.calls, [])
        self.assertFalse(
            (self.root / "builder-mismatch" / "build_receipt.json").exists()
        )

        nonregular_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "not a regular blob"):
            self.build(
                nonregular_tex,
                git=FakeGit(
                    self.repo,
                    track_build_tool=True,
                    build_tool_mode="120000",
                ),
                output_name="builder-nonregular",
            )
        self.assertEqual(nonregular_tex.calls, [])
        self.assertFalse(
            (self.root / "builder-nonregular" / "build_receipt.json").exists()
        )

    def test_tracked_builder_off_canonical_execution_path_fails_closed(self) -> None:
        fake = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "not at its canonical"):
            self.build(
                fake,
                git=FakeGit(self.repo, track_build_tool=True),
                output_name="builder-off-path",
                executing_builder_path=Path(builder.__file__).resolve(),
            )
        self.assertEqual(fake.calls, [])
        self.assertFalse(
            (self.root / "builder-off-path" / "build_receipt.json").exists()
        )

    def test_tracked_builder_blob_oid_mismatch_fails_closed(self) -> None:
        fake = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "tracked object id"):
            self.build(
                fake,
                git=FakeGit(
                    self.repo,
                    track_build_tool=True,
                    build_tool_oid="c" * 40,
                ),
                output_name="builder-oid-mismatch",
            )
        self.assertEqual(fake.calls, [])
        self.assertFalse(
            (self.root / "builder-oid-mismatch" / "build_receipt.json").exists()
        )

    def test_tracked_builder_source_change_during_build_fails_closed(self) -> None:
        source = Path(builder.__file__).read_bytes()
        fake = FakeTeX()
        with (
            mock.patch.object(
                builder,
                "_read_executing_build_tool_source",
                side_effect=[source, source + b"changed during build\n"],
            ),
            self.assertRaisesRegex(builder.BuildError, "does not match the subject"),
        ):
            self.build(
                fake,
                git=FakeGit(self.repo, track_build_tool=True),
                output_name="builder-changed",
            )
        self.assertGreater(len(fake.calls), 0)
        self.assertFalse(
            (self.root / "builder-changed" / "build_receipt.json").exists()
        )

    def test_tracked_builder_source_change_before_receipt_fails_closed(self) -> None:
        source = Path(builder.__file__).read_bytes()
        fake = FakeTeX()
        with (
            mock.patch.object(
                builder,
                "_read_executing_build_tool_source",
                side_effect=[source, source, source + b"changed before receipt\n"],
            ),
            self.assertRaisesRegex(builder.BuildError, "does not match the subject"),
        ):
            self.build(
                fake,
                git=FakeGit(self.repo, track_build_tool=True),
                output_name="builder-changed-before-receipt",
            )
        self.assertGreater(len(fake.calls), 0)
        self.assertFalse(
            (
                self.root / "builder-changed-before-receipt" / "build_receipt.json"
            ).exists()
        )

    def test_tracked_builder_source_change_after_receipt_is_unlinked(self) -> None:
        source = Path(builder.__file__).read_bytes()
        fake = FakeTeX()
        with (
            mock.patch.object(
                builder,
                "_read_executing_build_tool_source",
                side_effect=[
                    source,
                    source,
                    source,
                    source + b"changed after receipt\n",
                ],
            ),
            self.assertRaisesRegex(builder.BuildError, "does not match the subject"),
        ):
            self.build(
                fake,
                git=FakeGit(self.repo, track_build_tool=True),
                output_name="builder-changed-after-receipt",
            )
        self.assertGreater(len(fake.calls), 0)
        self.assertFalse(
            (
                self.root / "builder-changed-after-receipt" / "build_receipt.json"
            ).exists()
        )

    def test_real_git_repo_binds_builder_blob_without_tex(self) -> None:
        git_name = shutil.which("git")
        if git_name is None:
            self.skipTest("git is unavailable")
        source = Path(builder.__file__).read_bytes()
        (self.repo / builder.CANONICAL_BUILD_TOOL_PATH).write_bytes(source)

        def run_git(*args: str) -> bytes:
            process = subprocess.run(
                [git_name, *args],
                cwd=self.repo,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                shell=False,
            )
            if process.returncode != 0:
                self.fail(
                    f"real Git fixture command failed: {args!r}: "
                    f"{process.stderr.decode(errors='replace')}"
                )
            return process.stdout

        run_git("init", "--quiet")
        run_git(
            "add",
            "--",
            *builder.CANONICAL_INPUT_PATHS,
            builder.CANONICAL_BUILD_TOOL_PATH,
        )
        run_git(
            "-c",
            "user.name=paper-builder-selftest",
            "-c",
            "user.email=paper-builder-selftest@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "paper builder fixture",
        )
        commit = run_git("rev-parse", "HEAD").decode().strip()
        tree = run_git("rev-parse", "HEAD^{tree}").decode().strip()
        with mock.patch.object(builder, "__file__", str(self.fixture_builder)):
            verification = builder._verify_git_subject(
                self.paper.resolve(),
                commit,
                tree,
                timeout_seconds=30,
            )
        self.assertEqual(
            verification["build_tool_source"],
            {
                "blob_oid": builder._git_blob_oid(source, len(commit)),
                "path": builder.CANONICAL_BUILD_TOOL_PATH,
                "sha256": hashlib.sha256(source).hexdigest(),
                "size_bytes": len(source),
            },
        )

    def test_git_subject_calls_are_argv_and_shell_false(self) -> None:
        git = FakeGit(self.repo)
        self.build(FakeTeX(), git=git, output_name="git-argv")
        self.assertGreaterEqual(len(git.calls), 12)
        self.assertTrue(all(isinstance(argv, list) for argv, _, _, _ in git.calls))
        self.assertTrue(
            all(
                argv[0] == str(Path(self.executables["git"]).resolve())
                for argv, _, _, _ in git.calls
            )
        )
        self.assertTrue(all(shell is False for _, _, shell, _ in git.calls))

    def test_caller_git_and_tex_path_overrides_are_scrubbed(self) -> None:
        hostile_environment = {
            "GIT_DIR": str(self.root / "hostile-git-dir"),
            "GIT_WORK_TREE": str(self.root / "hostile-worktree"),
            "GIT_INDEX_FILE": str(self.root / "hostile-index"),
            "GIT_EXTERNAL_DIFF": str(self.root / "hostile-diff"),
            "TEXINPUTS": str(self.root / "hostile-texinputs"),
            "BIBINPUTS": str(self.root / "hostile-bibinputs"),
            "BSTINPUTS": str(self.root / "hostile-bstinputs"),
            "TEXMFOUTPUT": str(self.root / "hostile-texmfoutput"),
        }
        git = FakeGit(self.repo)
        tex = FakeTeX()
        with mock.patch.dict(os.environ, hostile_environment, clear=False):
            self.build(tex, git=git, output_name="scrubbed-env")
        for _, _, _, environment in git.calls:
            self.assertNotIn("GIT_DIR", environment)
            self.assertNotIn("GIT_WORK_TREE", environment)
            self.assertNotIn("GIT_INDEX_FILE", environment)
            self.assertNotIn("GIT_EXTERNAL_DIFF", environment)
            self.assertEqual(environment["GIT_CONFIG_NOSYSTEM"], "1")
            self.assertEqual(environment["GIT_NO_REPLACE_OBJECTS"], "1")
        for _, environment, _ in tex.calls:
            for name in ("TEXINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXMFOUTPUT"):
                self.assertNotIn(name, environment)

    def test_post_git_check_input_swap_cannot_enter_the_build(self) -> None:
        target = self.paper / "main.tex"

        def mutate_after_verification() -> None:
            target.write_bytes(b"not the committed paper bytes\n")

        git = FakeGit(
            self.repo,
            after_first_verification=mutate_after_verification,
        )
        fake = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "commit blobs"):
            self.build(fake, git=git, output_name="post-git-swap")
        self.assertEqual(fake.calls, [])

    def test_wrong_commit_or_tree_is_rejected_before_tex(self) -> None:
        wrong_commit_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "HEAD does not match"):
            self.build(
                wrong_commit_tex,
                output_name="wrong-commit",
                subject_commit="d" * 40,
            )
        self.assertEqual(wrong_commit_tex.calls, [])

        wrong_tree_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "tree does not match"):
            self.build(
                wrong_tree_tex,
                output_name="wrong-tree",
                subject_tree="d" * 40,
            )
        self.assertEqual(wrong_tree_tex.calls, [])

    def test_dirty_input_or_missing_tracked_input_is_rejected(self) -> None:
        dirty_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "worktree differs"):
            self.build(
                dirty_tex,
                git=FakeGit(self.repo, dirty_worktree=True),
                output_name="dirty",
            )
        self.assertEqual(dirty_tex.calls, [])

        staged_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "index differs"):
            self.build(
                staged_tex,
                git=FakeGit(self.repo, dirty_index=True),
                output_name="staged-dirty",
            )
        self.assertEqual(staged_tex.calls, [])

        missing_tex = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "not all nine"):
            self.build(
                missing_tex,
                git=FakeGit(
                    self.repo,
                    omit_tracked_input=builder.CANONICAL_INPUT_PATHS[-1],
                ),
                output_name="missing-tracked",
            )
        self.assertEqual(missing_tex.calls, [])

    def test_wrong_relative_paper_directory_is_rejected(self) -> None:
        wrong_paper = self.repo / "paper"
        wrong_paper.mkdir()
        for relative in builder.SOURCE_INPUTS:
            target = wrong_paper / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f"wrong:{relative}\n".encode())
        fake = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "paper directory must be"):
            self.build(fake, paper_dir=wrong_paper, output_name="wrong-relative")
        self.assertEqual(fake.calls, [])

    def test_tool_mutation_fails_before_success_receipt(self) -> None:
        fake = FakeTeX(mutate_tool="pdflatex")
        with self.assertRaisesRegex(builder.BuildError, "changed during the build"):
            self.build(fake, output_name="tool-mutated")
        self.assertFalse((self.root / "tool-mutated" / "build_receipt.json").exists())

    def test_private_path_guard_checks_unescaped_receipt_values(self) -> None:
        with self.assertRaisesRegex(builder.BuildError, "host-local absolute path"):
            builder._assert_receipt_has_no_private_paths(
                {"nested": {"value": str(self.root.resolve())}},
                [self.root],
            )

    def test_without_expected_hash_makes_no_exact_reproduction_claim(self) -> None:
        receipt = json.loads(
            self.build(FakeTeX(), output_name="no-expected").read_bytes()
        )
        self.assertFalse(receipt["scope_claims"]["exact_pdf_reproduction_verified"])
        self.assertIsNone(receipt["scope_claims"]["expected_pdf_sha256"])

    def test_existing_or_nested_output_is_rejected_before_subprocess(self) -> None:
        existing = self.root / "existing"
        existing.mkdir()
        fake = FakeTeX()
        with self.assertRaisesRegex(builder.BuildError, "must not already exist"):
            self.build(fake, output_name="existing")
        with self.assertRaisesRegex(builder.BuildError, "disjoint"):
            self.build(fake, output_dir=self.paper / "nested")
        self.assertEqual(fake.calls, [])

    def test_nonzero_command_stops_without_success_receipt(self) -> None:
        fake = FakeTeX(fail_phase="bibtex")
        with self.assertRaisesRegex(builder.BuildError, "exited with code 7"):
            self.build(fake, output_name="failed")
        self.assertFalse((self.root / "failed" / "build_receipt.json").exists())
        phases = [Path(call[0][0]).stem for call in fake.calls]
        self.assertEqual(phases, ["pdflatex", "bibtex", "pdflatex", "bibtex"])

    def test_expected_hash_mismatch_fails_closed(self) -> None:
        with self.assertRaisesRegex(builder.BuildError, "does not match expected"):
            self.build(FakeTeX(), output_name="mismatch", expected="0" * 64)
        self.assertFalse((self.root / "mismatch" / "build_receipt.json").exists())

    def test_unstable_outputs_hit_bounded_pass_limit(self) -> None:
        fake = FakeTeX(unstable=True)
        with self.assertRaisesRegex(builder.BuildError, "did not stabilize"):
            self.build(fake, output_name="unstable", max_passes=3)
        self.assertEqual(fake.latex_calls, 4)
        self.assertFalse((self.root / "unstable" / "build_receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
