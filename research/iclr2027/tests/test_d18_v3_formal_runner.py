"""Pure structural tests for the D18-v3 formal execution layer.

These tests never call readiness, GPU smoke, a formal run, or model
construction.  A bounded CPU canary plays only synthetic six-ply pairs to
exercise the real spawned-worker serialization and arena record path.
"""

from __future__ import annotations

import ast
import copy
import inspect
import json
import math
import random
import sys
import time

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 uses the locked backport.
    import tomli as tomllib
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import pytest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_formal_runner as formal  # noqa: E402
import d18_v3_verify_evidence as independent  # noqa: E402


def _fake_scalar_lane_record(payload: dict[str, object]) -> dict[str, object]:
    """Return a deterministic trajectory-shaped record without an arena/model."""

    index = int(payload["game_index"])
    if payload.get("fail"):
        raise RuntimeError(f"synthetic worker failure {index}")
    # Invert completion order under the injected thread executor.  The shared
    # lane executor must still return the canonical input order.
    time.sleep(0.001 * (5 - index))
    rng = random.Random(int(payload["seed"]))
    actions = [rng.randrange(82) for _ in range(12)]
    return {
        "game_index": index,
        "seed": int(payload["seed"]),
        "actions": actions,
        "trajectory_hash": formal.canonical_sha256(actions),
    }


def _raise_broken_pool(_: object) -> None:
    raise BrokenProcessPool("synthetic broken worker pool")


class _CanaryAgent:
    def __init__(self, name: str) -> None:
        self.name = name

    def select_action(self, game: object, rng: random.Random) -> object:
        points = sorted(
            action
            for action in getattr(game, "legal_moves")()
            if action is not None
        )
        options = [*points, None]
        return options[rng.randrange(len(options))]

    def diagnostics(self) -> dict[str, object]:
        return {
            "algorithm": "fake-puct-canary",
            "simulations": 16,
            "selected_visits": 8,
            "root_visit_sum": 16,
        }


def _bind_canary_agents() -> None:
    formal._initialize_formal_lane_worker({}, str(formal.DEFAULT_MANIFEST), "cpu")
    formal._FORMAL_LANE_AGENT_CACHE[("canary-a", "cpu")] = _CanaryAgent("canary-a")
    formal._FORMAL_LANE_AGENT_CACHE[("canary-b", "cpu")] = _CanaryAgent("canary-b")


def _initialize_spawn_canary_agents() -> None:
    """Use the production initializer contract inside a spawned subprocess."""

    _bind_canary_agents()


def _canary_pair_payload() -> dict[str, object]:
    from lifeline_rl import LifelineGame

    game = LifelineGame(5, superko_mode="enforce")
    schedules = []
    for member in (0, 1):
        schedules.append(
            {
                "schema_name": formal.prep.GAME_SCHEDULE_SCHEMA_NAME,
                "schema_version": formal.prep.SCHEMA_VERSION,
                "task_id": "canary-task",
                "game_id": f"canary-game-{member}",
                "pair_id": "canary-pair",
                "pair_index": 0,
                "pair_member": member,
                "eval_size": 5,
                "superko_mode": "enforce",
                "opening_actions": [],
                "opening_id": "canary-empty",
                "opening_prefix_hash": formal.canonical_sha256([]),
                "opening_stratum": "canary-stratum",
                "opening_variant": 0,
                "opening_state_hash": game.state_fingerprint(),
                "training_seed": 20260825,
                "policy_seed_a": 100,
                "policy_seed_b": 200,
                "policy_seed_assignment": {"A": 100, "B": 200},
                "runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
                "black_slot": "A" if member == 0 else "B",
                "white_slot": "B" if member == 0 else "A",
                "black_policy_seed": 100 if member == 0 else 200,
                "white_policy_seed": 200 if member == 0 else 100,
                "max_plies": 6,
            }
        )
    return {
        "task": {
            "agent_bindings": {
                "A": {"checkpoint_id": "canary-a"},
                "B": {"checkpoint_id": "canary-b"},
            }
        },
        "schedules": schedules,
    }


def _canary_pairs(count: int) -> dict[int, list[dict[str, object]]]:
    payload = _canary_pair_payload()
    base_schedules = payload["schedules"]
    assert isinstance(base_schedules, list)
    return {
        pair_index: [
            {
                **copy.deepcopy(base_schedules[member]),
                "game_id": f"canary-game-{pair_index}-{member}",
                "game_index": pair_index * 2 + member,
                "pair_id": f"canary-pair-{pair_index}",
                "pair_index": pair_index,
            }
            for member in range(2)
        ]
        for pair_index in range(count)
    }


def _without_timings(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _without_timings(item)
            for key, item in value.items()
            if not key.endswith("seconds")
        }
    if isinstance(value, list):
        return [_without_timings(item) for item in value]
    return value


def _smoke_opening_and_trace(
    size: int, *, decisions: int = 4, max_plies: int = 256
) -> tuple[dict[str, object], list[str], list[int], int]:
    from lifeline_rl import LifelineGame

    prototype = LifelineGame(size, superko_mode="enforce")
    opening_actions = [prototype.point_to_index[prototype.legal_moves()[0]]]

    def opening_game() -> LifelineGame:
        game = LifelineGame(size, superko_mode="enforce")
        result = game.play_move(game.valid_positions[opening_actions[0]])
        assert result.success and not game.game_over
        return game

    initial = opening_game()
    opening = {
        "opening_id": f"opening-n{size}",
        "opening_actions": opening_actions,
        "opening_prefix_hash": formal.canonical_sha256(opening_actions),
        "opening_state_hash": initial.state_fingerprint(),
    }
    game = initial
    plies = len(opening_actions)
    fingerprints: list[str] = []
    action_indices: list[int] = []
    resets = 0
    for _ in range(decisions):
        fingerprints.append(game.state_fingerprint())
        action_indices.append(game.num_points)
        result = game.skip_turn()
        assert result.success
        plies += 1
        if game.game_over or plies >= max_plies:
            game = opening_game()
            plies = len(opening_actions)
            resets += 1
    return opening, fingerprints, action_indices, resets


def _write_valid_throughput_profile(
    root: Path,
) -> tuple[
    Path,
    Path,
    dict[str, object],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    manifest_path = root / "formal_manifest.json"
    manifest_path.write_text("{}\n", encoding="utf-8", newline="\n")
    tasks: list[dict[str, object]] = []
    games: list[dict[str, object]] = []
    traces = {
        size: _smoke_opening_and_trace(size, decisions=64)
        for size in formal.PROFILE_EVAL_SIZES
    }
    for pair in formal.PROFILE_MODEL_PAIRS:
        for size in formal.PROFILE_EVAL_SIZES:
            for seed_offset in range(5):
                seed = 20260825 + seed_offset
                task_id = f"{pair[0]}-vs-{pair[1]}-n{size}-s{seed}"
                pair_plan: list[dict[str, object]] = []
                for pair_index in range(formal.EXPECTED_PAIRS_PER_TASK):
                    pair_id = f"{task_id}.pair-{pair_index:02d}"
                    game_ids = [
                        f"{pair_id}.member-{member}" for member in (0, 1)
                    ]
                    plan = {
                        **copy.deepcopy(traces[size][0]),
                        "pair_id": pair_id,
                        "pair_index": pair_index,
                        "game_ids": game_ids,
                        "stratum_id": f"n{size}_s{pair_index:02d}",
                        "variant_index": 0,
                        "policy_seed_a": seed * 1000 + pair_index * 2,
                        "policy_seed_assignment": 0,
                        "policy_seed_b": seed * 1000 + pair_index * 2 + 1,
                        "stratum_index": pair_index,
                    }
                    pair_plan.append(plan)
                    for member in (0, 1):
                        raw_schedule = {
                            "task_id": task_id,
                            "game_id": game_ids[member],
                            "pair_id": pair_id,
                            "pair_member": member,
                            "opening_actions": copy.deepcopy(plan["opening_actions"]),
                            "opening_id": plan["opening_id"],
                            "opening_prefix_hash": plan["opening_prefix_hash"],
                            "opening_state_hash": plan["opening_state_hash"],
                            "opening_stratum": plan["stratum_id"],
                            "opening_variant": plan["variant_index"],
                            "policy_seed_a": plan["policy_seed_a"],
                            "policy_seed_assignment": plan[
                                "policy_seed_assignment"
                            ],
                            "policy_seed_b": plan["policy_seed_b"],
                            "stratum_index": plan["stratum_index"],
                            "black_slot": "A" if member == 0 else "B",
                            "white_slot": "B" if member == 0 else "A",
                        }
                        games.append(
                            {
                                **raw_schedule,
                                "eval_size": size,
                                "pair_index": pair_index,
                                "frozen_game_schedule_sha256": (
                                    formal.canonical_sha256(raw_schedule)
                                ),
                            }
                        )
                tasks.append(
                    {
                        "task_id": task_id,
                        "model_pair": list(pair),
                        "eval_size": size,
                        "training_seed": seed,
                        "games": formal.EXPECTED_GAMES_PER_TASK,
                        "max_plies": 256,
                        "superko_mode": "enforce",
                        "agent_bindings": {
                            "A": {
                                "checkpoint_id": f"{pair[0]}-{seed}",
                                "model_kind": pair[0],
                            },
                            "B": {
                                "checkpoint_id": f"{pair[1]}-{seed}",
                                "model_kind": pair[1],
                            },
                        },
                        "pair_plan": pair_plan,
                    }
                )
    checkpoint_ids = sorted(
        {
            str(binding["checkpoint_id"])
            for task in tasks
            for binding in task["agent_bindings"].values()
        }
    )
    case_payloads = formal._gpu_smoke_case_payloads(
        tasks, games, seconds=formal.GPU_SMOKE_REQUESTED_SECONDS
    )
    task_shaped_seconds = 28.0
    workflow_wall_seconds = 32.0
    lane_decisions = 64
    per_agent_decisions = lane_decisions // 2
    lane_forwards = lane_decisions * 17
    per_agent_forwards = lane_forwards // 2
    lane_results: list[dict[str, object]] = []
    for payloads in case_payloads:
        for payload in payloads:
            task = payload["task"]
            opening = payload["opening"]
            schedule = payload["schedule"]
            assert (
                isinstance(task, dict)
                and isinstance(opening, dict)
                and isinstance(schedule, dict)
            )
            bindings = task["agent_bindings"]
            assert isinstance(bindings, dict)
            _, fingerprints, action_indices, game_resets = traces[
                int(task["eval_size"])
            ]
            agents = []
            for slot in ("A", "B"):
                binding = bindings[slot]
                assert isinstance(binding, dict)
                agents.append(
                    {
                        "agent_slot": slot,
                        "checkpoint_id": binding["checkpoint_id"],
                        "model_kind": binding["model_kind"],
                    }
                )
            resident_integrity = (
                {
                    "worker_pid": 10_000 + int(payload["lane_index"]),
                    "checkpoint_ids": list(checkpoint_ids),
                    "checkpoint_count": len(checkpoint_ids),
                    "tensor_count": 150,
                    "device_baseline_storage": "immutable_cuda_clone",
                    "all_state_tensors_unchanged": True,
                    "all_parameter_gradients_none": True,
                }
                if payload["verify_resident_integrity"]
                else None
            )
            lane_results.append(
                {
                    "case_index": payload["case_index"],
                    "lane_index": payload["lane_index"],
                    "worker_pid": 10_000 + int(payload["lane_index"]),
                    "coverage_case_id": payload["coverage_case_id"],
                    "task_id": task["task_id"],
                    "game_id": schedule["game_id"],
                    "pair_id": schedule["pair_id"],
                    "pair_member": schedule["pair_member"],
                    "frozen_game_schedule_sha256": schedule[
                        "frozen_game_schedule_sha256"
                    ],
                    "training_seed": task["training_seed"],
                    "model_pair": task["model_pair"],
                    "black_slot": schedule["black_slot"],
                    "white_slot": schedule["white_slot"],
                    "agents": agents,
                    "agent_slots_exercised": ["A", "B"],
                    "warmup_puct_decisions": 2,
                    "resident_integrity": resident_integrity,
                    "eval_size": task["eval_size"],
                    "opening_id": opening["opening_id"],
                    "puct_decisions": lane_decisions,
                    "per_agent_puct_decisions": {
                        "A": per_agent_decisions,
                        "B": per_agent_decisions,
                    },
                    "decision_seconds": [0.01] * lane_decisions,
                    "decision_state_fingerprints": list(fingerprints),
                    "decision_action_indices": list(action_indices),
                    "slowest_decision_seconds": 0.01,
                    "unique_state_count": len(set(fingerprints)),
                    "game_resets": game_resets,
                    "model_forward_calls": lane_forwards,
                    "per_agent_model_forward_calls": {
                        "A": per_agent_forwards,
                        "B": per_agent_forwards,
                    },
                    "setup_seconds": 0.25,
                    "sustained_seconds": (
                        task_shaped_seconds / formal.GPU_SMOKE_CASE_COUNT
                    ),
                    "total_seconds": 3.5,
                    "gpu_utilization_samples_percent": [60.0],
                    "max_memory_allocated_bytes": 128 * 1024**2,
                    "max_memory_reserved_bytes": 160 * 1024**2,
                    "device_free_memory_bytes": 14 * 1024**3,
                    "device": "cuda",
                    "device_name": "NVIDIA GeForce RTX 5090",
                    "device_total_memory_bytes": 32 * 1024**3,
                    "torch_version": "2.8.0+cu128",
                    "cuda_runtime_version": "12.8",
                }
            )
    preload_results = [
        {
            "lane_index": lane_index,
            "worker_pid": 10_000 + lane_index,
            "checkpoint_ids": list(checkpoint_ids),
            "checkpoint_count": len(checkpoint_ids),
            "device_baseline_checkpoint_ids": list(checkpoint_ids),
            "device_baseline_checkpoint_count": len(checkpoint_ids),
            "device_baseline_tensor_count": 150,
            "device_baseline_storage": "immutable_cuda_clone",
            "max_memory_allocated_bytes": 1024**3,
            "max_memory_reserved_bytes": 1_280 * 1024**2,
            "device_free_memory_bytes": 14 * 1024**3,
            "device_total_memory_bytes": 32 * 1024**3,
        }
        for lane_index in range(formal.SCALAR_LANE_COUNT)
    ]
    resident_workers = [
        {
            "worker_pid": 10_000 + lane_index,
            "max_memory_allocated_bytes": 1024**3,
            "max_memory_reserved_bytes": 1_280 * 1024**2,
        }
        for lane_index in range(formal.SCALAR_LANE_COUNT)
    ]
    decisions = (
        lane_decisions * formal.SCALAR_LANE_COUNT * formal.GPU_SMOKE_CASE_COUNT
    )
    forwards = lane_forwards * formal.SCALAR_LANE_COUNT * formal.GPU_SMOKE_CASE_COUNT
    aggregate_window = task_shaped_seconds
    rate = decisions / aggregate_window
    empirical_capacity_evidence = formal._validated_empirical_capacity_evidence()
    capacity_cases, projected = formal._formal_capacity_projection(
        lane_results,
        tasks,
        capacity_evidence=empirical_capacity_evidence,
    )
    worst_case_decisions = sum(
        int(task["games"]) * int(task["max_plies"]) for task in tasks
    )
    aggregate_allocated = formal.SCALAR_LANE_COUNT * 1024**3
    aggregate_reserved = formal.SCALAR_LANE_COUNT * 1_280 * 1024**2
    resident_integrity_results = [
        copy.deepcopy(row["resident_integrity"])
        for row in lane_results
        if row["resident_integrity"] is not None
    ]
    profile: dict[str, object] = {
        "schema_name": formal.THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": formal.THROUGHPUT_PROFILE_SCHEMA_VERSION,
        "status": "PASS",
        "experiment_id": formal.EXPERIMENT_ID,
        "formal_manifest_sha256": formal.sha256_file(manifest_path),
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "formal_games_executed": 0,
        "frozen_checkpoint_models": True,
        "device": "cuda",
        "device_name": "NVIDIA GeForce RTX 5090",
        "torch_version": "2.8.0+cu128",
        "cuda_runtime_version": "12.8",
        "inference_only": True,
        "training_mode": False,
        "amp_enabled": formal.AMP_ENABLED,
        "batch_calibration_performed": False,
        "selected_batch_size": formal.INFERENCE_BATCH_SIZE,
        "inference_batch_size": formal.INFERENCE_BATCH_SIZE,
        "inference_dtype": formal.INFERENCE_DTYPE,
        "scalar_lane_count": formal.SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": formal.SCALAR_LANE_EXECUTION_MODE,
        "production_equivalent_mode": True,
        "optimizer_steps": 0,
        "backward_calls": 0,
        "formal_numeric_path_match": True,
        "puct_simulations": 16,
        "temperature": 0.0,
        "root_noise": False,
        "data_supply": "registered_d18_v3_task_binding_and_opening_clone",
        "capacity_projection_method": formal.CAPACITY_PROJECTION_METHOD,
        "coverage": formal._profile_coverage(lane_results),
        "empirical_capacity_evidence": {
            "relative_path": formal._repo_relative(
                formal.EMPIRICAL_CAPACITY_EVIDENCE_PATH.resolve()
            ),
            "sha256": formal.EMPIRICAL_CAPACITY_EVIDENCE_EXPECTED_SHA256,
            "source_manifest_sha256": empirical_capacity_evidence[
                "source_manifest_sha256"
            ],
            "schema_name": formal.EMPIRICAL_CAPACITY_EVIDENCE_SCHEMA,
            "schema_version": (
                formal.EMPIRICAL_CAPACITY_EVIDENCE_SCHEMA_VERSION
            ),
        },
        "capacity_cases": capacity_cases,
        "input_parse_and_collate_seconds": 0.01,
        "setup_seconds": workflow_wall_seconds - task_shaped_seconds,
        "puct_decisions": decisions,
        "model_forward_calls": forwards,
        "requested_sustained_seconds": formal.GPU_SMOKE_REQUESTED_SECONDS,
        "requested_case_seconds": formal.GPU_SMOKE_REQUESTED_CASE_SECONDS,
        "sustained_seconds": task_shaped_seconds,
        "task_shaped_seconds": task_shaped_seconds,
        "task_shaped_seconds_semantics": formal.GPU_SMOKE_TASK_SHAPED_SEMANTICS,
        "task_shaped_max_seconds": formal.GPU_SMOKE_MAX_TASK_SHAPED_SECONDS,
        "atomic_tail_semantics": formal.GPU_SMOKE_ATOMIC_TAIL_SEMANTICS,
        "workflow_wall_seconds": workflow_wall_seconds,
        "workflow_wall_seconds_semantics": formal.GPU_SMOKE_WORKFLOW_WALL_SEMANTICS,
        "workflow_wall_max_seconds": formal.GPU_SMOKE_MAX_WORKFLOW_WALL_SECONDS,
        "workflow_overhead_seconds": workflow_wall_seconds - task_shaped_seconds,
        "workflow_overhead_seconds_semantics": (
            formal.GPU_SMOKE_WORKFLOW_OVERHEAD_SEMANTICS
        ),
        "timing_contract_version": formal.GPU_SMOKE_TIMING_CONTRACT_VERSION,
        "product_watchdog_seconds": formal.GPU_SMOKE_PRODUCT_TIMEOUT_SECONDS,
        "duration_seconds": workflow_wall_seconds,
        "total_seconds": workflow_wall_seconds,
        "aggregate_window_seconds": aggregate_window,
        "aggregate_puct_decisions_per_second": rate,
        "formal_game_count": formal.EXPECTED_GAMES,
        "formal_max_plies": 256,
        "worst_case_puct_decisions": worst_case_decisions,
        "formal_runtime_seconds": formal.MAX_RUNTIME_SECONDS,
        "non_gameplay_reserve_fraction": formal.FORMAL_NON_GAMEPLAY_RESERVE_FRACTION,
        "formal_gameplay_budget_seconds": formal.FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "projected_empirical_planning_seconds": projected,
        "lane_results": lane_results,
        "gpu_utilization_samples_percent": [60.0] * len(lane_results),
        "gpu_utilization_mean_percent": 60.0,
        "gpu_utilization_max_percent": 60.0,
        "aggregate_peak_memory_allocated_bytes": aggregate_allocated,
        "aggregate_peak_memory_reserved_bytes": aggregate_reserved,
        "aggregate_peak_memory_limit_bytes": formal.MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "minimum_device_memory_bytes": formal.MIN_DEVICE_MEMORY_BYTES,
        "minimum_device_free_headroom_bytes": formal.MIN_DEVICE_FREE_HEADROOM_BYTES,
        "device_total_memory_bytes": 32 * 1024**3,
        "device_free_memory_before_preload_bytes": 30 * 1024**3,
        "device_free_memory_after_smoke_bytes": 14 * 1024**3,
        "device_used_memory_after_smoke_bytes": 18 * 1024**3,
        "resident_checkpoint_count_per_worker": 15,
        "resident_cache_preload_results": preload_results,
        "resident_integrity_check_mode": (
            "final_case_all_checkpoints_against_preload_cuda_clones"
        ),
        "resident_integrity_worker_count": formal.SCALAR_LANE_COUNT,
        "resident_integrity_results": resident_integrity_results,
        "resident_worker_memory": resident_workers,
    }
    profile_path = root / "throughput.json"
    profile_path.write_text(
        json.dumps(profile, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest_path, profile_path, profile, tasks, games


def _checkpoint_registry_from_tasks(
    tasks: list[dict[str, object]],
) -> dict[tuple[str, int], dict[str, object]]:
    registry: dict[tuple[str, int], dict[str, object]] = {}
    for task in tasks:
        seed = int(task["training_seed"])
        bindings = task["agent_bindings"]
        assert isinstance(bindings, dict)
        for slot in ("A", "B"):
            binding = bindings[slot]
            assert isinstance(binding, dict)
            kind = str(binding["model_kind"])
            registry[(kind, seed)] = {
                **binding,
                "training_seed": seed,
            }
    return registry


def _rebind_profile_aggregate_timing(profile: dict[str, object]) -> None:
    lanes = profile["lane_results"]
    assert isinstance(lanes, list)
    aggregate_window = sum(
        max(
            float(row["sustained_seconds"])
            for row in lanes
            if int(row["case_index"]) == case_index
        )
        for case_index in range(formal.GPU_SMOKE_CASE_COUNT)
    )
    workflow_wall = float(profile["workflow_wall_seconds"])
    decisions = int(profile["puct_decisions"])
    profile["sustained_seconds"] = aggregate_window
    profile["task_shaped_seconds"] = aggregate_window
    profile["aggregate_window_seconds"] = aggregate_window
    profile["aggregate_puct_decisions_per_second"] = decisions / aggregate_window
    profile["workflow_overhead_seconds"] = workflow_wall - aggregate_window
    profile["setup_seconds"] = workflow_wall - aggregate_window


def _group_schedules_by_task(
    games: list[dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    grouped: dict[str, list[dict[str, object]]] = {}
    for game in games:
        grouped.setdefault(str(game["task_id"]), []).append(game)
    return grouped


def _minimal_export_tree(root: Path, task_directory_name: str = "synthetic-task") -> None:
    for name in (
        "canonical_numeric.json",
        "execution_metadata.json",
        "execution_summary.json",
        "result_receipts.jsonl",
        formal.THROUGHPUT_PROFILE_ARTIFACT_NAME,
    ):
        (root / name).write_bytes(b"{}\n")
    task_root = root / "tasks" / task_directory_name
    pairs = task_root / "pairs"
    pairs.mkdir(parents=True)
    for name in ("games.jsonl", "receipt.json", "summary.json"):
        (task_root / name).write_bytes(b"{}\n")
    (pairs / "pair_0000.json").write_bytes(b"{}\n")


def _minimal_autodl_stage(root: Path) -> str:
    bindings = {
        formal._repo_relative(formal.SCRIPT_PATH): (
            b"formal runner",
            "formal_runner_sha256",
        ),
        formal._repo_relative(formal.prep.SCRIPT_PATH): (
            b"preparation runner",
            "preparation_runner_sha256",
        ),
        formal._repo_relative(formal.VERIFIER_PATH): (
            b"independent verifier",
            "verifier_sha256",
        ),
        "research/iclr2027/configs/synthetic_d18_v3_manifest.json": (
            b"formal manifest",
            "formal_manifest_sha256",
        ),
        "research/iclr2027/autodl/d18_v3_runtime_requirements.lock.txt": (
            b"dependency lock",
            "dependency_lock_sha256",
        ),
        formal._repo_relative(formal.EMPIRICAL_CAPACITY_EVIDENCE_PATH): (
            formal.EMPIRICAL_CAPACITY_EVIDENCE_PATH.read_bytes(),
            "empirical_capacity_evidence_sha256",
        ),
        "research/iclr2027/results/formal/d18_v3/synthetic/task_bundle/bundle_summary.json": (
            b"bundle summary",
            "bundle_summary_sha256",
        ),
        "research/iclr2027/results/formal/d18_v3/synthetic/task_bundle/tasks.jsonl": (
            b"task manifest",
            "task_manifest_sha256",
        ),
        "research/iclr2027/results/formal/d18_v3/synthetic/task_bundle/game_manifest.jsonl": (
            b"game manifest",
            "game_manifest_sha256",
        ),
        "research/iclr2027/results/formal/d18_v3/synthetic/task_bundle/manifest_snapshot.json": (
            b"manifest snapshot",
            "manifest_snapshot_sha256",
        ),
    }
    rows: list[dict[str, object]] = []
    manifest_hashes: dict[str, str] = {}
    for relative, (content, field) in bindings.items():
        path = root / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        digest = formal.sha256_file(path)
        rows.append({"path": relative, "sha256": digest, "bytes": len(content)})
        manifest_hashes[field] = digest
    manifest = {
        "schema_name": formal.STAGE_SCHEMA,
        "schema_version": formal.SCHEMA_VERSION,
        "status": "prepared_not_run",
        "experiment_id": formal.EXPERIMENT_ID,
        **manifest_hashes,
        "semantic_bindings": {
            field: relative for relative, (_, field) in bindings.items()
        },
        "file_count": len(rows),
        "total_bytes": sum(int(row["bytes"]) for row in rows),
        "files": rows,
        "formal_games_executed": 0,
        "paid_actions": 0,
        "created_at_utc": "test",
    }
    manifest_path = root / "autodl_stage_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return formal.sha256_file(manifest_path)


def _mock_task_and_schedules() -> tuple[dict[str, object], list[dict[str, object]]]:
    task_id = "mock.d18v3.task"
    plans: list[dict[str, object]] = []
    schedules: list[dict[str, object]] = []
    prep_sha = formal.sha256_file(formal.prep.SCRIPT_PATH)
    game_index = 0
    for pair_index in range(formal.EXPECTED_PAIRS_PER_TASK):
        stratum = pair_index // 2
        variant = pair_index % 2
        pair_id = f"{task_id}.s{stratum:02d}.v{variant}"
        game_ids = [f"{pair_id}.m0", f"{pair_id}.m1"]
        plan = {
            "pair_id": pair_id,
            "pair_index": pair_index,
            "game_ids": game_ids,
            "opening_actions": [1, 2],
            "opening_id": f"opening-{stratum}-{variant}",
            "opening_prefix_hash": f"{pair_index + 1:064x}",
            "opening_state_hash": f"{pair_index + 101:064x}",
            "policy_seed_a": 10_000 + pair_index,
            "policy_seed_assignment": variant,
            "policy_seed_b": 20_000 + pair_index,
            "stratum_id": f"n5_s{stratum:02d}_p2",
            "stratum_index": stratum,
            "variant_index": variant,
        }
        plans.append(plan)
        for member in (0, 1):
            schedules.append(
                {
                    "task_id": task_id,
                    "pair_id": pair_id,
                    "pair_member": member,
                    "game_id": game_ids[member],
                    "game_index": game_index,
                    "opening_actions": [1, 2],
                    "opening_id": plan["opening_id"],
                    "opening_prefix_hash": plan["opening_prefix_hash"],
                    "opening_state_hash": plan["opening_state_hash"],
                    "opening_stratum": plan["stratum_id"],
                    "opening_variant": variant,
                    "policy_seed_a": plan["policy_seed_a"],
                    "policy_seed_assignment": variant,
                    "policy_seed_b": plan["policy_seed_b"],
                    "stratum_index": stratum,
                    "runner_sha256": prep_sha,
                }
            )
            game_index += 1
    task: dict[str, object] = {
        "task_id": task_id,
        "eval_size": 5,
        "pair_plan": plans,
    }
    return task, schedules


def _mock_gate_records() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for stratum in range(32):
        for variant in (0, 1):
            for member in (0, 1):
                rows.append(
                    {
                        "truncated": False,
                        "winner": "BLACK",
                        "black_slot": "A" if member == 0 else "B",
                        "white_slot": "B" if member == 0 else "A",
                        "pair_member": member,
                        "opening_variant": variant,
                        "opening_stratum": f"n5_s{stratum:02d}_p2",
                        "full_trajectory_hash": f"full-{stratum}-{variant}-{member}",
                        "continuation_trajectory_hash": f"continuation-{stratum}-{variant}",
                        "bound_trajectory_hash": f"bound-{stratum}-{variant}-{member}",
                    }
                )
    return rows


def _mock_gate_task() -> dict[str, object]:
    return {
        "games": 128,
        "formal_gates": {
            "min_unique_trajectories": 64,
            "min_unique_prefix_stripped_continuations": 32,
            "opening_strata": 32,
            "min_clusters_with_two_continuations": 24,
        },
    }


def test_runtime_schedule_adapter_is_exact_and_nonmutating() -> None:
    task, schedules = _mock_task_and_schedules()
    before = copy.deepcopy(schedules)
    bound = formal._bound_task_schedules(task, schedules)
    assert schedules == before
    assert len(bound) == 128
    assert [row["pair_index"] for row in bound[:4]] == [0, 0, 1, 1]
    assert {row["eval_size"] for row in bound} == {5}
    assert all(len(str(row["frozen_game_schedule_sha256"])) == 64 for row in bound)
    assert all(row["runner_sha256"] == formal.sha256_file(formal.prep.SCRIPT_PATH) for row in bound)


def test_runtime_schedule_adapter_rejects_task_game_drift() -> None:
    task, schedules = _mock_task_and_schedules()
    schedules[0]["opening_stratum"] = "tampered"
    with pytest.raises(formal.FormalExecutionError, match="task/game join"):
        formal._bound_task_schedules(task, schedules)


def test_scalar_lane_executor_matches_serial_fake_records_and_order() -> None:
    payloads = [
        {"game_index": index, "seed": 202608310000 + index}
        for index in range(6)
    ]
    with formal._ScalarLaneExecutor(
        1, executor_factory=ThreadPoolExecutor
    ) as serial_executor:
        serial = serial_executor.map_ordered(_fake_scalar_lane_record, payloads)
    with formal._ScalarLaneExecutor(
        4, executor_factory=ThreadPoolExecutor
    ) as concurrent_executor:
        concurrent = concurrent_executor.map_ordered(
            _fake_scalar_lane_record, payloads
        )

    assert concurrent == serial
    assert [row["game_index"] for row in concurrent] == list(range(6))
    assert all(len(row["actions"]) == 12 for row in concurrent)
    assert all(len(str(row["trajectory_hash"])) == 64 for row in concurrent)


def test_production_spawn_process_pool_matches_serial_records() -> None:
    payloads = [
        {"game_index": index, "seed": 202608311000 + index}
        for index in range(4)
    ]
    serial = [_fake_scalar_lane_record(payload) for payload in payloads]
    with formal._ScalarLaneExecutor(2) as spawned:
        concurrent = spawned.map_ordered(_fake_scalar_lane_record, payloads)
    assert concurrent == serial


def test_real_pair_lane_canary_matches_serial_and_concurrent_rng_and_hashes() -> None:
    payload = _canary_pair_payload()
    _bind_canary_agents()
    serial = formal._run_formal_pair_lane(copy.deepcopy(payload))
    _bind_canary_agents()
    with formal._ScalarLaneExecutor(
        2, executor_factory=ThreadPoolExecutor
    ) as concurrent_executor:
        concurrent = concurrent_executor.map_ordered(
            formal._run_formal_pair_lane,
            [copy.deepcopy(payload), copy.deepcopy(payload)],
        )
    assert all(_without_timings(row) == _without_timings(serial) for row in concurrent)
    games = serial["games"]
    assert isinstance(games, list) and len(games) == 2
    assert all(record["actions"] for record in games)
    assert all(record["full_trajectory_hash"] for record in games)
    assert all(record["final_state_hash"] for record in games)


def test_real_pair_lane_crosses_production_spawn_initializer_and_cache() -> None:
    payload = _canary_pair_payload()
    _bind_canary_agents()
    serial = formal._run_formal_pair_lane(copy.deepcopy(payload))
    with formal._ScalarLaneExecutor(
        2,
        initializer=_initialize_spawn_canary_agents,
    ) as spawned_executor:
        spawned = spawned_executor.map_ordered(
            formal._run_formal_pair_lane,
            [copy.deepcopy(payload), copy.deepcopy(payload)],
        )
    assert all(_without_timings(row) == _without_timings(serial) for row in spawned)
    assert all(
        record["full_trajectory_hash"] and record["final_state_hash"]
        for payload_row in spawned
        for record in payload_row["games"]
    )


def test_real_pair_lane_rejects_invalid_payload() -> None:
    with pytest.raises(formal.FormalExecutionError, match="task is missing"):
        formal._run_formal_pair_lane({})


def test_scalar_lane_executor_wraps_worker_failure_fail_closed() -> None:
    payloads = [
        {"game_index": index, "seed": 202608310100 + index, "fail": index == 2}
        for index in range(5)
    ]
    with formal._ScalarLaneExecutor(
        3, executor_factory=ThreadPoolExecutor
    ) as lane_executor:
        with pytest.raises(
            formal.FormalExecutionError,
            match=r"scalar lane worker failed: RuntimeError: synthetic worker failure 2",
        ):
            lane_executor.map_ordered(_fake_scalar_lane_record, payloads)


def test_scalar_lane_executor_wraps_broken_process_pool_fail_closed() -> None:
    with formal._ScalarLaneExecutor(
        2, executor_factory=ThreadPoolExecutor
    ) as lane_executor:
        with pytest.raises(
            formal.FormalExecutionError,
            match="BrokenProcessPool: synthetic broken worker pool",
        ):
            lane_executor.map_ordered(_raise_broken_pool, [{}, {}])


def test_formal_lane_initializer_deep_copies_and_clears_cache() -> None:
    manifest = {"nested": {"value": 1}}
    formal._FORMAL_LANE_AGENT_CACHE[("stale", "cpu")] = object()
    formal._FORMAL_LANE_DEVICE_BASELINES["stale"] = {"tensor": object()}
    formal._initialize_formal_lane_worker(manifest, str(formal.DEFAULT_MANIFEST), "cpu")
    manifest["nested"]["value"] = 2
    assert formal._FORMAL_LANE_MANIFEST == {"nested": {"value": 1}}
    assert formal._FORMAL_LANE_MANIFEST_PATH == formal.DEFAULT_MANIFEST.resolve()
    assert formal._FORMAL_LANE_DEVICE == "cpu"
    assert formal._FORMAL_LANE_AGENT_CACHE == {}
    assert formal._FORMAL_LANE_DEVICE_BASELINES == {}


def test_throughput_profile_is_required_and_accepts_exact_identity(
    tmp_path: Path,
) -> None:
    manifest_path, profile_path, profile, tasks, games = _write_valid_throughput_profile(
        tmp_path
    )
    assert formal._validate_throughput_profile(
        profile_path, manifest_path=manifest_path, tasks=tasks, games=games
    ) == profile
    with pytest.raises(
        formal.FormalExecutionError, match="formal throughput profile is missing"
    ):
        formal._validate_throughput_profile(
            tmp_path / "missing.json",
            manifest_path=manifest_path,
            tasks=tasks,
            games=games,
        )
    run_source = inspect.getsource(formal.run_bundle)
    assert run_source.index("_validate_throughput_profile") < run_source.index(
        "_validate_write_target"
    )


def test_resume_metadata_profile_mismatch_fails_before_profile_recovery_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    manifest_path, profile_path, _, tasks, games = _write_valid_throughput_profile(
        source_root
    )
    run_root = tmp_path / "run"
    run_root.mkdir()
    metadata_path = run_root / "execution_metadata.json"
    metadata_path.write_text(
        json.dumps({"throughput_profile_sha256": "0" * 64}, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    throughput_evidence = run_root / formal.THROUGHPUT_PROFILE_ARTIFACT_NAME
    writes: list[Path] = []

    monkeypatch.setattr(
        formal,
        "load_frozen_bundle",
        lambda *_: ({}, tasks, games, {}),
    )
    monkeypatch.setattr(
        formal,
        "_validate_write_target",
        lambda *_, **__: run_root,
    )

    def reject_any_atomic_write(path: Path, *_: object, **__: object) -> None:
        writes.append(path)
        raise AssertionError(f"unexpected write before identity failure: {path}")

    monkeypatch.setattr(formal, "_atomic_json", reject_any_atomic_write)
    with pytest.raises(
        formal.FormalExecutionError,
        match="metadata is bound to another throughput profile",
    ):
        formal.run_bundle(
            manifest_path,
            source_root,
            run_root,
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=True,
            throughput_profile=profile_path,
            _writer_lock_held=True,
        )
    assert writes == []
    assert metadata_path.is_file()
    assert not throughput_evidence.exists()


def test_resume_preflights_later_partial_pair_before_any_recovery_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    manifest_path, profile_path, _, tasks, games = _write_valid_throughput_profile(
        source_root
    )
    run_root = tmp_path / "run"
    run_root.mkdir()
    metadata = {
        "throughput_profile_sha256": formal.sha256_file(profile_path),
    }
    (run_root / "execution_metadata.json").write_text(
        json.dumps(metadata, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    later_task = tasks[-1]
    later_task_id = str(later_task["task_id"])
    later_directory = formal._task_directory(run_root, later_task_id)
    pairs_directory = later_directory / "pairs"
    pairs_directory.mkdir(parents=True)
    (later_directory / "state.json").write_text(
        json.dumps(
            {"task_id": later_task_id, "attempts": 1, "status": "pending"},
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (pairs_directory / "pair_0000.json").write_text("{}\n", encoding="utf-8")
    schedules = [
        {
            "task_id": later_task_id,
            "game_index": member,
            "pair_index": 0,
            "pair_member": member,
        }
        for member in (0, 1)
    ]
    source_identity = {
        "preparation_runner_sha256": "1" * 64,
        "formal_runner_sha256": "2" * 64,
        "execution_source_closure_sha256": "3" * 64,
    }
    writes: list[Path] = []

    monkeypatch.setattr(
        formal,
        "load_frozen_bundle",
        lambda *_: ({}, tasks, schedules, {}),
    )
    monkeypatch.setattr(
        formal,
        "_validate_write_target",
        lambda *_, **__: run_root,
    )
    monkeypatch.setattr(
        formal,
        "_execution_metadata",
        lambda *_, **__: metadata,
    )
    monkeypatch.setattr(
        formal,
        "_validate_throughput_profile",
        lambda *_, **__: json.loads(profile_path.read_text(encoding="utf-8")),
    )
    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        lambda *_: source_identity,
    )

    def reject_any_atomic_write(path: Path, *_: object, **__: object) -> None:
        writes.append(path)
        raise AssertionError(f"unexpected resume write before global preflight: {path}")

    monkeypatch.setattr(formal, "_atomic_json", reject_any_atomic_write)
    with pytest.raises(formal.FormalExecutionError, match="formal pair schema mismatch"):
        formal.run_bundle(
            manifest_path,
            source_root,
            run_root,
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=True,
            throughput_profile=profile_path,
            authorize_resume=True,
            _writer_lock_held=True,
        )
    assert writes == []
    assert not (run_root / formal.THROUGHPUT_PROFILE_ARTIFACT_NAME).exists()
    assert not formal._task_directory(run_root, str(tasks[0]["task_id"])).exists()


@pytest.mark.parametrize("unknown_kind", ("file", "directory"))
def test_resume_rejects_unknown_run_root_entry_before_any_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unknown_kind: str
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    manifest_path, profile_path, _, tasks, games = _write_valid_throughput_profile(
        source_root
    )
    run_root = tmp_path / "run"
    run_root.mkdir()
    (run_root / "execution_metadata.json").write_text("{}\n", encoding="utf-8")
    unknown = run_root / f"unknown-{unknown_kind}"
    if unknown_kind == "file":
        unknown.write_text("tamper\n", encoding="utf-8")
    else:
        unknown.mkdir()
    with pytest.raises(
        independent.VerificationError,
        match="formal run root contains an unknown or unsafe entry",
    ):
        independent._validate_run_root_entries(run_root)
    writes: list[Path] = []
    monkeypatch.setattr(
        formal,
        "load_frozen_bundle",
        lambda *_: ({}, tasks, games, {}),
    )
    monkeypatch.setattr(
        formal,
        "_validate_write_target",
        lambda *_, **__: run_root,
    )

    def reject_write(path: Path, *_: object, **__: object) -> None:
        writes.append(path)
        raise AssertionError(f"unexpected write before root preflight: {path}")

    monkeypatch.setattr(formal, "_atomic_json", reject_write)
    monkeypatch.setattr(formal, "_atomic_text", reject_write)
    with pytest.raises(
        formal.FormalExecutionError,
        match="formal run root contains an unknown or unsafe entry",
    ):
        formal.run_bundle(
            manifest_path,
            source_root,
            run_root,
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=True,
            throughput_profile=profile_path,
            authorize_resume=True,
            _writer_lock_held=True,
        )
    assert writes == []
    assert unknown.exists()
    assert not (run_root / formal.THROUGHPUT_PROFILE_ARTIFACT_NAME).exists()
    assert not (run_root / "tasks").exists()


@pytest.mark.parametrize(
    ("tamper_kind", "error"),
    (
        ("ledger", "terminal result ledger differs"),
        ("numeric", "terminal canonical numeric artifact differs"),
        ("summary", "terminal execution summary differs"),
        ("partial", "partial terminal artifacts"),
    ),
)
def test_resume_rejects_terminal_root_tamper_before_any_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tamper_kind: str,
    error: str,
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    manifest_path, profile_path, profile, tasks, games = _write_valid_throughput_profile(
        source_root
    )
    run_root = tmp_path / "run"
    run_root.mkdir()
    profile_sha256 = formal.sha256_file(profile_path)
    metadata = {"throughput_profile_sha256": profile_sha256}
    (run_root / "execution_metadata.json").write_text(
        formal.pretty_json(metadata), encoding="utf-8", newline="\n"
    )
    (run_root / formal.THROUGHPUT_PROFILE_ARTIFACT_NAME).write_bytes(
        profile_path.read_bytes()
    )
    receipts: list[dict[str, object]] = []
    games: list[dict[str, object]] = []
    for index, task in enumerate(tasks):
        task_id = str(task["task_id"])
        task_directory = formal._task_directory(run_root, task_id)
        task_directory.mkdir(parents=True)
        receipt = {
            "task_id": task_id,
            "games_path": "games.jsonl",
        }
        game = {"task_id": task_id, "game_index": index}
        (task_directory / "receipt.json").write_text(
            formal.pretty_json(receipt), encoding="utf-8", newline="\n"
        )
        (task_directory / "games.jsonl").write_text(
            formal._jsonl_text([game]), encoding="utf-8", newline="\n"
        )
        receipts.append(receipt)
        games.append(game)
    ledger_path = run_root / "result_receipts.jsonl"
    ledger_path.write_text(
        formal._jsonl_text(receipts), encoding="utf-8", newline="\n"
    )
    numeric = {"schema_name": "synthetic-terminal-numeric", "stable": True}
    numeric_path = run_root / "canonical_numeric.json"
    numeric_path.write_text(
        formal.pretty_json(numeric), encoding="utf-8", newline="\n"
    )
    status = {"execution_complete": True, "marker": "expected-complete-status"}
    summary = {
        **status,
        "result_receipts_path": "result_receipts.jsonl",
        "result_receipts_sha256": formal.sha256_file(ledger_path),
        "canonical_numeric_path": "canonical_numeric.json",
        "canonical_numeric_sha256": formal.sha256_file(numeric_path),
    }
    summary_path = run_root / "execution_summary.json"
    summary_path.write_text(
        formal.pretty_json(summary), encoding="utf-8", newline="\n"
    )
    if tamper_kind == "ledger":
        ledger_path.write_text("{}\n", encoding="utf-8", newline="\n")
    elif tamper_kind == "numeric":
        numeric_path.write_text(
            formal.pretty_json({**numeric, "stable": False}),
            encoding="utf-8",
            newline="\n",
        )
    elif tamper_kind == "summary":
        summary_path.write_text(
            formal.pretty_json({**summary, "marker": "tampered"}),
            encoding="utf-8",
            newline="\n",
        )
    else:
        numeric_path.unlink()

    monkeypatch.setattr(
        formal,
        "load_frozen_bundle",
        lambda *_: ({}, tasks, games, {}),
    )
    monkeypatch.setattr(
        formal,
        "_validate_throughput_profile",
        lambda *_, **__: copy.deepcopy(profile),
    )
    monkeypatch.setattr(
        formal,
        "_validate_write_target",
        lambda *_, **__: run_root,
    )
    monkeypatch.setattr(
        formal,
        "_execution_metadata",
        lambda *_, **__: metadata,
    )
    monkeypatch.setattr(formal, "_preflight_existing_task_tree", lambda *_, **__: None)
    monkeypatch.setattr(
        formal,
        "_current_status",
        lambda *_, **__: copy.deepcopy(status),
    )
    monkeypatch.setattr(
        formal,
        "_runner_numeric_artifact",
        lambda *_, **__: copy.deepcopy(numeric),
    )
    monkeypatch.setattr(formal, "EXPECTED_GAMES", len(games))
    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        lambda *_: {
            "preparation_runner_sha256": "1" * 64,
            "formal_runner_sha256": "2" * 64,
            "execution_source_closure_sha256": "3" * 64,
        },
    )
    writes: list[Path] = []

    def reject_write(path: Path, *_: object, **__: object) -> None:
        writes.append(path)
        raise AssertionError(f"unexpected resume write before terminal preflight: {path}")

    monkeypatch.setattr(formal, "_atomic_json", reject_write)
    monkeypatch.setattr(formal, "_atomic_text", reject_write)
    with pytest.raises(formal.FormalExecutionError, match=error):
        formal.run_bundle(
            manifest_path,
            source_root,
            run_root,
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=True,
            throughput_profile=profile_path,
            authorize_resume=True,
            _writer_lock_held=True,
        )
    assert writes == []


def test_parent_rejects_source_drift_before_pair_write_and_mixed_completion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _bind_canary_agents()
    payload = _canary_pair_payload()
    source_identity = {
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "execution_source_closure_sha256": "3" * 64,
    }
    payload["source_identity"] = source_identity
    pair = formal._run_formal_pair_lane(copy.deepcopy(payload))
    schedules = payload["schedules"]
    assert isinstance(schedules, list)
    assert pair["execution_source_closure_sha256"] == "3" * 64
    assert all(
        row["execution_source_closure_sha256"] == "3" * 64
        for row in pair["games"]
    )
    assert formal._validate_pair(
        pair,
        schedules,
        source_identity=source_identity,
    )
    audited = independent._audit_game(
        pair["games"][0],
        schedules[0],
        preparation_runner_sha=source_identity["preparation_runner_sha256"],
        formal_runner_sha=source_identity["formal_runner_sha256"],
        execution_source_closure_sha=source_identity[
            "execution_source_closure_sha256"
        ],
    )
    assert audited["game_id"] == schedules[0]["game_id"]
    tampered_game = copy.deepcopy(pair["games"][0])
    tampered_game["execution_source_closure_sha256"] = "4" * 64
    with pytest.raises(
        independent.VerificationError,
        match="execution-source closure binding mismatch",
    ):
        independent._audit_game(
            tampered_game,
            schedules[0],
            preparation_runner_sha=source_identity["preparation_runner_sha256"],
            formal_runner_sha=source_identity["formal_runner_sha256"],
            execution_source_closure_sha=source_identity[
                "execution_source_closure_sha256"
            ],
        )
    drifted_identity = {
        **source_identity,
        "execution_source_closure_sha256": "4" * 64,
    }
    with pytest.raises(
        formal.FormalExecutionError,
        match="game execution source closure binding mismatch",
    ):
        formal._validate_pair(
            pair,
            schedules,
            source_identity=drifted_identity,
        )

    class CompletedWorker:
        def map_ordered(self, worker: object, jobs: object) -> list[object]:
            del worker, jobs
            return [copy.deepcopy(pair)]

    closure_checks = 0

    def drift_after_worker(_: object) -> dict[str, str]:
        nonlocal closure_checks
        closure_checks += 1
        if closure_checks == 1:
            return source_identity
        raise formal.FormalExecutionError(
            "execution source closure changed during the formal run"
        )

    writes: list[Path] = []
    monkeypatch.setattr(formal, "_require_execution_source_closure", drift_after_worker)
    monkeypatch.setattr(
        formal,
        "_atomic_json",
        lambda path, *_args, **_kwargs: writes.append(path),
    )
    task_directory = tmp_path / "task"
    (task_directory / "pairs").mkdir(parents=True)
    with pytest.raises(
        formal.FormalExecutionError,
        match="execution source closure changed during the formal run",
    ):
        formal._execute_pair_lanes(
            payload["task"],
            {0: schedules},
            task_directory=task_directory,
            lane_executor=CompletedWorker(),  # type: ignore[arg-type]
            metadata={"frozen": True},
        )
    assert closure_checks == 2
    assert writes == []
    assert list((task_directory / "pairs").iterdir()) == []


def test_pair_batch_full_source_rehash_count_is_constant_for_64_pairs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _bind_canary_agents()
    payload = _canary_pair_payload()
    pairs = _canary_pairs(formal.EXPECTED_PAIRS_PER_TASK)
    source_identity = {
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "execution_source_closure_sha256": "3" * 64,
    }
    closure_checks = 0

    def count_full_rehash(_: object) -> dict[str, str]:
        nonlocal closure_checks
        closure_checks += 1
        return source_identity

    class RealCanaryWorker:
        def map_ordered(self, worker: object, jobs: object) -> list[object]:
            return [worker(job) for job in jobs]  # type: ignore[operator]

    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        count_full_rehash,
    )
    task_directory = tmp_path / "task"
    (task_directory / "pairs").mkdir(parents=True)
    formal._execute_pair_lanes(
        payload["task"],
        pairs,
        task_directory=task_directory,
        lane_executor=RealCanaryWorker(),  # type: ignore[arg-type]
        metadata={"frozen": True},
    )
    pair_paths = sorted((task_directory / "pairs").glob("pair_*.json"))
    assert len(pair_paths) == formal.EXPECTED_PAIRS_PER_TASK
    assert closure_checks == 3
    assert all(
        formal._read_json(path)["execution_source_closure_sha256"] == "3" * 64
        for path in pair_paths
    )
    unknown_pair_entry = task_directory / "pairs" / "ignored-directory"
    unknown_pair_entry.mkdir()
    with pytest.raises(
        formal.FormalExecutionError,
        match="pair evidence directory contains an unsafe entry",
    ):
        formal._pair_evidence(
            task_directory,
            [schedule for pair in pairs.values() for schedule in pair],
            source_identity=source_identity,
        )
    with pytest.raises(
        independent.VerificationError,
        match="pair artifact directory contains an unsafe entry",
    ):
        independent._validate_pair_directory_entries(task_directory / "pairs")


def test_pair_batch_detects_source_drift_after_writes_before_task_promotion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _bind_canary_agents()
    payload = _canary_pair_payload()
    pairs = _canary_pairs(2)
    source_identity = {
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "execution_source_closure_sha256": "3" * 64,
    }
    closure_checks = 0
    drifted = False

    def fail_full_rehash_after_write(_: object) -> dict[str, str]:
        nonlocal closure_checks
        closure_checks += 1
        if drifted:
            raise formal.FormalExecutionError(
                "execution source closure changed during the formal run"
            )
        return source_identity

    class RealCanaryWorker:
        def map_ordered(self, worker: object, jobs: object) -> list[object]:
            return [worker(job) for job in jobs]  # type: ignore[operator]

    original_atomic = formal._atomic_json

    def write_then_drift(path: Path, value: object, **kwargs: object) -> None:
        nonlocal drifted
        original_atomic(path, value, **kwargs)  # type: ignore[arg-type]
        drifted = True

    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        fail_full_rehash_after_write,
    )
    monkeypatch.setattr(formal, "_atomic_json", write_then_drift)
    task_directory = tmp_path / "task"
    (task_directory / "pairs").mkdir(parents=True)
    with pytest.raises(
        formal.FormalExecutionError,
        match="execution source closure changed during the formal run",
    ):
        formal._execute_pair_lanes(
            payload["task"],
            pairs,
            task_directory=task_directory,
            lane_executor=RealCanaryWorker(),  # type: ignore[arg-type]
            metadata={"frozen": True},
        )
    assert closure_checks == 3
    assert len(list((task_directory / "pairs").glob("pair_*.json"))) == 2
    assert not (task_directory / "games.jsonl").exists()
    assert not (task_directory / "summary.json").exists()
    assert not (task_directory / "receipt.json").exists()


def test_gpu_smoke_payloads_partition_one_total_and_round_robin_frozen_tasks(
    tmp_path: Path,
) -> None:
    _, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    phases = formal._gpu_smoke_case_payloads(
        tasks, games, seconds=formal.GPU_SMOKE_REQUESTED_SECONDS
    )
    assert len(phases) == formal.GPU_SMOKE_CASE_COUNT
    assert all(len(phase) == formal.SCALAR_LANE_COUNT for phase in phases)
    assert math.isclose(
        sum(float(phase[0]["seconds"]) for phase in phases),
        formal.GPU_SMOKE_REQUESTED_SECONDS,
        rel_tol=1e-12,
        abs_tol=1e-12,
    )
    assert all(
        math.isclose(
            float(payload["seconds"]),
            formal.GPU_SMOKE_REQUESTED_CASE_SECONDS,
            rel_tol=1e-12,
            abs_tol=1e-12,
        )
        for phase in phases
        for payload in phase
    )
    expected_seeds = [
        formal.prep.TRAINING_SEEDS[index % len(formal.prep.TRAINING_SEEDS)]
        for index in range(formal.SCALAR_LANE_COUNT)
    ]
    assert all(
        [int(payload["task"]["training_seed"]) for payload in phase]
        == expected_seeds
        for phase in phases
    )
    assert all(
        payload["verify_resident_integrity"]
        == (case_index == formal.GPU_SMOKE_CASE_COUNT - 1)
        for case_index, phase in enumerate(phases)
        for payload in phase
    )
    assert all(
        "black_slot" not in task["pair_plan"][0]
        and "white_slot" not in task["pair_plan"][0]
        for task in tasks
    )
    assert all(
        payload["schedule"]["game_id"]
        == payload["task"]["pair_plan"][0]["game_ids"][0]
        and payload["schedule"]["pair_member"] == 0
        and (
            payload["schedule"]["black_slot"],
            payload["schedule"]["white_slot"],
        )
        == ("A", "B")
        for phase in phases
        for payload in phase
    )
    lanes = profile["lane_results"]
    preloads = profile["resident_cache_preload_results"]
    assert isinstance(lanes, list) and len(lanes) == 9 * 12
    assert isinstance(preloads, list) and len(preloads) == 12
    assert len({row["worker_pid"] for row in preloads}) == 12
    assert all(
        row["checkpoint_count"] == 15
        and len(set(row["checkpoint_ids"])) == 15
        and row["device_baseline_checkpoint_ids"] == row["checkpoint_ids"]
        and row["device_baseline_checkpoint_count"] == 15
        and row["device_baseline_storage"] == "immutable_cuda_clone"
        for row in preloads
    )
    assert all(
        row["agent_slots_exercised"] == ["A", "B"]
        and {row["black_slot"], row["white_slot"]} == {"A", "B"}
        and len(row["decision_action_indices"]) == row["puct_decisions"]
        for row in lanes
    )
    integrity = profile["resident_integrity_results"]
    assert isinstance(integrity, list) and len(integrity) == 12
    assert {row["worker_pid"] for row in integrity} == {
        row["worker_pid"] for row in preloads
    }
    assert all(
        row["checkpoint_count"] == 15
        and len(set(row["checkpoint_ids"])) == 15
        and row["all_state_tensors_unchanged"] is True
        and row["all_parameter_gradients_none"] is True
        for row in integrity
    )
    capacity_cases = profile["capacity_cases"]
    assert isinstance(capacity_cases, list)
    assert all(
        row["formal_empirical_planning_decisions_per_lane"]
        == len(formal.prep.TRAINING_SEEDS)
        * math.ceil((formal.EXPECTED_GAMES_PER_TASK // 2) / formal.SCALAR_LANE_COUNT)
        * 2
        * {5: 32, 7: 84, 9: 138}[row["eval_size"]]
        for row in capacity_cases
    )
    expected_critical = (
        28.0 / formal.GPU_SMOKE_CASE_COUNT / 64
    )
    assert all(
        row["capacity_projection_method"] == formal.CAPACITY_PROJECTION_METHOD
        and row["critical_lane_index"] == 0
        and row["critical_lane_puct_decisions"] == 64
        and math.isclose(
            row["critical_seconds_per_decision"], expected_critical
        )
        and row["slowest_single_decision_seconds"] == 0.01
        for row in capacity_cases
    )


def test_capacity_projection_uses_slowest_lane_average_and_budget_boundary(
    tmp_path: Path,
) -> None:
    _, _, profile, tasks, _ = _write_valid_throughput_profile(tmp_path)
    lanes = profile["lane_results"]
    assert isinstance(lanes, list)
    capacity_cases, projected = formal._formal_capacity_projection(lanes, tasks)
    assert math.isclose(projected, 2_222.5)
    assert capacity_cases[0]["slowest_single_decision_seconds"] == 0.01
    assert capacity_cases[0]["critical_lane_index"] == 0
    assert math.isclose(
        capacity_cases[0]["critical_seconds_per_decision"], 7.0 / 144.0
    )

    lanes[0]["sustained_seconds"] = 3.2
    changed_cases, changed_projected = formal._formal_capacity_projection(
        lanes, tasks
    )
    assert changed_cases[0]["critical_lane_index"] == 0
    assert math.isclose(
        changed_cases[0]["critical_seconds_per_decision"], 0.05
    )
    assert changed_projected > projected

    slow_lanes = copy.deepcopy(lanes)
    for lane in slow_lanes:
        lane["puct_decisions"] = 16
    slow_cases, slow_projected = formal._formal_capacity_projection(
        slow_lanes, tasks
    )
    assert slow_projected > formal.FORMAL_GAMEPLAY_BUDGET_SECONDS
    with pytest.raises(formal.FormalCapacityError):
        formal._require_capacity_projection(slow_cases, slow_projected)

    formal._require_capacity_projection(
        capacity_cases, formal.FORMAL_GAMEPLAY_BUDGET_SECONDS
    )
    over_budget = math.nextafter(
        float(formal.FORMAL_GAMEPLAY_BUDGET_SECONDS), math.inf
    )
    with pytest.raises(formal.FormalCapacityError) as caught:
        formal._require_capacity_projection(capacity_cases, over_budget)
    diagnostic = caught.value.diagnostic
    assert diagnostic["status"] == "FAIL_CLOSED"
    assert diagnostic["schema_name"] == formal.THROUGHPUT_CAPACITY_FAILURE_SCHEMA
    assert diagnostic["projected_empirical_planning_seconds"] == over_budget
    assert "lane_results" not in diagnostic
    assert len(formal.canonical_json(diagnostic).encode("utf-8")) < 4096


@pytest.mark.parametrize(
    "mutation",
    ("histogram_count", "derived_planning", "source_manifest_digest"),
)
def test_empirical_capacity_evidence_recomputes_and_rejects_tamper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    payload = json.loads(
        formal.EMPIRICAL_CAPACITY_EVIDENCE_PATH.read_text(encoding="utf-8")
    )
    if mutation == "histogram_count":
        payload["sizes"]["5"]["histogram"]["16"] += 1
    elif mutation == "derived_planning":
        payload["sizes"]["7"]["empirical_planning_plies"] = 85
    else:
        payload["source_manifest_sha256"] = "0" * 64
    tampered = tmp_path / "capacity.json"
    tampered.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        formal,
        "EMPIRICAL_CAPACITY_EVIDENCE_EXPECTED_SHA256",
        formal.sha256_file(tampered),
    )
    with pytest.raises(formal.FormalExecutionError):
        formal._validated_empirical_capacity_evidence(tampered)


def test_single_decision_tail_jitter_is_diagnostic_not_capacity(
    tmp_path: Path,
) -> None:
    manifest_path, profile_path, profile, tasks, games = (
        _write_valid_throughput_profile(tmp_path)
    )
    original_projected = float(
        profile["projected_empirical_planning_seconds"]
    )
    original_critical = float(
        profile["capacity_cases"][0]["critical_seconds_per_decision"]
    )
    lane = profile["lane_results"][0]
    lane["decision_seconds"][0] = 0.5
    lane["slowest_decision_seconds"] = 0.5
    assert sum(lane["decision_seconds"]) <= float(lane["sustained_seconds"])

    capacity_cases, projected = formal._formal_capacity_projection(
        profile["lane_results"], tasks
    )
    assert math.isclose(projected, original_projected)
    assert math.isclose(
        capacity_cases[0]["critical_seconds_per_decision"], original_critical
    )
    assert capacity_cases[0]["slowest_single_decision_seconds"] == 0.5
    profile["capacity_cases"] = capacity_cases
    profile["projected_empirical_planning_seconds"] = projected
    profile_path.write_text(
        json.dumps(profile, sort_keys=True) + "\n", encoding="utf-8"
    )
    validated = formal._validate_throughput_profile(
        profile_path,
        manifest_path=manifest_path,
        tasks=tasks,
        games=games,
    )
    assert validated["projected_empirical_planning_seconds"] == projected

    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(
            formal.prep.SCRIPT_PATH
        ),
    }
    independently_validated = independent._validate_throughput_profile_evidence(
        evidence,
        metadata=metadata,
        tasks=tasks,
        grouped_schedules=_group_schedules_by_task(games),
        checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
        formal_manifest_sha=independent.sha256_file(manifest_path),
        formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
    )
    assert (
        independently_validated["projected_empirical_planning_seconds"]
        == projected
    )


def test_gpu_smoke_schedule_binding_accepts_exact_preparation_schema() -> None:
    frozen_manifest = formal.prep.load_json(formal.DEFAULT_MANIFEST)
    manifest = formal.prep.build_formal_manifest(
        protocol_path=formal.prep.resolve_repo_path(frozen_manifest["protocol_path"]),
        opening_path=formal.prep.resolve_repo_path(
            frozen_manifest["opening_design"]["opening_manifest_path"]
        ),
        v1_formal_path=formal.prep.resolve_repo_path(
            frozen_manifest["checkpoint_selection"]["source_manifest_path"]
        ),
    )
    bundle = formal.prep.materialize_bundle(
        manifest=manifest, manifest_path=formal.DEFAULT_MANIFEST
    )
    tasks = bundle["task_rows"]
    raw_games = bundle["game_rows"]
    grouped_raw: dict[str, list[dict[str, object]]] = {}
    for game in raw_games:
        grouped_raw.setdefault(str(game["task_id"]), []).append(game)
    bound_games: list[dict[str, object]] = []
    for task in tasks:
        bound_games.extend(
            formal._bound_task_schedules(
                task, grouped_raw[str(task["task_id"])]
            )
        )

    selected = formal._gpu_smoke_schedules_by_task(tasks, bound_games)
    assert len(selected) == formal.EXPECTED_TASKS
    assert all(
        "black_slot" not in task["pair_plan"][0]
        and "white_slot" not in task["pair_plan"][0]
        and selected[str(task["task_id"])]["game_id"]
        == task["pair_plan"][0]["game_ids"][0]
        and selected[str(task["task_id"])]["pair_member"] == 0
        for task in tasks
    )


def test_gpu_smoke_worker_consumes_bound_schedule_before_model_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, _, tasks, games = _write_valid_throughput_profile(tmp_path)
    payload = formal._gpu_smoke_case_payloads(
        tasks, games, seconds=formal.GPU_SMOKE_REQUESTED_SECONDS
    )[0][0]
    model_loads: list[object] = []

    def stop_at_model_load(binding: object) -> object:
        model_loads.append(binding)
        raise RuntimeError("model-load-reached")

    monkeypatch.setattr(formal, "_formal_lane_agent", stop_at_model_load)
    with pytest.raises(RuntimeError, match="model-load-reached"):
        formal._run_gpu_smoke_lane(payload)
    assert len(model_loads) == 1

    model_loads.clear()
    invalid_payload = copy.deepcopy(payload)
    invalid_payload["schedule"]["frozen_game_schedule_sha256"] = "0" * 64
    with pytest.raises(formal.FormalExecutionError, match="frozen hash drifted"):
        formal._run_gpu_smoke_lane(invalid_payload)
    assert model_loads == []


def test_readiness_rejects_bad_smoke_schedule_before_checkpoint_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, _, tasks, games = _write_valid_throughput_profile(tmp_path)
    invalid_games = copy.deepcopy(games)
    invalid_games[0]["frozen_game_schedule_sha256"] = "0" * 64
    checkpoint_loads: list[object] = []

    def unexpected_checkpoint_load(*args: object, **kwargs: object) -> object:
        checkpoint_loads.append((args, kwargs))
        raise AssertionError("checkpoint loading must not start")

    monkeypatch.setattr(
        formal,
        "load_frozen_bundle",
        lambda *_: ({}, tasks, invalid_games, {}),
    )
    monkeypatch.setattr(
        formal.legacy,
        "_load_neural_agent",
        unexpected_checkpoint_load,
    )
    with pytest.raises(formal.FormalExecutionError, match="frozen hash drifted"):
        formal.task_shaped_readiness(
            tmp_path / "manifest.json", tmp_path / "bundle"
        )
    assert checkpoint_loads == []


@pytest.mark.parametrize(
    ("mutation", "message"),
    (
        ("missing", "missing or duplicated"),
        ("duplicate", "missing or duplicated"),
        ("wrong_task", "missing or duplicated"),
        ("wrong_member", "missing or duplicated"),
        ("hash", "frozen hash drifted"),
        ("color", "color slots are invalid"),
    ),
)
def test_gpu_smoke_schedule_binding_rejects_invalid_game_rows_before_workers(
    tmp_path: Path, mutation: str, message: str
) -> None:
    _, _, _, tasks, games = _write_valid_throughput_profile(tmp_path)
    mutated_games = copy.deepcopy(games)
    selected_game_id = str(tasks[0]["pair_plan"][0]["game_ids"][0])
    selected_index = next(
        index
        for index, game in enumerate(mutated_games)
        if game["game_id"] == selected_game_id
    )
    if mutation == "missing":
        mutated_games.pop(selected_index)
    elif mutation == "duplicate":
        mutated_games.append(copy.deepcopy(mutated_games[selected_index]))
    elif mutation == "wrong_task":
        mutated_games[selected_index]["task_id"] = "another-task"
    elif mutation == "wrong_member":
        mutated_games[selected_index]["pair_member"] = 1
    elif mutation == "hash":
        mutated_games[selected_index]["frozen_game_schedule_sha256"] = "0" * 64
    else:
        mutated_games[selected_index]["black_slot"] = "B"

    with pytest.raises(formal.FormalExecutionError, match=message):
        formal._gpu_smoke_case_payloads(
            tasks,
            mutated_games,
            seconds=formal.GPU_SMOKE_REQUESTED_SECONDS,
        )


@pytest.mark.parametrize(
    ("field", "replacement"),
    (
        ("formal_runner_sha256", "0" * 64),
        ("formal_manifest_sha256", "1" * 64),
        ("scalar_lane_count", 11),
        ("inference_batch_size", 2),
        ("amp_enabled", True),
    ),
)
def test_throughput_profile_rejects_runner_manifest_and_numeric_drift(
    tmp_path: Path,
    field: str,
    replacement: object,
) -> None:
    manifest_path, profile_path, profile, tasks, games = _write_valid_throughput_profile(
        tmp_path
    )
    profile[field] = replacement
    profile_path.write_text(
        json.dumps(profile, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(
        formal.FormalExecutionError,
        match=rf"formal throughput profile binding mismatch: {field}",
    ):
        formal._validate_throughput_profile(
            profile_path, manifest_path=manifest_path, tasks=tasks, games=games
        )


@pytest.mark.parametrize(
    "field",
    (
        "game_id",
        "pair_id",
        "pair_member",
        "frozen_game_schedule_sha256",
        "black_slot",
    ),
)
def test_throughput_profile_rejects_frozen_schedule_tamper(
    tmp_path: Path, field: str
) -> None:
    manifest_path, profile_path, profile, tasks, games = (
        _write_valid_throughput_profile(tmp_path)
    )
    lanes = profile["lane_results"]
    assert isinstance(lanes, list) and isinstance(lanes[0], dict)
    if field == "pair_member":
        lanes[0][field] = 1
    elif field == "black_slot":
        lanes[0][field] = "B"
    else:
        lanes[0][field] = "0" * 64
    profile_path.write_text(json.dumps(profile, sort_keys=True), encoding="utf-8")
    with pytest.raises(
        formal.FormalExecutionError,
        match="frozen game schedule binding drifted",
    ):
        formal._validate_throughput_profile(
            profile_path,
            manifest_path=manifest_path,
            tasks=tasks,
            games=games,
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    (
        ("critical_raw_lane", "homogeneous capacity cases drifted"),
        ("memory", "resident-memory evidence drifted"),
        ("coverage", "coverage is incomplete"),
        ("nonfinite", "must be finite"),
        ("environment", "environment drifted"),
        ("warmup", "agent binding is not exact"),
        ("integrity_pid", "did not cover twelve preload PIDs"),
        ("integrity_checkpoint", "resident integrity 0 differs"),
        ("integrity_state", "resident integrity 0 differs"),
    ),
)
def test_throughput_profile_rejects_capacity_memory_coverage_and_environment(
    tmp_path: Path, mutation: str, message: str
) -> None:
    manifest_path, profile_path, profile, tasks, games = _write_valid_throughput_profile(
        tmp_path
    )
    lanes = profile["lane_results"]
    assert isinstance(lanes, list)
    if mutation == "critical_raw_lane":
        lanes[0]["sustained_seconds"] = 3.2
        _rebind_profile_aggregate_timing(profile)
    elif mutation == "memory":
        worker_pid = lanes[0]["worker_pid"]
        oversized_reserved = 31 * 1024**3
        for lane in lanes:
            if lane["worker_pid"] == worker_pid:
                lane["max_memory_reserved_bytes"] = oversized_reserved
        preloads = profile["resident_cache_preload_results"]
        assert isinstance(preloads, list)
        preloads[0]["max_memory_reserved_bytes"] = oversized_reserved
        residents = profile["resident_worker_memory"]
        assert isinstance(residents, list)
        residents[0]["max_memory_reserved_bytes"] = oversized_reserved
        profile["aggregate_peak_memory_reserved_bytes"] = sum(
            int(row["max_memory_reserved_bytes"]) for row in residents
        )
    elif mutation == "coverage":
        profile["coverage"]["model_kinds"] = ["padded_cnn"]
    elif mutation == "nonfinite":
        profile["total_seconds"] = float("nan")
    elif mutation == "environment":
        lanes[0]["device"] = "cpu"
    elif mutation == "warmup":
        lanes[0]["warmup_puct_decisions"] = 1
    else:
        integrity_rows = profile["resident_integrity_results"]
        final_integrity = lanes[-formal.SCALAR_LANE_COUNT]["resident_integrity"]
        assert isinstance(integrity_rows, list) and isinstance(final_integrity, dict)
        if mutation == "integrity_pid":
            duplicate_pid = integrity_rows[1]["worker_pid"]
            integrity_rows[0]["worker_pid"] = duplicate_pid
            final_integrity["worker_pid"] = duplicate_pid
        elif mutation == "integrity_checkpoint":
            integrity_rows[0]["checkpoint_ids"].pop()
            integrity_rows[0]["checkpoint_count"] = 14
            final_integrity["checkpoint_ids"].pop()
            final_integrity["checkpoint_count"] = 14
        else:
            integrity_rows[0]["all_state_tensors_unchanged"] = False
            final_integrity["all_state_tensors_unchanged"] = False
    profile_path.write_text(json.dumps(profile, sort_keys=True), encoding="utf-8")
    with pytest.raises(formal.FormalExecutionError, match=message):
        formal._validate_throughput_profile(
            profile_path, manifest_path=manifest_path, tasks=tasks, games=games
        )


def test_throughput_profile_rejects_forged_pre_cleanup_free_memory(
    tmp_path: Path,
) -> None:
    manifest_path, profile_path, profile, tasks, games = (
        _write_valid_throughput_profile(tmp_path)
    )
    forged_free = int(profile["device_free_memory_after_smoke_bytes"]) + 1024**3
    profile["device_free_memory_after_smoke_bytes"] = forged_free
    profile["device_used_memory_after_smoke_bytes"] = (
        int(profile["device_total_memory_bytes"]) - forged_free
    )
    profile_path.write_text(json.dumps(profile, sort_keys=True), encoding="utf-8")
    with pytest.raises(
        formal.FormalExecutionError,
        match="not bound to the conservative final pre-cleanup snapshot",
    ):
        formal._validate_throughput_profile(
            profile_path,
            manifest_path=manifest_path,
            tasks=tasks,
            games=games,
        )


def test_independent_verifier_rehashes_and_revalidates_complete_profile(
    tmp_path: Path,
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    checkpoint_registry = _checkpoint_registry_from_tasks(tasks)
    assert independent._validate_throughput_profile_evidence(
        evidence,
        metadata=metadata,
        tasks=tasks,
        grouped_schedules=_group_schedules_by_task(games),
        checkpoint_registry=checkpoint_registry,
        formal_manifest_sha=independent.sha256_file(manifest_path),
        formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
    ) == profile
    evidence.write_text(evidence.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(independent.VerificationError, match="hash differs"):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=checkpoint_registry,
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


def _mutate_v2_timing_profile(profile: dict[str, object], mutation: str) -> None:
    if mutation == "task_field":
        profile["task_shaped_seconds"] = float(profile["task_shaped_seconds"]) + 0.25
    elif mutation == "overhead_field":
        profile["workflow_overhead_seconds"] = (
            float(profile["workflow_overhead_seconds"]) + 0.25
        )
    elif mutation == "setup_field":
        profile["setup_seconds"] = float(profile["setup_seconds"]) + 0.25
    elif mutation == "requested_total":
        profile["requested_sustained_seconds"] = 26.0
    elif mutation == "requested_case":
        profile["requested_case_seconds"] = 3.1
    elif mutation == "lane_composition":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list) and isinstance(lanes[0], dict)
        lanes[0]["setup_seconds"] = 0.5
    elif mutation == "decision_sum":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list) and isinstance(lanes[0], dict)
        lanes[0]["decision_seconds"] = [1.0] * int(lanes[0]["puct_decisions"])
        lanes[0]["slowest_decision_seconds"] = 1.0
    elif mutation == "sequential_case_wall":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list)
        for case_index in range(formal.GPU_SMOKE_CASE_COUNT):
            lane = lanes[case_index * formal.SCALAR_LANE_COUNT]
            assert isinstance(lane, dict)
            lane["total_seconds"] = 3.6
    elif mutation == "task_nan":
        profile["task_shaped_seconds"] = float("nan")
    elif mutation == "wall_negative":
        profile["workflow_wall_seconds"] = -1.0
    elif mutation == "overhead_nan":
        profile["workflow_overhead_seconds"] = float("nan")
    elif mutation == "lane_sustained_nan":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list) and isinstance(lanes[0], dict)
        lanes[0]["sustained_seconds"] = float("nan")
    elif mutation == "lane_total_negative":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list) and isinstance(lanes[0], dict)
        lanes[0]["total_seconds"] = -1.0
    elif mutation == "lane_setup_negative":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list) and isinstance(lanes[0], dict)
        lanes[0]["setup_seconds"] = -1.0
    elif mutation == "swap_lane_order":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list)
        lanes[0], lanes[1] = lanes[1], lanes[0]
    elif mutation == "swap_case_order":
        lanes = profile["lane_results"]
        assert isinstance(lanes, list)
        first = lanes[: formal.SCALAR_LANE_COUNT]
        second = lanes[
            formal.SCALAR_LANE_COUNT : 2 * formal.SCALAR_LANE_COUNT
        ]
        lanes[: formal.SCALAR_LANE_COUNT] = second
        lanes[formal.SCALAR_LANE_COUNT : 2 * formal.SCALAR_LANE_COUNT] = first
    elif mutation == "task_over_30":
        task_shaped = 31.0
        lanes = profile["lane_results"]
        assert isinstance(lanes, list)
        for lane in lanes:
            assert isinstance(lane, dict)
            lane["sustained_seconds"] = task_shaped / formal.GPU_SMOKE_CASE_COUNT
        profile["task_shaped_seconds"] = task_shaped
        profile["sustained_seconds"] = task_shaped
        profile["aggregate_window_seconds"] = task_shaped
        profile["aggregate_puct_decisions_per_second"] = (
            int(profile["puct_decisions"]) / task_shaped
        )
        profile["workflow_overhead_seconds"] = 1.0
        profile["setup_seconds"] = 1.0
    elif mutation == "wall_over_57":
        profile["workflow_wall_seconds"] = 58.0
        profile["total_seconds"] = 58.0
        profile["duration_seconds"] = 58.0
        profile["workflow_overhead_seconds"] = 30.0
        profile["setup_seconds"] = 30.0
    elif mutation == "legacy_total_field":
        profile["total_seconds"] = float(profile["total_seconds"]) + 0.25
    elif mutation == "semantics":
        profile["task_shaped_seconds_semantics"] = "forged"
    else:  # pragma: no cover - protects the test helper itself
        raise AssertionError(f"unknown timing mutation: {mutation}")


def test_v2_timing_contract_accepts_32_second_workflow_and_real_lane_window(
    tmp_path: Path,
) -> None:
    manifest_path, profile_path, profile, tasks, games = (
        _write_valid_throughput_profile(tmp_path)
    )
    assert profile["workflow_wall_seconds"] == 32.0
    assert formal.GPU_SMOKE_REQUESTED_SECONDS <= float(
        profile["task_shaped_seconds"]
    ) <= formal.GPU_SMOKE_MAX_TASK_SHAPED_SECONDS
    assert formal._validate_throughput_profile(
        profile_path, manifest_path=manifest_path, tasks=tasks, games=games
    ) == profile


@pytest.mark.parametrize(
    "mutation",
    (
        "task_field",
        "overhead_field",
        "setup_field",
        "requested_total",
        "requested_case",
        "lane_composition",
        "decision_sum",
        "sequential_case_wall",
        "task_nan",
        "wall_negative",
        "overhead_nan",
        "lane_sustained_nan",
        "lane_total_negative",
        "lane_setup_negative",
        "swap_lane_order",
        "swap_case_order",
        "task_over_30",
        "wall_over_57",
        "legacy_total_field",
        "semantics",
    ),
)
def test_runner_rejects_v2_timing_tamper(tmp_path: Path, mutation: str) -> None:
    manifest_path, profile_path, profile, tasks, games = (
        _write_valid_throughput_profile(tmp_path)
    )
    _mutate_v2_timing_profile(profile, mutation)
    profile_path.write_text(json.dumps(profile, sort_keys=True), encoding="utf-8")
    with pytest.raises(formal.FormalExecutionError):
        formal._validate_throughput_profile(
            profile_path, manifest_path=manifest_path, tasks=tasks, games=games
        )


@pytest.mark.parametrize(
    "mutation",
    (
        "task_field",
        "overhead_field",
        "setup_field",
        "requested_total",
        "requested_case",
        "lane_composition",
        "decision_sum",
        "sequential_case_wall",
        "task_nan",
        "wall_negative",
        "overhead_nan",
        "lane_sustained_nan",
        "lane_total_negative",
        "lane_setup_negative",
        "swap_lane_order",
        "swap_case_order",
        "task_over_30",
        "wall_over_57",
        "legacy_total_field",
        "semantics",
    ),
)
def test_independent_verifier_rejects_v2_timing_tamper(
    tmp_path: Path, mutation: str
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    _mutate_v2_timing_profile(profile, mutation)
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    with pytest.raises(independent.VerificationError):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


def test_independent_verifier_rejects_crossed_lane_checkpoint_binding(
    tmp_path: Path,
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    lanes = profile["lane_results"]
    assert isinstance(lanes, list)
    lane = lanes[0]
    assert isinstance(lane, dict)
    agents = lane["agents"]
    assert isinstance(agents, list)
    agent = agents[0]
    assert isinstance(agent, dict) and agent["agent_slot"] == "A"
    pair = lane["model_pair"]
    assert isinstance(pair, list)
    seed = min(int(task["training_seed"]) for task in tasks)
    agent["checkpoint_id"] = f"{pair[1]}-{seed}"
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    with pytest.raises(
        independent.VerificationError,
        match="checkpoint/model/slot binding differs",
    ):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    (
        ("capacity", "capacity case differs"),
        ("capacity_barrier_vector", "capacity case differs"),
        ("critical_rate", "capacity case differs"),
        ("critical_raw_lane", "capacity case differs"),
        ("reserved", "resident allocated/reserved memory gate"),
        ("headroom", "device_free_after"),
        ("topology_n9", "coverage is incomplete"),
        ("single_state", "unique_state_count must be >= 2"),
    ),
)
def test_independent_verifier_rejects_profile_semantic_tamper(
    tmp_path: Path, mutation: str, message: str
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    if mutation == "capacity":
        profile["capacity_cases"][0][
            "projected_empirical_planning_seconds"
        ] += 1.0
    elif mutation == "capacity_barrier_vector":
        barriers = profile["capacity_cases"][0][
            "formal_task_barrier_empirical_decisions_per_lane"
        ]
        assert len(barriers) == 5 and sum(barriers) == 1_920
        barriers[0] += 1
        barriers[1] -= 1
    elif mutation == "critical_rate":
        profile["capacity_cases"][0]["critical_seconds_per_decision"] += 1e-6
    elif mutation == "critical_raw_lane":
        profile["lane_results"][0]["sustained_seconds"] = 3.2
        _rebind_profile_aggregate_timing(profile)
    elif mutation == "reserved":
        profile["aggregate_peak_memory_reserved_bytes"] += 1
    elif mutation == "headroom":
        profile["device_free_memory_after_smoke_bytes"] = (
            independent.MIN_DEVICE_FREE_HEADROOM_BYTES - 1
        )
        profile["device_used_memory_after_smoke_bytes"] = (
            int(profile["device_total_memory_bytes"])
            - int(profile["device_free_memory_after_smoke_bytes"])
        )
    elif mutation == "topology_n9":
        profile["coverage"]["model_kind_size_cases"] = [
            row
            for row in profile["coverage"]["model_kind_size_cases"]
            if not (
                row["model_kind"] == "topology_gnn" and row["eval_size"] == 9
            )
        ]
    else:
        lane = profile["lane_results"][0]
        lane["decision_state_fingerprints"] = [
            "0" * 64
        ] * int(lane["puct_decisions"])
        lane["unique_state_count"] = 1
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    with pytest.raises(independent.VerificationError, match=message):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


def test_independent_verifier_rejects_forged_pre_cleanup_free_memory(
    tmp_path: Path,
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(
        tmp_path
    )
    forged_free = int(profile["device_free_memory_after_smoke_bytes"]) + 1024**3
    profile["device_free_memory_after_smoke_bytes"] = forged_free
    profile["device_used_memory_after_smoke_bytes"] = (
        int(profile["device_total_memory_bytes"]) - forged_free
    )
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(
            formal.prep.SCRIPT_PATH
        ),
    }
    with pytest.raises(
        independent.VerificationError,
        match="not bound to the conservative final pre-cleanup snapshot",
    ):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    (
        ("lane_missing", "nine complete twelve-lane cases"),
        ("lane_duplicate", "lane case/task binding differs"),
        ("preload_pid", "preload worker processes are not distinct"),
        ("case_pid", "case does not use all twelve preloaded workers"),
        ("preload_checkpoint", "did not bind all fifteen checkpoints"),
        ("baseline_checkpoint", "preload device baseline differs"),
        ("integrity_pid", "does not cover all twelve preload PIDs"),
        ("integrity_checkpoint", "resident checkpoint integrity differs"),
        ("integrity_state", "resident checkpoint integrity differs"),
        ("warmup", "did not exercise both formal agents"),
        ("agent_slots", "checkpoint/model/slot binding differs"),
        ("game_id", "frozen game schedule binding differs"),
        ("pair_member", "frozen game schedule binding differs"),
        ("schedule_hash", "frozen game schedule binding differs"),
        ("color", "frozen game schedule binding differs"),
        ("opening", "opening differs from selected task schedule"),
        ("seed_round_robin", "lane case/task binding differs"),
        ("decision_length", "multi-state decision timing evidence is invalid"),
        ("slowest_decision", "multi-state decision timing evidence is invalid"),
        ("fingerprint_type", "pre-state fingerprint/action trace differs"),
        ("fingerprint_hex", "pre-state fingerprint/action trace differs"),
        ("action_length", "multi-state decision timing evidence is invalid"),
        ("action_illegal", "action exceeds PASS index"),
        ("reset_count", "multi-state decision timing evidence is invalid"),
        ("opening_prefix_hash", "selected opening prefix hash differs"),
        ("opening_state_hash", "selected opening state hash differs"),
    ),
)
def test_independent_verifier_rejects_lane_and_preload_tamper_matrix(
    tmp_path: Path, mutation: str, message: str
) -> None:
    manifest_path, _, profile, tasks, games = _write_valid_throughput_profile(tmp_path)
    lanes = profile["lane_results"]
    preloads = profile["resident_cache_preload_results"]
    assert isinstance(lanes, list) and isinstance(preloads, list)
    if mutation == "lane_missing":
        lanes.pop()
    elif mutation == "lane_duplicate":
        lanes[-1] = copy.deepcopy(lanes[-2])
    elif mutation == "preload_pid":
        preloads[1]["worker_pid"] = preloads[0]["worker_pid"]
    elif mutation == "case_pid":
        lanes[1]["worker_pid"] = lanes[0]["worker_pid"]
    elif mutation == "preload_checkpoint":
        preloads[0]["checkpoint_ids"].pop()
        preloads[0]["checkpoint_count"] = 14
    elif mutation == "baseline_checkpoint":
        preloads[0]["device_baseline_checkpoint_ids"].pop()
        preloads[0]["device_baseline_checkpoint_count"] = 14
    elif mutation in {"integrity_pid", "integrity_checkpoint", "integrity_state"}:
        integrity_rows = profile["resident_integrity_results"]
        final_integrity = lanes[-formal.SCALAR_LANE_COUNT]["resident_integrity"]
        assert isinstance(integrity_rows, list) and isinstance(final_integrity, dict)
        if mutation == "integrity_pid":
            duplicate_pid = integrity_rows[1]["worker_pid"]
            integrity_rows[0]["worker_pid"] = duplicate_pid
            final_integrity["worker_pid"] = duplicate_pid
        elif mutation == "integrity_checkpoint":
            integrity_rows[0]["checkpoint_ids"].pop()
            integrity_rows[0]["checkpoint_count"] = 14
            final_integrity["checkpoint_ids"].pop()
            final_integrity["checkpoint_count"] = 14
        else:
            integrity_rows[0]["all_state_tensors_unchanged"] = False
            final_integrity["all_state_tensors_unchanged"] = False
    elif mutation == "warmup":
        lanes[0]["warmup_puct_decisions"] = 1
    elif mutation == "agent_slots":
        lanes[0]["agents"] = list(reversed(lanes[0]["agents"]))
    elif mutation == "game_id":
        lanes[0]["game_id"] = "another-game"
    elif mutation == "pair_member":
        lanes[0]["pair_member"] = 1
    elif mutation == "schedule_hash":
        lanes[0]["frozen_game_schedule_sha256"] = "0" * 64
    elif mutation == "color":
        lanes[0]["black_slot"] = "B"
        lanes[0]["white_slot"] = "A"
    elif mutation == "opening":
        first_task = tasks[0]
        pair_plan = first_task["pair_plan"]
        assert isinstance(pair_plan, list) and isinstance(pair_plan[0], dict)
        alternate = copy.deepcopy(pair_plan[0])
        alternate["opening_id"] = "alternate-task-bound-opening"
        pair_plan.append(alternate)
        lanes[0]["opening_id"] = alternate["opening_id"]
        profile["coverage"] = formal._profile_coverage(lanes)
    elif mutation == "seed_round_robin":
        original_pid = lanes[1]["worker_pid"]
        lanes[1] = copy.deepcopy(lanes[0])
        lanes[1]["lane_index"] = 1
        lanes[1]["worker_pid"] = original_pid
    elif mutation == "decision_length":
        lanes[0]["decision_seconds"].pop()
    elif mutation == "slowest_decision":
        lanes[0]["slowest_decision_seconds"] = 0.06
    elif mutation == "fingerprint_type":
        lanes[0]["decision_state_fingerprints"][0] = {"forged": True}
    elif mutation == "fingerprint_hex":
        lanes[0]["decision_state_fingerprints"][0] = "0" * 64
    elif mutation == "action_length":
        lanes[0]["decision_action_indices"].pop()
    elif mutation == "action_illegal":
        lanes[0]["decision_action_indices"][0] = 10_000
    elif mutation == "reset_count":
        lanes[0]["game_resets"] += 1
    elif mutation == "opening_prefix_hash":
        games[0]["opening_prefix_hash"] = "0" * 64
    else:
        games[0]["opening_state_hash"] = "0" * 64

    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    with pytest.raises(independent.VerificationError, match=message):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
            grouped_schedules=_group_schedules_by_task(games),
            checkpoint_registry=_checkpoint_registry_from_tasks(tasks),
            formal_manifest_sha=independent.sha256_file(manifest_path),
            formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
        )


def test_pair_lane_failure_creates_no_parent_pair_artifact(tmp_path: Path) -> None:
    class FailingExecutor:
        def map_ordered(self, worker: object, payloads: object) -> list[object]:
            del worker, payloads
            raise formal.FormalExecutionError("synthetic pair batch failed")

    task_directory = tmp_path / "task"
    pairs_directory = task_directory / "pairs"
    pairs_directory.mkdir(parents=True)
    schedules = {
        pair_index: [
            {"pair_index": pair_index, "pair_member": member}
            for member in (0, 1)
        ]
        for pair_index in range(3)
    }
    with pytest.raises(
        formal.FormalExecutionError, match="synthetic pair batch failed"
    ):
        formal._execute_pair_lanes(
            {"task_id": "synthetic"},
            schedules,
            task_directory=task_directory,
            lane_executor=FailingExecutor(),  # type: ignore[arg-type]
        )

    assert list(pairs_directory.iterdir()) == []
    assert "_atomic_" not in inspect.getsource(formal._run_formal_pair_lane)


def test_partial_parent_pair_write_resumes_only_missing_payloads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class RecordingExecutor:
        def __init__(self) -> None:
            self.indices: list[int] = []

        def map_ordered(self, worker: object, payloads: object) -> list[object]:
            rows = list(payloads)  # type: ignore[arg-type]
            self.indices = [int(row["schedules"][0]["pair_index"]) for row in rows]
            return [worker(row) for row in rows]  # type: ignore[operator]

    _bind_canary_agents()
    canary = _canary_pair_payload()
    base_schedules = canary["schedules"]
    assert isinstance(base_schedules, list)
    task_directory = tmp_path / "task"
    (task_directory / "pairs").mkdir(parents=True)
    pairs = {
        index: [
            {
                **copy.deepcopy(base_schedules[member]),
                "game_id": f"canary-game-{index}-{member}",
                "game_index": index * 2 + member,
                "pair_id": f"canary-pair-{index}",
                "pair_index": index,
            }
            for member in range(2)
        ]
        for index in range(3)
    }
    original_atomic = formal._atomic_json
    writes = 0

    def fail_second_write(path: Path, value: object, **kwargs: object) -> None:
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("synthetic parent write interruption")
        original_atomic(path, value, **kwargs)  # type: ignore[arg-type]

    first = RecordingExecutor()
    monkeypatch.setattr(formal, "_atomic_json", fail_second_write)
    with pytest.raises(OSError, match="parent write interruption"):
        formal._execute_pair_lanes(
            canary["task"],
            pairs,
            task_directory=task_directory,
            lane_executor=first,  # type: ignore[arg-type]
        )
    assert first.indices == [0, 1, 2]
    completed_pair = task_directory / "pairs" / "pair_0000.json"
    assert completed_pair.is_file()
    completed_pair_before = completed_pair.read_bytes()
    monkeypatch.setattr(formal, "_atomic_json", original_atomic)
    resumed_write_paths: list[Path] = []

    def record_resumed_write(path: Path, value: object, **kwargs: object) -> None:
        resumed_write_paths.append(path.resolve())
        original_atomic(path, value, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(formal, "_atomic_json", record_resumed_write)
    resumed = RecordingExecutor()
    formal._execute_pair_lanes(
        canary["task"],
        pairs,
        task_directory=task_directory,
        lane_executor=resumed,  # type: ignore[arg-type]
    )
    assert resumed.indices == [1, 2]
    assert completed_pair.read_bytes() == completed_pair_before
    assert completed_pair.resolve() not in resumed_write_paths
    assert len(list((task_directory / "pairs").glob("pair_*.json"))) == 3


def test_opening_stratum_gate_passes_exact_shape_and_fails_variant_drift() -> None:
    rows = _mock_gate_records()
    counts = formal._task_counts(rows)
    gate = formal._formal_gate(_mock_gate_task(), counts)
    assert gate["passed"] is True
    assert counts["opening_strata_with_exact_four_games"] == 32
    assert counts["opening_strata_with_exact_two_variants"] == 32
    assert counts["opening_variants_with_exact_color_pair"] == 64
    assert "opening_stratum" in gate["stratum_key"]

    tampered = copy.deepcopy(rows)
    for row in tampered:
        if row["opening_stratum"] == "n5_s31_p2" and row["opening_variant"] == 1:
            row["opening_variant"] = 0
    tampered_gate = formal._formal_gate(
        _mock_gate_task(), formal._task_counts(tampered)
    )
    assert tampered_gate["passed"] is False
    assert tampered_gate["checks"]["exact_two_variants_per_opening_stratum"] is False


def test_receipt_paths_are_task_relative_only() -> None:
    task_directory = (formal.RESEARCH_ROOT / "tests" / "synthetic-task").resolve()
    assert formal._task_artifact_path(task_directory, "games.jsonl", "games.jsonl") == (
        task_directory / "games.jsonl"
    ).resolve()
    for raw in (
        "../games.jsonl",
        str((task_directory.parent / "games.jsonl").resolve()),
        "summary.json",
    ):
        with pytest.raises(formal.FormalExecutionError):
            formal._task_artifact_path(task_directory, raw, "games.jsonl")


def test_gpu_smoke_source_is_frozen_inference_path_only() -> None:
    smoke_source = inspect.getsource(formal.gpu_smoke)
    lane_source = inspect.getsource(formal._run_gpu_smoke_lane)
    select_source = inspect.getsource(formal._gpu_smoke_select_action)
    timed_select_source = inspect.getsource(formal._gpu_smoke_timed_select_action)
    preload_source = inspect.getsource(formal._run_gpu_smoke_preload_lane)
    integrity_source = inspect.getsource(formal._verify_resident_checkpoint_integrity)
    release_source = inspect.getsource(formal._release_gpu_smoke_lane_state)
    source = (
        smoke_source
        + lane_source
        + select_source
        + timed_select_source
        + preload_source
        + integrity_source
        + release_source
    )
    for forbidden in (
        ".backward(",
        "optimizer.step(",
        "time.sleep(",
        "dummy",
        "torch.matmul(",
        "Adam",
        "autocast(",
        "GradScaler",
        "_repeat_tensor_batch",
        "batch_candidates",
    ):
        assert forbidden not in source
    for required in (
        "torch.inference_mode()",
        "select_action",
        '"optimizer_steps": 0',
        '"backward_calls": 0',
        '"amp_enabled": AMP_ENABLED',
        '"batch_calibration_performed": False',
        '"formal_numeric_path_match": True',
    ):
        assert required in source
    assert "_ScalarLaneExecutor(" in smoke_source
    assert "initializer=_initialize_formal_lane_worker" in smoke_source
    assert "_run_gpu_smoke_lane" in smoke_source
    assert "tensor.detach().clone()" in preload_source
    assert "torch.equal" in integrity_source
    assert "_verify_resident_checkpoint_integrity" in lane_source
    assert "_FORMAL_LANE_AGENT_CACHE.clear()" in release_source
    assert "_FORMAL_LANE_DEVICE_BASELINES.clear()" in release_source
    assert "torch.cuda.empty_cache()" in release_source
    assert lane_source.index("sustained_started = time.perf_counter()") < lane_source.index(
        'for warmup_index, slot in enumerate(("A", "B"))'
    ) < lane_source.index("while time.perf_counter() < deadline or decisions < 2")
    assert "setup_seconds = sustained_started - lane_started" in lane_source
    assert lane_source.index("_verify_resident_checkpoint_integrity()") < lane_source.index(
        '"device_free_memory_bytes"'
    ) < lane_source.index("_release_gpu_smoke_lane_state()")
    lane_tree = ast.parse(lane_source)
    assert not any(
        isinstance(node, ast.Attribute) and node.attr == "cpu"
        for node in ast.walk(lane_tree)
    )
    assert smoke_source.index("workflow_started = time.perf_counter()") < smoke_source.index(
        "with _ScalarLaneExecutor"
    ) < smoke_source.index(
        "workflow_wall_seconds = time.perf_counter() - workflow_started"
    ) < smoke_source.index(
        "_gpu_smoke_pre_cleanup_memory_snapshot"
    )


def test_gpu_smoke_final_cleanup_releases_only_smoke_cuda_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import torch

    agent_cache = {("checkpoint", "cuda"): object()}
    baselines = {"checkpoint": {"weight": object()}}
    calls: list[str] = []
    monkeypatch.setattr(formal, "_FORMAL_LANE_AGENT_CACHE", agent_cache)
    monkeypatch.setattr(formal, "_FORMAL_LANE_DEVICE_BASELINES", baselines)
    monkeypatch.setattr(formal.gc, "collect", lambda: calls.append("gc"))
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: calls.append("empty_cache"))

    formal._release_gpu_smoke_lane_state()

    assert agent_cache == {}
    assert baselines == {}
    assert calls == ["gc", "empty_cache"]


def test_gpu_smoke_memory_evidence_uses_final_pre_cleanup_worker_minimum() -> None:
    preload_pids = set(range(100, 100 + formal.SCALAR_LANE_COUNT))
    final_case = formal.GPU_SMOKE_CASE_COUNT - 1
    total_bytes = 32 * 1024**3
    rows = [
        {
            "case_index": final_case,
            "worker_pid": pid,
            "device_free_memory_bytes": 20_000_000_000 + index,
            "device_total_memory_bytes": total_bytes,
        }
        for index, pid in enumerate(sorted(preload_pids))
    ]
    rows.append(
        {
            "case_index": 0,
            "worker_pid": 999,
            "device_free_memory_bytes": total_bytes,
            "device_total_memory_bytes": total_bytes,
        }
    )

    assert formal._gpu_smoke_pre_cleanup_memory_snapshot(rows, preload_pids) == (
        20_000_000_000,
        total_bytes,
    )

    with pytest.raises(formal.FormalExecutionError, match="all preloaded workers"):
        formal._gpu_smoke_pre_cleanup_memory_snapshot(rows[:-2], preload_pids)


def test_gpu_smoke_uses_a_real_game_and_rejects_mutation() -> None:
    from lifeline_rl import LifelineGame

    class ObservingAgent:
        def select_action(self, game: LifelineGame, rng: object) -> int:
            assert isinstance(game, LifelineGame)
            assert rng is not None
            return game.num_points

    game = LifelineGame(5, superko_mode="enforce")
    playable_copy = formal.legacy._playable_game_copy(game)
    assert isinstance(playable_copy, LifelineGame)
    assert playable_copy is not game
    assert playable_copy.clone() == game.clone()
    assert formal._gpu_smoke_select_action(ObservingAgent(), game, object()) == (
        game.num_points
    )
    with pytest.raises(formal.FormalExecutionError, match="detached GameSnapshot"):
        formal._gpu_smoke_select_action(ObservingAgent(), game.clone(), object())

    class MutatingAgent:
        def select_action(self, game: LifelineGame, rng: object) -> int:
            del rng
            game.skip_turn()
            return game.num_points

    with pytest.raises(formal.FormalExecutionError, match="mutated its input game"):
        formal._gpu_smoke_select_action(MutatingAgent(), game, object())

    lane_source = inspect.getsource(formal._run_gpu_smoke_lane)
    assert "games[decisions % len(games)].clone()" not in lane_source
    assert "_gpu_smoke_select_action" in lane_source
    assert "legacy._apply_action_index" in lane_source
    assert "decision_state_fingerprints" in lane_source


def test_d18_source_uses_shared_scalar_executor_and_no_training_or_batch_path() -> None:
    source = formal.SCRIPT_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    call_names = {
        node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, (ast.Attribute, ast.Name))
    }
    assert {
        "backward",
        "step",
        "zero_grad",
        "autocast",
        "GradScaler",
    }.isdisjoint(call_names)
    imported_modules = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        str(node.module)
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
    }
    assert all("batched" not in module.lower() for module in imported_modules)
    assert 'multiprocessing.get_context("spawn")' in inspect.getsource(
        formal._ScalarLaneExecutor
    )
    assert "_ScalarLaneExecutor" in inspect.getsource(formal.gpu_smoke)
    assert "_ScalarLaneExecutor" in inspect.getsource(formal.run_bundle)
    assert "_execute_pair_lanes" in inspect.getsource(formal._run_task)
    assert "torch.float32" in inspect.getsource(formal._formal_lane_agent)


def test_formal_play_game_passes_live_game_not_snapshot() -> None:
    from lifeline_rl import LifelineGame

    class PassAgent:
        name = "pass-spy"

        def __init__(self) -> None:
            self.calls = 0

        def select_action(self, game: LifelineGame, rng: object) -> None:
            assert isinstance(game, LifelineGame)
            assert rng is not None
            self.calls += 1
            return None

        def diagnostics(self) -> dict[str, object]:
            return {}

    initial = LifelineGame(5, superko_mode="enforce")
    schedule = {
        "eval_size": 5,
        "superko_mode": "enforce",
        "opening_actions": [],
        "opening_id": "empty",
        "opening_stratum": "test",
        "opening_state_hash": initial.state_fingerprint(),
        "black_slot": "A",
        "white_slot": "B",
        "black_policy_seed": 1,
        "white_policy_seed": 2,
        "max_plies": 2,
    }
    agent_a = PassAgent()
    agent_b = PassAgent()
    record = formal._play_game(schedule, agent_a=agent_a, agent_b=agent_b)
    assert agent_a.calls == 1
    assert agent_b.calls == 1
    assert record["truncated"] is False
    assert record["plies"] == 2


def test_real_frozen_schedule_schema_override_is_formal_and_hash_bound() -> None:
    class PassAgent:
        def __init__(self, name: str) -> None:
            self.name = name

        def select_action(self, game: object, rng: object) -> None:
            del game, rng
            return None

        def diagnostics(self) -> dict[str, object]:
            return {}

    bundle = (
        formal.RESEARCH_ROOT
        / "results"
        / "formal"
        / "d18_v3"
        / "run_20260901_candidate_v17"
        / "task_bundle"
    )
    assert formal.sha256_file(bundle / "game_manifest.jsonl") == (
        "85c61940984233054b6925570d96bd0d67e7076ca31df5505dc35d1bb5f29f97"
    )
    first_task = formal._read_jsonl(bundle / "tasks.jsonl")[0]
    task_schedules = [
        row
        for row in formal._read_jsonl(bundle / "game_manifest.jsonl")
        if row["task_id"] == first_task["task_id"]
    ]
    schedule = formal._bound_task_schedules(first_task, task_schedules)[0]
    assert schedule["schema_name"] == formal.prep.GAME_SCHEDULE_SCHEMA_NAME
    assert schedule["schema_name"] != formal.GAME_SCHEMA
    assert "inference_group_id" not in schedule

    record = formal._play_game(
        schedule,
        agent_a=PassAgent("pass-a"),
        agent_b=PassAgent("pass-b"),
    )
    formal._validate_game(record, schedule)
    assert "inference_group_id" not in record
    audited = independent._audit_game(
        record,
        schedule,
        preparation_runner_sha=record["preparation_runner_sha256"],
        formal_runner_sha=record["formal_runner_sha256"],
        execution_source_closure_sha=record["execution_source_closure_sha256"],
    )
    assert audited["game_id"] == schedule["game_id"]
    assert record["schema_name"] == formal.GAME_SCHEMA
    assert record["schema_version"] == formal.SCHEMA_VERSION
    assert record["schedule_sha256"] == formal.canonical_sha256(schedule)

    tampered_hash_record = copy.deepcopy(record)
    tampered_hash_record["schedule_sha256"] = "0" * 64
    with pytest.raises(formal.FormalExecutionError, match="game schedule hash mismatch"):
        formal._validate_game(tampered_hash_record, schedule)

    tampered_schedule = copy.deepcopy(schedule)
    tampered_schedule["schema_name"] = formal.prep.GAME_SCHEDULE_SCHEMA_NAME + "-tampered"
    with pytest.raises(formal.FormalExecutionError, match="schedule schema mismatch"):
        formal._validate_game(record, tampered_schedule)

    tampered_record = copy.deepcopy(record)
    tampered_record["schema_version"] = formal.SCHEMA_VERSION + 1
    with pytest.raises(formal.FormalExecutionError, match="schema version mismatch"):
        formal._validate_game(tampered_record, schedule)


def test_status_is_read_only_and_never_claims_formal_ready() -> None:
    status_source = inspect.getsource(formal.read_only_status)
    collector_source = inspect.getsource(formal._current_status)
    for forbidden in ("_atomic_", "write_text", "mkdir(", "copy2("):
        assert forbidden not in status_source
        assert forbidden not in collector_source
    assert '"formal_ready": False' in collector_source
    assert '"runner_gate_passed"' in collector_source


def test_cli_requires_bundle_and_formal_confirmation() -> None:
    parser = formal._parser()
    subparsers = next(
        action for action in parser._actions if action.__class__.__name__ == "_SubParsersAction"
    )
    assert {
        "validate",
        "validate-autodl-stage",
        "readiness",
        "gpu-smoke",
        "run",
        "status",
        "prepare-autodl-stage",
        "generate-job",
    } <= set(subparsers.choices)
    with pytest.raises(SystemExit):
        parser.parse_args(["readiness"])
    smoke_args = parser.parse_args(["gpu-smoke", "--bundle-dir", "bundle"])
    assert not hasattr(smoke_args, "batch_candidates")
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "--bundle-dir", "bundle", "--run-root", "run"])
    run_args = parser.parse_args(
        [
            "run",
            "--bundle-dir",
            "bundle",
            "--run-root",
            "run",
            "--throughput-profile",
            "smoke.json",
        ]
    )
    assert run_args.device == "cuda"
    assert run_args.confirm_formal is False
    assert run_args.throughput_profile == Path("smoke.json")
    with pytest.raises(formal.FormalExecutionError, match="--confirm-formal"):
        formal.run_bundle(
            Path("missing-manifest"),
            Path("missing-bundle"),
            Path("missing-run"),
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=False,
            throughput_profile=None,
        )


def test_dual_runner_hashes_and_current_frozen_prep_binding() -> None:
    manifest = formal.prep.load_json(formal.DEFAULT_MANIFEST)
    prep_relative = formal.prep.repo_relative(formal.prep.SCRIPT_PATH)
    assert manifest["source_hashes"][prep_relative] == formal.sha256_file(
        formal.prep.SCRIPT_PATH
    )
    task = {
        "experiment_id": formal.EXPERIMENT_ID,
        "experiment_arm": "d16-v3-paired-openings",
        "task_id": "mock",
        "inference_group_id": "mock-group",
        "formal_manifest_sha256": "1" * 64,
        "protocol_sha256": "2" * 64,
        "runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "training_seed": 20260825,
        "eval_size": 5,
        "model_pair": ["padded_cnn", "grid_gnn"],
        "agent_bindings": {"A": {}, "B": {}},
        "max_plies": 256,
        "superko_mode": "enforce",
    }
    metadata = {
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "verifier_sha256": formal.sha256_file(formal.VERIFIER_PATH),
        "execution_freeze_sha256": "6" * 64,
        "task_manifest_sha256": "3" * 64,
        "game_manifest_sha256": "4" * 64,
        "formal_manifest_sha256": "1" * 64,
        "protocol_sha256": "2" * 64,
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "execution_source_hashes": {},
        "python_version": "test",
        "torch_version": "test",
        "cuda_runtime_version": "test",
        "cudnn_version": None,
        "device": "cuda",
        "device_name": "test",
        "formal_source_hash": "5" * 64,
        "throughput_profile_sha256": "7" * 64,
        "throughput_profile_artifact_path": formal.THROUGHPUT_PROFILE_ARTIFACT_NAME,
        "throughput_profile_schema_name": formal.THROUGHPUT_PROFILE_SCHEMA,
        "throughput_profile_schema_version": (
            formal.THROUGHPUT_PROFILE_SCHEMA_VERSION
        ),
        "throughput_profile_formal_manifest_sha256": "1" * 64,
        "throughput_profile_formal_runner_sha256": formal.sha256_file(
            formal.SCRIPT_PATH
        ),
        "throughput_profile_empirical_capacity_evidence_sha256": (
            formal.EMPIRICAL_CAPACITY_EVIDENCE_EXPECTED_SHA256
        ),
        "capacity_projection_method": formal.CAPACITY_PROJECTION_METHOD,
        "scalar_lane_count": formal.SCALAR_LANE_COUNT,
        "scalar_lane_execution_mode": formal.SCALAR_LANE_EXECUTION_MODE,
        "inference_batch_size": formal.INFERENCE_BATCH_SIZE,
        "inference_dtype": formal.INFERENCE_DTYPE,
        "amp_enabled": formal.AMP_ENABLED,
    }
    base = formal._task_receipt_base(task, metadata)
    assert base["preparation_runner_sha256"] == formal.sha256_file(formal.prep.SCRIPT_PATH)
    assert base["formal_runner_sha256"] == formal.sha256_file(formal.SCRIPT_PATH)
    assert base["verifier_sha256"] == formal.sha256_file(formal.VERIFIER_PATH)
    assert base["execution_freeze_sha256"] == "6" * 64
    assert base["preparation_runner_sha256"] != base["formal_runner_sha256"]


def test_job_budget_and_exact_reuse_constants() -> None:
    assert formal.MAX_RUNTIME_SECONDS == 11_520
    assert formal.POLICY_MAX_DELIVERY_BYTES == 536_870_912
    assert formal.WORKER_RUN_METADATA_RESERVE_BYTES == 67_108_864
    assert formal.MAX_EXPORT_BYTES == 469_762_048
    assert formal.INSTANCE_UUID == "pro-788096a9e3b2"
    assert formal.GPU_SPEC == "5090-p"
    assert formal.IMAGE_UUID == "base-image-ec1e9vdbd3"
    source = inspect.getsource(formal.generate_job)
    assert 'instance_reuse = "require"' in source
    assert "min_gpu_utilization_percent = 50" in source
    assert "max_runtime_seconds <= MAX_RUNTIME_SECONDS" in source
    assert "pip install" not in source
    assert "--continue-on-error" not in source

    policy_lines = formal.DEFAULT_POLICY.read_text(encoding="utf-8").splitlines()
    policy_max_export = int(
        next(
            line.split("=", 1)[1].strip()
            for line in policy_lines
            if line.strip().startswith("max_export_bytes =")
        )
    )
    assert policy_max_export == (
        formal.MAX_EXPORT_BYTES + formal.WORKER_RUN_METADATA_RESERVE_BYTES
    )


def test_generate_job_writes_parseable_exact_smoke_and_formal_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text("{}\n", encoding="utf-8")
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    stage = tmp_path / "stage"
    stage.mkdir()
    output = tmp_path / "job.toml"
    dependency_relative = "research/iclr2027/autodl/d18_v3_runtime_requirements.lock.txt"
    staged_dependency = stage / dependency_relative
    staged_dependency.parent.mkdir(parents=True)
    staged_dependency.write_bytes(formal.DEPENDENCY_LOCK_PATH.read_bytes())
    relative_paths = {
        formal.SCRIPT_PATH.resolve(): "research/iclr2027/scripts/d18_v3_formal_runner.py",
        formal.prep.SCRIPT_PATH.resolve(): "research/iclr2027/scripts/d18_v3_runner.py",
        formal.VERIFIER_PATH.resolve(): "research/iclr2027/scripts/d18_v3_verify_evidence.py",
        formal.DEPENDENCY_LOCK_PATH.resolve(): dependency_relative,
        manifest_path.resolve(): "research/iclr2027/configs/test-manifest.json",
        bundle.resolve(): "research/iclr2027/results/formal/d18_v3/test/task_bundle",
    }
    monkeypatch.setattr(
        formal,
        "_repo_relative",
        lambda path: relative_paths[Path(path).resolve()],
    )
    bundle_hashes = {
        field: str(index + 1) * 64
        for index, field in enumerate(formal.BUNDLE_HASH_FILES)
    }
    semantic = {field: f"bound/{field}" for field in formal.STAGE_SEMANTIC_HASH_FIELDS}
    stage_manifest = {
        "semantic_bindings": semantic,
        "formal_manifest_sha256": formal.sha256_file(manifest_path),
        "formal_runner_sha256": formal.sha256_file(formal.SCRIPT_PATH),
        "preparation_runner_sha256": formal.sha256_file(formal.prep.SCRIPT_PATH),
        "verifier_sha256": formal.sha256_file(formal.VERIFIER_PATH),
        **bundle_hashes,
    }
    monkeypatch.setattr(formal, "load_frozen_bundle", lambda *_: ({}, [], [], {}))
    monkeypatch.setattr(
        formal,
        "_validated_autodl_stage",
        lambda *_: (stage_manifest, "a" * 64),
    )
    monkeypatch.setattr(formal, "_stage_semantic_bindings", lambda *_: semantic)
    monkeypatch.setattr(formal, "_require_stage_matches_local_closure", lambda *_: None)
    monkeypatch.setattr(formal, "_bundle_hashes", lambda *_: bundle_hashes)
    report = formal.generate_job(
        manifest_path,
        bundle,
        stage,
        output,
        local_python=Path("C:/Python/python.exe"),
        remote_python="python3",
        max_runtime_seconds=11_520,
    )
    parsed = tomllib.loads(output.read_text(encoding="utf-8"))
    profile_path = "$AUTODL_WORK_DIR/d18_v3_gpu_throughput.json"
    assert parsed["instance_reuse"] == "require"
    assert parsed["preferred_instance_uuid"] == "pro-788096a9e3b2"
    assert parsed["allowed_gpu_specs"] == ["5090-p"]
    assert parsed["image_uuid"] == formal.IMAGE_UUID
    assert parsed["framework_version"] == "2.8.0"
    assert parsed["cuda_runtime"] == "12.8"
    assert parsed["dependency_lock"] == dependency_relative
    probe = parsed["environment_probe_command"]
    assert "import importlib.metadata, pynvml, sys, torch" in probe
    assert "importlib.metadata.version('nvidia-ml-py') == '13.610.43'" in probe
    assert "pynvml.nvmlInit(); pynvml.nvmlShutdown()" in probe
    assert "utilization = torch.cuda.utilization()" in probe
    assert "isinstance(utilization, int) and 0 <= utilization <= 100" in probe
    assert parsed["gpu_num"] == 1
    assert parsed["min_gpu_utilization_percent"] == 50
    assert parsed["max_runtime_seconds"] == 11_520
    assert "--seconds 27" in parsed["gpu_smoke_command"]
    assert parsed["gpu_smoke_timeout_seconds"] == 60
    assert formal.GPU_SMOKE_PRODUCT_TIMEOUT_SECONDS == 60
    assert formal.GPU_SMOKE_REQUESTED_SECONDS == 27.0
    assert independent.GPU_SMOKE_REQUESTED_SECONDS == 27.0
    assert formal.GPU_SMOKE_MAX_TASK_SHAPED_SECONDS == 30.0
    assert independent.GPU_SMOKE_MAX_TASK_SHAPED_SECONDS == 30.0
    assert formal.GPU_SMOKE_MAX_WORKFLOW_WALL_SECONDS == 57.0
    assert independent.GPU_SMOKE_MAX_WORKFLOW_WALL_SECONDS == 57.0
    parsed_default = formal._parser().parse_args(
        ["gpu-smoke", "--bundle-dir", str(bundle)]
    )
    assert parsed_default.seconds == 27.0
    assert f"--profile-output {profile_path}" in parsed["gpu_smoke_command"]
    assert f"--throughput-profile {profile_path}" in parsed["command"]
    expected_runner = relative_paths[formal.SCRIPT_PATH.resolve()]
    assert parsed["gpu_smoke_command"].startswith(f"python3 {expected_runner} gpu-smoke")
    assert parsed["command"].startswith(f"python3 {expected_runner} run")
    assert report["gpu_smoke_command"] == parsed["gpu_smoke_command"]
    assert report["formal_command"] == parsed["command"]


def test_readiness_uses_only_the_frozen_stage_copy(tmp_path: Path) -> None:
    stage = (tmp_path / "immutable-stage").resolve()
    local_python = (
        Path("C:/Python/python.exe")
        if sys.platform == "win32"
        else Path("/opt/python/bin/python")
    )
    bundle = (
        formal.RESEARCH_ROOT
        / "results"
        / "formal"
        / "d18_v3"
        / "synthetic"
        / "task_bundle"
    )
    command = formal._build_staged_readiness_command(
        local_python=local_python,
        stage_directory=stage,
        manifest_path=formal.DEFAULT_MANIFEST,
        bundle_directory=bundle,
        stage_manifest_sha256="a" * 64,
    )
    expected_runner = Path(formal._repo_relative(formal.SCRIPT_PATH)).as_posix()
    expected_manifest = Path(
        formal._repo_relative(formal.DEFAULT_MANIFEST)
    ).as_posix()
    expected_bundle = Path(formal._repo_relative(bundle)).as_posix()
    assert command == (
        f"{local_python.resolve().as_posix()} -B {expected_runner} readiness "
        f"--manifest {expected_manifest} --bundle-dir {expected_bundle} "
        f"--stage-dir . --expected-stage-manifest-sha256 {'a' * 64}"
    )
    assert '"' not in command
    assert str(stage) not in command
    assert str(formal.SCRIPT_PATH) not in command
    assert str(formal.DEFAULT_MANIFEST) not in command
    assert str(bundle) not in command


def test_readiness_rejects_a_local_python_path_that_requires_quotes(
    tmp_path: Path,
) -> None:
    with pytest.raises(formal.FormalExecutionError, match="quote-free shell tokens"):
        formal._build_staged_readiness_command(
            local_python=tmp_path / "python with space.exe",
            stage_directory=tmp_path / "stage",
            manifest_path=formal.DEFAULT_MANIFEST,
            bundle_directory=(
                formal.RESEARCH_ROOT
                / "results"
                / "formal"
                / "d18_v3"
                / "synthetic"
                / "task_bundle"
            ),
            stage_manifest_sha256="a" * 64,
        )


def test_dependency_lock_is_hash_bound_and_staged() -> None:
    assert formal.DEPENDENCY_LOCK_PATH.relative_to(formal.REPO_ROOT).as_posix() == (
        "research/iclr2027/autodl/d18_v3_runtime_requirements.lock.txt"
    )
    assert formal.DEPENDENCY_LOCK_PATH.read_bytes() == (
        b"--index-url https://pypi.org/simple\n"
        b"torch==2.8.0\nnvidia-ml-py==13.610.43\n"
    )
    assert formal.sha256_file(formal.DEPENDENCY_LOCK_PATH) == (
        "8476a85f5dfd94751bdd645358e481a5d108ba4cbad80c47c98c8f83370edae5"
    )
    dependency_source = inspect.getsource(formal._execution_dependency_paths)
    source_hashes = inspect.getsource(formal._execution_source_hashes)
    stage_source = inspect.getsource(formal.prepare_autodl_stage)
    job_source = inspect.getsource(formal.generate_job)
    readiness_source = inspect.getsource(formal._build_staged_readiness_command)
    assert "DEPENDENCY_LOCK_PATH" in dependency_source
    assert "_execution_dependency_paths" in source_hashes
    assert "_execution_dependency_paths" in stage_source
    assert "dependency_lock_relative" in job_source
    assert "staged dependency lock is missing or differs" in job_source
    assert 'setup_revision = f"d18-v3-stage-{stage_manifest_sha256}"' in job_source
    assert "validate-autodl-stage" in job_source
    assert "expected-stage-manifest-sha256" in readiness_source


def test_execution_dependency_closure_covers_runtime_sidecars() -> None:
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    manifest = formal.prep.load_json(formal.DEFAULT_MANIFEST)
    dependencies = set(formal._execution_dependency_paths(formal.DEFAULT_MANIFEST))
    assert formal.EMPIRICAL_CAPACITY_EVIDENCE_PATH in dependencies
    assert formal.EMPIRICAL_CAPACITY_EVIDENCE_BUILDER_PATH in dependencies
    assert formal.prep.openings_v3.DEFAULT_V1_OPENINGS in dependencies
    assert set(AlphaZeroTrainer.source_files()) <= dependencies
    latest_paths = {
        formal._resolve_repo_path(row["latest_manifest_path"])
        for row in manifest["checkpoints"]
    }
    assert len(latest_paths) == 15
    assert latest_paths <= dependencies


def test_stage_validator_binds_exact_manifest_and_rejects_extra_file(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "stage"
    stage.mkdir()
    manifest_sha256 = _minimal_autodl_stage(stage)
    report = formal.validate_autodl_stage(
        stage, expected_manifest_sha256=manifest_sha256
    )
    assert report["status"] == "PASS"
    assert report["stage_manifest_sha256"] == manifest_sha256

    extra = stage / "unexpected.txt"
    extra.write_text("unexpected", encoding="utf-8")
    with pytest.raises(formal.FormalExecutionError, match="file closure differs"):
        formal.validate_autodl_stage(
            stage, expected_manifest_sha256=manifest_sha256
        )


def test_stage_validator_rejects_duplicate_and_unsafe_rows(tmp_path: Path) -> None:
    stage = tmp_path / "stage"
    stage.mkdir()
    _minimal_autodl_stage(stage)
    manifest_path = stage / "autodl_stage_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"].append(copy.deepcopy(manifest["files"][0]))
    manifest["file_count"] += 1
    manifest["total_bytes"] += manifest["files"][0]["bytes"]
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(formal.FormalExecutionError, match="duplicate stage file row"):
        formal.validate_autodl_stage(stage)

    manifest["files"][-1]["path"] = "../escape"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(formal.FormalExecutionError, match="unsafe"):
        formal.validate_autodl_stage(stage)


@pytest.mark.parametrize("field", formal.STAGE_SEMANTIC_HASH_FIELDS)
def test_stage_validator_rejects_rehashed_semantic_payload(
    tmp_path: Path, field: str
) -> None:
    stage = tmp_path / "stage"
    stage.mkdir()
    _minimal_autodl_stage(stage)
    manifest_path = stage / "autodl_stage_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    relative = manifest["semantic_bindings"][field]
    payload_path = stage / Path(relative)
    original_bytes = payload_path.stat().st_size
    payload_path.write_bytes(payload_path.read_bytes() + b" tampered")
    row = next(item for item in manifest["files"] if item["path"] == relative)
    row["sha256"] = formal.sha256_file(payload_path)
    row["bytes"] = payload_path.stat().st_size
    manifest["total_bytes"] += row["bytes"] - original_bytes
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(
        formal.FormalExecutionError,
        match=f"stage semantic binding differs: {field}",
    ):
        formal.validate_autodl_stage(stage)


def test_stage_local_closure_rejects_rehashed_nonsemantic_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    source = repo / "research" / "iclr2027" / "protocol.md"
    bundle = repo / "research" / "iclr2027" / "results" / "task_bundle"
    source.parent.mkdir(parents=True)
    bundle.mkdir(parents=True)
    source.write_bytes(b"trusted protocol")
    for filename in formal.BUNDLE_HASH_FILES.values():
        (bundle / filename).write_bytes(filename.encode("utf-8"))
    manifest_path = repo / "research" / "iclr2027" / "configs" / "manifest.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_bytes(b"trusted manifest")

    monkeypatch.setattr(formal, "REPO_ROOT", repo)
    monkeypatch.setattr(
        formal,
        "_execution_source_hashes",
        lambda _: {
            "research/iclr2027/protocol.md": formal.sha256_file(source),
        },
    )
    expected = formal._expected_stage_rows(manifest_path, bundle)
    forged = copy.deepcopy(expected)
    forged_path = repo / "research" / "iclr2027" / "forged_protocol.md"
    forged_path.write_bytes(b"forged protocol")
    forged["research/iclr2027/protocol.md"] = {
        "path": "research/iclr2027/protocol.md",
        "sha256": formal.sha256_file(forged_path),
        "bytes": forged_path.stat().st_size,
    }
    stage_manifest = {"files": list(forged.values())}
    with pytest.raises(
        formal.FormalExecutionError,
        match="exact local source and bundle closure",
    ):
        formal._require_stage_matches_local_closure(
            stage_manifest, manifest_path, bundle
        )


def test_export_byte_bound_fails_before_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    monkeypatch.setattr(formal, "MAX_EXPORT_BYTES", 4)
    monkeypatch.setattr(formal, "EXPORT_MANIFEST_RESERVE_BYTES", 0)
    with pytest.raises(formal.FormalExecutionError, match="fail-closed byte bound"):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
        )
    assert not export_root.exists()


def test_export_manifest_records_bounded_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    monkeypatch.setattr(formal, "MAX_EXPORT_BYTES", 16_384)
    monkeypatch.setattr(formal, "EXPORT_MANIFEST_RESERVE_BYTES", 8_192)
    manifest = formal.export_results(
        run_root,
        export_root,
        expected_task_directory_names={"synthetic-task"},
    )
    assert manifest["total_bytes"] == 9 * len(b"{}\n")
    assert manifest["max_export_bytes"] == 16_384
    assert manifest["projected_upper_bound_bytes"] <= 16_384
    assert (export_root / "canonical_numeric.json").read_bytes() == b"{}\n"
    assert len([path for path in export_root.rglob("*") if path.is_file()]) == 10


def test_independent_verifier_accepts_exact_legal_delivery_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    task_id = "synthetic-task"
    task_directory_name = formal._task_directory(run_root, task_id).name
    _minimal_export_tree(run_root, task_directory_name)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    monkeypatch.setattr(independent, "PAIRS_PER_TASK", 1)
    formal.export_results(
        run_root,
        export_root,
        expected_task_directory_names={task_directory_name},
    )
    independent._validate_evidence_root_entries(
        export_root, [{"task_id": task_id}]
    )


def test_export_full_source_rehash_count_is_constant_per_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    closure_checks = 0

    def count_full_rehash(_: object) -> dict[str, str]:
        nonlocal closure_checks
        closure_checks += 1
        return {
            "preparation_runner_sha256": "1" * 64,
            "formal_runner_sha256": "2" * 64,
            "execution_source_closure_sha256": "3" * 64,
        }

    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        count_full_rehash,
    )
    formal.export_results(
        run_root,
        export_root,
        expected_task_directory_names={"synthetic-task"},
        metadata={"frozen": True},
    )
    assert closure_checks == 2
    assert len([path for path in export_root.rglob("*") if path.is_file()]) == 10


def test_export_detects_source_drift_after_copy_batch_before_return(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    closure_checks = 0
    drifted = False

    def fail_final_full_rehash(_: object) -> dict[str, str]:
        nonlocal closure_checks
        closure_checks += 1
        if drifted:
            raise formal.FormalExecutionError(
                "execution source closure changed during the formal run"
            )
        return {
            "preparation_runner_sha256": "1" * 64,
            "formal_runner_sha256": "2" * 64,
            "execution_source_closure_sha256": "3" * 64,
        }

    original_copy = formal._copy_verified

    def copy_then_drift(*args: object, **kwargs: object) -> None:
        nonlocal drifted
        original_copy(*args, **kwargs)
        drifted = True

    monkeypatch.setattr(
        formal,
        "_require_execution_source_closure",
        fail_final_full_rehash,
    )
    monkeypatch.setattr(formal, "_copy_verified", copy_then_drift)
    with pytest.raises(
        formal.FormalExecutionError,
        match="execution source closure changed during the formal run",
    ):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
            metadata={"frozen": True},
        )
    assert closure_checks == 2
    assert (export_root / "export_manifest.json").is_file()


def test_export_rejects_stale_destination_before_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    export_root.mkdir()
    stale = export_root / "stale.bin"
    stale.write_bytes(b"stale")
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    with pytest.raises(formal.FormalExecutionError, match="stale or unknown files"):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
        )
    assert stale.read_bytes() == b"stale"
    assert not (export_root / "canonical_numeric.json").exists()


def test_export_rejects_stale_expected_file_before_other_copies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    export_root.mkdir()
    stale = export_root / "canonical_numeric.json"
    stale.write_bytes(b"stale")
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    with pytest.raises(formal.FormalExecutionError, match="hash or size differs"):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
        )
    assert stale.read_bytes() == b"stale"
    assert not (export_root / "execution_metadata.json").exists()


def test_export_rejects_task_directory_substitution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    with pytest.raises(formal.FormalExecutionError, match="file set differs"):
        formal.export_results(
            run_root,
            tmp_path / "export",
            expected_task_directory_names={"different-frozen-task"},
        )


def test_export_final_scan_detects_post_copy_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    original_copy = formal._copy_verified

    def mutating_copy(*args: object, **kwargs: object) -> None:
        original_copy(*args, **kwargs)
        destination = args[1]
        assert isinstance(destination, Path)
        canonical = export_root / "canonical_numeric.json"
        if destination.name == "summary.json" and canonical.is_file():
            canonical.write_bytes(b"post-copy mutation")

    monkeypatch.setattr(formal, "_copy_verified", mutating_copy)
    with pytest.raises(formal.FormalExecutionError, match="hash or size differs"):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
        )


def test_export_copy_rejects_source_drift_from_preflight(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    source.write_bytes(b"before")
    expected_sha256 = formal.sha256_file(source)
    expected_bytes = source.stat().st_size
    source.write_bytes(b"changed-after-preflight")
    destination = tmp_path / "export" / "source.json"
    with pytest.raises(formal.FormalExecutionError, match="changed after preflight"):
        formal._copy_verified(
            source,
            destination,
            expected_sha256=expected_sha256,
            expected_bytes=expected_bytes,
        )
    assert not destination.exists()


def test_export_rejects_source_reported_as_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    flagged = run_root / "canonical_numeric.json"
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda self: self == flagged or original_is_symlink(self),
    )
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    with pytest.raises(formal.FormalExecutionError, match="contains a symlink"):
        formal.export_results(
            run_root,
            tmp_path / "export",
            expected_task_directory_names={"synthetic-task"},
        )


def test_export_rejects_destination_reported_as_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_root = tmp_path / "run"
    run_root.mkdir()
    _minimal_export_tree(run_root)
    export_root = tmp_path / "export"
    export_root.mkdir()
    flagged = export_root / "canonical_numeric.json"
    flagged.write_bytes((run_root / "canonical_numeric.json").read_bytes())
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda self: self == flagged or original_is_symlink(self),
    )
    monkeypatch.setattr(formal, "EXPECTED_TASKS", 1)
    monkeypatch.setattr(formal, "EXPECTED_PAIRS_PER_TASK", 1)
    with pytest.raises(formal.FormalExecutionError, match="destination contains a symlink"):
        formal.export_results(
            run_root,
            export_root,
            expected_task_directory_names={"synthetic-task"},
        )


def test_writer_lock_is_nonblocking(tmp_path: Path) -> None:
    path = tmp_path / formal.WRITER_LOCK_NAME
    with formal._AdvisoryWriterLock(path):
        with pytest.raises(formal.FormalExecutionError, match="another D18-v3"):
            with formal._AdvisoryWriterLock(path):
                raise AssertionError("second writer unexpectedly acquired the lock")


def test_runner_numeric_contract_uses_seed_by_stratum_units() -> None:
    tasks: list[dict[str, object]] = []
    records: list[dict[str, object]] = []
    for left, right in formal.prep.MODEL_PAIRS:
        for size in formal.prep.SIZES:
            group_id = f"d16-v3.{left}_vs_{right}.n{size}"
            for training_seed in formal.prep.TRAINING_SEEDS:
                task_id = (
                    f"d18v3.n{size}.seed{training_seed}.{left}.vs.{right}"
                )
                tasks.append(
                    {
                        "task_id": task_id,
                        "inference_group_id": group_id,
                        "model_pair": [left, right],
                        "eval_size": size,
                    }
                )
                for stratum in range(32):
                    for variant in (0, 1):
                        for member in (0, 1):
                            records.append(
                                {
                                    "task_id": task_id,
                                    "training_seed": training_seed,
                                    "opening_stratum": f"n{size}_s{stratum:02d}",
                                    "opening_variant": variant,
                                    "pair_member": member,
                                    "black_slot": "A" if member == 0 else "B",
                                    "winner": "DRAW",
                                    "truncated": False,
                                }
                            )
    assert all("inference_group_id" not in record for record in records)
    comparison_records = formal._runner_bind_inference_groups(records, tasks)
    assert all("inference_group_id" not in record for record in records)
    rows = formal._runner_comparison_rows(
        comparison_records, bootstrap_replicates=25
    )
    assert len(rows) == 9
    assert all(row["games_completed"] == 640 for row in rows)
    assert all(row["seed_by_opening_stratum_units"] == 160 for row in rows)
    assert all(row["paired_a_score_equal_weighted_over_seed_and_stratum"] == 0.5 for row in rows)
    assert all(row["primary_ci95"] == [0.5, 0.5] for row in rows)
    assert all(row["secondary_ci95"] == [0.5, 0.5] for row in rows)

    conflicting = copy.deepcopy(records)
    conflicting[0]["inference_group_id"] = "d16-v3.grid_gnn_vs_resmlp.n5"
    with pytest.raises(
        formal.FormalExecutionError,
        match="game inference group conflicts with its task",
    ):
        formal._runner_bind_inference_groups(conflicting, tasks)

    unknown = copy.deepcopy(records)
    unknown[0]["task_id"] = "unknown-task"
    unknown[0]["inference_group_id"] = tasks[0]["inference_group_id"]
    with pytest.raises(
        formal.FormalExecutionError,
        match="record has no matching task",
    ):
        formal._runner_bind_inference_groups(unknown, tasks)

    inconsistent_tasks = copy.deepcopy(tasks)
    inconsistent_tasks[0][
        "inference_group_id"
    ] = "d16-v3.grid_gnn_vs_resmlp.n5"
    with pytest.raises(
        formal.FormalExecutionError,
        match="canonical aggregation inference group is inconsistent",
    ):
        formal._runner_bind_inference_groups(records, inconsistent_tasks)

    with pytest.raises(
        formal.FormalExecutionError,
        match="duplicate canonical aggregation task",
    ):
        formal._runner_bind_inference_groups(records, [*tasks, tasks[0]])


def test_readiness_loads_every_checkpoint_and_covers_all_sizes() -> None:
    source = inspect.getsource(formal.task_shaped_readiness)
    assert 'manifest["checkpoints"]' in source
    assert 'len(checkpoint_ids) == 15' in source
    assert 'seen_sizes == {5, 7, 9}' in source


def test_runner_and_independent_interval_implementations_match() -> None:
    matrix = {
        seed: {
            f"s{stratum:02d}": ((seed - 20260825) + (stratum % 5)) / 8.0
            for stratum in range(32)
        }
        for seed in formal.prep.TRAINING_SEEDS
    }
    assert formal._runner_crossed_bootstrap(
        matrix, replicates=250, seed=formal.BOOTSTRAP_SEED
    ) == independent._crossed_bootstrap(
        matrix, replicates=250, seed=independent.BOOTSTRAP_SEED
    )
    seed_means = [0.2, 0.35, 0.5, 0.65, 0.8]
    assert formal._runner_seed_t_interval(seed_means) == independent._seed_t_interval(
        seed_means
    )
