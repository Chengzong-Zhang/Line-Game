"""UCT Monte Carlo tree search over the exact LIFELINE state."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from ..core import LifelineGame, Player
from .base import Action, legal_actions


@dataclass(frozen=True)
class MCTSConfig:
    simulations: int = 64
    exploration: float = math.sqrt(2.0)
    rollout_depth: int = 80

    def __post_init__(self) -> None:
        if self.simulations < 1:
            raise ValueError("simulations must be at least 1")
        if not math.isfinite(self.exploration) or self.exploration < 0:
            raise ValueError("exploration must be finite and non-negative")
        if self.rollout_depth < 0:
            raise ValueError("rollout_depth must be non-negative")


@dataclass(frozen=True)
class ActionStats:
    action: Action
    visits: int
    mean_value: float

    def to_dict(self, game: LifelineGame) -> dict[str, object]:
        return {
            "action": game.num_points if self.action is None else game.point_to_index[self.action],
            "point": None if self.action is None else list(self.action),
            "visits": self.visits,
            "mean_value": self.mean_value,
        }


@dataclass(frozen=True)
class SearchResult:
    action: Action
    root_player: Player
    simulations: int
    action_stats: tuple[ActionStats, ...]

    def to_dict(self, game: LifelineGame) -> dict[str, object]:
        return {
            "selected_action": (
                game.num_points if self.action is None else game.point_to_index[self.action]
            ),
            "selected_point": None if self.action is None else list(self.action),
            "root_player": self.root_player.value,
            "simulations": self.simulations,
            "actions": [stats.to_dict(game) for stats in self.action_stats],
        }


@dataclass
class _Node:
    player_to_act: Player
    parent: _Node | None = None
    action: Action = None
    unexpanded_actions: list[Action] = field(default_factory=list)
    children: dict[Action, _Node] = field(default_factory=dict)
    visits: int = 0
    value_sum: float = 0.0

    @property
    def mean_value(self) -> float:
        return self.value_sum / self.visits if self.visits else 0.0


class MCTSAgent:
    """Adversarial UCT with uniform random rollouts.

    Values are stored from the root player's perspective. At opponent nodes the
    exploitation term is negated, so both sides select actions for themselves
    rather than cooperatively maximizing the root value.
    """

    def __init__(self, config: MCTSConfig | None = None, label: str | None = None):
        self.config = config or MCTSConfig()
        self.label = label
        self.last_search: SearchResult | None = None

    @property
    def name(self) -> str:
        return self.label or (
            f"uct_mcts_s{self.config.simulations}_d{self.config.rollout_depth}"
        )

    @staticmethod
    def _apply_action(game: LifelineGame, action: Action) -> None:
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise RuntimeError(f"MCTS generated an illegal action: {action!r} ({result.reason})")

    def _select_child(
        self,
        node: _Node,
        root_player: Player,
        rng: random.Random,
    ) -> _Node:
        log_parent = math.log(max(1, node.visits))
        actor_sign = 1.0 if node.player_to_act is root_player else -1.0
        best_score = -math.inf
        best_children: list[_Node] = []
        for child in node.children.values():
            exploitation = actor_sign * child.mean_value
            exploration = self.config.exploration * math.sqrt(log_parent / child.visits)
            score = exploitation + exploration
            if score > best_score + 1e-15:
                best_score = score
                best_children = [child]
            elif abs(score - best_score) <= 1e-15:
                best_children.append(child)
        if not best_children:
            raise RuntimeError("cannot select from a node without children")
        return rng.choice(best_children)

    def _rollout(
        self,
        game: LifelineGame,
        root_player: Player,
        rng: random.Random,
    ) -> float:
        for _ in range(self.config.rollout_depth):
            if game.game_over:
                break
            action = rng.choice(legal_actions(game))
            self._apply_action(game, action)
        if not game.game_over:
            return 0.0
        return game.rewards()[root_player]

    def search(self, game: LifelineGame, rng: random.Random) -> SearchResult:
        if game.game_over:
            raise RuntimeError("cannot search a terminal state")

        root_snapshot = game.clone()
        root_player = game.current_player
        root_actions = legal_actions(game)
        root = _Node(
            player_to_act=root_player,
            unexpanded_actions=list(root_actions),
        )
        working = LifelineGame(
            game.grid_size,
            start_player=game.start_player,
            superko_mode=game.superko_mode,
        )

        for _ in range(self.config.simulations):
            working.restore(root_snapshot)
            node = root

            while (
                not working.game_over
                and not node.unexpanded_actions
                and node.children
            ):
                node = self._select_child(node, root_player, rng)
                self._apply_action(working, node.action)

            if not working.game_over and node.unexpanded_actions:
                index = rng.randrange(len(node.unexpanded_actions))
                action = node.unexpanded_actions.pop(index)
                self._apply_action(working, action)
                child = _Node(
                    player_to_act=working.current_player,
                    parent=node,
                    action=action,
                    unexpanded_actions=legal_actions(working),
                )
                node.children[action] = child
                node = child

            value = self._rollout(working, root_player, rng)
            cursor: _Node | None = node
            while cursor is not None:
                cursor.visits += 1
                cursor.value_sum += value
                cursor = cursor.parent

        stats = tuple(
            ActionStats(
                action=action,
                visits=root.children[action].visits if action in root.children else 0,
                mean_value=(
                    root.children[action].mean_value if action in root.children else 0.0
                ),
            )
            for action in root_actions
        )
        most_visits = max(item.visits for item in stats)
        candidates = [item for item in stats if item.visits == most_visits]
        best_value = max(item.mean_value for item in candidates)
        candidates = [item for item in candidates if item.mean_value == best_value]
        selected = rng.choice(candidates).action
        return SearchResult(
            action=selected,
            root_player=root_player,
            simulations=self.config.simulations,
            action_stats=stats,
        )

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        self.last_search = self.search(game, rng)
        return self.last_search.action

    def diagnostics(self) -> dict[str, object]:
        if self.last_search is None:
            return {}
        return {
            "root_player": self.last_search.root_player.value,
            "simulations": self.last_search.simulations,
            "selected_visits": next(
                item.visits
                for item in self.last_search.action_stats
                if item.action == self.last_search.action
            ),
            "selected_mean_value": next(
                item.mean_value
                for item in self.last_search.action_stats
                if item.action == self.last_search.action
            ),
            "exploration": self.config.exploration,
            "rollout_depth": self.config.rollout_depth,
            "root_actions": [
                {
                    "point": None if item.action is None else list(item.action),
                    "visits": item.visits,
                    "mean_value": item.mean_value,
                }
                for item in self.last_search.action_stats
            ],
        }
