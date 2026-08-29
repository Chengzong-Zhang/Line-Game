"""Deterministic multi-actor self-play driven by batched PUCT calls."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, replace
from typing import Any

from lifeline_rl.alphazero.replay import Experience, ReplayBuffer
from lifeline_rl.alphazero.self_play import (
    SelfPlayAction,
    SelfPlayConfig,
    SelfPlayResult,
    _apply_indexed_action,
    _float_vector,
    _legal_action_mask,
    _validate_distribution,
    _visit_vector,
)
from lifeline_rl.core import GameSnapshot, LifelineGame, Player

from .batched_puct import BatchedPUCTSearch


@dataclass(frozen=True)
class _SearchContext:
    ply: int
    actor: Player
    temperature: float
    fingerprint: str
    legal_mask: tuple[int, ...]
    turn_count_before: int
    root_snapshot: GameSnapshot


class _Actor:
    def __init__(self, config: SelfPlayConfig, seed: int, game_index: int):
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise TypeError("seed must be an integer")
        if isinstance(game_index, bool) or not isinstance(game_index, int):
            raise TypeError("game_index must be an integer")
        if game_index < 0:
            raise ValueError("game_index must be non-negative")
        self.config = config
        self.seed = seed
        self.game_index = game_index
        self.rng = random.Random(seed)
        self.game = LifelineGame(
            config.grid_size,
            start_player=config.start_player,
            superko_mode=config.superko_mode,
        )
        self.pending: list[Experience] = []
        self.actions: list[SelfPlayAction] = []

    @property
    def active(self) -> bool:
        return not self.game.game_over and len(self.actions) < self.config.max_plies

    def request(self) -> _SearchContext:
        if not self.active:
            raise RuntimeError("cannot search a finished actor")
        ply = len(self.actions)
        return _SearchContext(
            ply=ply,
            actor=self.game.current_player,
            temperature=self.config.temperature_at_ply(ply),
            fingerprint=self.game.state_fingerprint(),
            legal_mask=_legal_action_mask(self.game),
            turn_count_before=self.game.turn_count,
            root_snapshot=self.game.clone(),
        )

    def accept(self, context: _SearchContext, result: Any) -> None:
        game = self.game
        if game.clone() != context.root_snapshot:
            raise RuntimeError("batched PUCT mutated a self-play root")
        action = getattr(result, "action", None)
        if isinstance(action, bool) or not isinstance(action, int):
            raise TypeError("search result action must be an integer")
        action_count = game.num_points + 1
        if not 0 <= action < action_count or not context.legal_mask[action]:
            raise RuntimeError(f"batched PUCT selected illegal action {action}")
        try:
            root_player = Player(getattr(result, "root_player", context.actor))
        except (TypeError, ValueError) as exc:
            raise ValueError("search result has an invalid root_player") from exc
        if root_player is not context.actor:
            raise RuntimeError("search result root_player does not match the actor")

        visits = _visit_vector(
            getattr(result, "visits", None),
            action_count=action_count,
        )
        if any(
            visits[index]
            for index, legal in enumerate(context.legal_mask)
            if not legal
        ):
            raise ValueError("search visits include an illegal action")
        if sum(visits) < 1:
            raise ValueError("search visits must contain positive mass")
        policy = _float_vector(
            getattr(result, "policy", None),
            action_count=action_count,
            name="policy",
        )
        priors = _float_vector(
            getattr(result, "priors", None),
            action_count=action_count,
            name="priors",
        )
        _validate_distribution(policy, context.legal_mask, "policy")
        _validate_distribution(priors, context.legal_mask, "priors")
        simulations = getattr(result, "simulations", sum(visits))
        if (
            isinstance(simulations, bool)
            or not isinstance(simulations, int)
            or simulations != sum(visits)
        ):
            raise ValueError("search simulations must equal total root visits")
        result_temperature = float(
            getattr(result, "temperature", context.temperature)
        )
        if not math.isclose(
            result_temperature,
            context.temperature,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            raise ValueError("search temperature does not match the actor request")
        if policy[action] <= 0.0:
            raise ValueError("selected action has zero policy probability")

        point = None if action == game.num_points else game.valid_positions[action]
        provenance = {
            "source": "alphazero_autodl_multi_actor",
            "game_index": self.game_index,
            "game_seed": self.seed,
            "ply": context.ply,
            "selected_action": action,
            "superko_mode": self.config.superko_mode,
            "start_player": self.config.start_player,
        }
        self.pending.append(
            Experience(
                grid_size=game.grid_size,
                observation_mode=self.config.observation_mode,
                board=tuple(game.grid),
                physical_edges=game.physical_edges,
                logical_edges=(
                    tuple(sorted(game.edges[Player.BLACK])),
                    tuple(sorted(game.edges[Player.WHITE])),
                ),
                current_player=context.actor.value,
                consecutive_skips=game.consecutive_skips,
                legal_action_mask=context.legal_mask,
                root_visits=visits,
                z=0.0,
                state_fingerprint=context.fingerprint,
                provenance=provenance,
            )
        )
        self.actions.append(
            SelfPlayAction(
                ply=context.ply,
                turn_count_before=context.turn_count_before,
                actor=context.actor.value,
                action=action,
                point=point,
                temperature=context.temperature,
                state_fingerprint=context.fingerprint,
                legal_action_mask=context.legal_mask,
                root_visits=visits,
                root_policy=policy,
                root_priors=priors,
                simulations=simulations,
            )
        )
        _apply_indexed_action(game, action)

    def finish(self) -> SelfPlayResult:
        if self.active:
            raise RuntimeError("cannot finalize an active actor")
        truncated = not self.game.game_over
        if truncated:
            winner: str | None = None
            rewards: dict[str, float] | None = None
            experiences: tuple[Experience, ...] = ()
        else:
            game_rewards = self.game.rewards()
            raw_winner = self.game.winner()
            winner = raw_winner.value if isinstance(raw_winner, Player) else raw_winner
            rewards = {
                player.value: game_rewards[player]
                for player in (Player.BLACK, Player.WHITE)
            }
            experiences = tuple(
                replace(
                    sample,
                    z=game_rewards[Player(sample.current_player)],
                    provenance={
                        **sample.provenance,
                        "terminal_plies": len(self.actions),
                        "terminal_winner": winner,
                        "reward_source": "LifelineGame.rewards",
                    },
                )
                for sample in self.pending
            )
        return SelfPlayResult(
            game_index=self.game_index,
            seed=self.seed,
            grid_size=self.config.grid_size,
            superko_mode=self.config.superko_mode,
            start_player=self.config.start_player,
            terminated=not truncated,
            truncated=truncated,
            final_state_fingerprint=self.game.state_fingerprint(),
            winner=winner,
            rewards=rewards,
            plies=len(self.actions),
            actions=tuple(self.actions),
            experiences=experiences,
            added_to_replay=False,
        )


def play_multi_actor_self_play(
    searcher: BatchedPUCTSearch,
    configs: tuple[SelfPlayConfig, ...],
    seeds: tuple[int, ...],
    *,
    game_indices: tuple[int, ...] | None = None,
    replay_buffer: ReplayBuffer | None = None,
) -> tuple[SelfPlayResult, ...]:
    """Play a group of games, committing all completed trajectories once."""

    configs = tuple(configs)
    seeds = tuple(seeds)
    if not configs:
        raise ValueError("multi-actor self-play requires at least one actor")
    if len(configs) != len(seeds):
        raise ValueError("configs and seeds must have the same length")
    if game_indices is None:
        game_indices = tuple(range(len(configs)))
    else:
        game_indices = tuple(game_indices)
    if len(game_indices) != len(configs) or len(set(game_indices)) != len(game_indices):
        raise ValueError("game_indices must be unique and match the actor count")
    if replay_buffer is not None and not isinstance(replay_buffer, ReplayBuffer):
        raise TypeError("replay_buffer must be a ReplayBuffer")

    actors = tuple(
        _Actor(config, seed, game_index)
        for config, seed, game_index in zip(configs, seeds, game_indices)
    )
    while True:
        active = tuple(actor for actor in actors if actor.active)
        if not active:
            break
        contexts = tuple(actor.request() for actor in active)
        results = searcher.search_batch(
            tuple(actor.game for actor in active),
            tuple(actor.rng for actor in active),
            temperatures=tuple(context.temperature for context in contexts),
            add_root_noise=tuple(actor.config.add_root_noise for actor in active),
        )
        if len(results) != len(active):
            raise RuntimeError("batched search returned the wrong result count")
        for actor, context, result in zip(active, contexts, results):
            actor.accept(context, result)

    results = tuple(actor.finish() for actor in actors)
    if replay_buffer is None:
        return results
    committed = tuple(
        sample
        for result in results
        if result.terminated
        for sample in result.experiences
    )
    if committed:
        replay_buffer.add_game(committed)
    return tuple(
        replace(result, added_to_replay=result.terminated)
        for result in results
    )


__all__ = ["play_multi_actor_self_play"]
