"""Bounded positive-control agent that searches for reachable Superko cycles.

The agent is deliberately an engineering diagnostic, not a competitive
baseline.  It searches counterfactually with ``superko_mode="observe"`` so a
path may end by selecting a move that the default rules would reject.  The
action returned to the real game is nevertheless always legal in that game's
current mode.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, replace
from typing import Iterable, Literal, Sequence

from ..core import GameSnapshot, LifelineGame, Player, StateKey
from .base import Action, apply_action, legal_actions


Fallback = Literal["random", "first"]


@dataclass(frozen=True)
class CycleSeekingConfig:
    """Finite search limits and the explicit no-cycle fallback."""

    max_depth: int = 6
    branch_limit: int = 8
    node_budget: int = 25_000
    fallback: Fallback = "random"

    def __post_init__(self) -> None:
        for name, value in (
            ("max_depth", self.max_depth),
            ("branch_limit", self.branch_limit),
            ("node_budget", self.node_budget),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.fallback not in ("random", "first"):
            raise ValueError("fallback must be 'random' or 'first'")


@dataclass(frozen=True)
class CycleSearchResult:
    """Auditable result of one bounded search."""

    action: Action
    path: tuple[Action, ...]
    reason: str
    root_mode: str
    nodes_expanded: int
    max_depth_reached: int
    repeat_action: Action = None

    @property
    def found_cycle(self) -> bool:
        return self.reason in ("immediate_repeat", "counterfactual_cycle")

    def to_dict(self) -> dict[str, object]:
        def encode(action: Action) -> list[int] | None:
            return None if action is None else [action[0], action[1]]

        return {
            "action": encode(self.action),
            "path": [encode(action) for action in self.path],
            "reason": self.reason,
            "root_mode": self.root_mode,
            "nodes_expanded": self.nodes_expanded,
            "max_depth_reached": self.max_depth_reached,
            "repeat_action": encode(self.repeat_action),
            "found_cycle": self.found_cycle,
        }


@dataclass(frozen=True)
class GuidedCycleCheck:
    """Result of checking a caller-supplied positive-control path.

    This helper performs no search and is never consulted by
    :class:`CycleSeekingAgent`; fixture-guided validation therefore remains
    visibly separate from the generic bounded search.
    """

    valid: bool
    closes_root_position: bool
    repeat_action: Action
    reason: str | None = None


@dataclass
class _SearchBudget:
    nodes_expanded: int = 0
    max_depth_reached: int = 0


def _observe_snapshot(snapshot: GameSnapshot) -> GameSnapshot:
    return replace(snapshot, superko_mode="observe")


def _new_game_from_snapshot(grid_size: int, snapshot: GameSnapshot) -> LifelineGame:
    game = LifelineGame(
        grid_size,
        start_player=snapshot.start_player,
        superko_mode="observe",
    )
    game.restore(_observe_snapshot(snapshot))
    return game


def _position_projection(game: LifelineGame) -> tuple[object, ...]:
    snapshot = game.clone()
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def _state_key_distance(left: StateKey, right: StateKey) -> int:
    """Small structural distance used only to order the bounded search."""

    player_cost = 4 if left[0] != right[0] else 0
    occupied_cost = len(set(left[1]).symmetric_difference(right[1]))
    black_edge_cost = len(set(left[2]).symmetric_difference(right[2]))
    white_edge_cost = len(set(left[3]).symmetric_difference(right[3]))
    return player_cost + occupied_cost + black_edge_cost + white_edge_cost


def _distance_to_history(game: LifelineGame, targets: frozenset[StateKey]) -> int:
    current = game._compute_state_key(game.current_player)
    return min(_state_key_distance(current, target) for target in targets)


def check_fixture_guided_cycle(
    game: LifelineGame,
    actions: Sequence[Action],
) -> GuidedCycleCheck:
    """Validate one explicitly supplied path in counterfactual observe mode.

    The last action must be a point move marked ``would_violate_superko``.  The
    returned ``closes_root_position`` flag separately records whether accepting
    it restores the rule-relevant root position.  The input game is untouched.
    """

    if game.game_over:
        return GuidedCycleCheck(False, False, None, "terminal_root")
    if not actions:
        return GuidedCycleCheck(False, False, None, "empty_path")

    root = game.clone()
    root_projection = _position_projection(game)
    working = _new_game_from_snapshot(game.grid_size, root)
    repeat_action: Action = None

    for index, action in enumerate(actions):
        is_last = index == len(actions) - 1
        if action is None:
            if is_last:
                return GuidedCycleCheck(False, False, None, "pass_cannot_trigger_superko")
            result = working.skip_turn()
        else:
            evaluated = working.evaluate_move(action)
            if is_last and not evaluated.would_violate_superko:
                return GuidedCycleCheck(False, False, None, "last_action_is_not_repeat")
            result = working.play_move(action)
            if is_last:
                repeat_action = action
        if not result.success:
            return GuidedCycleCheck(False, False, repeat_action, result.reason)

    return GuidedCycleCheck(
        valid=repeat_action is not None,
        closes_root_position=_position_projection(working) == root_projection,
        repeat_action=repeat_action,
    )


class CycleSeekingAgent:
    """Seek a nearby history repetition with a finite counterfactual search."""

    def __init__(
        self,
        config: CycleSeekingConfig | None = None,
        label: str | None = None,
    ) -> None:
        self.config = config or CycleSeekingConfig()
        self.label = label
        self.last_search: CycleSearchResult | None = None

    @property
    def name(self) -> str:
        return self.label or (
            f"cycle_seeking_d{self.config.max_depth}"
            f"_b{self.config.branch_limit}_n{self.config.node_budget}"
        )

    @staticmethod
    def _canonical_action_key(game: LifelineGame, action: Action) -> int:
        return game.num_points if action is None else game.point_to_index[action]

    def _ordered_successors(
        self,
        game: LifelineGame,
        actions: Iterable[Action],
        targets: frozenset[StateKey],
        rng: random.Random,
    ) -> list[tuple[Action, LifelineGame]]:
        scored: list[tuple[tuple[object, ...], Action, LifelineGame]] = []
        snapshot = game.clone()
        for action in actions:
            child = _new_game_from_snapshot(game.grid_size, snapshot)
            try:
                apply_action(child, action, source="CycleSeekingAgent search")
            except RuntimeError:
                continue
            direct_repeat = (
                bool(child.would_violate_superko_moves())
                if not child.game_over
                else False
            )
            distance = _distance_to_history(child, targets) if not child.game_over else 10**9
            score = (
                0 if direct_repeat else 1,
                distance,
                rng.random(),
                self._canonical_action_key(game, action),
            )
            scored.append((score, action, child))
        scored.sort(key=lambda item: item[0])
        return [
            (action, child)
            for _, action, child in scored[: self.config.branch_limit]
        ]

    def _find_path(
        self,
        game: LifelineGame,
        targets: frozenset[StateKey],
        rng: random.Random,
        budget: _SearchBudget,
        *,
        depth: int,
        allow_current_repeat: bool,
        root_actions: tuple[Action, ...] | None = None,
    ) -> tuple[Action, ...] | None:
        if budget.nodes_expanded >= self.config.node_budget:
            return None
        budget.nodes_expanded += 1
        budget.max_depth_reached = max(budget.max_depth_reached, depth)

        if game.game_over:
            return None
        if depth >= self.config.max_depth:
            return None
        if allow_current_repeat:
            repeats = sorted(
                game.would_violate_superko_moves(),
                key=lambda action: self._canonical_action_key(game, action),
            )
            if repeats:
                return (rng.choice(repeats),)

        actions = root_actions if root_actions is not None else tuple(legal_actions(game))
        for action, child in self._ordered_successors(game, actions, targets, rng):
            suffix = self._find_path(
                child,
                targets,
                rng,
                budget,
                depth=depth + 1,
                allow_current_repeat=True,
            )
            if suffix is not None:
                return (action, *suffix)
            if budget.nodes_expanded >= self.config.node_budget:
                break
        return None

    def _fallback(self, actions: list[Action], rng: random.Random) -> Action:
        if self.config.fallback == "first":
            return actions[0]
        return rng.choice(actions)

    def search(self, game: LifelineGame, rng: random.Random) -> CycleSearchResult:
        """Search without mutating ``game`` and return an auditable plan."""

        if game.game_over:
            raise RuntimeError("cannot search a terminal state")
        root_snapshot = game.clone()
        root_actions = legal_actions(game)
        if not root_actions:
            raise RuntimeError("cannot act without a legal action")

        if game.superko_mode == "observe":
            immediate = [
                action
                for action in game.would_violate_superko_moves()
                if action in root_actions
            ]
            if immediate:
                action = rng.choice(sorted(immediate, key=game.point_to_index.__getitem__))
                return CycleSearchResult(
                    action=action,
                    path=(action,),
                    reason="immediate_repeat",
                    root_mode=game.superko_mode,
                    nodes_expanded=0,
                    max_depth_reached=0,
                    repeat_action=action,
                )

        working = _new_game_from_snapshot(game.grid_size, root_snapshot)
        budget = _SearchBudget()
        path = self._find_path(
            working,
            root_snapshot.history_hashes,
            rng,
            budget,
            depth=0,
            allow_current_repeat=False,
            root_actions=tuple(root_actions),
        )
        if path is not None and path[0] in root_actions:
            return CycleSearchResult(
                action=path[0],
                path=path,
                reason="counterfactual_cycle",
                root_mode=game.superko_mode,
                nodes_expanded=budget.nodes_expanded,
                max_depth_reached=budget.max_depth_reached,
                repeat_action=path[-1],
            )

        action = self._fallback(root_actions, rng)
        return CycleSearchResult(
            action=action,
            path=(action,),
            reason=f"fallback_{self.config.fallback}",
            root_mode=game.superko_mode,
            nodes_expanded=budget.nodes_expanded,
            max_depth_reached=budget.max_depth_reached,
        )

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        self.last_search = self.search(game, rng)
        return self.last_search.action

    def diagnostics(self) -> dict[str, object]:
        if self.last_search is None:
            return {}
        return self.last_search.to_dict()
