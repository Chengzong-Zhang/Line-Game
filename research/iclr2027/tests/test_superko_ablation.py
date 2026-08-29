from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from typing import Any

from lifeline_rl import LifelineGame, Player


ROOT = Path(__file__).resolve().parents[1]
WITNESS_PATH = ROOT / "state_aliasing" / "superko_n6_witness_v1.json"

Action = tuple[int, int] | None
PREFIX: tuple[Action, ...] = (
    (0, 1),
    (4, 0),
    (2, 0),
    (1, 4),
    (2, 3),
    (2, 2),
    (3, 1),
    (1, 4),
    None,
    (1, 1),
)
PREFIX_ACTORS = (
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
)
CANDIDATE = (2, 3)
WITNESS_LOOP: tuple[Action, ...] = (
    (2, 2),
    (3, 1),
    (1, 4),
    None,
    (1, 1),
    (2, 3),
)
LOOP_ACTORS = (
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
    Player.WHITE,
    Player.BLACK,
)
STAGE_5_SHA256 = "c1362c7a100c1c512e2345740f4d9cbd1c34c12b7ab708d65dac681365c14608"
SOURCE_SHA256 = "EFB6BF27D35E8894D9F8C749C8C86765CBCF957060B55AA8456C006051A84CA0"


def _actions(raw: list[list[int] | None]) -> tuple[Action, ...]:
    return tuple(
        None if action is None else (int(action[0]), int(action[1]))
        for action in raw
    )


def _position_key(game: LifelineGame) -> tuple[Any, ...]:
    return game._compute_state_key(game.current_player)


def _position_digest(game: LifelineGame) -> str:
    return hashlib.sha256(repr(_position_key(game)).encode("utf-8")).hexdigest()


def _position_projection(game: LifelineGame) -> tuple[Any, ...]:
    snapshot = game.clone()
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def _apply(game: LifelineGame, action: Action):
    return game.skip_turn() if action is None else game.play_move(action)


class NaturalSuperkoAblationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.witness = json.loads(WITNESS_PATH.read_text(encoding="utf-8"))

    def _replay(
        self,
        mode: str,
        actions: tuple[Action, ...],
        actors: tuple[Player, ...],
    ) -> LifelineGame:
        game = LifelineGame(self.witness["grid_size"], superko_mode=mode)
        self.assertEqual(len(actions), len(actors))
        for ply, (action, actor) in enumerate(zip(actions, actors)):
            with self.subTest(mode=mode, ply=ply, action=action):
                self.assertEqual(game.current_player, actor)
                result = _apply(game, action)
                self.assertTrue(result.success, (ply, action, result))
        return game

    def assert_result_matches(self, result: Any, expected: dict[str, Any]) -> None:
        self.assertEqual(result.success, expected["success"])
        self.assertEqual(result.reason, expected["reason"])
        self.assertEqual(
            result.would_violate_superko,
            expected["would_violate_superko"],
        )

    def assert_complete_state(self, game: LifelineGame, expected: dict[str, Any]) -> None:
        self.assertEqual(game.clone(), expected["snapshot"])
        self.assertEqual(game.serialize_state(), expected["serialized"])
        self.assertEqual(game.canonical_state_json(), expected["canonical_json"])
        self.assertEqual(game.legal_moves(), expected["legal_moves"])

    def test_fixture_and_natural_prefix_are_frozen(self) -> None:
        natural = self.witness["natural_prefix"]
        self.assertEqual(self.witness["schema_version"], 1)
        self.assertEqual(
            self.witness["classification"],
            "standard_initial_state_natural_superko_rejection",
        )
        self.assertEqual(_actions(natural["actions"]), PREFIX)
        self.assertEqual(tuple(map(Player, natural["actors"])), PREFIX_ACTORS)
        self.assertEqual(natural["transitions"], 10)
        self.assertEqual(natural["placements"], 9)
        self.assertEqual(natural["passes"], 1)

        game = self._replay("enforce", PREFIX, PREFIX_ACTORS)
        self.assertEqual(game.current_player, Player.BLACK)
        self.assertEqual(game.current_player.value, natural["resulting_player"])
        self.assertEqual(game.turn_count, 9)
        self.assertEqual(game.turn_count, natural["resulting_turn_count"])
        self.assertEqual(game.point_to_index[CANDIDATE], 17)
        self.assertEqual(
            game.point_to_index[CANDIDATE],
            self.witness["candidate"]["action_index"],
        )

        provenance = self.witness["provenance"]
        source_path = (WITNESS_PATH.parent / provenance["artifact"]).resolve()
        self.assertTrue(source_path.is_file())
        self.assertEqual(
            hashlib.sha256(source_path.read_bytes()).hexdigest().upper(),
            SOURCE_SHA256,
        )
        self.assertEqual(provenance["artifact_sha256"], SOURCE_SHA256)
        source = json.loads(source_path.read_text(encoding="utf-8"))["random"]
        self.assertEqual(_actions(source["prefix"]), PREFIX)
        self.assertEqual(_actions(source["rejected_actions"]), (CANDIDATE,))
        for key in (
            "seed",
            "episode",
            "ply",
            "episodes_budget",
            "max_plies",
            "total_plies_examined",
        ):
            self.assertEqual(source[key], provenance[key])
        self.assertEqual(provenance["episode_index_base"], 0)
        self.assertEqual(provenance["ply_index_base"], 0)
        self.assertEqual(provenance["pass_probability"], 0.12)
        self.assertEqual(provenance["attack_bias"], 0.95)

        claims = self.witness["claim_boundary"]
        self.assertTrue(claims["standard_initial_state_natural_rejection"])
        self.assertEqual(
            claims["six_transition_scope"],
            "The six transitions close this particular witness loop only.",
        )
        self.assertFalse(claims["global_shortest_loop_claimed"])
        self.assertFalse(
            claims["two_naturally_reachable_same_topology_history_aliases_claimed"]
        )

    def test_enforce_rejects_candidate_transactionally(self) -> None:
        game = self._replay("enforce", PREFIX, PREFIX_ACTORS)
        expected_result = self.witness["expected"]["enforce"]
        before = {
            "legal_moves": game.legal_moves(),
            "snapshot": game.clone(),
            "serialized": game.serialize_state(),
            "canonical_json": game.canonical_state_json(),
        }

        evaluated = game.evaluate_move(CANDIDATE)
        self.assert_result_matches(evaluated, expected_result["evaluate_move"])
        self.assert_complete_state(game, before)

        played = game.play_move(CANDIDATE)
        self.assert_result_matches(played, expected_result["play_move"])
        self.assert_complete_state(game, before)
        self.assertTrue(expected_result["complete_state_unchanged"])

    def test_observe_accepts_candidate_and_returns_to_stage_five(self) -> None:
        stage_count = self.witness["stage_5"]["prefix_action_count"]
        game = self._replay(
            "observe",
            PREFIX[:stage_count],
            PREFIX_ACTORS[:stage_count],
        )
        stage_key = _position_key(game)
        stage_projection = _position_projection(game)
        stage = self.witness["stage_5"]
        self.assertEqual(_position_digest(game), STAGE_5_SHA256)
        self.assertEqual(stage["position_key_sha256"], STAGE_5_SHA256)
        self.assertEqual(game.grid, stage["board"])
        self.assertEqual(
            sorted(game.edges[Player.BLACK]),
            [tuple(edge) for edge in stage["logical_edge_indices"]["BLACK"]],
        )
        self.assertEqual(
            sorted(game.edges[Player.WHITE]),
            [tuple(edge) for edge in stage["logical_edge_indices"]["WHITE"]],
        )
        self.assertEqual(len(game.history_hashes), stage["history_key_count"])
        self.assertEqual(game.turn_count, stage["turn_count"])
        self.assertEqual(game.current_player.value, stage["current_player"])
        self.assertEqual(game.consecutive_skips, stage["consecutive_skips"])
        self.assertEqual(game.game_over, stage["game_over"])

        for ply, (action, actor) in enumerate(
            zip(PREFIX[stage_count:], PREFIX_ACTORS[stage_count:]),
            start=stage_count,
        ):
            with self.subTest(ply=ply, action=action):
                self.assertEqual(game.current_player, actor)
                self.assertTrue(_apply(game, action).success)

        expected = self.witness["expected"]["observe"]
        before_evaluation = game.clone()
        evaluated = game.evaluate_move(CANDIDATE)
        self.assert_result_matches(evaluated, expected["evaluate_move"])
        self.assertEqual(game.clone(), before_evaluation)

        played = game.play_move(CANDIDATE)
        self.assert_result_matches(played, expected["play_move"])
        self.assertEqual(_position_key(game), stage_key)
        self.assertEqual(_position_projection(game), stage_projection)
        self.assertEqual(_position_digest(game), expected["result_position_key_sha256"])
        self.assertEqual(game.turn_count, 10)

    def test_observe_cycle_repeats_twice(self) -> None:
        stage_count = self.witness["stage_5"]["prefix_action_count"]
        game = self._replay(
            "observe",
            PREFIX[:stage_count],
            PREFIX_ACTORS[:stage_count],
        )
        loop = self.witness["witness_loop"]
        self.assertEqual(_actions(loop["actions"]), WITNESS_LOOP)
        self.assertEqual(tuple(map(Player, loop["actors"])), LOOP_ACTORS)
        self.assertEqual(loop["transitions"], 6)
        self.assertEqual(loop["placements"], 5)
        self.assertEqual(loop["passes"], 1)

        stage_key = _position_key(game)
        stage_projection = _position_projection(game)
        expected = self.witness["expected"]["observe_two_loop_replay"]
        self.assertEqual(game.turn_count, expected["turn_counts_at_stage_and_loop_ends"][0])
        successes = 0
        for round_index in range(2):
            for step, (action, actor) in enumerate(zip(WITNESS_LOOP, LOOP_ACTORS)):
                with self.subTest(round=round_index + 1, step=step, action=action):
                    self.assertEqual(game.current_player, actor)
                    result = _apply(game, action)
                    self.assertTrue(result.success, result)
                    successes += int(result.success)
            self.assertEqual(_position_key(game), stage_key)
            self.assertEqual(_position_projection(game), stage_projection)
            self.assertEqual(
                _position_digest(game),
                expected["position_key_sha256_at_loop_ends"][round_index],
            )
            self.assertEqual(
                game.turn_count,
                expected["turn_counts_at_stage_and_loop_ends"][round_index + 1],
            )

        self.assertEqual(successes, 12)
        self.assertEqual(successes, expected["successful_transitions"])
        self.assertEqual(2 * len(WITNESS_LOOP), expected["total_transitions"])

    def test_snapshot_and_serialization_preserve_mode(self) -> None:
        observe = self._replay("observe", PREFIX, PREFIX_ACTORS)
        self.assertTrue(observe.play_move(CANDIDATE).success)
        snapshot = observe.clone()
        self.assertEqual(snapshot.superko_mode, "observe")

        restored = LifelineGame(self.witness["grid_size"], superko_mode="enforce")
        restored.restore(snapshot)
        self.assertEqual(restored.superko_mode, "observe")
        self.assertEqual(restored.clone(), snapshot)

        expected = self.witness["expected"]
        observe_payload = json.loads(observe.canonical_state_json())
        self.assertEqual(
            observe_payload["schema_version"],
            expected["observe"]["serialization_schema_version"],
        )
        self.assertEqual(
            observe_payload["superko_mode"],
            expected["observe"]["serialization_superko_mode"],
        )
        observe_round_trip = LifelineGame.from_serialized_state(observe_payload)
        self.assertEqual(observe_round_trip.superko_mode, "observe")
        self.assertEqual(observe_round_trip.clone(), observe.clone())

        enforce = self._replay("enforce", PREFIX, PREFIX_ACTORS)
        enforce_payload = json.loads(enforce.canonical_state_json())
        self.assertEqual(
            enforce_payload["schema_version"],
            expected["enforce"]["serialization_schema_version"],
        )
        self.assertNotIn("superko_mode", enforce_payload)
        self.assertFalse(expected["enforce"]["serialization_contains_superko_mode"])
        enforce_round_trip = LifelineGame.from_serialized_state(enforce_payload)
        self.assertEqual(enforce_round_trip.superko_mode, "enforce")
        self.assertEqual(enforce_round_trip.clone(), enforce.clone())

    def test_superko_diagnostics_and_legal_moves_match_modes(self) -> None:
        enforce = self._replay("enforce", PREFIX, PREFIX_ACTORS)
        observe = self._replay("observe", PREFIX, PREFIX_ACTORS)
        expected = list(_actions(self.witness["expected"]["would_violate_superko_moves"]))

        self.assertEqual(enforce.would_violate_superko_moves(), expected)
        self.assertEqual(observe.would_violate_superko_moves(), expected)
        self.assertNotIn(CANDIDATE, enforce.legal_moves())
        self.assertIn(CANDIDATE, observe.legal_moves())
        self.assertEqual(
            set(observe.legal_moves()) - set(enforce.legal_moves()),
            {CANDIDATE},
        )
        self.assertFalse(
            self.witness["expected"]["enforce"]["candidate_in_legal_moves"]
        )
        self.assertTrue(
            self.witness["expected"]["observe"]["candidate_in_legal_moves"]
        )


if __name__ == "__main__":
    unittest.main()
