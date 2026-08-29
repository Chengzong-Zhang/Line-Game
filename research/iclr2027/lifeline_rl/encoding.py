"""Stable, dependency-free observations for baseline agents."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .core import PLAYERS, LifelineGame, Player, PointState


def _history_digest(game: LifelineGame) -> tuple[str, ...]:
    """Return stable digests without exposing Python's randomized hash()."""

    return tuple(
        sorted(
            hashlib.sha256(repr(state).encode("utf-8")).hexdigest()
            for state in game.history_hashes
        )
    )


def encode_observation(game: LifelineGame, mode: str = "topology_history") -> dict[str, Any]:
    """Encode a state using immutable Python values.

    The four canonical modes match the D1 research contract. ``physical``,
    ``topological``, and ``full`` remain accepted as convenience aliases.
    """

    aliases = {
        "physical": "grid",
        "topological": "topology",
        "full": "topology_history",
    }
    mode = aliases.get(mode, mode)
    if mode not in {"grid", "grid_graph", "topology", "topology_history"}:
        raise ValueError("unknown observation mode")
    legal_moves = set() if game.game_over else set(game.legal_moves())
    observation: dict[str, Any] = {
        "board": tuple(game.grid),
        "coordinates": tuple(
            (x / (game.grid_size - 1), y / (game.grid_size - 1))
            for x, y in game.valid_positions
        ),
        "current_player": 0 if game.current_player is Player.BLACK else 1,
        "consecutive_skips": game.consecutive_skips,
        "legal_action_mask": tuple(
            int(point in legal_moves) for point in game.valid_positions
        ) + (int(not game.game_over),),
    }
    if mode in {"grid_graph", "topology", "topology_history"}:
        observation["physical_edges"] = game.physical_edges
    if mode in {"topology", "topology_history"}:
        observation["logical_edges"] = tuple(
            tuple(sorted(game.edges[player])) for player in PLAYERS
        )
    if mode == "topology_history":
        observation["history"] = _history_digest(game)
    return observation


def observation_json(game: LifelineGame, mode: str = "topology_history") -> str:
    """Canonical JSON form useful for logs and regression fixtures."""

    return json.dumps(encode_observation(game, mode), separators=(",", ":"))


def one_hot_board(game: LifelineGame) -> tuple[tuple[int, ...], ...]:
    """Five channels in PointState numeric order, with no NumPy dependency."""

    return tuple(
        tuple(int(state == int(channel)) for state in game.grid)
        for channel in PointState
    )
