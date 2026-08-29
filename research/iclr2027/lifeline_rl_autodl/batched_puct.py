"""Independent-tree PUCT with cross-actor batched leaf inference.

This module deliberately lives outside ``lifeline_rl/``.  The frozen D14--D16
checkpoint source hash therefore remains unchanged while the AutoDL v2 path can
evolve under its own source identity.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from lifeline_rl.alphazero.puct import (
    PUCTConfig,
    PUCTSearch,
    PolicyValue,
    SearchResult,
    _Edge,
    _Node,
    _policy_from_visits,
    _sample_policy,
    _validate_temperature,
)
from lifeline_rl.core import LifelineGame


@runtime_checkable
class PolicyValueBatchEvaluator(Protocol):
    """One prediction per non-terminal game, preserving input order."""

    def evaluate_batch(
        self,
        games: Sequence[LifelineGame],
    ) -> Sequence[PolicyValue]:
        ...


class BatchedPUCTSearch(PUCTSearch):
    """Advance independent trees in lockstep and batch their new leaves."""

    def __init__(
        self,
        evaluator: PolicyValueBatchEvaluator,
        config: PUCTConfig | None = None,
    ) -> None:
        super().__init__(evaluator, config)

    def _expand_from_evaluation(
        self,
        game: LifelineGame,
        node: _Node,
        raw: object,
    ) -> float:
        if game.game_over:
            raise RuntimeError("terminal nodes must not be passed to the evaluator")
        if game.current_player is not node.player_to_act:
            raise RuntimeError("tree actor does not match restored game state")
        evaluation = self._coerce_evaluation(raw)
        try:
            value = float(evaluation.value)
        except (TypeError, ValueError) as exc:
            raise ValueError("evaluator value must be numeric") from exc
        if not math.isfinite(value) or not -1.0 <= value <= 1.0:
            raise ValueError("evaluator value must be finite and in [-1, 1]")
        legal_actions = self._legal_actions(game)
        normalized = self._normalized_priors(
            evaluation.priors,
            legal_actions,
            game.num_points + 1,
        )
        node.edges = {
            action: _Edge(prior=normalized[action])
            for action in legal_actions
        }
        return value

    def _evaluate_batch_and_expand(
        self,
        games: Sequence[LifelineGame],
        nodes: Sequence[_Node],
    ) -> tuple[float, ...]:
        if len(games) != len(nodes):
            raise ValueError("games and nodes must have the same length")
        if not games:
            return ()
        snapshots = tuple(game.clone() for game in games)
        evaluate_batch = getattr(self.evaluator, "evaluate_batch", None)
        try:
            if callable(evaluate_batch):
                raw_evaluations = tuple(evaluate_batch(games))
            else:
                raw_evaluations = tuple(
                    self.evaluator.evaluate(game) for game in games
                )
        finally:
            for game, snapshot in zip(games, snapshots):
                game.restore(snapshot)
        if len(raw_evaluations) != len(games):
            raise ValueError("evaluate_batch must return one result per game")
        return tuple(
            self._expand_from_evaluation(game, node, raw)
            for game, node, raw in zip(games, nodes, raw_evaluations)
        )

    @staticmethod
    def _flags(value: Sequence[bool] | bool, count: int) -> tuple[bool, ...]:
        if isinstance(value, bool):
            return (value,) * count
        flags = tuple(value)
        if len(flags) != count:
            raise ValueError("add_root_noise must match the number of games")
        if any(not isinstance(flag, bool) for flag in flags):
            raise TypeError("add_root_noise entries must be booleans")
        return flags

    def search_batch(
        self,
        games: Sequence[LifelineGame],
        rngs: Sequence[random.Random],
        *,
        temperatures: Sequence[float] | None = None,
        add_root_noise: Sequence[bool] | bool = False,
    ) -> tuple[SearchResult, ...]:
        games = tuple(games)
        rngs = tuple(rngs)
        if not games:
            raise ValueError("search_batch requires at least one game")
        if len(games) != len(rngs):
            raise ValueError("games and rngs must have the same length")
        if temperatures is None:
            normalized_temperatures = (1.0,) * len(games)
        else:
            if len(temperatures) != len(games):
                raise ValueError("temperatures must match the number of games")
            normalized_temperatures = tuple(
                _validate_temperature(value) for value in temperatures
            )
        root_noise_flags = self._flags(add_root_noise, len(games))

        root_snapshots = tuple(game.clone() for game in games)
        for index, snapshot in enumerate(root_snapshots):
            if snapshot.game_over:
                raise RuntimeError(
                    f"cannot search terminal state at batch index {index}"
                )
        roots = tuple(
            _Node(player_to_act=snapshot.current_player)
            for snapshot in root_snapshots
        )
        workers = tuple(self._new_worker(game) for game in games)
        for worker, snapshot in zip(workers, root_snapshots):
            worker.restore(snapshot)
        self._evaluate_batch_and_expand(workers, roots)
        for root, rng, enabled in zip(roots, rngs, root_noise_flags):
            if enabled and self.config.dirichlet_epsilon > 0.0:
                self._add_root_noise(root, rng)

        for _ in range(self.config.simulations):
            pending: list[
                tuple[LifelineGame, _Node, list[_Node], list[_Edge]]
            ] = []
            for root, worker, snapshot, rng in zip(
                roots, workers, root_snapshots, rngs
            ):
                worker.restore(snapshot)
                node = root
                visited_nodes: list[_Node] = [root]
                visited_edges: list[_Edge] = []
                while True:
                    action, edge = self._select_edge(node, rng)
                    self._apply_action(worker, action)
                    visited_edges.append(edge)
                    if edge.child is None:
                        child = _Node(player_to_act=worker.current_player)
                        edge.child = child
                        visited_nodes.append(child)
                        if worker.game_over:
                            self._backup(
                                visited_nodes,
                                visited_edges,
                                worker.rewards(),
                            )
                        else:
                            pending.append(
                                (worker, child, visited_nodes, visited_edges)
                            )
                        break
                    node = edge.child
                    visited_nodes.append(node)
                    if worker.game_over:
                        self._backup(
                            visited_nodes,
                            visited_edges,
                            worker.rewards(),
                        )
                        break

            if pending:
                values = self._evaluate_batch_and_expand(
                    [item[0] for item in pending],
                    [item[1] for item in pending],
                )
                for (_, child, nodes, edges), value in zip(pending, values):
                    self._backup(
                        nodes,
                        edges,
                        self._absolute_payoffs(child.player_to_act, value),
                    )

        results: list[SearchResult] = []
        for game, root, rng, temperature in zip(
            games, roots, rngs, normalized_temperatures
        ):
            action_count = game.num_points + 1
            visits = tuple(
                root.edges[action].visits if action in root.edges else 0
                for action in range(action_count)
            )
            priors = tuple(
                root.edges[action].prior if action in root.edges else 0.0
                for action in range(action_count)
            )
            q_values = tuple(
                root.edges[action].q_for(root.player_to_act)
                if action in root.edges
                else 0.0
                for action in range(action_count)
            )
            policy = _policy_from_visits(visits, priors, temperature)
            results.append(
                SearchResult(
                    action=_sample_policy(policy, rng),
                    root_player=root.player_to_act,
                    simulations=self.config.simulations,
                    visits=visits,
                    priors=priors,
                    policy=policy,
                    temperature=temperature,
                    q_values=q_values,
                )
            )
        return tuple(results)


__all__ = ["BatchedPUCTSearch", "PolicyValueBatchEvaluator"]
