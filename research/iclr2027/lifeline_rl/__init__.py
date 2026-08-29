"""Dependency-free reference environment for the two-player LIFELINE game."""

from .core import (
    GameSnapshot,
    LifelineGame,
    MoveResult,
    Player,
    PointState,
    SUPERKO_MODES,
    Territory,
)
from .env import EnvSnapshot, LifelineEnv
from .arena import (
    GameRecord,
    IllegalAgentActionError,
    MatchupResult,
    play_game,
    replay_game_record,
    run_matchup,
    write_matchup,
)
from .agents import (
    AGENT_KINDS,
    GreedyAgent,
    GreedyConfig,
    HeuristicWeights,
    MCTSAgent,
    MCTSConfig,
    MinimaxAgent,
    MinimaxConfig,
    RandomAgent,
    make_agent,
)

__all__ = [
    "AGENT_KINDS",
    "EnvSnapshot",
    "GameSnapshot",
    "GameRecord",
    "GreedyAgent",
    "GreedyConfig",
    "HeuristicWeights",
    "IllegalAgentActionError",
    "LifelineEnv",
    "LifelineGame",
    "MCTSAgent",
    "MCTSConfig",
    "MinimaxAgent",
    "MinimaxConfig",
    "MatchupResult",
    "MoveResult",
    "Player",
    "PointState",
    "RandomAgent",
    "SUPERKO_MODES",
    "Territory",
    "play_game",
    "replay_game_record",
    "run_matchup",
    "write_matchup",
    "make_agent",
]
