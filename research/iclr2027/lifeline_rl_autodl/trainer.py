"""AutoDL v2 trainer that batches self-play without altering the frozen trainer."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import fmean
from typing import Any

from lifeline_rl.alphazero.checkpoint import compute_source_hash
from lifeline_rl.alphazero.puct import PUCTConfig
from lifeline_rl.alphazero.self_play import play_self_play_game
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

from .batched_network import BatchedTorchPolicyValueEvaluator
from .batched_puct import BatchedPUCTSearch
from .multi_actor import play_multi_actor_self_play


@dataclass(frozen=True)
class AutoDLRuntimeConfig:
    """Execution choices that are checkpoint-bound for the v2 path."""

    schema_version: int = 1
    actor_count: int = 32
    inference_amp: bool = True

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("unsupported AutoDL runtime schema")
        if (
            isinstance(self.actor_count, bool)
            or not isinstance(self.actor_count, int)
            or self.actor_count < 1
        ):
            raise ValueError("actor_count must be a positive integer")
        if not isinstance(self.inference_amp, bool):
            raise TypeError("inference_amp must be a boolean")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class BatchedAlphaZeroTrainer(AlphaZeroTrainer):
    """Reuse legacy optimization/checkpoint logic with a v2 self-play engine."""

    def __init__(
        self,
        *args: Any,
        runtime: AutoDLRuntimeConfig | None = None,
        **kwargs: Any,
    ) -> None:
        self.runtime = runtime or AutoDLRuntimeConfig()
        super().__init__(*args, **kwargs)
        if self.runtime.inference_amp and self.device.type != "cuda":
            raise ValueError("inference_amp requires a CUDA trainer device")
        evaluator = BatchedTorchPolicyValueEvaluator(
            self.model,
            self.config.observation_mode,
            self.device,
            use_amp=self.runtime.inference_amp,
        )
        self.searcher = BatchedPUCTSearch(
            evaluator,
            PUCTConfig(
                simulations=self.config.puct_simulations,
                c_puct=self.config.c_puct,
                dirichlet_alpha=self.config.dirichlet_alpha,
                dirichlet_epsilon=self.config.dirichlet_epsilon,
            ),
        )

    @staticmethod
    def source_files() -> tuple[Path, ...]:
        research_root = Path(__file__).resolve().parents[1]
        files = list(AlphaZeroTrainer.source_files())
        files.extend((research_root / "lifeline_rl_autodl").rglob("*.py"))
        for name in ("autodl_game_gpu.py", "run_autodl_main_training.py"):
            cli = research_root / "scripts" / name
            if cli.is_file():
                files.append(cli)
        return tuple(sorted(set(files)))

    @classmethod
    def current_source_hash(cls) -> str:
        research_root = Path(__file__).resolve().parents[1]
        return compute_source_hash(cls.source_files(), root=research_root)

    def resume_config(self) -> dict[str, Any]:
        return {
            "alphazero": json.loads(
                self.config.canonical_json(resume_critical=True)
            ),
            "autodl_runtime": self.runtime.to_dict(),
        }

    def run_iteration(self) -> dict[str, Any]:
        iteration_index = self.counters.iteration
        completed_this_iteration = 0
        truncated_this_iteration = 0
        total_added_before = self.replay_buffer.total_added
        games_remaining = self.config.games_per_iteration

        while games_remaining:
            actor_count = min(self.runtime.actor_count, games_remaining)
            game_indices = tuple(
                self.counters.next_game_id + offset
                for offset in range(actor_count)
            )
            seeds = tuple(
                self.self_play_rng.getrandbits(63) for _ in range(actor_count)
            )
            sizes = tuple(
                self.self_play_rng.choice(self.config.board_sizes)
                for _ in range(actor_count)
            )
            configs = tuple(self._self_play_config(size) for size in sizes)
            if actor_count == 1:
                results = (
                    play_self_play_game(
                        self.searcher,
                        configs[0],
                        seeds[0],
                        game_index=game_indices[0],
                        replay_buffer=self.replay_buffer,
                    ),
                )
            else:
                results = play_multi_actor_self_play(
                    self.searcher,
                    configs,
                    seeds,
                    game_indices=game_indices,
                    replay_buffer=self.replay_buffer,
                )

            for result in results:
                payload = self._result_payload(result)
                payload["iteration"] = iteration_index
                payload["execution_path"] = "autodl_batched_v2"
                self._append_jsonl(
                    self.games_log_path,
                    payload,
                    unique_key="game_index",
                )
                self.counters.environment_steps += len(payload.get("actions", ()))
                self.counters.games_attempted += 1
                self.counters.next_game_id += 1
                if payload.get("terminated"):
                    self.counters.games_completed += 1
                    completed_this_iteration += 1
                else:
                    self.counters.games_truncated += 1
                    truncated_this_iteration += 1
            games_remaining -= actor_count

        updates: list[dict[str, float]] = []
        if len(self.replay_buffer) >= self.config.batch_size:
            for _ in range(self.config.training_steps_per_iteration):
                updates.append(self.train_batch())
        if self.scheduler is not None:
            self.scheduler.step()
        self.counters.iteration += 1

        metrics: dict[str, Any] = {
            "schema_version": 1,
            "iteration": self.counters.iteration,
            "execution_path": "autodl_batched_v2",
            "games_completed": completed_this_iteration,
            "games_truncated": truncated_this_iteration,
            "experiences_added": self.replay_buffer.total_added - total_added_before,
            "buffer_size": len(self.replay_buffer),
            "gradient_steps_this_iteration": len(updates),
            "model_kind": self.config.model_kind,
            "observation_mode": self.config.observation_mode,
            "parameter_count": self.model.parameter_count,
            "actor_count": self.runtime.actor_count,
            "inference_amp": self.runtime.inference_amp,
            "counters": self.counters.to_dict(),
        }
        for key in ("loss", "policy_loss", "value_loss", "gradient_norm"):
            metrics[key] = fmean(update[key] for update in updates) if updates else None
        self._append_jsonl(self.metrics_path, metrics, unique_key="iteration")
        return metrics


__all__ = ["AutoDLRuntimeConfig", "BatchedAlphaZeroTrainer"]
