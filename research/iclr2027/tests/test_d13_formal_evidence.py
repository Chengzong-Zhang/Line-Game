from __future__ import annotations

import importlib.util
import json
import shutil
import unittest
from copy import deepcopy
from pathlib import Path


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None


@unittest.skipUnless(TORCH_AVAILABLE, "D13 formal evidence requires torch")
class D13FormalEvidenceTests(unittest.TestCase):
    @staticmethod
    def _learning() -> dict:
        return {
            "evidence_tier": "formal",
            "passed": True,
            "claim_eligible": True,
            "checkpoint": {
                "sha256": "a" * 64,
                "source_hash": "b" * 64,
                "strict_source_verified": True,
            },
            "observed": {
                "model_kind": "topology_gnn",
                "games_completed": 100,
                "gradient_steps": 200,
            },
        }

    @staticmethod
    def _arena() -> dict:
        return {
            "evidence_tier": "formal",
            "gate_kind": "beat_random",
            "gate_passed": True,
            "claim_eligible": True,
            "checkpoint_file_verification_skipped": False,
            "checkpoint_identities": {
                "A": {
                    "sha256": "a" * 64,
                    "source_hash": "b" * 64,
                    "model_kind": "topology_gnn",
                }
            },
            "games_replayed": 200,
        }

    def test_joint_gate_requires_same_formal_checkpoint(self) -> None:
        from scripts.verify_d13_formal_evidence import validate_d13_joint_evidence

        result = validate_d13_joint_evidence(self._learning(), self._arena())
        self.assertTrue(result["claim_eligible"])
        self.assertEqual(result["checkpoint_sha256"], "a" * 64)

        mismatched = deepcopy(self._arena())
        mismatched["checkpoint_identities"]["A"]["sha256"] = "c" * 64
        with self.assertRaisesRegex(ValueError, "different checkpoint SHA-256"):
            validate_d13_joint_evidence(self._learning(), mismatched)

    def test_joint_gate_rejects_exploratory_or_skipped_evidence(self) -> None:
        from scripts.verify_d13_formal_evidence import validate_d13_joint_evidence

        smoke = deepcopy(self._learning())
        smoke["evidence_tier"] = "smoke"
        smoke["claim_eligible"] = False
        with self.assertRaisesRegex(ValueError, "not formal"):
            validate_d13_joint_evidence(smoke, self._arena())

        skipped = deepcopy(self._arena())
        skipped["checkpoint_file_verification_skipped"] = True
        with self.assertRaisesRegex(ValueError, "not strict formal"):
            validate_d13_joint_evidence(self._learning(), skipped)

    def test_joint_report_is_atomic_and_immutable(self) -> None:
        from scripts.verify_d13_formal_evidence import (
            validate_d13_joint_evidence,
            write_joint_report,
        )

        output = Path(__file__).parent / "_d13_joint_report_test"
        if output.exists():
            shutil.rmtree(output)
        try:
            report = validate_d13_joint_evidence(self._learning(), self._arena())
            path = output / "joint.json"
            write_joint_report(report, path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)
            self.assertFalse(list(output.glob(".*.tmp")))
            with self.assertRaises(FileExistsError):
                write_joint_report(report, path)
        finally:
            if output.exists():
                shutil.rmtree(output)


if __name__ == "__main__":
    unittest.main()
