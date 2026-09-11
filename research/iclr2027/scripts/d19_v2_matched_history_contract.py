#!/usr/bin/env python3
"""Executable, CPU-safe tensor contract for the append-only D19-v2 plan.

This module defines the four feature gates and the single shared backbone used
by the D19-v2 preflight.  It deliberately contains no trainer, optimizer step,
self-play loop, checkpoint writer, or formal-result writer.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402
from lifeline_rl.core import GameSnapshot  # noqa: E402

try:  # Keep static manifest checks importable in a core-only environment.
    import torch
    from torch import Tensor, nn
except ImportError:  # pragma: no cover - exercised only without the train extra
    torch = None
    Tensor = Any
    nn = None


SCHEMA_NAME = "lifeline-d19-v2-matched-history-ablation-manifest"
SCHEMA_VERSION = 1
PROTOCOL_ID = "d19_v2_matched_history_ablation_protocol_20260901_v1"
EXPERIMENT_ID = "d19_v2_logical_edges_x_compact_history_candidate_v1"

BASE_NODE_FEATURES = 11
COMPACT_HISTORY_FEATURES = 1
MATCHED_NODE_FEATURES = BASE_NODE_FEATURES + COMPACT_HISTORY_FEATURES
RELATION_COUNT = 3
EXPECTED_TRAINABLE_PARAMETERS = 63_235

ARM_FEATURES: dict[str, tuple[bool, bool]] = {
    "edge0_history0": (False, False),
    "edge1_history0": (True, False),
    "edge0_history1": (False, True),
    "edge1_history1": (True, True),
}

SHARED_REFERENCE_FIELDS = {
    "backbone_ref": "matched_backbone_v1",
    "training_schedule_ref": "shared_training_schedule_v1",
    "evaluation_schedule_ref": "shared_evaluation_schedule_v1",
    "seed_schedule_ref": "shared_seed_schedule_v1",
    "optimizer_ref": "shared_adamw_v1",
    "search_ref": "shared_puct16_v1",
    "budget_ref": "shared_budget_v1",
}


class ContractError(ValueError):
    """Raised when D19-v2 could cease to be a matched four-arm comparison."""


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def read_json(path: str | Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ContractError(f"JSON root must be an object: {path}")
    return payload


def resolve_repo_path(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ContractError("bound paths must be non-empty strings")
    candidate = Path(raw_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ContractError(f"bound path must be repository-relative: {raw_path!r}")
    resolved = (REPO_ROOT / candidate).resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise ContractError(f"bound path escapes the repository: {raw_path!r}") from exc
    return resolved


def _require_exact_mapping(
    value: object,
    expected: Mapping[str, object],
    label: str,
) -> None:
    if not isinstance(value, Mapping) or dict(value) != dict(expected):
        raise ContractError(f"{label} differs from the frozen matched contract")


def validate_manifest(
    manifest: Mapping[str, Any],
    *,
    verify_source_bindings: bool = True,
) -> dict[str, Any]:
    """Fail closed on feature, schedule, parameter, or evidence drift."""

    if manifest.get("schema_name") != SCHEMA_NAME:
        raise ContractError("unexpected D19-v2 manifest schema")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ContractError("unsupported D19-v2 manifest schema version")
    if manifest.get("protocol_id") != PROTOCOL_ID:
        raise ContractError("D19-v2 protocol id drifted")
    if manifest.get("experiment_id") != EXPERIMENT_ID:
        raise ContractError("D19-v2 experiment id drifted")
    if manifest.get("status") != "preflight_only_not_authorized":
        raise ContractError("D19-v2 must remain preflight-only")

    relationship = manifest.get("relationship_to_frozen_d19_v1")
    expected_relationship = {
        "mode": "append_only_distinct_candidate",
        "frozen_experiment_id": "d19_logic_edge_archmatched_smoke_v1",
        "frozen_gate_status": "CLOSED",
        "supersedes_frozen_protocol": False,
        "imports_old_result": False,
    }
    _require_exact_mapping(
        relationship,
        expected_relationship,
        "relationship to frozen D19-v1",
    )

    execution = manifest.get("execution_boundary")
    expected_execution = {
        "training_authorized": False,
        "evaluation_authorized": False,
        "gpu_authorized": False,
        "formal_result_exists": False,
        "old_d19_result_reuse_allowed": False,
        "preflight_may_train": False,
        "preflight_may_step_optimizer": False,
        "preflight_may_run_self_play": False,
        "preflight_may_make_network_requests": False,
    }
    _require_exact_mapping(execution, expected_execution, "execution boundary")

    backbone = manifest.get("matched_backbone")
    if not isinstance(backbone, Mapping):
        raise ContractError("matched_backbone must be an object")
    expected_backbone = {
        "id": "matched_backbone_v1",
        "family": "relation_gnn_physical_own_opponent",
        "base_node_feature_width": BASE_NODE_FEATURES,
        "compact_history_feature_width": COMPACT_HISTORY_FEATURES,
        "input_node_feature_width": MATCHED_NODE_FEATURES,
        "relation_count": RELATION_COUNT,
        "hidden_channels": 64,
        "message_passing_layers": 3,
        "trainable_parameter_count_each_arm": EXPECTED_TRAINABLE_PARAMETERS,
        "parameter_count_rule": "EXACT_EQUAL_OR_REJECT",
        "state_dict_shape_rule": "EXACT_EQUAL_OR_REJECT",
        "initial_state_rule": "IDENTICAL_WITHIN_MATCHED_TRAINING_SEED",
    }
    _require_exact_mapping(backbone, expected_backbone, "matched backbone")

    compact = manifest.get("compact_history_feature")
    if not isinstance(compact, Mapping):
        raise ContractError("compact_history_feature must be an object")
    required_compact = {
        "id": "immediate_superko_membership_plane_v1",
        "feature_width_per_node": 1,
        "enabled_value": 1,
        "disabled_or_nonmatching_value": 0,
        "pass_feature": 0,
        "source": "complete_pre_action_GameSnapshot",
        "future_information_used": False,
        "legal_mask_replaced": False,
        "minimality_scope": (
            "one Boolean per point action, necessary and sufficient only for "
            "immediate Superko-membership status"
        ),
    }
    for key, expected in required_compact.items():
        if compact.get(key) != expected:
            raise ContractError(f"compact history contract drifted at {key}")

    arms = manifest.get("arms")
    if not isinstance(arms, list) or len(arms) != len(ARM_FEATURES):
        raise ContractError("D19-v2 requires exactly four arms")
    observed: dict[str, tuple[bool, bool]] = {}
    for row in arms:
        if not isinstance(row, Mapping):
            raise ContractError("each arm must be an object")
        allowed_keys = {
            "id",
            "logical_edges_enabled",
            "compact_history_enabled",
            *SHARED_REFERENCE_FIELDS,
        }
        if set(row) != allowed_keys:
            raise ContractError("arm fields must contain only gates and shared refs")
        arm_id = row.get("id")
        if not isinstance(arm_id, str) or arm_id in observed:
            raise ContractError("arm ids must be unique strings")
        feature_pair = (
            row.get("logical_edges_enabled"),
            row.get("compact_history_enabled"),
        )
        if not all(isinstance(value, bool) for value in feature_pair):
            raise ContractError("arm feature gates must be strict booleans")
        for key, expected in SHARED_REFERENCE_FIELDS.items():
            if row.get(key) != expected:
                raise ContractError(f"arm {arm_id} does not share {key}")
        observed[arm_id] = feature_pair
    if observed != ARM_FEATURES:
        raise ContractError("four arms do not form the declared 2x2 factorial")

    seeds = manifest.get("shared_seed_schedule")
    expected_seeds = {
        "id": "shared_seed_schedule_v1",
        "training_seeds": [20260825, 20260826, 20260827, 20260828, 20260829],
        "paired_across_arms": True,
        "counter_based_substreams_required": True,
        "arm_id_may_not_enter_seed_derivation": True,
    }
    _require_exact_mapping(seeds, expected_seeds, "seed schedule")

    training_schedule = manifest.get("shared_training_schedule")
    expected_training_schedule = {
        "id": "shared_training_schedule_v1",
        "mixed_size_order": "counter_based_shared_per_game",
        "same_initial_weights_within_training_seed": True,
        "same_iteration_game_update_indices_across_arms": True,
        "missing_seed_may_not_be_dropped": True,
    }
    _require_exact_mapping(
        training_schedule,
        expected_training_schedule,
        "training schedule",
    )

    optimizer = manifest.get("shared_optimizer")
    expected_optimizer = {
        "id": "shared_adamw_v1",
        "kind": "AdamW",
        "learning_rate": 0.001,
        "weight_decay": 0.0001,
        "betas": [0.9, 0.999],
        "epsilon": 1e-08,
        "amsgrad": False,
        "gradient_clip_norm": 5.0,
    }
    _require_exact_mapping(optimizer, expected_optimizer, "optimizer")

    search = manifest.get("shared_search")
    expected_search = {
        "id": "shared_puct16_v1",
        "kind": "PUCT",
        "simulations": 16,
        "c_puct": 1.5,
        "dirichlet_alpha": 0.3,
        "dirichlet_epsilon_self_play": 0.25,
        "dirichlet_epsilon_evaluation": 0.0,
        "temperature_moves": 20,
        "initial_temperature": 1.0,
        "final_temperature": 0.1,
    }
    _require_exact_mapping(search, expected_search, "search schedule")

    budget = manifest.get("shared_budget")
    expected_budget = {
        "id": "shared_budget_v1",
        "train_sizes": [5, 7, 9],
        "iterations": 10,
        "games_per_iteration": 10,
        "self_play_games_per_arm_seed": 100,
        "training_steps_per_iteration": 20,
        "gradient_steps_per_arm_seed": 200,
        "batch_size": 16,
        "replay_capacity": 10000,
        "max_plies": 256,
        "superko_mode": "enforce",
    }
    _require_exact_mapping(budget, expected_budget, "training budget")

    evaluation = manifest.get("shared_evaluation_schedule")
    if not isinstance(evaluation, Mapping):
        raise ContractError("shared_evaluation_schedule must be an object")
    required_evaluation = {
        "id": "shared_evaluation_schedule_v1",
        "eval_sizes": [9, 10, 12],
        "opponents": ["random", "uct_mcts_16"],
        "games_per_arm_seed_size_opponent": 200,
        "paired_color_pairs": 100,
        "temperature": 0.0,
        "root_noise": False,
        "fine_tuning": False,
        "same_opening_policy_color_seed_plan_across_arms": True,
        "primary_statistical_unit": "training_seed",
        "pooled_games_are_independent": False,
    }
    for key, expected in required_evaluation.items():
        if evaluation.get(key) != expected:
            raise ContractError(f"evaluation schedule drifted at {key}")
    _require_exact_mapping(
        evaluation.get("uct_mcts_16"),
        {
            "simulations": 16,
            "rollout_depth": 80,
            "exploration": 1.4142135623730951,
        },
        "UCT-MCTS-16 evaluation opponent",
    )

    _require_exact_mapping(
        manifest.get("planned_totals_not_authorized"),
        {
            "training_tasks": 20,
            "self_play_games": 2000,
            "gradient_steps": 4000,
            "evaluation_tasks": 120,
            "evaluation_games": 24000,
        },
        "planned totals",
    )
    _require_exact_mapping(
        manifest.get("factorial_contrasts"),
        {
            "logical_at_history0": "edge1_history0 - edge0_history0",
            "logical_at_history1": "edge1_history1 - edge0_history1",
            "history_at_edge0": "edge0_history1 - edge0_history0",
            "history_at_edge1": "edge1_history1 - edge1_history0",
            "interaction": (
                "edge1_history1 - edge1_history0 - edge0_history1 + edge0_history0"
            ),
            "interval": (
                "paired two-sided Student-t 95% interval across five training "
                "seeds, df=4"
            ),
            "stratify_by": ["eval_size", "opponent"],
        },
        "factorial contrasts",
    )

    witness_boundary = manifest.get("witness_boundary")
    expected_witness_boundary = {
        "candidate_path": (
            "research/iclr2027/results/validation/"
            "targeted_history_twin_n6_stage5_search_25k_v1.json"
        ),
        "candidate_sha256": (
            "4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5"
        ),
        "verification_path": (
            "research/iclr2027/results/validation/"
            "targeted_history_twin_n6_stage5_verification_v1.json"
        ),
        "verification_sha256": (
            "555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F"
        ),
        "candidate_action": [2, 3],
        "same_mask_free_topology": True,
        "same_implemented_observation_and_mask": False,
        "may_close_construct_validity_blocker": False,
    }
    _require_exact_mapping(
        witness_boundary,
        expected_witness_boundary,
        "witness boundary",
    )
    _require_exact_mapping(
        manifest.get("preflight_contract"),
        {
            "device": "cpu",
            "allowed": [
                "manifest and source hash validation",
                "complete-snapshot feature construction",
                "small mixed-size tensor construction",
                "model construction",
                "no-grad forward",
            ],
            "training_steps": 0,
            "optimizer_steps": 0,
            "self_play_games": 0,
            "evaluation_games": 0,
            "checkpoints": 0,
            "formal_results": 0,
            "gpu_operations": 0,
        },
        "preflight contract",
    )
    _require_exact_mapping(
        manifest.get("claim_boundary"),
        {
            "preflight_supports_tensor_contract_only": True,
            "learning_effect_claimed": False,
            "topology_history_superiority_claimed": False,
            "same_observation_mask_decision_witness_claimed": False,
            "construct_validity_blocker_status": "OPEN",
            "old_d19_gate_opened": False,
        },
        "claim boundary",
    )

    if verify_source_bindings:
        bindings = manifest.get("source_bindings")
        if not isinstance(bindings, list) or not bindings:
            raise ContractError("source bindings must be a non-empty list")
        seen_paths: set[str] = set()
        for binding in bindings:
            if not isinstance(binding, Mapping) or set(binding) != {"path", "sha256"}:
                raise ContractError("each source binding needs only path and sha256")
            raw_path = binding.get("path")
            expected_sha = binding.get("sha256")
            if not isinstance(raw_path, str) or raw_path in seen_paths:
                raise ContractError("source binding paths must be unique strings")
            if (
                not isinstance(expected_sha, str)
                or len(expected_sha) != 64
                or any(
                    character not in "0123456789ABCDEF" for character in expected_sha
                )
            ):
                raise ContractError(f"invalid SHA-256 for {raw_path}")
            path = resolve_repo_path(raw_path)
            if not path.is_file():
                raise ContractError(f"bound source is missing: {raw_path}")
            if sha256_file(path) != expected_sha:
                raise ContractError(f"bound source SHA-256 mismatch: {raw_path}")
            seen_paths.add(raw_path)
        expected_binding_paths = {
            "research/iclr2027/D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md",
            "research/iclr2027/lifeline_rl/core.py",
            "research/iclr2027/lifeline_rl/alphazero/network.py",
            "research/iclr2027/scripts/d19_v2_matched_history_contract.py",
            "research/iclr2027/scripts/verify_d19_v2_matched_history_preflight.py",
            (
                "research/iclr2027/results/validation/"
                "targeted_history_twin_n6_stage5_search_25k_v1.json"
            ),
            (
                "research/iclr2027/results/validation/"
                "targeted_history_twin_n6_stage5_verification_v1.json"
            ),
        }
        if seen_paths != expected_binding_paths:
            raise ContractError(
                "source binding path set differs from the frozen contract"
            )

    return {
        "arms": len(observed),
        "training_seeds": len(expected_seeds["training_seeds"]),
        "expected_parameter_count_each": EXPECTED_TRAINABLE_PARAMETERS,
        "training_authorized": False,
        "evaluation_authorized": False,
    }


def load_manifest(
    path: str | Path, *, verify_source_bindings: bool = True
) -> dict[str, Any]:
    manifest = read_json(path)
    validate_manifest(manifest, verify_source_bindings=verify_source_bindings)
    return manifest


def compact_history_plane_from_snapshot(
    grid_size: int,
    snapshot: GameSnapshot,
) -> tuple[float, ...]:
    """Return one pre-action Superko-membership bit for every point action.

    The rules engine restores the complete immutable snapshot, including the
    history set.  A bit is one exactly when the corresponding candidate move's
    resulting state key is already in that set.  Invalid local placements and
    PASS receive zero.  No reward, successor observation, opponent response,
    rollout, or later action is consulted.
    """

    game = LifelineGame(
        grid_size,
        start_player=snapshot.start_player,
        superko_mode=snapshot.superko_mode,
    )
    game.restore(snapshot)
    return tuple(
        float(game.evaluate_move(point).would_violate_superko)
        for point in game.valid_positions
    )


def compact_history_plane(game: LifelineGame) -> tuple[float, ...]:
    return compact_history_plane_from_snapshot(game.grid_size, game.clone())


def mask_free_topology(game: LifelineGame) -> tuple[Any, ...]:
    """Projection used only to re-check the bounded natural-history witness."""

    return (
        tuple(game.grid),
        tuple(sorted(game.edges[Player.BLACK])),
        tuple(sorted(game.edges[Player.WHITE])),
        game.current_player,
        game.consecutive_skips,
        game.game_over,
    )


def replay_actions(grid_size: int, actions: Sequence[object]) -> LifelineGame:
    game = LifelineGame(grid_size)
    normalized: list[tuple[int, int] | None] = []
    for action in actions:
        if action is None:
            normalized.append(None)
        elif (
            isinstance(action, list)
            and len(action) == 2
            and all(
                isinstance(value, int) and not isinstance(value, bool)
                for value in action
            )
        ):
            normalized.append((action[0], action[1]))
        else:
            raise ContractError(f"invalid persisted witness action: {action!r}")
    game.replay(normalized)
    return game


_ModuleBase = object if nn is None else nn.Module


class _MatchedRelationalBlock(_ModuleBase):
    def __init__(self, channels: int):
        if nn is None:  # pragma: no cover - guarded by CPU preflight
            raise ImportError("D19-v2 tensor preflight requires PyTorch")
        super().__init__()
        self.self_projection = nn.Linear(channels, channels)
        self.relation_projections = nn.ModuleList(
            nn.Linear(channels, channels, bias=False) for _ in range(RELATION_COUNT)
        )
        self.normalization = nn.LayerNorm(channels)

    def forward(self, hidden: Tensor, adjacency: Tensor, node_mask: Tensor) -> Tensor:
        update = self.self_projection(hidden)
        for relation, projection in enumerate(self.relation_projections):
            update = update + projection(torch.bmm(adjacency[:, relation], hidden))
        hidden = self.normalization(hidden + torch.relu(update))
        return hidden * node_mask.unsqueeze(-1)


class MatchedD19V2PolicyValueNetwork(_ModuleBase):
    """One backbone shared byte-for-byte by all four feature-gated arms."""

    def __init__(self, hidden_channels: int = 64, message_passing_layers: int = 3):
        if nn is None:  # pragma: no cover - guarded by CPU preflight
            raise ImportError("D19-v2 tensor preflight requires PyTorch")
        super().__init__()
        if hidden_channels != 64 or message_passing_layers != 3:
            raise ContractError("D19-v2 backbone width/depth drifted")
        self.hidden_channels = hidden_channels
        self.message_passing_layers = message_passing_layers
        self.input_projection = nn.Linear(MATCHED_NODE_FEATURES, hidden_channels)
        self.blocks = nn.ModuleList(
            _MatchedRelationalBlock(hidden_channels)
            for _ in range(message_passing_layers)
        )
        self.point_policy = nn.Sequential(
            nn.Linear(hidden_channels, hidden_channels),
            nn.ReLU(),
            nn.Linear(hidden_channels, 1),
        )
        self.pass_policy = nn.Sequential(
            nn.Linear(hidden_channels, hidden_channels),
            nn.ReLU(),
            nn.Linear(hidden_channels, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(hidden_channels, hidden_channels),
            nn.ReLU(),
            nn.Linear(hidden_channels, 1),
            nn.Tanh(),
        )

    def forward(
        self,
        node_features: Tensor,
        adjacency: Tensor,
        node_mask: Tensor,
        legal_action_mask: Tensor,
    ) -> tuple[Tensor, Tensor]:
        if node_features.ndim != 3 or node_features.shape[-1] != MATCHED_NODE_FEATURES:
            raise ContractError("D19-v2 node features must have width 12")
        batch, nodes, _ = node_features.shape
        if adjacency.shape != (batch, RELATION_COUNT, nodes, nodes):
            raise ContractError("D19-v2 relation tensor shape drifted")
        if node_mask.shape != (batch, nodes):
            raise ContractError("D19-v2 node mask shape drifted")
        if legal_action_mask.shape != (batch, nodes + 1):
            raise ContractError("D19-v2 legal mask shape drifted")
        if not bool(legal_action_mask.bool().any(dim=1).all()):
            raise ContractError("terminal/all-masked inputs are not preflight cases")

        mask = node_mask.to(dtype=node_features.dtype)
        hidden = torch.relu(self.input_projection(node_features)) * mask.unsqueeze(-1)
        for block in self.blocks:
            hidden = block(hidden, adjacency, mask)
        denominator = mask.sum(dim=1, keepdim=True).clamp_min(1.0)
        pooled = hidden.sum(dim=1) / denominator
        point_logits = self.point_policy(hidden).squeeze(-1)
        pass_logit = self.pass_policy(pooled)
        logits = torch.cat((point_logits, pass_logit), dim=1)
        logits = logits.masked_fill(
            ~legal_action_mask.bool(), torch.finfo(logits.dtype).min
        )
        value = self.value_head(pooled).squeeze(-1)
        return logits, value

    @property
    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())


def instantiate_matched_model(
    initialization_seed: int,
) -> MatchedD19V2PolicyValueNetwork:
    if torch is None:
        raise ImportError("D19-v2 tensor preflight requires PyTorch")
    if isinstance(initialization_seed, bool) or not isinstance(
        initialization_seed, int
    ):
        raise ContractError("initialization_seed must be a strict integer")
    with torch.random.fork_rng(devices=[]):
        torch.random.default_generator.manual_seed(initialization_seed)
        model = MatchedD19V2PolicyValueNetwork()
    if model.parameter_count != EXPECTED_TRAINABLE_PARAMETERS:
        raise ContractError(
            "D19-v2 exact parameter count mismatch: "
            f"{model.parameter_count} != {EXPECTED_TRAINABLE_PARAMETERS}"
        )
    return model


def model_state_sha256(model: MatchedD19V2PolicyValueNetwork) -> str:
    """Hash tensor names, dtypes, shapes, and bytes without serializing a file."""

    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        value = tensor.detach().cpu().contiguous()
        metadata = canonical_json(
            {"name": name, "dtype": str(value.dtype), "shape": list(value.shape)}
        )
        digest.update(metadata.encode("utf-8"))
        digest.update(value.numpy().tobytes(order="C"))
    return digest.hexdigest().upper()


def build_arm_batch(
    games: Sequence[LifelineGame],
    *,
    logical_edges_enabled: bool,
    compact_history_enabled: bool,
):
    """Collate one shape-identical CPU batch and apply only the two gates."""

    if torch is None:
        raise ImportError("D19-v2 tensor preflight requires PyTorch")
    if not games:
        raise ContractError("cannot build an empty D19-v2 batch")
    if not isinstance(logical_edges_enabled, bool) or not isinstance(
        compact_history_enabled, bool
    ):
        raise ContractError("D19-v2 feature gates must be strict booleans")

    from lifeline_rl.alphazero.network import TensorBatch, collate_positions

    base = collate_positions(games, "topology", device="cpu")
    adjacency = base.adjacency.clone()
    if not logical_edges_enabled:
        adjacency[:, 1:, :, :] = 0.0

    history = torch.zeros(
        base.node_features.shape[0],
        base.node_features.shape[1],
        COMPACT_HISTORY_FEATURES,
        dtype=base.node_features.dtype,
        device="cpu",
    )
    if compact_history_enabled:
        for row, game in enumerate(games):
            plane = compact_history_plane(game)
            history[row, : len(plane), 0] = torch.tensor(
                plane,
                dtype=base.node_features.dtype,
            )

    node_features = torch.cat((base.node_features, history), dim=-1)
    return TensorBatch(
        node_features=node_features,
        adjacency=adjacency,
        node_mask=base.node_mask.clone(),
        legal_action_mask=base.legal_action_mask.clone(),
        policy_targets=None,
        value_targets=None,
    )


__all__ = [
    "ARM_FEATURES",
    "BASE_NODE_FEATURES",
    "COMPACT_HISTORY_FEATURES",
    "ContractError",
    "EXPECTED_TRAINABLE_PARAMETERS",
    "EXPERIMENT_ID",
    "MATCHED_NODE_FEATURES",
    "MatchedD19V2PolicyValueNetwork",
    "PROTOCOL_ID",
    "RELATION_COUNT",
    "RESEARCH_ROOT",
    "SCHEMA_NAME",
    "SCHEMA_VERSION",
    "build_arm_batch",
    "canonical_json",
    "compact_history_plane",
    "compact_history_plane_from_snapshot",
    "instantiate_matched_model",
    "load_manifest",
    "mask_free_topology",
    "model_state_sha256",
    "read_json",
    "replay_actions",
    "resolve_repo_path",
    "sha256_file",
    "validate_manifest",
]
