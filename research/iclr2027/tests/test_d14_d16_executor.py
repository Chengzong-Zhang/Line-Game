from __future__ import annotations

import copy
import hashlib
import json
import random
import shutil
import sys
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineGame, make_agent, run_matchup, write_matchup
from scripts.d14_d16_experiments import (
    RESULT_SCHEMA_NAME,
    ProtocolError,
    _validate_training_result,
    generate_tasks,
    load_manifest,
    manifest_hash,
    validate_checkpoint_artifact,
    write_task_bundle,
)
from scripts.run_d14_d16_task_bundle import (
    _configure_deterministic_runtime,
    _execution_metadata,
    _receipt_execution_identity,
    _result_header,
    _snapshot_artifact,
    _task_directory,
    _verify_arena_artifacts,
    build_training_config,
    dry_run_summary,
    load_task_bundle,
    run_bundle,
    run_training_task,
    status_summary,
    validate_present_receipts,
)


SMOKE_MANIFEST = ROOT / "configs" / "d14_d16_executor_smoke_manifest.json"


class _PassAgent:
    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    def select_action(self, game: LifelineGame, rng: random.Random):
        del game, rng
        return None

    def diagnostics(self):
        return {}


def _fake_training_receipt(task: dict) -> dict:
    budget = task["training_budget"]
    snapshots = [
        {
            "gradient_steps": step,
            "self_play_games": budget["self_play_games"],
            "environment_steps": 2,
            "loss": 1.0,
            "policy_loss": 0.5,
            "value_loss": 0.5,
            "wall_clock_seconds": 0.1,
        }
        for step in task["required_checkpoint_gradient_steps"]
    ]
    return {
        **_result_header(task),
        "status": "complete",
        "completed_at_utc": "2026-08-26T00:00:00Z",
        "representation": task["representation"],
        "board_sizes": task["board_sizes"],
        "seed": task["seed"],
        "parameter_count": task["expected_trainable_parameters"],
        "training_budget": budget,
        "puct_simulations": budget["puct_simulations"],
        "self_play_games_completed": budget["self_play_games"],
        "gradient_steps_completed": budget["gradient_steps"],
        "checkpoint_gradient_steps": task["required_checkpoint_gradient_steps"],
        "curve_snapshots": snapshots,
        "checkpoint_artifacts": [],
    }


def _fake_evaluation_receipt(task: dict) -> dict:
    games = task["games"]
    return {
        **_result_header(task),
        "status": "complete",
        "completed_at_utc": "2026-08-26T00:00:00Z",
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
        "replay_verified_games": games,
        "a_wins": 0,
        "a_losses": 0,
        "draws": games,
        "color_balance": task["color_balance"],
        "max_plies": task["max_plies"],
        "superko_mode": task["superko_mode"],
    }


def _baseline_task(task: dict) -> dict:
    baseline = copy.deepcopy(task)
    baseline["agent_a"] = {
        "kind": "search_baseline",
        "baseline_id": "random_a",
        "agent_kind": "random",
        "config": {},
    }
    baseline["agent_b"] = {
        "kind": "search_baseline",
        "baseline_id": "random_b",
        "agent_kind": "random",
        "config": {},
    }
    return baseline


class D14D16ExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_manifest(SMOKE_MANIFEST)
        self.tasks = generate_tasks(self.manifest)
        self.base = ROOT / "tests" / f"_d14_d16_executor_test_{uuid.uuid4().hex}"
        self.base.mkdir()

    def tearDown(self) -> None:
        if self.base.exists():
            shutil.rmtree(self.base)

    def _actual_training_receipt(self) -> tuple[dict, dict, Path]:
        task = self.tasks["training"][0]
        task_directory = self.base / "actual_training"
        _configure_deterministic_runtime("cpu")
        receipt = run_training_task(task, task_directory, device="cpu")
        metadata = _execution_metadata(
            self.manifest,
            self.base / "actual_bundle",
            "cpu",
        )
        receipt["execution_identity"] = _receipt_execution_identity(metadata)
        return task, receipt, task_directory

    def test_training_config_preserves_explicit_schedule(self) -> None:
        for task in self.tasks["training"]:
            config = build_training_config(task)
            self.assertEqual(config.model_kind, task["representation"])
            self.assertEqual(config.board_sizes, (5,))
            self.assertEqual(config.iterations, 1)
            self.assertEqual(config.games_per_iteration, 1)
            self.assertEqual(config.training_steps_per_iteration, 1)
            self.assertEqual(config.checkpoint_every, 1)
            self.assertEqual(config.batch_size, 2)

    def test_real_training_artifacts_bind_logs_curve_checkpoint_and_orphan_resume(self) -> None:
        task, receipt, task_directory = self._actual_training_receipt()
        _validate_training_result(receipt, task)

        changed_curve = copy.deepcopy(receipt)
        changed_curve["curve_snapshots"][0]["loss"] += 0.25
        with self.assertRaisesRegex(ProtocolError, "curve snapshot is not backed by metrics"):
            _validate_training_result(changed_curve, task)

        games_path = Path(receipt["games_log_path"])
        original_games_bytes = games_path.read_bytes()
        original_games = original_games_bytes.decode("utf-8")
        games = [json.loads(line) for line in original_games.splitlines()]
        games[0]["seed"] += 1
        games_path.write_text(
            "".join(json.dumps(game, sort_keys=True) + "\n" for game in games),
            encoding="utf-8",
        )
        changed_games = copy.deepcopy(receipt)
        changed_games["games_log_sha256"] = hashlib.sha256(games_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ProtocolError, "deterministic task binding failed"):
            _validate_training_result(changed_games, task)
        games_path.write_bytes(original_games_bytes)

        artifact = receipt["checkpoint_artifacts"][0]
        wrong_step = copy.deepcopy(artifact)
        wrong_step["gradient_steps"] = 2
        task_with_second_step = copy.deepcopy(task)
        task_with_second_step["required_checkpoint_gradient_steps"] = [1, 2]
        with self.assertRaisesRegex(ProtocolError, "path does not encode its scheduled step"):
            validate_checkpoint_artifact(task_with_second_step, wrong_step)

        checkpoint_path = Path(artifact["checkpoint_path"])
        checkpoint_bytes = checkpoint_path.read_bytes()
        checkpoint_path.write_bytes(checkpoint_bytes + b"tamper")
        with self.assertRaisesRegex(ProtocolError, "SHA-256 binding failed"):
            _validate_training_result(receipt, task)
        checkpoint_path.write_bytes(checkpoint_bytes)

        latest_path = Path(artifact["checkpoint_directory"]) / "latest.json"
        latest_path.unlink()
        recovered = _snapshot_artifact(
            task,
            Path(artifact["checkpoint_directory"]),
            wall_clock_seconds=float(artifact["wall_clock_seconds"]),
        )
        self.assertEqual(recovered["checkpoint_sha256"], artifact["checkpoint_sha256"])
        self.assertTrue(latest_path.is_file())
        _validate_training_result(receipt, task)

        state_path = task_directory / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["checkpoint_artifacts"] = []
        state["latest_checkpoint_directory"] = None
        state_path.write_text(json.dumps(state), encoding="utf-8")
        resumed = run_training_task(task, task_directory, device="cpu")
        resumed["execution_identity"] = receipt["execution_identity"]
        adopted_state = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(adopted_state["orphan_snapshots_adopted"], [1])
        _validate_training_result(resumed, task)

    def test_bundle_round_trip_and_tamper_detection(self) -> None:
        bundle = self.base / "bundle"
        write_task_bundle(self.manifest, bundle)
        observed = load_task_bundle(self.manifest, bundle)
        self.assertEqual(observed, self.tasks)
        summary = dry_run_summary(self.manifest, observed)
        self.assertEqual(summary["status"], "dry_run_ok_no_writes")
        self.assertEqual(summary["training_tasks"], 3)
        self.assertEqual(summary["evaluation_tasks"], 6)

        path = bundle / "training_tasks.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        lines.reverse()
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "modified or reordered"):
            load_task_bundle(self.manifest, bundle)

    def test_completed_tasks_are_skipped_and_one_evaluation_can_follow(self) -> None:
        run_root = self.base / "run"
        bundle = self.base / "bundle_path"
        training_calls: list[str] = []
        evaluation_calls: list[str] = []

        def train(task, task_directory, *, device):
            del task_directory, device
            training_calls.append(task["task_id"])
            return _fake_training_receipt(task)

        def evaluate(task, task_directory, **kwargs):
            del task_directory, kwargs
            evaluation_calls.append(task["task_id"])
            return _fake_evaluation_receipt(task)

        first = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            training_runner=train,
            evaluation_runner=evaluate,
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(first["attempted_this_invocation"], 3)
        self.assertEqual(len(training_calls), 3)

        second = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            training_runner=train,
            evaluation_runner=evaluate,
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(second["attempted_this_invocation"], 0)
        self.assertEqual(second["skipped_complete"], 3)
        self.assertEqual(len(training_calls), 3)

        third = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="evaluation",
            max_tasks=1,
            training_runner=train,
            evaluation_runner=evaluate,
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(third["attempted_this_invocation"], 1)
        self.assertEqual(len(evaluation_calls), 1)

    def test_training_only_restart_deep_validates_existing_evaluation_and_stales_ledger(self) -> None:
        run_root = self.base / "deep_restart"
        bundle = self.base / "bundle_path"

        def train(task, task_directory, *, device):
            del task_directory, device
            return _fake_training_receipt(task)

        def evaluate(task, task_directory, **kwargs):
            del task_directory, kwargs
            return {**_fake_evaluation_receipt(task), "artifact_token": "valid"}

        def validator(task, receipt, checkpoints):
            del checkpoints
            if task["task_kind"] == "evaluation" and receipt.get("artifact_token") != "valid":
                raise ProtocolError("forged evaluation artifact")

        run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            training_runner=train,
            evaluation_runner=evaluate,
            receipt_validator=validator,
        )
        run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="evaluation",
            max_tasks=1,
            training_runner=train,
            evaluation_runner=evaluate,
            receipt_validator=validator,
        )
        evaluation_task = self.tasks["evaluation"][0]
        receipt_path = _task_directory(run_root, evaluation_task["task_id"]) / "receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["artifact_token"] = "forged"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "forged evaluation artifact"):
            status_summary(
                self.manifest,
                self.tasks,
                bundle_directory=bundle,
                run_root=run_root,
                receipt_validator=validator,
            )
        (run_root / "result_receipts.jsonl").write_text("stale\n", encoding="utf-8")

        with self.assertRaisesRegex(ProtocolError, "forged evaluation artifact"):
            run_bundle(
                self.manifest,
                self.tasks,
                bundle_directory=bundle,
                run_root=run_root,
                device="cpu",
                task_kind="training",
                training_runner=train,
                evaluation_runner=evaluate,
                receipt_validator=validator,
            )
        self.assertFalse(json.loads((run_root / "result_ledger_status.json").read_text())["valid"])
        self.assertEqual(
            len(list((run_root / "stale_ledgers").glob("result_receipts_*.jsonl"))),
            1,
        )

    def test_failure_receipt_requires_explicit_retry(self) -> None:
        run_root = self.base / "failure_run"
        bundle = self.base / "bundle_path"
        calls: list[str] = []

        def fail(task, task_directory, *, device):
            del task_directory, device
            calls.append(task["task_id"])
            raise RuntimeError("fixture failure")

        first = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            max_tasks=1,
            training_runner=fail,
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(first["failed_this_invocation"], 1)
        self.assertEqual(len(calls), 1)
        first_failed_task = calls[0]

        second = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            max_tasks=1,
            training_runner=fail,
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(second["skipped_failed"], 1)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[1], first_failed_task)

        third = run_bundle(
            self.manifest,
            self.tasks,
            bundle_directory=bundle,
            run_root=run_root,
            device="cpu",
            task_kind="training",
            max_tasks=1,
            retry_failed=True,
            training_runner=lambda task, task_directory, device: _fake_training_receipt(task),
            receipt_validator=lambda task, receipt, checkpoints: None,
        )
        self.assertEqual(third["attempted_this_invocation"], 1)
        self.assertEqual(third["failed_this_invocation"], 0)

    def test_arena_artifacts_are_replayed_and_pair_checked(self) -> None:
        task = _baseline_task(self.tasks["evaluation"][0])
        result = run_matchup(
            make_agent("random"),
            make_agent("random"),
            games=2,
            grid_size=5,
            base_seed=task["seed"],
            max_plies=task["max_plies"],
            superko_mode=task["superko_mode"],
        )
        result.summary.update(
            {
                "experiment_id": task["experiment_id"],
                "manifest_sha256": task["manifest_sha256"],
                "evidence_tier": task["evidence_tier"],
                "task_id": task["task_id"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
            }
        )
        arena = self.base / "arena"
        write_matchup(result, arena)
        _, records, observed, bindings = _verify_arena_artifacts(task, arena)
        self.assertEqual(len(records), 2)
        self.assertEqual(observed["replay_verified_games"], 2)
        self.assertEqual(observed["color_pairs_verified"], 1)
        self.assertEqual(bindings["A"]["agent_kind"], "random")

        games_path = arena / "games.jsonl"
        records[1]["white_policy_seed"] += 1
        games_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ProtocolError, "invalid color pairs"):
            _verify_arena_artifacts(task, arena)

    def test_pass_agent_cannot_impersonate_a_learned_checkpoint(self) -> None:
        task = self.tasks["evaluation"][0]
        result = run_matchup(
            _PassAgent("A"),
            make_agent("random"),
            games=2,
            grid_size=5,
            base_seed=task["seed"],
            max_plies=task["max_plies"],
            superko_mode=task["superko_mode"],
        )
        result.summary.update(
            {
                "experiment_id": task["experiment_id"],
                "manifest_sha256": task["manifest_sha256"],
                "evidence_tier": task["evidence_tier"],
                "task_id": task["task_id"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
            }
        )
        arena = self.base / "impostor_arena"
        write_matchup(result, arena)
        with self.assertRaisesRegex(ProtocolError, "learned slot is not NeuralPUCTAgent"):
            _verify_arena_artifacts(task, arena)

    def test_arena_csv_and_action_diagnostics_are_not_orphan_evidence(self) -> None:
        task = _baseline_task(self.tasks["evaluation"][0])
        result = run_matchup(
            make_agent("random"),
            make_agent("random"),
            games=2,
            grid_size=5,
            base_seed=task["seed"],
            max_plies=task["max_plies"],
            superko_mode=task["superko_mode"],
        )
        result.summary.update(
            {
                "experiment_id": task["experiment_id"],
                "manifest_sha256": task["manifest_sha256"],
                "evidence_tier": task["evidence_tier"],
                "task_id": task["task_id"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
            }
        )
        arena = self.base / "csv_arena"
        write_matchup(result, arena)
        _verify_arena_artifacts(task, arena)

        csv_path = arena / "games.csv"
        csv_text = csv_path.read_text(encoding="utf-8")
        csv_path.write_text(csv_text.replace(",random,random,", ",forged,random,", 1), encoding="utf-8")
        with self.assertRaisesRegex(ProtocolError, "CSV disagrees"):
            _verify_arena_artifacts(task, arena)
        csv_path.write_text(csv_text, encoding="utf-8")

        games_path = arena / "games.jsonl"
        records = [json.loads(line) for line in games_path.read_text(encoding="utf-8").splitlines()]
        records[0]["actions"][0]["diagnostics"] = {"forged": True}
        games_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ProtocolError, "RandomAgent must be empty"):
            _verify_arena_artifacts(task, arena)

    def test_truncated_evaluation_fails_before_receipt(self) -> None:
        task = _baseline_task(self.tasks["evaluation"][0])
        task["max_plies"] = 1
        result = run_matchup(
            make_agent("random"),
            make_agent("random"),
            games=2,
            grid_size=5,
            base_seed=task["seed"],
            max_plies=1,
            superko_mode=task["superko_mode"],
        )
        result.summary.update(
            {
                "experiment_id": task["experiment_id"],
                "manifest_sha256": task["manifest_sha256"],
                "evidence_tier": task["evidence_tier"],
                "task_id": task["task_id"],
                "checkpoint_gradient_steps": task["checkpoint_gradient_steps"],
                "agent_specs": {"A": task["agent_a"], "B": task["agent_b"]},
            }
        )
        arena = self.base / "truncated_arena"
        write_matchup(result, arena)
        with self.assertRaisesRegex(ProtocolError, "evaluation contains 2 truncations"):
            _verify_arena_artifacts(task, arena)


if __name__ == "__main__":
    unittest.main()
