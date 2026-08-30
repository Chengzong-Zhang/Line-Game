"""Discovery tests for the D18-v3 zero-execution preparation contract."""

from __future__ import annotations

import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_generate_openings as openings  # noqa: E402
import d18_v3_runner as runner  # noqa: E402


def test_d18_v3_openings_are_exact_and_disjoint() -> None:
    manifest = openings.load_json(openings.DEFAULT_OUTPUT)
    report = openings.validate_manifest(
        manifest,
        generator_path=openings.SCRIPT_PATH,
        v1_path=openings.DEFAULT_V1_OPENINGS,
    )
    assert report["opening_count"] == 192
    assert report["formal_games_executed"] == 0
    assert manifest["audit"]["prefix_hashes_disjoint_from_v1"] is True
    assert manifest["audit"]["state_hashes_disjoint_from_v1"] is True


def test_d18_v3_runtime_dependencies_are_hash_bound() -> None:
    from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

    sources = set(
        runner._source_paths(
            protocol_path=runner.DEFAULT_PROTOCOL,
            opening_path=runner.DEFAULT_OPENINGS,
            v1_formal_path=runner.DEFAULT_V1_FORMAL,
        )
    )
    assert openings.DEFAULT_V1_OPENINGS in sources
    assert set(AlphaZeroTrainer.source_files()) <= sources

    manifest = runner.load_json(runner.DEFAULT_MANIFEST)
    relative = runner.repo_relative(openings.DEFAULT_V1_OPENINGS)
    assert manifest["source_hashes"][relative] == runner.sha256_file(
        openings.DEFAULT_V1_OPENINGS
    )
    latest_paths = {
        runner.resolve_repo_path(row["latest_manifest_path"])
        for row in manifest["checkpoints"]
    }
    assert len(latest_paths) == 15
    for row in manifest["checkpoints"]:
        latest_path = runner.resolve_repo_path(row["latest_manifest_path"])
        assert latest_path == runner.resolve_repo_path(row["path"]).with_name(
            "latest.json"
        )
        assert row["latest_manifest_sha256"] == runner.sha256_file(latest_path)
        relative = runner.repo_relative(latest_path)
        assert manifest["source_hashes"][relative] == row["latest_manifest_sha256"]


def test_d18_v3_manifest_and_bundle_contract() -> None:
    manifest = runner.load_json(runner.DEFAULT_MANIFEST)
    runner.validate_formal_manifest(manifest, manifest_path=runner.DEFAULT_MANIFEST)
    bundle = runner.materialize_bundle(
        manifest=manifest, manifest_path=runner.DEFAULT_MANIFEST
    )
    report = runner.validate_materialized_bundle(bundle)
    assert report == {
        "color_pairs_per_task": 64,
        "formal_games_executed": 0,
        "game_count": 5760,
        "status": "passed",
        "task_count": 45,
    }


def test_d18_v3_dry_run_executes_zero_games() -> None:
    report = runner.dry_run_report(manifest_path=runner.DEFAULT_MANIFEST)
    assert report["status"] == "passed_zero_execution"
    assert report["formal_games_executed"] == 0
    assert report["model_forward_calls"] == 0
    assert report["gpu_actions"] == 0
    assert report["external_actions"] == 0
    assert report["paid_actions"] == 0


def test_d18_v3_cli_exposes_no_formal_runner() -> None:
    parser = runner.build_parser()
    subparsers = [
        action
        for action in parser._actions
        if action.__class__.__name__ == "_SubParsersAction"
    ][0]
    assert set(subparsers.choices) == {
        "freeze-manifest",
        "prepare-bundle",
        "readiness",
        "dry-run",
        "show-contract",
    }
    assert "run" not in subparsers.choices
    assert "run-formal" not in subparsers.choices
