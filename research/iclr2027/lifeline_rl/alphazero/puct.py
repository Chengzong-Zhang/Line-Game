"""Dependency-free policy/value guided Monte Carlo tree search.

The public action space is the same fixed integer space used by
``LifelineEnv``: board points occupy ``[0, game.num_points)`` and PASS is the
last action, ``game.num_points``.  Evaluator values are always interpreted from
the perspective of the player to act in the supplied state.

No search transition is ever applied to the caller's game.  A complete
``GameSnapshot`` (including Superko history) is restored into a private worker
before every simulation.
"""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from ..core import LifelineGame, Player


PriorVector = Sequence[float] | Mapping[int, float]


@dataclass(frozen=True)
class PolicyValue:
    """One evaluator prediction for a non-terminal state.

    ``value`` is from ``game.current_player``'s perspective. ``priors`` may be
    either a full action vector or a sparse integer-action mapping.  PUCT masks
    illegal actions, clips unusable weights to zero, and normalizes the legal
    mass.  If no usable legal mass remains, it falls back to a uniform legal
    distribution.
    """

    value: float
    priors: PriorVector


@runtime_checkable
class PolicyValueEvaluator(Protocol):
    """Minimal inference interface consumed by :class:`PUCTSearch`."""

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        """Return a current-player value and fixed-space action priors."""


@dataclass(frozen=True)
class PUCTConfig:
    """Search hyperparameters independent of any tensor framework."""

    simulations: int = 64
    c_puct: float = 1.5
    dirichlet_alpha: float = 0.3
    dirichlet_epsilon: float = 0.25

    def __post_init__(self) -> None:
        if isinstance(self.simulations, bool) or not isinstance(self.simulations, int):
            raise TypeError("simulations must be an integer")
        if self.simulations < 1:
            raise ValueError("simulations must be at least 1")
        if not math.isfinite(self.c_puct) or self.c_puct < 0.0:
            raise ValueError("c_puct must be finite and non-negative")
        if not math.isfinite(self.dirichlet_alpha) or self.dirichlet_alpha <= 0.0:
            raise ValueError("dirichlet_alpha must be finite and positive")
        if (
            not math.isfinite(self.dirichlet_epsilon)
            or not 0.0 <= self.dirichlet_epsilon <= 1.0
        ):
            raise ValueError("dirichlet_epsilon must be finite and in [0, 1]")


def _validate_temperature(temperature: float) -> float:
    if isinstance(temperature, bool):
        raise TypeError("temperature must be a real number")
    try:
        normalized = float(temperature)
    except (TypeError, ValueError) as exc:
        raise TypeError("temperature must be a real number") from exc
    if not math.isfinite(normalized) or normalized < 0.0:
        raise ValueError("temperature must be finite and non-negative")
    return normalized


def _policy_from_visits(
    visits: Sequence[int],
    priors: Sequence[float],
    temperature: float,
) -> tuple[float, ...]:
    """Convert root visit counts into a numerically stable policy."""

    normalized_temperature = _validate_temperature(temperature)
    if len(visits) != len(priors):
        raise ValueError("visits and priors must have the same length")

    # A legal action can legitimately have a zero network prior and still gain
    # visits (for example after a favorable Q estimate).  Such actions must not
    # disappear from the temperature policy.  Illegal actions have both zero
    # prior and zero visits.
    support = [
        index
        for index, prior in enumerate(priors)
        if prior > 0.0 or visits[index] > 0
    ]
    if not support:
        raise ValueError("root priors contain no legal-action support")

    if normalized_temperature == 0.0:
        best = max(visits[index] for index in support)
        # Canonical tie-breaking makes evaluation at temperature zero fully
        # deterministic; stochastic self-play should use a positive value.
        selected = next(index for index in support if visits[index] == best)
        return tuple(1.0 if index == selected else 0.0 for index in range(len(visits)))

    positive_visits = [index for index in support if visits[index] > 0]
    if not positive_visits:
        total_prior = math.fsum(priors[index] for index in support)
        return tuple(
            priors[index] / total_prior if index in support else 0.0
            for index in range(len(visits))
        )

    inverse_temperature = 1.0 / normalized_temperature
    log_weights = {
        index: math.log(visits[index]) * inverse_temperature
        for index in positive_visits
    }
    largest = max(log_weights.values())
    weights = {
        index: math.exp(log_weight - largest)
        for index, log_weight in log_weights.items()
    }
    total = math.fsum(weights.values())
    return tuple(weights.get(index, 0.0) / total for index in range(len(visits)))


def _sample_policy(policy: Sequence[float], rng: random.Random) -> int:
    positive = [index for index, probability in enumerate(policy) if probability > 0.0]
    if not positive:
        raise ValueError("cannot sample an empty policy")
    if len(positive) == 1:
        return positive[0]

    threshold = rng.random()
    cumulative = 0.0
    for index in positive[:-1]:
        cumulative += policy[index]
        if threshold < cumulative:
            return index
    # Returning the final supported action absorbs harmless floating-point
    # normalization residue without ever selecting an illegal zero entry.
    return positive[-1]


@dataclass(frozen=True)
class SearchResult:
    """Fixed-action-space root statistics and the sampled search action."""

    action: int
    root_player: Player
    simulations: int
    visits: tuple[int, ...]
    priors: tuple[float, ...]
    policy: tuple[float, ...]
    temperature: float
    q_values: tuple[float, ...]

    @property
    def selected_action(self) -> int:
        """Alias useful to logging code that prefers an explicit field name."""

        return self.action

    @property
    def visit_counts(self) -> tuple[int, ...]:
        """Descriptive alias for :attr:`visits`."""

        return self.visits

    def root_policy(self, temperature: float | None = None) -> tuple[float, ...]:
        """Return a visit-count policy at a requested temperature.

        With no argument, the exact policy used to select ``action`` is
        returned.  At temperature zero the canonical lowest-index maximum is
        selected; for positive temperatures the policy is proportional to
        ``visits ** (1 / temperature)``.
        """

        if temperature is None:
            return self.policy
        return _policy_from_visits(self.visits, self.priors, temperature)

    def select_action(
        self,
        rng: random.Random,
        temperature: float | None = None,
    ) -> int:
        """Sample again from this root, optionally at another temperature."""

        return _sample_policy(self.root_policy(temperature), rng)


@dataclass
class _Edge:
    prior: float
    child: _Node | None = None
    visits: int = 0
    payoff_sums: dict[Player, float] = field(
        default_factory=lambda: {Player.BLACK: 0.0, Player.WHITE: 0.0}
    )

    def q_for(self, player: Player) -> float:
        return self.payoff_sums[player] / self.visits if self.visits else 0.0


@dataclass
class _Node:
    player_to_act: Player
    edges: dict[int, _Edge] = field(default_factory=dict)
    visits: int = 0


class PUCTSearch:
    """Policy/value guided search with absolute-player payoff backup.

    Edge values are accumulated separately for BLACK and WHITE rather than
    flipped blindly at every depth.  This is important for LIFELINE because a
    placement may auto-skip the opponent and leave the same player to act at
    the child state.
    """

    def __init__(
        self,
        evaluator: PolicyValueEvaluator,
        config: PUCTConfig | None = None,
    ) -> None:
        evaluate = getattr(evaluator, "evaluate", None)
        if not callable(evaluate):
            raise TypeError("evaluator must define evaluate(game)")
        self.evaluator = evaluator
        self.config = config or PUCTConfig()

    @staticmethod
    def _new_worker(game: LifelineGame) -> LifelineGame:
        return LifelineGame(
            game.grid_size,
            start_player=game.start_player,
            superko_mode=game.superko_mode,
        )

    @staticmethod
    def _legal_actions(game: LifelineGame) -> tuple[int, ...]:
        if game.game_over:
            return ()
        # legal_moves() already follows canonical point-index order. PASS is
        # legal in every non-terminal state and is always the final action.
        return tuple(game.point_to_index[point] for point in game.legal_moves()) + (
            game.num_points,
        )

    @staticmethod
    def _apply_action(game: LifelineGame, action: int) -> None:
        result = (
            game.skip_turn()
            if action == game.num_points
            else game.play_move(game.valid_positions[action])
        )
        if not result.success:
            raise RuntimeError(
                f"PUCT generated illegal integer action {action}: {result.reason}"
            )

    @staticmethod
    def _coerce_evaluation(raw: object) -> PolicyValue:
        if isinstance(raw, PolicyValue):
            return raw
        # Attribute-shaped results make lightweight model adapters convenient.
        if hasattr(raw, "value") and hasattr(raw, "priors"):
            return PolicyValue(getattr(raw, "value"), getattr(raw, "priors"))
        # A two-tuple is accepted as a small dependency-free convenience.
        if isinstance(raw, tuple) and len(raw) == 2:
            return PolicyValue(raw[0], raw[1])
        raise TypeError("evaluator.evaluate() must return PolicyValue(value, priors)")

    @staticmethod
    def _normalized_priors(
        priors: PriorVector,
        legal_actions: Sequence[int],
        action_count: int,
    ) -> dict[int, float]:
        if isinstance(priors, Mapping):
            def raw_weight(action: int) -> object:
                return priors.get(action, 0.0)
        elif isinstance(priors, Sequence) and not isinstance(priors, (str, bytes)):
            if len(priors) != action_count:
                raise ValueError(
                    f"evaluator returned {len(priors)} priors for {action_count} actions"
                )

            def raw_weight(action: int) -> object:
                return priors[action]
        else:
            raise TypeError("priors must be a full sequence or integer-action mapping")

        weights: dict[int, float] = {}
        for action in legal_actions:
            try:
                weight = float(raw_weight(action))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"prior for legal action {action} is not numeric") from exc
            # Model adapters can safely emit masked logits containing NaN,
            # infinity, or negative sentinel values: none receive legal mass.
            weights[action] = weight if math.isfinite(weight) and weight > 0.0 else 0.0

        total = math.fsum(weights.values())
        if total <= 0.0:
            uniform = 1.0 / len(legal_actions)
            return {action: uniform for action in legal_actions}
        return {action: weight / total for action, weight in weights.items()}

    def _evaluate_and_expand(self, game: LifelineGame, node: _Node) -> float:
        if game.game_over:
            raise RuntimeError("terminal nodes must not be passed to the evaluator")
        if game.current_player is not node.player_to_act:
            raise RuntimeError("tree actor does not match restored game state")

        legal_actions = self._legal_actions(game)
        state_before_evaluation = game.clone()
        raw = self.evaluator.evaluate(game)
        # Evaluation is specified as read-only, but restoring here also keeps a
        # buggy adapter from corrupting subsequent search transitions.
        game.restore(state_before_evaluation)
        evaluation = self._coerce_evaluation(raw)
        try:
            value = float(evaluation.value)
        except (TypeError, ValueError) as exc:
            raise ValueError("evaluator value must be numeric") from exc
        if not math.isfinite(value):
            raise ValueError("evaluator value must be finite")
        if not -1.0 <= value <= 1.0:
            raise ValueError("evaluator value must be in [-1, 1]")

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

    def _add_root_noise(self, root: _Node, rng: random.Random) -> None:
        actions = tuple(root.edges)
        samples = [
            rng.gammavariate(self.config.dirichlet_alpha, 1.0)
            for _ in actions
        ]
        total = math.fsum(samples)
        if total <= 0.0 or not math.isfinite(total):
            noise = [1.0 / len(actions)] * len(actions)
        else:
            noise = [sample / total for sample in samples]
        epsilon = self.config.dirichlet_epsilon
        for action, component in zip(actions, noise):
            edge = root.edges[action]
            edge.prior = (1.0 - epsilon) * edge.prior + epsilon * component

        # Renormalize to eliminate accumulated floating-point residue.
        mixed_total = math.fsum(edge.prior for edge in root.edges.values())
        for edge in root.edges.values():
            edge.prior /= mixed_total

    def _select_edge(
        self,
        node: _Node,
        rng: random.Random,
    ) -> tuple[int, _Edge]:
        if not node.edges:
            raise RuntimeError("cannot select an action from an unexpanded node")
        parent_scale = math.sqrt(max(1, node.visits))
        best_score = -math.inf
        candidates: list[tuple[int, _Edge]] = []
        for action, edge in node.edges.items():
            q_value = edge.q_for(node.player_to_act)
            exploration = (
                self.config.c_puct
                * edge.prior
                * parent_scale
                / (1 + edge.visits)
            )
            score = q_value + exploration
            if score > best_score + 1e-15:
                best_score = score
                candidates = [(action, edge)]
            elif abs(score - best_score) <= 1e-15:
                candidates.append((action, edge))
        return rng.choice(candidates)

    @staticmethod
    def _absolute_payoffs(player_to_act: Player, value: float) -> dict[Player, float]:
        opponent = LifelineGame.opponent(player_to_act)
        return {player_to_act: value, opponent: -value}

    @staticmethod
    def _backup(
        nodes: Sequence[_Node],
        edges: Sequence[_Edge],
        payoffs: Mapping[Player, float],
    ) -> None:
        for node in nodes:
            node.visits += 1
        for edge in edges:
            edge.visits += 1
            for player in (Player.BLACK, Player.WHITE):
                edge.payoff_sums[player] += payoffs[player]

    def search(
        self,
        game: LifelineGame,
        rng: random.Random,
        *,
        temperature: float = 1.0,
        add_root_noise: bool = False,
    ) -> SearchResult:
        """Run PUCT without mutating ``game`` and return full root statistics."""

        normalized_temperature = _validate_temperature(temperature)
        if not isinstance(add_root_noise, bool):
            raise TypeError("add_root_noise must be a boolean")
        root_snapshot = game.clone()
        if root_snapshot.game_over:
            raise RuntimeError("cannot search a terminal state")

        root = _Node(player_to_act=root_snapshot.current_player)
        worker = self._new_worker(game)
        worker.restore(root_snapshot)
        self._evaluate_and_expand(worker, root)
        if add_root_noise and self.config.dirichlet_epsilon > 0.0:
            self._add_root_noise(root, rng)

        for _ in range(self.config.simulations):
            worker.restore(root_snapshot)
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
                        payoffs = worker.rewards()
                    else:
                        value = self._evaluate_and_expand(worker, child)
                        payoffs = self._absolute_payoffs(child.player_to_act, value)
                    break

                node = edge.child
                visited_nodes.append(node)
                if worker.game_over:
                    payoffs = worker.rewards()
                    break

            self._backup(visited_nodes, visited_edges, payoffs)

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
            root.edges[action].q_for(root.player_to_act) if action in root.edges else 0.0
            for action in range(action_count)
        )
        policy = _policy_from_visits(visits, priors, normalized_temperature)
        selected = _sample_policy(policy, rng)
        return SearchResult(
            action=selected,
            root_player=root.player_to_act,
            simulations=self.config.simulations,
            visits=visits,
            priors=priors,
            policy=policy,
            temperature=normalized_temperature,
            q_values=q_values,
        )


# Short alias for callers that prefer the algorithm name as the type name.
PUCT = PUCTSearch


__all__ = [
    "PUCT",
    "PUCTConfig",
    "PUCTSearch",
    "PolicyValue",
    "PolicyValueEvaluator",
    "SearchResult",
]
