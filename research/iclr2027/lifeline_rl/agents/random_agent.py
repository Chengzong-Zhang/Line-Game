"""Uniform random legal-action baseline."""

from __future__ import annotations

import random
from dataclasses import dataclass

from ..core import LifelineGame
from .base import Action, legal_actions


@dataclass(frozen=True)
class RandomAgent:
    """Sample uniformly from all point moves and PASS."""

    label: str = "random"

    @property
    def name(self) -> str:
        return self.label

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        actions = legal_actions(game)
        if not actions:
            raise RuntimeError("cannot act in a terminal state")
        return rng.choice(actions)

    def diagnostics(self) -> dict[str, object]:
        return {}
