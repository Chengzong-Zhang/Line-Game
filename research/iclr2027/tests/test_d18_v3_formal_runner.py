"""Pure structural tests for the D18-v3 formal execution layer.

These tests never call readiness, GPU smoke, formal run, model construction,
or an arena game.  They exercise joins, hashes, fail-closed gates, and command
surface invariants with synthetic dictionaries only.
"""

from __future__ import annotations

import copy
import inspect
import json
import sys
from pathlib import Path

import pytest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_formal_runner as formal  # noqa: E402
import d18_v3_verify_evidence as independent  # noqa: E402


def _minimal_export_tree(root: Path) -> None:
    for name in (
        "canonical_numeric.json",
        "execution_metadata.json",
        "execution_summary.json",
        "result_receipts.jsonl",
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
    source = inspect.getsource(formal.gpu_smoke)
    for forbidden in (".backward(", "Adam", "autocast(", "GradScaler", "_repeat_tensor_batch", "batch_candidates"):
        assert forbidden not in source
    for required in (
        "torch.inference_mode()",
        "select_action",
        '"optimizer_steps": 0',
        '"backward_calls": 0',
        '"amp_enabled": False',
        '"batch_calibration_performed": False',
        '"formal_numeric_path_match": True',
    ):
        assert required in source


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
    run_args = parser.parse_args(
        ["run", "--bundle-dir", "bundle", "--run-root", "run"]
    )
    assert run_args.device == "cuda"
    assert run_args.confirm_formal is False
    with pytest.raises(formal.FormalExecutionError, match="--confirm-formal"):
        formal.run_bundle(
            Path("missing-manifest"),
            Path("missing-bundle"),
            Path("missing-run"),
            device="cuda",
            continue_on_error=False,
            export_directory=None,
            confirm_formal=False,
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


def test_readiness_uses_only_the_frozen_stage_copy(tmp_path: Path) -> None:
    stage = (tmp_path / "immutable-stage").resolve()
    bundle = (
        formal.RESEARCH_ROOT
        / "results"
        / "formal"
        / "d18_v3"
        / "synthetic"
        / "task_bundle"
    )
    command = formal._build_staged_readiness_command(
        local_python=Path(sys.executable),
        stage_directory=stage,
        manifest_path=formal.DEFAULT_MANIFEST,
        bundle_directory=bundle,
        stage_manifest_sha256="a" * 64,
    )
    expected_runner = stage / Path(formal._repo_relative(formal.SCRIPT_PATH))
    expected_manifest = stage / Path(
        formal._repo_relative(formal.DEFAULT_MANIFEST)
    )
    expected_bundle = stage / Path(formal._repo_relative(bundle))
    for expected in (expected_runner, expected_manifest, expected_bundle):
        assert f'"{expected}"' in command
    assert f'"{formal.SCRIPT_PATH}" readiness' not in command
    assert f'--manifest "{formal.DEFAULT_MANIFEST}"' not in command
    assert f'--bundle-dir "{bundle}"' not in command


def test_dependency_lock_is_hash_bound_and_staged() -> None:
    assert formal.DEPENDENCY_LOCK_PATH.relative_to(formal.REPO_ROOT).as_posix() == (
        "research/iclr2027/autodl/d18_v3_runtime_requirements.lock.txt"
    )
    assert formal.DEPENDENCY_LOCK_PATH.read_bytes() == b"--no-index\ntorch==2.8.0\n"
    assert formal.sha256_file(formal.DEPENDENCY_LOCK_PATH) == (
        "2df94edd048e9aa9990bce302672f6c71f0845e70fd0be43fbbdd719d869473a"
    )
    source_hashes = inspect.getsource(formal._execution_source_hashes)
    stage_source = inspect.getsource(formal.prepare_autodl_stage)
    job_source = inspect.getsource(formal.generate_job)
    readiness_source = inspect.getsource(formal._build_staged_readiness_command)
    assert "DEPENDENCY_LOCK_PATH" in source_hashes
    assert "DEPENDENCY_LOCK_PATH" in stage_source
    assert "dependency_lock_relative" in job_source
    assert "staged dependency lock is missing or differs" in job_source
    assert 'setup_revision = f"d18-v3-stage-{stage_manifest_sha256}"' in job_source
    assert "validate-autodl-stage" in job_source
    assert "expected-stage-manifest-sha256" in readiness_source


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
    assert manifest["total_bytes"] == 8 * len(b"{}\n")
    assert manifest["max_export_bytes"] == 16_384
    assert manifest["projected_upper_bound_bytes"] <= 16_384
    assert (export_root / "canonical_numeric.json").read_bytes() == b"{}\n"
    assert len([path for path in export_root.rglob("*") if path.is_file()]) == 9


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
