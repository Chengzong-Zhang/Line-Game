"""Common policy interface and action helpers."""

from __future__ import annotations

import random
from typing import Protocol, TypeAlias, runtime_checkable

from ..core import LifelineGame, Point

Action: TypeAlias = Point | None


@runtime_checkable
class Agent(Protocol):
    """Minimal interface consumed by the arena."""

    @property
    def name(self) -> str:
        ...

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        ...

    def diagnostics(self) -> dict[str, object]:
        ...


def legal_actions(game: LifelineGame) -> list[Action]:
    """Return point moves in canonical order followed by PASS."""

    if game.game_over:
        return []
    return [*game.legal_moves(), None]


def apply_action(game: LifelineGame, action: Action, *, source: str = "agent") -> None:
    """Apply one already-selected action and fail loudly on search bugs."""

    result = game.skip_turn() if action is None else game.play_move(action)
    if not result.success:
        raise RuntimeError(f"{source} generated illegal action {action!r}: {result.reason}")
