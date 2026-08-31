from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[2]
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import subject_binding  # noqa: E402


OWNER_MARKER = ".subject-binding-selftest-owner"


class SubjectBindingSelfTests(unittest.TestCase):
    def setUp(self) -> None:
        artifacts = REPO_ROOT / "local_artifacts"
        artifacts.mkdir(exist_ok=True)
        self.root = artifacts / (
            f"_subject_binding_selftest_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        )
        self.root.mkdir()
        self.owner_token = uuid.uuid4().hex
        (self.root / OWNER_MARKER).write_text(
            self.owner_token + "\n", encoding="ascii", newline="\n"
        )
        self.addCleanup(self._remove_root)
        self.repo, self.commit, self.tree = self._create_repository("sha1")

    def _remove_root(self) -> None:
        if not self.root.exists():
            return
        expected_parent = REPO_ROOT / "local_artifacts"
        marker = self.root / OWNER_MARKER
        if (
            self.root.parent != expected_parent
            or not self.root.name.startswith("_subject_binding_selftest_")
            or self.root.is_symlink()
            or not self.root.is_dir()
            or not marker.is_file()
            or marker.read_text(encoding="ascii") != self.owner_token + "\n"
        ):
            raise RuntimeError(
                "refusing unsafe subject-binding self-test cleanup target"
            )

        def remove_readonly(function: object, path: str, _error: object) -> None:
            target = Path(path)
            try:
                target.chmod(stat.S_IWRITE | stat.S_IREAD)
                function(path)  # type: ignore[operator]
            except OSError as exc:
                raise RuntimeError(
                    "subject-binding self-test cleanup could not remove a Git object"
                ) from exc

        shutil.rmtree(self.root, onerror=remove_readonly)

    @staticmethod
    def _git(repo: Path, *args: str) -> bytes:
        executable, _size, _digest = subject_binding._resolve_git_executable()
        completed = subprocess.run(
            [str(executable), "--no-pager", "-C", str(repo), *args],
            cwd=str(repo),
            env=subject_binding._controlled_git_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=False,
            timeout=30,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"self-test Git command failed with exit code {completed.returncode}"
            )
        return completed.stdout

    def _create_repository(self, object_format: str) -> tuple[Path, str, str]:
        repo = self.root / f"repo-{object_format}"
        repo.mkdir()
        init_args = ["init", "--quiet"]
        if object_format == "sha256":
            init_args.append("--object-format=sha256")
        self._git(repo, *init_args)
        (repo / "input.txt").write_bytes(b"subject input\n")
        (repo / "tool.py").write_bytes(b"VALUE = 1\n")
        self._git(repo, "add", "--", "input.txt", "tool.py")
        self._git(
            repo,
            "-c",
            "user.name=Subject Binding Selftest",
            "-c",
            "user.email=subject-binding-selftest@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "subject baseline",
        )
        commit = (
            self._git(repo, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
        )
        tree = (
            self._git(repo, "rev-parse", "--verify", "HEAD^{tree}")
            .decode("ascii")
            .strip()
        )
        return repo, commit, tree

    @staticmethod
    def _verify(
        repo: Path, commit: object, tree: object
    ) -> subject_binding.SubjectSnapshot:
        return subject_binding.verify_subject_repository(
            repo,
            commit,
            tree,
            frozen_paths=("input.txt",),
            tool_paths=(repo / "tool.py",),
        )

    def test_exact_sha1_commit_tree_and_bytes_pass(self) -> None:
        snapshot = self._verify(self.repo, self.commit, self.tree)
        self.assertEqual(snapshot.binding.commit, self.commit)
        self.assertEqual(snapshot.binding.tree, self.tree)
        self.assertEqual(snapshot.tool_relatives, ("tool.py",))
        self.assertEqual(
            tuple(item.relative for item in snapshot.files),
            ("input.txt", "tool.py"),
        )
        expected = {
            "input.txt": b"subject input\n",
            "tool.py": b"VALUE = 1\n",
        }
        for item in snapshot.files:
            self.assertEqual(item.data, expected[item.relative])
            self.assertEqual(item.size_bytes, len(item.data))
            self.assertEqual(item.sha256, hashlib.sha256(item.data).hexdigest())
        subject_binding.assert_subject_snapshot_unchanged(snapshot)

    def test_wrong_commit_tree_and_object_type_fail_closed(self) -> None:
        with self.assertRaisesRegex(subject_binding.SubjectBindingError, "HEAD"):
            self._verify(self.repo, "0" * len(self.commit), self.tree)

        blob = (
            self._git(self.repo, "rev-parse", "HEAD:input.txt").decode("ascii").strip()
        )
        with self.assertRaisesRegex(subject_binding.SubjectBindingError, "tree"):
            self._verify(self.repo, self.commit, blob)

        (self.repo / ".git" / "HEAD").write_text(
            self.tree + "\n", encoding="ascii", newline="\n"
        )
        with self.assertRaisesRegex(
            subject_binding.SubjectBindingError, "not a commit"
        ):
            self._verify(self.repo, self.tree, self.tree)

    def test_dirty_staged_and_untracked_inputs_or_tools_are_rejected(self) -> None:
        cases = (
            ("dirty-input", self.repo / "input.txt", b"dirty input\n", False),
            ("staged-input", self.repo / "input.txt", b"staged input\n", True),
            ("dirty-tool", self.repo / "tool.py", b"VALUE = 2\n", False),
        )
        for label, path, data, staged in cases:
            with self.subTest(label=label):
                path.write_bytes(data)
                if staged:
                    self._git(self.repo, "add", "--", path.name)
                with self.assertRaises(subject_binding.SubjectBindingError):
                    self._verify(self.repo, self.commit, self.tree)
                self._git(
                    self.repo,
                    "restore",
                    "--source",
                    self.commit,
                    "--staged",
                    "--worktree",
                    "--",
                    path.name,
                )

        untracked_tool = self.repo / "untracked_tool.py"
        untracked_tool.write_bytes(b"VALUE = 3\n")
        with self.assertRaisesRegex(
            subject_binding.SubjectBindingError, "tracked by the commit"
        ):
            subject_binding.verify_subject_repository(
                self.repo,
                self.commit,
                self.tree,
                frozen_paths=("input.txt",),
                tool_paths=(untracked_tool,),
            )

    def test_post_check_swap_is_detected(self) -> None:
        snapshot = self._verify(self.repo, self.commit, self.tree)
        (self.repo / "input.txt").write_bytes(b"swapped after verification\n")
        with self.assertRaises(subject_binding.SubjectBindingError):
            subject_binding.assert_subject_snapshot_unchanged(snapshot)

    def test_malicious_git_environment_is_cleared(self) -> None:
        injected = {
            "GIT_DIR": str(self.root / "attacker-git-dir"),
            "GIT_WORK_TREE": str(self.root / "attacker-work-tree"),
            "GIT_OBJECT_DIRECTORY": str(self.root / "attacker-objects"),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(self.root / "attacker-alternates"),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": str(self.root / "attacker-hooks"),
        }
        real_run = subject_binding.subprocess.run
        observed_environments: list[dict[str, str]] = []

        def capture_run(*args: object, **kwargs: object) -> object:
            environment = kwargs.get("env")
            if isinstance(environment, dict):
                observed_environments.append(dict(environment))
            return real_run(*args, **kwargs)

        with mock.patch.dict(os.environ, injected, clear=False):
            with mock.patch.object(
                subject_binding.subprocess, "run", side_effect=capture_run
            ):
                snapshot = self._verify(self.repo, self.commit, self.tree)
        self.assertEqual(snapshot.binding.commit, self.commit)
        self.assertTrue(observed_environments)
        for environment in observed_environments:
            self.assertNotIn("GIT_DIR", environment)
            self.assertNotIn("GIT_WORK_TREE", environment)
            self.assertNotIn("GIT_OBJECT_DIRECTORY", environment)
            self.assertNotIn("GIT_ALTERNATE_OBJECT_DIRECTORIES", environment)
            self.assertNotIn("GIT_CONFIG_KEY_0", environment)
            self.assertNotIn("GIT_CONFIG_VALUE_0", environment)
            self.assertEqual(environment["GIT_CONFIG_COUNT"], "0")
            self.assertEqual(environment["GIT_LITERAL_PATHSPECS"], "1")
            self.assertEqual(environment["GIT_NO_LAZY_FETCH"], "1")
            self.assertEqual(environment["GIT_NO_REPLACE_OBJECTS"], "1")

    def test_object_id_width_case_and_json_type_confusion_are_rejected(self) -> None:
        self.assertEqual(
            subject_binding.parse_subject_binding("a" * 64, "b" * 64),
            subject_binding.SubjectBinding("a" * 64, "b" * 64),
        )
        invalid_pairs = (
            ("a" * 40, "b" * 64),
            ("A" * 40, "b" * 40),
            ("a" * 39, "b" * 40),
            (True, "b" * 40),
            (1, "b" * 40),
            ([], "b" * 40),
            ("a" * 40, False),
            ("a" * 40, {}),
        )
        for commit, tree in invalid_pairs:
            with self.subTest(commit_type=type(commit), tree_type=type(tree)):
                with self.assertRaises(subject_binding.SubjectBindingError):
                    subject_binding.parse_subject_binding(commit, tree)

    def test_sha256_repository_passes_when_supported(self) -> None:
        try:
            repo, commit, tree = self._create_repository("sha256")
        except RuntimeError as exc:
            self.skipTest(f"installed Git lacks SHA-256 repository support: {exc}")
        self.assertEqual(len(commit), 64)
        self.assertEqual(len(tree), 64)
        snapshot = self._verify(repo, commit, tree)
        self.assertEqual(snapshot.binding.commit, commit)
        self.assertEqual(snapshot.binding.tree, tree)

    def test_path_escape_duplicate_and_outside_tool_are_rejected(self) -> None:
        outside = self.root / "outside.py"
        outside.write_bytes(b"VALUE = 4\n")
        with self.assertRaisesRegex(subject_binding.SubjectBindingError, "inside"):
            subject_binding.verify_subject_repository(
                self.repo,
                self.commit,
                self.tree,
                frozen_paths=("input.txt",),
                tool_paths=(outside,),
            )
        with self.assertRaisesRegex(subject_binding.SubjectBindingError, "canonical"):
            subject_binding.verify_subject_repository(
                self.repo,
                self.commit,
                self.tree,
                frozen_paths=("../input.txt",),
                tool_paths=(self.repo / "tool.py",),
            )
        with self.assertRaisesRegex(subject_binding.SubjectBindingError, "duplicate"):
            subject_binding.verify_subject_repository(
                self.repo,
                self.commit,
                self.tree,
                frozen_paths=("tool.py",),
                tool_paths=(self.repo / "tool.py",),
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
