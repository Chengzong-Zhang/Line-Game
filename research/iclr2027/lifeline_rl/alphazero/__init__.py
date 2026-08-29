"""AlphaZero framework with dependency-free search/replay primitives.

The neural model, trainer, and checkpoint backend are intentionally not
imported here, so ``import lifeline_rl.alphazero`` remains usable without the
optional PyTorch training dependency.
"""

from .config import AlphaZeroConfig
from .evaluation import (
    ArenaGateConfig,
    evaluate_arena_gate,
    evaluate_matchup_gate,
    score_wilson_interval,
    write_gate_report,
)
from .puct import (
    PUCT,
    PUCTConfig,
    PUCTSearch,
    PolicyValue,
    PolicyValueEvaluator,
    SearchResult,
)
from .replay import Experience, ReplayBuffer
from .self_play import (
    SelfPlayAction,
    SelfPlayConfig,
    SelfPlayResult,
    play_self_play_game,
)

__all__ = [
    "AlphaZeroConfig",
    "ArenaGateConfig",
    "Experience",
    "PUCT",
    "PUCTConfig",
    "PUCTSearch",
    "PolicyValue",
    "PolicyValueEvaluator",
    "ReplayBuffer",
    "SearchResult",
    "SelfPlayAction",
    "SelfPlayConfig",
    "SelfPlayResult",
    "evaluate_arena_gate",
    "evaluate_matchup_gate",
    "play_self_play_game",
    "score_wilson_interval",
    "write_gate_report",
]
