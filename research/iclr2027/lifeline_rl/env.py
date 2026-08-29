"""Gymnasium-shaped wrapper that does not require Gymnasium to be installed."""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Iterable

from .core import GameSnapshot, LifelineGame, Player
from .encoding import encode_observation


@dataclass(frozen=True)
class EnvSnapshot:
    game: GameSnapshot
    random_state: object


class LifelineEnv:
    """Alternating-player environment with a fixed point-action mapping.

    Point actions occupy ``[0, n(n+1)/2)`` in row-major triangular order and
    the final action is PASS.  Terminal reward is returned from the perspective
    of the player who submitted the terminating action; ``info['rewards']``
    always contains both players' payoffs.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        grid_size: int = 9,
        observation_mode: str = "topology_history",
        illegal_action_mode: str = "raise",
        superko_mode: str = "enforce",
    ):
        if illegal_action_mode not in {"raise", "penalty"}:
            raise ValueError("illegal_action_mode must be raise or penalty")
        self.grid_size = grid_size
        self.observation_mode = observation_mode
        self.illegal_action_mode = illegal_action_mode
        self._rng = random.Random()
        self.game = LifelineGame(grid_size, superko_mode=superko_mode)
        self.superko_mode = self.game.superko_mode

    @property
    def action_count(self) -> int:
        return self.game.num_points + 1

    @property
    def pass_action(self) -> int:
        return self.game.num_points

    def action_to_point(self, action: int) -> tuple[int, int] | None:
        if isinstance(action, bool) or not isinstance(action, int):
            raise TypeError("action must be an integer")
        if action == self.pass_action:
            return None
        if not 0 <= action < self.game.num_points:
            raise ValueError(f"action must be in [0, {self.pass_action}]")
        return self.game.valid_positions[action]

    def point_to_action(self, point: tuple[int, int] | None) -> int:
        if point is None:
            return self.pass_action
        try:
            return self.game.point_to_index[tuple(point)]
        except (KeyError, TypeError) as exc:
            raise ValueError(f"invalid grid position: {point!r}") from exc

    def legal_action_mask(self) -> tuple[int, ...]:
        if self.game.game_over:
            return (0,) * self.action_count
        legal = set(self.game.legal_moves())
        return tuple(int(point in legal) for point in self.game.valid_positions) + (1,)

    def _observation(self) -> dict[str, Any]:
        observation = encode_observation(self.game, self.observation_mode)
        observation["legal_action_mask"] = self.legal_action_mask()
        return observation

    def _info(
        self,
        acting_player: Player | None = None,
        reason: str | None = None,
        legal_action_mask: tuple[int, ...] | None = None,
    ) -> dict[str, Any]:
        rewards = self.game.rewards()
        winner = self.game.winner()
        return {
            "acting_player": acting_player.value if acting_player is not None else None,
            "current_player": self.game.current_player.value,
            "legal_action_mask": (
                legal_action_mask if legal_action_mask is not None else self.legal_action_mask()
            ),
            "winner": winner.value if isinstance(winner, Player) else winner,
            "rewards": {player.value: rewards[player] for player in rewards},
            "reason": reason,
            "turn_count": self.game.turn_count,
            "superko_mode": self.game.superko_mode,
        }

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if seed is not None:
            self._rng.seed(seed)
        start_player = Player.BLACK
        if options and "start_player" in options:
            start_player = Player(options["start_player"])
        self.game = LifelineGame(
            self.grid_size,
            start_player=start_player,
            superko_mode=self.superko_mode,
        )
        observation = self._observation()
        return observation, self._info(legal_action_mask=observation["legal_action_mask"])

    def step(self, action: int) -> tuple[dict[str, Any], float, bool, bool, dict[str, Any]]:
        if self.game.game_over:
            raise RuntimeError("step() called after termination; call reset()")
        acting_player = self.game.current_player
        point = self.action_to_point(action)
        result = self.game.skip_turn() if point is None else self.game.play_move(point)
        if not result.success:
            if self.illegal_action_mode == "raise":
                raise ValueError(f"illegal action {action}: {result.reason}")
            observation = self._observation()
            return (
                observation,
                -1.0,
                False,
                False,
                self._info(acting_player, result.reason, observation["legal_action_mask"]),
            )

        reward = self.game.rewards()[acting_player] if self.game.game_over else 0.0
        observation = self._observation()
        return (
            observation,
            reward,
            self.game.game_over,
            False,
            self._info(acting_player, legal_action_mask=observation["legal_action_mask"]),
        )

    def clone(self) -> EnvSnapshot:
        return EnvSnapshot(self.game.clone(), self._rng.getstate())

    def restore(self, snapshot: EnvSnapshot) -> None:
        self.game.restore(snapshot.game)
        self.superko_mode = self.game.superko_mode
        self._rng.setstate(snapshot.random_state)

    def serialize_state(self) -> dict[str, Any]:
        return self.game.serialize_state()

    def replay(self, actions: Iterable[int]) -> None:
        for ply, action in enumerate(actions):
            try:
                self.step(action)
            except (RuntimeError, TypeError, ValueError) as exc:
                raise ValueError(f"replay failed at ply {ply}, action {action}") from exc
