from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.d14_d16_experiments import (
    RESULT_SCHEMA_NAME,
    ProtocolError,
    aggregate_results,
    audit_parameter_counts,
    current_execution_identity,
    generate_tasks,
    load_manifest,
    manifest_hash,
    validate_manifest,
    validate_result_ledger,
    write_task_bundle,
)


FORMAL_MANIFEST = ROOT / "configs" / "d14_d16_formal_manifest.json"

_BASELINE_CLASSES = {
    "random": "lifeline_rl.agents.random_agent.RandomAgent",
    "greedy": "lifeline_rl.agents.greedy.GreedyAgent",
    "minimax-2": "lifeline_rl.agents.minimax.MinimaxAgent",
    "minimax-3": "lifeline_rl.agents.minimax.MinimaxAgent",
    "mcts": "lifeline_rl.agents.mcts.MCTSAgent",
}


def _runtime_identity() -> dict:
    import torch

    return {
        **current_execution_identity(),
        "cuda_runtime_version": torch.version.cuda,
        "cudnn_version": torch.backends.cudnn.version(),
        "device": "cpu",
        "device_name": None,
        "cublas_workspace_config": os.environ.get("CUBLAS_WORKSPACE_CONFIG"),
    }


@contextmanager
def _synthetic_artifact_validation():
    with patch(
        "scripts.d14_d16_experiments._validate_training_artifacts",
        return_value=[],
    ), patch(
        "scripts.d14_d16_experiments._validate_evaluation_artifacts",
        return_value=None,
    ):
        yield


def _complete_results(manifest: dict) -> list[dict]:
    tasks = generate_tasks(manifest)
    digest = manifest_hash(manifest)
    parameter_counts = {
        entry["id"]: entry["expected_trainable_parameters"]
        for entry in manifest["representations"]
    }
    records: list[dict] = []
    identity = _runtime_identity()
    checkpoint_index: dict[tuple[str, int], dict] = {}
    for task in tasks["training"]:
        budget = task["training_budget"]
        final_step = task["required_checkpoint_gradient_steps"][-1]
        snapshots = []
        for step in task["required_checkpoint_gradient_steps"]:
            fraction = step / final_step
            snapshots.append(
                {
                    "gradient_steps": step,
                    "self_play_games": max(1, round(budget["self_play_games"] * fraction)),
                    "environment_steps": max(1, round(20_000 * fraction)),
                    "loss": 2.0 - fraction,
                    "policy_loss": 1.5 - 0.5 * fraction,
                    "value_loss": 0.5 - 0.25 * fraction,
                    "wall_clock_seconds": 1000.0 * fraction,
                }
            )
        artifacts = []
        for step in task["required_checkpoint_gradient_steps"]:
            checkpoint_sha = hashlib.sha256(
                f"{task['task_id']}:{step}:checkpoint".encode("utf-8")
            ).hexdigest()
            config_hash = hashlib.sha256(
                f"{task['task_id']}:config".encode("utf-8")
            ).hexdigest()
            artifact = {
                "gradient_steps": step,
                "checkpoint_sha256": checkpoint_sha,
                "config_hash": config_hash,
                "source_hash": identity["trainer_source_hash"],
            }
            artifacts.append(artifact)
            checkpoint_index[(task["task_id"], step)] = artifact
        records.append(
            {
                "schema_name": RESULT_SCHEMA_NAME,
                "schema_version": 1,
                "experiment_id": manifest["experiment_id"],
                "manifest_sha256": digest,
                "evidence_tier": manifest["evidence_tier"],
                "task_id": task["task_id"],
                "execution_identity": identity,
                "status": "complete",
                "representation": task["representation"],
                "board_sizes": task["board_sizes"],
                "seed": task["seed"],
                "parameter_count": parameter_counts[task["representation"]],
                "training_budget": budget,
                "puct_simulations": budget["puct_simulations"],
                "self_play_games_completed": budget["self_play_games"],
                "gradient_steps_completed": budget["gradient_steps"],
                "environment_steps_completed": 20_000,
                "checkpoint_gradient_steps": task["required_checkpoint_gradient_steps"],
                "curve_snapshots": snapshots,
                "checkpoint_artifacts": artifacts,
                "wall_clock_seconds": 1000.0,
            }
        )
    for task in tasks["evaluation"]:
        games = task["games"]

        def binding(spec: dict) -> dict:
            if spec["kind"] == "search_baseline":
                return {
                    "kind": "search_baseline",
                    "agent_kind": spec["agent_kind"],
                    "class": _BASELINE_CLASSES[spec["agent_kind"]],
                    "name": spec.get("baseline_id", spec["agent_kind"]),
                    "config": spec.get("config"),
                }
            artifact = checkpoint_index[
                (spec["training_task_id"], spec["gradient_steps"])
            ]
            return {
                "kind": "learned_checkpoint",
                "class": "lifeline_rl.alphazero.neural_agent.NeuralPUCTAgent",
                "name": spec["representation"],
                "representation": spec["representation"],
                "training_task_id": spec["training_task_id"],
                "gradient_steps": spec["gradient_steps"],
                "parameter_count": parameter_counts[spec["representation"]],
                "search": spec["search"],
                "checkpoint_sha256": artifact["checkpoint_sha256"],
                "checkpoint_config_hash": artifact["config_hash"],
                "checkpoint_source_hash": artifact["source_hash"],
            }

        records.append(
            {
                "schema_name": RESULT_SCHEMA_NAME,
                "schema_version": 1,
                "experiment_id": manifest["experiment_id"],
                "manifest_sha256": digest,
                "evidence_tier": manifest["evidence_tier"],
                "task_id": task["task_id"],
                "execution_identity": identity,
                "status": "complete",
                "train_sizes": task["train_sizes"],
                "eval_size": task["eval_size"],
                "seed": task["seed"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "games_requested": games,
                "games_completed": games,
                "truncated_games": 0,
                "a_as_black_games": games // 2,
                "a_as_white_games": games // 2,
                "color_pairs_verified": games // 2,
                "color_balance": task["color_balance"],
                "replay_verified_games": games,
                "max_plies": task["max_plies"],
                "superko_mode": task["superko_mode"],
                "a_wins": games // 2,
                "a_losses": games // 2,
                "draws": 0,
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
                "agent_bindings": {
                    "A": binding(task["agent_a"]),
                    "B": binding(task["agent_b"]),
                },
            }
        )
    return records


class D14D16ExperimentProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_manifest(FORMAL_MANIFEST)

    def test_formal_manifest_generates_complete_deterministic_matrix(self) -> None:
        audit = validate_manifest(self.manifest)
        tasks = generate_tasks(self.manifest)
        self.assertEqual(audit["training_tasks"], 15)
        self.assertEqual(audit["evaluation_tasks"], 315)
        self.assertEqual(len(tasks["training"]), 15)
        self.assertEqual(len(tasks["evaluation"]), 315)
        self.assertEqual(
            len({task["task_id"] for task in tasks["training"] + tasks["evaluation"]}),
            330,
        )
        self.assertTrue(
            all(
                task["games"]
                == (20 if task["evaluation_kind"] == "learning_curve" else 200)
                for task in tasks["evaluation"]
            )
        )
        self.assertTrue(all(task["board_sizes"] == [5, 7, 9] for task in tasks["training"]))
        final_mcts = [
            task
            for task in tasks["evaluation"]
            if task["evaluation_kind"] == "final_vs_search"
            and task["agent_b"].get("baseline_id") == "uct_mcts_16"
        ]
        self.assertEqual(len(final_mcts), 45)
        self.assertTrue(all(task["purposes"] == ["final_vs_search", "learning_curve"] for task in final_mcts))

    def test_task_bundle_refuses_directory_reuse(self) -> None:
        output = ROOT / "tests" / f"_d14_d16_task_bundle_test_{uuid.uuid4().hex}"
        try:
            summary = write_task_bundle(self.manifest, output)
            self.assertEqual(summary["training_tasks"], 15)
            self.assertEqual(
                len((output / "evaluation_tasks.jsonl").read_text(encoding="utf-8").splitlines()),
                315,
            )
            with self.assertRaises(ProtocolError):
                write_task_bundle(self.manifest, output)
        finally:
            if output.exists():
                shutil.rmtree(output)

    def test_duplicate_seed_is_rejected_before_task_generation(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["seeds"][-1] = manifest["seeds"][0]
        with self.assertRaisesRegex(ProtocolError, "seeds must not contain duplicates"):
            validate_manifest(manifest)

    def test_schedule_products_checkpoint_mapping_and_warmup_are_frozen(self) -> None:
        manifest = copy.deepcopy(self.manifest)
        manifest["training_budget"]["self_play_games"] = 99
        with self.assertRaisesRegex(ProtocolError, "must equal self_play_games"):
            validate_manifest(manifest)

        manifest = copy.deepcopy(self.manifest)
        manifest["evaluation"]["checkpoint_gradient_steps"][0] = 39
        with self.assertRaisesRegex(ProtocolError, "exactly map checkpoint iterations"):
            validate_manifest(manifest)

        manifest = copy.deepcopy(self.manifest)
        manifest["training_budget"]["batch_size"] = 21
        with self.assertRaisesRegex(ProtocolError, "optimizer updates cannot be skipped"):
            validate_manifest(manifest)

    def test_parameter_audit_enforces_frozen_counts_and_one_percent_spread(self) -> None:
        counts = []
        values = {
            entry["id"]: entry["expected_trainable_parameters"]
            for entry in self.manifest["representations"]
        }
        for representation, count in values.items():
            counts.append(
                {
                    "representation": representation,
                    "parameter_count": count,
                }
            )
        audit = audit_parameter_counts(self.manifest, counts, require_seed_matrix=False)
        self.assertTrue(audit["pass"])
        self.assertLess(audit["groups"][0]["relative_spread"], 0.01)
        counts[0]["parameter_count"] -= 1
        with self.assertRaisesRegex(ProtocolError, "expected .* frozen dry-run"):
            audit_parameter_counts(self.manifest, counts, require_seed_matrix=False)

    def test_formal_aggregate_keeps_all_five_seeds(self) -> None:
        with _synthetic_artifact_validation():
            aggregate = aggregate_results(self.manifest, _complete_results(self.manifest))
        self.assertTrue(aggregate["formal_ready"])
        self.assertEqual(aggregate["receipts"], {
            "training": 15,
            "evaluation": 315,
            "failed_training": 0,
            "failed_evaluation": 0,
        })
        self.assertEqual(len(aggregate["training_curve"]), 15)
        self.assertEqual(len(aggregate["arena_learning_curve"]), 45)
        self.assertEqual(len(aggregate["final_vs_search"]), 18)
        self.assertEqual(len(aggregate["representation_round_robin"]), 9)
        self.assertTrue(all(row["seed_receipts"] == 5 for row in aggregate["final_vs_search"]))

    def test_missing_duplicate_and_mixed_tier_receipts_are_rejected(self) -> None:
        records = _complete_results(self.manifest)
        with self.assertRaisesRegex(ProtocolError, "missing 1 task receipts"):
            validate_result_ledger(self.manifest, records[:-1])

        duplicated = records + [copy.deepcopy(records[0])]
        with self.assertRaisesRegex(ProtocolError, "duplicate result receipt"):
            validate_result_ledger(self.manifest, duplicated)

        mixed = copy.deepcopy(records)
        mixed[0]["evidence_tier"] = "pilot"
        with self.assertRaisesRegex(ProtocolError, "mixed evidence tiers"):
            validate_result_ledger(self.manifest, mixed)

    def test_non_color_balanced_or_non_replayed_formal_result_is_rejected(self) -> None:
        records = _complete_results(self.manifest)
        first_evaluation = next(record for record in records if "games_requested" in record)
        first_evaluation["a_as_white_games"] = 99
        with _synthetic_artifact_validation(), self.assertRaisesRegex(
            ProtocolError, "not a verified same-seed color swap"
        ):
            validate_result_ledger(self.manifest, records)

        records = _complete_results(self.manifest)
        first_evaluation = next(record for record in records if "games_requested" in record)
        first_evaluation["replay_verified_games"] = 199
        with _synthetic_artifact_validation(), self.assertRaisesRegex(
            ProtocolError, "every arena game must pass replay"
        ):
            validate_result_ledger(self.manifest, records)

    def test_compute_mismatch_is_rejected(self) -> None:
        records = _complete_results(self.manifest)
        first_training = next(record for record in records if "training_budget" in record)
        first_training["gradient_steps_completed"] -= 1
        with _synthetic_artifact_validation(), self.assertRaisesRegex(
            ProtocolError, "gradient-step budget mismatch"
        ):
            validate_result_ledger(self.manifest, records)

    def test_execution_identity_mixing_and_source_drift_are_rejected(self) -> None:
        records = _complete_results(self.manifest)
        records[0]["execution_identity"] = {
            **records[0]["execution_identity"],
            "runner_sha256": "0" * 64,
        }
        with self.assertRaisesRegex(ProtocolError, "mixes trainer source or runner"):
            validate_result_ledger(self.manifest, records)

        records = _complete_results(self.manifest)
        for record in records:
            record["execution_identity"] = {
                **record["execution_identity"],
                "protocol_sha256": "0" * 64,
            }
        with self.assertRaisesRegex(ProtocolError, "differs from the current frozen sources"):
            validate_result_ledger(self.manifest, records)

    def test_declared_failed_seed_is_retained_and_blocks_formal_ready(self) -> None:
        records = _complete_results(self.manifest)
        first_training = next(record for record in records if "training_budget" in record)
        first_training["status"] = "failed"
        first_training["failure_reason"] = "intentional fixture failure"
        for record in records:
            specs = record.get("agent_specs", {})
            if any(
                spec.get("training_task_id") == first_training["task_id"]
                for spec in specs.values()
            ):
                record["status"] = "failed"
                record["failure_reason"] = "dependency fixture failure"
        with _synthetic_artifact_validation():
            aggregate = aggregate_results(self.manifest, records)
        self.assertFalse(aggregate["formal_ready"])
        self.assertEqual(aggregate["receipts"]["failed_training"], 1)
        self.assertEqual(aggregate["failed_runs"][0]["task_id"], first_training["task_id"])


if __name__ == "__main__":
    unittest.main()
