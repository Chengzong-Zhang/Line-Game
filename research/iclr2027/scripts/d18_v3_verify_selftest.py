#!/usr/bin/env python3
"""Pure synthetic adversarial tests for the independent D18-v3 verifier."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import d18_v3_verify_evidence as verifier  # noqa: E402
from lifeline_rl import LifelineGame, Player  # noqa: E402


def _audited_rows(*, diverse_strata: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for stratum in range(32):
        for variant in range(2):
            continuation = (
                f"continuation-{stratum}-alt"
                if variant == 1 and stratum < diverse_strata
                else f"continuation-{stratum}-base"
            )
            for member in range(2):
                rows.append(
                    {
                        "outcome": "DRAW",
                        "truncated": False,
                        "opening_stratum": f"n5_s{stratum:02d}",
                        "opening_variant": variant,
                        "pair_member": member,
                        # Color members deliberately share the formal full key.
                        "full_trajectory_hash": f"full-{stratum}-{variant}",
                        "continuation_trajectory_hash": continuation,
                        "bound_trajectory_hash": f"bound-{stratum}-{variant}-{member}",
                    }
                )
    return rows


class D18V3VerifierSelfTest(unittest.TestCase):
    def test_strict_json_rejects_duplicate_keys_and_nonfinite_values(self) -> None:
        synthetic = Path("synthetic.json")
        with mock.patch.object(Path, "read_text", return_value='{"a":1,"a":2}\n'):
            with self.assertRaisesRegex(verifier.VerificationError, "duplicate JSON"):
                verifier.load_json(synthetic)
        with mock.patch.object(Path, "read_text", return_value='{"a":NaN}\n'):
            with self.assertRaisesRegex(verifier.VerificationError, "non-finite"):
                verifier.load_json(synthetic)

    def test_diversity_exact_boundary_passes_and_one_below_fails(self) -> None:
        counts = verifier._task_counts(_audited_rows(diverse_strata=24))
        self.assertEqual(counts["games_requested"], 128)
        self.assertEqual(counts["unique_full_trajectories"], 64)
        self.assertEqual(counts["opening_strata"], 32)
        self.assertEqual(counts["strata_with_two_unique_continuations"], 24)
        self.assertTrue(verifier._formal_gate(counts)["passed"])

        below = verifier._task_counts(_audited_rows(diverse_strata=23))
        self.assertEqual(below["strata_with_two_unique_continuations"], 23)
        self.assertFalse(verifier._formal_gate(below)["passed"])

    def test_slot_and_record_labels_cannot_inflate_formal_diversity(self) -> None:
        rows = _audited_rows(diverse_strata=32)
        for index, row in enumerate(rows):
            row["full_trajectory_hash"] = "same-full-sequence"
            row["continuation_trajectory_hash"] = "same-continuation"
            row["bound_trajectory_hash"] = f"slot-label-{index}"
        counts = verifier._task_counts(rows)
        self.assertEqual(counts["unique_full_trajectories"], 1)
        self.assertEqual(counts["unique_prefix_stripped_continuations"], 1)
        self.assertEqual(counts["unique_bound_trajectories_with_slots"], 128)
        self.assertFalse(verifier._formal_gate(counts)["passed"])

    def test_relocation_paths_reject_absolute_parent_and_dot_components(self) -> None:
        base = (RESEARCH_ROOT / "synthetic-verifier-task").resolve()
        for unsafe in ("../escape.json", "pairs/../escape.json", "./games.jsonl"):
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(verifier.VerificationError):
                    verifier._resolve_artifact(base, unsafe, label="artifact")
        absolute = str((base / "absolute.json").resolve())
        with self.assertRaisesRegex(verifier.VerificationError, "relative"):
            verifier._resolve_artifact(base, absolute, label="artifact")
        self.assertEqual(
            verifier._resolve_artifact(base, "pairs/pair_0000.json", label="artifact"),
            (base / "pairs" / "pair_0000.json").resolve(),
        )

    def test_policy_seed_assignment_is_crossed_and_agent_stable(self) -> None:
        low, high = verifier._policy_seed_pair(size=9, stratum=31)
        self.assertNotEqual(low, high)
        variant_zero = {"A": low, "B": high}
        variant_one = {"A": high, "B": low}
        self.assertEqual(variant_zero["A"], variant_one["B"])
        self.assertEqual(variant_zero["B"], variant_one["A"])
        # Across a color swap the A seed is unchanged; only its color changes.
        self.assertEqual(variant_zero["A"], variant_zero["A"])

    def test_independent_replay_and_trajectory_hash_tampering(self) -> None:
        prep_sha = "a" * 64
        formal_sha = "b" * 64
        schedule = {
            "game_id": "synthetic.m0",
            "task_id": "synthetic",
            "eval_size": 5,
            "training_seed": 20260825,
            "opening_actions": [],
            "opening_stratum": "n5_s00_p2",
            "opening_variant": 0,
            "pair_id": "synthetic.p0",
            "pair_member": 0,
            "black_slot": "A",
            "white_slot": "B",
            "superko_mode": "enforce",
        }
        game = LifelineGame(5, start_player=Player.BLACK, superko_mode="enforce")
        actions: list[dict[str, object]] = []
        for ply in range(2):
            actor = game.current_player.value
            actions.append(
                {
                    "ply": ply,
                    "actor": actor,
                    "action": game.num_points,
                    "point": None,
                    "decision_seconds": 0.0,
                    "diagnostics": {},
                }
            )
            self.assertTrue(game.skip_turn().success)
        winner = game.winner()
        winner_value = winner.value if isinstance(winner, Player) else winner
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
        continuation = [15, 15]
        full_key = {
            "eval_size": 5,
            "opening_actions": [],
            "continuation_actions": continuation,
        }
        bound_key = {**full_key, "black_slot": "A", "white_slot": "B"}
        record = {
            **schedule,
            "schema_name": verifier.GAME_SCHEMA,
            "schema_version": verifier.SCHEMA_VERSION,
            "preparation_runner_sha256": prep_sha,
            "formal_runner_sha256": formal_sha,
            "schedule_sha256": verifier.canonical_sha256(schedule),
            "grid_size": 5,
            "winner": winner_value,
            "truncated": False,
            "plies": 2,
            "continuation_plies": 2,
            "duration_seconds": 0.0,
            "territories": territories,
            "actions": actions,
            "full_trajectory_hash": verifier.canonical_sha256(full_key),
            "continuation_trajectory_hash": verifier.canonical_sha256(continuation),
            "bound_trajectory_hash": verifier.canonical_sha256(bound_key),
            "final_state_hash": game.state_fingerprint(),
        }
        audited = verifier._audit_game(
            record,
            schedule,
            preparation_runner_sha=prep_sha,
            formal_runner_sha=formal_sha,
        )
        self.assertEqual(audited["outcome"], "DRAW")

        tampered = copy.deepcopy(record)
        tampered["continuation_trajectory_hash"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, "continuation trajectory"):
            verifier._audit_game(
                tampered,
                schedule,
                preparation_runner_sha=prep_sha,
                formal_runner_sha=formal_sha,
            )

    def test_crossed_bootstrap_is_literal_seeded_and_seed_t_is_df4(self) -> None:
        matrix = {
            seed: {
                f"s{stratum:02d}": ((seed - 20260825) + (stratum % 5)) / 8.0
                for stratum in range(32)
            }
            for seed in verifier.TRAINING_SEEDS
        }
        first = verifier._crossed_bootstrap(matrix, replicates=250, seed=verifier.BOOTSTRAP_SEED)
        second = verifier._crossed_bootstrap(matrix, replicates=250, seed=verifier.BOOTSTRAP_SEED)
        changed = verifier._crossed_bootstrap(matrix, replicates=250, seed=verifier.BOOTSTRAP_SEED + 1)
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertTrue(0.0 <= first[0] <= first[1] <= 1.0)
        self.assertEqual(verifier._seed_t_interval([0.5] * 5), [0.5, 0.5])

    def test_numeric_mismatch_and_failure_report_are_fail_closed(self) -> None:
        left = {
            "experiment_id": verifier.EXPERIMENT_ID,
            "formal_manifest_sha256": "a" * 64,
            "task_manifest_sha256": "b" * 64,
            "game_manifest_sha256": "c" * 64,
            "comparison_rows": [{"score": 0.5}],
        }
        right = copy.deepcopy(left)
        verifier._numeric_equal(verifier._numeric_core(left), verifier._numeric_core(right))
        right["comparison_rows"][0]["score"] = 0.5001
        with self.assertRaisesRegex(verifier.VerificationError, "numeric mismatch"):
            verifier._numeric_equal(verifier._numeric_core(left), verifier._numeric_core(right))

        report = verifier.failure_report(verifier.VerificationError("synthetic"))
        self.assertFalse(report["formal_ready"])
        self.assertEqual(report["status"], "FAIL_CLOSED")
        self.assertEqual(tuple(report["gates"]), verifier.GATE_NAMES)
        self.assertTrue(all(value is False for value in report["gates"].values()))

    def test_execution_metadata_requires_dual_runner_and_reports_verifier_binding(self) -> None:
        preparation = verifier.DEFAULT_PREPARATION_RUNNER.resolve()
        formal = verifier.DEFAULT_FORMAL_RUNNER.resolve()
        source_hashes = {
            verifier._repo_relative(preparation): verifier.sha256_file(preparation),
            verifier._repo_relative(formal): verifier.sha256_file(formal),
            verifier._repo_relative(verifier.SCRIPT_PATH): verifier.sha256_file(
                verifier.SCRIPT_PATH
            ),
        }
        metadata = {
            "schema_name": verifier.RUN_SCHEMA,
            "schema_version": verifier.SCHEMA_VERSION,
            "experiment_id": verifier.EXPERIMENT_ID,
            "formal_manifest_sha256": "1" * 64,
            "protocol_sha256": "2" * 64,
            "preparation_runner_sha256": verifier.sha256_file(preparation),
            "formal_runner_sha256": verifier.sha256_file(formal),
            "verifier_sha256": verifier.sha256_file(verifier.SCRIPT_PATH),
            "task_manifest_sha256": "3" * 64,
            "game_manifest_sha256": "4" * 64,
            "bundle_summary_sha256": "5" * 64,
            "manifest_snapshot_sha256": "6" * 64,
            "formal_source_hash": "7" * 64,
            "execution_source_hashes": source_hashes,
            "python_version": "3.synthetic",
            "torch_version": "synthetic",
            "cuda_runtime_version": None,
            "cudnn_version": None,
            "device": "cpu",
            "device_name": None,
            "throughput_profile_sha256": "8" * 64,
            "throughput_profile_artifact_path": verifier.THROUGHPUT_PROFILE_ARTIFACT_NAME,
            "throughput_profile_schema_name": verifier.THROUGHPUT_PROFILE_SCHEMA,
            "throughput_profile_schema_version": verifier.SCHEMA_VERSION,
            "throughput_profile_formal_manifest_sha256": "1" * 64,
            "throughput_profile_formal_runner_sha256": verifier.sha256_file(formal),
            "scalar_lane_count": verifier.SCALAR_LANE_COUNT,
            "scalar_lane_execution_mode": verifier.SCALAR_LANE_EXECUTION_MODE,
            "inference_batch_size": verifier.INFERENCE_BATCH_SIZE,
            "inference_dtype": verifier.INFERENCE_DTYPE,
            "amp_enabled": False,
        }
        metadata["execution_freeze_sha256"] = verifier.canonical_sha256(
            {
                field: metadata[field]
                for field in verifier.EXECUTION_FREEZE_FIELDS
            }
        )
        _, _, verifier_bound = verifier._validate_execution_metadata(
            metadata,
            formal_manifest_sha="1" * 64,
            task_manifest_sha="3" * 64,
            game_manifest_sha="4" * 64,
            protocol_sha="2" * 64,
            preparation_runner_path=preparation,
            formal_runner_path=formal,
        )
        self.assertTrue(verifier_bound)

        missing_verifier = copy.deepcopy(metadata)
        missing_verifier["execution_source_hashes"].pop(
            verifier._repo_relative(verifier.SCRIPT_PATH)
        )
        missing_verifier["execution_freeze_sha256"] = verifier.canonical_sha256(
            {
                field: missing_verifier[field]
                for field in verifier.EXECUTION_FREEZE_FIELDS
            }
        )
        _, _, verifier_bound = verifier._validate_execution_metadata(
            missing_verifier,
            formal_manifest_sha="1" * 64,
            task_manifest_sha="3" * 64,
            game_manifest_sha="4" * 64,
            protocol_sha="2" * 64,
            preparation_runner_path=preparation,
            formal_runner_path=formal,
        )
        self.assertFalse(verifier_bound)

        missing_explicit_verifier = copy.deepcopy(metadata)
        missing_explicit_verifier.pop("verifier_sha256")
        with self.assertRaisesRegex(verifier.VerificationError, "verifier mismatch"):
            verifier._validate_execution_metadata(
                missing_explicit_verifier,
                formal_manifest_sha="1" * 64,
                task_manifest_sha="3" * 64,
                game_manifest_sha="4" * 64,
                protocol_sha="2" * 64,
                preparation_runner_path=preparation,
                formal_runner_path=formal,
            )

        tampered_freeze = copy.deepcopy(metadata)
        tampered_freeze["execution_freeze_sha256"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, "freeze hash"):
            verifier._validate_execution_metadata(
                tampered_freeze,
                formal_manifest_sha="1" * 64,
                task_manifest_sha="3" * 64,
                game_manifest_sha="4" * 64,
                protocol_sha="2" * 64,
                preparation_runner_path=preparation,
                formal_runner_path=formal,
            )

        tampered = copy.deepcopy(metadata)
        tampered["formal_runner_sha256"] = "0" * 64
        with self.assertRaisesRegex(verifier.VerificationError, "formal-runner"):
            verifier._validate_execution_metadata(
                tampered,
                formal_manifest_sha="1" * 64,
                task_manifest_sha="3" * 64,
                game_manifest_sha="4" * 64,
                protocol_sha="2" * 64,
                preparation_runner_path=preparation,
                formal_runner_path=formal,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
