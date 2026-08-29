"""Deterministic one-ply greedy baseline."""

from __future__ import annotations

import random
from dataclasses import dataclass

from ..core import LifelineGame, Player
from .base import Action, apply_action, legal_actions
from .heuristic import HeuristicWeights, heuristic_features, heuristic_score


@dataclass(frozen=True)
class GreedyActionScore:
    action: Action
    score: float
    features: dict[str, int]


@dataclass(frozen=True)
class GreedyConfig:
    weights: HeuristicWeights = HeuristicWeights()


@dataclass(frozen=True)
class GreedySearchResult:
    action: Action
    root_player: Player
    action_scores: tuple[GreedyActionScore, ...]


class GreedyAgent:
    """Choose the highest-scoring legal successor, breaking ties canonically."""

    def __init__(
        self,
        config: GreedyConfig | None = None,
        label: str = "greedy",
    ) -> None:
        self.config = config or GreedyConfig()
        self.label = label
        self.last_search: GreedySearchResult | None = None

    @property
    def name(self) -> str:
        return self.label

    def search(self, game: LifelineGame) -> GreedySearchResult:
        if game.game_over:
            raise RuntimeError("cannot search a terminal state")
        root_snapshot = game.clone()
        root_player = game.current_player
        worker = LifelineGame(
            game.grid_size,
            start_player=game.start_player,
            superko_mode=game.superko_mode,
        )
        scores: list[GreedyActionScore] = []
        for action in legal_actions(game):
            worker.restore(root_snapshot)
            apply_action(worker, action, source="Greedy")
            features = heuristic_features(worker, root_player)
            scores.append(
                GreedyActionScore(
                    action=action,
                    score=heuristic_score(worker, root_player, self.config.weights),
                    features=features,
                )
            )
        best_score = max(item.score for item in scores)
        selected = next(item.action for item in scores if item.score == best_score)
        return GreedySearchResult(
            action=selected,
            root_player=root_player,
            action_scores=tuple(scores),
        )

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        del rng  # Canonical tie-breaking makes this baseline deterministic.
        self.last_search = self.search(game)
        return self.last_search.action

    def diagnostics(self) -> dict[str, object]:
        if self.last_search is None:
            return {}
        selected = next(
            item for item in self.last_search.action_scores if item.action == self.last_search.action
        )
        return {
            "root_player": self.last_search.root_player.value,
            "selected_score": selected.score,
            "actions_evaluated": len(self.last_search.action_scores),
            "heuristic": "100*node_advantage + 10*line_advantage + "
            "5*logical_edge_advantage + frontier_advantage",
            "root_actions": [
                {
                    "point": None if item.action is None else list(item.action),
                    "score": item.score,
                    "features": item.features,
                }
                for item in self.last_search.action_scores
            ],
        }
