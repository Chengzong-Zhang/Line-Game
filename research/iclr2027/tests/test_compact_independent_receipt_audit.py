from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
from dataclasses import fields, replace
from pathlib import Path
from typing import Any, Callable

import pytest


ICLR_ROOT = Path(__file__).resolve().parents[1]
if str(ICLR_ROOT) not in sys.path:
    sys.path.insert(0, str(ICLR_ROOT))

from reviews import compact_independent_receipt_audit as verifier  # noqa: E402


def _copy_inputs(tmp_path: Path) -> verifier.AuditInputs:
    defaults = verifier.default_inputs()
    copied: dict[str, Path] = {}
    for field in fields(verifier.AuditInputs):
        source = getattr(defaults, field.name)
        destination = tmp_path / f"{field.name}{source.suffix}"
        shutil.copyfile(source, destination)
        copied[field.name] = destination
    return verifier.AuditInputs(**copied)


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
            for row in rows
        ),
        encoding="utf-8",
        newline="\n",
    )


def _mutate_first_receipt(
    inputs: verifier.AuditInputs,
    predicate: Callable[[dict[str, Any]], bool],
    mutation: Callable[[dict[str, Any]], None],
) -> None:
    rows = _load_jsonl(inputs.receipts)
    target = next(row for row in rows if predicate(row))
    mutation(target)
    _write_jsonl(inputs.receipts, rows)


def _audit_unpinned(inputs: verifier.AuditInputs) -> dict[str, Any]:
    return verifier._audit_inputs(inputs, enforce_frozen_identity=False)


def test_golden_tracked_inputs_pass_with_narrow_boundary() -> None:
    report = verifier.audit_inputs(verifier.default_inputs())
    assert report["ok"] is True
    assert report["verdict"] == "PASS_TRACKED_METADATA_CONSISTENCY_ONLY"
    assert report["skips"] == 0
    assert report["audit_contract"]["frozen_identity_enforced"] is True
    assert report["audit_contract"]["manifest_byte_pin_enforced"] is True
    assert report["audit_contract"]["distinct_input_files"] == 11
    assert report["tasks_and_receipts"]["receipt_rows"] == 330
    assert report["tasks_and_receipts"]["typed_hash_bindings"] == 4695
    assert report["training_accounting"]["self_play_games"] == 1500
    assert report["training_accounting"]["gradient_steps"] == 3000
    assert report["evaluation_accounting"]["evaluation_games"] == 30600
    assert report["aggregate_accounting"]["evaluation_aggregate_rows"] == 72
    assert report["compact_projection"] == {
        "rows": 330,
        "retained_hash_bindings": 4695,
        "sha256": verifier.EXPECTED_COMPACT_SHA256,
        "size_bytes": 910909,
        "matches_frozen_projection_identity": True,
    }
    limitations = report["limitations"]
    assert limitations["verified_external_artifact_bytes"] == 0
    assert limitations["receipt_declared_paths_opened"] == 0
    for field in (
        "raw_game_files_verified",
        "raw_game_hashes_recomputed",
        "checkpoint_files_verified",
        "checkpoint_hashes_recomputed",
        "training_logs_verified",
        "trajectory_records_opened",
        "trajectory_replay_performed",
        "models_retrained",
        "retraining_performed",
    ):
        assert limitations[field] is False
    assert limitations["resists_same_user_adversarial_filesystem_aba"] is False
    assert limitations["resists_same_user_concurrent_input_substitution"] is False
    assert '"formal_ready": true' not in json.dumps(report, sort_keys=True)


def test_cli_emits_one_strict_json_report() -> None:
    script = ICLR_ROOT / "reviews" / "compact_independent_receipt_audit.py"
    completed = subprocess.run(
        [sys.executable, "-B", str(script)],
        cwd=ICLR_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    report = json.loads(
        completed.stdout, parse_constant=lambda value: pytest.fail(value)
    )
    assert report["verdict"] == "PASS_TRACKED_METADATA_CONSISTENCY_ONLY"
    assert completed.stderr == ""


@pytest.mark.parametrize(
    "payload,match",
    [
        (b'{"x":1,"x":2}', "duplicate JSON object key"),
        (b'{"x":NaN}', "non-finite JSON number"),
        (b'{"x":1e999}', "non-finite JSON number"),
        (b"\xef\xbb\xbf{}", "BOM"),
    ],
)
def test_strict_json_rejects_ambiguous_encodings(payload: bytes, match: str) -> None:
    with pytest.raises(verifier.AuditError, match=match):
        verifier.strict_json_bytes(payload, "unit")


def test_strict_json_rejects_excessive_nesting_as_audit_error() -> None:
    payload = b"[" * 2_000 + b"0" + b"]" * 2_000

    with pytest.raises(verifier.AuditError, match="JSON nesting exceeds maximum depth"):
        verifier.strict_json_bytes(payload, "deep JSON")


def test_strict_json_has_an_explicit_interpreter_independent_depth_limit() -> None:
    at_limit = b"[" * verifier.MAX_JSON_DEPTH + b"0" + b"]" * verifier.MAX_JSON_DEPTH
    over_limit = (
        b"[" * (verifier.MAX_JSON_DEPTH + 1)
        + b"0"
        + b"]" * (verifier.MAX_JSON_DEPTH + 1)
    )

    assert isinstance(verifier.strict_json_bytes(at_limit, "at limit"), list)
    with pytest.raises(verifier.AuditError, match="JSON nesting exceeds maximum depth"):
        verifier.strict_json_bytes(over_limit, "over limit")
    with pytest.raises(verifier.AuditError, match="JSON nesting exceeds maximum depth"):
        verifier.strict_jsonl_bytes(over_limit + b"\n", "over-limit JSONL")


def test_cli_excessive_nesting_emits_one_failure_report(tmp_path: Path) -> None:
    script = ICLR_ROOT / "reviews" / "compact_independent_receipt_audit.py"
    deep_json = tmp_path / "deep.json"
    payload = b"[" * 2_000 + b"0" + b"]" * 2_000
    deep_json.write_bytes(payload)

    completed = subprocess.run(
        [
            sys.executable,
            "-B",
            str(script),
            "--prior-audit",
            str(deep_json),
        ],
        cwd=ICLR_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 1
    report = json.loads(
        completed.stdout, parse_constant=lambda value: pytest.fail(value)
    )
    assert report["ok"] is False
    assert report["verdict"] == "FAIL_TRACKED_METADATA_CONSISTENCY"
    assert len(report["errors"]) == 1
    assert "JSON nesting exceeds maximum depth" in report["errors"][0]
    assert completed.stderr == ""


@pytest.mark.parametrize(
    "payload,match",
    [
        (b'{"x":1}\n\n', "blank JSONL line"),
        (b'{"x":1}', "must end with a newline"),
        (b' {"x":1}\n', "surrounding whitespace"),
    ],
)
def test_strict_jsonl_rejects_blank_or_noncanonical_lines(
    payload: bytes, match: str
) -> None:
    with pytest.raises(verifier.AuditError, match=match):
        verifier.strict_jsonl_bytes(payload, "unit-jsonl")


def test_task_files_are_joined_by_task_id_not_line_position(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    lines = inputs.evaluation_tasks.read_bytes().splitlines()
    inputs.evaluation_tasks.write_bytes(b"\n".join(reversed(lines)) + b"\n")
    report = verifier.audit_inputs(inputs)
    assert report["ok"] is True


def test_receipts_are_joined_by_task_id_not_line_position(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    rows = _load_jsonl(inputs.receipts)
    _write_jsonl(inputs.receipts, list(reversed(rows)))
    report = _audit_unpinned(inputs)
    assert report["ok"] is True
    assert report["internal_consistency_checks_passed"] is True
    assert report["verdict"] == "PASS_UNFROZEN_TEST_MODE_ONLY"
    assert report["skips"] == 2
    assert report["audit_contract"]["frozen_identity_enforced"] is False
    assert report["audit_contract"]["manifest_byte_pin_enforced"] is True
    assert report["compact_projection"]["matches_frozen_projection_identity"] is False


def test_frozen_compact_identity_detects_receipt_reordering(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    rows = _load_jsonl(inputs.receipts)
    _write_jsonl(inputs.receipts, list(reversed(rows)))
    with pytest.raises(
        verifier.AuditError, match="compact projection byte SHA-256 drifted"
    ):
        verifier.audit_inputs(inputs)


@pytest.mark.parametrize("mode", ["missing", "extra", "duplicate"])
def test_receipt_task_set_fails_closed(tmp_path: Path, mode: str) -> None:
    inputs = _copy_inputs(tmp_path)
    rows = _load_jsonl(inputs.receipts)
    if mode == "missing":
        rows.pop()
    elif mode == "extra":
        extra = dict(rows[0])
        extra["task_id"] = "unexpected.extra.task"
        rows.append(extra)
    else:
        rows.append(dict(rows[0]))
    _write_jsonl(inputs.receipts, rows)
    with pytest.raises(verifier.AuditError, match="expected 330|duplicate task_id"):
        _audit_unpinned(inputs)


def test_manifest_snapshot_byte_drift_fails_closed(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    inputs.manifest_snapshot.write_bytes(inputs.manifest_snapshot.read_bytes() + b" ")
    with pytest.raises(verifier.AuditError, match="byte-for-byte copy"):
        _audit_unpinned(inputs)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (
            lambda row: row.__setitem__("self_play_games_completed", 99),
            "self_play_games_completed",
        ),
        (lambda row: row.__setitem__("seed", 1), "seed"),
        (lambda row: row.__setitem__("parameter_count", True), "JSON type mismatch"),
        (
            lambda row: row["checkpoint_artifacts"][0].__setitem__(
                "gradient_steps", 41
            ),
            "gradient_steps",
        ),
    ],
)
def test_training_budget_seed_parameter_and_checkpoint_drift_fail(
    tmp_path: Path,
    mutation: Callable[[dict[str, Any]], None],
    match: str,
) -> None:
    inputs = _copy_inputs(tmp_path)
    _mutate_first_receipt(
        inputs, lambda row: row["result_kind"] == "training", mutation
    )
    with pytest.raises(verifier.AuditError, match=match):
        _audit_unpinned(inputs)


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda row: row.__setitem__("truncated_games", 1), "truncated_games"),
        (
            lambda row: row.__setitem__(
                "color_pairs_verified", row["color_pairs_verified"] - 1
            ),
            "color_pairs_verified",
        ),
        (
            lambda row: row["agent_specs"]["A"]["search"].__setitem__(
                "simulations", 17
            ),
            "agent_specs",
        ),
        (
            lambda row: row["agent_bindings"]["A"].__setitem__(
                "checkpoint_sha256", "0" * 64
            ),
            "agent_bindings",
        ),
    ],
)
def test_evaluation_truncation_color_agent_and_crosslink_drift_fail(
    tmp_path: Path,
    mutation: Callable[[dict[str, Any]], None],
    match: str,
) -> None:
    inputs = _copy_inputs(tmp_path)
    _mutate_first_receipt(
        inputs, lambda row: row["result_kind"] == "evaluation", mutation
    )
    with pytest.raises(verifier.AuditError, match=match):
        _audit_unpinned(inputs)


def test_receipt_wdl_change_is_caught_by_recomputed_aggregate(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)

    def mutate(row: dict[str, Any]) -> None:
        row["a_wins"] += 1
        row["a_losses"] -= 1

    _mutate_first_receipt(
        inputs,
        lambda row: row["result_kind"] == "evaluation" and row["a_losses"] > 0,
        mutate,
    )
    with pytest.raises(verifier.AuditError, match="aggregate.json"):
        _audit_unpinned(inputs)


def test_aggregate_float_change_fails_above_tolerance(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    aggregate = json.loads(inputs.aggregate.read_text(encoding="utf-8"))
    aggregate["final_vs_search"][0]["a_score_rate"] += 1e-6
    inputs.aggregate.write_text(
        json.dumps(aggregate, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(verifier.AuditError, match="float mismatch"):
        _audit_unpinned(inputs)


def test_csv_nonfinite_float_fails_closed(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    with inputs.final_vs_search_csv.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.reader(stream))
    score_index = rows[0].index("a_score_rate")
    rows[1][score_index] = "NaN"
    with inputs.final_vs_search_csv.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows(rows)
    with pytest.raises(verifier.AuditError, match="non-finite float cell"):
        _audit_unpinned(inputs)


def test_receipt_field_closure_rejects_extra_field(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    _mutate_first_receipt(
        inputs,
        lambda row: row["result_kind"] == "training",
        lambda row: row.__setitem__("unexpected", 1),
    )
    with pytest.raises(verifier.AuditError, match="field closure mismatch"):
        _audit_unpinned(inputs)


def test_hash_binding_format_and_legacy_collision_fail_closed() -> None:
    with pytest.raises(verifier.AuditError, match="lowercase SHA-256"):
        verifier.flatten_hash_bindings({"artifact_sha256": "A" * 64})
    collision = {
        "nested": {"artifact_hash": "0" * 64},
        "nested.artifact_hash": "1" * 64,
    }
    with pytest.raises(verifier.AuditError, match="collision"):
        verifier.flatten_hash_bindings(collision)


def test_float_comparison_enforces_absolute_one_e_minus_twelve_boundary() -> None:
    verifier._compare_numeric(0.5, 0.5 + 5e-13, "within tolerance")
    with pytest.raises(verifier.AuditError, match="float mismatch"):
        verifier._compare_numeric(0.5, 0.5 + 2e-12, "above tolerance")


def test_wilson_helper_rejects_huge_counts_before_float_conversion() -> None:
    with pytest.raises(verifier.AuditError, match="Wilson draws.*integer is above"):
        verifier._score_ci95(0, 10**400, 10**400)


def test_huge_json_integer_becomes_audit_error_not_overflow() -> None:
    with pytest.raises(verifier.AuditError, match="finite JSON number"):
        verifier._require_number(10**400, "huge")


def test_huge_csv_integer_becomes_audit_error_not_value_error() -> None:
    with pytest.raises(verifier.AuditError, match="integer cell exceeds"):
        verifier._parse_csv_cell("9" * 5_000, "games_completed", "unit")


def test_huge_environment_steps_fail_before_float_aggregation(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)

    def mutate(row: dict[str, Any]) -> None:
        row["curve_snapshots"][0]["environment_steps"] = 10**400

    _mutate_first_receipt(inputs, lambda row: row["result_kind"] == "training", mutate)
    with pytest.raises(
        verifier.AuditError, match="environment_steps.*integer is above"
    ):
        _audit_unpinned(inputs)


def test_tracked_reader_rejects_oversize_file(tmp_path: Path) -> None:
    oversized = tmp_path / "oversized.json"
    with oversized.open("wb") as stream:
        stream.truncate(verifier.MAX_INPUT_BYTES + 1)
    with pytest.raises(verifier.AuditError, match="bounded canonical plain file"):
        verifier.TrackedReader().read("oversized", oversized)


def test_tracked_reader_rejects_symlink_or_reparse_input(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("{}\n", encoding="utf-8", newline="\n")
    link = tmp_path / "link.json"
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")
    with pytest.raises(verifier.AuditError, match="bounded canonical plain file"):
        verifier.TrackedReader().read("linked", link)


def test_input_roles_cannot_alias_one_plain_file() -> None:
    defaults = verifier.default_inputs()
    aliased = replace(defaults, manifest_snapshot=defaults.manifest)

    with pytest.raises(verifier.AuditError, match="distinct plain-file identities"):
        verifier.audit_inputs(aliased)


def test_frozen_manifest_hash_is_checked_before_task_expansion(tmp_path: Path) -> None:
    inputs = _copy_inputs(tmp_path)
    manifest = json.loads(inputs.manifest.read_text(encoding="utf-8"))
    manifest["training_budget"]["iterations"] = 10**400
    payload = (
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    inputs.manifest.write_bytes(payload)
    inputs.manifest_snapshot.write_bytes(payload)

    with pytest.raises(verifier.AuditError, match="frozen manifest byte SHA-256"):
        verifier.audit_inputs(inputs)


def test_nonexistent_receipt_paths_remain_opaque_and_are_not_opened(
    tmp_path: Path,
) -> None:
    inputs = _copy_inputs(tmp_path)
    rows = _load_jsonl(inputs.receipts)

    def replace_paths(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in list(value.items()):
                if (
                    key == "path"
                    or key.endswith("_path")
                    or key == "checkpoint_directory"
                ):
                    value[key] = r"Z:\definitely-does-not-exist\opaque-artifact"
                else:
                    replace_paths(child)
        elif isinstance(value, list):
            for child in value:
                replace_paths(child)

    for row in rows:
        replace_paths(row)
    _write_jsonl(inputs.receipts, rows)
    report = _audit_unpinned(inputs)
    assert report["ok"] is True
    assert report["internal_consistency_checks_passed"] is True
    assert report["verdict"] == "PASS_UNFROZEN_TEST_MODE_ONLY"
    assert report["skips"] == 2
    assert report["audit_contract"]["frozen_identity_enforced"] is False
    assert report["audit_contract"]["manifest_byte_pin_enforced"] is True
    assert report["limitations"]["receipt_declared_paths_opened"] == 0
    assert report["limitations"]["verified_external_artifact_bytes"] == 0


def test_prior_full_audit_is_contrast_only_not_current_verification() -> None:
    report = verifier.audit_inputs(verifier.default_inputs())
    prior = report["prior_full_audit_contrast"]
    assert prior["self_reported_replay_sample_games"] == 630
    assert prior["used_as_current_accounting_source"] is False
    assert prior["used_as_current_artifact_verification"] is False
    assert report["limitations"]["trajectory_replay_performed"] is False


def test_prior_self_reported_ok_and_errors_are_non_authoritative(
    tmp_path: Path,
) -> None:
    inputs = _copy_inputs(tmp_path)
    prior = json.loads(inputs.prior_audit.read_text(encoding="utf-8"))
    prior["ok"] = False
    prior["errors"] = ["deliberate prior self-report mutation"]
    inputs.prior_audit.write_text(
        json.dumps(prior, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(
        verifier.AuditError,
        match="prior full audit reference byte SHA-256 drifted",
    ):
        verifier.audit_inputs(inputs)

    report = _audit_unpinned(inputs)
    assert report["ok"] is True
    assert report["verdict"] == "PASS_UNFROZEN_TEST_MODE_ONLY"
    assert report["skips"] == 2
    assert report["audit_contract"]["frozen_identity_enforced"] is False
    assert report["prior_full_audit_contrast"]["self_reported_ok"] is False
    assert report["prior_full_audit_contrast"]["self_reported_errors_count"] == 1
    assert (
        report["prior_full_audit_contrast"]["used_as_current_accounting_source"]
        is False
    )


def test_public_audit_api_does_not_expose_identity_pin_bypass() -> None:
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        verifier.audit_inputs(  # type: ignore[call-arg]
            verifier.default_inputs(),
            expected_prior_sha256=None,
        )
