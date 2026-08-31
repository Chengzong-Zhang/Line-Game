from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import build_supplement_candidate as builder  # noqa: E402


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SupplementBuilderSelfTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = TOOL_DIR / (
            f"_selftest_workspace_{os.getpid()}_{self._testMethodName}"
        )
        self.root.mkdir()
        self.source = self.root / "source"
        self.source.mkdir()
        self.identity_file = self.root / "identity_terms.json"
        self.identity_file.write_text(
            json.dumps(
                ["private-identity-never-present", "private-id-99887766"],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        if self.root.exists() and self.root.parent == TOOL_DIR:
            shutil.rmtree(self.root)

    def write_allowlist(
        self,
        rows: list[dict[str, str]],
        *,
        require_git_tracked: bool = False,
        name: str = "allowlist.json",
    ) -> Path:
        path = self.root / name
        payload = {
            "schema_version": 1,
            "status": builder.STATUS,
            "package_name": "selftest_candidate",
            "purpose": "isolated deterministic self-test",
            "require_git_tracked": require_git_tracked,
            "limits": {
                "max_file_bytes": 1024 * 1024,
                "max_total_bytes": 2 * 1024 * 1024,
            },
            "files": rows,
        }
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return path

    @staticmethod
    def row(
        source: str,
        destination: str,
        data: bytes,
        category: str = "selftest_payload",
    ) -> dict[str, str]:
        return {
            "source": source,
            "destination": destination,
            "category": category,
            "expected_sha256": sha256(data),
        }

    def build_one(self, data: bytes = b"safe payload\n") -> tuple[Path, Path]:
        source_file = self.source / "safe.txt"
        source_file.write_bytes(data)
        allowlist = self.write_allowlist(
            [self.row("safe.txt", "payload/safe.txt", data)]
        )
        output = self.root / "candidate"
        result = builder.build_candidate(
            self.source,
            allowlist,
            output,
            self.identity_file,
        )
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["candidate_status"], builder.STATUS)
        return allowlist, output

    def test_valid_build_verify_and_unlisted_source_exclusion(self) -> None:
        (self.source / "not_allowlisted.txt").write_text(
            "this file must not be copied\n", encoding="utf-8"
        )
        allowlist, output = self.build_one()
        self.assertFalse((output / "not_allowlisted.txt").exists())
        result = builder.verify_candidate(output, allowlist, self.identity_file)
        self.assertEqual(result["status"], "PASS")
        tree = (output / builder.TREE_NAME).read_text(encoding="utf-8")
        self.assertNotIn("not_allowlisted", tree)

    def test_generic_cli_subject_arguments_are_truly_optional(self) -> None:
        build_args = builder._parser().parse_args(
            [
                "build",
                "--output",
                str(self.root / "unused-candidate"),
                "--identity-file",
                str(self.identity_file),
            ]
        )
        verify_args = builder._parser().parse_args(
            [
                "verify",
                "--candidate",
                str(self.root / "unused-candidate"),
                "--identity-file",
                str(self.identity_file),
            ]
        )
        for observed in (build_args, verify_args):
            self.assertIsNone(observed.subject_root)
            self.assertIsNone(observed.subject_commit)
            self.assertIsNone(observed.subject_tree)

    def test_repeated_builds_are_byte_identical(self) -> None:
        data = b"deterministic payload\n"
        (self.source / "safe.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("safe.txt", "safe.txt", data)])
        first = self.root / "candidate_a"
        second = self.root / "candidate_b"
        builder.build_candidate(self.source, allowlist, first, self.identity_file)
        builder.build_candidate(self.source, allowlist, second, self.identity_file)
        first_files = {
            path.relative_to(first).as_posix(): path.read_bytes()
            for path in first.rglob("*")
            if path.is_file()
        }
        second_files = {
            path.relative_to(second).as_posix(): path.read_bytes()
            for path in second.rglob("*")
            if path.is_file()
        }
        self.assertEqual(first_files, second_files)

    def test_existing_output_is_never_overwritten(self) -> None:
        data = b"safe payload\n"
        (self.source / "safe.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("safe.txt", "safe.txt", data)])
        output = self.root / "candidate"
        output.mkdir()
        sentinel = output / "sentinel.txt"
        sentinel.write_text("preserve me\n", encoding="utf-8")
        with self.assertRaises(builder.CandidateError):
            builder.build_candidate(self.source, allowlist, output, self.identity_file)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve me\n")

    def test_absolute_path_content_is_rejected_without_leaking_match(self) -> None:
        data = b"cache = C:\\Users\\private-user\\model.bin\n"
        (self.source / "bad.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("bad.txt", "bad.txt", data)])
        output = self.root / "candidate"
        with self.assertRaises(builder.CandidateError) as caught:
            builder.build_candidate(self.source, allowlist, output, self.identity_file)
        self.assertIn("windows_absolute_path", str(caught.exception))
        self.assertNotIn("private-user", str(caught.exception))
        self.assertFalse(output.exists())

    def test_public_https_url_is_not_misclassified_as_a_windows_path(self) -> None:
        allowlist, output = self.build_one(
            b"index = https://download.pytorch.org/whl/cu118\n"
        )
        result = builder.verify_candidate(output, allowlist, self.identity_file)
        self.assertEqual(result["privacy_scan"], "PASS")

    def test_credential_content_is_rejected_without_leaking_match(self) -> None:
        data = b'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"\n'
        (self.source / "bad.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("bad.txt", "bad.txt", data)])
        output = self.root / "candidate"
        with self.assertRaises(builder.CandidateError) as caught:
            builder.build_candidate(self.source, allowlist, output, self.identity_file)
        self.assertIn("known_token_shape", str(caught.exception))
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", str(caught.exception))
        self.assertFalse(output.exists())

    def test_identity_term_is_rejected(self) -> None:
        data = b"private-identity-never-present\n"
        (self.source / "bad.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("bad.txt", "bad.txt", data)])
        with self.assertRaises(builder.CandidateError) as caught:
            builder.build_candidate(
                self.source,
                allowlist,
                self.root / "candidate",
                self.identity_file,
            )
        self.assertIn("private_identity_term_1", str(caught.exception))
        self.assertNotIn("private-identity-never-present", str(caught.exception))

    def test_symlink_source_is_rejected(self) -> None:
        data = b"safe target\n"
        target = self.source / "target.txt"
        target.write_bytes(data)
        link = self.source / "link.txt"
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symlink creation is unavailable: {exc}")
        allowlist = self.write_allowlist([self.row("link.txt", "link.txt", data)])
        with self.assertRaises(builder.CandidateError):
            builder.build_candidate(
                self.source,
                allowlist,
                self.root / "candidate",
                self.identity_file,
            )

    def test_reparse_flag_is_rejected_even_without_symlink_privilege(self) -> None:
        data = b"safe-looking reparse payload\n"
        (self.source / "link.txt").write_bytes(data)
        allowlist = self.write_allowlist([self.row("link.txt", "link.txt", data)])

        def simulated_reparse(path: Path) -> bool:
            return Path(path).name == "link.txt"

        with mock.patch.object(builder, "_is_reparse", side_effect=simulated_reparse):
            with self.assertRaises(builder.CandidateError):
                builder.build_candidate(
                    self.source,
                    allowlist,
                    self.root / "candidate",
                    self.identity_file,
                )

    def test_extra_candidate_file_and_payload_tamper_are_rejected(self) -> None:
        allowlist, output = self.build_one()
        (output / "extra.txt").write_text("extra\n", encoding="utf-8")
        with self.assertRaises(builder.CandidateError):
            builder.verify_candidate(output, allowlist, self.identity_file)
        (output / "extra.txt").unlink()
        (output / "payload" / "safe.txt").write_text("tampered\n", encoding="utf-8")
        with self.assertRaises(builder.CandidateError):
            builder.verify_candidate(output, allowlist, self.identity_file)

    def test_absolute_destination_and_forbidden_source_tree_are_rejected(self) -> None:
        data = b"safe\n"
        (self.source / "safe.txt").write_bytes(data)
        absolute = self.write_allowlist(
            [self.row("safe.txt", "/escape.txt", data)], name="absolute.json"
        )
        with self.assertRaises(builder.CandidateError):
            builder.load_allowlist(absolute)

        environment_destination = self.write_allowlist(
            [self.row("safe.txt", ".env", data)], name="environment.json"
        )
        with self.assertRaises(builder.CandidateError):
            builder.load_allowlist(environment_destination)

        forbidden_dir = self.source / "local_artifacts"
        forbidden_dir.mkdir()
        (forbidden_dir / "safe.txt").write_bytes(data)
        forbidden = self.write_allowlist(
            [self.row("local_artifacts/safe.txt", "safe.txt", data)],
            name="forbidden.json",
        )
        with self.assertRaises(builder.CandidateError):
            builder.load_allowlist(forbidden)

    def test_default_project_allowlist_builds_verifies_and_runs_checks(self) -> None:
        repo_root = TOOL_DIR.parents[2]
        allowlist = TOOL_DIR / "supplement_allowlist.json"
        output = self.root / "project_candidate"
        result = builder.build_candidate(
            repo_root,
            allowlist,
            output,
            self.identity_file,
        )
        self.assertEqual(result["status"], "PASS")
        verified = builder.verify_candidate(output, allowlist, self.identity_file)
        self.assertEqual(verified["privacy_scan"], "PASS")
        completed = subprocess.run(
            [
                sys.executable,
                "-B",
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-t",
                ".",
                "-p",
                "test_*.py",
            ],
            cwd=output,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=(completed.stdout + "\n" + completed.stderr),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
