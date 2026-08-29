from __future__ import annotations

import copy
import unittest
from pathlib import Path

from scripts import verify_superko_policy_matrix as verifier


ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = (
    ROOT
    / "results"
    / "smoke"
    / "superko_policy_matrix"
    / "superko_policy_matrix_revised_runner_preflight.json"
)


class VerifySuperkoPolicyMatrixTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.preflight = verifier.load_report(PREFLIGHT)

    def _random_only_report(self) -> dict[str, object]:
        report = copy.deepcopy(self.preflight)
        report["config"]["policies"] = ["random"]
        report["config"]["frozen_rl"]["requested"] = False
        report["config"]["frozen_rl"]["metadata"] = None
        report["conditions"] = [report["conditions"][0]]
        return report

    def test_revised_preflight_replays_and_verifies_checkpoint(self) -> None:
        result = verifier.verify_report(self.preflight)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["conditions_verified"], 2)
        self.assertEqual(result["blocks_verified"], 2)
        self.assertEqual(result["games_replayed"], 8)
        self.assertEqual(result["checkpoint_files_verified"], 1)

    def test_rejects_replayed_actor_tampering(self) -> None:
        report = self._random_only_report()
        action = report["conditions"][0]["blocks"][0]["orientations"][0]["enforce"]["actions"][0]
        action["actor"] = "WHITE" if action["actor"] == "BLACK" else "BLACK"
        with self.assertRaisesRegex(verifier.VerificationError, r"actions\[0\]\.actor"):
            verifier.verify_report(report)

    def test_rejects_summary_count_tampering(self) -> None:
        report = self._random_only_report()
        summary = report["conditions"][0]["summary"]["mode"]["observe"]
        summary["trigger_states"] += 1
        with self.assertRaisesRegex(verifier.VerificationError, r"trigger_states"):
            verifier.verify_report(report)

    def test_rejects_nonfinite_json_number(self) -> None:
        report = self._random_only_report()
        report["runtime"]["duration_seconds"] = float("nan")
        with self.assertRaisesRegex(verifier.VerificationError, r"non-finite"):
            verifier.verify_report(report)

    def test_rejects_checkpoint_identity_tampering(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["config"]["frozen_rl"]["metadata"]["checkpoint"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, r"checkpoint\.sha256"):
            verifier.verify_report(report)

    def test_formal_extension_requires_exact_fresh_seeds(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["purpose"] = "five_seed_extension"
        report["config"]["master_seeds"] = [*verifier.FORMAL_SEEDS[:-1], 123]
        report["config"]["uses_exact_frozen_seed_set"] = False
        with self.assertRaisesRegex(verifier.VerificationError, r"master_seeds"):
            verifier.verify_report(report, verify_formal_sidecars=False)

    def test_formal_cell_requires_five_blocks(self) -> None:
        report = copy.deepcopy(self.preflight)
        report["purpose"] = "five_seed_extension"
        config = report["config"]
        config["sizes"] = list(verifier.FORMAL_SIZES)
        config["policies"] = list(verifier.FORMAL_POLICIES)
        config["master_seeds"] = list(verifier.FORMAL_SEEDS)
        config["uses_exact_frozen_seed_set"] = True
        config["blocks_per_seed"] = 1
        config["bootstrap_resamples"] = 10_000
        config["formal_manifest"] = {"path": "unread-portable-manifest.json", "sha256": "0" * 64}
        template = report["conditions"][0]
        report["conditions"] = [
            {
                "policy": policy,
                "grid_size": size,
                "summary": template["summary"],
                "blocks": template["blocks"],
            }
            for policy in verifier.FORMAL_POLICIES
            for size in verifier.FORMAL_SIZES
        ]
        with self.assertRaisesRegex(
            verifier.VerificationError, r"formal cell must contain exactly five blocks"
        ):
            verifier.verify_report(report, verify_formal_sidecars=False)


if __name__ == "__main__":
    unittest.main()
