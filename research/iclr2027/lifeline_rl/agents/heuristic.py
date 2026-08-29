"""Cheap, territory-free state evaluation shared by search baselines."""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..core import LifelineGame, PLAYER_STATES, Player, PointState


@dataclass(frozen=True)
class HeuristicWeights:
    """Weights for the documented material/topology heuristic.

    The heuristic deliberately avoids the exact contour/territory algorithm.
    It is therefore suitable at every non-terminal search node without making
    intermediate scoring a hidden computational dependency.
    """

    nodes: float = 100.0
    lines: float = 10.0
    logical_edges: float = 5.0
    frontier: float = 1.0

    def __post_init__(self) -> None:
        if not all(
            math.isfinite(value)
            for value in (self.nodes, self.lines, self.logical_edges, self.frontier)
        ):
            raise ValueError("heuristic weights must be finite")


DEFAULT_HEURISTIC_WEIGHTS = HeuristicWeights()
TERMINAL_VALUE = 1_000_000.0


def _frontier_count(game: LifelineGame, player: Player) -> int:
    """Count distinct empty physical neighbours of the player's nodes."""

    node_state, _ = PLAYER_STATES[player]
    frontier: set[int] = set()
    for index, state in enumerate(game.grid):
        if state != int(node_state):
            continue
        frontier.update(
            neighbour
            for neighbour in game.adjacency[index]
            if game.grid[neighbour] == int(PointState.EMPTY)
        )
    return len(frontier)


def heuristic_features(game: LifelineGame, player: Player) -> dict[str, int]:
    """Return signed, root-player-perspective features for diagnostics."""

    opponent = game.opponent(player)
    own_node, own_line = PLAYER_STATES[player]
    opponent_node, opponent_line = PLAYER_STATES[opponent]
    return {
        "node_advantage": game.grid.count(int(own_node)) - game.grid.count(int(opponent_node)),
        "line_advantage": game.grid.count(int(own_line)) - game.grid.count(int(opponent_line)),
        "logical_edge_advantage": len(game.edges[player]) - len(game.edges[opponent]),
        "frontier_advantage": _frontier_count(game, player) - _frontier_count(game, opponent),
    }


def heuristic_score(
    game: LifelineGame,
    player: Player,
    weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
) -> float:
    """Evaluate ``game`` from ``player`` without exact non-terminal territory.

    Terminal states use the rules engine's exact win/draw/loss reward.  Every
    non-terminal state uses only node cells, line cells, explicit logical
    edges, and one-hop empty frontier cells.
    """

    if game.game_over:
        return TERMINAL_VALUE * game.rewards()[player]
    features = heuristic_features(game, player)
    return (
        weights.nodes * features["node_advantage"]
        + weights.lines * features["line_advantage"]
        + weights.logical_edges * features["logical_edge_advantage"]
        + weights.frontier * features["frontier_advantage"]
    )
