"""Focused regression coverage for the separate D20 formal executor."""

from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = RESEARCH_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

import d20_matched_ablation_runner as d20  # noqa: E402
from lifeline_rl import LifelineGame  # noqa: E402


class D20MatchedAblationRunnerTests(unittest.TestCase):
    def test_registered_plan_and_openings_are_complete(self) -> None:
        manifest = d20.load_manifest()
        plan = d20.build_task_plan(manifest)
        openings = d20.generate_opening_registry(manifest)

        self.assertEqual(len(plan["training"]), 20)
        self.assertEqual(len(plan["evaluation"]), 100)
        self.assertEqual(sum(task["games"] for task in plan["evaluation"]), 6_400)
        for size, entries in openings.items():
            self.assertEqual(len(entries), 32, size)
            self.assertEqual(len({entry["prefix_fingerprint"] for entry in entries}), 32, size)
            for entry in entries:
                replayed = d20._opening_from_actions(int(size), entry["actions"])
                self.assertEqual(replayed.state_fingerprint(), entry["prefix_fingerprint"])

    def test_cpu_train_checkpoint_evaluate_and_replay_smoke(self) -> None:
        """Exercise the hard part without claiming a registered formal result."""

        formal_manifest = d20.load_manifest()
        manifest = copy.deepcopy(formal_manifest)
        training = manifest["training"]
        training["train_sizes"] = [5]
        training["iterations"] = 1
        training["games_per_iteration"] = 1
        training["updates_per_iteration"] = 1
        training["batch_size"] = 1
        arm = manifest["arms"][3]
        training_task = {
            "task_id": "test.edge1_history1.seed20260825",
            "arm_id": arm["id"],
            "training_seed": 20260825,
        }

        d20.LOCAL_ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".d20-test-", dir=d20.LOCAL_ARTIFACT_ROOT) as raw_root:
            root = Path(raw_root)
            receipt = d20._train_task(
                training_task,
                arm=arm,
                manifest=manifest,
                run_root=root,
                source_hashes=d20._source_closure(),
                device=d20.torch.device("cpu"),
            )
            checkpoint = receipt["checkpoint"]
            model = d20._load_checkpoint_model(
                d20.REPO_ROOT / checkpoint["checkpoint_path"],
                task=training_task,
                manifest=manifest,
                device=d20.torch.device("cpu"),
            )
            self.assertEqual(sum(parameter.numel() for parameter in model.parameters()), 63_235)

            game = LifelineGame(5, superko_mode="enforce")
            action = game.point_to_index[game.legal_moves()[0]]
            d20._apply_index(game, action)
            opening = {
                "opening_id": "n5.s00.v0",
                "grid_size": 5,
                "stratum": 0,
                "variant": 0,
                "actions": [action],
                "prefix_fingerprint": game.state_fingerprint(),
            }
            games_path = root / "smoke_games.jsonl"
            evaluation_task = {
                "task_id": "eval.edge1_history1.seed20260825.n5.vs.random",
                "arm_id": arm["id"],
                "training_seed": 20260825,
                "eval_size": 5,
                "opponent_id": "random",
                "games": 2,
            }
            with games_path.open("x", encoding="utf-8") as handle:
                evaluation = d20._evaluate_task(
                    evaluation_task,
                    arm=arm,
                    model=model,
                    checkpoint_sha256=checkpoint["checkpoint_sha256"],
                    manifest=manifest,
                    opening_registry={"5": [opening]},
                    games_handle=handle,
                    device=d20.torch.device("cpu"),
                )
            self.assertEqual(evaluation["games"], 2)
            for row in d20._read_jsonl(games_path, "smoke games"):
                d20._replay_evaluation_row(row)


if __name__ == "__main__":
    unittest.main()
