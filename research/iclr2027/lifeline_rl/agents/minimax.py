"""Depth-limited alpha-beta Minimax over lossless LIFELINE snapshots."""

from __future__ import annotations

import math
import random
from dataclasses import asdict, dataclass

from ..core import LifelineGame, PLAYER_STATES, Player
from .base import Action, apply_action
from .heuristic import HeuristicWeights, heuristic_score


@dataclass(frozen=True)
class MinimaxConfig:
    depth: int = 2
    move_cap: int = 20
    weights: HeuristicWeights = HeuristicWeights()

    def __post_init__(self) -> None:
        if not isinstance(self.depth, int) or isinstance(self.depth, bool):
            raise TypeError("depth must be an integer")
        if self.depth < 1:
            raise ValueError("depth must be at least 1")
        if not isinstance(self.move_cap, int) or isinstance(self.move_cap, bool):
            raise TypeError("move_cap must be an integer")
        if self.move_cap < 1:
            raise ValueError("move_cap must be at least 1")


@dataclass(frozen=True)
class MinimaxActionScore:
    action: Action
    value: float


@dataclass(frozen=True)
class MinimaxSearchResult:
    action: Action
    root_player: Player
    value: float
    action_scores: tuple[MinimaxActionScore, ...]
    nodes: int
    leaf_evaluations: int
    alpha_beta_cutoffs: int
    max_point_branching: int


class MinimaxAgent:
    """Adversarial depth-limited search with the disclosed top-k point cap.

    At every node, legal point moves use the legacy tactical ordering:
    attacks on an opponent line first, then moves adjacent to an own line,
    followed by all remaining moves.  Canonical point order breaks ties.  The
    first ``move_cap`` point moves are searched and PASS is appended as an
    additional branch, so the maximum branching factor is ``move_cap + 1``.
    """

    def __init__(self, config: MinimaxConfig | None = None, label: str | None = None):
        self.config = config or MinimaxConfig()
        self.label = label
        self.last_search: MinimaxSearchResult | None = None
        self._nodes = 0
        self._leaf_evaluations = 0
        self._alpha_beta_cutoffs = 0
        self._max_point_branching = 0

    @property
    def name(self) -> str:
        return self.label or f"minimax_d{self.config.depth}_cap{self.config.move_cap}"

    def ordered_actions(self, game: LifelineGame) -> list[Action]:
        """Return capped tactical point moves followed by the PASS action."""

        actor = game.current_player
        own_line = PLAYER_STATES[actor][1]
        opponent_line = PLAYER_STATES[game.opponent(actor)][1]
        tiers: list[list[Action]] = [[], [], []]
        for point in game.legal_moves():
            state = game.get_state(point)
            if state == opponent_line:
                tiers[0].append(point)
            elif any(game.get_state(adjacent) == own_line for adjacent in game.adjacent_positions(point)):
                tiers[1].append(point)
            else:
                tiers[2].append(point)
        point_actions = [action for tier in tiers for action in tier][: self.config.move_cap]
        self._max_point_branching = max(self._max_point_branching, len(point_actions))
        return [*point_actions, None]

    def _evaluate(self, game: LifelineGame, root_player: Player) -> float:
        self._leaf_evaluations += 1
        return heuristic_score(game, root_player, self.config.weights)

    def _minimax(
        self,
        game: LifelineGame,
        depth: int,
        alpha: float,
        beta: float,
        root_player: Player,
    ) -> float:
        self._nodes += 1
        if game.game_over or depth == 0:
            return self._evaluate(game, root_player)

        maximizing = game.current_player is root_player
        best = -math.inf if maximizing else math.inf
        snapshot = game.clone()
        for action in self.ordered_actions(game):
            game.restore(snapshot)
            apply_action(game, action, source="Minimax")
            value = self._minimax(game, depth - 1, alpha, beta, root_player)
            if maximizing:
                best = max(best, value)
                alpha = max(alpha, best)
            else:
                best = min(best, value)
                beta = min(beta, best)
            if beta <= alpha:
                self._alpha_beta_cutoffs += 1
                break
        game.restore(snapshot)
        return best

    def search(self, game: LifelineGame) -> MinimaxSearchResult:
        if game.game_over:
            raise RuntimeError("cannot search a terminal state")
        self._nodes = 0
        self._leaf_evaluations = 0
        self._alpha_beta_cutoffs = 0
        self._max_point_branching = 0

        root_snapshot = game.clone()
        root_player = game.current_player
        worker = LifelineGame(
            game.grid_size,
            start_player=game.start_player,
            superko_mode=game.superko_mode,
        )
        worker.restore(root_snapshot)
        scores: list[MinimaxActionScore] = []
        for action in self.ordered_actions(worker):
            worker.restore(root_snapshot)
            apply_action(worker, action, source="Minimax")
            value = self._minimax(
                worker,
                self.config.depth - 1,
                -math.inf,
                math.inf,
                root_player,
            )
            scores.append(MinimaxActionScore(action=action, value=value))

        best_value = max(item.value for item in scores)
        selected = next(item.action for item in scores if item.value == best_value)
        return MinimaxSearchResult(
            action=selected,
            root_player=root_player,
            value=best_value,
            action_scores=tuple(scores),
            nodes=self._nodes,
            leaf_evaluations=self._leaf_evaluations,
            alpha_beta_cutoffs=self._alpha_beta_cutoffs,
            max_point_branching=self._max_point_branching,
        )

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        del rng  # Canonical ordering and tie-breaking are deterministic.
        self.last_search = self.search(game)
        return self.last_search.action

    def diagnostics(self) -> dict[str, object]:
        if self.last_search is None:
            return {}
        return {
            "root_player": self.last_search.root_player.value,
            "value": self.last_search.value,
            "nodes": self.last_search.nodes,
            "leaf_evaluations": self.last_search.leaf_evaluations,
            "alpha_beta_cutoffs": self.last_search.alpha_beta_cutoffs,
            "max_point_branching": self.last_search.max_point_branching,
            "config": asdict(self.config),
            "root_actions": [
                {
                    "point": None if item.action is None else list(item.action),
                    "value": item.value,
                }
                for item in self.last_search.action_scores
            ],
        }
