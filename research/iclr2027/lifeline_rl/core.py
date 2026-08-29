"""Pure-Python two-player LIFELINE rules engine.

The implementation is intentionally dependency free.  Its rule ordering mirrors
``web/web前端/GameEngine.js``, which remains the product-facing reference engine.
The training implementation stores logical edges separately from physical line
points because two reachable states can share the same board while differing in
their future topology.
"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import dataclass
from enum import Enum, IntEnum
from typing import Any, Iterable, Sequence

Point = tuple[int, int]
Edge = tuple[int, int]
StateKey = tuple[Any, ...]


class Player(str, Enum):
    BLACK = "BLACK"
    WHITE = "WHITE"


class PointState(IntEnum):
    EMPTY = 0
    BLACK_NODE = 1
    BLACK_LINE = 2
    WHITE_NODE = 3
    WHITE_LINE = 4


PLAYERS = (Player.BLACK, Player.WHITE)
SUPERKO_MODES = ("enforce", "observe")
DIRECTIONS: tuple[Point, ...] = (
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, -1),
    (-1, 1),
)
DIRS_CLOCKWISE: tuple[Point, ...] = (
    (1, 0),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (0, -1),
    (1, -1),
)
PLAYER_STATES = {
    Player.BLACK: (PointState.BLACK_NODE, PointState.BLACK_LINE),
    Player.WHITE: (PointState.WHITE_NODE, PointState.WHITE_LINE),
}


@dataclass(frozen=True)
class Territory:
    polygon: tuple[Point, ...] | None
    area: int
    display_area: int


@dataclass(frozen=True)
class MoveResult:
    success: bool
    reason: str | None = None
    would_violate_superko: bool = False


@dataclass(frozen=True)
class GameSnapshot:
    """Lossless immutable state used by tree search and tests."""

    grid: tuple[int, ...]
    black_edges: tuple[Edge, ...]
    white_edges: tuple[Edge, ...]
    current_player: Player
    game_over: bool
    consecutive_skips: int
    turn_count: int
    history_hashes: frozenset[StateKey]
    superko_mode: str
    start_player: Player


class LifelineGame:
    """Exact two-player game state and transition rules."""

    MIN_GRID_SIZE = 5
    MAX_GRID_SIZE = 15

    def __init__(
        self,
        grid_size: int = 9,
        start_player: Player | str = Player.BLACK,
        superko_mode: str = "enforce",
    ):
        if not isinstance(grid_size, int) or isinstance(grid_size, bool):
            raise TypeError("grid_size must be an integer")
        if not self.MIN_GRID_SIZE <= grid_size <= self.MAX_GRID_SIZE:
            raise ValueError("grid_size must be between 5 and 15")
        try:
            start = Player(start_player)
        except ValueError as exc:
            raise ValueError("start_player must be BLACK or WHITE") from exc
        if superko_mode not in SUPERKO_MODES:
            raise ValueError(f"superko_mode must be one of {SUPERKO_MODES}")

        self.grid_size = grid_size
        self.start_player = start
        self.superko_mode = superko_mode
        self.valid_positions: tuple[Point, ...] = tuple(
            (x, y)
            for y in range(grid_size)
            for x in range(grid_size - y)
        )
        self.point_to_index = {point: index for index, point in enumerate(self.valid_positions)}
        self.adjacency: tuple[tuple[int, ...], ...] = tuple(
            tuple(
                self.point_to_index[next_point]
                for dx, dy in DIRECTIONS
                if (next_point := (point[0] + dx, point[1] + dy)) in self.point_to_index
            )
            for point in self.valid_positions
        )
        self.physical_edges: tuple[Edge, ...] = tuple(
            sorted(
                {
                    (index, neighbor) if index < neighbor else (neighbor, index)
                    for index, neighbors in enumerate(self.adjacency)
                    for neighbor in neighbors
                }
            )
        )
        self.boundary_indices: tuple[int, ...] = tuple(
            index
            for index, (x, y) in enumerate(self.valid_positions)
            if x == 0 or y == 0 or x + y == grid_size - 1
        )
        self.initial_positions = {
            Player.BLACK: (0, 0),
            Player.WHITE: (grid_size - 1, 0),
        }

        self.grid: list[int] = [int(PointState.EMPTY)] * len(self.valid_positions)
        self.edges: dict[Player, set[Edge]] = {player: set() for player in PLAYERS}
        self._legal_moves_cache: dict[Player, tuple[Point, ...]] = {}
        self.current_player = self.start_player
        self.game_over = False
        self.consecutive_skips = 0
        self.turn_count = 0
        self.cached_territories: dict[Player, Territory] = {
            player: Territory(None, 0, 0) for player in PLAYERS
        }

        for player in PLAYERS:
            node_state, _ = PLAYER_STATES[player]
            self._set_state(self.initial_positions[player], node_state)

        self.history_hashes: set[StateKey] = {self._compute_state_key(self.start_player)}

    @property
    def num_points(self) -> int:
        return len(self.valid_positions)

    def is_valid_position(self, point: Sequence[int]) -> bool:
        return tuple(point) in self.point_to_index

    def _index(self, point: Sequence[int]) -> int:
        try:
            normalized = (int(point[0]), int(point[1]))
        except (IndexError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid grid position: {point!r}") from exc
        if normalized not in self.point_to_index:
            raise ValueError(f"invalid grid position: {point!r}")
        return self.point_to_index[normalized]

    def _get_state(self, point: Point) -> PointState:
        return PointState(self.grid[self.point_to_index[point]])

    def get_state(self, point: Sequence[int]) -> PointState:
        return PointState(self.grid[self._index(point)])

    def _set_state(self, point: Point, state: PointState | int) -> None:
        self.grid[self.point_to_index[point]] = int(state)

    @staticmethod
    def opponent(player: Player) -> Player:
        return Player.WHITE if player is Player.BLACK else Player.BLACK

    def get_board_matrix(self) -> list[list[int | None]]:
        matrix: list[list[int | None]] = []
        for y in range(self.grid_size):
            row: list[int | None] = []
            for x in range(self.grid_size):
                index = self.point_to_index.get((x, y))
                row.append(self.grid[index] if index is not None else None)
            matrix.append(row)
        return matrix

    def _player_nodes(self, player: Player) -> list[Point]:
        node_state, _ = PLAYER_STATES[player]
        return [
            point
            for point, state in zip(self.valid_positions, self.grid)
            if state == int(node_state)
        ]

    def _player_lines(self, player: Player) -> list[Point]:
        _, line_state = PLAYER_STATES[player]
        return [
            point
            for point, state in zip(self.valid_positions, self.grid)
            if state == int(line_state)
        ]

    def adjacent_positions(self, point: Point) -> list[Point]:
        return [self.valid_positions[index] for index in self.adjacency[self.point_to_index[point]]]

    @staticmethod
    def can_connect(point_a: Point, point_b: Point) -> bool:
        return (
            point_a[0] == point_b[0]
            or point_a[1] == point_b[1]
            or point_a[0] + point_a[1] == point_b[0] + point_b[1]
        )

    def line_points(self, start: Point, end: Point) -> list[Point]:
        if not self.can_connect(start, end):
            return []
        x1, y1 = start
        x2, y2 = end
        if x1 == x2:
            return [(x1, y) for y in range(min(y1, y2), max(y1, y2) + 1)]
        if y1 == y2:
            return [(x, y1) for x in range(min(x1, x2), max(x1, x2) + 1)]
        left, right = (start, end) if x1 < x2 else (end, start)
        return [(left[0] + i, left[1] - i) for i in range(right[0] - left[0] + 1)]

    def can_connect_with_blocking(self, point_a: Point, point_b: Point, player: Player) -> bool:
        if not self.can_connect(point_a, point_b):
            return False
        enemy_node, enemy_line = PLAYER_STATES[self.opponent(player)]
        for point in self.line_points(point_a, point_b):
            if point == point_a or point == point_b:
                continue
            if self._get_state(point) in (enemy_node, enemy_line):
                return False
        return True

    def _check_three_point_limitation(self, new_point: Point, player: Player) -> bool:
        node_set = set(self._player_nodes(player))
        adjacent_nodes = [point for point in self.adjacent_positions(new_point) if point in node_set]
        if len(adjacent_nodes) >= 2:
            return False
        for adjacent_node in adjacent_nodes:
            if any(point in node_set for point in self.adjacent_positions(adjacent_node)):
                return False
        return True

    def _is_in_protection_zone(self, point: Point, player: Player) -> bool:
        return point in self.adjacent_positions(self.initial_positions[self.opponent(player)])

    def _edge(self, point_a: Point, point_b: Point) -> Edge:
        a = self.point_to_index[point_a]
        b = self.point_to_index[point_b]
        return (a, b) if a < b else (b, a)

    def edge_points(self, edge: Edge) -> tuple[Point, Point]:
        return self.valid_positions[edge[0]], self.valid_positions[edge[1]]

    def _cleanup_broken_edges(self, player: Player) -> None:
        node_state, line_state = PLAYER_STATES[player]
        for edge in tuple(self.edges[player]):
            point_a, point_b = self.edge_points(edge)
            if not all(
                self._get_state(point) in (node_state, line_state)
                for point in self.line_points(point_a, point_b)
            ):
                self.edges[player].remove(edge)

    def _opponent_connected_pieces(self, opponent: Player) -> set[int]:
        node_state, _ = PLAYER_STATES[opponent]
        initial_index = self.point_to_index[self.initial_positions[opponent]]
        if self.grid[initial_index] != int(node_state):
            return set()

        self._cleanup_broken_edges(opponent)
        graph: dict[int, list[int]] = {}
        for a, b in self.edges[opponent]:
            graph.setdefault(a, []).append(b)
            graph.setdefault(b, []).append(a)

        alive_nodes = {initial_index}
        queue = deque([initial_index])
        while queue:
            current = queue.popleft()
            for next_index in graph.get(current, ()):
                if next_index not in alive_nodes:
                    alive_nodes.add(next_index)
                    queue.append(next_index)

        alive = set(alive_nodes)
        for edge in self.edges[opponent]:
            if edge[0] in alive_nodes and edge[1] in alive_nodes:
                point_a, point_b = self.edge_points(edge)
                alive.update(self.point_to_index[point] for point in self.line_points(point_a, point_b))
        return alive

    def _restore_edges(self, player: Player, edges_snapshot: set[Edge]) -> None:
        node_state, line_state = PLAYER_STATES[player]
        for edge in edges_snapshot:
            if edge in self.edges[player]:
                continue
            point_a, point_b = self.edge_points(edge)
            if self._get_state(point_a) != node_state or self._get_state(point_b) != node_state:
                continue
            if not self.can_connect_with_blocking(point_a, point_b, player):
                continue
            for point in self.line_points(point_a, point_b):
                if point == point_a or point == point_b:
                    self._set_state(point, node_state)
                elif self._get_state(point) == PointState.EMPTY:
                    self._set_state(point, line_state)
            self.edges[player].add(edge)

    def _connect_all_crawl(self, player: Player) -> None:
        node_state, line_state = PLAYER_STATES[player]
        enemy_states = set(PLAYER_STATES[self.opponent(player)])
        for node in self._player_nodes(player):
            for dx, dy in DIRECTIONS:
                x, y = node[0] + dx, node[1] + dy
                path: list[Point] = []
                while (x, y) in self.point_to_index:
                    state = self._get_state((x, y))
                    if state in enemy_states:
                        break
                    if state == node_state:
                        other = (x, y)
                        edge = self._edge(node, other)
                        if edge not in self.edges[player]:
                            for path_point in path:
                                if self._get_state(path_point) == PointState.EMPTY:
                                    self._set_state(path_point, line_state)
                            self.edges[player].add(edge)
                        break
                    path.append((x, y))
                    x += dx
                    y += dy

    def _handle_blocking_attack(
        self,
        new_point: Point,
        player: Player,
        original_state: PointState,
    ) -> None:
        del new_point
        opponent = self.opponent(player)
        if original_state != PLAYER_STATES[opponent][1]:
            return

        saved_edges = {candidate: set(self.edges[candidate]) for candidate in PLAYERS}
        alive = self._opponent_connected_pieces(opponent)
        opponent_states = {int(state) for state in PLAYER_STATES[opponent]}
        removed_pieces = 0
        for index, state in enumerate(self.grid):
            if state in opponent_states and index not in alive:
                self.grid[index] = int(PointState.EMPTY)
                removed_pieces += 1

        self.edges[opponent].clear()
        for candidate in PLAYERS:
            self._cleanup_broken_edges(candidate)

        if removed_pieces > 0:
            for candidate in PLAYERS:
                self._restore_edges(candidate, saved_edges[candidate])
            return
        self._restore_edges(player, saved_edges[player])
        self._restore_edges(opponent, saved_edges[opponent])

    def _add_node(self, point: Point) -> bool:
        if point not in self.point_to_index:
            return False
        original_state = self._get_state(point)
        if original_state not in (
            PointState.EMPTY,
            PointState.BLACK_LINE,
            PointState.WHITE_LINE,
        ):
            return False
        if self._is_in_protection_zone(point, self.current_player):
            return False

        current_node, current_line = PLAYER_STATES[self.current_player]
        is_attack = original_state == PLAYER_STATES[self.opponent(self.current_player)][1]
        if not is_attack and not self._check_three_point_limitation(point, self.current_player):
            return False

        self._set_state(point, current_node)
        existing_nodes = [node for node in self._player_nodes(self.current_player) if node != point]
        connected = False
        for node in existing_nodes:
            if not self.can_connect_with_blocking(point, node, self.current_player):
                continue
            connected = True
            for line_point in self.line_points(point, node):
                if line_point == point or line_point == node:
                    self._set_state(line_point, current_node)
                elif self._get_state(line_point) in (PointState.EMPTY, current_line):
                    self._set_state(line_point, current_line)
            self.edges[self.current_player].add(self._edge(point, node))

        if not connected:
            self._set_state(point, original_state)
            return False

        self._handle_blocking_attack(point, self.current_player, original_state)
        self._connect_all_crawl(self.current_player)
        return True

    def _position_snapshot(self) -> tuple[list[int], dict[Player, set[Edge]], Player]:
        return (
            self.grid.copy(),
            {player: set(self.edges[player]) for player in PLAYERS},
            self.current_player,
        )

    def _restore_position(
        self,
        snapshot: tuple[list[int], dict[Player, set[Edge]], Player],
    ) -> None:
        self.grid, self.edges, self.current_player = snapshot

    def _compute_state_key(self, next_player: Player) -> StateKey:
        occupied = tuple(
            (point[0], point[1], state)
            for point, state in zip(self.valid_positions, self.grid)
            if state != int(PointState.EMPTY)
        )
        return (
            next_player.value,
            occupied,
            tuple(sorted(self.edges[Player.BLACK])),
            tuple(sorted(self.edges[Player.WHITE])),
        )

    def evaluate_move(self, point: Sequence[int], player: Player | str | None = None) -> MoveResult:
        candidate = self.current_player if player is None else Player(player)
        try:
            normalized = (int(point[0]), int(point[1]))
        except (IndexError, TypeError, ValueError):
            return MoveResult(False, "INVALID_MOVE")
        if normalized not in self.point_to_index:
            return MoveResult(False, "INVALID_MOVE")

        snapshot = self._position_snapshot()
        try:
            self.current_player = candidate
            if not self._add_node(normalized):
                return MoveResult(False, "INVALID_MOVE")
            state_key = self._compute_state_key(self.opponent(candidate))
            would_violate_superko = state_key in self.history_hashes
            if would_violate_superko and self.superko_mode == "enforce":
                return MoveResult(
                    False,
                    "SUPERKO_VIOLATION",
                    would_violate_superko=True,
                )
            return MoveResult(True, would_violate_superko=would_violate_superko)
        finally:
            self._restore_position(snapshot)

    def legal_moves(self, player: Player | str | None = None) -> list[Point]:
        candidate = self.current_player if player is None else Player(player)
        cached = self._legal_moves_cache.get(candidate)
        if cached is None:
            cached = tuple(
                point
                for point in self.valid_positions
                if self.evaluate_move(point, candidate).success
            )
            self._legal_moves_cache[candidate] = cached
        return list(cached)

    def would_violate_superko_moves(
        self,
        player: Player | str | None = None,
    ) -> list[Point]:
        """Return locally valid placements whose resulting key is already recorded.

        In ``enforce`` mode these placements are illegal. In ``observe`` mode
        they remain legal, while :class:`MoveResult` exposes the counterfactual
        Superko event for ablation logging.
        """

        candidate = self.current_player if player is None else Player(player)
        return [
            point
            for point in self.valid_positions
            if self.evaluate_move(point, candidate).would_violate_superko
        ]

    def _has_valid_moves(self, player: Player) -> bool:
        return bool(self.legal_moves(player))

    def _switch_player(self) -> None:
        self.current_player = self.opponent(self.current_player)

    def _check_and_auto_skip(self) -> None:
        if self.game_over:
            return
        if not self._has_valid_moves(self.current_player):
            self.consecutive_skips += 1
            if self.consecutive_skips >= len(PLAYERS):
                self.game_over = True
            else:
                self._switch_player()
                self._check_and_auto_skip()

    def play_move(self, point: Sequence[int]) -> MoveResult:
        if self.game_over:
            return MoveResult(False, "GAME_OVER")
        try:
            normalized = (int(point[0]), int(point[1]))
        except (IndexError, TypeError, ValueError):
            return MoveResult(False, "INVALID_MOVE")

        snapshot = self._position_snapshot()
        if not self._add_node(normalized):
            return MoveResult(False, "INVALID_MOVE")

        state_key = self._compute_state_key(self.opponent(self.current_player))
        would_violate_superko = state_key in self.history_hashes
        if would_violate_superko and self.superko_mode == "enforce":
            self._restore_position(snapshot)
            return MoveResult(
                False,
                "SUPERKO_VIOLATION",
                would_violate_superko=True,
            )

        self.history_hashes.add(state_key)
        self.turn_count += 1
        self.consecutive_skips = 0
        self._legal_moves_cache.clear()
        self._switch_player()
        self._check_and_auto_skip()
        if self.game_over:
            self._update_territories()
        return MoveResult(True, would_violate_superko=would_violate_superko)

    def skip_turn(self) -> MoveResult:
        if self.game_over:
            return MoveResult(False, "GAME_OVER")
        self.consecutive_skips += 1
        if self.consecutive_skips >= len(PLAYERS):
            self.game_over = True
        else:
            self._switch_player()
            self._check_and_auto_skip()
        if self.game_over:
            self._update_territories()
        return MoveResult(True)

    def clone(self) -> GameSnapshot:
        return GameSnapshot(
            grid=tuple(self.grid),
            black_edges=tuple(sorted(self.edges[Player.BLACK])),
            white_edges=tuple(sorted(self.edges[Player.WHITE])),
            current_player=self.current_player,
            game_over=self.game_over,
            consecutive_skips=self.consecutive_skips,
            turn_count=self.turn_count,
            history_hashes=frozenset(self.history_hashes),
            superko_mode=self.superko_mode,
            start_player=self.start_player,
        )

    def restore(self, snapshot: GameSnapshot) -> None:
        if len(snapshot.grid) != self.num_points:
            raise ValueError("snapshot grid size does not match this game")
        self.grid = list(snapshot.grid)
        self.edges = {
            Player.BLACK: set(snapshot.black_edges),
            Player.WHITE: set(snapshot.white_edges),
        }
        self.current_player = snapshot.current_player
        self.game_over = snapshot.game_over
        self.consecutive_skips = snapshot.consecutive_skips
        self.turn_count = snapshot.turn_count
        self.history_hashes = set(snapshot.history_hashes)
        if snapshot.superko_mode not in SUPERKO_MODES:
            raise ValueError("snapshot has an invalid Superko mode")
        self.superko_mode = snapshot.superko_mode
        try:
            self.start_player = Player(snapshot.start_player)
        except ValueError as exc:
            raise ValueError("snapshot has an invalid start player") from exc
        self._legal_moves_cache.clear()
        self.cached_territories = {
            player: Territory(None, 0, 0) for player in PLAYERS
        }
        if self.game_over:
            self._update_territories()

    def replay(self, actions: Iterable[Point | None]) -> None:
        for ply, action in enumerate(actions):
            result = self.skip_turn() if action is None else self.play_move(action)
            if not result.success:
                raise ValueError(f"illegal replay action at ply {ply}: {action!r} ({result.reason})")

    def winner(self) -> Player | str | None:
        if not self.game_over:
            return None
        black = self.cached_territories[Player.BLACK].area
        white = self.cached_territories[Player.WHITE].area
        if black == white:
            return "DRAW"
        return Player.BLACK if black > white else Player.WHITE

    def rewards(self) -> dict[Player, float]:
        winner = self.winner()
        if winner is None or winner == "DRAW":
            return {Player.BLACK: 0.0, Player.WHITE: 0.0}
        assert isinstance(winner, Player)
        return {winner: 1.0, self.opponent(winner): -1.0}

    def serialize_state(self) -> dict[str, Any]:
        def state_key_json(key: StateKey) -> list[Any]:
            return [
                key[0],
                [list(entry) for entry in key[1]],
                [list(edge) for edge in key[2]],
                [list(edge) for edge in key[3]],
            ]

        payload = {
            "schema_version": 1,
            "grid_size": self.grid_size,
            "positions": [list(point) for point in self.valid_positions],
            "board": self.grid.copy(),
            "edges": {
                player.value: [list(edge) for edge in sorted(self.edges[player])]
                for player in PLAYERS
            },
            "current_player": self.current_player.value,
            "game_over": self.game_over,
            "consecutive_skips": self.consecutive_skips,
            "turn_count": self.turn_count,
            "history": [
                state_key_json(key)
                for key in sorted(self.history_hashes, key=repr)
            ],
            "territories": {
                player.value: {
                    "polygon": (
                        [list(point) for point in self.cached_territories[player].polygon]
                        if self.cached_territories[player].polygon is not None
                        else None
                    ),
                    "area": self.cached_territories[player].area,
                    "display_area": self.cached_territories[player].display_area,
                }
                for player in PLAYERS
            },
            "winner": self.winner().value if isinstance(self.winner(), Player) else self.winner(),
        }
        # Preserve byte-identical schema-v1 serialization and fingerprints for
        # the frozen default rules. Schema 2 records the observe-only ablation;
        # schema 3 additionally makes a non-default starting player lossless.
        if self.start_player is not Player.BLACK:
            payload["schema_version"] = 3
            payload["superko_mode"] = self.superko_mode
            payload["start_player"] = self.start_player.value
        elif self.superko_mode == "observe":
            payload["schema_version"] = 2
            payload["superko_mode"] = self.superko_mode
        return payload

    def canonical_state_json(self) -> str:
        """Return a byte-stable JSON representation of the complete rule state."""

        return json.dumps(
            self.serialize_state(),
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )

    def state_fingerprint(self) -> str:
        """SHA-256 identifier for logs and paired-state datasets."""

        return hashlib.sha256(self.canonical_state_json().encode("utf-8")).hexdigest()

    def _decode_state_key(self, raw_key: Any) -> StateKey:
        if not isinstance(raw_key, list) or len(raw_key) != 4:
            raise ValueError("invalid serialized history entry")
        try:
            next_player = Player(raw_key[0]).value
            occupied = tuple(
                (int(entry[0]), int(entry[1]), int(entry[2]))
                for entry in raw_key[1]
            )
            black_edges = tuple((int(edge[0]), int(edge[1])) for edge in raw_key[2])
            white_edges = tuple((int(edge[0]), int(edge[1])) for edge in raw_key[3])
        except (IndexError, TypeError, ValueError) as exc:
            raise ValueError("invalid serialized history entry") from exc
        occupied_points = [(x, y) for x, y, _ in occupied]
        if (
            len(occupied_points) != len(set(occupied_points))
            or any(point not in self.point_to_index for point in occupied_points)
            or occupied_points != sorted(
                occupied_points,
                key=self.point_to_index.__getitem__,
            )
        ):
            raise ValueError("invalid occupied-point ordering in serialized history")
        for _, _, state in occupied:
            if state not in {
                int(PointState.BLACK_NODE),
                int(PointState.BLACK_LINE),
                int(PointState.WHITE_NODE),
                int(PointState.WHITE_LINE),
            }:
                raise ValueError("invalid point state in serialized history")
        for edge in (*black_edges, *white_edges):
            if not (0 <= edge[0] < edge[1] < self.num_points):
                raise ValueError("invalid edge in serialized history")
        if (
            black_edges != tuple(sorted(set(black_edges)))
            or white_edges != tuple(sorted(set(white_edges)))
        ):
            raise ValueError("invalid edge ordering in serialized history")
        occupied_map = {(x, y): PointState(state) for x, y, state in occupied}
        for player, edges in (
            (Player.BLACK, black_edges),
            (Player.WHITE, white_edges),
        ):
            node_state, line_state = PLAYER_STATES[player]
            for edge in edges:
                point_a, point_b = self.edge_points(edge)
                if occupied_map.get(point_a) != node_state or occupied_map.get(point_b) != node_state:
                    raise ValueError("serialized history edge endpoints are not nodes")
                if any(
                    occupied_map.get(point) not in (node_state, line_state)
                    for point in self.line_points(point_a, point_b)
                ):
                    raise ValueError("serialized history contains a broken edge")
        return (next_player, occupied, black_edges, white_edges)

    def restore_serialized(self, data: dict[str, Any]) -> None:
        """Validate and restore a state emitted by :meth:`serialize_state`."""

        if not isinstance(data, dict) or data.get("schema_version") not in {1, 2, 3}:
            raise ValueError("unsupported serialized-state schema")
        schema_version = data["schema_version"]
        superko_mode = "enforce" if schema_version == 1 else data.get("superko_mode")
        if superko_mode not in SUPERKO_MODES:
            raise ValueError("invalid serialized Superko mode")
        try:
            start_player = (
                Player.BLACK
                if schema_version in {1, 2}
                else Player(data.get("start_player"))
            )
        except ValueError as exc:
            raise ValueError("invalid serialized start player") from exc
        if data.get("grid_size") != self.grid_size:
            raise ValueError("serialized grid size does not match this game")
        expected_positions = [list(point) for point in self.valid_positions]
        if data.get("positions") != expected_positions:
            raise ValueError("serialized action/position ordering does not match")

        board = data.get("board")
        valid_states = {int(member) for member in PointState}
        if (
            not isinstance(board, list)
            or len(board) != self.num_points
            or any(isinstance(state, bool) or not isinstance(state, int) or state not in valid_states for state in board)
        ):
            raise ValueError("invalid serialized board")

        raw_edges = data.get("edges")
        if not isinstance(raw_edges, dict) or set(raw_edges) != {player.value for player in PLAYERS}:
            raise ValueError("invalid serialized edge mapping")

        decoded_edges: dict[Player, tuple[Edge, ...]] = {}
        try:
            for player in PLAYERS:
                edges = tuple((int(edge[0]), int(edge[1])) for edge in raw_edges[player.value])
                if len(edges) != len(set(edges)):
                    raise ValueError("duplicate serialized edge")
                if any(not (0 <= edge[0] < edge[1] < self.num_points) for edge in edges):
                    raise ValueError("invalid serialized edge")
                node_state, line_state = PLAYER_STATES[player]
                for edge in edges:
                    point_a, point_b = self.edge_points(edge)
                    if board[edge[0]] != int(node_state) or board[edge[1]] != int(node_state):
                        raise ValueError("serialized edge endpoints are not nodes")
                    if any(
                        board[self.point_to_index[point]] not in (int(node_state), int(line_state))
                        for point in self.line_points(point_a, point_b)
                    ):
                        raise ValueError("serialized state contains a broken edge")
                decoded_edges[player] = tuple(sorted(edges))
            current_player = Player(data.get("current_player"))
        except (IndexError, TypeError, ValueError) as exc:
            raise ValueError("invalid serialized edges or current player") from exc

        game_over = data.get("game_over")
        consecutive_skips = data.get("consecutive_skips")
        turn_count = data.get("turn_count")
        if not isinstance(game_over, bool):
            raise ValueError("invalid serialized terminal flag")
        if (
            isinstance(consecutive_skips, bool)
            or not isinstance(consecutive_skips, int)
            or consecutive_skips < 0
        ):
            raise ValueError("invalid serialized skip count")
        if isinstance(turn_count, bool) or not isinstance(turn_count, int) or turn_count < 0:
            raise ValueError("invalid serialized turn count")

        raw_history = data.get("history")
        if not isinstance(raw_history, list) or not raw_history:
            raise ValueError("invalid serialized Superko history")
        history = frozenset(
            self._decode_state_key(raw_key)
            for raw_key in raw_history
        )
        if len(history) != len(raw_history):
            raise ValueError("duplicate serialized history entry")

        self.restore(
            GameSnapshot(
                grid=tuple(board),
                black_edges=decoded_edges[Player.BLACK],
                white_edges=decoded_edges[Player.WHITE],
                current_player=current_player,
                game_over=game_over,
                consecutive_skips=consecutive_skips,
                turn_count=turn_count,
                history_hashes=history,
                superko_mode=superko_mode,
                start_player=start_player,
            )
        )

    @classmethod
    def from_serialized_state(cls, data: dict[str, Any]) -> LifelineGame:
        if not isinstance(data, dict):
            raise ValueError("serialized state must be a mapping")
        grid_size = data.get("grid_size")
        schema_version = data.get("schema_version")
        if schema_version not in {1, 2, 3}:
            raise ValueError("unsupported serialized-state schema")
        superko_mode = "enforce" if schema_version == 1 else data.get("superko_mode")
        start_player = Player.BLACK if schema_version in {1, 2} else data.get("start_player")
        game = cls(grid_size, start_player=start_player, superko_mode=superko_mode)
        game.restore_serialized(data)
        return game

    # Territory scoring below is a direct dependency-free port of the Web engine.
    def _outer_contour(self, player: Player) -> list[Point]:
        friendly = set(self._player_nodes(player) + self._player_lines(player))
        if not friendly:
            return []
        start = min(friendly, key=lambda point: (point[0], point[1]))
        if len(friendly) == 1:
            return [start]

        backtrack = 3
        contour: list[Point] = []
        current = start
        first_out_direction: int | None = None
        for _ in range(len(friendly) * 6 + 10):
            out_direction = None
            for offset in range(6):
                direction = (backtrack + 1 + offset) % 6
                dx, dy = DIRS_CLOCKWISE[direction]
                if (current[0] + dx, current[1] + dy) in friendly:
                    out_direction = direction
                    break
            if out_direction is None:
                contour.append(current)
                break
            if first_out_direction is None:
                first_out_direction = out_direction
                contour.append(current)
            elif current == start and out_direction == first_out_direction:
                break
            else:
                contour.append(current)
            dx, dy = DIRS_CLOCKWISE[out_direction]
            current = (current[0] + dx, current[1] + dy)
            backtrack = (out_direction + 3) % 6
        return contour

    def _covered_indices(self, polygon: Sequence[Point]) -> set[int]:
        wall = {self.point_to_index[point] for point in polygon}
        water = {index for index in self.boundary_indices if index not in wall}
        queue = deque(water)
        while queue:
            current = queue.popleft()
            for next_index in self.adjacency[current]:
                if next_index not in wall and next_index not in water:
                    water.add(next_index)
                    queue.append(next_index)
        return set(range(self.num_points)) - water

    def _bfs_from_source(
        self,
        source: int,
        blocked: set[int],
    ) -> tuple[list[int], list[list[int] | None]]:
        distances = [-1] * self.num_points
        predecessors: list[list[int] | None] = [None] * self.num_points
        distances[source] = 0
        queue = deque([source])
        while queue:
            current = queue.popleft()
            for next_index in self.adjacency[current]:
                if next_index in blocked:
                    continue
                distance = distances[current] + 1
                if distances[next_index] == -1:
                    distances[next_index] = distance
                    predecessors[next_index] = [current]
                    queue.append(next_index)
                elif distances[next_index] == distance:
                    assert predecessors[next_index] is not None
                    predecessors[next_index].append(current)
        return distances, predecessors

    def _reconstruct_paths(
        self,
        source: int,
        target: int,
        distances: list[int],
        predecessors: list[list[int] | None],
    ) -> list[list[Point]]:
        if distances[target] == -1:
            return []

        def build(index: int) -> list[list[int]]:
            if index == source:
                return [[source]]
            result: list[list[int]] = []
            for previous in predecessors[index] or ():
                result.extend(path + [index] for path in build(previous))
            return result

        return [[self.valid_positions[index] for index in path] for path in build(target)]

    @staticmethod
    def _dedupe_consecutive(points: Sequence[Point]) -> list[Point]:
        return [point for index, point in enumerate(points) if index == 0 or point != points[index - 1]]

    def _compute_territory(self, player: Player) -> Territory:
        friendly_node_indices = {self.point_to_index[point] for point in self._player_nodes(player)}
        enemy_indices = {
            self.point_to_index[point]
            for point in self._player_nodes(self.opponent(player)) + self._player_lines(self.opponent(player))
        }
        current_polygon = self._outer_contour(player)
        if len(current_polygon) < 3:
            return Territory(None, 0, 0)

        current_area = 0
        while True:
            polygon_length = len(current_polygon)
            if polygon_length < 3:
                break
            current_covered = self._covered_indices(current_polygon)
            current_area = len(current_covered)
            current_perimeter = polygon_length
            best_candidate: list[Point] | None = None
            best_perimeter = current_perimeter
            best_area = current_area

            bfs_cache: list[tuple[int, list[int], list[list[int] | None]]] = []
            for point in current_polygon:
                source = self.point_to_index[point]
                distances, predecessors = self._bfs_from_source(source, enemy_indices)
                bfs_cache.append((source, distances, predecessors))

            for i in range(polygon_length):
                source, distances, predecessors = bfs_cache[i]
                for j in range(polygon_length - 1, i + 1, -1):
                    arc_length = j - i
                    target = self.point_to_index[current_polygon[j]]
                    shortest_distance = distances[target]
                    if shortest_distance == -1 or shortest_distance >= arc_length:
                        continue
                    paths = self._reconstruct_paths(
                        source,
                        target,
                        distances,
                        predecessors,
                    )
                    for path in paths:
                        path_length = len(path)
                        path_interior = path[1:-1]
                        is_inward = all(
                            self.point_to_index[point] in current_covered
                            for point in path_interior
                        )
                        reversed_middle = list(reversed(path_interior))
                        if is_inward:
                            wedge = self._dedupe_consecutive(
                                current_polygon[i : j + 1] + reversed_middle
                            )
                            if len(wedge) < 3:
                                continue
                            wedge_covered = self._covered_indices(wedge)
                            wedge_area = len(wedge_covered)
                            path_indices = {self.point_to_index[point] for point in path}
                            candidate_a_area = current_area - wedge_area + 2 * (path_length - 1)
                            candidate_a_perimeter = current_perimeter - arc_length + path_length - 1
                            if (
                                candidate_a_perimeter <= best_perimeter
                                and not (
                                    candidate_a_perimeter == best_perimeter
                                    and candidate_a_area >= best_area
                                )
                                and all(
                                    index not in wedge_covered or index in path_indices
                                    for index in friendly_node_indices
                                )
                            ):
                                candidate_a = self._dedupe_consecutive(
                                    current_polygon[:i] + path + current_polygon[j + 1 :]
                                )
                                if len(candidate_a) >= 3:
                                    best_perimeter = candidate_a_perimeter
                                    best_area = candidate_a_area
                                    best_candidate = candidate_a

                            candidate_b_perimeter = len(wedge)
                            candidate_b_area = wedge_area
                            if (
                                candidate_b_perimeter <= best_perimeter
                                and not (
                                    candidate_b_perimeter == best_perimeter
                                    and candidate_b_area >= best_area
                                )
                                and friendly_node_indices <= wedge_covered
                                and enemy_indices.isdisjoint(wedge_covered)
                            ):
                                best_perimeter = candidate_b_perimeter
                                best_area = candidate_b_area
                                best_candidate = wedge
                        else:
                            candidates = (
                                current_polygon[:i] + path + current_polygon[j + 1 :],
                                current_polygon[i : j + 1] + reversed_middle,
                            )
                            for raw_candidate in candidates:
                                candidate = self._dedupe_consecutive(raw_candidate)
                                if len(candidate) < 3 or len(candidate) > best_perimeter:
                                    continue
                                covered = self._covered_indices(candidate)
                                area = len(covered)
                                if len(candidate) == best_perimeter and area >= best_area:
                                    continue
                                if not friendly_node_indices <= covered or not enemy_indices.isdisjoint(covered):
                                    continue
                                best_perimeter = len(candidate)
                                best_area = area
                                best_candidate = candidate

            if best_candidate is None:
                break
            current_polygon = best_candidate

        if len(current_polygon) < 3:
            return Territory(None, 0, 0)
        display_area = abs(
            sum(
                current[0] * following[1] - following[0] * current[1]
                for current, following in zip(
                    current_polygon,
                    current_polygon[1:] + current_polygon[:1],
                )
            )
        )
        return Territory(tuple(current_polygon + [current_polygon[0]]), current_area, display_area)

    def _update_territories(self) -> None:
        self.cached_territories = {
            player: self._compute_territory(player)
            for player in PLAYERS
        }
