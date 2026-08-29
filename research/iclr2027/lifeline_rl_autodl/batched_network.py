"""Mixed-size batched PyTorch inference for AutoDL actor groups."""

from __future__ import annotations

from collections.abc import Sequence

import torch

from lifeline_rl.alphazero.network import (
    MODEL_OBSERVATION_MODES,
    PolicyValueModel,
    collate_positions,
)
from lifeline_rl.alphazero.puct import PolicyValue
from lifeline_rl.core import LifelineGame


class BatchedTorchPolicyValueEvaluator:
    """Relocate mixed-size PASS logits after one shared model forward pass."""

    def __init__(
        self,
        model: PolicyValueModel,
        observation_mode: str | None = None,
        device: str | torch.device = "cpu",
        *,
        use_amp: bool = False,
    ) -> None:
        if observation_mode is None:
            observation_mode = getattr(model, "observation_mode", None)
        if observation_mode not in MODEL_OBSERVATION_MODES:
            raise ValueError(
                f"observation_mode must be one of {MODEL_OBSERVATION_MODES}"
            )
        if not isinstance(use_amp, bool):
            raise TypeError("use_amp must be a boolean")
        self.model = model
        self.observation_mode = observation_mode
        self.device = torch.device(device)
        if use_amp and self.device.type != "cuda":
            raise ValueError("inference AMP requires a CUDA device")
        self.use_amp = use_amp
        self.model.to(self.device)

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        return self.evaluate_batch((game,))[0]

    def evaluate_batch(
        self,
        games: Sequence[LifelineGame],
    ) -> tuple[PolicyValue, ...]:
        games = tuple(games)
        if not games:
            raise ValueError("evaluate_batch requires at least one game")
        if any(game.game_over for game in games):
            raise ValueError("terminal games are not network inputs")
        batch = collate_positions(
            games,
            self.observation_mode,
            device=self.device,
        )
        was_training = self.model.training
        self.model.eval()
        with torch.no_grad():
            with torch.autocast(
                device_type="cuda",
                dtype=torch.float16,
                enabled=self.use_amp,
            ):
                logits, values = self.model(
                    batch.node_features,
                    batch.adjacency,
                    batch.node_mask,
                    batch.legal_action_mask,
                )
                probabilities = torch.softmax(logits, dim=1)
        probabilities = probabilities.float().cpu()
        values = values.float().cpu()
        if was_training:
            self.model.train()

        padded_pass_index = int(batch.node_features.shape[1])
        results: list[PolicyValue] = []
        for index, game in enumerate(games):
            priors = tuple(
                float(value)
                for value in probabilities[index, : game.num_points]
            ) + (float(probabilities[index, padded_pass_index]),)
            results.append(
                PolicyValue(value=float(values[index]), priors=priors)
            )
        return tuple(results)


__all__ = ["BatchedTorchPolicyValueEvaluator"]
