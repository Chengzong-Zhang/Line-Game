from __future__ import annotations

import contextlib
import copy
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from lifeline_rl import LifelineGame
from scripts.search_state_aliasing import classify_history_pair
from scripts import verify_targeted_history_twin as verifier_module
from scripts.search_targeted_history_twin import (
    DEFAULT_FIXTURE_PATH,
    EXPECTED_FIXTURE_SHA256,
    _load_reference,
    _sha256_file,
    _write_candidate_output,
    search_targeted_history_twin,
)
from scripts.verify_targeted_history_twin import (
    WEB_CANDIDATE_ACTION,
    WEB_REFERENCE_HISTORY,
    WEB_TWIN_HISTORY,
    _write_receipt,
    build_existing_web_candidate,
    run_tracked_web_replay,
    verify_candidate_file,
    verify_candidate_payload,
)


ROOT = Path(__file__).resolve().parents[1]
PERSISTED_CANDIDATE = (
    ROOT / "results" / "validation" / "history_superko_n6_strict_pair_candidate_v1.json"
)
PERSISTED_RECEIPT = (
    ROOT
    / "results"
    / "validation"
    / "history_superko_n6_strict_pair_verification_v1.json"
)
PERSISTED_TARGET_SEARCH = (
    ROOT
    / "results"
    / "validation"
    / "targeted_history_twin_n6_stage5_search_25k_v1.json"
)
PERSISTED_TARGET_RECEIPT = (
    ROOT
    / "results"
    / "validation"
    / "targeted_history_twin_n6_stage5_verification_v1.json"
)


class TargetedHistoryTwinSearchTests(unittest.TestCase):
    def test_frozen_reference_binding_and_natural_rejection(self) -> None:
        self.assertEqual(_sha256_file(DEFAULT_FIXTURE_PATH), EXPECTED_FIXTURE_SHA256)
        target = _load_reference()
        reference = LifelineGame(target.grid_size)
        reference.replay(target.reference_history)
        outcome = reference.evaluate_move(target.candidate_action)
        self.assertFalse(outcome.success)
        self.assertEqual(outcome.reason, "SUPERKO_VIOLATION")
        self.assertTrue(outcome.would_violate_superko)
        self.assertIn(target.forbidden_key, reference.history_hashes)

    def test_one_state_run_is_explicitly_budget_scoped(self) -> None:
        payload = search_targeted_history_twin(
            max_states=1,
            max_depth=2,
            max_seconds=10.0,
            progress_every=0,
        )
        result = payload["result"]
        self.assertEqual(result["status"], "NOT_FOUND_WITHIN_BUDGET")
        self.assertEqual(result["termination_reason"], "STATE_BUDGET")
        self.assertEqual(result["stats"]["states_examined"], 1)
        self.assertGreater(result["frontier_entries_valid"], 0)
        self.assertFalse(payload["claim_boundary"]["global_nonexistence_claimed"])
        self.assertFalse(payload["claim_boundary"]["search_space_exhausted_claimed"])
        self.assertFalse(payload["claim_boundary"]["a_star_claimed"])

    def test_depth_zero_cannot_be_mislabeled_exhaustive(self) -> None:
        payload = search_targeted_history_twin(
            max_states=10,
            max_depth=0,
            max_seconds=10.0,
            progress_every=0,
        )
        result = payload["result"]
        self.assertEqual(result["status"], "NOT_FOUND_WITHIN_BUDGET")
        self.assertEqual(
            result["termination_reason"],
            "FRONTIER_EMPTY_WITHIN_BOUNDED_CONFIGURATION",
        )
        self.assertEqual(result["stats"]["depth_cutoff_count"], 1)
        self.assertGreater(result["stats"]["depth_cutoff_action_candidates"], 0)
        self.assertEqual(result["frontier_entries_valid"], 0)

    def test_small_search_order_is_deterministic(self) -> None:
        first = search_targeted_history_twin(
            max_states=8,
            max_depth=3,
            max_seconds=10.0,
            progress_every=0,
        )
        second = search_targeted_history_twin(
            max_states=8,
            max_depth=3,
            max_seconds=10.0,
            progress_every=0,
        )
        for key in (
            "visited_trace_sha256",
            "frontier_sha256",
            "frontier_entries_valid",
        ):
            self.assertEqual(first["result"][key], second["result"][key])
        first_stats = dict(first["result"]["stats"])
        second_stats = dict(second["result"]["stats"])
        first_stats.pop("elapsed_seconds")
        second_stats.pop("elapsed_seconds")
        self.assertEqual(first_stats, second_stats)

    def test_progress_every_is_observable(self) -> None:
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            search_targeted_history_twin(
                max_states=1,
                max_depth=2,
                max_seconds=10.0,
                progress_every=1,
            )
        self.assertIn('"states_examined": 1', stream.getvalue())

    def test_persisted_target_search_replays_deterministically(self) -> None:
        persisted = json.loads(PERSISTED_TARGET_SEARCH.read_text(encoding="utf-8"))
        fresh = search_targeted_history_twin(
            max_states=25_000,
            max_depth=20,
            max_seconds=None,
            progress_every=0,
        )
        self.assertEqual(fresh["result"]["status"], "FOUND_CANDIDATE")
        self.assertEqual(fresh["result"]["termination_reason"], "FOUND")
        self.assertEqual(fresh["result"]["witness"], persisted["result"]["witness"])
        for key in (
            "visited_trace_sha256",
            "frontier_sha256",
            "frontier_entries_valid",
            "best_depth_state_count",
        ):
            self.assertEqual(fresh["result"][key], persisted["result"][key])
        fresh_stats = dict(fresh["result"]["stats"])
        persisted_stats = dict(persisted["result"]["stats"])
        fresh_stats.pop("elapsed_seconds")
        persisted_stats.pop("elapsed_seconds")
        self.assertEqual(fresh_stats, persisted_stats)

    def test_fixture_byte_change_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            changed = Path(directory) / "changed_fixture.json"
            changed.write_bytes(DEFAULT_FIXTURE_PATH.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "fixture SHA-256 mismatch"):
                _load_reference(changed)

    def test_candidate_output_is_create_only_and_avoids_frozen_roots(self) -> None:
        payload = {"schema_version": 1, "result": {"status": "TEST_ONLY"}}
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            output = Path(directory) / "candidate.json"
            _write_candidate_output(output, payload)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), payload)
            with self.assertRaises(FileExistsError):
                _write_candidate_output(output, payload)
        with self.assertRaisesRegex(ValueError, "frozen/formal"):
            _write_candidate_output(
                ROOT / "state_aliasing" / "must_not_write_candidate.json",
                payload,
            )


class TargetedHistoryTwinVerifierTests(unittest.TestCase):
    def test_existing_tracked_pair_passes_independent_replay(self) -> None:
        candidate = build_existing_web_candidate()
        receipt = verify_candidate_payload(candidate)
        self.assertEqual(receipt["status"], "PASS")
        self.assertTrue(receipt["ok"])
        verified = receipt["verified_witness"]
        self.assertTrue(verified["standard_initial_state_replay"])
        self.assertTrue(verified["same_mask_free_topology"])
        self.assertTrue(verified["different_superko_history_sets"])
        self.assertEqual(
            verified["reference_outcome"]["reason"],
            "SUPERKO_VIOLATION",
        )
        self.assertTrue(verified["twin_outcome"]["success"])
        self.assertEqual(verified["legal_only_in_reference"], [])
        self.assertEqual(verified["legal_only_in_twin"], [list(WEB_CANDIDATE_ACTION)])
        self.assertTrue(
            receipt["claim_boundary"][
                "decision_relevant_superko_legality_witness_verified"
            ]
        )
        self.assertFalse(
            receipt["claim_boundary"][
                "implemented_mask_bearing_topology_observation_equal"
            ]
        )

    @unittest.skipUnless(shutil.which("node"), "tracked Web replay requires Node.js")
    def test_tracked_web_replay_matches_the_python_candidate_exactly(self) -> None:
        candidate = build_existing_web_candidate()
        web_replay = run_tracked_web_replay(candidate)
        receipt = verify_candidate_payload(candidate, web_replay=web_replay)
        self.assertEqual(web_replay["status"], "PASS")
        self.assertEqual(web_replay["candidate_action"], list(WEB_CANDIDATE_ACTION))
        self.assertEqual(web_replay["legal_only_in_twin"], [list(WEB_CANDIDATE_ACTION)])
        self.assertTrue(receipt["claim_boundary"]["cross_engine_replay_verified"])

    def test_existing_pair_is_accepted_by_the_preexisting_direct_classifier(
        self,
    ) -> None:
        classified = classify_history_pair(
            6,
            WEB_REFERENCE_HISTORY,
            WEB_TWIN_HISTORY,
        )
        self.assertIsNotNone(classified)
        assert classified is not None
        self.assertEqual(classified["kind"], "history_superko_strict")
        self.assertTrue(classified["witness"]["strict"])
        self.assertEqual(classified["witness"]["action"], list(WEB_CANDIDATE_ACTION))

    def test_verifier_rejects_identical_histories(self) -> None:
        candidate = build_existing_web_candidate()
        forged = copy.deepcopy(candidate)
        forged["result"]["witness"]["twin_history"] = copy.deepcopy(
            forged["result"]["witness"]["reference_history"]
        )
        with self.assertRaisesRegex(ValueError, "histories are identical"):
            verify_candidate_payload(forged)

    def test_verifier_rejects_source_binding_tampering(self) -> None:
        candidate = build_existing_web_candidate()
        forged = copy.deepcopy(candidate)
        forged["input_binding"]["source_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "wrong source binding"):
            verify_candidate_payload(forged)

    def test_verifier_rejects_declared_replay_digest_tampering(self) -> None:
        candidate = build_existing_web_candidate()
        forged = copy.deepcopy(candidate)
        forged["result"]["witness"]["twin_state_fingerprint"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "does not replay"):
            verify_candidate_payload(forged)

    def test_existing_pair_cannot_masquerade_as_frozen_target_search(self) -> None:
        candidate = build_existing_web_candidate()
        forged = copy.deepcopy(candidate)
        forged["artifact_kind"] = "targeted_history_twin_search_candidate"
        forged["input_binding"] = {
            "fixture_path": "state_aliasing/superko_n6_witness_v1.json",
            "fixture_sha256": verifier_module.EXPECTED_FIXTURE_SHA256,
            "expected_fixture_sha256": verifier_module.EXPECTED_FIXTURE_SHA256,
            "fixture_id": "natural_superko_n6_witness_v1",
            "engine_core_sha256": verifier_module._sha256_file(
                verifier_module.CORE_PATH
            ),
            "search_script_sha256": verifier_module._sha256_file(
                verifier_module.SEARCH_PATH
            ),
        }
        forged["target"] = {
            "grid_size": 6,
            "candidate_action": list(WEB_CANDIDATE_ACTION),
            "reference_history": forged["result"]["witness"]["reference_history"],
        }
        with self.assertRaisesRegex(ValueError, "differs from the frozen target"):
            verify_candidate_payload(forged)

    def test_verifier_rejects_coordinate_type_coercion(self) -> None:
        candidate = build_existing_web_candidate()
        forged = copy.deepcopy(candidate)
        forged["result"]["witness"]["candidate_action"] = [True, 1]
        with self.assertRaisesRegex(ValueError, "strict integers"):
            verify_candidate_payload(forged)

    def test_candidate_file_and_create_only_receipt_round_trip(self) -> None:
        candidate = build_existing_web_candidate()
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            directory_path = Path(directory)
            candidate_path = directory_path / "candidate.json"
            candidate_path.write_text(
                json.dumps(candidate, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            receipt = verify_candidate_file(candidate_path)
            self.assertEqual(receipt["status"], "PASS")
            output = directory_path / "receipt.json"
            _write_receipt(output, receipt)
            persisted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                persisted["candidate_binding"]["candidate_sha256"],
                receipt["candidate_binding"]["candidate_sha256"],
            )
            with self.assertRaises(FileExistsError):
                _write_receipt(output, receipt)

    @unittest.skipUnless(
        shutil.which("node"), "persisted dual-engine receipt requires Node.js"
    )
    def test_persisted_candidate_and_receipt_revalidate(self) -> None:
        persisted_candidate = json.loads(
            PERSISTED_CANDIDATE.read_text(encoding="utf-8")
        )
        persisted_receipt = json.loads(PERSISTED_RECEIPT.read_text(encoding="utf-8"))
        self.assertEqual(persisted_candidate, build_existing_web_candidate())
        fresh = verify_candidate_file(PERSISTED_CANDIDATE, require_web_replay=True)
        for key in (
            "status",
            "ok",
            "candidate_binding",
            "source_binding",
            "verified_witness",
            "claim_boundary",
        ):
            self.assertEqual(persisted_receipt[key], fresh[key])
        persisted_cross = dict(persisted_receipt["cross_engine_replay"])
        fresh_cross = dict(fresh["cross_engine_replay"])
        persisted_cross.pop("node_version")
        fresh_cross.pop("node_version")
        self.assertEqual(persisted_cross, fresh_cross)
        self.assertEqual(
            PERSISTED_RECEIPT.read_bytes(),
            (json.dumps(persisted_receipt, indent=2, sort_keys=True) + "\n").encode(
                "utf-8"
            ),
        )

        def strings(value: object):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for nested in value.values():
                    yield from strings(nested)
            elif isinstance(value, list):
                for nested in value:
                    yield from strings(nested)

        for value in strings(persisted_receipt):
            self.assertFalse(len(value) >= 3 and value[1:3] in {":\\", ":/"})
            self.assertFalse(value.startswith("/"))

    @unittest.skipUnless(
        shutil.which("node"), "targeted dual-engine receipt requires Node.js"
    )
    def test_persisted_target_search_and_dual_engine_receipt_revalidate(self) -> None:
        search_payload = json.loads(PERSISTED_TARGET_SEARCH.read_text(encoding="utf-8"))
        persisted = json.loads(PERSISTED_TARGET_RECEIPT.read_text(encoding="utf-8"))
        self.assertEqual(search_payload["result"]["status"], "FOUND_CANDIDATE")
        self.assertEqual(search_payload["result"]["stats"]["states_examined"], 8)
        self.assertEqual(search_payload["result"]["stats"]["transitions_examined"], 69)
        self.assertFalse(
            search_payload["claim_boundary"]["found_candidate_is_verified_witness"]
        )
        fresh = verify_candidate_file(PERSISTED_TARGET_SEARCH, require_web_replay=True)
        for key in (
            "status",
            "ok",
            "candidate_binding",
            "source_binding",
            "verified_witness",
            "claim_boundary",
        ):
            self.assertEqual(persisted[key], fresh[key])
        persisted_cross = dict(persisted["cross_engine_replay"])
        fresh_cross = dict(fresh["cross_engine_replay"])
        persisted_cross.pop("node_version")
        fresh_cross.pop("node_version")
        self.assertEqual(persisted_cross, fresh_cross)
        self.assertTrue(persisted["claim_boundary"]["cross_engine_replay_verified"])
        self.assertEqual(
            persisted["cross_engine_replay"]["input_model"],
            "Both Web and Python verifiers consume the same persisted candidate JSON.",
        )
        self.assertEqual(
            persisted["verified_witness"]["legal_only_in_twin"],
            [[2, 3]],
        )


if __name__ == "__main__":
    unittest.main()
