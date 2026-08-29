"""Deterministic AlphaZero self-play over the exact LIFELINE rules."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, replace
from typing import Any, Protocol

from ..core import LifelineGame, Player, SUPERKO_MODES
from .replay import OBSERVATION_MODES, Experience, ReplayBuffer


class Searcher(Protocol):
    """The subset of :class:`PUCTSearch` consumed by self-play."""

    def search(
        self,
        game: LifelineGame,
        rng: random.Random,
        *,
        temperature: float = 1.0,
        add_root_noise: bool = False,
    ) -> Any:
        ...


@dataclass(frozen=True)
class SelfPlayConfig:
    grid_size: int = 9
    max_plies: int = 200
    temperature_moves: int = 20
    initial_temperature: float = 1.0
    final_temperature: float = 0.0
    observation_mode: str = "grid_graph"
    superko_mode: str = "enforce"
    start_player: str = Player.BLACK.value
    add_root_noise: bool = True

    def __post_init__(self) -> None:
        if isinstance(self.grid_size, bool) or not isinstance(self.grid_size, int):
            raise TypeError("grid_size must be an integer")
        if not LifelineGame.MIN_GRID_SIZE <= self.grid_size <= LifelineGame.MAX_GRID_SIZE:
            raise ValueError(
                f"grid_size must be between {LifelineGame.MIN_GRID_SIZE} and "
                f"{LifelineGame.MAX_GRID_SIZE}"
            )
        if isinstance(self.max_plies, bool) or not isinstance(self.max_plies, int):
            raise TypeError("max_plies must be an integer")
        if self.max_plies < 1:
            raise ValueError("max_plies must be at least 1")
        if isinstance(self.temperature_moves, bool) or not isinstance(
            self.temperature_moves, int
        ):
            raise TypeError("temperature_moves must be an integer")
        if self.temperature_moves < 0:
            raise ValueError("temperature_moves must be non-negative")
        for name, value in (
            ("initial_temperature", self.initial_temperature),
            ("final_temperature", self.final_temperature),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a number")
            if not math.isfinite(float(value)) or value < 0:
                raise ValueError(f"{name} must be finite and non-negative")
        if self.observation_mode not in OBSERVATION_MODES:
            raise ValueError(
                "observation_mode must be grid, grid_graph, topology, or topology_history"
            )
        if self.superko_mode not in SUPERKO_MODES:
            raise ValueError(f"superko_mode must be one of {SUPERKO_MODES}")
        try:
            start_player = Player(self.start_player)
        except (TypeError, ValueError) as exc:
            raise ValueError("start_player must be BLACK or WHITE") from exc
        if not isinstance(self.add_root_noise, bool):
            raise TypeError("add_root_noise must be a boolean")
        object.__setattr__(self, "initial_temperature", float(self.initial_temperature))
        object.__setattr__(self, "final_temperature", float(self.final_temperature))
        object.__setattr__(self, "start_player", start_player.value)

    def temperature_at_ply(self, ply: int) -> float:
        """Return the schedule value for an action-log ply, not ``turn_count``."""

        if isinstance(ply, bool) or not isinstance(ply, int):
            raise TypeError("ply must be an integer")
        if ply < 0:
            raise ValueError("ply must be non-negative")
        return (
            self.initial_temperature
            if ply < self.temperature_moves
            else self.final_temperature
        )


@dataclass(frozen=True)
class SelfPlayAction:
    ply: int
    turn_count_before: int
    actor: str
    action: int
    point: tuple[int, int] | None
    temperature: float
    state_fingerprint: str
    legal_action_mask: tuple[int, ...]
    root_visits: tuple[int, ...]
    root_policy: tuple[float, ...]
    root_priors: tuple[float, ...]
    simulations: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "ply": self.ply,
            "turn_count_before": self.turn_count_before,
            "actor": self.actor,
            "action": self.action,
            "point": None if self.point is None else list(self.point),
            "temperature": self.temperature,
            "state_fingerprint": self.state_fingerprint,
            "legal_action_mask": list(self.legal_action_mask),
            "root_visits": list(self.root_visits),
            "root_policy": list(self.root_policy),
            "root_priors": list(self.root_priors),
            "simulations": self.simulations,
        }


@dataclass(frozen=True)
class SelfPlayResult:
    game_index: int
    seed: int
    grid_size: int
    superko_mode: str
    start_player: str
    terminated: bool
    truncated: bool
    final_state_fingerprint: str
    winner: str | None
    rewards: dict[str, float] | None
    plies: int
    actions: tuple[SelfPlayAction, ...]
    experiences: tuple[Experience, ...]
    added_to_replay: bool

    @property
    def action_log(self) -> tuple[SelfPlayAction, ...]:
        return self.actions

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "game_index": self.game_index,
            "seed": self.seed,
            "grid_size": self.grid_size,
            "superko_mode": self.superko_mode,
            "start_player": self.start_player,
            "terminated": self.terminated,
            "truncated": self.truncated,
            "final_state_fingerprint": self.final_state_fingerprint,
            "winner": self.winner,
            "rewards": self.rewards,
            "plies": self.plies,
            "added_to_replay": self.added_to_replay,
            "sample_count": len(self.experiences),
            "actions": [entry.to_dict() for entry in self.actions],
        }


def _legal_action_mask(game: LifelineGame) -> tuple[int, ...]:
    legal_points = set(game.legal_moves())
    return tuple(int(point in legal_points) for point in game.valid_positions) + (1,)


def _float_vector(
    values: Any,
    *,
    action_count: int,
    name: str,
) -> tuple[float, ...]:
    try:
        vector = tuple(float(value) for value in values)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"search result {name} must be a numeric iterable") from exc
    if len(vector) != action_count:
        raise ValueError(f"search result {name} must contain {action_count} actions")
    if any(not math.isfinite(value) or value < 0 for value in vector):
        raise ValueError(f"search result {name} must be finite and non-negative")
    return vector


def _visit_vector(values: Any, *, action_count: int) -> tuple[int, ...]:
    try:
        vector = tuple(values)
    except TypeError as exc:
        raise TypeError("search result visits must be an integer iterable") from exc
    if len(vector) != action_count:
        raise ValueError(f"search result visits must contain {action_count} actions")
    for action, visits in enumerate(vector):
        if isinstance(visits, bool) or not isinstance(visits, int) or visits < 0:
            raise ValueError(f"search result visits[{action}] must be a non-negative integer")
    return vector


def _validate_distribution(
    values: tuple[float, ...],
    legal_action_mask: tuple[int, ...],
    name: str,
) -> None:
    if not math.isclose(sum(values), 1.0, rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError(f"search result {name} must sum to one")
    if any(values[action] > 1e-12 for action, legal in enumerate(legal_action_mask) if not legal):
        raise ValueError(f"search result {name} assigns mass to an illegal action")


def _apply_indexed_action(game: LifelineGame, action: int) -> tuple[int, int] | None:
    if action == game.num_points:
        point = None
        move_result = game.skip_turn()
    elif 0 <= action < game.num_points:
        point = game.valid_positions[action]
        move_result = game.play_move(point)
    else:
        raise ValueError(f"search selected action {action} outside the action space")
    if not move_result.success:
        raise RuntimeError(f"PUCT selected illegal action {action}: {move_result.reason}")
    return point


def play_self_play_game(
    searcher: Searcher,
    config: SelfPlayConfig,
    seed: int,
    *,
    game_index: int = 0,
    replay_buffer: ReplayBuffer | None = None,
) -> SelfPlayResult:
    """Play one seeded game and atomically commit only a terminal trajectory."""

    if isinstance(seed, bool) or not isinstance(seed, int):
        raise TypeError("seed must be an integer")
    if isinstance(game_index, bool) or not isinstance(game_index, int):
        raise TypeError("game_index must be an integer")
    if game_index < 0:
        raise ValueError("game_index must be non-negative")
    if replay_buffer is not None and not isinstance(replay_buffer, ReplayBuffer):
        raise TypeError("replay_buffer must be a ReplayBuffer")

    rng = random.Random(seed)
    game = LifelineGame(
        config.grid_size,
        start_player=config.start_player,
        superko_mode=config.superko_mode,
    )
    pending: list[Experience] = []
    action_log: list[SelfPlayAction] = []

    while not game.game_over and len(action_log) < config.max_plies:
        ply = len(action_log)
        actor = game.current_player
        temperature = config.temperature_at_ply(ply)
        fingerprint = game.state_fingerprint()
        legal_mask = _legal_action_mask(game)
        turn_count_before = game.turn_count
        root_snapshot = game.clone()

        search_result = searcher.search(
            game,
            rng,
            temperature=temperature,
            add_root_noise=config.add_root_noise,
        )
        if game.clone() != root_snapshot:
            raise RuntimeError("PUCT search mutated the self-play root game")

        action = getattr(search_result, "action", None)
        if isinstance(action, bool) or not isinstance(action, int):
            raise TypeError("search result action must be an integer")
        action_count = game.num_points + 1
        if not 0 <= action < action_count:
            raise ValueError("search result action is outside the action space")
        if not legal_mask[action]:
            raise RuntimeError(f"PUCT selected masked action {action}")
        root_player = getattr(search_result, "root_player", actor)
        try:
            result_player = Player(root_player)
        except (TypeError, ValueError) as exc:
            raise ValueError("search result has an invalid root_player") from exc
        if result_player is not actor:
            raise RuntimeError("search result root_player does not match the game root")

        visits = _visit_vector(
            getattr(search_result, "visits", None),
            action_count=action_count,
        )
        if any(visits[index] for index, legal in enumerate(legal_mask) if not legal):
            raise ValueError("search result visits include an illegal action")
        if sum(visits) < 1:
            raise ValueError("search result visits must include at least one simulation")
        policy = _float_vector(
            getattr(search_result, "policy", None),
            action_count=action_count,
            name="policy",
        )
        priors = _float_vector(
            getattr(search_result, "priors", None),
            action_count=action_count,
            name="priors",
        )
        _validate_distribution(policy, legal_mask, "policy")
        _validate_distribution(priors, legal_mask, "priors")
        simulations = getattr(search_result, "simulations", sum(visits))
        if isinstance(simulations, bool) or not isinstance(simulations, int) or simulations < 1:
            raise ValueError("search result simulations must be a positive integer")
        if simulations != sum(visits):
            raise ValueError("search result simulations must equal total root visits")
        result_temperature = getattr(search_result, "temperature", temperature)
        if not math.isclose(
            float(result_temperature), temperature, rel_tol=0.0, abs_tol=1e-12
        ):
            raise ValueError("search result temperature does not match the requested value")
        if policy[action] <= 0.0:
            raise ValueError("search selected an action with zero policy probability")

        point = None if action == game.num_points else game.valid_positions[action]
        provenance = {
            "source": "alphazero_self_play",
            "game_index": game_index,
            "game_seed": seed,
            "ply": ply,
            "selected_action": action,
            "superko_mode": config.superko_mode,
            "start_player": config.start_player,
        }
        pending.append(
            Experience(
                grid_size=game.grid_size,
                observation_mode=config.observation_mode,
                board=tuple(game.grid),
                physical_edges=game.physical_edges,
                logical_edges=(
                    tuple(sorted(game.edges[Player.BLACK])),
                    tuple(sorted(game.edges[Player.WHITE])),
                ),
                current_player=actor.value,
                consecutive_skips=game.consecutive_skips,
                legal_action_mask=legal_mask,
                root_visits=visits,
                z=0.0,
                state_fingerprint=fingerprint,
                provenance=provenance,
            )
        )
        action_log.append(
            SelfPlayAction(
                ply=ply,
                turn_count_before=turn_count_before,
                actor=actor.value,
                action=action,
                point=point,
                temperature=temperature,
                state_fingerprint=fingerprint,
                legal_action_mask=legal_mask,
                root_visits=visits,
                root_policy=policy,
                root_priors=priors,
                simulations=simulations,
            )
        )
        _apply_indexed_action(game, action)

    truncated = not game.game_over
    if truncated:
        experiences: tuple[Experience, ...] = ()
        winner: str | None = None
        rewards: dict[str, float] | None = None
        added_to_replay = False
    else:
        game_rewards = game.rewards()
        winner_value = game.winner()
        winner = winner_value.value if isinstance(winner_value, Player) else winner_value
        rewards = {player.value: game_rewards[player] for player in (Player.BLACK, Player.WHITE)}
        experiences = tuple(
            replace(
                sample,
                z=game_rewards[Player(sample.current_player)],
                provenance={
                    **sample.provenance,
                    "terminal_plies": len(action_log),
                    "terminal_winner": winner,
                    "reward_source": "LifelineGame.rewards",
                },
            )
            for sample in pending
        )
        if replay_buffer is not None:
            replay_buffer.add_game(experiences)
            added_to_replay = True
        else:
            added_to_replay = False

    return SelfPlayResult(
        game_index=game_index,
        seed=seed,
        grid_size=config.grid_size,
        superko_mode=config.superko_mode,
        start_player=config.start_player,
        terminated=not truncated,
        truncated=truncated,
        final_state_fingerprint=game.state_fingerprint(),
        winner=winner,
        rewards=rewards,
        plies=len(action_log),
        actions=tuple(action_log),
        experiences=experiences,
        added_to_replay=added_to_replay,
    )
