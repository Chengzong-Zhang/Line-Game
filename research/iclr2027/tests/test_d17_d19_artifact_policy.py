from pathlib import Path
import shutil
import subprocess
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
GIT = shutil.which("git")
FAIL_CLOSED_ROOT = "research/iclr2027/results/formal/d17_d19/"


class D17D19ArtifactPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if GIT is None:
            raise RuntimeError("git is required to verify the artifact policy")

    def _check_ignore(self, relative_path: str) -> subprocess.CompletedProcess:
        completed = subprocess.run(
            [GIT, "check-ignore", "--no-index", "--verbose", "--", relative_path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        self.assertIn(
            completed.returncode,
            (0, 1),
            msg=(
                f"git check-ignore failed for {relative_path!r}: "
                f"stdout={completed.stdout!r}, stderr={completed.stderr!r}"
            ),
        )
        return completed

    def assertIgnoredByFailClosedRoot(self, relative_path: str) -> None:
        completed = self._check_ignore(relative_path)
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"generated artifact is not ignored: {relative_path}",
        )
        match_metadata = completed.stdout.partition("\t")[0]
        matched_pattern = match_metadata.rsplit(":", 1)[-1]
        self.assertEqual(
            matched_pattern,
            FAIL_CLOSED_ROOT,
            msg=(
                f"{relative_path} must be ignored by the fail-closed root rule, "
                f"not only by {matched_pattern!r}"
            ),
        )

    def assertTrackable(self, relative_path: str) -> None:
        completed = self._check_ignore(relative_path)
        self.assertEqual(
            completed.returncode,
            1,
            msg=(
                f"canonical input or policy file is unexpectedly ignored: "
                f"{relative_path}; match={completed.stdout!r}"
            ),
        )

    def test_generated_execution_artifacts_are_ignored_by_root_rule(self) -> None:
        generated_paths = (
            f"{FAIL_CLOSED_ROOT}run_future/formal_run/tasks/task_001/state.json",
            f"{FAIL_CLOSED_ROOT}run_future/formal_run/tasks/task_001/attempts/attempt_0001.failed.json",
            f"{FAIL_CLOSED_ROOT}run_future/task_bundle/game_manifest.jsonl",
            f"{FAIL_CLOSED_ROOT}run_future/task_bundle/tasks.jsonl",
            f"{FAIL_CLOSED_ROOT}run_future/autodl_stage/research/iclr2027/lifeline_rl/core.py",
            f"{FAIL_CLOSED_ROOT}run_future/runner_control/formal.stdout.txt",
            f"{FAIL_CLOSED_ROOT}run_future/recovery/task_001/state.json",
        )
        for relative_path in generated_paths:
            with self.subTest(relative_path=relative_path):
                self.assertIgnoredByFailClosedRoot(relative_path)

    def test_future_compact_evidence_is_still_ignored(self) -> None:
        future_candidate_paths = (
            f"{FAIL_CLOSED_ROOT}run_future/aggregate/aggregate.json",
            f"{FAIL_CLOSED_ROOT}run_future/summary/run_summary.json",
            f"{FAIL_CLOSED_ROOT}run_future/receipts/receipt_ledger.jsonl",
            f"{FAIL_CLOSED_ROOT}run_future/hashes/hash_manifest.json",
            f"{FAIL_CLOSED_ROOT}run_future/verification/independent_verification_report.md",
        )
        for relative_path in future_candidate_paths:
            with self.subTest(relative_path=relative_path):
                self.assertIgnoredByFailClosedRoot(relative_path)

    def test_canonical_inputs_and_policy_test_remain_trackable(self) -> None:
        trackable_paths = (
            "research/iclr2027/D17_D19_PROTOCOL.md",
            "research/iclr2027/D17_D19_ARTIFACT_ALLOWLIST_PLAN.md",
            "research/iclr2027/scripts/d17_d19_experiments.py",
            "research/iclr2027/scripts/d17_d19_runner.py",
            "research/iclr2027/configs/d17_d19_formal_manifest.json",
            "research/iclr2027/configs/d17_d19_openings_manifest.json",
            "research/iclr2027/tests/test_d17_d19_artifact_policy.py",
        )
        for relative_path in trackable_paths:
            with self.subTest(relative_path=relative_path):
                self.assertTrackable(relative_path)

    def test_no_d17_d19_negated_ignore_rule_exists(self) -> None:
        ignore_lines = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        negated_rules = [
            line.strip()
            for line in ignore_lines
            if line.strip().startswith("!") and "d17_d19" in line.casefold()
        ]
        self.assertEqual(negated_rules, [])


if __name__ == "__main__":
    unittest.main()
