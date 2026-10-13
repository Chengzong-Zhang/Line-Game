"""Trainable, action-masked model-free LIFELINE baselines.

These baselines are deliberately isolated from the frozen AlphaZero evidence.
They share the exact two-player rule engine and never treat an illegal action as
a valid learning target.
"""

from .dqn import DQNConfig, DQNTrainer

__all__ = ["DQNConfig", "DQNTrainer"]
from .dqn import DQNConfig, DQNTrainer
from .ppo import PPOConfig, PPOTrainer
from .sac import SACConfig, SACTrainer

__all__ = ["DQNConfig", "DQNTrainer", "PPOConfig", "PPOTrainer", "SACConfig", "SACTrainer"]
