"""Pure structural tests for the D18-v3 formal execution layer.

These tests never call readiness, GPU smoke, formal run, model construction,
or an arena game.  They exercise joins, hashes, fail-closed gates, and command
surface invariants with synthetic dictionaries only.
"""

from __future__ import annotations

import ast
import copy
import inspect
import json
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


def _canary_pair_payload() -> dict[str, object]:
    from lifeline_rl import LifelineGame

    game = LifelineGame(5, superko_mode="enforce")
    schedules = []
    for member in (0, 1):
        schedules.append(
            {
                "task_id": "canary-task",
                "pair_id": "canary-pair",
                "pair_index": 0,
                "pair_member": member,
                "eval_size": 5,
                "superko_mode": "enforce",
                "opening_actions": [],
                "opening_id": "canary-empty",
                "opening_stratum": "canary-stratum",
                "opening_variant": 0,
                "opening_state_hash": game.state_fingerprint(),
                "black_slot": "A" if member == 0 else "B",
                "white_slot": "B" if member == 0 else "A",
                "black_policy_seed": 100 + member,
                "white_policy_seed": 200 + member,
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


def _write_valid_throughput_profile(
    root: Path,
) -> tuple[Path, Path, dict[str, object], list[dict[str, object]]]:
    manifest_path = root / "formal_manifest.json"
    manifest_path.write_text("{}\n", encoding="utf-8", newline="\n")
    tasks: list[dict[str, object]] = []
    for pair in formal.PROFILE_MODEL_PAIRS:
        for size in formal.PROFILE_EVAL_SIZES:
            for seed_offset in range(5):
                seed = 20260825 + seed_offset
                tasks.append(
                    {
                        "model_pair": list(pair),
                        "eval_size": size,
                        "training_seed": seed,
                        "max_plies": 256,
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
                        "pair_plan": [
                            {
                                "opening_id": f"opening-n{size}",
                                "opening_actions": [0],
                                "opening_prefix_hash": f"{size:064x}",
                                "opening_state_hash": f"{size + 1:064x}",
                            }
                        ],
                    }
                )
    payloads = formal._gpu_smoke_lane_payloads(tasks, seconds=20.0)
    lane_results: list[dict[str, object]] = []
    for payload in payloads:
        binding = payload["agent_binding"]
        opening = payload["opening"]
        assert isinstance(binding, dict) and isinstance(opening, dict)
        lane_results.append(
            {
                "lane_index": payload["lane_index"],
                "coverage_case_id": payload["coverage_case_id"],
                "checkpoint_id": binding["checkpoint_id"],
                "model_kind": binding["model_kind"],
                "model_pair": payload["model_pair"],
                "agent_slot": payload["agent_slot"],
                "eval_size": payload["eval_size"],
                "opening_id": opening["opening_id"],
                "puct_decisions": 300,
                "model_forward_calls": 5_100,
                "setup_seconds": 0.5,
                "sustained_seconds": 20.0,
                "total_seconds": 20.5,
                "gpu_utilization_samples_percent": [60.0],
                "max_memory_allocated_bytes": 128 * 1024**2,
                "device": "cuda",
                "device_name": "NVIDIA GeForce RTX 5090",
                "device_total_memory_bytes": 32 * 1024**3,
                "torch_version": "2.8.0+cu128",
                "cuda_runtime_version": "12.8",
            }
        )
    decisions = 300 * formal.SCALAR_LANE_COUNT
    forwards = 5_100 * formal.SCALAR_LANE_COUNT
    rate = decisions / 20.0
    worst_case_decisions = formal.EXPECTED_GAMES * 256
    memory = formal.SCALAR_LANE_COUNT * 128 * 1024**2
    profile: dict[str, object] = {
        "schema_name": formal.THROUGHPUT_PROFILE_SCHEMA,
        "schema_version": formal.SCHEMA_VERSION,
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
        "coverage": formal._profile_coverage(lane_results),
        "input_parse_and_collate_seconds": 0.01,
        "setup_seconds": 0.5,
        "puct_decisions": decisions,
        "model_forward_calls": forwards,
        "requested_sustained_seconds": 20.0,
        "sustained_seconds": 20.0,
        "duration_seconds": 22.0,
        "total_seconds": 22.0,
        "aggregate_window_seconds": 20.0,
        "aggregate_puct_decisions_per_second": rate,
        "formal_game_count": formal.EXPECTED_GAMES,
        "formal_max_plies": 256,
        "worst_case_puct_decisions": worst_case_decisions,
        "formal_runtime_seconds": formal.MAX_RUNTIME_SECONDS,
        "non_gameplay_reserve_fraction": formal.FORMAL_NON_GAMEPLAY_RESERVE_FRACTION,
        "formal_gameplay_budget_seconds": formal.FORMAL_GAMEPLAY_BUDGET_SECONDS,
        "projected_worst_case_seconds": worst_case_decisions / rate,
        "lane_results": lane_results,
        "gpu_utilization_samples_percent": [60.0] * formal.SCALAR_LANE_COUNT,
        "gpu_utilization_mean_percent": 60.0,
        "gpu_utilization_max_percent": 60.0,
        "aggregate_peak_memory_allocated_bytes": memory,
        "aggregate_peak_memory_limit_bytes": formal.MAX_AGGREGATE_LANE_MEMORY_BYTES,
        "minimum_device_memory_bytes": formal.MIN_DEVICE_MEMORY_BYTES,
    }
    profile_path = root / "throughput.json"
    profile_path.write_text(
        json.dumps(profile, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest_path, profile_path, profile, tasks


def _minimal_export_tree(root: Path) -> None:
    for name in (
        "canonical_numeric.json",
        "execution_metadata.json",
        "execution_summary.json",
        "result_receipts.jsonl",
        formal.THROUGHPUT_PROFILE_ARTIFACT_NAME,
    ):
        (root / name).write_bytes(b"{}\n")
    task_root = root / "tasks" / "synthetic-task"
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
    formal._initialize_formal_lane_worker(manifest, str(formal.DEFAULT_MANIFEST), "cpu")
    manifest["nested"]["value"] = 2
    assert formal._FORMAL_LANE_MANIFEST == {"nested": {"value": 1}}
    assert formal._FORMAL_LANE_MANIFEST_PATH == formal.DEFAULT_MANIFEST.resolve()
    assert formal._FORMAL_LANE_DEVICE == "cpu"
    assert formal._FORMAL_LANE_AGENT_CACHE == {}


def test_throughput_profile_is_required_and_accepts_exact_identity(
    tmp_path: Path,
) -> None:
    manifest_path, profile_path, profile, tasks = _write_valid_throughput_profile(
        tmp_path
    )
    assert formal._validate_throughput_profile(
        profile_path, manifest_path=manifest_path, tasks=tasks
    ) == profile
    with pytest.raises(
        formal.FormalExecutionError, match="formal throughput profile is missing"
    ):
        formal._validate_throughput_profile(
            tmp_path / "missing.json", manifest_path=manifest_path, tasks=tasks
        )
    run_source = inspect.getsource(formal.run_bundle)
    assert run_source.index("_validate_throughput_profile") < run_source.index(
        "_validate_write_target"
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
    manifest_path, profile_path, profile, tasks = _write_valid_throughput_profile(
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
            profile_path, manifest_path=manifest_path, tasks=tasks
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    (
        ("slow", "cannot finish"),
        ("memory", "aggregate lane memory"),
        ("coverage", "coverage is incomplete"),
        ("nonfinite", "must be finite"),
        ("environment", "is not CUDA"),
    ),
)
def test_throughput_profile_rejects_capacity_memory_coverage_and_environment(
    tmp_path: Path, mutation: str, message: str
) -> None:
    manifest_path, profile_path, profile, tasks = _write_valid_throughput_profile(
        tmp_path
    )
    lanes = profile["lane_results"]
    assert isinstance(lanes, list)
    if mutation == "slow":
        for lane in lanes:
            lane["puct_decisions"] = 100
            lane["model_forward_calls"] = 1_700
        profile["puct_decisions"] = 1_200
        profile["model_forward_calls"] = 20_400
        profile["aggregate_puct_decisions_per_second"] = 60.0
        profile["projected_worst_case_seconds"] = (
            formal.EXPECTED_GAMES * 256 / 60.0
        )
    elif mutation == "memory":
        lanes[0]["max_memory_allocated_bytes"] = formal.MAX_AGGREGATE_LANE_MEMORY_BYTES
        profile["aggregate_peak_memory_allocated_bytes"] = (
            formal.MAX_AGGREGATE_LANE_MEMORY_BYTES
            + (formal.SCALAR_LANE_COUNT - 1) * 128 * 1024**2
        )
    elif mutation == "coverage":
        profile["coverage"]["model_kinds"] = ["padded_cnn"]
    elif mutation == "nonfinite":
        profile["total_seconds"] = float("nan")
    else:
        lanes[0]["device"] = "cpu"
    profile_path.write_text(json.dumps(profile, sort_keys=True), encoding="utf-8")
    with pytest.raises(formal.FormalExecutionError, match=message):
        formal._validate_throughput_profile(
            profile_path, manifest_path=manifest_path, tasks=tasks
        )


def test_independent_verifier_rehashes_and_revalidates_complete_profile(
    tmp_path: Path,
) -> None:
    manifest_path, _, profile, tasks = _write_valid_throughput_profile(tmp_path)
    evidence = tmp_path / independent.THROUGHPUT_PROFILE_ARTIFACT_NAME
    evidence.write_text(
        json.dumps(profile, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    metadata = {
        "throughput_profile_sha256": independent.sha256_file(evidence),
        "preparation_runner_sha256": independent.sha256_file(formal.prep.SCRIPT_PATH),
    }
    assert independent._validate_throughput_profile_evidence(
        evidence,
        metadata=metadata,
        tasks=tasks,
        formal_manifest_sha=independent.sha256_file(manifest_path),
        formal_runner_sha=independent.sha256_file(formal.SCRIPT_PATH),
    ) == profile
    evidence.write_text(evidence.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(independent.VerificationError, match="hash differs"):
        independent._validate_throughput_profile_evidence(
            evidence,
            metadata=metadata,
            tasks=tasks,
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
            del worker
            rows = list(payloads)  # type: ignore[arg-type]
            self.indices = [int(row["schedules"][0]["pair_index"]) for row in rows]
            return [{"pair_index": index} for index in self.indices]

    task_directory = tmp_path / "task"
    (task_directory / "pairs").mkdir(parents=True)
    pairs = {
        index: [
            {"pair_index": index, "pair_member": member}
            for member in (0, 1)
        ]
        for index in range(3)
    }
    monkeypatch.setattr(formal, "_validate_pair", lambda *_: [])
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
            {"task_id": "synthetic"},
            pairs,
            task_directory=task_directory,
            lane_executor=first,  # type: ignore[arg-type]
        )
    assert first.indices == [0, 1, 2]
    assert (task_directory / "pairs" / "pair_0000.json").is_file()
    monkeypatch.setattr(formal, "_atomic_json", original_atomic)
    resumed = RecordingExecutor()
    formal._execute_pair_lanes(
        {"task_id": "synthetic"},
        pairs,
        task_directory=task_directory,
        lane_executor=resumed,  # type: ignore[arg-type]
    )
    assert resumed.indices == [1, 2]
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
    source = smoke_source + lane_source
    for forbidden in (".backward(", "Adam", "autocast(", "GradScaler", "_repeat_tensor_batch", "batch_candidates"):
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
    assert smoke_source.index("started = time.perf_counter()") < smoke_source.index(
        "with _ScalarLaneExecutor"
    ) < smoke_source.index("total_seconds = time.perf_counter() - started")


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
    assert "legacy._playable_game_copy" in lane_source
    assert "_gpu_smoke_select_action" in lane_source


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
        "throughput_profile_schema_version": formal.SCHEMA_VERSION,
        "throughput_profile_formal_manifest_sha256": "1" * 64,
        "throughput_profile_formal_runner_sha256": formal.sha256_file(
            formal.SCRIPT_PATH
        ),
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
    assert parsed["gpu_num"] == 1
    assert parsed["min_gpu_utilization_percent"] == 50
    assert parsed["max_runtime_seconds"] == 11_520
    assert "--seconds 20" in parsed["gpu_smoke_command"]
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
    assert formal.DEPENDENCY_LOCK_PATH.read_bytes() == b"--no-index\ntorch==2.8.0\n"
    assert formal.sha256_file(formal.DEPENDENCY_LOCK_PATH) == (
        "2df94edd048e9aa9990bce302672f6c71f0845e70fd0be43fbbdd719d869473a"
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
    records: list[dict[str, object]] = []
    for left, right in formal.prep.MODEL_PAIRS:
        for size in formal.prep.SIZES:
            group_id = f"d16-v3.{left}_vs_{right}.n{size}"
            for training_seed in formal.prep.TRAINING_SEEDS:
                for stratum in range(32):
                    for variant in (0, 1):
                        for member in (0, 1):
                            records.append(
                                {
                                    "inference_group_id": group_id,
                                    "training_seed": training_seed,
                                    "opening_stratum": f"n{size}_s{stratum:02d}",
                                    "opening_variant": variant,
                                    "pair_member": member,
                                    "black_slot": "A" if member == 0 else "B",
                                    "winner": "DRAW",
                                    "truncated": False,
                                }
                            )
    rows = formal._runner_comparison_rows(records, bootstrap_replicates=25)
    assert len(rows) == 9
    assert all(row["games_completed"] == 640 for row in rows)
    assert all(row["seed_by_opening_stratum_units"] == 160 for row in rows)
    assert all(row["paired_a_score_equal_weighted_over_seed_and_stratum"] == 0.5 for row in rows)
    assert all(row["primary_ci95"] == [0.5, 0.5] for row in rows)
    assert all(row["secondary_ci95"] == [0.5, 0.5] for row in rows)


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
