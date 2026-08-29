"""Single construction path used by arena command-line tools."""

from __future__ import annotations

from .base import Agent
from .greedy import GreedyAgent
from .mcts import MCTSAgent, MCTSConfig
from .minimax import MinimaxAgent, MinimaxConfig
from .random_agent import RandomAgent

AGENT_KINDS = ("random", "greedy", "minimax-2", "minimax-3", "mcts")


def make_agent(
    kind: str,
    *,
    minimax_move_cap: int = 20,
    mcts_simulations: int = 64,
    mcts_rollout_depth: int = 80,
    mcts_exploration: float = 2**0.5,
) -> Agent:
    """Build a baseline agent from its stable CLI identifier."""

    if kind == "random":
        return RandomAgent()
    if kind == "greedy":
        return GreedyAgent()
    if kind in {"minimax-2", "minimax-3"}:
        return MinimaxAgent(
            MinimaxConfig(depth=int(kind[-1]), move_cap=minimax_move_cap)
        )
    if kind == "mcts":
        return MCTSAgent(
            MCTSConfig(
                simulations=mcts_simulations,
                rollout_depth=mcts_rollout_depth,
                exploration=mcts_exploration,
            )
        )
    raise ValueError(f"unknown agent kind {kind!r}; expected one of {AGENT_KINDS}")
