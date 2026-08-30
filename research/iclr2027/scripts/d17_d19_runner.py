#!/usr/bin/env python3
"""Resumable D17--D19 evaluator, exact preflight, and AutoDL gates.

No command can mutate D14--D16 evidence.  ``prepare-bundle`` and ``run`` only
write into caller-supplied new D17--D19 directories; formal execution also
requires the explicit ``--confirm-formal`` lock.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import platform
import random
import shutil
import statistics
import sys
import tempfile
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

try:
    from d17_d19_experiments import (  # type: ignore
        BUNDLE_EXPERIMENT_ID,
        D16_V2_EXPERIMENT_ID,
        GEN_SIZE_EXPERIMENT_ID,
        ProtocolError,
        canonical_json,
        canonical_sha256,
        generate_tasks,
        load_manifest,
        load_task_bundle,
        manifest_hash,
        materialize_manifest,
        opening_prefix_hash,
        opening_state_hash,
        resolve_manifest_path,
        sha256_file,
        write_task_bundle,
    )
except ModuleNotFoundError:
    from scripts.d17_d19_experiments import (  # type: ignore
        BUNDLE_EXPERIMENT_ID,
        D16_V2_EXPERIMENT_ID,
        GEN_SIZE_EXPERIMENT_ID,
        ProtocolError,
        canonical_json,
        canonical_sha256,
        generate_tasks,
        load_manifest,
        load_task_bundle,
        manifest_hash,
        materialize_manifest,
        opening_prefix_hash,
        opening_state_hash,
        resolve_manifest_path,
        sha256_file,
        write_task_bundle,
    )


RUN_SCHEMA_NAME = "lifeline-d17-d19-execution"
RECEIPT_SCHEMA_NAME = "lifeline-d17-d19-receipt"
GAME_SCHEMA_NAME = "lifeline-d17-d19-game-record"
NUMERIC_SCHEMA_NAME = "lifeline-d17-d19-numeric-interface"
SCHEMA_VERSION = 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_text(path: Path, content: str, *, overwrite: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and path.exists():
        raise ProtocolError(f"refusing to overwrite immutable artifact: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if not overwrite and path.exists():
            raise ProtocolError(f"refusing to overwrite immutable artifact: {path}")
        os.replace(temporary, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def _atomic_json(
    path: Path, payload: Mapping[str, Any], *, overwrite: bool = True
) -> None:
    _atomic_text(
        path,
        json.dumps(
            payload,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n",
        overwrite=overwrite,
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"cannot read JSON artifact {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ProtocolError(f"JSON artifact must contain an object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ProtocolError(f"cannot read JSONL artifact {path}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(lines, start=1):
        if not line:
            raise ProtocolError(f"blank JSONL line at {path}:{number}")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ProtocolError(f"invalid JSONL line at {path}:{number}") from exc
        if not isinstance(value, dict):
            raise ProtocolError(f"JSONL line is not an object at {path}:{number}")
        rows.append(value)
    return rows


def _jsonl_text(rows: Iterable[Mapping[str, Any]]) -> str:
    return "".join(canonical_json(row) + "\n" for row in rows)


def _slug(value: str) -> str:
    safe = "".join(character if character.isalnum() or character in "._-" else "-" for character in value)
    return safe[:180].strip("-") or "task"


def _task_directory(run_root: Path, task_id: str) -> Path:
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return run_root / "tasks" / f"{_slug(task_id)}__{digest}"


def _checkpoint_rows(manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(item) for item in manifest["checkpoints"]]


def _resolve_checkpoint_paths(
    checkpoint: Mapping[str, Any], *, manifest_path: Path
) -> tuple[Path, Path]:
    checkpoint_path = resolve_manifest_path(
        str(checkpoint["path"]), manifest_path=manifest_path
    )
    config_path = resolve_manifest_path(
        str(checkpoint["config_path"]), manifest_path=manifest_path
    )
    return checkpoint_path, config_path


def _validate_checkpoint_files(
    checkpoint: Mapping[str, Any], *, manifest_path: Path
) -> tuple[Path, Path]:
    required = (
        "checkpoint_id",
        "model_kind",
        "path",
        "sha256",
        "config_path",
        "config_hash",
        "config_file_sha256",
        "source_hash",
        "source_receipt_path",
        "source_receipt_sha256",
    )
    missing = [field for field in required if field not in checkpoint]
    if missing:
        raise ProtocolError(
            "learned-checkpoint task binding is incomplete; missing "
            + ", ".join(missing)
        )
    for field in (
        "sha256",
        "config_hash",
        "config_file_sha256",
        "source_hash",
        "source_receipt_sha256",
    ):
        value = checkpoint[field]
        if (
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            raise ProtocolError(
                f"learned-checkpoint task binding has invalid {field}"
            )
    checkpoint_path, config_path = _resolve_checkpoint_paths(
        checkpoint, manifest_path=manifest_path
    )
    if not checkpoint_path.is_file():
        raise ProtocolError(f"checkpoint is missing: {checkpoint_path}")
    if not config_path.is_file():
        raise ProtocolError(f"checkpoint config is missing: {config_path}")
    if sha256_file(checkpoint_path) != checkpoint["sha256"]:
        raise ProtocolError(
            f"checkpoint SHA-256 mismatch: {checkpoint['checkpoint_id']}"
        )
    if sha256_file(config_path) != checkpoint["config_file_sha256"]:
        raise ProtocolError(
            f"checkpoint config-file SHA-256 mismatch: {checkpoint['checkpoint_id']}"
        )
    receipt_path = resolve_manifest_path(
        str(checkpoint["source_receipt_path"]), manifest_path=manifest_path
    )
    if not receipt_path.is_file():
        raise ProtocolError(f"source training receipt is missing: {receipt_path}")
    if sha256_file(receipt_path) != checkpoint["source_receipt_sha256"]:
        raise ProtocolError(
            f"source receipt SHA-256 mismatch: {checkpoint['checkpoint_id']}"
        )
    return checkpoint_path, config_path


def _validate_manifest_source_files(
    manifest: Mapping[str, Any], *, manifest_path: Path
) -> int:
    source_hashes = manifest.get("source_hashes")
    if not isinstance(source_hashes, Mapping) or not source_hashes:
        raise ProtocolError("manifest source_hashes are missing")
    verified = 0
    for raw_path, expected_sha in source_hashes.items():
        path = resolve_manifest_path(str(raw_path), manifest_path=manifest_path)
        if not path.is_file():
            raise ProtocolError(f"frozen source artifact is missing: {path}")
        if sha256_file(path) != expected_sha:
            raise ProtocolError(f"frozen source artifact SHA-256 mismatch: {path}")
        verified += 1
    return verified


def _search_config(manifest: Mapping[str, Any], arm_name: str):
    from lifeline_rl.alphazero.neural_agent import NeuralPUCTSearchConfig

    raw = manifest[arm_name]["learned_search"]
    if raw.get("add_root_noise") is not False:
        raise ProtocolError("formal learned search must disable root noise")
    return NeuralPUCTSearchConfig(
        simulations=int(raw["simulations"]),
        c_puct=float(raw["c_puct"]),
        temperature=float(raw["temperature"]),
    )


def _load_neural_agent(
    checkpoint: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    device: str,
    arm_name: str,
):
    from lifeline_rl.alphazero.neural_agent import NeuralPUCTAgent

    checkpoint_path, config_path = _validate_checkpoint_files(
        checkpoint, manifest_path=manifest_path
    )
    return NeuralPUCTAgent.from_checkpoint(
        checkpoint_path,
        config_path=config_path,
        device=device,
        search_config=_search_config(manifest, arm_name),
        label=str(checkpoint["checkpoint_id"]),
        expected_model_kind=str(checkpoint["model_kind"]),
        expected_config_hash=str(checkpoint["config_hash"]),
        expected_source_hash=str(checkpoint["source_hash"]),
        strict_source=True,
    )


def _apply_action_index(game: Any, action_index: int) -> None:
    if action_index == game.num_points:
        result = game.skip_turn()
    elif 0 <= action_index < game.num_points:
        result = game.play_move(game.valid_positions[action_index])
    else:
        raise ProtocolError(f"action index {action_index} is outside the action space")
    if not result.success:
        raise ProtocolError(f"persisted action {action_index} is illegal: {result.reason}")


def _game_from_opening(opening: Mapping[str, Any], size: int):
    from lifeline_rl import LifelineGame

    game = LifelineGame(size, superko_mode="enforce")
    actions = [int(value) for value in opening["opening_actions"]]
    for action in actions:
        if game.game_over:
            raise ProtocolError("opening prefix reaches a terminal state early")
        _apply_action_index(game, action)
    if game.game_over:
        raise ProtocolError("opening prefix is terminal")
    if opening_prefix_hash(actions) != opening["opening_prefix_hash"]:
        raise ProtocolError("opening prefix hash mismatch")
    if opening_state_hash(game) != opening["opening_state_hash"]:
        raise ProtocolError("opening full-state hash mismatch")
    return game


def _opening_by_size(materialized: Mapping[str, Any]) -> dict[int, dict[str, Any]]:
    entries = materialized["d16_v2"]["opening_prefixes"]
    result: dict[int, dict[str, Any]] = {}
    for entry in entries:
        result.setdefault(int(entry["eval_size"]), dict(entry))
    return result


def _task_shaped_learned_bindings(
    materialized: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Select one real formal task agent spec for every frozen checkpoint."""

    tasks = generate_tasks(materialized)
    if len(tasks) != 85:
        raise ProtocolError("task-shaped checkpoint audit requires the exact 85 tasks")
    checkpoint_rows = {
        str(checkpoint["checkpoint_id"]): dict(checkpoint)
        for checkpoint in _checkpoint_rows(materialized)
    }
    selected: dict[str, dict[str, Any]] = {}
    spec_hashes: dict[str, str] = {}
    for task in tasks:
        for slot in ("A", "B"):
            spec = dict(task["agent_specs"][slot])
            if spec.get("kind") != "learned_checkpoint":
                continue
            checkpoint_id = str(spec["checkpoint_id"])
            spec_hash = canonical_sha256(spec)
            previous_hash = spec_hashes.setdefault(checkpoint_id, spec_hash)
            if previous_hash != spec_hash:
                raise ProtocolError(
                    f"formal tasks disagree on checkpoint binding {checkpoint_id}"
                )
            arm_name = (
                "gen_size"
                if task["evaluation_kind"] == "gen_size"
                else "d16_v2"
            )
            candidate = {
                "task_id": task["task_id"],
                "task_runner_sha256": task["runner_sha256"],
                "slot": slot,
                "arm_name": arm_name,
                "spec": spec,
                "checkpoint": checkpoint_rows.get(checkpoint_id),
            }
            current = selected.get(checkpoint_id)
            # Grid/Topology checkpoints occur in both experiments.  Prefer the
            # GEN-SIZE task path, while Padded-CNN necessarily comes from D16-v2.
            if current is None or (
                current["arm_name"] != "gen_size" and arm_name == "gen_size"
            ):
                selected[checkpoint_id] = candidate
    if set(selected) != set(checkpoint_rows):
        missing = sorted(set(checkpoint_rows) - set(selected))
        raise ProtocolError(
            "formal task agent specs do not cover every checkpoint: "
            + ", ".join(missing)
        )
    ordered: list[dict[str, Any]] = []
    for checkpoint in _checkpoint_rows(materialized):
        row = selected[str(checkpoint["checkpoint_id"])]
        if row["checkpoint"] is None:
            raise ProtocolError("task-shaped checkpoint registry lookup failed")
        ordered.append(row)
    return ordered


def _undirected_edge_support(edges: Iterable[Sequence[int]]) -> set[tuple[int, int]]:
    return {
        (min(int(edge[0]), int(edge[1])), max(int(edge[0]), int(edge[1])))
        for edge in edges
    }


def _tensor_edge_support(adjacency: Any) -> set[tuple[int, int]]:
    nonzero = adjacency.detach().cpu().ne(0).nonzero(as_tuple=False).tolist()
    return {
        (min(int(first), int(second)), max(int(first), int(second)))
        for first, second in nonzero
        if int(first) != int(second)
    }


def _forward_case(
    agent: Any,
    *,
    checkpoint: Mapping[str, Any],
    size: int,
    opening: Mapping[str, Any] | None,
    fixture_kind: str = "readiness",
    run_puct: bool = False,
) -> dict[str, Any]:
    import torch

    from lifeline_rl import LifelineGame
    from lifeline_rl.encoding import encode_observation
    from lifeline_rl.alphazero.network import collate_positions

    game = LifelineGame(size, superko_mode="enforce") if opening is None else _game_from_opening(opening, size)
    before = game.clone()
    serialized = game.serialize_state()
    restored = LifelineGame.from_serialized_state(copy.deepcopy(serialized))
    if restored.clone() != before:
        raise ProtocolError("GameSnapshot/serialized-state round-trip is not lossless")
    if restored.canonical_state_json() != game.canonical_state_json():
        raise ProtocolError("canonical full-state JSON changed after round-trip")

    mode = str(agent.config.observation_mode)
    observation = encode_observation(game, mode)
    nodes = size * (size + 1) // 2
    pass_index = nodes
    legal = tuple(bool(value) for value in observation["legal_action_mask"])
    legal_points = set(game.legal_moves())
    expected_legal = tuple(point in legal_points for point in game.valid_positions) + (
        not game.game_over,
    )
    if legal != expected_legal:
        raise ProtocolError("encoded legal mask does not exactly match the environment")
    if game.num_points != nodes or len(legal) != nodes + 1:
        raise ProtocolError("size encoding/action count mismatch")
    if not legal[pass_index]:
        raise ProtocolError("PASS must be legal and occupy the last action index")
    batch = collate_positions([game], mode, device=agent.device)
    if tuple(batch.node_features.shape[:2]) != (1, nodes):
        raise ProtocolError("node feature shape does not encode the requested size")
    if tuple(batch.legal_action_mask.shape) != (1, nodes + 1):
        raise ProtocolError("collated legal-action mask has the wrong size")
    if int(batch.node_mask[0].sum().item()) != nodes:
        raise ProtocolError("node mask does not cover exactly the real board")
    if not bool(batch.legal_action_mask[0, pass_index].item()):
        raise ProtocolError("collated PASS bit is not at the final action index")
    if tuple(bool(value) for value in batch.legal_action_mask[0].tolist()) != legal:
        raise ProtocolError("collated legal mask differs point-by-point from the environment")

    physical_edges = _undirected_edge_support(game.physical_edges)
    own_edges = _undirected_edge_support(game.edges[game.current_player])
    opponent_edges = _undirected_edge_support(
        game.edges[LifelineGame.opponent(game.current_player)]
    )
    expected_relations = (
        (physical_edges, own_edges, opponent_edges)
        if mode == "topology"
        else (physical_edges, set(), set())
    )
    observed_relations = tuple(
        _tensor_edge_support(batch.adjacency[0, relation, :nodes, :nodes])
        for relation in range(3)
    )
    if observed_relations != expected_relations:
        raise ProtocolError("encoded physical/logical relation supports are incorrect")
    model_kind = str(checkpoint["model_kind"])
    relation_indices = tuple(getattr(agent.model, "_relation_indices", ()))
    if model_kind == "grid_gnn" and relation_indices != (0,):
        raise ProtocolError("Grid-GNN must consume only the physical-edge relation")
    if model_kind == "topology_gnn" and relation_indices != (0, 1, 2):
        raise ProtocolError("Topology-GNN must consume all three logical relations")
    agent.model.eval()
    with torch.no_grad():
        logits, values = agent.model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )
    if tuple(logits.shape) != (1, nodes + 1) or tuple(values.shape) != (1,):
        raise ProtocolError("policy/value forward shapes are incompatible")
    if not bool(torch.isfinite(values).all().item()):
        raise ProtocolError("value output must be finite")
    if not bool(torch.isfinite(logits[batch.legal_action_mask]).all().item()):
        raise ProtocolError("legal action logits must be finite")
    illegal = ~batch.legal_action_mask
    if bool(illegal.any().item()):
        floor = torch.finfo(logits.dtype).min
        if not bool((logits[illegal] == floor).all().item()):
            raise ProtocolError("illegal action logits must equal the dtype mask floor")
    priors = torch.softmax(logits, dim=1)
    if not bool(torch.isfinite(priors[batch.legal_action_mask]).all().item()):
        raise ProtocolError("legal action priors must be finite")
    if bool(illegal.any().item()) and not bool((priors[illegal] == 0).all().item()):
        raise ProtocolError("illegal action priors must be exactly zero")

    puct: dict[str, Any] | None = None
    if run_puct:
        if (
            int(agent.config.search.simulations) != 16
            or float(agent.config.search.temperature) != 0.0
            or int(agent._searcher.config.simulations) != 16
            or float(agent._searcher.config.dirichlet_epsilon) != 0.0
        ):
            raise ProtocolError("dry-run PUCT must be PUCT-16, temperature 0, no root noise")
        snapshot = game.clone()
        fixture_label = (
            "empty"
            if opening is None
            else str(opening.get("opening_id", opening.get("fixture_id", "fixture")))
        )
        policy_seed = int.from_bytes(
            hashlib.sha256(
                f"{checkpoint['checkpoint_id']}|{size}|{fixture_label}|dry-run-puct".encode(
                    "utf-8"
                )
            ).digest()[:8],
            "big",
        ) & ((1 << 63) - 1)
        result = agent.search(game, random.Random(policy_seed))
        if game.clone() != snapshot:
            raise ProtocolError("dry-run PUCT mutated its input state")
        if result.simulations != 16 or float(result.temperature) != 0.0:
            raise ProtocolError("dry-run PUCT result does not report the frozen budget")
        action_index, point = _search_action_index(game, result.action)
        if not legal[action_index]:
            raise ProtocolError("dry-run PUCT selected an illegal action")
        selected_once = _playable_game_copy(game)
        selected_replay = _playable_game_copy(game)
        _apply_action_index(selected_once, action_index)
        _apply_action_index(selected_replay, action_index)
        if selected_once.canonical_state_json() != selected_replay.canonical_state_json():
            raise ProtocolError("dry-run PUCT action is not exactly replayable")
        puct = {
            "simulations": result.simulations,
            "c_puct": float(agent.config.search.c_puct),
            "temperature": float(result.temperature),
            "add_root_noise": False,
            "dirichlet_epsilon": float(agent._searcher.config.dirichlet_epsilon),
            "policy_seed": policy_seed,
            "selected_action_index": action_index,
            "selected_point": point,
            "selected_action_legal": True,
            "input_state_unchanged": True,
            "action_replay_exact": True,
        }
    return {
        "checkpoint_id": checkpoint["checkpoint_id"],
        "model_kind": model_kind,
        "training_seed": checkpoint["training_seed"],
        "eval_size": size,
        "nodes": nodes,
        "action_count": nodes + 1,
        "pass_action_index": pass_index,
        "legal_actions": sum(legal),
        "fixture_kind": fixture_kind,
        "opening_id": (
            None
            if opening is None
            else opening.get("opening_id", opening.get("fixture_id"))
        ),
        "game_snapshot_roundtrip": True,
        "full_state_fields": [
            "grid",
            "black_edges",
            "white_edges",
            "current_player",
            "game_over",
            "consecutive_skips",
            "turn_count",
            "history_hashes",
            "superko_mode",
            "start_player",
        ],
        "node_mask_real_nodes": nodes,
        "padding_nodes": 0,
        "forward_policy_shape": list(logits.shape),
        "forward_value_shape": list(values.shape),
        "legal_mask_exact_environment_match": True,
        "relation_edge_counts": [len(edges) for edges in observed_relations],
        "model_relation_indices": list(relation_indices),
        "physical_and_logical_edge_support_exact": True,
        "illegal_prior_probability_zero": True,
        "legal_priors_and_value_finite": True,
        "puct": puct,
        "puct_checked": puct is not None,
        "status": "PASS",
    }


def _mixed_size_case(agent: Any, games: Sequence[Any]) -> dict[str, Any]:
    import torch

    from lifeline_rl.alphazero.network import collate_positions

    batch = collate_positions(
        games, str(agent.config.observation_mode), device=agent.device
    )
    max_nodes = max(game.num_points for game in games)
    expected_actions = max_nodes + 1
    if tuple(batch.legal_action_mask.shape) != (len(games), expected_actions):
        raise ProtocolError("mixed-size legal mask has the wrong padded shape")
    rows: list[dict[str, Any]] = []
    for index, game in enumerate(games):
        nodes = game.num_points
        if int(batch.node_mask[index].sum().item()) != nodes:
            raise ProtocolError("mixed-size node padding mask is incorrect")
        if not bool(batch.legal_action_mask[index, max_nodes].item()):
            raise ProtocolError("mixed-size PASS was not relocated to the shared last column")
        if nodes < max_nodes and bool(batch.legal_action_mask[index, nodes:max_nodes].any().item()):
            raise ProtocolError("mixed-size padding actions were marked legal")
        rows.append(
            {
                "eval_size": game.grid_size,
                "real_nodes": nodes,
                "padding_nodes": max_nodes - nodes,
                "native_pass_index": nodes,
                "batched_pass_index": max_nodes,
            }
        )
    agent.model.eval()
    with torch.no_grad():
        logits, values = agent.model(
            batch.node_features,
            batch.adjacency,
            batch.node_mask,
            batch.legal_action_mask,
        )
    if tuple(logits.shape) != (len(games), expected_actions):
        raise ProtocolError("mixed-size policy output shape is incorrect")
    if tuple(values.shape) != (len(games),):
        raise ProtocolError("mixed-size value output shape is incorrect")
    return {
        "sizes": [game.grid_size for game in games],
        "max_nodes": max_nodes,
        "batched_action_count": expected_actions,
        "rows": rows,
        "status": "PASS",
    }


def _validate_source_identity(checkpoints: Sequence[Mapping[str, Any]]) -> str:
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    current = AlphaZeroTrainer.current_source_hash()
    declared = {str(checkpoint["source_hash"]) for checkpoint in checkpoints}
    if declared != {current}:
        raise ProtocolError(
            "frozen checkpoint source hash does not match the current read-only AlphaZero source"
        )
    return current


def _exact_dry_run_fixture_plan(
    manifest: Mapping[str, Any],
    materialized: Mapping[str, Any],
    checkpoints: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Expand the frozen 20 GEN + 45 D16 cells into exactly 195 fixtures."""

    dry_run_contract = manifest["dry_run"]
    gen_fixtures_by_size: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for raw_fixture in dry_run_contract["gen_size_state_fixtures"]:
        fixture = dict(raw_fixture)
        gen_fixtures_by_size[int(fixture["eval_size"])].append(fixture)
    cluster_indices = [
        int(value)
        for value in dry_run_contract["d16_v2_opening_fixture_cluster_indices"]
    ]
    opening_registry = [
        dict(item) for item in materialized["d16_v2"]["opening_prefixes"]
    ]
    d16_fixtures_by_size: dict[int, list[dict[str, Any]]] = {}
    for size in (5, 7, 9):
        by_cluster = {
            str(item["opening_cluster"]): item
            for item in opening_registry
            if int(item["eval_size"]) == size
        }
        selected = []
        for cluster_index in cluster_indices:
            cluster_id = f"n{size}_c{cluster_index:02d}"
            if cluster_id not in by_cluster:
                raise ProtocolError(f"dry-run opening cluster is missing: {cluster_id}")
            selected.append(by_cluster[cluster_id])
        d16_fixtures_by_size[size] = selected

    plan: list[dict[str, Any]] = []
    for checkpoint in checkpoints:
        for size in (5, 7, 9):
            for opening in d16_fixtures_by_size[size]:
                plan.append(
                    {
                        "checkpoint_id": checkpoint["checkpoint_id"],
                        "size": size,
                        "opening": opening,
                        "fixture_kind": "d16_v2_registered_opening",
                    }
                )
        if checkpoint["model_kind"] in {"grid_gnn", "topology_gnn"}:
            for size in (10, 12):
                for opening in gen_fixtures_by_size[size]:
                    plan.append(
                        {
                            "checkpoint_id": checkpoint["checkpoint_id"],
                            "size": size,
                            "opening": opening,
                            "fixture_kind": "gen_size_registered_state",
                        }
                    )
    counts = Counter(row["fixture_kind"] for row in plan)
    if counts != Counter(
        {"gen_size_registered_state": 60, "d16_v2_registered_opening": 135}
    ):
        raise ProtocolError(f"dry-run fixture plan is not exactly 60+135: {counts}")
    return plan


def exact_dry_run(
    manifest: Mapping[str, Any], *, manifest_path: Path
) -> dict[str, Any]:
    """Run the frozen 65-cell x three-fixture CPU forward/PUCT matrix."""

    import torch

    from lifeline_rl import LifelineGame, make_agent

    started = time.perf_counter()
    materialized = materialize_manifest(manifest)
    checkpoints = _checkpoint_rows(manifest)
    task_bindings = _task_shaped_learned_bindings(materialized)
    task_binding_by_checkpoint = {
        str(row["spec"]["checkpoint_id"]): row for row in task_bindings
    }
    source_hash = _validate_source_identity(checkpoints)
    opening_examples = _opening_by_size(materialized)
    fixture_plan = _exact_dry_run_fixture_plan(manifest, materialized, checkpoints)
    cases: list[dict[str, Any]] = []
    mixed_cases: list[dict[str, Any]] = []
    checkpoint_audits: list[dict[str, Any]] = []
    agent_cache: dict[tuple[str, str], Any] = {}

    for checkpoint in checkpoints:
        task_binding = task_binding_by_checkpoint[str(checkpoint["checkpoint_id"])]
        spec = task_binding["spec"]
        checkpoint_path, config_path = _resolve_checkpoint_paths(
            spec, manifest_path=manifest_path
        )
        model_kind = str(checkpoint["model_kind"])
        arm_name = str(task_binding["arm_name"])
        agent = _build_agent_from_spec(
            spec,
            manifest=manifest,
            manifest_path=manifest_path,
            device="cpu",
            arm_name=arm_name,
            cache=agent_cache,
        )
        for fixture in fixture_plan:
            if fixture["checkpoint_id"] != checkpoint["checkpoint_id"]:
                continue
            cases.append(
                _forward_case(
                    agent,
                    checkpoint=checkpoint,
                    size=int(fixture["size"]),
                    opening=fixture["opening"],
                    fixture_kind=str(fixture["fixture_kind"]),
                    run_puct=True,
                )
            )
        games = [
            _game_from_opening(opening_examples[size], size)
            for size in (5, 7, 9)
        ]
        if model_kind in {"grid_gnn", "topology_gnn"}:
            games.extend([LifelineGame(10), LifelineGame(12)])
        mixed = _mixed_size_case(agent, games)
        mixed["checkpoint_id"] = checkpoint["checkpoint_id"]
        mixed["model_kind"] = model_kind
        mixed_cases.append(mixed)
        identity = agent.checkpoint_identity
        if (
            identity.sha256 != checkpoint["sha256"]
            or identity.config_hash != checkpoint["config_hash"]
            or identity.source_hash != checkpoint["source_hash"]
            or identity.gradient_steps != 200
            or tuple(agent.config.trained_board_sizes) != (5, 7, 9)
        ):
            raise ProtocolError("loaded checkpoint identity does not match the frozen manifest")
        checkpoint_audits.append(
            {
                "checkpoint_id": checkpoint["checkpoint_id"],
                "task_id": task_binding["task_id"],
                "task_agent_slot": task_binding["slot"],
                "task_agent_spec_sha256": canonical_sha256(spec),
                "model_kind": model_kind,
                "training_seed": checkpoint["training_seed"],
                "checkpoint_path": str(checkpoint_path),
                "checkpoint_sha256": identity.sha256,
                "config_path": str(config_path),
                "config_hash": identity.config_hash,
                "config_file_sha256": checkpoint["config_file_sha256"],
                "source_hash": identity.source_hash,
                "source_receipt_path": str(
                    resolve_manifest_path(
                        str(spec["source_receipt_path"]),
                        manifest_path=manifest_path,
                    )
                ),
                "source_receipt_sha256": spec["source_receipt_sha256"],
                "gradient_steps": identity.gradient_steps,
                "trained_board_sizes": list(agent.config.trained_board_sizes),
                "parameter_count": agent.config.parameter_count,
                "fine_tuning_performed": False,
                "status": "PASS",
            }
        )
        del agent

    # Exercise both frozen non-learning interfaces on a real unseen-size state.
    opponent_checks: list[dict[str, Any]] = []
    for opponent in manifest["gen_size"]["opponents"]:
        config = opponent["config"]
        options: dict[str, Any] = {}
        if opponent["agent_kind"] == "mcts":
            options = {
                "mcts_simulations": int(config["simulations"]),
                "mcts_rollout_depth": int(config["rollout_depth"]),
                "mcts_exploration": float(config["exploration"]),
            }
        baseline = make_agent(str(opponent["agent_kind"]), **options)
        game = LifelineGame(10)
        snapshot = game.clone()
        action = baseline.select_action(game, random.Random(20260829))
        if game.clone() != snapshot:
            raise ProtocolError("frozen opponent mutated the dry-run state")
        if action is not None and action not in game.legal_moves():
            raise ProtocolError("frozen opponent returned an illegal action")
        opponent_checks.append(
            {
                "opponent": opponent["id"],
                "agent_kind": opponent["agent_kind"],
                "config": config,
                "returned_pass": action is None,
                "state_unchanged": True,
                "status": "PASS",
            }
        )

    duration = time.perf_counter() - started
    runner_path = Path(__file__).resolve()
    experiments_path = runner_path.with_name("d17_d19_experiments.py")
    source_files_verified = _validate_manifest_source_files(
        manifest, manifest_path=manifest_path
    )
    protocol_path = resolve_manifest_path(
        str(manifest["protocol_path"]), manifest_path=manifest_path
    )
    if sha256_file(protocol_path) != manifest["protocol_sha256"]:
        raise ProtocolError("execution protocol SHA-256 mismatch")
    return {
        "schema_name": "lifeline-d17-d19-exact-dry-run",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "formal_tasks_executed": 0,
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "materialized_manifest_sha256": manifest_hash(materialized),
        "device": "cpu",
        "torch_version": torch.__version__,
        "duration_seconds": duration,
        "checkpoint_count": len(checkpoint_audits),
        "task_shaped_checkpoint_bindings": len(task_bindings),
        "checkpoint_target_size_cells": 65,
        "expected_checkpoint_target_size_cells": 65,
        "checkpoint_target_size_forward_cases": len(cases),
        "expected_checkpoint_target_size_forward_cases": 195,
        "fixture_forward_puct_checks": len(cases),
        "expected_fixture_forward_puct_checks": 195,
        "gen_size_fixture_forward_puct_checks": sum(
            case["fixture_kind"] == "gen_size_registered_state" for case in cases
        ),
        "d16_v2_fixture_forward_puct_checks": sum(
            case["fixture_kind"] == "d16_v2_registered_opening" for case in cases
        ),
        "checkpoints": checkpoint_audits,
        "forward_cases": cases,
        "mixed_size_padding_cases": mixed_cases,
        "opponent_checks": opponent_checks,
        "opening_registry": {
            "count": len(materialized["d16_v2"]["opening_prefixes"]),
            "all_explicit": True,
            "all_legal_nonterminal": True,
            "full_state_hashes_verified": True,
        },
        "source_hash": source_hash,
        "protocol_path": str(protocol_path),
        "protocol_sha256": manifest["protocol_sha256"],
        "source_files_verified": source_files_verified,
        "runner_sha256": sha256_file(runner_path),
        "experiments_sha256": sha256_file(experiments_path),
        "checks": {
            "checkpoint_bytes": True,
            "checkpoint_config_bytes": True,
            "checkpoint_config_hash": True,
            "checkpoint_source_hash": True,
            "task_shaped_agent_specs": len(task_bindings) == 15,
            "source_training_receipt_sha256": True,
            "trained_sizes_5_7_9": True,
            "no_fine_tuning": True,
            "legal_action_mask": True,
            "legal_action_mask_pointwise_environment_match": True,
            "pass_last_native_and_padded": True,
            "size_node_padding_encoding": True,
            "grid_physical_only_topology_full_logical_relations": True,
            "illegal_priors_zero_legal_priors_value_finite": True,
            "puct_16_temperature_zero_no_root_noise_195_of_195": (
                len(cases) == 195 and all(case["puct_checked"] for case in cases)
            ),
            "game_snapshot_full_state_roundtrip": True,
            "d16_v2_opening_manifest": True,
            "random_and_uct_mcts_16_interfaces": True,
        },
        "completed_at_utc": _utc_now(),
    }


def readiness(
    manifest: Mapping[str, Any], *, manifest_path: Path
) -> dict[str, Any]:
    """Task-shaped local CPU gate: real checkpoint, opening, parse, shape, forward."""

    import torch

    started = time.perf_counter()
    materialized = materialize_manifest(manifest)
    openings = _opening_by_size(materialized)
    checkpoints = _checkpoint_rows(manifest)
    task_bindings = _task_shaped_learned_bindings(materialized)
    _validate_source_identity(checkpoints)
    source_files_verified = _validate_manifest_source_files(
        manifest, manifest_path=manifest_path
    )
    selected: list[Mapping[str, Any]] = []
    for model_kind in ("padded_cnn", "grid_gnn", "topology_gnn"):
        selected.append(
            next(
                binding
                for binding in task_bindings
                if binding["spec"]["model_kind"] == model_kind
                and binding["spec"]["training_seed"] == 20260825
            )
        )
    cases: list[dict[str, Any]] = []
    agent_cache: dict[tuple[str, str], Any] = {}
    for task_binding in selected:
        spec = task_binding["spec"]
        checkpoint = task_binding["checkpoint"]
        arm_name = str(task_binding["arm_name"])
        agent = _build_agent_from_spec(
            spec,
            manifest=manifest,
            manifest_path=manifest_path,
            device="cpu",
            arm_name=arm_name,
            cache=agent_cache,
        )
        size = 10 if arm_name == "gen_size" else 5
        opening = None if size == 10 else openings[5]
        case = _forward_case(
            agent,
            checkpoint=checkpoint,
            size=size,
            opening=opening,
        )
        case.update(
            {
                "task_id": task_binding["task_id"],
                "task_agent_slot": task_binding["slot"],
                "task_agent_spec_sha256": canonical_sha256(spec),
                "source_receipt_path": str(
                    resolve_manifest_path(
                        str(spec["source_receipt_path"]),
                        manifest_path=manifest_path,
                    )
                ),
                "source_receipt_sha256": spec["source_receipt_sha256"],
            }
        )
        cases.append(case)
    duration = time.perf_counter() - started
    runner_path = Path(__file__).resolve()
    return {
        "schema_name": "lifeline-d17-d19-readiness",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "protocol_sha256": manifest["protocol_sha256"],
        "source_files_verified": source_files_verified,
        "device": "cpu",
        "torch_version": torch.__version__,
        "runner_sha256": sha256_file(runner_path),
        "experiments_sha256": sha256_file(
            runner_path.with_name("d17_d19_experiments.py")
        ),
        "real_opening_sample": openings[5]["opening_id"],
        "model_kinds_built": [case["model_kind"] for case in cases],
        "task_shaped_agent_specs_verified": len(cases),
        "source_receipts_verified": len(cases),
        "forward_cases": cases,
        "duration_seconds": duration,
        "formal_tasks_executed": 0,
        "completed_at_utc": _utc_now(),
    }


def _baseline_agent(spec: Mapping[str, Any]):
    from lifeline_rl import make_agent

    kind = str(spec["agent_kind"])
    config = dict(spec.get("config", {}))
    options: dict[str, Any] = {}
    if kind == "mcts":
        options = {
            "mcts_simulations": int(config["simulations"]),
            "mcts_rollout_depth": int(config.get("rollout_depth", 80)),
            "mcts_exploration": float(config.get("exploration", math.sqrt(2.0))),
        }
    return make_agent(kind, **options)


def _build_agent_from_spec(
    spec: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    device: str,
    arm_name: str,
    cache: dict[tuple[str, str], Any],
):
    if spec["kind"] == "search_baseline":
        key = (f"baseline:{canonical_sha256(spec)}", device)
        if key not in cache:
            cache[key] = _baseline_agent(spec)
        return cache[key]
    if spec["kind"] != "learned_checkpoint":
        raise ProtocolError(f"unsupported agent kind {spec['kind']!r}")
    key = (str(spec["checkpoint_id"]), device)
    if key not in cache:
        cache[key] = _load_neural_agent(
            spec,
            manifest=manifest,
            manifest_path=manifest_path,
            device=device,
            arm_name=arm_name,
        )
    return cache[key]


def _compact_diagnostics(agent: Any, *, phase: str) -> dict[str, Any]:
    raw = dict(agent.diagnostics())
    keep = (
        "algorithm",
        "model_kind",
        "checkpoint_sha256",
        "simulations",
        "temperature",
        "root_player",
        "selected_action",
        "selected_visits",
        "selected_prior",
        "selected_q",
        "root_visit_sum",
        "train_superko_mode",
        "eval_superko_mode",
        "superko_mode_override",
    )
    compact = {name: raw[name] for name in keep if name in raw}
    compact["phase"] = phase
    return compact


def _policy_action(game: Any, action: Any) -> tuple[int, list[int] | None]:
    if action is None:
        return game.num_points, None
    if action not in game.point_to_index:
        raise ProtocolError(f"agent returned an invalid point: {action!r}")
    return game.point_to_index[action], [int(action[0]), int(action[1])]


def _search_action_index(game: Any, action: Any) -> tuple[int, list[int] | None]:
    """Normalize the dependency-free PUCT result, whose action is an index."""

    if isinstance(action, bool) or not isinstance(action, int):
        raise ProtocolError(f"PUCT returned a non-integer action index: {action!r}")
    if not 0 <= action <= game.num_points:
        raise ProtocolError(f"PUCT returned an out-of-range action index: {action}")
    if action == game.num_points:
        return action, None
    point = game.valid_positions[action]
    return action, [int(point[0]), int(point[1])]


def _playable_game_copy(game: Any):
    """Round-trip the full state into an independently playable game."""

    from lifeline_rl import LifelineGame

    return LifelineGame.from_serialized_state(copy.deepcopy(game.serialize_state()))


def _play_manifest_game(
    schedule: Mapping[str, Any], *, agent_a: Any, agent_b: Any
) -> dict[str, Any]:
    """Play one pre-registered game, including its prefix in the replay log."""

    from lifeline_rl import LifelineGame, Player

    size = int(schedule["eval_size"])
    game = LifelineGame(size, superko_mode=str(schedule["superko_mode"]))
    actions: list[dict[str, Any]] = []
    for action_index in schedule["opening_actions"]:
        if game.game_over:
            raise ProtocolError("opening prefix becomes terminal before completion")
        actor = game.current_player
        action_index = int(action_index)
        point = None if action_index == game.num_points else game.valid_positions[action_index]
        _apply_action_index(game, action_index)
        actions.append(
            {
                "ply": len(actions),
                "actor": actor.value,
                "action": action_index,
                "point": None if point is None else [int(point[0]), int(point[1])],
                "decision_seconds": 0.0,
                "diagnostics": {
                    "phase": "opening_prefix",
                    "opening_id": schedule["opening_id"],
                    "opening_cluster": schedule["opening_cluster"],
                    "opening_prefix_hash": schedule["opening_prefix_hash"],
                },
            }
        )
    if game.game_over or opening_state_hash(game) != schedule["opening_state_hash"]:
        raise ProtocolError("materialized opening does not restore its bound nonterminal state")

    agents = {
        "A": agent_a,
        "B": agent_b,
    }
    color_slots = {
        Player.BLACK: str(schedule["black_slot"]),
        Player.WHITE: str(schedule["white_slot"]),
    }
    policy_rng = {
        Player.BLACK: random.Random(int(schedule["black_policy_seed"])),
        Player.WHITE: random.Random(int(schedule["white_policy_seed"])),
    }
    max_plies = int(schedule["max_plies"])
    started = time.perf_counter()
    while not game.game_over and len(actions) < max_plies:
        actor = game.current_player
        slot = color_slots[actor]
        agent = agents[slot]
        snapshot = game.clone()
        decision_started = time.perf_counter()
        action = agent.select_action(game, policy_rng[actor])
        decision_seconds = time.perf_counter() - decision_started
        if game.clone() != snapshot:
            raise ProtocolError(f"agent {agent.name!r} mutated the arena state")
        action_index, point = _policy_action(game, action)
        _apply_action_index(game, action_index)
        actions.append(
            {
                "ply": len(actions),
                "actor": actor.value,
                "action": action_index,
                "point": point,
                "decision_seconds": decision_seconds,
                "diagnostics": _compact_diagnostics(agent, phase="evaluation"),
            }
        )
    duration = time.perf_counter() - started
    truncated = not game.game_over
    winner = None if truncated else game.winner()
    winner_value = winner.value if isinstance(winner, Player) else winner
    territories = None
    if game.game_over:
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
    prefix_length = len(schedule["opening_actions"])
    all_action_indices = [int(entry["action"]) for entry in actions]
    continuation = all_action_indices[prefix_length:]
    primary_key = {
        "eval_size": size,
        "opening_actions": [int(value) for value in schedule["opening_actions"]],
        "continuation_actions": continuation,
    }
    bound_key = {
        **primary_key,
        "black_slot": schedule["black_slot"],
        "white_slot": schedule["white_slot"],
    }
    record = dict(schedule)
    record.update(
        {
            "schema_name": GAME_SCHEMA_NAME,
            "schema_version": SCHEMA_VERSION,
            "grid_size": size,
            "superko_mode": schedule["superko_mode"],
            "seed": int.from_bytes(
                hashlib.sha256(str(schedule["pair_id"]).encode("utf-8")).digest()[:8],
                "big",
            )
            & ((1 << 63) - 1),
            "black_agent": agent_a.name
            if schedule["black_slot"] == "A"
            else agent_b.name,
            "white_agent": agent_a.name
            if schedule["white_slot"] == "A"
            else agent_b.name,
            "winner": winner_value,
            "truncated": truncated,
            "plies": len(actions),
            "continuation_plies": len(continuation),
            "duration_seconds": duration,
            "territories": territories,
            "actions": actions,
            # Formal diversity keys ignore color-slot labels.  The bound audit
            # key additionally includes slots, as requested for identity QA.
            "action_trajectory_hash": canonical_sha256(primary_key),
            "continuation_trajectory_hash": canonical_sha256(continuation),
            "complete_bound_trajectory_hash": canonical_sha256(bound_key),
            "final_state_hash": opening_state_hash(game),
        }
    )
    return record


def _validate_game_record(
    record: Mapping[str, Any], schedule: Mapping[str, Any]
) -> None:
    from lifeline_rl import replay_game_record

    identity_fields = (
        "experiment_id",
        "experiment_arm",
        "evidence_tier",
        "manifest_sha256",
        "materialized_manifest_sha256",
        "protocol_sha256",
        "runner_sha256",
        "task_id",
        "evaluation_kind",
        "inference_group_id",
        "game_id",
        "game_index",
        "pair_id",
        "pair_index",
        "pair_member",
        "pair_color_orientation",
        "color_swap",
        "black_slot",
        "white_slot",
        "training_seed",
        "checkpoint_id",
        "checkpoint_sha256",
        "config_hash",
        "source_hash",
        "checkpoint_bindings",
        "eval_size",
        "opponent",
        "model_pair",
        "opening_cluster",
        "opening_id",
        "opening_seed",
        "opening_actions",
        "opening_prefix_hash",
        "opening_state_hash",
        "prefix_plies",
        "policy_seed_block",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
        "black_policy_seed",
        "white_policy_seed",
        "max_plies",
        "superko_mode",
        "source_hashes",
    )
    for field in identity_fields:
        if record.get(field) != schedule.get(field):
            raise ProtocolError(
                f"{schedule['game_id']}: game record identity mismatch for {field}"
            )
    if record.get("schema_name") != GAME_SCHEMA_NAME or record.get(
        "schema_version"
    ) != SCHEMA_VERSION:
        raise ProtocolError(f"{schedule['game_id']}: game record schema mismatch")
    actions = record.get("actions")
    if not isinstance(actions, list) or record.get("plies") != len(actions):
        raise ProtocolError(f"{schedule['game_id']}: action log length mismatch")
    prefix = [int(value) for value in schedule["opening_actions"]]
    observed_prefix = [int(entry["action"]) for entry in actions[: len(prefix)]]
    if observed_prefix != prefix:
        raise ProtocolError(f"{schedule['game_id']}: replay prefix differs from manifest")
    continuation = [int(entry["action"]) for entry in actions[len(prefix) :]]
    primary_key = {
        "eval_size": int(schedule["eval_size"]),
        "opening_actions": prefix,
        "continuation_actions": continuation,
    }
    bound_key = {
        **primary_key,
        "black_slot": schedule["black_slot"],
        "white_slot": schedule["white_slot"],
    }
    if record.get("action_trajectory_hash") != canonical_sha256(primary_key):
        raise ProtocolError(f"{schedule['game_id']}: action trajectory hash mismatch")
    if record.get("continuation_trajectory_hash") != canonical_sha256(continuation):
        raise ProtocolError(
            f"{schedule['game_id']}: continuation trajectory hash mismatch"
        )
    if record.get("complete_bound_trajectory_hash") != canonical_sha256(bound_key):
        raise ProtocolError(f"{schedule['game_id']}: bound trajectory hash mismatch")
    replayed = replay_game_record(dict(record))
    if opening_state_hash(replayed) != record.get("final_state_hash"):
        raise ProtocolError(f"{schedule['game_id']}: final full-state hash mismatch")


def _validate_pair(
    pair_payload: Mapping[str, Any], schedules: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    if len(schedules) != 2:
        raise ProtocolError("a color pair must contain exactly two scheduled games")
    records = pair_payload.get("games")
    if not isinstance(records, list) or len(records) != 2:
        raise ProtocolError("persisted pair must contain exactly two game records")
    ordered_schedules = sorted(schedules, key=lambda item: int(item["pair_member"]))
    ordered_records = sorted(records, key=lambda item: int(item["pair_member"]))
    for record, schedule in zip(ordered_records, ordered_schedules):
        _validate_game_record(record, schedule)
    first, second = ordered_records
    if (
        first["pair_member"] != 0
        or second["pair_member"] != 1
        or first["black_slot"] != "A"
        or first["white_slot"] != "B"
        or second["black_slot"] != "B"
        or second["white_slot"] != "A"
    ):
        raise ProtocolError("persisted pair does not implement the frozen A/B color swap")
    invariant_fields = (
        "pair_id",
        "opening_cluster",
        "opening_id",
        "opening_actions",
        "opening_prefix_hash",
        "opening_state_hash",
        "training_seed",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
    )
    for field in invariant_fields:
        if first[field] != second[field]:
            raise ProtocolError(f"color pair changed frozen field {field}")
    return ordered_records


def _task_counts(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    wins = losses = draws = truncated = 0
    for record in records:
        if bool(record["truncated"]):
            truncated += 1
            continue
        if record["winner"] == "DRAW":
            draws += 1
            continue
        a_color = "BLACK" if record["black_slot"] == "A" else "WHITE"
        if record["winner"] == a_color:
            wins += 1
        else:
            losses += 1
    primary_hashes = {str(record["action_trajectory_hash"]) for record in records}
    continuation_hashes = {
        str(record["continuation_trajectory_hash"]) for record in records
    }
    bound_hashes = {
        str(record["complete_bound_trajectory_hash"]) for record in records
    }
    cluster_continuations: dict[str, set[str]] = defaultdict(set)
    for record in records:
        cluster_continuations[str(record["opening_cluster"])].add(
            str(record["continuation_trajectory_hash"])
        )
    clusters_with_two = sum(
        len(values) >= 2 for values in cluster_continuations.values()
    )
    return {
        "games_requested": len(records),
        "games_completed": len(records) - truncated,
        "truncated_games": truncated,
        "a_wins": wins,
        "a_losses": losses,
        "draws": draws,
        "replay_verified_games": len(records),
        # Formal key ignores black/white slot labels; color swap cannot
        # mechanically inflate it when the action sequence is unchanged.
        "unique_action_trajectories": len(primary_hashes),
        "unique_prefix_stripped_continuations": len(continuation_hashes),
        "unique_bound_trajectories_with_slots": len(bound_hashes),
        "opening_clusters": len(cluster_continuations),
        "clusters_with_two_unique_continuations": clusters_with_two,
    }


def _formal_gate(task: Mapping[str, Any], counts: Mapping[str, Any]) -> dict[str, Any]:
    gates = task["formal_gates"]
    checks = {
        "exact_game_count": counts["games_requested"] == task["games"],
        "all_games_completed": counts["games_completed"] == task["games"],
        "zero_truncations": counts["truncated_games"] == 0,
        "all_games_replay_verified": counts["replay_verified_games"] == task["games"],
        "minimum_unique_action_trajectories": (
            counts["unique_action_trajectories"]
            >= int(gates["min_unique_trajectories"])
        ),
    }
    if task["evaluation_kind"] == "d16_v2":
        checks.update(
            {
                "exact_opening_cluster_count": counts["opening_clusters"]
                == int(gates["opening_clusters"]),
                "minimum_unique_prefix_stripped_continuations": (
                    counts["unique_prefix_stripped_continuations"]
                    >= int(gates["min_unique_prefix_stripped_continuations"])
                ),
                "minimum_clusters_with_two_continuations": (
                    counts["clusters_with_two_unique_continuations"]
                    >= int(gates["min_clusters_with_two_continuations"])
                ),
            }
        )
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": dict(gates),
        "unique_key": (
            "eval_size+opening_actions+continuation_actions; slot labels ignored"
        ),
        "bound_audit_key": (
            "eval_size+opening_actions+continuation_actions+black_slot+white_slot"
        ),
    }


def _task_agent_metadata(agent: Any) -> dict[str, Any]:
    metadata = {
        "name": agent.name,
        "class": f"{agent.__class__.__module__}.{agent.__class__.__qualname__}",
    }
    helper = getattr(agent, "metadata_dict", None)
    if callable(helper):
        metadata["config"] = helper()
    else:
        config = getattr(agent, "config", None)
        if config is not None:
            try:
                from dataclasses import asdict, is_dataclass

                if is_dataclass(config):
                    metadata["config"] = asdict(config)
            except (TypeError, ValueError):
                pass
    return metadata


def _pair_artifact_path(task_directory: Path, pair_index: int) -> Path:
    return task_directory / "pairs" / f"pair_{pair_index:04d}.json"


def _load_or_run_pair(
    schedules: Sequence[Mapping[str, Any]],
    *,
    task_directory: Path,
    agent_a: Any,
    agent_b: Any,
) -> list[dict[str, Any]]:
    pair_index = int(schedules[0]["pair_index"])
    path = _pair_artifact_path(task_directory, pair_index)
    if path.is_file():
        return _validate_pair(_read_json(path), schedules)
    records = [
        _play_manifest_game(schedule, agent_a=agent_a, agent_b=agent_b)
        for schedule in sorted(schedules, key=lambda item: int(item["pair_member"]))
    ]
    payload = {
        "schema_name": "lifeline-d17-d19-color-pair",
        "schema_version": SCHEMA_VERSION,
        "task_id": schedules[0]["task_id"],
        "pair_id": schedules[0]["pair_id"],
        "pair_index": pair_index,
        "games": records,
    }
    _validate_pair(payload, schedules)
    _atomic_json(path, payload, overwrite=False)
    return records


def _task_schedule_index(
    games: Sequence[Mapping[str, Any]], task_id: str
) -> dict[int, list[Mapping[str, Any]]]:
    pairs: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    for game in games:
        if game["task_id"] == task_id:
            pairs[int(game["pair_index"])].append(game)
    return dict(sorted(pairs.items()))


def _bundle_hashes(bundle_directory: Path) -> dict[str, str]:
    tasks_path = bundle_directory / "tasks.jsonl"
    games_path = bundle_directory / "game_manifest.jsonl"
    return {
        "task_manifest_sha256": sha256_file(tasks_path),
        "game_manifest_sha256": sha256_file(games_path),
    }


def _execution_metadata(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
    device: str,
) -> dict[str, Any]:
    import torch

    runner_path = Path(__file__).resolve()
    experiments_path = runner_path.with_name("d17_d19_experiments.py")
    source_files_verified = _validate_manifest_source_files(
        manifest, manifest_path=manifest_path
    )
    protocol_path = resolve_manifest_path(
        str(manifest["protocol_path"]), manifest_path=manifest_path
    )
    if sha256_file(protocol_path) != manifest["protocol_sha256"]:
        raise ProtocolError("execution protocol SHA-256 mismatch")
    device_name = None
    if torch.device(device).type == "cuda":
        if not torch.cuda.is_available():
            raise ProtocolError(f"requested CUDA device is unavailable: {device}")
        device_name = torch.cuda.get_device_name(torch.device(device))
    return {
        "schema_name": RUN_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "experiment_id": manifest["experiment_id"],
        "manifest_path": str(manifest_path.resolve()),
        "manifest_sha256": manifest_hash(manifest),
        "protocol_path": str(protocol_path),
        "protocol_sha256": manifest["protocol_sha256"],
        "source_files_verified": source_files_verified,
        "bundle_directory": str(bundle_directory.resolve()),
        **_bundle_hashes(bundle_directory),
        "run_root": str(run_root.resolve()),
        "runner_path": str(runner_path),
        "runner_sha256": sha256_file(runner_path),
        "experiments_sha256": sha256_file(experiments_path),
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "cuda_runtime_version": torch.version.cuda,
        "cudnn_version": torch.backends.cudnn.version(),
        "device": str(torch.device(device)),
        "device_name": device_name,
        "formal_source_hash": _validate_source_identity(_checkpoint_rows(manifest)),
    }


def _receipt_base(
    task: Mapping[str, Any],
    *,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schema_name": RECEIPT_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": task["bundle_experiment_id"],
        "experiment_id": task["experiment_id"],
        "experiment_arm": task["experiment_arm"],
        "evidence_tier": task["evidence_tier"],
        "task_id": task["task_id"],
        "evaluation_kind": task["evaluation_kind"],
        "inference_group_id": task["inference_group_id"],
        "manifest_sha256": task["manifest_sha256"],
        "materialized_manifest_sha256": task["materialized_manifest_sha256"],
        "protocol_sha256": task["protocol_sha256"],
        "runner_sha256": task["runner_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "training_seed": task["training_seed"],
        "checkpoint_id": task["checkpoint_id"],
        "checkpoint_sha256": task["checkpoint_sha256"],
        "config_hash": task["config_hash"],
        "source_hash": task["source_hash"],
        "checkpoint_bindings": task["checkpoint_bindings"],
        "eval_size": task["eval_size"],
        "opponent": task["opponent"],
        "model_pair": task["model_pair"],
        "max_plies": task["max_plies"],
        "superko_mode": task["superko_mode"],
        "source_hashes": task["source_hashes"],
        "execution_identity": {
            name: metadata[name]
            for name in (
                "runner_sha256",
                "experiments_sha256",
                "python_version",
                "torch_version",
                "cuda_runtime_version",
                "cudnn_version",
                "device",
                "device_name",
                "formal_source_hash",
                "protocol_sha256",
                "source_files_verified",
            )
        },
    }


def _run_task(
    task: Mapping[str, Any],
    schedules: Sequence[Mapping[str, Any]],
    *,
    task_directory: Path,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    device: str,
    metadata: Mapping[str, Any],
    agent_cache: dict[tuple[str, str], Any],
) -> dict[str, Any]:
    receipt_path = task_directory / "receipt.json"
    if receipt_path.is_file():
        receipt = _read_json(receipt_path)
        validate_task_receipt(task, schedules, receipt, metadata=metadata)
        return receipt
    arm_name = "gen_size" if task["evaluation_kind"] == "gen_size" else "d16_v2"
    agent_a = _build_agent_from_spec(
        task["agent_specs"]["A"],
        manifest=manifest,
        manifest_path=manifest_path,
        device=device,
        arm_name=arm_name,
        cache=agent_cache,
    )
    agent_b = _build_agent_from_spec(
        task["agent_specs"]["B"],
        manifest=manifest,
        manifest_path=manifest_path,
        device=device,
        arm_name=arm_name,
        cache=agent_cache,
    )
    pair_index = _task_schedule_index(schedules, str(task["task_id"]))
    if len(pair_index) * 2 != int(task["games"]):
        raise ProtocolError(f"{task['task_id']}: game manifest pair count mismatch")
    records: list[dict[str, Any]] = []
    for _, pair_schedules in pair_index.items():
        records.extend(
            _load_or_run_pair(
                pair_schedules,
                task_directory=task_directory,
                agent_a=agent_a,
                agent_b=agent_b,
            )
        )
    records.sort(key=lambda item: int(item["game_index"]))
    for record, schedule in zip(records, schedules):
        _validate_game_record(record, schedule)
    counts = _task_counts(records)
    gate = _formal_gate(task, counts)
    games_path = task_directory / "games.jsonl"
    expected_games_text = _jsonl_text(records)
    if games_path.is_file():
        if games_path.read_text(encoding="utf-8") != expected_games_text:
            raise ProtocolError(f"{task['task_id']}: existing games.jsonl is inconsistent")
    else:
        _atomic_text(games_path, expected_games_text, overwrite=False)
    summary = {
        **_receipt_base(task, metadata=metadata),
        **counts,
        "formal_gate": gate,
        "status": "complete",
        "execution_status": "complete",
        "gate_status": "passed" if gate["passed"] else "failed",
        "failure_reason": None if gate["passed"] else "formal_task_gate_failed",
        "agent_a": _task_agent_metadata(agent_a),
        "agent_b": _task_agent_metadata(agent_b),
        "games_path": str(games_path.resolve()),
        "games_sha256": sha256_file(games_path),
    }
    summary_path = task_directory / "summary.json"
    if summary_path.is_file():
        if _read_json(summary_path) != summary:
            raise ProtocolError(f"{task['task_id']}: existing summary is inconsistent")
    else:
        _atomic_json(summary_path, summary, overwrite=False)
    receipt = {
        **summary,
        "arena_games_path": str(games_path.resolve()),
        "arena_games_sha256": sha256_file(games_path),
        "arena_summary_path": str(summary_path.resolve()),
        "arena_summary_sha256": sha256_file(summary_path),
        "completed_at_utc": _utc_now(),
    }
    validate_task_receipt(task, schedules, receipt, metadata=metadata)
    _atomic_json(receipt_path, receipt, overwrite=False)
    return receipt


def validate_task_receipt(
    task: Mapping[str, Any],
    schedules: Sequence[Mapping[str, Any]],
    receipt: Mapping[str, Any],
    *,
    metadata: Mapping[str, Any],
) -> None:
    expected_base = _receipt_base(task, metadata=metadata)
    for field, expected in expected_base.items():
        if receipt.get(field) != expected:
            raise ProtocolError(f"{task['task_id']}: receipt binding mismatch for {field}")
    if receipt.get("status") != "complete" or receipt.get("execution_status") != "complete":
        raise ProtocolError(f"{task['task_id']}: complete game receipt status is invalid")
    games_path = Path(str(receipt.get("arena_games_path", "")))
    summary_path = Path(str(receipt.get("arena_summary_path", "")))
    if not games_path.is_file() or not summary_path.is_file():
        raise ProtocolError(f"{task['task_id']}: receipt artifacts are missing")
    if (
        sha256_file(games_path) != receipt.get("arena_games_sha256")
        or sha256_file(summary_path) != receipt.get("arena_summary_sha256")
    ):
        raise ProtocolError(f"{task['task_id']}: receipt artifact hash mismatch")
    records = _read_jsonl(games_path)
    if len(records) != len(schedules):
        raise ProtocolError(f"{task['task_id']}: receipt game count mismatch")
    ordered_schedules = sorted(schedules, key=lambda item: int(item["game_index"]))
    for record, schedule in zip(records, ordered_schedules):
        _validate_game_record(record, schedule)
    counts = _task_counts(records)
    gate = _formal_gate(task, counts)
    for field, expected in counts.items():
        if receipt.get(field) != expected:
            raise ProtocolError(f"{task['task_id']}: receipt count mismatch for {field}")
    if receipt.get("formal_gate") != gate:
        raise ProtocolError(f"{task['task_id']}: receipt formal gate mismatch")
    expected_gate_status = "passed" if gate["passed"] else "failed"
    if receipt.get("gate_status") != expected_gate_status:
        raise ProtocolError(f"{task['task_id']}: receipt gate status disagrees with gate")
    expected_reason = None if gate["passed"] else "formal_task_gate_failed"
    if receipt.get("failure_reason") != expected_reason:
        raise ProtocolError(f"{task['task_id']}: receipt gate failure reason is inconsistent")


def _load_state(path: Path, task_id: str) -> dict[str, Any]:
    if not path.is_file():
        return {
            "schema_name": RUN_SCHEMA_NAME,
            "schema_version": SCHEMA_VERSION,
            "task_id": task_id,
            "attempts": 0,
            "status": "pending",
        }
    state = _read_json(path)
    if state.get("task_id") != task_id:
        raise ProtocolError(f"state file belongs to another task: {path}")
    return state


def _write_failed_attempt(
    task_directory: Path,
    *,
    task: Mapping[str, Any],
    state: Mapping[str, Any],
    exc: BaseException,
    metadata: Mapping[str, Any],
) -> Path:
    attempt = int(state["attempts"])
    path = task_directory / "attempts" / f"attempt_{attempt:04d}.failed.json"
    payload = {
        **_receipt_base(task, metadata=metadata),
        "status": "failed_attempt",
        "attempt": attempt,
        "failed_at_utc": _utc_now(),
        "failure_reason": f"{type(exc).__name__}: {exc}",
        "traceback": traceback.format_exc(),
        "canonical_receipt_written": False,
    }
    _atomic_json(path, payload, overwrite=False)
    return path


def _group_game_manifest(
    games: Sequence[Mapping[str, Any]],
) -> dict[str, list[Mapping[str, Any]]]:
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for game in games:
        grouped[str(game["task_id"])].append(game)
    for task_id in grouped:
        grouped[task_id].sort(key=lambda item: int(item["game_index"]))
    return dict(grouped)


def _independent_verification_passed(
    run_root: Path, metadata: Mapping[str, Any]
) -> tuple[bool, str | None]:
    candidates = (
        run_root / "independent_verification.json",
        run_root / "verification" / "independent_verification.json",
    )
    for path in candidates:
        if not path.is_file():
            continue
        payload = _read_json(path)
        inputs = payload.get("inputs")
        gates = payload.get("gates")
        if not isinstance(inputs, Mapping) or not isinstance(gates, Mapping):
            raise ProtocolError("independent verification report lacks inputs/gates")
        manifest_input = inputs.get("manifest")
        task_input = inputs.get("task_manifest")
        game_input = inputs.get("game_manifest")
        receipts_input = inputs.get("receipts")
        if not all(
            isinstance(value, Mapping)
            for value in (manifest_input, task_input, game_input, receipts_input)
        ):
            raise ProtocolError("independent verification input bindings are malformed")
        ledger = run_root / "result_receipts.jsonl"
        verifier = Path(__file__).with_name("d17_d19_verify_evidence.py")
        bindings_pass = (
            payload.get("bundle_id") == BUNDLE_EXPERIMENT_ID
            and manifest_input.get("canonical_sha256")
            == metadata["manifest_sha256"]
            and task_input.get("sha256") == metadata["task_manifest_sha256"]
            and game_input.get("sha256") == metadata["game_manifest_sha256"]
            and ledger.is_file()
            and receipts_input.get("sha256") == sha256_file(ledger)
            and verifier.is_file()
            and payload.get("verifier_sha256") == sha256_file(verifier)
        )
        passed = (
            payload.get("status") == "PASS"
            and payload.get("formal_ready") is True
            and bindings_pass
            and bool(gates)
            and all(value is True for value in gates.values())
            and gates.get("canonical_hash_verified") is True
            and gates.get("canonical_numeric_match") is True
        )
        return passed, str(path.resolve())
    return False, None


def _finalize_ledger(
    tasks: Sequence[Mapping[str, Any]],
    grouped_games: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    run_root: Path,
    metadata: Mapping[str, Any],
) -> dict[str, Any]:
    receipts: list[dict[str, Any]] = []
    missing: list[str] = []
    execution_failed: list[str] = []
    for task in tasks:
        task_id = str(task["task_id"])
        task_directory = _task_directory(run_root, task_id)
        receipt_path = task_directory / "receipt.json"
        if not receipt_path.is_file():
            state_path = task_directory / "state.json"
            if state_path.is_file() and _load_state(state_path, task_id).get("status") == "failed":
                execution_failed.append(task_id)
            else:
                missing.append(task_id)
            continue
        receipt = _read_json(receipt_path)
        validate_task_receipt(
            task,
            grouped_games[str(task["task_id"])],
            receipt,
            metadata=metadata,
        )
        receipts.append(receipt)
    complete = sum(
        receipt["status"] == "complete"
        and receipt.get("execution_status") == "complete"
        for receipt in receipts
    )
    gate_failed = [
        str(receipt["task_id"])
        for receipt in receipts
        if receipt.get("gate_status") == "failed"
    ]
    independent_passed, independent_path = _independent_verification_passed(
        run_root, metadata
    )
    ledger_path: Path | None = None
    if not missing and not execution_failed:
        ledger_path = run_root / "result_receipts.jsonl"
        text = _jsonl_text(receipts)
        if ledger_path.is_file():
            if ledger_path.read_text(encoding="utf-8") != text:
                raise ProtocolError("immutable result receipt ledger disagrees with receipts")
        else:
            _atomic_text(ledger_path, text, overwrite=False)
    execution_complete = (
        not missing
        and not execution_failed
        and complete == len(tasks)
        and sum(int(receipt["truncated_games"]) for receipt in receipts) == 0
    )
    formal_ready = execution_complete and not gate_failed and independent_passed
    ledger_sha = None if ledger_path is None else sha256_file(ledger_path)
    status = {
        "schema_name": RUN_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": BUNDLE_EXPERIMENT_ID,
        "manifest_sha256": metadata["manifest_sha256"],
        "protocol_sha256": metadata["protocol_sha256"],
        "runner_sha256": metadata["runner_sha256"],
        "experiments_sha256": metadata["experiments_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "receipts_present": len(receipts),
        "receipt_count": len(receipts),
        "complete_tasks": complete,
        "failed_tasks": len(execution_failed),
        "execution_failed_tasks": len(execution_failed),
        "execution_failed_preview": execution_failed[:10],
        "gate_failed_tasks": len(gate_failed),
        "gate_failed_preview": gate_failed[:10],
        "missing_tasks": len(missing),
        "missing_preview": missing[:10],
        "execution_complete": execution_complete,
        "independent_verification_passed": independent_passed,
        "independent_verification_path": independent_path,
        "formal_ready": formal_ready,
        "result_ledger": None if ledger_path is None else str(ledger_path.resolve()),
        "result_ledger_sha256": ledger_sha,
        "ledger_sha256": ledger_sha,
        "result_receipts_sha256": ledger_sha,
        "updated_at_utc": _utc_now(),
    }
    _atomic_json(run_root / "result_ledger_status.json", status)
    return status


def run_bundle(
    manifest: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    *,
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
    device: str,
    task_kind: str = "all",
    max_tasks: int | None = None,
    retry_failed: bool = False,
    continue_on_error: bool = False,
) -> dict[str, Any]:
    """Execute pending P0 tasks sequentially with immutable pair artifacts."""

    if run_root.exists() and not run_root.is_dir():
        raise ProtocolError("run root exists but is not a directory")
    run_root.mkdir(parents=True, exist_ok=True)
    metadata = _execution_metadata(
        manifest,
        manifest_path=manifest_path,
        bundle_directory=bundle_directory,
        run_root=run_root,
        device=device,
    )
    metadata_path = run_root / "execution_metadata.json"
    if metadata_path.is_file():
        if _read_json(metadata_path) != metadata:
            raise ProtocolError(
                "run root belongs to another manifest, bundle, runner build, or device"
            )
    else:
        _atomic_json(metadata_path, metadata, overwrite=False)
    grouped_games = _group_game_manifest(games)
    selected = [
        task
        for task in tasks
        if task_kind == "all" or task["evaluation_kind"] == task_kind
    ]
    attempted = skipped_complete = skipped_failed = skipped_gate_failed = 0
    execution_failures = gate_failures = 0
    agent_cache: dict[tuple[str, str], Any] = {}
    for task in selected:
        task_id = str(task["task_id"])
        task_directory = _task_directory(run_root, task_id)
        task_directory.mkdir(parents=True, exist_ok=True)
        receipt_path = task_directory / "receipt.json"
        if receipt_path.is_file():
            receipt = _read_json(receipt_path)
            validate_task_receipt(
                task, grouped_games[task_id], receipt, metadata=metadata
            )
            skipped_complete += 1
            if receipt.get("gate_status") == "failed":
                skipped_gate_failed += 1
            continue
        state_path = task_directory / "state.json"
        state = _load_state(state_path, task_id)
        if state.get("status") == "failed" and not retry_failed:
            skipped_failed += 1
            continue
        if max_tasks is not None and attempted >= max_tasks:
            break
        state["attempts"] = int(state.get("attempts", 0)) + 1
        state["status"] = "running"
        state["attempt_started_at_utc"] = _utc_now()
        _atomic_json(state_path, state)
        attempted += 1
        try:
            receipt = _run_task(
                task,
                grouped_games[task_id],
                task_directory=task_directory,
                manifest=manifest,
                manifest_path=manifest_path,
                device=device,
                metadata=metadata,
                agent_cache=agent_cache,
            )
        except Exception as exc:
            execution_failures += 1
            state = _load_state(state_path, task_id)
            failure_path = _write_failed_attempt(
                task_directory,
                task=task,
                state=state,
                exc=exc,
                metadata=metadata,
            )
            state["status"] = "failed"
            state["failure_reason"] = f"{type(exc).__name__}: {exc}"
            state["failure_receipt"] = str(failure_path.resolve())
            state["failed_at_utc"] = _utc_now()
            _atomic_json(state_path, state)
            if not continue_on_error:
                break
        else:
            state = _load_state(state_path, task_id)
            state["status"] = receipt["execution_status"]
            state["gate_status"] = receipt["gate_status"]
            state["completed_at_utc"] = receipt["completed_at_utc"]
            for stale_field in (
                "failure_reason",
                "failure_receipt",
                "failed_at_utc",
            ):
                state.pop(stale_field, None)
            if receipt["gate_status"] == "failed":
                state["gate_failure_reason"] = receipt["failure_reason"]
                gate_failures += 1
            else:
                state.pop("gate_failure_reason", None)
            _atomic_json(state_path, state)
    ledger = _finalize_ledger(
        tasks, grouped_games, run_root=run_root, metadata=metadata
    )
    summary = {
        **ledger,
        "attempted_this_invocation": attempted,
        # Backward-compatible alias: a completed task that misses a diversity
        # gate is evidence, not an execution failure.
        "failures_this_invocation": execution_failures,
        "execution_failures_this_invocation": execution_failures,
        "gate_failures_this_invocation": gate_failures,
        "skipped_complete": skipped_complete,
        "skipped_failed": skipped_failed,
        "skipped_gate_failed": skipped_gate_failed,
        "device": device,
    }
    _atomic_json(run_root / "execution_summary.json", summary)
    return summary


def status_summary(
    manifest: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    *,
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
) -> dict[str, Any]:
    """Read-only deep status; never trusts a pre-existing ledger flag."""

    metadata_path = run_root / "execution_metadata.json"
    if not metadata_path.is_file():
        return {
            "bundle_id": BUNDLE_EXPERIMENT_ID,
            "manifest_sha256": manifest_hash(manifest),
            "receipts_present": 0,
            "complete_tasks": 0,
            "failed_tasks": 0,
            "missing_tasks": len(tasks),
            "execution_complete": False,
            "independent_verification_passed": False,
            "formal_ready": False,
            "status": "not_started",
        }
    metadata = _read_json(metadata_path)
    expected = _execution_metadata(
        manifest,
        manifest_path=manifest_path,
        bundle_directory=bundle_directory,
        run_root=run_root,
        device=str(metadata.get("device", "")),
    )
    if metadata != expected:
        raise ProtocolError("execution metadata is stale or belongs to another run")
    return _finalize_ledger(
        tasks,
        _group_game_manifest(games),
        run_root=run_root,
        metadata=metadata,
    )


def _score_and_outcome_for_a(record: Mapping[str, Any]) -> tuple[float | None, str]:
    """Return the focal-A score without treating a color-swapped game as a unit."""

    if record.get("truncated") is True:
        return None, "TRUNCATED"
    winner = record.get("winner")
    if winner == "DRAW":
        return 0.5, "DRAW"
    if winner not in {"BLACK", "WHITE"}:
        raise ProtocolError(f"game has invalid winner {winner!r}")
    black_slot = record.get("black_slot")
    white_slot = record.get("white_slot")
    if (black_slot, white_slot) not in {("A", "B"), ("B", "A")}:
        raise ProtocolError("game does not contain a valid A/B color assignment")
    a_color = "BLACK" if black_slot == "A" else "WHITE"
    return (1.0, "WIN") if winner == a_color else (0.0, "LOSS")


def _canonical_seed_t_interval(seed_scores: Sequence[float]) -> list[float] | None:
    if len(seed_scores) < 2:
        return None
    critical_values = {
        1: 12.706,
        2: 4.303,
        3: 3.182,
        4: 2.776,
        5: 2.571,
        6: 2.447,
        7: 2.365,
        8: 2.306,
        9: 2.262,
        10: 2.228,
        11: 2.201,
        12: 2.179,
        13: 2.160,
        14: 2.145,
        15: 2.131,
        16: 2.120,
        17: 2.110,
        18: 2.101,
        19: 2.093,
        20: 2.086,
        21: 2.080,
        22: 2.074,
        23: 2.069,
        24: 2.064,
        25: 2.060,
        26: 2.056,
        27: 2.052,
        28: 2.048,
        29: 2.045,
        30: 2.042,
    }
    mean = statistics.fmean(seed_scores)
    standard_error = statistics.stdev(seed_scores) / math.sqrt(len(seed_scores))
    critical = critical_values.get(len(seed_scores) - 1, 1.96)
    margin = critical * standard_error
    return [max(0.0, mean - margin), min(1.0, mean + margin)]


def _canonical_percentile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ProtocolError("cannot take a percentile of an empty sample")
    ordered = sorted(values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _canonical_crossed_bootstrap_interval(
    clusters_by_seed: Mapping[int, Mapping[str, Sequence[float]]],
    *,
    resamples: int,
    random_seed: int,
) -> list[float] | None:
    seeds = sorted(clusters_by_seed)
    if len(seeds) < 2 or resamples < 1:
        return None
    cluster_sets = [set(clusters_by_seed[seed]) for seed in seeds]
    if not cluster_sets or any(
        cluster_ids != cluster_sets[0] for cluster_ids in cluster_sets[1:]
    ):
        raise ProtocolError(
            "canonical crossed bootstrap requires the same registered cluster IDs "
            "for every training seed"
        )
    cluster_ids = sorted(cluster_sets[0])
    if not cluster_ids:
        return None
    rng = random.Random(random_seed)
    estimates: list[float] = []
    for _ in range(resamples):
        sampled_seeds = [rng.choice(seeds) for _ in range(len(seeds))]
        sampled_clusters = [
            rng.choice(cluster_ids) for _ in range(len(cluster_ids))
        ]
        crossed_cells = [
            statistics.fmean(clusters_by_seed[seed][cluster_id])
            for seed in sampled_seeds
            for cluster_id in sampled_clusters
        ]
        estimates.append(statistics.fmean(crossed_cells))
    return [
        _canonical_percentile(estimates, 0.025),
        _canonical_percentile(estimates, 0.975),
    ]


def _canonical_wilson_descriptive(
    wins: int, draws: int, games_completed: int
) -> list[float] | None:
    if games_completed < 1:
        return None
    proportion = (wins + 0.5 * draws) / games_completed
    z = 1.96
    denominator = 1.0 + z * z / games_completed
    center = (proportion + z * z / (2.0 * games_completed)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1.0 - proportion) / games_completed
            + z * z / (4.0 * games_completed * games_completed)
        )
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def _canonical_bootstrap_settings(
    manifest: Mapping[str, Any],
) -> dict[str, tuple[int, int]]:
    config = manifest.get("statistics")
    if not isinstance(config, Mapping):
        raise ProtocolError("manifest.statistics is missing")
    gen = config.get("gen_size_secondary_interval")
    d16 = config.get("d16_v2_primary_interval")
    if not isinstance(gen, Mapping) or not isinstance(d16, Mapping):
        raise ProtocolError("manifest bootstrap interval declarations are missing")
    settings = {
        GEN_SIZE_EXPERIMENT_ID: (
            int(gen.get("replicates", 0)),
            int(gen.get("bootstrap_seed", -1)),
        ),
        D16_V2_EXPERIMENT_ID: (
            int(d16.get("replicates", 0)),
            int(d16.get("bootstrap_seed", -1)),
        ),
    }
    frozen = {
        GEN_SIZE_EXPERIMENT_ID: (20_000, 202608299901),
        D16_V2_EXPERIMENT_ID: (20_000, 202608299902),
    }
    if settings != frozen:
        raise ProtocolError(
            "canonical bootstrap replicates/seeds differ from the frozen protocol"
        )
    return settings


def canonical_aggregate(
    manifest: Mapping[str, Any],
    tasks: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    *,
    manifest_path: Path,
    bundle_directory: Path,
    run_root: Path,
    output: Path,
) -> dict[str, Any]:
    """Build the canonical numeric interface without reading verifier output."""

    if output.exists():
        raise ProtocolError(f"refusing to overwrite canonical numeric artifact: {output}")
    metadata_path = run_root / "execution_metadata.json"
    if not metadata_path.is_file():
        raise ProtocolError("canonical aggregate requires a started formal run")
    metadata = _read_json(metadata_path)
    expected_metadata = _execution_metadata(
        manifest,
        manifest_path=manifest_path,
        bundle_directory=bundle_directory,
        run_root=run_root,
        device=str(metadata.get("device", "")),
    )
    if metadata != expected_metadata:
        raise ProtocolError("execution metadata is stale or belongs to another run")
    grouped_schedules = _group_game_manifest(games)
    ledger = _finalize_ledger(
        tasks, grouped_schedules, run_root=run_root, metadata=metadata
    )
    if ledger.get("execution_complete") is not True:
        raise ProtocolError(
            "canonical aggregate requires 85/85 complete tasks with no failure, "
            "missing task, or truncation"
        )

    task_rows_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    game_rows_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    pair_rows_by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for task in tasks:
        task_id = str(task["task_id"])
        group_id = str(task["inference_group_id"])
        schedules = grouped_schedules[task_id]
        receipt = _read_json(_task_directory(run_root, task_id) / "receipt.json")
        validate_task_receipt(task, schedules, receipt, metadata=metadata)
        records = _read_jsonl(Path(str(receipt["arena_games_path"])))
        task_rows_by_group[group_id].append(task)
        schedule_by_game = {str(row["game_id"]): row for row in schedules}
        records_by_pair: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for record in records:
            schedule = schedule_by_game.get(str(record.get("game_id")))
            if schedule is None:
                raise ProtocolError(f"{task_id}: canonical aggregate found an extra game")
            _validate_game_record(record, schedule)
            _, outcome = _score_and_outcome_for_a(record)
            enriched = dict(record)
            enriched["canonical_outcome"] = outcome
            game_rows_by_group[group_id].append(enriched)
            records_by_pair[str(record["pair_id"])].append(record)
        for plan in task["pair_plan"]:
            pair_id = str(plan["pair_id"])
            pair_records = records_by_pair.get(pair_id, [])
            if len(pair_records) != 2:
                raise ProtocolError(f"{task_id}: canonical aggregate pair is incomplete")
            pair_scores = [_score_and_outcome_for_a(record)[0] for record in pair_records]
            if any(score is None for score in pair_scores):
                raise ProtocolError(f"{task_id}: canonical aggregate encountered truncation")
            crossed_cluster = (
                str(plan["opening_cluster"])
                if task["experiment_id"] == D16_V2_EXPERIMENT_ID
                else str(plan["policy_seed_block"])
                + f".x{plan['policy_seed_assignment']}"
            )
            pair_rows_by_group[group_id].append(
                {
                    "training_seed": int(task["training_seed"]),
                    "crossed_cluster_id": crossed_cluster,
                    "pair_score": statistics.fmean(
                        float(score) for score in pair_scores if score is not None
                    ),
                }
            )

    settings = _canonical_bootstrap_settings(manifest)
    comparison_rows: list[dict[str, Any]] = []
    for group_id in sorted(task_rows_by_group):
        group_tasks = task_rows_by_group[group_id]
        group_games = game_rows_by_group[group_id]
        group_pairs = pair_rows_by_group[group_id]
        experiment_ids = {str(task["experiment_id"]) for task in group_tasks}
        if len(experiment_ids) != 1:
            raise ProtocolError(f"canonical inference group {group_id!r} mixes experiments")
        experiment_id = next(iter(experiment_ids))
        seeds = sorted({int(task["training_seed"]) for task in group_tasks})
        clusters_by_seed: dict[int, dict[str, list[float]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for pair in group_pairs:
            clusters_by_seed[int(pair["training_seed"])][
                str(pair["crossed_cluster_id"])
            ].append(float(pair["pair_score"]))
        seed_scores: list[float] = []
        seed_units: list[dict[str, Any]] = []
        cluster_unit_count = 0
        for seed in seeds:
            cluster_scores = {
                cluster_id: statistics.fmean(values)
                for cluster_id, values in sorted(clusters_by_seed.get(seed, {}).items())
                if values
            }
            cluster_unit_count += len(cluster_scores)
            if cluster_scores:
                seed_score = statistics.fmean(cluster_scores.values())
                seed_scores.append(seed_score)
                seed_units.append(
                    {
                        "training_seed": seed,
                        "opening_clusters": len(cluster_scores),
                        "seed_score_equal_weighted_over_clusters": seed_score,
                    }
                )
        if len(seed_scores) != 5:
            raise ProtocolError(
                f"canonical inference group {group_id!r} does not retain all five seeds"
            )
        outcomes = Counter(str(record["canonical_outcome"]) for record in group_games)
        completed = len(group_games) - outcomes["TRUNCATED"]
        bootstrap_resamples, bootstrap_seed = settings[experiment_id]
        seed_ci = _canonical_seed_t_interval(seed_scores)
        crossed_ci = _canonical_crossed_bootstrap_interval(
            clusters_by_seed,
            resamples=bootstrap_resamples,
            random_seed=bootstrap_seed,
        )
        if experiment_id == GEN_SIZE_EXPERIMENT_ID:
            primary_method = "training-seed Student t interval"
            primary_ci = seed_ci
            secondary_method = "two-way crossed seed x policy-pair bootstrap"
            secondary_ci = crossed_ci
        else:
            primary_method = "two-way crossed seed x opening-cluster bootstrap"
            primary_ci = crossed_ci
            secondary_method = "training-seed Student t interval"
            secondary_ci = seed_ci
        comparison_rows.append(
            {
                "inference_group_id": group_id,
                "experiment_id": experiment_id,
                "experiment_arm": group_tasks[0]["experiment_arm"],
                "task_receipts": len(group_tasks),
                "training_seed_units": len(seed_scores),
                "seed_by_opening_cluster_units": cluster_unit_count,
                "paired_color_units": len(group_pairs),
                "games_completed": completed,
                "truncated_games": outcomes["TRUNCATED"],
                "a_wins": outcomes["WIN"],
                "a_losses": outcomes["LOSS"],
                "draws": outcomes["DRAW"],
                "unique_full_color_aware": len(
                    {str(record["complete_bound_trajectory_hash"]) for record in group_games}
                ),
                "unique_full_sequence_ignoring_color": len(
                    {str(record["action_trajectory_hash"]) for record in group_games}
                ),
                "unique_continuation_ignoring_opening_and_color": len(
                    {str(record["continuation_trajectory_hash"]) for record in group_games}
                ),
                "primary_score_equal_weighted_over_training_seeds": statistics.fmean(
                    seed_scores
                ),
                "training_seed_t_ci95": seed_ci,
                "crossed_seed_cluster_bootstrap_ci95": crossed_ci,
                "primary_interval_method": primary_method,
                "primary_ci95": primary_ci,
                "secondary_interval_method": secondary_method,
                "secondary_ci95": secondary_ci,
                "crossed_cluster_bootstrap_resamples": bootstrap_resamples,
                "crossed_cluster_bootstrap_seed": bootstrap_seed,
                "pooled_game_score_descriptive_only": (
                    (outcomes["WIN"] + 0.5 * outcomes["DRAW"]) / completed
                    if completed
                    else None
                ),
                "pooled_game_wilson_ci95_descriptive_only": (
                    _canonical_wilson_descriptive(
                        outcomes["WIN"], outcomes["DRAW"], completed
                    )
                ),
                "seed_units": seed_units,
            }
        )
    group_counts = Counter(row["experiment_id"] for row in comparison_rows)
    if group_counts != Counter(
        {GEN_SIZE_EXPERIMENT_ID: 8, D16_V2_EXPERIMENT_ID: 9}
    ):
        raise ProtocolError(f"canonical comparison groups are incomplete: {group_counts}")
    numeric = {
        "schema_name": NUMERIC_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": BUNDLE_EXPERIMENT_ID,
        "manifest_sha256": metadata["manifest_sha256"],
        "protocol_sha256": metadata["protocol_sha256"],
        "runner_sha256": metadata["runner_sha256"],
        "experiments_sha256": metadata["experiments_sha256"],
        "task_manifest_sha256": metadata["task_manifest_sha256"],
        "game_manifest_sha256": metadata["game_manifest_sha256"],
        "comparison_rows": comparison_rows,
    }
    _atomic_json(output, numeric, overwrite=False)
    return {
        "status": "canonical_numeric_written_awaiting_independent_verification",
        "formal_ready": False,
        "canonical_numeric_path": str(output.resolve()),
        "canonical_numeric_sha256": sha256_file(output),
        "comparison_rows": len(comparison_rows),
        "training_seed_is_primary_unit": True,
        "individual_games_treated_as_independent": False,
    }


def _repeat_tensor_batch(base: Any, batch_size: int, device: Any):
    from lifeline_rl.alphazero.network import TensorBatch

    rows = int(base.node_features.shape[0])
    repeats = math.ceil(batch_size / rows)

    def repeated(tensor: Any | None):
        if tensor is None:
            return None
        shape = [repeats] + [1] * (tensor.ndim - 1)
        return tensor.repeat(*shape)[:batch_size].to(device, non_blocking=True)

    return TensorBatch(
        node_features=repeated(base.node_features),
        adjacency=repeated(base.adjacency),
        node_mask=repeated(base.node_mask),
        legal_action_mask=repeated(base.legal_action_mask),
        policy_targets=None,
        value_targets=None,
    )


def gpu_smoke(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    seconds: float,
    profile_output: Path | None,
    batch_candidates: Sequence[int],
) -> dict[str, Any]:
    """Sustain real CUDA forward/backward/optimizer work for 15--30 seconds."""

    import torch
    import torch.nn.functional as functional

    from lifeline_rl import LifelineGame
    from lifeline_rl.alphazero.network import collate_positions

    if not 15.0 <= seconds <= 30.0:
        raise ProtocolError("GPU smoke duration must be between 15 and 30 seconds")
    if not torch.cuda.is_available():
        raise ProtocolError("GPU smoke requires a real available CUDA device")
    if not batch_candidates or any(size < 1 for size in batch_candidates):
        raise ProtocolError("GPU smoke batch candidates must be positive")
    work_dir_raw = os.environ.get("AUTODL_WORK_DIR")
    if not work_dir_raw:
        raise ProtocolError("AUTODL_WORK_DIR is required for the GPU smoke profile")
    work_dir = Path(work_dir_raw).resolve()
    if profile_output is None:
        profile_output = work_dir / "d17_d19_gpu_throughput.json"
    profile_output = profile_output.resolve()
    try:
        profile_output.relative_to(work_dir)
    except ValueError as exc:
        raise ProtocolError("GPU smoke profile must be inside AUTODL_WORK_DIR") from exc
    if profile_output.exists():
        raise ProtocolError(f"refusing to overwrite GPU smoke profile: {profile_output}")

    started = time.perf_counter()
    materialized = materialize_manifest(manifest)
    openings = _opening_by_size(materialized)
    checkpoint = next(
        row
        for row in _checkpoint_rows(manifest)
        if row["model_kind"] == "topology_gnn"
        and row["training_seed"] == 20260825
    )
    loaded = _load_neural_agent(
        checkpoint,
        manifest=manifest,
        manifest_path=manifest_path,
        device="cuda",
        arm_name="gen_size",
    )
    # The checkpoint-backed agent remains untouched; optimizer work is on a
    # disposable clone and is never saved.
    model = copy.deepcopy(loaded.model).to("cuda")
    model.train()
    positions = [
        _game_from_opening(openings[size], size) for size in (5, 7, 9)
    ] + [LifelineGame(10), LifelineGame(12)]
    supply_started = time.perf_counter()
    base = collate_positions(positions, "topology", device="cpu")
    supply_parse_seconds = time.perf_counter() - supply_started
    amp_dtype = (
        torch.bfloat16
        if torch.cuda.is_bf16_supported()
        else torch.float16
    )
    amp_name = "bfloat16" if amp_dtype is torch.bfloat16 else "float16"
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scaler = torch.amp.GradScaler(
        "cuda", enabled=(amp_dtype is torch.float16)
    )

    def step(batch: Any) -> float:
        optimizer.zero_grad(set_to_none=True)
        with torch.amp.autocast("cuda", dtype=amp_dtype):
            logits, values = model(
                batch.node_features,
                batch.adjacency,
                batch.node_mask,
                batch.legal_action_mask,
            )
            targets = batch.legal_action_mask.to(torch.int64).argmax(dim=1)
            policy_loss = functional.cross_entropy(logits, targets)
            value_loss = functional.mse_loss(values, torch.zeros_like(values))
            loss = policy_loss + value_loss
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        scaler.step(optimizer)
        scaler.update()
        return float(loss.detach().cpu())

    candidate_results: list[dict[str, Any]] = []
    selected_batch = int(batch_candidates[0])
    selected_tensor_batch = None
    calibration_deadline = started + min(6.0, seconds * 0.3)
    for candidate in sorted(set(int(value) for value in batch_candidates)):
        if time.perf_counter() >= calibration_deadline and selected_tensor_batch is not None:
            break
        try:
            tensor_batch = _repeat_tensor_batch(base, candidate, torch.device("cuda"))
            candidate_started = time.perf_counter()
            loss = step(tensor_batch)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - candidate_started
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            candidate_results.append(
                {"batch_size": candidate, "status": "oom"}
            )
            break
        candidate_results.append(
            {
                "batch_size": candidate,
                "status": "pass",
                "step_seconds": elapsed,
                "examples_per_second": candidate / elapsed,
                "loss": loss,
            }
        )
        selected_batch = candidate
        selected_tensor_batch = tensor_batch
    if selected_tensor_batch is None:
        raise ProtocolError("no GPU smoke batch candidate completed")

    deadline = started + seconds
    steps = 0
    examples = 0
    losses: list[float] = []
    utilization_samples: list[float] = []
    sustained_started = time.perf_counter()
    while time.perf_counter() < deadline:
        losses.append(step(selected_tensor_batch))
        torch.cuda.synchronize()
        steps += 1
        examples += selected_batch
        utilization = getattr(torch.cuda, "utilization", None)
        if callable(utilization):
            try:
                utilization_samples.append(float(utilization()))
            except Exception:
                pass
    sustained_seconds = time.perf_counter() - sustained_started
    duration = time.perf_counter() - started
    profile = {
        "schema_name": "lifeline-d17-d19-gpu-smoke",
        "schema_version": SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "manifest_sha256": manifest_hash(manifest),
        "checkpoint_id": checkpoint["checkpoint_id"],
        "checkpoint_sha256": checkpoint["sha256"],
        "disposable_model_clone": True,
        "formal_tasks_executed": 0,
        "device": "cuda",
        "device_name": torch.cuda.get_device_name(),
        "torch_version": torch.__version__,
        "cuda_runtime_version": torch.version.cuda,
        "amp_dtype": amp_name,
        "data_supply": "preloaded_repeated_real_mixed_size_state_batch",
        "real_sizes": [5, 7, 9, 10, 12],
        "input_parse_and_collate_seconds": supply_parse_seconds,
        "candidate_results": candidate_results,
        "selected_batch_size": selected_batch,
        "optimizer_steps": steps,
        "examples": examples,
        "sustained_seconds": sustained_seconds,
        "duration_seconds": duration,
        "optimizer_steps_per_second": steps / sustained_seconds,
        "examples_per_second": examples / sustained_seconds,
        "last_loss": None if not losses else losses[-1],
        "gpu_utilization_samples_percent": utilization_samples,
        "gpu_utilization_mean_percent": (
            None
            if not utilization_samples
            else statistics.fmean(utilization_samples)
        ),
        "gpu_utilization_max_percent": (
            None if not utilization_samples else max(utilization_samples)
        ),
        "max_memory_allocated_bytes": torch.cuda.max_memory_allocated(),
        "profile_path": str(profile_output),
        "completed_at_utc": _utc_now(),
    }
    _atomic_json(profile_output, profile, overwrite=False)
    return profile


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def prepare_autodl_stage(
    *,
    manifest_path: Path,
    bundle_directory: Path,
    dry_run_evidence: Path,
    output: Path,
) -> dict[str, Any]:
    """Create a minimal immutable repo-layout upload tree for one reviewed Job."""

    allowed_root = (RESEARCH_ROOT / "results" / "formal" / "d17_d19").resolve()
    output = output.resolve()
    try:
        output.relative_to(allowed_root)
    except ValueError as exc:
        raise ProtocolError("AutoDL stage must be inside results/formal/d17_d19") from exc
    if output.exists():
        raise ProtocolError(f"refusing to reuse AutoDL stage directory: {output}")
    manifest = load_manifest(manifest_path)
    _validate_dry_run_evidence(dry_run_evidence, manifest)
    _, tasks, games = load_task_bundle(manifest, bundle_directory)
    if len(tasks) != 85 or len(games) != 8320:
        raise ProtocolError("AutoDL stage requires the exact 85-task/8,320-game bundle")

    sources: set[Path] = set()

    def add(source: Path) -> None:
        source = source.resolve()
        if not source.is_file():
            raise ProtocolError(f"AutoDL stage input is missing: {source}")
        try:
            source.relative_to(REPO_ROOT.resolve())
        except ValueError as exc:
            raise ProtocolError(f"AutoDL stage input is outside the repository: {source}") from exc
        sources.add(source)

    add(manifest_path)
    add(dry_run_evidence)
    add(RESEARCH_ROOT / "pyproject.toml")
    add(resolve_manifest_path(str(manifest["protocol_path"]), manifest_path=manifest_path))
    opening_binding = manifest["d16_v2"]["opening_manifest"]
    add(resolve_manifest_path(str(opening_binding["path"]), manifest_path=manifest_path))
    for source in (RESEARCH_ROOT / "lifeline_rl").rglob("*.py"):
        if "__pycache__" not in source.parts:
            add(source)
    for source in (RESEARCH_ROOT / "scripts").glob("d17_d19_*.py"):
        add(source)
    for source in bundle_directory.rglob("*"):
        if source.is_file():
            add(source)
    for raw_path in manifest["source_hashes"]:
        add(resolve_manifest_path(str(raw_path), manifest_path=manifest_path))
    for binding in manifest["readonly_bindings"]:
        add(resolve_manifest_path(str(binding["path"]), manifest_path=manifest_path))
    for checkpoint in manifest["checkpoints"]:
        for field in ("path", "config_path", "source_receipt_path"):
            add(resolve_manifest_path(str(checkpoint[field]), manifest_path=manifest_path))

    output.mkdir(parents=True, exist_ok=False)
    staged_files: list[dict[str, Any]] = []
    for source in sorted(sources, key=lambda path: path.as_posix()):
        relative = source.relative_to(REPO_ROOT.resolve())
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if sha256_file(destination) != sha256_file(source):
            raise ProtocolError(f"AutoDL stage copy hash mismatch: {relative}")
        staged_files.append(
            {
                "path": relative.as_posix(),
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
            }
        )
    payload = {
        "schema_name": "lifeline-d17-d19-autodl-stage",
        "schema_version": SCHEMA_VERSION,
        "status": "prepared_not_run",
        "bundle_id": BUNDLE_EXPERIMENT_ID,
        "manifest_sha256": manifest_hash(manifest),
        "protocol_sha256": manifest["protocol_sha256"],
        "task_manifest_sha256": sha256_file(bundle_directory / "tasks.jsonl"),
        "game_manifest_sha256": sha256_file(bundle_directory / "game_manifest.jsonl"),
        "dry_run_evidence_sha256": sha256_file(dry_run_evidence),
        "source_repository": str(REPO_ROOT.resolve()),
        "stage_root": str(output),
        "file_count": len(staged_files),
        "total_bytes": sum(int(row["bytes"]) for row in staged_files),
        "files": staged_files,
        "formal_tasks_executed": 0,
        "paid_action_performed": False,
        "created_at_utc": _utc_now(),
    }
    stage_manifest = output / "autodl_stage_manifest.json"
    _atomic_json(stage_manifest, payload, overwrite=False)
    return {
        **payload,
        "stage_manifest_path": str(stage_manifest.resolve()),
        "stage_manifest_sha256": sha256_file(stage_manifest),
    }


def generate_job_toml(
    *,
    manifest_path: Path,
    bundle_directory: Path,
    output: Path,
    code_path: Path,
    image_uuid: str,
    local_python: Path,
    remote_python: str,
    max_runtime_seconds: int,
    dry_run_evidence: Path,
) -> dict[str, Any]:
    """Write a safe review-only AutoDL job; this never calls AutoDL."""

    if output.exists():
        raise ProtocolError(f"refusing to overwrite Job TOML: {output}")
    if max_runtime_seconds < 1:
        raise ProtocolError("max_runtime_seconds must be positive")
    manifest = load_manifest(manifest_path)
    _validate_dry_run_evidence(dry_run_evidence, manifest)
    _, tasks, games = load_task_bundle(manifest, bundle_directory)
    if len(tasks) != 85 or len(games) != 8320:
        raise ProtocolError("AutoDL job requires the exact materialized P0 bundle")
    local_runner = Path(__file__).resolve()
    code_path = code_path.resolve()
    stage_manifest_path = code_path / "autodl_stage_manifest.json"
    if not stage_manifest_path.is_file():
        raise ProtocolError(
            "code_path must be an immutable minimal stage from prepare-autodl-stage"
        )
    stage_manifest = _read_json(stage_manifest_path)
    if (
        stage_manifest.get("schema_name") != "lifeline-d17-d19-autodl-stage"
        or stage_manifest.get("status") != "prepared_not_run"
        or stage_manifest.get("manifest_sha256") != manifest_hash(manifest)
        or stage_manifest.get("dry_run_evidence_sha256") != sha256_file(dry_run_evidence)
    ):
        raise ProtocolError("AutoDL stage manifest is stale or belongs to another run")

    def staged_relative(source: Path) -> Path:
        try:
            relative = source.resolve().relative_to(REPO_ROOT.resolve())
        except ValueError as exc:
            raise ProtocolError(f"AutoDL input is outside the repository: {source}") from exc
        staged = code_path / relative
        if not staged.is_file() or sha256_file(staged) != sha256_file(source):
            raise ProtocolError(f"AutoDL stage is missing or stale: {relative}")
        return relative

    remote_manifest = staged_relative(manifest_path)
    remote_bundle = bundle_directory.resolve().relative_to(REPO_ROOT.resolve())
    for required in ("tasks.jsonl", "game_manifest.jsonl", "bundle_summary.json"):
        staged_relative(bundle_directory / required)
    remote_runner = staged_relative(local_runner)
    remote_dry_run = staged_relative(dry_run_evidence)
    readiness_command = (
        f'"{local_python.resolve()}" -B "{local_runner}" readiness '
        f'--manifest "{manifest_path.resolve()}"'
    )
    gpu_smoke_command = (
        f"{remote_python} {remote_runner.as_posix()} gpu-smoke "
        f"--manifest {remote_manifest.as_posix()} --seconds 20 "
        "--profile-output $AUTODL_WORK_DIR/d17_d19_gpu_throughput.json"
    )
    command = (
        f"{remote_python} {remote_runner.as_posix()} run "
        f"--manifest {remote_manifest.as_posix()} "
        f"--bundle-dir {remote_bundle.as_posix()} "
        f"--dry-run-evidence {remote_dry_run.as_posix()} "
        "--run-root $AUTODL_WORK_DIR/d17_d19/"
        f"{BUNDLE_EXPERIMENT_ID}/formal_run --device cuda --continue-on-error "
        "--export-dir $AUTODL_EXPORT_DIR/d17_d19/"
        f"{BUNDLE_EXPERIMENT_ID} --confirm-formal"
    )
    content = "\n".join(
        [
            f'name = {_toml_string("lifeline-d17-d19-p0-formal-v1")}',
            "",
            f"image_uuid = {_toml_string(image_uuid)}",
            'framework = "pytorch"',
            'instance_reuse = "prefer"',
            "auto_release = false",
            'accelerator = "cuda"',
            "gpu_num = 1",
            "min_vram_gb = 8",
            "min_gpu_utilization_percent = 50",
            f"max_runtime_seconds = {max_runtime_seconds}",
            "",
            f"code_path = {_toml_string(str(code_path.resolve()))}",
            "input_paths = []",
            'setup_command = "python3 -m pip install -e research/iclr2027"',
            "",
            f"readiness_command = {_toml_string(readiness_command)}",
            "readiness_timeout_seconds = 300",
            f"gpu_smoke_command = {_toml_string(gpu_smoke_command)}",
            "gpu_smoke_timeout_seconds = 240",
            f"command = {_toml_string(command)}",
            "",
            "[environment]",
            'PYTHONUNBUFFERED = "1"',
            'OMP_NUM_THREADS = "2"',
            'MKL_NUM_THREADS = "2"',
            "",
        ]
    )
    _atomic_text(output, content, overwrite=False)
    return {
        "status": "job_toml_generated_not_run",
        "path": str(output.resolve()),
        "sha256": sha256_file(output),
        "image_uuid": image_uuid,
        "image_uuid_is_placeholder": image_uuid.startswith("REPLACE_WITH_"),
        "readiness_command": readiness_command,
        "gpu_smoke_command": gpu_smoke_command,
        "min_gpu_utilization_percent": 50,
        "formal_command": command,
        "instance_reuse": "prefer",
        "auto_release": False,
        "paid_action_performed": False,
        "minimal_stage_root": str(code_path),
        "stage_manifest_sha256": sha256_file(stage_manifest_path),
    }


def _copy_verified(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if not destination.is_file() or sha256_file(destination) != sha256_file(source):
            raise ProtocolError(f"export destination differs: {destination}")
        return
    shutil.copy2(source, destination)


def export_lightweight_results(run_root: Path, export_directory: Path) -> dict[str, Any]:
    """Export JSON summaries/receipts/game logs, never pair scratch artifacts."""

    export_directory.mkdir(parents=True, exist_ok=True)
    copied: list[dict[str, Any]] = []
    root_files = (
        "execution_metadata.json",
        "execution_summary.json",
        "result_ledger_status.json",
        "result_receipts.jsonl",
    )
    for name in root_files:
        source = run_root / name
        if source.is_file():
            destination = export_directory / name
            _copy_verified(source, destination)
            copied.append(
                {"path": str(destination.resolve()), "sha256": sha256_file(destination)}
            )
    tasks_root = run_root / "tasks"
    if tasks_root.is_dir():
        for task_directory in sorted(path for path in tasks_root.iterdir() if path.is_dir()):
            for name in ("receipt.json", "summary.json", "games.jsonl"):
                source = task_directory / name
                if not source.is_file():
                    continue
                destination = export_directory / "tasks" / task_directory.name / name
                _copy_verified(source, destination)
                copied.append(
                    {"path": str(destination.resolve()), "sha256": sha256_file(destination)}
                )
    manifest_path = export_directory / "export_manifest.json"
    payload = {
        "schema_name": "lifeline-d17-d19-lightweight-export",
        "schema_version": SCHEMA_VERSION,
        "source_run_root": str(run_root.resolve()),
        "files": copied,
        "pair_scratch_exported": False,
        "created_at_utc": _utc_now(),
    }
    if manifest_path.is_file():
        existing = _read_json(manifest_path)
        if existing.get("files") != payload["files"]:
            raise ProtocolError("existing export manifest differs from current results")
    else:
        _atomic_json(manifest_path, payload, overwrite=False)
    return payload


def p1_gate(
    status: Mapping[str, Any],
    *,
    remaining_budget_seconds: float | None,
    estimated_smoke_seconds: float | None,
    paid_change_approved: bool,
) -> dict[str, Any]:
    budget_passed = (
        remaining_budget_seconds is not None
        and estimated_smoke_seconds is not None
        and remaining_budget_seconds >= 2.0 * estimated_smoke_seconds
    )
    checks = {
        "p0_execution_complete": status.get("execution_complete") is True,
        "p0_independent_verification_passed": status.get(
            "independent_verification_passed"
        )
        is True,
        "p0_formal_ready": status.get("formal_ready") is True,
        "budget_at_least_twice_smoke_estimate": budget_passed,
        "paid_new_instance_or_card_change_approved_if_needed": paid_change_approved,
        "ppo_a2c_dqn_trpo_not_introduced": True,
    }
    return {
        "schema_name": "lifeline-d17-d19-p1-gate",
        "schema_version": SCHEMA_VERSION,
        "experiment_id": "d19_logic_edge_archmatched_smoke_v1",
        "status": "PASS" if all(checks.values()) else "BLOCKED",
        "checks": checks,
        "remaining_budget_seconds": remaining_budget_seconds,
        "estimated_smoke_seconds": estimated_smoke_seconds,
        "p1_execution_performed": False,
        "paper_claims_allowed": False,
        "completed_at_utc": _utc_now(),
    }


def _emit(payload: Mapping[str, Any], output: Path | None) -> None:
    if output is not None:
        _atomic_json(output, payload, overwrite=False)
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))


def _validate_dry_run_evidence(
    path: Path, manifest: Mapping[str, Any]
) -> dict[str, Any]:
    payload = _read_json(path)
    runner_path = Path(__file__).resolve()
    checks = payload.get("checks")
    checkpoint_audits = payload.get("checkpoints")
    if (
        payload.get("schema_name") != "lifeline-d17-d19-exact-dry-run"
        or payload.get("status") != "PASS"
        or payload.get("manifest_sha256") != manifest_hash(manifest)
        or payload.get("runner_sha256") != sha256_file(runner_path)
        or payload.get("experiments_sha256")
        != sha256_file(runner_path.with_name("d17_d19_experiments.py"))
        or payload.get("protocol_sha256") != manifest["protocol_sha256"]
        or payload.get("checkpoint_count") != 15
        or payload.get("task_shaped_checkpoint_bindings") != 15
        or payload.get("checkpoint_target_size_cells") != 65
        or payload.get("checkpoint_target_size_forward_cases") != 195
        or payload.get("fixture_forward_puct_checks") != 195
        or payload.get("gen_size_fixture_forward_puct_checks") != 60
        or payload.get("d16_v2_fixture_forward_puct_checks") != 135
        or not isinstance(payload.get("forward_cases"), list)
        or len(payload["forward_cases"]) != 195
        or not all(case.get("puct_checked") is True for case in payload["forward_cases"])
        or payload.get("formal_tasks_executed") != 0
        or not isinstance(checks, Mapping)
        or not checks
        or not all(value is True for value in checks.values())
        or checks.get("task_shaped_agent_specs") is not True
        or checks.get("source_training_receipt_sha256") is not True
        or not isinstance(checkpoint_audits, list)
        or len(checkpoint_audits) != 15
        or not all(
            isinstance(audit, Mapping)
            and isinstance(audit.get("task_id"), str)
            and bool(audit.get("task_id"))
            and isinstance(audit.get("task_agent_spec_sha256"), str)
            and len(audit["task_agent_spec_sha256"]) == 64
            and isinstance(audit.get("source_receipt_sha256"), str)
            and len(audit["source_receipt_sha256"]) == 64
            and Path(str(audit.get("source_receipt_path", ""))).is_file()
            and sha256_file(Path(str(audit["source_receipt_path"])))
            == audit["source_receipt_sha256"]
            for audit in checkpoint_audits
        )
    ):
        raise ProtocolError(
            "exact dry-run evidence is stale, incomplete, or bound to another runner"
        )
    return payload


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare-bundle")
    prepare.add_argument("--manifest", type=Path, required=True)
    prepare.add_argument("--bundle-dir", type=Path, required=True)

    for name in ("dry-run", "readiness"):
        child = commands.add_parser(name)
        child.add_argument("--manifest", type=Path, required=True)
        child.add_argument("--output", type=Path)

    for name in ("run", "status", "aggregate", "p1-gate"):
        child = commands.add_parser(name)
        child.add_argument("--manifest", type=Path, required=True)
        child.add_argument("--bundle-dir", type=Path, required=True)
        child.add_argument("--run-root", type=Path, required=True)

    run = commands.choices["run"]
    run.add_argument("--dry-run-evidence", type=Path, required=True)
    run.add_argument("--device", default="cpu")
    run.add_argument(
        "--task-kind", choices=("all", "gen_size", "d16_v2"), default="all"
    )
    run.add_argument("--max-tasks", type=int)
    run.add_argument("--retry-failed", action="store_true")
    run.add_argument("--continue-on-error", action="store_true")
    run.add_argument("--export-dir", type=Path)
    run.add_argument("--confirm-formal", action="store_true")

    p1 = commands.choices["p1-gate"]
    p1.add_argument("--remaining-budget-seconds", type=float)
    p1.add_argument("--estimated-smoke-seconds", type=float)
    p1.add_argument("--paid-change-approved", action="store_true")
    p1.add_argument("--output", type=Path)

    aggregate = commands.choices["aggregate"]
    aggregate.add_argument("--output", type=Path)

    smoke = commands.add_parser("gpu-smoke")
    smoke.add_argument("--manifest", type=Path, required=True)
    smoke.add_argument("--seconds", type=float, default=20.0)
    smoke.add_argument("--profile-output", type=Path)
    smoke.add_argument(
        "--batch-candidates", default="32,64,128,256,512,1024,2048,4096"
    )

    stage = commands.add_parser("prepare-autodl-stage")
    stage.add_argument("--manifest", type=Path, required=True)
    stage.add_argument("--bundle-dir", type=Path, required=True)
    stage.add_argument("--dry-run-evidence", type=Path, required=True)
    stage.add_argument("--output", type=Path, required=True)

    job = commands.add_parser("generate-job")
    job.add_argument("--manifest", type=Path, required=True)
    job.add_argument("--bundle-dir", type=Path, required=True)
    job.add_argument("--dry-run-evidence", type=Path, required=True)
    job.add_argument("--output", type=Path, required=True)
    job.add_argument("--code-path", type=Path, required=True)
    job.add_argument(
        "--image-uuid", default="REPLACE_WITH_COMPATIBLE_PYTORCH_IMAGE_UUID"
    )
    job.add_argument("--local-python", type=Path, default=Path(sys.executable))
    job.add_argument("--remote-python", default="python3")
    job.add_argument("--max-runtime-seconds", type=int, default=14400)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest_path = args.manifest.resolve()
        manifest = load_manifest(manifest_path)
        if args.command == "prepare-bundle":
            payload = write_task_bundle(manifest, args.bundle_dir)
            print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
        elif args.command == "dry-run":
            _emit(
                exact_dry_run(manifest, manifest_path=manifest_path), args.output
            )
        elif args.command == "readiness":
            _emit(readiness(manifest, manifest_path=manifest_path), args.output)
        elif args.command == "gpu-smoke":
            try:
                candidates = [
                    int(value.strip())
                    for value in str(args.batch_candidates).split(",")
                    if value.strip()
                ]
            except ValueError as exc:
                raise ProtocolError("--batch-candidates must be comma-separated integers") from exc
            _emit(
                gpu_smoke(
                    manifest,
                    manifest_path=manifest_path,
                    seconds=args.seconds,
                    profile_output=args.profile_output,
                    batch_candidates=candidates,
                ),
                None,
            )
        elif args.command == "prepare-autodl-stage":
            payload = prepare_autodl_stage(
                manifest_path=manifest_path,
                bundle_directory=args.bundle_dir.resolve(),
                dry_run_evidence=args.dry_run_evidence.resolve(),
                output=args.output.resolve(),
            )
            print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
        elif args.command == "generate-job":
            payload = generate_job_toml(
                manifest_path=manifest_path,
                bundle_directory=args.bundle_dir.resolve(),
                output=args.output.resolve(),
                code_path=args.code_path.resolve(),
                image_uuid=args.image_uuid,
                local_python=args.local_python,
                remote_python=args.remote_python,
                max_runtime_seconds=args.max_runtime_seconds,
                dry_run_evidence=args.dry_run_evidence.resolve(),
            )
            print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
        else:
            materialized, tasks, games = load_task_bundle(
                manifest, args.bundle_dir
            )
            if manifest_hash(materialized) != tasks[0]["materialized_manifest_sha256"]:
                raise ProtocolError("bundle materialized-manifest binding failed")
            if args.command == "status":
                payload = status_summary(
                    manifest,
                    tasks,
                    games,
                    manifest_path=manifest_path,
                    bundle_directory=args.bundle_dir.resolve(),
                    run_root=args.run_root.resolve(),
                )
            elif args.command == "aggregate":
                canonical_output = (
                    args.output.resolve()
                    if args.output is not None
                    else args.run_root.resolve() / "canonical_numeric.json"
                )
                payload = canonical_aggregate(
                    manifest,
                    tasks,
                    games,
                    manifest_path=manifest_path,
                    bundle_directory=args.bundle_dir.resolve(),
                    run_root=args.run_root.resolve(),
                    output=canonical_output,
                )
            elif args.command == "p1-gate":
                status = status_summary(
                    manifest,
                    tasks,
                    games,
                    manifest_path=manifest_path,
                    bundle_directory=args.bundle_dir.resolve(),
                    run_root=args.run_root.resolve(),
                )
                payload = p1_gate(
                    status,
                    remaining_budget_seconds=args.remaining_budget_seconds,
                    estimated_smoke_seconds=args.estimated_smoke_seconds,
                    paid_change_approved=args.paid_change_approved,
                )
                _emit(payload, args.output)
                return 0 if payload["status"] == "PASS" else 2
            else:
                if not args.confirm_formal:
                    raise ProtocolError(
                        "formal execution is locked; pass --confirm-formal only after review"
                    )
                if args.max_tasks is not None and args.max_tasks < 1:
                    raise ProtocolError("--max-tasks must be positive")
                _validate_dry_run_evidence(args.dry_run_evidence.resolve(), manifest)
                payload = run_bundle(
                    manifest,
                    tasks,
                    games,
                    manifest_path=manifest_path,
                    bundle_directory=args.bundle_dir.resolve(),
                    run_root=args.run_root.resolve(),
                    device=args.device,
                    task_kind=args.task_kind,
                    max_tasks=args.max_tasks,
                    retry_failed=args.retry_failed,
                    continue_on_error=args.continue_on_error,
                )
                if args.export_dir is not None:
                    payload = {
                        **payload,
                        "lightweight_export": export_lightweight_results(
                            args.run_root.resolve(), args.export_dir.resolve()
                        ),
                    }
            print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
    except ProtocolError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
