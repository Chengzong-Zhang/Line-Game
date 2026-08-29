from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from typing import Any

from lifeline_rl import LifelineGame, Player
from lifeline_rl.encoding import encode_observation, observation_json
from scripts.search_state_aliasing import (
    _grid_key,
    _mask_free_topology_key,
    classify_grid_pair,
)


ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / "state_aliasing" / "pairs_v1.json"
SEARCH_REPORT_PATH = ROOT / "state_aliasing" / "search_report_v1.json"
AUDIT_PATH = ROOT / "d6_redteam_exact_audit.json"


def _actions(raw: list[list[int] | None]) -> tuple[tuple[int, int] | None, ...]:
    return tuple(None if action is None else (action[0], action[1]) for action in raw)


def _replay(pair: dict[str, Any], label: str) -> LifelineGame:
    game = LifelineGame(pair["grid_size"])
    game.replay(_actions(pair[f"history_{label}"]))
    return game


def _digest_observation(game: LifelineGame, mode: str) -> str:
    return hashlib.sha256(observation_json(game, mode).encode("utf-8")).hexdigest()


def _edge_points(game: LifelineGame, player: Player) -> set[tuple[tuple[int, int], tuple[int, int]]]:
    return {
        (game.valid_positions[a], game.valid_positions[b])
        for a, b in game.edges[player]
    }


class D6PairedDatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dataset = json.loads(DATASET_PATH.read_text(encoding="utf-8"))

    def test_dataset_claims_only_weak_pairs(self) -> None:
        self.assertEqual(self.dataset["schema_version"], 1)
        self.assertEqual(self.dataset["claim_status"]["strict_grid_topology_pairs"], 0)
        self.assertEqual(self.dataset["claim_status"]["strict_history_superko_pairs"], 0)
        self.assertEqual(self.dataset["claim_status"]["weak_history_pairs"], 1)
        self.assertTrue(self.dataset["pairs"])
        self.assertTrue(all(not pair["strict"] for pair in self.dataset["pairs"]))

    def test_every_pair_replays_to_expected_equal_grid_observation(self) -> None:
        for pair in self.dataset["pairs"]:
            with self.subTest(pair_id=pair["pair_id"]):
                game_a = _replay(pair, "a")
                game_b = _replay(pair, "b")
                expected = pair["expected"]

                self.assertEqual(game_a.grid, expected["board"])
                self.assertEqual(game_a.grid, game_b.grid)
                self.assertEqual(game_a.current_player, game_b.current_player)
                self.assertEqual(game_a.current_player.value, expected["current_player"])
                self.assertEqual(game_a.consecutive_skips, expected["consecutive_skips"])
                self.assertEqual(game_a.consecutive_skips, game_b.consecutive_skips)
                self.assertEqual(game_a.game_over, expected["game_over"])
                self.assertEqual(game_a.game_over, game_b.game_over)

                grid_a = encode_observation(game_a, "grid")
                grid_b = encode_observation(game_b, "grid")
                topology_a = encode_observation(game_a, "topology")
                topology_b = encode_observation(game_b, "topology")
                self.assertEqual(grid_a, grid_b)
                self.assertEqual(
                    _digest_observation(game_a, "grid"),
                    expected["implemented_grid_observation_sha256"],
                )
                self.assertEqual(
                    _digest_observation(game_b, "grid"),
                    expected["implemented_grid_observation_sha256"],
                )
                if pair["classification"] == "reachable_weak_topology_alias":
                    self.assertNotEqual(topology_a, topology_b)
                    self.assertEqual(
                        _digest_observation(game_a, "topology"),
                        expected["implemented_topology_observation_sha256_a"],
                    )
                    self.assertEqual(
                        _digest_observation(game_b, "topology"),
                        expected["implemented_topology_observation_sha256_b"],
                    )
                else:
                    self.assertEqual(topology_a, topology_b)
                    self.assertNotEqual(
                        encode_observation(game_a, "topology_history"),
                        encode_observation(game_b, "topology_history"),
                    )
                    self.assertEqual(
                        _digest_observation(game_a, "topology"),
                        expected["implemented_topology_observation_sha256"],
                    )
                    self.assertEqual(
                        _digest_observation(game_a, "topology_history"),
                        expected["topology_history_observation_sha256_a"],
                    )
                    self.assertEqual(
                        _digest_observation(game_b, "topology_history"),
                        expected["topology_history_observation_sha256_b"],
                    )
                self.assertEqual(game_a.state_fingerprint(), expected["state_fingerprint_a"])
                self.assertEqual(game_b.state_fingerprint(), expected["state_fingerprint_b"])
                self.assertEqual(len(game_a.history_hashes), expected["history_key_count_a"])
                self.assertEqual(len(game_b.history_hashes), expected["history_key_count_b"])
                self.assertEqual(game_a.legal_moves(), list(_actions(expected["legal_actions"])))
                self.assertEqual(game_a.legal_moves(), game_b.legal_moves())

    def test_expected_logical_edge_differences_are_exact(self) -> None:
        for pair in self.dataset["pairs"]:
            with self.subTest(pair_id=pair["pair_id"]):
                if pair["classification"] != "reachable_weak_topology_alias":
                    continue
                game_a = _replay(pair, "a")
                game_b = _replay(pair, "b")
                expected = pair["expected"]
                for player in (Player.BLACK, Player.WHITE):
                    edges_a = _edge_points(game_a, player)
                    edges_b = _edge_points(game_b, player)
                    only_a = {
                        (tuple(edge[0]), tuple(edge[1]))
                        for edge in expected["logical_edges_only_in_a"][player.value]
                    }
                    only_b = {
                        (tuple(edge[0]), tuple(edge[1]))
                        for edge in expected["logical_edges_only_in_b"][player.value]
                    }
                    self.assertEqual(edges_a - edges_b, only_a)
                    self.assertEqual(edges_b - edges_a, only_b)

    def test_n5_evidence_action_remains_weak(self) -> None:
        pair = next(
            item for item in self.dataset["pairs"]
            if item["pair_id"] == "weak_grid_topology_n5_v1"
        )
        game_a = _replay(pair, "a")
        game_b = _replay(pair, "b")
        action = tuple(pair["evidence"]["action"])
        self.assertTrue(game_a.play_move(action).success)
        self.assertTrue(game_b.play_move(action).success)
        self.assertEqual(encode_observation(game_a, "grid"), encode_observation(game_b, "grid"))
        self.assertNotEqual(
            encode_observation(game_a, "topology"),
            encode_observation(game_b, "topology"),
        )
        self.assertTrue(game_a.game_over)
        self.assertTrue(game_b.game_over)
        self.assertEqual(game_a.winner(), Player.WHITE)
        self.assertEqual(game_b.winner(), Player.WHITE)
        self.assertEqual(game_a.rewards(), game_b.rewards())

    def test_n6_all_direct_shared_actions_have_equal_grid_successors(self) -> None:
        pair = next(
            item for item in self.dataset["pairs"]
            if item["pair_id"] == "weak_grid_topology_n6_v1"
        )
        base_a = _replay(pair, "a")
        base_b = _replay(pair, "b")
        for action in _actions(pair["evidence"]["direct_shared_actions_checked"]):
            with self.subTest(action=action):
                game_a = LifelineGame(pair["grid_size"])
                game_b = LifelineGame(pair["grid_size"])
                game_a.restore(base_a.clone())
                game_b.restore(base_b.clone())
                result_a = game_a.skip_turn() if action is None else game_a.play_move(action)
                result_b = game_b.skip_turn() if action is None else game_b.play_move(action)
                self.assertTrue(result_a.success)
                self.assertTrue(result_b.success)
                self.assertEqual(
                    encode_observation(game_a, "grid"),
                    encode_observation(game_b, "grid"),
                )

    def test_direct_grid_classifier_includes_pass(self) -> None:
        pair = next(
            item for item in self.dataset["pairs"]
            if item["pair_id"] == "weak_grid_topology_n6_v1"
        )
        classified = classify_grid_pair(
            pair["grid_size"],
            _actions(pair["history_a"]),
            _actions(pair["history_b"]),
        )
        self.assertIsNotNone(classified)
        assert classified is not None
        self.assertFalse(classified["witness"]["strict"])
        self.assertIn(None, classified["witness"]["common_legal_actions"])

    def test_weak_history_pair_has_no_superko_legality_difference(self) -> None:
        pair = next(
            item for item in self.dataset["pairs"]
            if item["pair_id"] == "weak_history_alias_n5_v1"
        )
        base_a = _replay(pair, "a")
        base_b = _replay(pair, "b")
        self.assertEqual(encode_observation(base_a, "topology"), encode_observation(base_b, "topology"))
        self.assertNotEqual(base_a.history_hashes, base_b.history_hashes)
        rejected_a = [
            point for point in base_a.valid_positions
            if base_a.evaluate_move(point).reason == "SUPERKO_VIOLATION"
        ]
        rejected_b = [
            point for point in base_b.valid_positions
            if base_b.evaluate_move(point).reason == "SUPERKO_VIOLATION"
        ]
        self.assertEqual(rejected_a, [])
        self.assertEqual(rejected_b, [])

        for action in _actions(pair["evidence"]["direct_shared_actions_checked"]):
            with self.subTest(action=action):
                game_a = LifelineGame(pair["grid_size"])
                game_b = LifelineGame(pair["grid_size"])
                game_a.restore(base_a.clone())
                game_b.restore(base_b.clone())
                result_a = game_a.skip_turn() if action is None else game_a.play_move(action)
                result_b = game_b.skip_turn() if action is None else game_b.play_move(action)
                self.assertTrue(result_a.success)
                self.assertTrue(result_b.success)
                self.assertEqual(
                    encode_observation(game_a, "topology"),
                    encode_observation(game_b, "topology"),
                )

    def test_search_keys_separate_implemented_mask_from_mask_free_topology(self) -> None:
        reached = LifelineGame(5)
        self.assertTrue(reached.play_move((0, 3)).success)
        repeated_key = reached._compute_state_key(Player.WHITE)

        ordinary = LifelineGame(5)
        injected = LifelineGame(5)
        injected.history_hashes.add(repeated_key)

        self.assertEqual(
            _mask_free_topology_key(ordinary),
            _mask_free_topology_key(injected),
        )
        self.assertNotEqual(_grid_key(ordinary), _grid_key(injected))
        self.assertTrue(ordinary.evaluate_move((0, 3)).success)
        self.assertEqual(
            injected.evaluate_move((0, 3)).reason,
            "SUPERKO_VIOLATION",
        )

    def test_machine_readable_negative_report_matches_red_team_certificate(self) -> None:
        search = json.loads(SEARCH_REPORT_PATH.read_text(encoding="utf-8"))
        audit = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
        exact = search["exhaustive_side_five"]
        audited_counts = audit["alias_analysis"]["counts"]
        audited_graph = audit["exhaustive_superko_analysis"]
        self.assertEqual(exact["states"], audited_graph["states"])
        self.assertEqual(exact["transitions"], audited_graph["transitions"])
        self.assertEqual(exact["natural_superko_found"], audited_graph["natural_superko_found"])
        for key in (
            "grid_alias_groups",
            "distinct_topology_pairs",
            "different_legal_action_sets",
            "different_visible_one_step_outcomes",
            "different_exact_black_values",
            "different_shared_action_q_values",
            "different_optimal_action_sets",
            "disjoint_optimal_action_sets",
        ):
            self.assertEqual(exact[key], audited_counts[key])

if __name__ == "__main__":
    unittest.main()
