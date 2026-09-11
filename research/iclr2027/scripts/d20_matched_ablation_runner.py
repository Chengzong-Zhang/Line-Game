#!/usr/bin/env python3
"""Formal, append-only executor for the D20 matched-history factorial.

D19-v2 is deliberately a preflight-only frozen candidate.  This module does
not alter it: it is a separate D20 protocol whose four arms use the *same*
matched backbone and gate only logical edges and the compact Superko-history
plane.  It implements the missing end-to-end chain:

* complete-snapshot self play preserving history information in memory;
* matched optimizer updates and hash-bound final checkpoints;
* non-empty, model-independent opening strata with colour-swapped arenas;
* held-out-size tests against Random, UCT-16, and UCT-64; and
* a fail-closed independent replay/aggregate verifier.

Raw trajectories and checkpoints are intentionally written below
``local_artifacts/``.  They are not paper claims until ``--verify`` returns a
fresh ``formal_ready: true`` report for exactly the same source closure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import statistics
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

# CuBLAS reads this reproducibility switch when it first executes a CUDA
# matrix multiplication. Set it before importing Torch so a fresh D20 process
# can enable deterministic algorithms on CUDA 11+.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:  # Support direct execution and package-style unit-test imports.
    import d19_v2_matched_history_contract as matched_contract  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - selected only by package imports
    from scripts import d19_v2_matched_history_contract as matched_contract  # type: ignore

import torch
from torch import Tensor

from lifeline_rl import LifelineGame, Player
from lifeline_rl.agents.minimax import MinimaxAgent, MinimaxConfig
from lifeline_rl.agents.mcts import MCTSAgent, MCTSConfig
from lifeline_rl.agents.random_agent import RandomAgent
from lifeline_rl.alphazero.puct import PUCTConfig, PUCTSearch, PolicyValue


SCHEMA_VERSION = 2
MANIFEST_SCHEMA = "lifeline-d20-matched-ablation-manifest"
RUN_SCHEMA = "lifeline-d20-matched-ablation-run"
TASK_SCHEMA = "lifeline-d20-matched-ablation-task"
CHECKPOINT_SCHEMA = "lifeline-d20-matched-ablation-checkpoint"
RECEIPT_SCHEMA = "lifeline-d20-matched-ablation-receipt"
REPORT_SCHEMA = "lifeline-d20-matched-ablation-verification"
NUMERIC_SCHEMA = "lifeline-d20-matched-ablation-canonical-numeric"
EXPERIMENT_ID = "d20_matched_logical_edges_compact_history_formal_v2"
PROTOCOL_ID = "d20_matched_logical_edges_compact_history_protocol_20260909_v2"
SCHEDULE_DOMAIN = "d20-matched-ablation-counter-schedule-v1"

DEFAULT_MANIFEST = RESEARCH_ROOT / "configs" / "d20_matched_ablation_manifest_v2.json"
DEFAULT_PROTOCOL = RESEARCH_ROOT / "D20_MATCHED_ABLATION_PROTOCOL_V2.md"
LOCAL_ARTIFACT_ROOT = (REPO_ROOT / "local_artifacts" / "d20_matched_ablation").resolve()


class D20Error(RuntimeError):
    """Raised when a D20 protocol, artifact, or execution invariant fails."""


def canonical_json(value: Any) -> str:
    """Canonical finite JSON used for all D20 fingerprints."""

    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise D20Error(f"not canonical finite JSON: {exc}") from exc


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest().upper()


def sha256_file(path: str | Path) -> str:
    target = Path(path)
    if not target.is_file() or target.is_symlink():
        raise D20Error(f"hash target is not a regular file: {target}")
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise D20Error(f"cannot read {label}: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise D20Error(f"{label} must be a JSON object")
    return payload


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise D20Error(f"cannot read {label}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise D20Error(f"blank row in {label} at {line_number}")
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise D20Error(f"invalid JSONL row in {label} at {line_number}") from exc
        if not isinstance(row, dict):
            raise D20Error(f"non-object JSONL row in {label} at {line_number}")
        rows.append(row)
    return rows


def _write_new_json(path: Path, payload: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise D20Error(f"refusing to overwrite artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def _write_new_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    if path.exists() or path.is_symlink():
        raise D20Error(f"refusing to overwrite artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(canonical_json(dict(row)) + "\n")


def _relative_to_repo(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise D20Error(f"path is outside repository: {path}") from exc


def _derive_seed(domain: str, *components: object) -> int:
    raw = hashlib.sha256(
        canonical_json(
            {"schedule_domain": SCHEDULE_DOMAIN, "domain": domain, "components": components}
        ).encode("utf-8")
    ).digest()
    value = int.from_bytes(raw[:8], "big") & ((1 << 63) - 1)
    return value or 1


def _strict_int(value: object, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise D20Error(f"{label} must be an integer >= {minimum}")
    return value


def _strict_bool(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise D20Error(f"{label} must be a boolean")
    return value


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdefABCDEF" for character in value)
    )


def _source_closure() -> dict[str, str]:
    """Hash every source module whose semantics affect D20 execution."""

    relative_paths = (
        "research/iclr2027/scripts/d20_matched_ablation_runner.py",
        "research/iclr2027/scripts/verify_d20_matched_ablation.py",
        "research/iclr2027/scripts/d19_v2_matched_history_contract.py",
        "research/iclr2027/lifeline_rl/core.py",
        "research/iclr2027/lifeline_rl/alphazero/network.py",
        "research/iclr2027/lifeline_rl/alphazero/puct.py",
        "research/iclr2027/lifeline_rl/agents/minimax.py",
        "research/iclr2027/lifeline_rl/agents/heuristic.py",
        "research/iclr2027/lifeline_rl/agents/mcts.py",
        "research/iclr2027/lifeline_rl/agents/random_agent.py",
        "research/iclr2027/lifeline_rl/arena.py",
    )
    return {relative: sha256_file(REPO_ROOT / relative) for relative in relative_paths}


def load_manifest(path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    """Load the separate D20 registration without weakening frozen D19."""

    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    candidate = candidate.resolve()
    if not candidate.is_file() or candidate.is_symlink():
        raise D20Error(f"manifest is not a regular file: {candidate}")
    manifest = _read_json(candidate, "manifest")
    if manifest.get("schema_name") != MANIFEST_SCHEMA or manifest.get("schema_version") != SCHEMA_VERSION:
        raise D20Error("unexpected D20 manifest schema")
    if manifest.get("experiment_id") != EXPERIMENT_ID or manifest.get("protocol_id") != PROTOCOL_ID:
        raise D20Error("D20 experiment/protocol identifier mismatch")
    if manifest.get("status") != "formal_local_execution_authorized":
        raise D20Error("D20 must explicitly remain a local formal-execution registration")
    relation = manifest.get("relationship_to_d19_v2")
    expected_relation = {
        "mode": "append_only_distinct_experiment",
        "d19_v2_manifest_may_not_be_modified": True,
        "imports_d19_v2_results": False,
        "d19_v2_construct_validity_blocker_closed": False,
    }
    if relation != expected_relation:
        raise D20Error("D20 relationship-to-D19 boundary drifted")

    backbone = manifest.get("matched_backbone")
    expected_backbone = {
        "source": "d19_v2_matched_history_contract.MatchedD19V2PolicyValueNetwork",
        "node_feature_width": 12,
        "relation_count": 3,
        "hidden_channels": 64,
        "message_passing_layers": 3,
        "parameter_count_each_arm": 63235,
        "initial_state_rule": "identical_within_training_seed",
        "gates_only": ["logical_edges", "compact_history"],
    }
    if backbone != expected_backbone:
        raise D20Error("D20 matched backbone contract drifted")

    arms = manifest.get("arms")
    expected_arms = [
        {
            "id": arm_id,
            "logical_edges_enabled": gates[0],
            "compact_history_enabled": gates[1],
        }
        for arm_id, gates in matched_contract.ARM_FEATURES.items()
    ]
    if arms != expected_arms:
        raise D20Error("D20 arms are not the required exact 2x2 factorial")

    training = manifest.get("training")
    if not isinstance(training, Mapping):
        raise D20Error("training must be an object")
    required_training = {
        "training_seeds": [20260825, 20260826, 20260827, 20260828, 20260829],
        "train_sizes": [5, 7, 9],
        "iterations": 10,
        "games_per_iteration": 10,
        "updates_per_iteration": 20,
        "batch_size": 16,
        "replay_capacity": 10000,
        "puct_simulations": 16,
        "c_puct": 1.5,
        "dirichlet_alpha": 0.3,
        "dirichlet_epsilon": 0.25,
        "temperature_moves": 20,
        "initial_temperature": 1.0,
        "final_temperature": 0.1,
        "max_plies": 256,
        "superko_mode": "enforce",
        "optimizer": {
            "kind": "AdamW",
            "learning_rate": 0.001,
            "weight_decay": 0.0001,
            "betas": [0.9, 0.999],
            "epsilon": 1e-08,
            "gradient_clip_norm": 5.0,
        },
    }
    if dict(training) != required_training:
        raise D20Error("D20 training schedule drifted")

    evaluation = manifest.get("evaluation")
    if not isinstance(evaluation, Mapping):
        raise D20Error("evaluation must be an object")
    expected_evaluation = {
        "train_seen_size": 9,
        "held_out_sizes": [10, 12],
        "opening_strata": 32,
        "opening_variants_per_stratum": 1,
        "games_per_task": 64,
        "paired_color_pairs": 32,
        "max_plies": 256,
        "superko_mode": "enforce",
        "neural_puct": {"simulations": 1, "c_puct": 1.5, "temperature": 0.0},
        "opponents": {
            "random": {"kind": "random", "eval_sizes": [9, 10, 12]},
            "minimax_d2_cap8_v1": {
                "kind": "minimax",
                "depth": 2,
                "move_cap": 8,
                "eval_sizes": [10, 12],
            },
        },
        "primary_statistical_unit": "training_seed",
        "pooled_games_are_independent": False,
    }
    if dict(evaluation) != expected_evaluation:
        raise D20Error("D20 evaluation schedule drifted")

    expected_totals = {
        "training_tasks": 20,
        "self_play_games": 2000,
        "gradient_steps": 4000,
        "evaluation_tasks": 100,
        "evaluation_games": 6400,
        "checkpoints": 20,
    }
    if manifest.get("planned_totals") != expected_totals:
        raise D20Error("D20 planned totals drifted")
    expected_calibration = {
        "candidate_id": "minimax_d2_cap8_v1",
        "required_sizes": [10, 12],
        "required_status": "PASS",
        "lower_confidence_bound_rule": "two_sided_student_t_95_lower_gt_0.5_df4",
    }
    if manifest.get("strong_opponent_calibration") != expected_calibration:
        raise D20Error("D20 strong-opponent calibration gate drifted")
    source_bindings = manifest.get("source_bindings")
    if not isinstance(source_bindings, Mapping):
        raise D20Error("source_bindings must be an object")
    observed_sources = _source_closure()
    if dict(source_bindings) != observed_sources:
        raise D20Error("a D20 source binding drifted; start a distinct protocol revision")
    protocol_sha = manifest.get("protocol_sha256")
    if not _valid_sha256(protocol_sha) or str(protocol_sha).upper() != sha256_file(DEFAULT_PROTOCOL):
        raise D20Error("D20 protocol hash binding drifted")
    return manifest


def _arm_map(manifest: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    arms = manifest["arms"]
    assert isinstance(arms, list)
    return {str(row["id"]): dict(row) for row in arms}


def build_task_plan(manifest: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Create a source-independent, counter-based plan before model execution."""

    training = manifest["training"]
    evaluation = manifest["evaluation"]
    assert isinstance(training, Mapping) and isinstance(evaluation, Mapping)
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for arm in manifest["arms"]:
        assert isinstance(arm, Mapping)
        arm_id = str(arm["id"])
        for seed in training["training_seeds"]:
            task = {
                "schema_name": TASK_SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "kind": "training",
                "task_id": f"train.{arm_id}.seed{seed}",
                "arm_id": arm_id,
                "training_seed": int(seed),
                "train_sizes": list(training["train_sizes"]),
                "iterations": int(training["iterations"]),
                "games_per_iteration": int(training["games_per_iteration"]),
                "updates_per_iteration": int(training["updates_per_iteration"]),
            }
            task["row_sha256"] = canonical_sha256(task)
            train_rows.append(task)

            for opponent_id, opponent in evaluation["opponents"].items():
                assert isinstance(opponent, Mapping)
                sizes = list(opponent["eval_sizes"])
                for size in sizes:
                    eval_task = {
                        "schema_name": TASK_SCHEMA,
                        "schema_version": SCHEMA_VERSION,
                        "kind": "evaluation",
                        "task_id": f"eval.{arm_id}.seed{seed}.n{size}.vs.{opponent_id}",
                        "arm_id": arm_id,
                        "training_seed": int(seed),
                        "eval_size": int(size),
                        "opponent_id": str(opponent_id),
                        "games": int(evaluation["games_per_task"]),
                        "color_pairs": int(evaluation["paired_color_pairs"]),
                        "opening_strata": int(evaluation["opening_strata"]),
                        "opening_variants_per_stratum": int(evaluation["opening_variants_per_stratum"]),
                    }
                    eval_task["row_sha256"] = canonical_sha256(eval_task)
                    eval_rows.append(eval_task)
    expected = manifest["planned_totals"]
    if len(train_rows) != expected["training_tasks"] or len(eval_rows) != expected["evaluation_tasks"]:
        raise D20Error("task plan count disagrees with registered totals")
    return {"training": train_rows, "evaluation": eval_rows}


def _action_from_index(game: LifelineGame, action: int) -> tuple[int, int] | None:
    if action == game.num_points:
        return None
    if not 0 <= action < game.num_points:
        raise D20Error(f"invalid fixed action index {action}")
    return game.valid_positions[action]


def _apply_index(game: LifelineGame, action: int) -> None:
    result = game.skip_turn() if action == game.num_points else game.play_move(game.valid_positions[action])
    if not result.success:
        raise D20Error(f"illegal indexed action {action}: {result.reason}")


def _legal_action_mask(game: LifelineGame) -> tuple[int, ...]:
    legal_points = set(game.legal_moves())
    return tuple(int(point in legal_points) for point in game.valid_positions) + (1,)


def _game_fingerprint(game: LifelineGame) -> str:
    return game.state_fingerprint()


def _opening_from_actions(size: int, actions: Sequence[int]) -> LifelineGame:
    game = LifelineGame(size, superko_mode="enforce")
    for action in actions:
        if game.game_over:
            raise D20Error("opening contains an action after terminal state")
        _apply_index(game, int(action))
    if game.game_over:
        raise D20Error("registered opening is terminal")
    return game


def generate_opening_registry(manifest: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Make deterministic non-empty openings without loading a model or result."""

    evaluation = manifest["evaluation"]
    assert isinstance(evaluation, Mapping)
    registry: dict[str, list[dict[str, Any]]] = {}
    for size in (9, 10, 12):
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for stratum in range(int(evaluation["opening_strata"])):
            for variant in range(int(evaluation["opening_variants_per_stratum"])):
                # The number of opening plies deliberately varies by stratum;
                # all choices are uniformly sampled from legal placements only.
                prefix_length = 3 + (stratum % 6)
                accepted: dict[str, Any] | None = None
                for attempt in range(1000):
                    rng = random.Random(_derive_seed("opening", size, stratum, variant, attempt))
                    game = LifelineGame(size, superko_mode="enforce")
                    actions: list[int] = []
                    valid = True
                    for _ in range(prefix_length):
                        legal = list(game.legal_moves())
                        if not legal or game.game_over:
                            valid = False
                            break
                        point = rng.choice(legal)
                        action = game.point_to_index[point]
                        _apply_index(game, action)
                        actions.append(action)
                    if not valid or game.game_over:
                        continue
                    prefix_fingerprint = _game_fingerprint(game)
                    if prefix_fingerprint in seen:
                        continue
                    accepted = {
                        "opening_id": f"n{size}.s{stratum:02d}.v{variant}",
                        "grid_size": size,
                        "stratum": stratum,
                        "variant": variant,
                        "generator_attempt": attempt,
                        "actions": actions,
                        "prefix_fingerprint": prefix_fingerprint,
                        "plies": len(actions),
                    }
                    accepted["row_sha256"] = canonical_sha256(accepted)
                    break
                if accepted is None:
                    raise D20Error(f"could not produce unique opening n={size}, stratum={stratum}, variant={variant}")
                seen.add(str(accepted["prefix_fingerprint"]))
                entries.append(accepted)
        expected = int(evaluation["opening_strata"]) * int(evaluation["opening_variants_per_stratum"])
        if len(entries) != expected or len(seen) != expected:
            raise D20Error("opening registry coverage/uniqueness failed")
        registry[str(size)] = entries
    return registry


@dataclass(frozen=True)
class D20Experience:
    """A self-play target retaining the exact pre-action history snapshot."""

    snapshot: Any
    actor: Player
    legal_action_mask: tuple[int, ...]
    root_visits: tuple[int, ...]
    z: float


class MatchedD20Evaluator:
    """Torch adapter using D19's exact feature gates for D20 inference."""

    def __init__(
        self,
        model: torch.nn.Module,
        *,
        logical_edges_enabled: bool,
        compact_history_enabled: bool,
        device: torch.device,
    ) -> None:
        self.model = model
        self.logical_edges_enabled = logical_edges_enabled
        self.compact_history_enabled = compact_history_enabled
        self.device = device
        self.model.to(device)

    def evaluate(self, game: LifelineGame) -> PolicyValue:
        batch = matched_contract.build_arm_batch(
            [game],
            logical_edges_enabled=self.logical_edges_enabled,
            compact_history_enabled=self.compact_history_enabled,
        )
        was_training = self.model.training
        self.model.eval()
        with torch.no_grad():
            logits, values = self.model(
                batch.node_features.to(self.device),
                batch.adjacency.to(self.device),
                batch.node_mask.to(self.device),
                batch.legal_action_mask.to(self.device),
            )
            priors = torch.softmax(logits[0], dim=0).detach().cpu().tolist()
            value = float(values[0].detach().cpu().item())
        if was_training:
            self.model.train()
        return PolicyValue(value=value, priors=priors)


class MatchedD20Agent:
    """Arena-compatible fixed-weight policy with the registered evaluation PUCT."""

    def __init__(
        self,
        model: torch.nn.Module,
        *,
        arm: Mapping[str, Any],
        device: torch.device,
        checkpoint_sha256: str,
        label: str,
        neural_puct: Mapping[str, Any],
    ) -> None:
        self.label = label
        self.checkpoint_sha256 = checkpoint_sha256
        self.evaluator = MatchedD20Evaluator(
            model,
            logical_edges_enabled=bool(arm["logical_edges_enabled"]),
            compact_history_enabled=bool(arm["compact_history_enabled"]),
            device=device,
        )
        self.searcher = PUCTSearch(
            self.evaluator,
            PUCTConfig(
                simulations=int(neural_puct["simulations"]),
                c_puct=float(neural_puct["c_puct"]),
                dirichlet_alpha=0.3,
                dirichlet_epsilon=0.0,
            ),
        )
        self.temperature = float(neural_puct["temperature"])
        self._last_diagnostics: dict[str, Any] = {}

    @property
    def name(self) -> str:
        return self.label

    def select_action(self, game: LifelineGame, rng: random.Random) -> tuple[int, int] | None:
        result = self.searcher.search(game, rng, temperature=self.temperature, add_root_noise=False)
        self._last_diagnostics = {
            "algorithm": "d20_matched_neural_puct",
            "checkpoint_sha256": self.checkpoint_sha256,
            "simulations": result.simulations,
            "temperature": result.temperature,
            "selected_action": result.action,
            "root_visits": list(result.visits),
        }
        return _action_from_index(game, result.action)

    def diagnostics(self) -> dict[str, Any]:
        return dict(self._last_diagnostics)


def _experience_games(experiences: Sequence[D20Experience]) -> list[LifelineGame]:
    games: list[LifelineGame] = []
    for experience in experiences:
        snapshot = experience.snapshot
        game = LifelineGame(
            int(snapshot.grid_size) if hasattr(snapshot, "grid_size") else 5,
            start_player=snapshot.start_player,
            superko_mode=snapshot.superko_mode,
        )
        # GameSnapshot has no grid-size field; the holder stores it separately
        # through the concrete board cardinality below.
        games.append(game)
    return games


def _snapshot_to_game(snapshot: Any, grid_size: int) -> LifelineGame:
    game = LifelineGame(
        grid_size,
        start_player=snapshot.start_player,
        superko_mode=snapshot.superko_mode,
    )
    game.restore(snapshot)
    return game


def _make_training_batch(
    experiences: Sequence[D20Experience],
    *,
    logical_edges_enabled: bool,
    compact_history_enabled: bool,
    device: torch.device,
) -> tuple[Any, Tensor, Tensor]:
    if not experiences:
        raise D20Error("cannot train on an empty D20 batch")
    games: list[LifelineGame] = []
    for experience in experiences:
        point_count = len(experience.legal_action_mask) - 1
        # n(n+1)/2 = point_count; all registered sizes satisfy this exact root.
        discriminant = 1 + 8 * point_count
        side = (math.isqrt(discriminant) - 1) // 2
        if side * (side + 1) // 2 != point_count:
            raise D20Error("experience action mask does not encode a triangular board")
        games.append(_snapshot_to_game(experience.snapshot, side))
    batch = matched_contract.build_arm_batch(
        games,
        logical_edges_enabled=logical_edges_enabled,
        compact_history_enabled=compact_history_enabled,
    )
    count = len(experiences)
    max_nodes = int(batch.node_features.shape[1])
    policy_targets = torch.zeros(count, max_nodes + 1, dtype=torch.float32, device=device)
    value_targets = torch.zeros(count, dtype=torch.float32, device=device)
    for row, experience in enumerate(experiences):
        nodes = len(experience.legal_action_mask) - 1
        visits = experience.root_visits
        total = sum(visits)
        if total < 1 or len(visits) != nodes + 1:
            raise D20Error("experience has invalid root visit target")
        for action, visits_at_action in enumerate(visits):
            if not experience.legal_action_mask[action] and visits_at_action:
                raise D20Error("experience assigns visits to an illegal action")
        policy_targets[row, :nodes] = torch.tensor(visits[:nodes], dtype=torch.float32, device=device) / total
        policy_targets[row, max_nodes] = float(visits[nodes]) / total
        value_targets[row] = experience.z
    return batch, policy_targets, value_targets


def _train_step(
    model: torch.nn.Module,
    optimizer: torch.optim.Optimizer,
    experiences: Sequence[D20Experience],
    *,
    arm: Mapping[str, Any],
    gradient_clip_norm: float,
    device: torch.device,
) -> dict[str, float]:
    batch, policy_targets, value_targets = _make_training_batch(
        experiences,
        logical_edges_enabled=bool(arm["logical_edges_enabled"]),
        compact_history_enabled=bool(arm["compact_history_enabled"]),
        device=device,
    )
    model.train()
    logits, values = model(
        batch.node_features.to(device),
        batch.adjacency.to(device),
        batch.node_mask.to(device),
        batch.legal_action_mask.to(device),
    )
    policy_loss = -(policy_targets * torch.log_softmax(logits, dim=1)).sum(dim=1).mean()
    value_loss = torch.mean((values - value_targets) ** 2)
    loss = policy_loss + value_loss
    if not bool(torch.isfinite(loss)):
        raise D20Error("non-finite D20 loss")
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    gradient_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), gradient_clip_norm).item())
    optimizer.step()
    return {
        "loss": float(loss.detach().cpu().item()),
        "policy_loss": float(policy_loss.detach().cpu().item()),
        "value_loss": float(value_loss.detach().cpu().item()),
        "gradient_norm": gradient_norm,
    }


def _play_self_play_game(
    searcher: PUCTSearch,
    *,
    grid_size: int,
    seed: int,
    max_plies: int,
    temperature_moves: int,
    initial_temperature: float,
    final_temperature: float,
    root_noise: bool,
    game_index: int,
) -> tuple[dict[str, Any], list[D20Experience]]:
    game = LifelineGame(grid_size, superko_mode="enforce")
    rng = random.Random(seed)
    pending: list[tuple[Any, Player, tuple[int, ...], tuple[int, ...]]] = []
    actions: list[dict[str, Any]] = []
    for ply in range(max_plies):
        if game.game_over:
            break
        snapshot = game.clone()
        legal_mask = _legal_action_mask(game)
        temperature = initial_temperature if ply < temperature_moves else final_temperature
        result = searcher.search(game, rng, temperature=temperature, add_root_noise=root_noise)
        if len(result.visits) != game.num_points + 1:
            raise D20Error("PUCT self-play output action width drifted")
        action = int(result.action)
        if not legal_mask[action]:
            raise D20Error("PUCT self-play selected an illegal action")
        actions.append(
            {
                "ply": ply,
                "actor": game.current_player.value,
                "action": action,
                "point": None if action == game.num_points else list(game.valid_positions[action]),
                "temperature": temperature,
                "state_fingerprint": _game_fingerprint(game),
                "legal_action_mask": list(legal_mask),
                "root_visits": list(result.visits),
                "simulations": result.simulations,
            }
        )
        pending.append((snapshot, game.current_player, legal_mask, tuple(int(value) for value in result.visits)))
        _apply_index(game, action)
    if not game.game_over:
        raise D20Error(f"self-play game {game_index} reached max_plies={max_plies}")
    rewards = game.rewards()
    experiences = [
        D20Experience(
            snapshot=snapshot,
            actor=actor,
            legal_action_mask=legal_mask,
            root_visits=visits,
            z=float(rewards[actor]),
        )
        for snapshot, actor, legal_mask, visits in pending
    ]
    row = {
        "schema_version": SCHEMA_VERSION,
        "game_index": game_index,
        "seed": seed,
        "grid_size": grid_size,
        "superko_mode": "enforce",
        "terminated": True,
        "truncated": False,
        "final_state_fingerprint": _game_fingerprint(game),
        "winner": game.winner().value if isinstance(game.winner(), Player) else game.winner(),
        "plies": len(actions),
        "actions": actions,
    }
    return row, experiences


def _configure_determinism(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    try:
        torch.use_deterministic_algorithms(True)
    except RuntimeError as exc:
        raise D20Error(f"cannot enable deterministic Torch execution: {exc}") from exc


def _atomic_torch_save(path: Path, payload: Mapping[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise D20Error(f"refusing to overwrite checkpoint: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".d20-", suffix=".pt", dir=path.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        torch.save(dict(payload), temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _torch_load_weights(path: Path) -> Mapping[str, Any]:
    try:
        payload = torch.load(path, map_location="cpu", weights_only=True)
    except TypeError:  # pragma: no cover - old torch fallback
        payload = torch.load(path, map_location="cpu")
    except Exception as exc:
        raise D20Error(f"cannot safely load checkpoint {path}: {exc}") from exc
    if not isinstance(payload, Mapping):
        raise D20Error("checkpoint payload must be a mapping")
    return payload


def _save_checkpoint(
    run_root: Path,
    *,
    task: Mapping[str, Any],
    model: torch.nn.Module,
    manifest: Mapping[str, Any],
    source_hashes: Mapping[str, str],
    training_summary: Mapping[str, Any],
) -> dict[str, Any]:
    task_id = str(task["task_id"])
    state_hash = matched_contract.model_state_sha256(model)
    model_state = {name: value.detach().cpu().contiguous() for name, value in model.state_dict().items()}
    payload = {
        "schema_name": CHECKPOINT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "protocol_id": PROTOCOL_ID,
        "task_id": task_id,
        "arm_id": task["arm_id"],
        "training_seed": task["training_seed"],
        "manifest_sha256": canonical_sha256(manifest),
        "source_hashes": dict(source_hashes),
        "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
        "model_state_sha256": state_hash,
        "model_state_dict": model_state,
        "training_summary": dict(training_summary),
    }
    path = run_root / "checkpoints" / f"{task_id}.pt"
    _atomic_torch_save(path, payload)
    receipt = {
        "task_id": task_id,
        "checkpoint_path": _relative_to_repo(path),
        "checkpoint_sha256": sha256_file(path),
        "model_state_sha256": state_hash,
        "parameter_count": payload["parameter_count"],
    }
    receipt["row_sha256"] = canonical_sha256(receipt)
    return receipt


def _load_checkpoint_model(
    path: Path,
    *,
    task: Mapping[str, Any],
    manifest: Mapping[str, Any],
    device: torch.device,
) -> torch.nn.Module:
    payload = _torch_load_weights(path)
    required = {
        "schema_name": CHECKPOINT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "protocol_id": PROTOCOL_ID,
        "task_id": task["task_id"],
        "arm_id": task["arm_id"],
        "training_seed": task["training_seed"],
        "manifest_sha256": canonical_sha256(manifest),
    }
    for key, expected in required.items():
        if payload.get(key) != expected:
            raise D20Error(f"checkpoint binding mismatch at {key}")
    state = payload.get("model_state_dict")
    if not isinstance(state, Mapping):
        raise D20Error("checkpoint model state is missing")
    model = matched_contract.instantiate_matched_model(int(task["training_seed"]))
    model.load_state_dict(state, strict=True)
    if sum(parameter.numel() for parameter in model.parameters()) != matched_contract.EXPECTED_TRAINABLE_PARAMETERS:
        raise D20Error("checkpoint model parameter count mismatch")
    observed_state_hash = matched_contract.model_state_sha256(model)
    if payload.get("model_state_sha256") != observed_state_hash:
        raise D20Error("checkpoint model-state hash mismatch")
    model.to(device)
    return model


def _train_task(
    task: Mapping[str, Any],
    *,
    arm: Mapping[str, Any],
    manifest: Mapping[str, Any],
    run_root: Path,
    source_hashes: Mapping[str, str],
    device: torch.device,
) -> dict[str, Any]:
    training = manifest["training"]
    assert isinstance(training, Mapping)
    seed = int(task["training_seed"])
    _configure_determinism(seed)
    model = matched_contract.instantiate_matched_model(seed).to(device)
    initial_hash = matched_contract.model_state_sha256(model)
    if sum(parameter.numel() for parameter in model.parameters()) != matched_contract.EXPECTED_TRAINABLE_PARAMETERS:
        raise D20Error("matched model parameter count drifted")
    optimizer_spec = training["optimizer"]
    assert isinstance(optimizer_spec, Mapping)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(optimizer_spec["learning_rate"]),
        weight_decay=float(optimizer_spec["weight_decay"]),
        betas=tuple(float(item) for item in optimizer_spec["betas"]),
        eps=float(optimizer_spec["epsilon"]),
    )
    evaluator = MatchedD20Evaluator(
        model,
        logical_edges_enabled=bool(arm["logical_edges_enabled"]),
        compact_history_enabled=bool(arm["compact_history_enabled"]),
        device=device,
    )
    searcher = PUCTSearch(
        evaluator,
        PUCTConfig(
            simulations=int(training["puct_simulations"]),
            c_puct=float(training["c_puct"]),
            dirichlet_alpha=float(training["dirichlet_alpha"]),
            dirichlet_epsilon=float(training["dirichlet_epsilon"]),
        ),
    )
    replay: list[D20Experience] = []
    selfplay_path = run_root / "self_play" / f"{task['task_id']}.jsonl"
    metrics_path = run_root / "training_metrics" / f"{task['task_id']}.jsonl"
    selfplay_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    if selfplay_path.exists() or metrics_path.exists():
        raise D20Error("training task output already exists")
    started = time.perf_counter()
    game_index = 0
    gradient_steps = 0
    total_environment_steps = 0
    with selfplay_path.open("x", encoding="utf-8", newline="\n") as selfplay_handle, metrics_path.open("x", encoding="utf-8", newline="\n") as metrics_handle:
        for iteration in range(int(training["iterations"])):
            game_rows: list[dict[str, Any]] = []
            for local_game in range(int(training["games_per_iteration"])):
                size_index = _derive_seed("training_size", seed, iteration, local_game) % len(training["train_sizes"])
                grid_size = int(training["train_sizes"][size_index])
                game_seed = _derive_seed("self_play", seed, iteration, local_game)
                row, experiences = _play_self_play_game(
                    searcher,
                    grid_size=grid_size,
                    seed=game_seed,
                    max_plies=int(training["max_plies"]),
                    temperature_moves=int(training["temperature_moves"]),
                    initial_temperature=float(training["initial_temperature"]),
                    final_temperature=float(training["final_temperature"]),
                    root_noise=True,
                    game_index=game_index,
                )
                row.update({"task_id": task["task_id"], "iteration": iteration})
                selfplay_handle.write(canonical_json(row) + "\n")
                selfplay_handle.flush()
                game_rows.append(row)
                game_index += 1
                total_environment_steps += int(row["plies"])
                replay.extend(experiences)
                replay = replay[-int(training["replay_capacity"]) :]
            update_rows: list[dict[str, float]] = []
            if len(replay) < int(training["batch_size"]):
                raise D20Error("replay is too small for registered D20 batch size")
            for update_index in range(int(training["updates_per_iteration"])):
                selection_rng = random.Random(_derive_seed("training_batch", seed, iteration, update_index))
                indices = selection_rng.sample(range(len(replay)), int(training["batch_size"]))
                update_rows.append(
                    _train_step(
                        model,
                        optimizer,
                        [replay[index] for index in indices],
                        arm=arm,
                        gradient_clip_norm=float(optimizer_spec["gradient_clip_norm"]),
                        device=device,
                    )
                )
                gradient_steps += 1
            metrics = {
                "task_id": task["task_id"],
                "iteration": iteration + 1,
                "self_play_games": len(game_rows),
                "environment_steps": sum(int(row["plies"]) for row in game_rows),
                "replay_size": len(replay),
                "gradient_steps": len(update_rows),
                **{
                    field: statistics.fmean(row[field] for row in update_rows)
                    for field in ("loss", "policy_loss", "value_loss", "gradient_norm")
                },
            }
            metrics_handle.write(canonical_json(metrics) + "\n")
            metrics_handle.flush()
    expected_games = int(training["iterations"]) * int(training["games_per_iteration"])
    expected_updates = int(training["iterations"]) * int(training["updates_per_iteration"])
    if game_index != expected_games or gradient_steps != expected_updates:
        raise D20Error("training counters differ from registered budget")
    summary = {
        "self_play_games": game_index,
        "gradient_steps": gradient_steps,
        "environment_steps": total_environment_steps,
        "initial_model_state_sha256": initial_hash,
        "final_model_state_sha256": matched_contract.model_state_sha256(model),
        "self_play_path": _relative_to_repo(selfplay_path),
        "self_play_sha256": sha256_file(selfplay_path),
        "metrics_path": _relative_to_repo(metrics_path),
        "metrics_sha256": sha256_file(metrics_path),
        "wall_clock_seconds": time.perf_counter() - started,
        "device": str(device),
    }
    checkpoint = _save_checkpoint(
        run_root,
        task=task,
        model=model,
        manifest=manifest,
        source_hashes=source_hashes,
        training_summary=summary,
    )
    return {
        "schema_name": RECEIPT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "kind": "training",
        "status": "complete",
        "task": dict(task),
        "arm": dict(arm),
        "summary": summary,
        "checkpoint": checkpoint,
    }


def _opponent(opponent_id: str) -> Any:
    if opponent_id == "random":
        return RandomAgent()
    if opponent_id == "minimax_d2_cap8_v1":
        return MinimaxAgent(MinimaxConfig(depth=2, move_cap=8), label="minimax_d2_cap8_v1")
    raise D20Error(f"unknown registered opponent {opponent_id!r}")


def _play_evaluation_game(
    agent_a: Any,
    agent_b: Any,
    *,
    opening: Mapping[str, Any],
    pair_id: str,
    game_index: int,
    a_as_black: bool,
    a_policy_seed: int,
    b_policy_seed: int,
    max_plies: int,
) -> dict[str, Any]:
    grid_size = int(opening["grid_size"])
    opening_actions = [int(action) for action in opening["actions"]]
    game = _opening_from_actions(grid_size, opening_actions)
    if _game_fingerprint(game) != opening["prefix_fingerprint"]:
        raise D20Error("opening fingerprint does not reproduce")
    black_agent, white_agent = (agent_a, agent_b) if a_as_black else (agent_b, agent_a)
    policy_rng = {
        Player.BLACK: random.Random(a_policy_seed if a_as_black else b_policy_seed),
        Player.WHITE: random.Random(b_policy_seed if a_as_black else a_policy_seed),
    }
    continuation: list[dict[str, Any]] = []
    started = time.perf_counter()
    while not game.game_over and len(continuation) < max_plies:
        actor = game.current_player
        agent = black_agent if actor is Player.BLACK else white_agent
        snapshot = game.clone()
        action_point = agent.select_action(game, policy_rng[actor])
        if game.clone() != snapshot:
            raise D20Error(f"arena agent {agent.name!r} mutated the game while choosing")
        if action_point is not None and action_point not in game.point_to_index:
            raise D20Error(f"arena agent {agent.name!r} emitted an invalid point")
        action = game.num_points if action_point is None else game.point_to_index[action_point]
        continuation.append(
            {
                "ply": len(continuation),
                "actor": actor.value,
                "action": action,
                "point": None if action_point is None else list(action_point),
                "state_fingerprint": _game_fingerprint(game),
                "diagnostics": dict(agent.diagnostics()),
            }
        )
        _apply_index(game, action)
    truncated = not game.game_over
    winner = None if truncated else game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = None
    if not truncated:
        territories = {player.value: game.cached_territories[player].area for player in (Player.BLACK, Player.WHITE)}
    return {
        "schema_version": SCHEMA_VERSION,
        "pair_id": pair_id,
        "game_index": game_index,
        "grid_size": grid_size,
        "superko_mode": "enforce",
        "opening_id": opening["opening_id"],
        "opening_actions": opening_actions,
        "opening_fingerprint": opening["prefix_fingerprint"],
        "opening_stratum": opening["stratum"],
        "opening_variant": opening["variant"],
        "black_slot": "A" if a_as_black else "B",
        "white_slot": "B" if a_as_black else "A",
        "black_agent": black_agent.name,
        "white_agent": white_agent.name,
        "a_policy_seed": a_policy_seed,
        "b_policy_seed": b_policy_seed,
        "terminated": not truncated,
        "truncated": truncated,
        "winner": winner_value,
        "territories": territories,
        "plies": len(continuation),
        "duration_seconds": time.perf_counter() - started,
        "final_state_fingerprint": _game_fingerprint(game),
        "actions": continuation,
    }


def _score_for_a(row: Mapping[str, Any]) -> float | None:
    if bool(row["truncated"]):
        return None
    winner = row["winner"]
    if winner == "DRAW":
        return 0.5
    a_color = "BLACK" if row["black_slot"] == "A" else "WHITE"
    return 1.0 if winner == a_color else 0.0


def _evaluate_task(
    task: Mapping[str, Any],
    *,
    arm: Mapping[str, Any],
    model: torch.nn.Module,
    checkpoint_sha256: str,
    manifest: Mapping[str, Any],
    opening_registry: Mapping[str, Sequence[Mapping[str, Any]]],
    games_handle: Any,
    device: torch.device,
) -> dict[str, Any]:
    evaluation = manifest["evaluation"]
    assert isinstance(evaluation, Mapping)
    grid_size = int(task["eval_size"])
    openings = list(opening_registry[str(grid_size)])
    agent_a = MatchedD20Agent(
        model,
        arm=arm,
        device=device,
        checkpoint_sha256=checkpoint_sha256,
        label=f"{task['arm_id']}-seed{task['training_seed']}",
        neural_puct=evaluation["neural_puct"],
    )
    agent_b = _opponent(str(task["opponent_id"]))
    rows: list[dict[str, Any]] = []
    for opening in openings:
        pair_id = f"{task['task_id']}.{opening['opening_id']}"
        pair_seed = _derive_seed(
            "evaluation_pair",
            int(task["training_seed"]),
            grid_size,
            task["opponent_id"],
            int(opening["stratum"]),
            int(opening["variant"]),
        )
        a_seed = _derive_seed("evaluation_policy_a", pair_seed)
        b_seed = _derive_seed("evaluation_policy_b", pair_seed)
        first = _play_evaluation_game(
            agent_a,
            agent_b,
            opening=opening,
            pair_id=pair_id,
            game_index=len(rows),
            a_as_black=True,
            a_policy_seed=a_seed,
            b_policy_seed=b_seed,
            max_plies=int(evaluation["max_plies"]),
        )
        second = _play_evaluation_game(
            agent_a,
            agent_b,
            opening=opening,
            pair_id=pair_id,
            game_index=len(rows) + 1,
            a_as_black=False,
            a_policy_seed=a_seed,
            b_policy_seed=b_seed,
            max_plies=int(evaluation["max_plies"]),
        )
        for row in (first, second):
            row["task_id"] = task["task_id"]
            row["arm_id"] = task["arm_id"]
            row["training_seed"] = task["training_seed"]
            row["opponent_id"] = task["opponent_id"]
            row["row_sha256"] = canonical_sha256(row)
            games_handle.write(canonical_json(row) + "\n")
            games_handle.flush()
            rows.append(row)
    expected_games = int(task["games"])
    if len(rows) != expected_games:
        raise D20Error("evaluation task game coverage mismatch")
    scores = [_score_for_a(row) for row in rows]
    if any(score is None for score in scores):
        raise D20Error(f"evaluation task {task['task_id']} contains truncation")
    numeric_scores = [float(score) for score in scores if score is not None]
    return {
        "schema_name": RECEIPT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "kind": "evaluation",
        "status": "complete",
        "task": dict(task),
        "checkpoint_sha256": checkpoint_sha256,
        "games": len(rows),
        "wins": sum(score == 1.0 for score in numeric_scores),
        "losses": sum(score == 0.0 for score in numeric_scores),
        "draws": sum(score == 0.5 for score in numeric_scores),
        "score_rate": statistics.fmean(numeric_scores),
        "unique_openings": len({str(row["opening_fingerprint"]) for row in rows}),
        "truncated_games": 0,
    }


def _t_interval(values: Sequence[float]) -> dict[str, float | int | list[float]]:
    if len(values) != 5:
        raise D20Error("D20 primary t interval requires all five training seeds")
    mean = statistics.fmean(values)
    stdev = statistics.stdev(values)
    margin = 2.7764451051977987 * stdev / math.sqrt(5.0)
    return {"n": 5, "df": 4, "mean": mean, "ci95": [mean - margin, mean + margin]}


def _aggregate_games(manifest: Mapping[str, Any], games: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    expected_games_per_cell = int(manifest["evaluation"]["games_per_task"])
    groups: dict[tuple[str, int, str, int], list[float]] = {}
    for row in games:
        score = _score_for_a(row)
        if score is None:
            raise D20Error("cannot aggregate truncated game")
        key = (str(row["arm_id"]), int(row["training_seed"]), str(row["opponent_id"]), int(row["grid_size"]))
        groups.setdefault(key, []).append(float(score))
    by_cell: dict[tuple[str, int], dict[str, dict[int, float]]] = {}
    for (arm_id, seed, opponent_id, grid_size), scores in groups.items():
        if len(scores) != expected_games_per_cell:
            raise D20Error(
                f"cell {arm_id}/{seed}/{opponent_id}/{grid_size} has {len(scores)}, "
                f"not {expected_games_per_cell} games"
            )
        by_cell.setdefault((opponent_id, grid_size), {}).setdefault(arm_id, {})[seed] = statistics.fmean(scores)
    cell_rows: list[dict[str, Any]] = []
    contrast_rows: list[dict[str, Any]] = []
    required_arms = list(matched_contract.ARM_FEATURES)
    for (opponent_id, grid_size), arm_values in sorted(by_cell.items()):
        if set(arm_values) != set(required_arms) or any(len(values) != 5 for values in arm_values.values()):
            raise D20Error(f"incomplete factorial cell at {opponent_id}/n{grid_size}")
        seed_sets = [set(values) for values in arm_values.values()]
        if any(seed_set != seed_sets[0] for seed_set in seed_sets[1:]):
            raise D20Error(f"factorial arms do not share the same training seeds at {opponent_id}/n{grid_size}")
        ordered_seeds = sorted(seed_sets[0])
        indexed = {arm: [values[seed] for seed in ordered_seeds] for arm, values in arm_values.items()}
        for arm_id in required_arms:
            cell_rows.append(
                {
                    "opponent_id": opponent_id,
                    "eval_size": grid_size,
                    "arm_id": arm_id,
                    "training_seed_score_rates": indexed[arm_id],
                    "training_seed_interval": _t_interval(indexed[arm_id]),
                }
            )
        e00, e10, e01, e11 = (indexed[name] for name in ("edge0_history0", "edge1_history0", "edge0_history1", "edge1_history1"))
        contrasts = {
            "logical_at_history0": [right - left for left, right in zip(e00, e10)],
            "logical_at_history1": [right - left for left, right in zip(e01, e11)],
            "history_at_edge0": [right - left for left, right in zip(e00, e01)],
            "history_at_edge1": [right - left for left, right in zip(e10, e11)],
            "interaction": [a - b - c + d for a, b, c, d in zip(e11, e10, e01, e00)],
        }
        for name, values in contrasts.items():
            contrast_rows.append(
                {
                    "opponent_id": opponent_id,
                    "eval_size": grid_size,
                    "contrast": name,
                    "training_seed_values": values,
                    "training_seed_interval": _t_interval(values),
                }
            )
    return {
        "schema_name": NUMERIC_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "primary_statistical_unit": "training_seed",
        "pooled_games_are_independent": False,
        "cell_estimates": cell_rows,
        "factorial_contrasts": contrast_rows,
        "evaluation_games": len(games),
    }


def _replay_evaluation_row(row: Mapping[str, Any]) -> None:
    grid_size = int(row["grid_size"])
    game = _opening_from_actions(grid_size, [int(item) for item in row["opening_actions"]])
    if _game_fingerprint(game) != row["opening_fingerprint"]:
        raise D20Error("game opening fingerprint mismatch")
    actions = row["actions"]
    if not isinstance(actions, list):
        raise D20Error("game continuation must be a list")
    for expected_ply, action_row in enumerate(actions):
        if game.game_over:
            raise D20Error("continuation extends beyond terminal state")
        if action_row.get("ply") != expected_ply:
            raise D20Error("continuation ply index mismatch")
        if action_row.get("actor") != game.current_player.value:
            raise D20Error("continuation actor mismatch")
        if action_row.get("state_fingerprint") != _game_fingerprint(game):
            raise D20Error("continuation pre-action fingerprint mismatch")
        action = int(action_row["action"])
        _apply_index(game, action)
    if bool(row["truncated"]):
        if game.game_over:
            raise D20Error("terminal game incorrectly labelled truncated")
        return
    if not game.game_over:
        raise D20Error("non-truncated game did not terminate")
    winner = game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    if winner_value != row.get("winner"):
        raise D20Error("winner mismatch after replay")
    territories = {player.value: game.cached_territories[player].area for player in (Player.BLACK, Player.WHITE)}
    if territories != row.get("territories"):
        raise D20Error("territory mismatch after replay")
    if _game_fingerprint(game) != row.get("final_state_fingerprint"):
        raise D20Error("final state fingerprint mismatch")


def verify_run(
    run_root: str | Path,
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Independently recompute all D20 counts, replays, and contrasts."""

    manifest = load_manifest(manifest_path)
    root = Path(run_root).resolve()
    metadata = _read_json(root / "run_metadata.json", "run metadata")
    if metadata.get("schema_name") != RUN_SCHEMA or metadata.get("experiment_id") != EXPERIMENT_ID:
        raise D20Error("run metadata schema/id mismatch")
    if metadata.get("manifest_sha256") != canonical_sha256(manifest):
        raise D20Error("run metadata manifest binding mismatch")
    if metadata.get("source_hashes") != _source_closure():
        raise D20Error("run source closure drifted")
    calibration_binding = _read_json(root / "strong_opponent_calibration.json", "strong-opponent calibration")
    if metadata.get("strong_opponent_calibration") != calibration_binding:
        raise D20Error("run metadata calibration binding mismatch")
    if _load_calibration_binding(str(calibration_binding.get("report_path", ""))) != calibration_binding:
        raise D20Error("strong-opponent calibration report drifted")
    plan = build_task_plan(manifest)
    task_manifest = _read_json(root / "task_plan.json", "task plan")
    if task_manifest != plan:
        raise D20Error("persisted task plan differs from registered schedule")
    training_receipts = _read_jsonl(root / "training_receipts.jsonl", "training receipts")
    evaluation_receipts = _read_jsonl(root / "evaluation_receipts.jsonl", "evaluation receipts")
    if len(training_receipts) != len(plan["training"]):
        raise D20Error("training receipt coverage mismatch")
    if len(evaluation_receipts) != len(plan["evaluation"]):
        raise D20Error("evaluation receipt coverage mismatch")
    expected_training_ids = {str(row["task_id"]) for row in plan["training"]}
    observed_training_ids = {str(row.get("task", {}).get("task_id")) for row in training_receipts}
    if observed_training_ids != expected_training_ids:
        raise D20Error("training task IDs are missing or duplicated")
    checkpoint_count = 0
    for receipt in training_receipts:
        task = receipt.get("task")
        checkpoint = receipt.get("checkpoint")
        if not isinstance(task, Mapping) or not isinstance(checkpoint, Mapping):
            raise D20Error("training receipt shape invalid")
        if receipt.get("status") != "complete":
            raise D20Error("incomplete training receipt")
        path = REPO_ROOT / str(checkpoint.get("checkpoint_path"))
        if sha256_file(path) != checkpoint.get("checkpoint_sha256"):
            raise D20Error("checkpoint byte hash mismatch")
        model = _load_checkpoint_model(path, task=task, manifest=manifest, device=torch.device("cpu"))
        if matched_contract.model_state_sha256(model) != checkpoint.get("model_state_sha256"):
            raise D20Error("loaded checkpoint state hash mismatch")
        summary = receipt.get("summary")
        if not isinstance(summary, Mapping) or summary.get("self_play_games") != 100 or summary.get("gradient_steps") != 200:
            raise D20Error("training receipt budget mismatch")
        checkpoint_count += 1
    expected_eval_ids = {str(row["task_id"]) for row in plan["evaluation"]}
    observed_eval_ids = {str(row.get("task", {}).get("task_id")) for row in evaluation_receipts}
    if observed_eval_ids != expected_eval_ids:
        raise D20Error("evaluation task IDs are missing or duplicated")
    games = _read_jsonl(root / "evaluation_games.jsonl", "evaluation games")
    if len(games) != int(manifest["planned_totals"]["evaluation_games"]):
        raise D20Error("evaluation-game count mismatch")
    evaluation = manifest["evaluation"]
    expected_task_games = int(evaluation["games_per_task"])
    expected_pairs = int(evaluation["paired_color_pairs"])
    expected_openings = int(evaluation["opening_strata"]) * int(evaluation["opening_variants_per_stratum"])
    by_task: dict[str, list[Mapping[str, Any]]] = {}
    for row in games:
        expected_row_hash = row.get("row_sha256")
        raw = dict(row)
        raw.pop("row_sha256", None)
        if expected_row_hash != canonical_sha256(raw):
            raise D20Error("evaluation row hash mismatch")
        _replay_evaluation_row(row)
        by_task.setdefault(str(row["task_id"]), []).append(row)
    for receipt in evaluation_receipts:
        task = receipt.get("task")
        if not isinstance(task, Mapping) or receipt.get("status") != "complete":
            raise D20Error("incomplete evaluation receipt")
        task_games = by_task.get(str(task["task_id"]), [])
        if len(task_games) != expected_task_games or any(bool(row["truncated"]) for row in task_games):
            raise D20Error("evaluation task replay/count/truncation failure")
        pairs: dict[str, list[Mapping[str, Any]]] = {}
        for row in task_games:
            pairs.setdefault(str(row["pair_id"]), []).append(row)
        if len(pairs) != expected_pairs or any(len(pair) != 2 for pair in pairs.values()):
            raise D20Error("paired-colour evaluation coverage mismatch")
        for pair in pairs.values():
            if {row["black_slot"] for row in pair} != {"A", "B"}:
                raise D20Error("colour swap missing within a pair")
            if pair[0]["opening_fingerprint"] != pair[1]["opening_fingerprint"]:
                raise D20Error("colour pair does not share opening")
        if len({row["opening_fingerprint"] for row in task_games}) != expected_openings:
            raise D20Error("opening diversity gate failed")
        scores = [_score_for_a(row) for row in task_games]
        if sum(value == 1.0 for value in scores) != receipt.get("wins"):
            raise D20Error("evaluation receipt win count mismatch")
        if sum(value == 0.0 for value in scores) != receipt.get("losses"):
            raise D20Error("evaluation receipt loss count mismatch")
        if sum(value == 0.5 for value in scores) != receipt.get("draws"):
            raise D20Error("evaluation receipt draw count mismatch")
    numeric = _aggregate_games(manifest, games)
    report = {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "formal_ready": True,
        "experiment_id": EXPERIMENT_ID,
        "manifest_sha256": canonical_sha256(manifest),
        "run_root": _relative_to_repo(root),
        "training_tasks": len(training_receipts),
        "evaluation_tasks": len(evaluation_receipts),
        "evaluation_games_replayed": len(games),
        "checkpoint_count": checkpoint_count,
        "gates": {
            "source_closure": True,
            "matched_parameter_count": True,
            "all_registered_seeds": True,
            "checkpoint_load_hashes": True,
            "held_out_sizes": True,
            "strong_opponent_present": True,
            "paired_colour_opening_diversity": True,
            "zero_truncations": True,
            "all_games_replayed": True,
            "training_seed_inference": True,
        },
        "canonical_numeric_sha256": canonical_sha256(numeric),
    }
    return report, numeric


def _validate_new_output_root(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(LOCAL_ARTIFACT_ROOT)
    except ValueError as exc:
        raise D20Error(f"D20 output must be below {_relative_to_repo(LOCAL_ARTIFACT_ROOT)}") from exc
    if resolved == LOCAL_ARTIFACT_ROOT or resolved.exists() or resolved.is_symlink():
        raise D20Error("D20 output root must be a new, specific local-artifact directory")
    return resolved


def _load_calibration_binding(raw: str | Path) -> dict[str, Any]:
    """Require the separately registered Minimax-vs-UCT calibration to pass."""

    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    candidate = candidate.resolve()
    try:
        candidate.relative_to((REPO_ROOT / "local_artifacts").resolve())
    except ValueError as exc:
        raise D20Error("calibration report must be a local artifact inside this repository") from exc
    report = _read_json(candidate, "strong-opponent calibration report")
    required = {
        "status": "PASS",
        "formal_ready": True,
        "candidate_id": "minimax_d2_cap8_v1",
        "passed_sizes": [10, 12],
    }
    for key, expected in required.items():
        if report.get(key) != expected:
            raise D20Error(f"strong-opponent calibration failed at {key}")
    return {
        "report_path": _relative_to_repo(candidate),
        "report_sha256": sha256_file(candidate),
        "report": report,
    }


def run_formal(
    *,
    output_root: str | Path,
    manifest_path: str | Path = DEFAULT_MANIFEST,
    device: str = "cuda",
    calibration_report: str | Path | None = None,
) -> dict[str, Any]:
    """Execute the registered local D20 run once, then fail-closed verify it."""

    manifest = load_manifest(manifest_path)
    if device not in {"cpu", "cuda"}:
        raise D20Error("device must be cpu or cuda")
    if device == "cuda" and not torch.cuda.is_available():
        raise D20Error("D20 requested CUDA but no CUDA device is available")
    if calibration_report is None:
        raise D20Error("D20-v2 formal execution requires a passed --calibration-report")
    calibration_binding = _load_calibration_binding(calibration_report)
    output = _validate_new_output_root(output_root)
    output.mkdir(parents=True, exist_ok=False)
    selected_device = torch.device(device)
    source_hashes = _source_closure()
    plan = build_task_plan(manifest)
    opening_registry = generate_opening_registry(manifest)
    metadata = {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "protocol_id": PROTOCOL_ID,
        "manifest_path": _relative_to_repo(Path(manifest_path).resolve() if Path(manifest_path).is_absolute() else REPO_ROOT / manifest_path),
        "manifest_sha256": canonical_sha256(manifest),
        "protocol_sha256": sha256_file(DEFAULT_PROTOCOL),
        "source_hashes": source_hashes,
        "device": str(selected_device),
        "torch_version": torch.__version__,
        "cuda_device_name": torch.cuda.get_device_name(0) if selected_device.type == "cuda" else None,
        "strong_opponent_calibration": calibration_binding,
        "status": "running",
    }
    _write_new_json(output / "run_metadata.json", metadata)
    _write_new_json(output / "task_plan.json", plan)
    _write_new_json(output / "opening_registry.json", opening_registry)
    _write_new_json(output / "strong_opponent_calibration.json", calibration_binding)
    training_receipts: list[dict[str, Any]] = []
    checkpoint_by_training_task: dict[str, dict[str, Any]] = {}
    arms = _arm_map(manifest)
    for task in plan["training"]:
        receipt = _train_task(
            task,
            arm=arms[str(task["arm_id"])],
            manifest=manifest,
            run_root=output,
            source_hashes=source_hashes,
            device=selected_device,
        )
        receipt["row_sha256"] = canonical_sha256(receipt)
        training_receipts.append(receipt)
        checkpoint_by_training_task[str(task["task_id"])] = receipt["checkpoint"]
    _write_new_jsonl(output / "training_receipts.jsonl", training_receipts)
    evaluation_receipts: list[dict[str, Any]] = []
    games_path = output / "evaluation_games.jsonl"
    with games_path.open("x", encoding="utf-8", newline="\n") as games_handle:
        for task in plan["evaluation"]:
            training_id = f"train.{task['arm_id']}.seed{task['training_seed']}"
            checkpoint = checkpoint_by_training_task.get(training_id)
            if checkpoint is None:
                raise D20Error(f"missing completed training checkpoint for {training_id}")
            checkpoint_path = REPO_ROOT / str(checkpoint["checkpoint_path"])
            model = _load_checkpoint_model(
                checkpoint_path,
                task={
                    "task_id": training_id,
                    "arm_id": task["arm_id"],
                    "training_seed": task["training_seed"],
                },
                manifest=manifest,
                device=selected_device,
            )
            receipt = _evaluate_task(
                task,
                arm=arms[str(task["arm_id"])],
                model=model,
                checkpoint_sha256=str(checkpoint["checkpoint_sha256"]),
                manifest=manifest,
                opening_registry=opening_registry,
                games_handle=games_handle,
                device=selected_device,
            )
            receipt["row_sha256"] = canonical_sha256(receipt)
            evaluation_receipts.append(receipt)
    _write_new_jsonl(output / "evaluation_receipts.jsonl", evaluation_receipts)
    runner_report, numeric = verify_run(output, manifest_path=manifest_path)
    _write_new_json(output / "canonical_numeric.json", numeric)
    _write_new_json(output / "runner_verification.json", runner_report)
    try:
        import verify_d20_matched_ablation as independent_verifier  # type: ignore
    except ModuleNotFoundError:  # pragma: no cover - package-style fallback
        from scripts import verify_d20_matched_ablation as independent_verifier  # type: ignore
    independent_report, independent_numeric = independent_verifier.verify(
        output,
        manifest_path=manifest_path,
    )
    if canonical_sha256(independent_numeric) != canonical_sha256(numeric):
        raise D20Error("runner and independent numeric aggregates disagree")
    _write_new_json(output / "independent_verification.json", independent_report)
    completion = {
        "schema_name": RUN_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": EXPERIMENT_ID,
        "status": "complete",
        "formal_ready": bool(independent_report["formal_ready"]),
        "training_receipts_sha256": sha256_file(output / "training_receipts.jsonl"),
        "evaluation_receipts_sha256": sha256_file(output / "evaluation_receipts.jsonl"),
        "evaluation_games_sha256": sha256_file(games_path),
        "canonical_numeric_sha256": sha256_file(output / "canonical_numeric.json"),
        "runner_verification_sha256": sha256_file(output / "runner_verification.json"),
        "independent_verification_sha256": sha256_file(output / "independent_verification.json"),
    }
    _write_new_json(output / "completion.json", completion)
    return {"run_root": str(output), "completion": completion, "verification": independent_report}


def run_readiness(*, manifest_path: str | Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    """CPU task-shaped readiness: real feature encoding, PUCT, and one update."""

    manifest = load_manifest(manifest_path)
    plan = build_task_plan(manifest)
    arm = _arm_map(manifest)["edge1_history1"]
    task = plan["training"][0]
    _configure_determinism(int(task["training_seed"]))
    model = matched_contract.instantiate_matched_model(int(task["training_seed"]))
    evaluator = MatchedD20Evaluator(model, logical_edges_enabled=True, compact_history_enabled=True, device=torch.device("cpu"))
    searcher = PUCTSearch(evaluator, PUCTConfig(simulations=16, c_puct=1.5, dirichlet_alpha=0.3, dirichlet_epsilon=0.25))
    row, experiences = _play_self_play_game(
        searcher,
        grid_size=5,
        seed=_derive_seed("readiness_self_play", int(task["training_seed"])),
        max_plies=256,
        temperature_moves=20,
        initial_temperature=1.0,
        final_temperature=0.1,
        root_noise=True,
        game_index=0,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.0001)
    metrics = _train_step(
        model,
        optimizer,
        experiences[:16],
        arm=arm,
        gradient_clip_norm=5.0,
        device=torch.device("cpu"),
    )
    return {
        "status": "PASS",
        "kind": "d20_task_shaped_cpu_readiness",
        "self_play_plies": row["plies"],
        "experience_count": len(experiences),
        "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
        "metrics": metrics,
    }


def run_gpu_smoke(
    *,
    manifest_path: str | Path = DEFAULT_MANIFEST,
    seconds: int = 20,
    batch_size: int = 32,
    profile_output: str | Path | None = None,
) -> dict[str, Any]:
    """Continuously exercise D20's real CUDA forward/backward/optimizer path."""

    if not torch.cuda.is_available():
        raise D20Error("CUDA is unavailable for D20 GPU smoke")
    if not 15 <= seconds <= 30:
        raise D20Error("GPU smoke seconds must be between 15 and 30")
    if batch_size < 2:
        raise D20Error("GPU smoke batch size must be >= 2")
    manifest = load_manifest(manifest_path)
    arm = _arm_map(manifest)["edge1_history1"]
    _configure_determinism(20260909)
    model = matched_contract.instantiate_matched_model(20260909).to("cuda")
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.0001)
    game = LifelineGame(7, superko_mode="enforce")
    # Use a real compact-history tensor rather than synthetic random arrays.
    visits = tuple(1 if legal else 0 for legal in _legal_action_mask(game))
    experiences = [
        D20Experience(
            snapshot=game.clone(),
            actor=game.current_player,
            legal_action_mask=_legal_action_mask(game),
            root_visits=visits,
            z=0.0,
        )
        for _ in range(batch_size)
    ]
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    steps = 0
    while time.perf_counter() - started < seconds:
        _train_step(model, optimizer, experiences, arm=arm, gradient_clip_norm=5.0, device=torch.device("cuda"))
        steps += 1
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    profile = {
        "status": "PASS",
        "kind": "d20_task_shaped_cuda_smoke",
        "device": torch.cuda.get_device_name(0),
        "torch_version": torch.__version__,
        "seconds": elapsed,
        "batch_size": batch_size,
        "optimizer_steps": steps,
        "optimizer_steps_per_second": steps / elapsed,
        "peak_memory_mib": torch.cuda.max_memory_allocated() / (1024 * 1024),
        "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
    }
    if profile_output is not None:
        target = Path(profile_output)
        _write_new_json(target, profile)
    return profile


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--readiness", action="store_true")
    parser.add_argument("--gpu-smoke", action="store_true")
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--profile-output", type=Path)
    parser.add_argument("--run-formal", action="store_true")
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--calibration-report", type=Path)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--report-output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    selected = sum(bool(value) for value in (args.readiness, args.gpu_smoke, args.run_formal, args.verify))
    if selected != 1:
        raise SystemExit("select exactly one of --readiness, --gpu-smoke, --run-formal, or --verify")
    if args.readiness:
        payload = run_readiness(manifest_path=args.manifest)
    elif args.gpu_smoke:
        payload = run_gpu_smoke(
            manifest_path=args.manifest,
            seconds=args.seconds,
            batch_size=args.batch_size,
            profile_output=args.profile_output,
        )
    elif args.run_formal:
        if args.output_root is None:
            raise SystemExit("--run-formal requires --output-root")
        if args.calibration_report is None:
            raise SystemExit("D20-v2 --run-formal requires --calibration-report")
        payload = run_formal(
            output_root=args.output_root,
            manifest_path=args.manifest,
            device=args.device,
            calibration_report=args.calibration_report,
        )
    else:
        report, numeric = verify_run(args.verify, manifest_path=args.manifest)
        payload = {"verification": report, "canonical_numeric": numeric}
        if args.report_output is not None:
            _write_new_json(args.report_output, payload)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
