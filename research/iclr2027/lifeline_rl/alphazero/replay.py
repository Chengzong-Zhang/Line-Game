"""Dependency-free AlphaZero experience records and FIFO replay storage.

The replay representation deliberately uses immutable Python containers rather
than NumPy or Torch tensors.  This keeps checkpoint loading and inspection
available in the dependency-free reference environment while allowing the
trainer to tensorize variable-sized samples at batch time.
"""

from __future__ import annotations

import copy
import json
import math
import random
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..core import Player, PointState


REPLAY_SCHEMA_VERSION = 1
POINT_STATE_VALUES = frozenset(int(point_state) for point_state in PointState)
OBSERVATION_MODES = frozenset({"grid", "grid_graph", "topology", "topology_history"})


def _require_int(value: object, name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _normalise_edges(
    edges: Iterable[Sequence[int]],
    *,
    num_points: int,
    name: str,
) -> tuple[tuple[int, int], ...]:
    normalised: list[tuple[int, int]] = []
    for position, edge in enumerate(edges):
        if isinstance(edge, (str, bytes)) or not isinstance(edge, Sequence) or len(edge) != 2:
            raise TypeError(f"{name}[{position}] must be a two-integer edge")
        first = _require_int(edge[0], f"{name}[{position}][0]")
        second = _require_int(edge[1], f"{name}[{position}][1]")
        if first >= num_points or second >= num_points:
            raise ValueError(f"{name}[{position}] references a point outside the board")
        if first == second:
            raise ValueError(f"{name}[{position}] must not be a self-edge")
        normalised.append((first, second) if first < second else (second, first))
    if len(set(normalised)) != len(normalised):
        raise ValueError(f"{name} contains duplicate edges")
    return tuple(sorted(normalised))


def _normalise_player(value: Player | str | int) -> str:
    if isinstance(value, bool):
        raise TypeError("current_player must be BLACK or WHITE")
    if isinstance(value, int) and value == 0:
        return Player.BLACK.value
    if isinstance(value, int) and value == 1:
        return Player.WHITE.value
    try:
        return Player(value).value
    except (TypeError, ValueError) as exc:
        raise ValueError("current_player must be BLACK or WHITE") from exc


def _copy_json_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(dict(value))
    if any(not isinstance(key, str) for key in copied):
        raise TypeError("provenance keys must be strings")
    try:
        encoded = json.dumps(copied, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TypeError("provenance must contain only finite JSON-compatible values") from exc
    # JSON round-tripping recursively canonicalizes tuples and mapping keys, so
    # checkpoint serialization cannot silently change provenance equality.
    return json.loads(encoded)


def _tuple_tree(value: Any) -> Any:
    """Restore tuple structure after an optional JSON state-dict round trip."""

    if isinstance(value, (list, tuple)):
        return tuple(_tuple_tree(item) for item in value)
    return value


@dataclass(frozen=True)
class Experience:
    """One policy/value target captured at a self-play root.

    ``current_player`` is persisted as ``"BLACK"`` or ``"WHITE"`` and ``z``
    is the terminal payoff for that exact player.  Therefore value targets do
    not rely on alternating-ply assumptions, which are invalid when the game
    automatically skips a player with no legal point move.
    """

    grid_size: int
    observation_mode: str
    board: tuple[int, ...]
    physical_edges: tuple[tuple[int, int], ...]
    logical_edges: tuple[tuple[tuple[int, int], ...], tuple[tuple[int, int], ...]]
    current_player: str
    consecutive_skips: int
    legal_action_mask: tuple[int, ...]
    root_visits: tuple[int, ...]
    z: float
    state_fingerprint: str
    provenance: dict[str, Any]

    def __post_init__(self) -> None:
        grid_size = _require_int(self.grid_size, "grid_size", minimum=1)
        if self.observation_mode not in OBSERVATION_MODES:
            raise ValueError(
                "observation_mode must be grid, grid_graph, topology, or topology_history"
            )
        num_points = grid_size * (grid_size + 1) // 2

        try:
            board = tuple(self.board)
        except TypeError as exc:
            raise TypeError("board must be an iterable of integers") from exc
        if len(board) != num_points:
            raise ValueError(f"board must contain {num_points} point states")
        for index, state in enumerate(board):
            _require_int(state, f"board[{index}]")
            if state not in POINT_STATE_VALUES:
                raise ValueError(f"board[{index}] is not a valid point state")

        physical_edges = _normalise_edges(
            self.physical_edges,
            num_points=num_points,
            name="physical_edges",
        )
        if len(self.logical_edges) != 2:
            raise ValueError("logical_edges must contain BLACK and WHITE edge groups")
        logical_edges = (
            _normalise_edges(
                self.logical_edges[0],
                num_points=num_points,
                name="logical_edges[BLACK]",
            ),
            _normalise_edges(
                self.logical_edges[1],
                num_points=num_points,
                name="logical_edges[WHITE]",
            ),
        )

        current_player = _normalise_player(self.current_player)
        consecutive_skips = _require_int(
            self.consecutive_skips,
            "consecutive_skips",
        )
        if consecutive_skips > 1:
            raise ValueError("a non-terminal sample cannot have more than one consecutive skip")

        try:
            legal_mask = tuple(self.legal_action_mask)
            root_visits = tuple(self.root_visits)
        except TypeError as exc:
            raise TypeError("legal_action_mask and root_visits must be iterable") from exc
        action_count = num_points + 1
        if len(legal_mask) != action_count:
            raise ValueError(f"legal_action_mask must contain {action_count} actions")
        if len(root_visits) != action_count:
            raise ValueError(f"root_visits must contain {action_count} actions")
        for action, legal in enumerate(legal_mask):
            if isinstance(legal, bool):
                legal = int(legal)
            if not isinstance(legal, int) or legal not in (0, 1):
                raise ValueError(f"legal_action_mask[{action}] must be 0 or 1")
        legal_mask = tuple(int(value) for value in legal_mask)
        if not any(legal_mask):
            raise ValueError("a replay sample must have at least one legal action")
        for action, visits in enumerate(root_visits):
            _require_int(visits, f"root_visits[{action}]")
            if not legal_mask[action] and visits:
                raise ValueError("illegal actions must have zero root visits")
        if sum(root_visits) < 1:
            raise ValueError("root_visits must contain at least one simulation")

        if isinstance(self.z, bool) or not isinstance(self.z, (int, float)):
            raise TypeError("z must be a terminal payoff")
        z = float(self.z)
        if not math.isfinite(z) or z not in (-1.0, 0.0, 1.0):
            raise ValueError("z must be one of -1, 0, or +1")

        if not isinstance(self.state_fingerprint, str):
            raise TypeError("state_fingerprint must be a SHA-256 hex string")
        fingerprint = self.state_fingerprint.lower()
        if len(fingerprint) != 64 or any(character not in "0123456789abcdef" for character in fingerprint):
            raise ValueError("state_fingerprint must be a 64-character SHA-256 hex string")
        if not isinstance(self.provenance, Mapping):
            raise TypeError("provenance must be a mapping")

        object.__setattr__(self, "board", tuple(int(value) for value in board))
        object.__setattr__(self, "physical_edges", physical_edges)
        object.__setattr__(self, "logical_edges", logical_edges)
        object.__setattr__(self, "current_player", current_player)
        object.__setattr__(self, "consecutive_skips", consecutive_skips)
        object.__setattr__(self, "legal_action_mask", legal_mask)
        object.__setattr__(self, "root_visits", tuple(int(value) for value in root_visits))
        object.__setattr__(self, "z", z)
        object.__setattr__(self, "state_fingerprint", fingerprint)
        object.__setattr__(self, "provenance", _copy_json_mapping(self.provenance))

    @property
    def num_points(self) -> int:
        return len(self.board)

    @property
    def action_count(self) -> int:
        return len(self.legal_action_mask)

    @property
    def policy_target(self) -> tuple[float, ...]:
        """Return root visits normalized as a policy target."""

        total = sum(self.root_visits)
        return tuple(visits / total for visits in self.root_visits)

    def to_dict(self) -> dict[str, Any]:
        return {
            "grid_size": self.grid_size,
            "observation_mode": self.observation_mode,
            "board": list(self.board),
            "physical_edges": [list(edge) for edge in self.physical_edges],
            "logical_edges": [
                [list(edge) for edge in player_edges]
                for player_edges in self.logical_edges
            ],
            "current_player": self.current_player,
            "consecutive_skips": self.consecutive_skips,
            "legal_action_mask": list(self.legal_action_mask),
            "root_visits": list(self.root_visits),
            "z": self.z,
            "state_fingerprint": self.state_fingerprint,
            "provenance": copy.deepcopy(self.provenance),
        }

    @classmethod
    def from_dict(cls, state: Mapping[str, Any]) -> Experience:
        if not isinstance(state, Mapping):
            raise TypeError("experience state must be a mapping")
        try:
            return cls(
                grid_size=state["grid_size"],
                observation_mode=state["observation_mode"],
                board=tuple(state["board"]),
                physical_edges=tuple(tuple(edge) for edge in state["physical_edges"]),
                logical_edges=tuple(
                    tuple(tuple(edge) for edge in player_edges)
                    for player_edges in state["logical_edges"]
                ),
                current_player=state["current_player"],
                consecutive_skips=state["consecutive_skips"],
                legal_action_mask=tuple(state["legal_action_mask"]),
                root_visits=tuple(state["root_visits"]),
                z=state["z"],
                state_fingerprint=state["state_fingerprint"],
                provenance=state["provenance"],
            )
        except KeyError as exc:
            raise ValueError(f"experience state is missing {exc.args[0]!r}") from exc


class ReplayBuffer:
    """Fixed-capacity FIFO replay with deterministic local sampling state."""

    def __init__(self, capacity: int, seed: int = 0):
        self.capacity = _require_int(capacity, "capacity", minimum=1)
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise TypeError("seed must be an integer")
        self._samples: list[Experience] = []
        self._rng = random.Random(seed)
        self.total_added = 0

    def __len__(self) -> int:
        return len(self._samples)

    def __iter__(self):
        return iter(self.samples)

    @property
    def samples(self) -> tuple[Experience, ...]:
        return tuple(Experience.from_dict(sample.to_dict()) for sample in self._samples)

    def add_game(self, samples: Iterable[Experience]) -> None:
        """Atomically append one completed game's samples in ply order.

        The entire iterable is materialized and validated before any buffer
        state changes.  A game longer than the capacity is still one atomic
        insertion: only its newest ``capacity`` samples remain, while
        ``total_added`` counts every valid sample presented.
        """

        try:
            pending = tuple(samples)
        except TypeError as exc:
            raise TypeError("samples must be an iterable of Experience objects") from exc
        if any(not isinstance(sample, Experience) for sample in pending):
            raise TypeError("all replay entries must be Experience objects")
        if not pending:
            return
        # Break aliases to caller-owned nested provenance dictionaries before
        # committing the complete game.
        pending = tuple(Experience.from_dict(sample.to_dict()) for sample in pending)

        combined = [*self._samples, *pending]
        retained = combined[-self.capacity :]
        self._samples = retained
        self.total_added += len(pending)

    def sample(self, batch_size: int) -> tuple[Experience, ...]:
        batch_size = _require_int(batch_size, "batch_size", minimum=1)
        if batch_size > len(self._samples):
            raise ValueError("batch_size cannot exceed the replay size")
        selected = self._rng.sample(self._samples, batch_size)
        return tuple(Experience.from_dict(sample.to_dict()) for sample in selected)

    def state_dict(self) -> dict[str, Any]:
        return {
            "schema_version": REPLAY_SCHEMA_VERSION,
            "capacity": self.capacity,
            "samples": [sample.to_dict() for sample in self._samples],
            "total_added": self.total_added,
            "rng_state": copy.deepcopy(self._rng.getstate()),
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        """Validate completely, then replace order, counters, and RNG atomically."""

        if not isinstance(state, Mapping):
            raise TypeError("replay state must be a mapping")
        schema_version = state.get("schema_version")
        if schema_version != REPLAY_SCHEMA_VERSION:
            raise ValueError(f"unsupported replay schema version: {schema_version!r}")
        stored_capacity = _require_int(state.get("capacity"), "capacity", minimum=1)
        if stored_capacity != self.capacity:
            raise ValueError(
                f"replay capacity mismatch: checkpoint={stored_capacity}, configured={self.capacity}"
            )
        raw_samples = state.get("samples")
        if isinstance(raw_samples, (str, bytes)) or not isinstance(raw_samples, Sequence):
            raise TypeError("replay samples must be a sequence")
        pending = [
            sample if isinstance(sample, Experience) else Experience.from_dict(sample)
            for sample in raw_samples
        ]
        if len(pending) > stored_capacity:
            raise ValueError("checkpoint contains more samples than replay capacity")
        total_added = _require_int(state.get("total_added"), "total_added")
        if total_added < len(pending):
            raise ValueError("total_added cannot be smaller than the retained replay size")
        if "rng_state" not in state:
            raise ValueError("replay state is missing 'rng_state'")
        candidate_rng = random.Random()
        try:
            candidate_rng.setstate(_tuple_tree(copy.deepcopy(state["rng_state"])))
        except (TypeError, ValueError) as exc:
            raise ValueError("replay state contains an invalid RNG state") from exc

        self._samples = pending
        self.total_added = total_added
        self._rng = candidate_rng

    @classmethod
    def from_state_dict(cls, state: Mapping[str, Any]) -> ReplayBuffer:
        if not isinstance(state, Mapping):
            raise TypeError("replay state must be a mapping")
        capacity = _require_int(state.get("capacity"), "capacity", minimum=1)
        buffer = cls(capacity)
        buffer.load_state_dict(state)
        return buffer
