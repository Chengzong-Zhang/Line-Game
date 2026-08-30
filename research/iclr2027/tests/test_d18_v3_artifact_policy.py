"""Fail-closed Git policy for generated D18-v3 formal artifacts."""

from pathlib import Path
import shutil
import subprocess
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
GIT = shutil.which("git")
FAIL_CLOSED_ROOT = "research/iclr2027/results/formal/d18_v3/"


class D18V3ArtifactPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if GIT is None:
            raise RuntimeError("git is required to verify the artifact policy")

    def _check_ignore(self, relative_path: str) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [GIT, "check-ignore", "--no-index", "--verbose", "--", relative_path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        self.assertIn(completed.returncode, (0, 1), msg=completed.stderr)
        return completed

    def assertIgnoredByRoot(self, relative_path: str) -> None:
        completed = self._check_ignore(relative_path)
        self.assertEqual(completed.returncode, 0, msg=relative_path)
        metadata = completed.stdout.partition("\t")[0]
        self.assertEqual(metadata.rsplit(":", 1)[-1], FAIL_CLOSED_ROOT)

    def assertTrackable(self, relative_path: str) -> None:
        completed = self._check_ignore(relative_path)
        self.assertEqual(
            completed.returncode,
            1,
            msg=f"unexpected ignore match for {relative_path}: {completed.stdout!r}",
        )

    def test_generated_tree_is_ignored_by_the_root_rule(self) -> None:
        generated = (
            f"{FAIL_CLOSED_ROOT}run_v1/task_bundle/tasks.jsonl",
            f"{FAIL_CLOSED_ROOT}run_v1/task_bundle/game_manifest.jsonl",
            f"{FAIL_CLOSED_ROOT}run_v1/formal_run/tasks/task_001/state.json",
            f"{FAIL_CLOSED_ROOT}run_v1/formal_run/tasks/task_001/pairs/pair_0000.json",
            f"{FAIL_CLOSED_ROOT}run_v1/formal_run/result_receipts.jsonl",
            f"{FAIL_CLOSED_ROOT}run_v1/autodl_stage/stage_manifest.json",
            f"{FAIL_CLOSED_ROOT}run_v1/verification/independent_report.json",
        )
        for relative_path in generated:
            with self.subTest(relative_path=relative_path):
                self.assertIgnoredByRoot(relative_path)

    def test_canonical_sources_remain_trackable(self) -> None:
        canonical = (
            "research/iclr2027/D18_V3_PROTOCOL.md",
            "research/iclr2027/D18_V3_ARTIFACT_POLICY.md",
            "research/iclr2027/configs/d18_v3_formal_manifest.json",
            "research/iclr2027/configs/d18_v3_paired_openings_manifest.json",
            "research/iclr2027/scripts/d18_v3_runner.py",
            "research/iclr2027/scripts/d18_v3_formal_runner.py",
            "research/iclr2027/tests/test_d18_v3_artifact_policy.py",
        )
        for relative_path in canonical:
            with self.subTest(relative_path=relative_path):
                self.assertTrackable(relative_path)

    def test_no_negated_d18_v3_rule_exists(self) -> None:
        lines = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        negated = [
            line.strip()
            for line in lines
            if line.strip().startswith("!") and "d18_v3" in line.casefold()
        ]
        self.assertEqual(negated, [])


if __name__ == "__main__":
    unittest.main()
