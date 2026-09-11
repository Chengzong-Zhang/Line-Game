from __future__ import annotations

import json
import shutil
import subprocess
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

import pytest

from scripts import verify_d14_d16_fresh_install_profile as verifier


@dataclass(frozen=True)
class _SyntheticSubject:
    git_executable: Path = Path(sys.executable)
    git_executable_sha256: str = "c" * 64
    git_executable_size_bytes: int = 123

    def public_fields(self):
        return {
            "subject_binding_verified": True,
            "subject_commit": "a" * 40,
            "subject_fixed_input_count": 64,
            "subject_tool_source_count": 2,
            "subject_tree": "b" * 40,
        }


def _reference_source_paths():
    allowlist = json.loads(
        (
            verifier.RESEARCH_ROOT
            / "supplement_tools"
            / "supplement_claim_complete_allowlist.json"
        ).read_text(encoding="utf-8")
    )
    return tuple(
        sorted(
            row["source"]
            for row in allowlist["files"]
            if row["category"] == "reference_implementation"
        )
    )


def _patch_subject_success(monkeypatch, captured=None, package_paths=None):
    subject = _SyntheticSubject()

    def bind(*args, **kwargs):
        if captured is not None:
            captured["args"] = args
            captured["kwargs"] = kwargs
        return subject

    monkeypatch.setattr(verifier, "verify_subject_repository", bind)
    monkeypatch.setattr(
        verifier, "assert_subject_snapshot_unchanged", lambda value: None
    )
    monkeypatch.setattr(
        verifier,
        "_subject_package_paths",
        lambda *args, **kwargs: (
            _reference_source_paths() if package_paths is None else package_paths
        ),
    )
    monkeypatch.setattr(verifier, "_assert_subject_paths_absent", lambda *args: None)
    return subject


def _patch_decoded_payload(monkeypatch, target_label, mutate):
    original = verifier._strict_json_object

    def tamper(data, *, canonical, label: str):
        payload = original(data, canonical=canonical, label=label)
        if label == target_label:
            payload = deepcopy(payload)
            mutate(payload)
        return payload

    monkeypatch.setattr(verifier, "_strict_json_object", tamper)


def test_checked_in_profile_is_canonical_and_resolves_every_allowlisted_byte():
    profile_bytes = verifier.DEFAULT_PROFILE.read_bytes()
    assert profile_bytes == verifier.canonical_json_bytes(json.loads(profile_bytes))
    validation = verifier.validate_contract(verifier.DEFAULT_PROFILE)

    assert validation.public["contract"]["status"] == "contract_only_not_executed"
    assert validation.public["dependency_lock"]["package_count"] == 20
    assert validation.public["packaging"]["wheel_source_count"] == 25
    assert validation.package_source_paths == _reference_source_paths()
    assert (
        validation.public["packaging"]["subject_package_source_closure_verified"]
        is False
    )
    assert validation.public["packaging"]["installed_distribution_policy"] == {
        "expected_distribution_count": 22,
        "lock_pins_source": "dependency_lock.pins",
        "pip": {
            "pre_pinned": False,
            "receipt_binding_required": True,
            "version_policy": "record_exact_at_execution",
        },
        "project": {"name": "lifeline-rl", "version": "0.1.0"},
        "unexpected_distribution_policy": "BLOCKED",
    }
    expected_packaging_semantics = {
        "build_backend": verifier.EXPECTED_BUILD_BACKEND,
        "declared_build_requires": verifier.EXPECTED_DECLARED_BUILD_REQUIRES,
        "declared_optional_dependencies": (
            verifier.EXPECTED_DECLARED_OPTIONAL_DEPENDENCIES
        ),
        "declared_runtime_dependencies": (
            verifier.EXPECTED_DECLARED_RUNTIME_DEPENDENCIES
        ),
        "excluded_top_level_packages": verifier.EXPECTED_EXCLUDED_TOP_LEVEL_PACKAGES,
        "package_discovery": verifier.EXPECTED_PACKAGE_DISCOVERY,
        "package_discovery_root": verifier.EXPECTED_PACKAGE_DISCOVERY_ROOT,
        "project_name": verifier.EXPECTED_PROJECT_NAME,
        "project_version": verifier.EXPECTED_PROJECT_VERSION,
        "requires_python": verifier.EXPECTED_REQUIRES_PYTHON,
    }
    assert {
        key: validation.public["packaging"][key] for key in expected_packaging_semantics
    } == expected_packaging_semantics
    assert validation.public["packaging"]["pyproject"]["path"] == (
        verifier.EXPECTED_PYPROJECT_PATH
    )
    assert validation.public["independent_receipt_audit"]["execution_ready"] is True
    assert (
        validation.public["independent_receipt_audit"][
            "compact_independent_verifier_status"
        ]
        == "implemented"
    )
    transport = validation.public["line_ending_transport_policy"]
    assert transport["path"] == verifier.EXPECTED_GITATTRIBUTES_PATH
    assert transport["sha256"] == verifier.EXPECTED_GITATTRIBUTES_SHA256
    assert transport["required_attribute"] == "-text"
    assert transport["rules_verified"] is True
    assert transport["frozen_evidence_path_count"] == 10
    assert transport["frozen_evidence_paths"] == list(
        verifier.EXPECTED_FROZEN_TRANSPORT_PATHS
    )
    compact_contract = validation.public["independent_receipt_audit"][
        "compact_verifier_contract"
    ]
    assert compact_contract["sha256"] == verifier.EXPECTED_COMPACT_VERIFIER_SHA256
    assert compact_contract["expected_public_verdict"] == (
        "PASS_TRACKED_METADATA_CONSISTENCY_ONLY"
    )
    assert compact_contract["expected_exit_code"] == 0
    assert compact_contract["expected_skips"] == 0
    assert compact_contract["expected_distinct_tracked_inputs"] == 11
    assert compact_contract["expected_manifest_byte_pin_enforced"] is True
    assert compact_contract["distinct_tracked_inputs"] == 11
    assert compact_contract["manifest_byte_pin_enforced"] is True
    assert compact_contract["executed_by_contract_verifier"] is False
    assert compact_contract["limitations"] == verifier.EXPECTED_COMPACT_LIMITATIONS
    compact_bindings = {
        row["path"]: row["sha256"] for row in compact_contract["tracked_input_bindings"]
    }
    assert set(compact_bindings) == verifier.EXPECTED_COMPACT_BINDING_PATHS
    assert len(compact_bindings) == 11
    assert {
        path: compact_bindings[path]
        for path in (
            "research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv",
            "research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv",
            "research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv",
            "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv",
        )
    } == {
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv": "40f531f0f974f75cf8921499d209eb529bc2f99308390f8ce753f63047f5b616",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv": "8fdcba541d8c62b9697be5bd17f512c76976e0acb4d1a6a3f8c785d3959b0fa8",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv": "b06659670c5bd199fcbefaa808398859ff220a4ce60cae9ddd47d04fa4f25fff",
        "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv": "af96f5a9cfb5fc1f343953d1ad2b1bbabff96f078f002e4ee2e57dc048b4fae0",
    }
    assert validation.public["tests"]["targeted_test_count"] == 29
    assert {
        row["path"] for row in validation.public["tests"]["targeted_tests"]
    } == verifier.EXPECTED_TARGETED_TEST_PATHS
    assert validation.public["tests"]["group_counts"] == {
        "d14_d16_protocol_receipt": 2,
        "dependency_free_core_search_serialization": 13,
        "pytorch_network_trainer": 11,
        "retained_reproducibility": 2,
    }
    closure = validation.public["claim_allowlist_closure"]
    assert closure["row_count"] == 120
    assert closure["category_count"] == 28
    assert closure["canonical_triple_sha256"] == verifier.EXPECTED_CLAIM_TRIPLE_SHA256
    assert closure["full_two_way_identity_equal"] is True
    assert closure["copy_rows_with_verified_source_bytes"] == 109
    assert closure["derivative_rows_with_verified_input_bytes"] == 10
    assert len(closure["future_derived_outputs"]) == 11
    assert closure["future_derived_outputs_generated"] is False
    assert closure["verified_derived_output_bytes"] == 0
    assert len(validation.frozen_paths) == len(set(validation.frozen_paths))


def test_targeted_test_paths_and_hashes_equal_resolved_allowlist_exactly():
    validation = verifier.validate_contract(verifier.DEFAULT_PROFILE)
    observed = {
        row["path"]: row["sha256"]
        for row in validation.public["tests"]["targeted_tests"]
    }
    allowlist = json.loads(
        (
            verifier.RESEARCH_ROOT
            / "supplement_tools"
            / "supplement_claim_complete_allowlist.json"
        ).read_text(encoding="utf-8")
    )
    expected = {
        row["source"]: row["expected_sha256"]
        for row in allowlist["files"]
        if row["category"] == "targeted_test"
    }

    assert len(observed) == len(expected) == 29
    assert observed == expected


def test_full_claim_allowlist_identity_digest_and_byte_binding_counts_are_frozen():
    validation = verifier.validate_contract(verifier.DEFAULT_PROFILE)
    closure = validation.public["claim_allowlist_closure"]

    assert closure["canonical_triple_sha256"] == (
        "95933b2b39d57495c9e945b95c6dd2f024270f1784d6221163540ec552a707f8"
    )
    assert closure["row_count"] == 120
    assert closure["category_count"] == 28
    assert len(closure["copy_source_bindings"]) == 109
    assert len(closure["derivative_input_bindings"]) == 10
    assert len(closure["future_derived_outputs"]) == 11
    assert set(validation.future_derived_output_paths) == {
        row["path"] for row in closure["future_derived_outputs"]
    }
    assert all(
        not (verifier.REPOSITORY_ROOT / path).exists()
        for path in validation.future_derived_output_paths
    )


def test_pyproject_copy_hash_is_current_in_both_claim_contracts():
    claim = json.loads(
        (
            verifier.RESEARCH_ROOT / "supplement_tools" / "claim_complete_profile.json"
        ).read_text(encoding="utf-8")
    )
    allowlist = json.loads(
        (
            verifier.RESEARCH_ROOT
            / "supplement_tools"
            / "supplement_claim_complete_allowlist.json"
        ).read_text(encoding="utf-8")
    )
    expected = verifier.sha256_file(verifier.RESEARCH_ROOT / "pyproject.toml")
    claim_row = next(
        row
        for row in claim["files"]
        if row["source"] == verifier.EXPECTED_PYPROJECT_PATH
    )
    allowlist_row = next(
        row
        for row in allowlist["files"]
        if row["source"] == verifier.EXPECTED_PYPROJECT_PATH
    )

    assert (
        expected == "03b9e027be0bc9c6618175d5a1f36d074fa250f4747cc0d51bdeda9f126d8839"
    )
    assert claim_row["inputs"] == [
        {"expected_sha256": "0" * 64, "path": verifier.EXPECTED_PYPROJECT_PATH}
    ]
    assert allowlist_row["expected_sha256"] == expected


def test_self_consistent_full_identity_drift_is_stopped_by_canonical_digest(
    monkeypatch,
):
    original = verifier._strict_json_object

    def tamper(data, *, canonical, label: str):
        payload = original(data, canonical=canonical, label=label)
        if label in {"resolved claim allowlist", "claim-complete profile"}:
            payload = deepcopy(payload)
            row = next(
                row for row in payload["files"] if row["category"] == "formal_aggregate"
            )
            row["category"] = "synthetic_new_category"
        return payload

    monkeypatch.setattr(verifier, "_strict_json_object", tamper)

    with pytest.raises(verifier.ContractError, match="canonical identity digest"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_copy_source_bytes_are_bound_to_allowlist_hash(monkeypatch):
    original = verifier._strict_json_object

    def tamper(data, *, canonical, label: str):
        payload = original(data, canonical=canonical, label=label)
        if label == "resolved claim allowlist":
            payload = deepcopy(payload)
            row = next(
                row for row in payload["files"] if row["category"] == "package_config"
            )
            row["expected_sha256"] = "1" * 64
        return payload

    monkeypatch.setattr(verifier, "_strict_json_object", tamper)

    with pytest.raises(verifier.ContractError, match="copy source.*SHA-256 differs"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize("mutation", ["missing", "extra", "replaced"])
def test_compact_binding_path_set_is_exact_and_fail_closed(monkeypatch, mutation):
    replacement_path = (
        "research/iclr2027/results/formal/d14_d16/task_bundle_v1/bundle_summary.json"
    )
    replacement_sha256 = verifier.sha256_file(
        verifier.REPOSITORY_ROOT / replacement_path
    )

    def mutate(profile):
        bindings = profile["independent_receipt_audit"]["compact_verifier_contract"][
            "tracked_input_bindings"
        ]
        training_path = (
            "research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv"
        )
        if mutation == "missing":
            bindings[:] = [row for row in bindings if row["path"] != training_path]
        elif mutation == "extra":
            bindings.append({"path": replacement_path, "sha256": replacement_sha256})
        else:
            row = next(row for row in bindings if row["path"] == training_path)
            row.update(path=replacement_path, sha256=replacement_sha256)

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(
        verifier.ContractError,
        match="exact schema v1 path set|exactly 11 distinct inputs",
    ):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    "constant", ["NaN", "Infinity", "-Infinity", "1e400", "-1e400"]
)
def test_strict_json_rejects_non_finite_constants(constant):
    with pytest.raises(verifier.ContractError, match="non-finite"):
        verifier._strict_json_object(
            f'{{"value": {constant}}}'.encode(),
            canonical=False,
            label="synthetic JSON",
        )


def test_strict_json_rejects_duplicate_keys_recursively():
    with pytest.raises(verifier.ContractError, match="duplicate key"):
        verifier._strict_json_object(
            b'{"outer": {"same": 1, "same": 2}}',
            canonical=False,
            label="synthetic JSON",
        )


def test_targeted_allowlist_closure_cannot_shrink_with_profile(monkeypatch):
    def mutate(allowlist):
        files = allowlist["files"]
        victim = next(row for row in files if row["category"] == "targeted_test")
        files.remove(victim)

    _patch_decoded_payload(monkeypatch, "resolved claim allowlist", mutate)

    with pytest.raises(verifier.ContractError, match="targeted test closure"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    "mutation",
    [
        "extra_key",
        "invalid_category",
        "invalid_hash",
        "duplicate_source",
        "casefold_duplicate_source",
        "casefold_duplicate_destination",
        "selected_nonidentity",
    ],
)
def test_every_allowlist_row_and_selected_identity_are_validated(monkeypatch, mutation):
    def mutate(allowlist):
        files = allowlist["files"]
        nonselected = next(
            row for row in files if row["category"] == "formal_aggregate"
        )
        if mutation == "extra_key":
            nonselected["unexpected"] = True
        elif mutation == "invalid_category":
            nonselected["category"] = 42
        elif mutation == "invalid_hash":
            nonselected["expected_sha256"] = "not-a-hash"
        elif mutation == "duplicate_source":
            nonselected["source"] = files[0]["source"]
        elif mutation == "casefold_duplicate_source":
            nonselected["source"] = files[0]["source"].upper()
        elif mutation == "casefold_duplicate_destination":
            nonselected["destination"] = files[0]["destination"].upper()
        else:
            selected = next(row for row in files if row["category"] == "targeted_test")
            selected["destination"] = "research/iclr2027/tests/renamed_target.py"

    _patch_decoded_payload(monkeypatch, "resolved claim allowlist", mutate)

    with pytest.raises(verifier.ContractError):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize("mutation", ["second_null", "special_identity_drift"])
def test_allowlist_null_hash_exception_is_unique_and_identity_bound(
    monkeypatch, mutation
):
    def mutate(allowlist):
        files = allowlist["files"]
        if mutation == "second_null":
            files[0]["expected_sha256"] = None
        else:
            special = next(
                row for row in files if row["category"] == "transformation_receipt"
            )
            special["source"] = (
                "research/iclr2027/supplement_tools/derived_claim_complete/"
                "ANONYMIZATION_DERIVATION_COPY.json"
            )

    _patch_decoded_payload(monkeypatch, "resolved claim allowlist", mutate)

    with pytest.raises(verifier.ContractError, match="null SHA-256"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    "mutation", ["mode", "inputs", "input_hash", "descriptive_destinations"]
)
def test_claim_profile_selected_rows_and_descriptive_destinations_are_frozen(
    monkeypatch, mutation
):
    def mutate(profile):
        selected = next(
            row for row in profile["files"] if row["category"] == "targeted_test"
        )
        if mutation == "mode":
            selected["mode"] = "render"
        elif mutation == "inputs":
            selected["inputs"].append(deepcopy(selected["inputs"][0]))
        elif mutation == "input_hash":
            selected["inputs"][0]["expected_sha256"] = "1" * 64
        else:
            profile["descriptive_only_destinations"].pop()

    _patch_decoded_payload(monkeypatch, "claim-complete profile", mutate)

    with pytest.raises(verifier.ContractError):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    "mutation",
    [
        "invalid_category",
        "invalid_mode",
        "copy_input_path",
        "copy_input_hash",
        "derivative_input_path",
        "derivative_input_hash",
        "derivation_receipt_input",
    ],
)
def test_every_claim_profile_row_shape_is_validated(monkeypatch, mutation):
    def mutate(profile):
        copy_row = next(
            row
            for row in profile["files"]
            if row["mode"] == "copy" and row["category"] != "targeted_test"
        )
        derivative_row = next(
            row
            for row in profile["files"]
            if row["mode"] not in {"copy", "derivation_receipt"}
        )
        derivation_receipt = next(
            row for row in profile["files"] if row["mode"] == "derivation_receipt"
        )
        if mutation == "invalid_category":
            copy_row["category"] = 42
        elif mutation == "invalid_mode":
            copy_row["mode"] = "unsupported"
        elif mutation == "copy_input_path":
            copy_row["inputs"][0]["path"] = "research/iclr2027/other.py"
        elif mutation == "copy_input_hash":
            copy_row["inputs"][0]["expected_sha256"] = "1" * 64
        elif mutation == "derivative_input_path":
            derivative_row["inputs"][0]["path"] = "../unsafe"
        elif mutation == "derivative_input_hash":
            derivative_row["inputs"][0]["expected_sha256"] = "not-a-hash"
        else:
            derivation_receipt["inputs"].append(
                {
                    "expected_sha256": "0" * 64,
                    "path": derivation_receipt["source"],
                }
            )

    _patch_decoded_payload(monkeypatch, "claim-complete profile", mutate)

    with pytest.raises(verifier.ContractError):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize("field", ["source", "destination"])
def test_claim_profile_paths_are_globally_casefold_unique(monkeypatch, field):
    def mutate(profile):
        derivative_rows = [
            row
            for row in profile["files"]
            if row["mode"] not in {"copy", "derivation_receipt"}
        ]
        derivative_rows[1][field] = derivative_rows[0][field].upper()

    _patch_decoded_payload(monkeypatch, "claim-complete profile", mutate)

    with pytest.raises(verifier.ContractError, match=f"{field} paths.*duplicated"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    ("label", "path", "replacement"),
    [
        ("fresh-install profile", ("schema_version",), True),
        (
            "fresh-install profile",
            ("dependency_lock", "expected_package_count"),
            20.0,
        ),
        (
            "fresh-install profile",
            (
                "independent_receipt_audit",
                "compact_verifier_contract",
                "expected_exit_code",
            ),
            False,
        ),
        (
            "fresh-install profile",
            (
                "independent_receipt_audit",
                "compact_verifier_contract",
                "expected_skips",
            ),
            False,
        ),
        (
            "fresh-install profile",
            ("scope_boundary", "clean_install_executed"),
            0,
        ),
        (
            "fresh-install profile",
            (
                "packaging",
                "installed_distribution_policy",
                "expected_distribution_count",
            ),
            22.0,
        ),
        (
            "fresh-install profile",
            ("packaging", "installed_distribution_policy", "pip", "pre_pinned"),
            0,
        ),
        (
            "fresh-install profile",
            ("tests", "expected_allowlist_count"),
            29.0,
        ),
        ("resolved claim allowlist", ("schema_version",), True),
        (
            "resolved claim allowlist",
            ("limits", "max_file_bytes"),
            True,
        ),
        ("claim-complete profile", ("schema_version",), True),
    ],
)
def test_json_type_confusions_are_fail_closed(monkeypatch, label, path, replacement):
    original = verifier._strict_json_object

    def tamper(data, *, canonical, label: str):
        payload = original(data, canonical=canonical, label=label)
        if label == target_label:
            payload = deepcopy(payload)
            cursor = payload
            for key in target_path[:-1]:
                cursor = cursor[key]
            cursor[target_path[-1]] = replacement
        return payload

    target_label = label
    target_path = path
    monkeypatch.setattr(verifier, "_strict_json_object", tamper)

    with pytest.raises(verifier.ContractError, match="value/type"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    ("label", "path", "replacement"),
    [
        ("resolved claim allowlist", ("status",), "approved"),
        ("claim-complete profile", ("status",), "approved"),
        ("claim-complete profile", ("approval",), "not_required"),
    ],
)
def test_allowlist_and_claim_profile_authority_drift_blocks(
    monkeypatch, label, path, replacement
):
    original = verifier._strict_json_object

    def tamper(data, *, canonical, label: str):
        payload = original(data, canonical=canonical, label=label)
        if label == target_label:
            payload = deepcopy(payload)
            payload[target_path[0]] = replacement
        return payload

    target_label = label
    target_path = path
    monkeypatch.setattr(verifier, "_strict_json_object", tamper)

    with pytest.raises(verifier.ContractError, match="value/type"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_hash_drift_is_fail_closed(tmp_path):
    artifact = tmp_path / "tracked.py"
    artifact.write_bytes(b"one\n")
    reader = verifier.SnapshotReader(tmp_path)

    with pytest.raises(verifier.ContractError, match="SHA-256 differs"):
        verifier._hash_bound_file(
            reader,
            "tracked.py",
            verifier.hashlib.sha256(b"two\n").hexdigest(),
            "synthetic tracked input",
        )


def test_contract_validation_reads_each_bound_path_once(monkeypatch):
    observed = {}
    original = verifier._read_relative

    def count(repo_root, relative, label):
        observed[relative] = observed.get(relative, 0) + 1
        return original(repo_root, relative, label)

    monkeypatch.setattr(verifier, "_read_relative", count)
    validation = verifier.validate_contract(verifier.DEFAULT_PROFILE)

    assert set(observed) == set(validation.frozen_paths)
    assert set(observed.values()) == {1}


def test_snapshot_recheck_detects_post_validation_mutation(tmp_path):
    artifact = tmp_path / "tracked.py"
    artifact.write_bytes(b"before\n")
    reader = verifier.SnapshotReader(tmp_path)
    snapshot = reader.read("tracked.py", "synthetic input")
    validation = verifier.ContractValidation(
        public={},
        frozen_paths=("tracked.py",),
        future_derived_output_paths=(),
        package_source_paths=(),
        snapshots=(snapshot,),
    )
    artifact.write_bytes(b"after\n")

    with pytest.raises(verifier.ContractError, match="changed after subject"):
        validation.assert_local_bytes_unchanged(tmp_path)


def test_exact_lock_parser_accepts_only_the_frozen_directive_and_pins():
    data = (
        verifier.RESEARCH_ROOT / "requirements-d14-d16-win-cu118.lock.txt"
    ).read_bytes()

    pins, directives = verifier.parse_execution_lock(data)

    assert directives == verifier.EXPECTED_DIRECTIVES
    assert len(pins) == 20
    assert pins["torch"] == "2.7.1+cu118"


@pytest.mark.parametrize(
    "bad_line",
    [
        "--find-links C:/private/wheels",
        "--trusted-host download.pytorch.org",
        "torch==2.7.1+cu118; python_version == '3.10'",
        "torch==2.7.1+cu118 # inline comment",
        "torch==2.7.1+cu118 --hash=sha256:" + "0" * 64,
        "torch>=2.7",
        "foo-==1.0",
        "foo==1..0",
        "foo==.1",
        "foo==1.",
        "foo==1.0+",
        "foo==1.0++local",
        "foo==1.0+local..tag",
        "foo==1-0",
    ],
)
def test_exact_lock_parser_rejects_extra_directives_markers_comments_and_options(
    bad_line,
):
    payload = (verifier.EXPECTED_DIRECTIVES[0] + "\n" + bad_line + "\n").encode("utf-8")

    with pytest.raises(verifier.ContractError):
        verifier.parse_execution_lock(payload)


def test_exact_lock_parser_rejects_missing_or_duplicate_frozen_directive():
    with pytest.raises(verifier.ContractError, match="directive"):
        verifier.parse_execution_lock(b"torch==2.7.1+cu118\n")
    duplicate = (
        verifier.EXPECTED_DIRECTIVES[0]
        + "\n"
        + verifier.EXPECTED_DIRECTIVES[0]
        + "\ntorch==2.7.1+cu118\n"
    ).encode("utf-8")
    with pytest.raises(verifier.ContractError, match="duplicates"):
        verifier.parse_execution_lock(duplicate)


def test_exact_lock_parser_rejects_normalized_package_name_collision():
    payload = (
        verifier.EXPECTED_DIRECTIVES[0]
        + "\ntyping_extensions==4.15.0"
        + "\ntyping-extensions==4.15.0\n"
    ).encode()

    with pytest.raises(verifier.ContractError, match="duplicates package"):
        verifier.parse_execution_lock(payload)


@pytest.mark.parametrize("mutation", ["missing", "extra", "replaced"])
def test_execution_lock_requires_exact_twenty_pin_closure(monkeypatch, mutation):
    original = verifier.parse_execution_lock

    def tamper(data):
        pins, directives = original(data)
        pins = dict(pins)
        if mutation == "missing":
            pins.pop("colorama")
        elif mutation == "extra":
            pins["unexpected"] = "1.0"
        else:
            pins["numpy"] = "2.2.7"
        return pins, directives

    monkeypatch.setattr(verifier, "parse_execution_lock", tamper)

    with pytest.raises(verifier.ContractError, match="exact package/version closure"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    ("path", "replacement"),
    [
        (("packaging", "wheel_source_root"), "research/iclr2027/other"),
        (("packaging", "wheel_source_suffix"), ".pyi"),
        (("packaging", "wheel_top_level_packages"), ["other"]),
        (
            ("packaging", "package_discovery"),
            {"include": ["other"], "where": ["."]},
        ),
        (("packaging", "package_discovery_root"), "research/iclr2027/other"),
        (("packaging", "excluded_top_level_packages"), []),
        (
            (
                "packaging",
                "installed_distribution_policy",
                "expected_distribution_count",
            ),
            23,
        ),
    ],
)
def test_package_root_discovery_and_distribution_closure_are_frozen(
    monkeypatch, path, replacement
):
    def mutate(profile):
        cursor = profile
        for key in path[:-1]:
            cursor = cursor[key]
        cursor[path[-1]] = replacement

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(verifier.ContractError):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize(
    ("mutation", "value"),
    [
        ("requires_python", ">=99"),
        ("project_name", "other-project"),
        ("build_backend", "other.backend"),
    ],
)
def test_self_consistent_packaging_semantic_drift_is_still_blocked(
    monkeypatch, mutation, value
):
    original_parse = verifier.parse_minimal_pyproject

    def mutate_profile(profile):
        packaging = profile["packaging"]
        packaging[mutation] = value
        if mutation == "project_name":
            packaging["installed_distribution_policy"]["project"]["name"] = value

    def mutate_pyproject(data):
        pyproject = deepcopy(original_parse(data))
        if mutation == "requires_python":
            pyproject["project"]["requires-python"] = value
        elif mutation == "project_name":
            pyproject["project"]["name"] = value
        else:
            pyproject["build-system"]["build-backend"] = value
        return pyproject

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate_profile)
    monkeypatch.setattr(verifier, "parse_minimal_pyproject", mutate_pyproject)

    with pytest.raises(verifier.ContractError, match="complete packaging semantics"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_parsed_pyproject_semantic_drift_is_blocked(monkeypatch):
    original = verifier.parse_minimal_pyproject

    def tamper(data):
        pyproject = deepcopy(original(data))
        pyproject["project"]["requires-python"] = ">=99"
        return pyproject

    monkeypatch.setattr(verifier, "parse_minimal_pyproject", tamper)

    with pytest.raises(verifier.ContractError, match="pyproject packaging semantics"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_dependency_lock_path_is_frozen(monkeypatch):
    replacement = "research/iclr2027/pyproject.toml"

    def mutate(profile):
        profile["dependency_lock"].update(
            path=replacement,
            sha256=verifier.sha256_file(verifier.REPOSITORY_ROOT / replacement),
        )

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(verifier.ContractError, match="dependency lock path"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_pyproject_path_is_frozen(monkeypatch):
    replacement = verifier.EXPECTED_LOCK_PATH

    def mutate(profile):
        profile["packaging"].update(
            pyproject_path=replacement,
            pyproject_sha256=verifier.sha256_file(
                verifier.REPOSITORY_ROOT / replacement
            ),
        )

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(verifier.ContractError, match="packaging pyproject path"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_critical_input_role_path_mapping_is_frozen(monkeypatch):
    replacement = verifier.EXPECTED_CRITICAL_PATHS["fresh_install_preflight"]

    def mutate(profile):
        environment_verifier = next(
            row
            for row in profile["critical_inputs"]
            if row["role"] == "environment_verifier"
        )
        environment_verifier.update(
            path=replacement,
            sha256=verifier.sha256_file(verifier.REPOSITORY_ROOT / replacement),
        )

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(verifier.ContractError, match="role/path mapping"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_line_ending_transport_policy_profile_hash_is_frozen(monkeypatch):
    def mutate(profile):
        transport = next(
            row
            for row in profile["critical_inputs"]
            if row["role"] == "line_ending_transport_policy"
        )
        transport["sha256"] = "0" * 64

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(
        verifier.ContractError, match="line-ending transport policy SHA-256"
    ):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


@pytest.mark.parametrize("mutation", ["missing", "wrong_attribute", "duplicate"])
def test_line_ending_transport_policy_is_exact_and_fail_closed(mutation):
    data = (
        verifier.REPOSITORY_ROOT / verifier.EXPECTED_GITATTRIBUTES_PATH
    ).read_bytes()
    path = verifier.EXPECTED_FROZEN_TRANSPORT_PATHS[0].encode("ascii")
    rule = path + b" -text\n"
    if mutation == "missing":
        data = data.replace(rule, b"", 1)
    elif mutation == "wrong_attribute":
        data = data.replace(rule, path + b" text\n", 1)
    else:
        data = data.replace(rule, rule + rule, 1)

    with pytest.raises(verifier.ContractError, match="transport rule|ten-path closure"):
        verifier._validated_frozen_transport_paths(data)


def test_line_ending_transport_policy_rejects_crlf_policy_bytes():
    data = (
        verifier.REPOSITORY_ROOT / verifier.EXPECTED_GITATTRIBUTES_PATH
    ).read_bytes()

    with pytest.raises(verifier.ContractError, match="UTF-8/LF"):
        verifier._validated_frozen_transport_paths(data.replace(b"\n", b"\r\n"))


def test_test_group_paths_are_an_exact_profile_closure(monkeypatch):
    def mutate(profile):
        profile["tests"]["groups"]["pytorch_network_trainer"].pop()

    _patch_decoded_payload(monkeypatch, "fresh-install profile", mutate)

    with pytest.raises(verifier.ContractError, match="test group path closure"):
        verifier.validate_contract(verifier.DEFAULT_PROFILE)


def test_current_subject_package_tree_equals_claim_and_allowlist_closure():
    git = shutil.which("git")
    assert git is not None
    commit = subprocess.check_output(
        [git, "rev-parse", "--verify", "HEAD"],
        cwd=verifier.REPOSITORY_ROOT,
        text=True,
    ).strip()
    observed = verifier._subject_package_paths(
        Path(git).resolve(),
        verifier.REPOSITORY_ROOT,
        commit,
        verifier.EXPECTED_PACKAGE_DISCOVERY_ROOT,
        verifier.EXPECTED_PACKAGE_DISCOVERY,
        ".py",
    )

    assert observed == _reference_source_paths()


@pytest.mark.parametrize(
    "paths",
    [
        ["research/iclr2027/other.py"],
        ["research/iclr2027/lifeline_rl/data.json"],
        ["research/iclr2027/lifeline_rl/module.py"],
    ],
)
def test_declared_package_source_shape_is_fail_closed(paths):
    with pytest.raises(verifier.ContractError):
        verifier._validate_package_source_paths(
            paths, "research/iclr2027/lifeline_rl", ".py"
        )


def test_report_pass_means_contract_only_with_explicit_subject_binding(monkeypatch):
    captured = {}
    _patch_subject_success(monkeypatch, captured=captured)
    validation = verifier.validate_contract(verifier.DEFAULT_PROFILE)

    report = verifier.build_report(
        verifier.DEFAULT_PROFILE,
        "a" * 40,
        "b" * 40,
    )

    assert report["status"] == "PASS"
    assert report["ok"] is True
    assert report["blockers"] == []
    assert report["subject"]["subject_binding_verified"] is True
    assert report["scope_boundary"] == verifier.EXPECTED_SCOPE
    assert report["scope_boundary"]["contract_only"] is True
    assert report["scope_boundary"]["network_accessed"] is False
    assert report["scope_boundary"]["packages_installed"] is False
    assert report["scope_boundary"]["clean_install_executed"] is False
    assert report["packaging"]["subject_package_source_closure_verified"] is True
    assert report["publication"] == verifier.PUBLICATION_BOUNDARY
    assert report["verification_boundary"] == {
        "resists_same_user_adversarial_git_aba": False,
        "statement": verifier.VERIFICATION_BOUNDARY["statement"],
    }
    assert captured["args"][:3] == (
        verifier.REPOSITORY_ROOT.resolve(),
        "a" * 40,
        "b" * 40,
    )
    assert captured["kwargs"]["frozen_paths"] == validation.frozen_paths
    assert captured["kwargs"]["tool_paths"] == [
        Path(verifier.__file__).resolve(),
        verifier.SUBJECT_BINDING_SOURCE.resolve(),
    ]


def test_subject_local_and_tool_snapshots_cover_both_package_enumerations(monkeypatch):
    subject = _patch_subject_success(monkeypatch)
    subject_checks = []
    local_checks = []
    tool_checks = []
    monkeypatch.setattr(
        verifier,
        "assert_subject_snapshot_unchanged",
        lambda value: subject_checks.append(value),
    )
    monkeypatch.setattr(
        verifier.ContractValidation,
        "assert_local_bytes_unchanged",
        lambda self, repo_root: local_checks.append(repo_root),
    )
    monkeypatch.setattr(
        verifier,
        "_assert_snapshots_unchanged",
        lambda repo_root, snapshots, message: tool_checks.append(message),
    )

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert report["status"] == "PASS"
    assert subject_checks == [subject, subject, subject]
    assert len(local_checks) == 2
    assert len(tool_checks) == 2


def test_second_subject_snapshot_mutation_blocks_after_package_enumeration(monkeypatch):
    _patch_subject_success(monkeypatch)
    calls = 0

    def check(_snapshot):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise verifier.SubjectBindingError("synthetic late Git mutation")

    monkeypatch.setattr(verifier, "assert_subject_snapshot_unchanged", check)

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert calls == 2
    assert report["status"] == "BLOCKED"
    assert "synthetic late Git mutation" in report["blockers"]
    assert report["packaging"]["subject_package_source_closure_verified"] is False


def test_final_subject_snapshot_mutation_blocks_after_second_enumeration(monkeypatch):
    _patch_subject_success(monkeypatch)
    calls = 0

    def check(_snapshot):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise verifier.SubjectBindingError("synthetic final Git mutation")

    monkeypatch.setattr(verifier, "assert_subject_snapshot_unchanged", check)

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert calls == 3
    assert report["status"] == "BLOCKED"
    assert "synthetic final Git mutation" in report["blockers"]
    assert report["packaging"]["subject_package_source_closure_verified"] is False


def test_repeated_subject_package_enumerations_must_match(monkeypatch):
    _patch_subject_success(monkeypatch)
    exact = _reference_source_paths()
    enumerations = iter(
        [exact, exact + ("research/iclr2027/lifeline_rl/undeclared.py",)]
    )
    calls = 0

    def enumerate_paths(*args, **kwargs):
        nonlocal calls
        calls += 1
        return next(enumerations)

    monkeypatch.setattr(verifier, "_subject_package_paths", enumerate_paths)

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert calls == 2
    assert report["status"] == "BLOCKED"
    assert any(
        "repeated subject package tree enumerations differ from closure" in blocker
        for blocker in report["blockers"]
    )
    assert report["packaging"]["subject_package_source_closure_verified"] is False


def test_subject_binding_failure_blocks_contract(monkeypatch):
    def fail(*args, **kwargs):
        raise verifier.SubjectBindingError("synthetic subject mismatch")

    monkeypatch.setattr(verifier, "verify_subject_repository", fail)

    report = verifier.build_report(
        verifier.DEFAULT_PROFILE,
        "a" * 40,
        "b" * 40,
    )

    assert report["status"] == "BLOCKED"
    assert report["ok"] is False
    assert report["blockers"] == ["synthetic subject mismatch"]
    assert report["scope_boundary"]["tests_or_games_run"] is False


def test_invalid_subject_ids_are_redacted_without_sensitive_echo():
    secret = "private-subject-C:/secret/token"

    report = verifier.build_report(verifier.DEFAULT_PROFILE, secret, secret)
    rendered = verifier.render_report(report)

    assert report["status"] == "BLOCKED"
    assert report["subject"]["subject_commit"] is None
    assert report["subject"]["subject_tree"] is None
    assert secret not in rendered


def test_post_subject_local_snapshot_failure_blocks(monkeypatch):
    _patch_subject_success(monkeypatch)
    monkeypatch.setattr(
        verifier.ContractValidation,
        "assert_local_bytes_unchanged",
        lambda self, repo_root: (_ for _ in ()).throw(
            verifier.ContractError("synthetic post-subject mutation")
        ),
    )

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert report["status"] == "BLOCKED"
    assert report["blockers"] == ["synthetic post-subject mutation"]


def test_report_render_is_deterministic_canonical_lf(monkeypatch):
    _patch_subject_success(monkeypatch)
    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    first = verifier.render_report(report).encode("utf-8")
    second = verifier.render_report(report).encode("utf-8")

    assert first == second
    assert first.endswith(b"\n")
    assert b"\r\n" not in first
    assert json.loads(first) == report


def test_main_stdout_is_exact_canonical_utf8_lf(monkeypatch, capsysbinary):
    report = {"blockers": [], "ok": True, "status": "PASS"}
    monkeypatch.setattr(
        verifier,
        "build_report",
        lambda *args, **kwargs: deepcopy(report),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
        ],
    )

    assert verifier.main() == 0
    assert capsysbinary.readouterr().out == verifier.canonical_json_bytes(report)


def test_subject_package_tree_drift_blocks_pass(monkeypatch):
    unexpected = _reference_source_paths() + (
        "research/iclr2027/lifeline_rl/undeclared.py",
    )
    _patch_subject_success(monkeypatch, package_paths=unexpected)

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert report["status"] == "BLOCKED"
    assert any("package tree differs" in blocker for blocker in report["blockers"])


def test_subject_package_tree_missing_source_blocks_pass(monkeypatch):
    missing = _reference_source_paths()[:-1]
    _patch_subject_success(monkeypatch, package_paths=missing)

    report = verifier.build_report(verifier.DEFAULT_PROFILE, "a" * 40, "b" * 40)

    assert report["status"] == "BLOCKED"
    assert any("package tree differs" in blocker for blocker in report["blockers"])


def test_existing_output_is_rejected_without_overwrite(tmp_path, monkeypatch):
    output = tmp_path / "receipt.json"
    output.write_text("preserve\n", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    with pytest.raises(SystemExit) as caught:
        verifier.main()

    assert caught.value.code == 2
    assert output.read_text(encoding="utf-8") == "preserve\n"


@pytest.mark.parametrize(
    "relative",
    [
        "research/iclr2027/lifeline_rl/receipt.py.json",
        "research/iclr2027/configs/receipt.json",
        "research/iclr2027/tests/receipt.json",
    ],
)
def test_repository_output_outside_validation_tree_is_rejected(relative):
    output = verifier.REPOSITORY_ROOT.joinpath(*relative.split("/"))

    with pytest.raises(
        verifier.ContractError, match="results/iclr2027|results/validation"
    ):
        verifier.validate_output_path(output)


def test_output_requires_json_existing_plain_parent_and_safe_location(tmp_path):
    external = tmp_path / "receipt.json"
    assert verifier.validate_output_path(external) == external.absolute()
    with pytest.raises(verifier.ContractError, match=".json suffix"):
        verifier.validate_output_path(tmp_path / "receipt.txt")
    with pytest.raises(verifier.ContractError, match="already exist"):
        existing = tmp_path / "existing.json"
        existing.write_text("preserve\n", encoding="utf-8")
        verifier.validate_output_path(existing)
    with pytest.raises(verifier.ContractError, match="parent"):
        verifier.validate_output_path(tmp_path / "missing" / "receipt.json")


def test_repository_validation_subtree_output_is_allowed_but_not_created(tmp_path):
    output = (
        verifier.RESEARCH_ROOT
        / "results"
        / "validation"
        / f"fresh-profile-path-check-{tmp_path.name}.json"
    )
    assert not output.exists()

    assert verifier.validate_output_path(output) == output.absolute()
    assert not output.exists()


def test_reparse_output_parent_is_rejected_when_supported(tmp_path):
    target = tmp_path / "plain"
    target.mkdir()
    link = tmp_path / "linked"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("host does not permit directory symlinks")

    with pytest.raises(verifier.ContractError, match="canonical plain directory"):
        verifier.validate_output_path(link / "receipt.json")


def test_output_publication_recheck_rewrites_drift_as_blocked(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    reports = iter(
        [
            {"blockers": [], "ok": True, "status": "PASS"},
            {
                "blockers": ["synthetic input drift"],
                "ok": False,
                "status": "BLOCKED",
            },
            {
                "blockers": ["synthetic input drift"],
                "ok": False,
                "status": "BLOCKED",
            },
        ]
    )
    monkeypatch.setattr(verifier, "build_report", lambda *args, **kwargs: next(reports))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "BLOCKED"
    assert payload["ok"] is False
    assert "synthetic input drift" in payload["blockers"]
    assert any("publication recheck" in item for item in payload["blockers"])
    assert json.loads(capsys.readouterr().out) == payload


def test_output_third_recheck_drift_is_published_only_as_blocked(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    reports = iter(
        [
            {"blockers": [], "ok": True, "status": "PASS"},
            {"blockers": [], "ok": True, "status": "PASS"},
            {
                "blockers": ["synthetic drift after second recheck"],
                "ok": False,
                "status": "BLOCKED",
            },
        ]
    )
    monkeypatch.setattr(verifier, "build_report", lambda *args, **kwargs: next(reports))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "BLOCKED"
    assert "synthetic drift after second recheck" in payload["blockers"]
    assert any("publication rechecks" in item for item in payload["blockers"])
    assert json.loads(capsys.readouterr().out) == payload


def test_output_pass_is_published_only_after_successful_final_recheck(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    report = {"blockers": [], "ok": True, "status": "PASS"}
    calls = 0

    def build(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls in {2, 3}:
            assert not output.exists()
        return deepcopy(report)

    monkeypatch.setattr(verifier, "build_report", build)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert calls == 3
    assert payload["status"] == "PASS"
    assert json.loads(capsys.readouterr().out) == payload
    assert not list(tmp_path.glob(f".{output.name}.*.tmp"))


def test_second_build_exception_never_leaves_pass_target(tmp_path, monkeypatch, capsys):
    output = tmp_path / "receipt.json"
    calls = 0

    def build(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            assert not output.exists()
            raise RuntimeError("synthetic recheck crash")
        return {"blockers": [], "ok": True, "status": "PASS"}

    monkeypatch.setattr(verifier, "build_report", build)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "BLOCKED"
    assert not output.exists()
    assert not list(tmp_path.glob(f".{output.name}.*.tmp"))


def test_third_build_exception_never_leaves_pass_target(tmp_path, monkeypatch, capsys):
    output = tmp_path / "receipt.json"
    calls = 0

    def build(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 3:
            assert not output.exists()
            raise RuntimeError("synthetic final recheck crash")
        return {"blockers": [], "ok": True, "status": "PASS"}

    monkeypatch.setattr(verifier, "build_report", build)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(capsys.readouterr().out)
    assert calls == 3
    assert payload["status"] == "BLOCKED"
    assert not output.exists()
    assert not list(tmp_path.glob(f".{output.name}.*.tmp"))


def test_create_only_publication_failure_leaves_no_target_or_temp(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    report = {"blockers": [], "ok": True, "status": "PASS"}
    monkeypatch.setattr(
        verifier, "build_report", lambda *args, **kwargs: deepcopy(report)
    )
    monkeypatch.setattr(
        verifier.os,
        "open",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PermissionError("synthetic create failure")
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "BLOCKED"
    assert not output.exists()
    assert not list(tmp_path.glob(f".{output.name}.*.tmp"))


def test_create_only_publication_target_race_preserves_racer_and_never_writes_pass(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    report = {"blockers": [], "ok": True, "status": "PASS"}
    monkeypatch.setattr(
        verifier, "build_report", lambda *args, **kwargs: deepcopy(report)
    )

    original_open = verifier.os.open

    def race(path, flags, mode=0o777):
        Path(path).write_text("racer\n", encoding="utf-8")
        return original_open(path, flags, mode)

    monkeypatch.setattr(verifier.os, "open", race)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "BLOCKED"
    assert output.read_text(encoding="utf-8") == "racer\n"
    assert not list(tmp_path.glob(f".{output.name}.*.tmp"))


def test_single_byte_commit_writes_and_fsyncs_complete_invalid_payload_first(
    tmp_path, monkeypatch
):
    output = tmp_path / "receipt.json"
    rendered = verifier.render_report({"blockers": [], "ok": True, "status": "PASS"})
    events = []
    original_write = verifier.os.write
    original_fsync = verifier.os.fsync

    def record_write(descriptor, payload):
        events.append(("write", bytes(payload)))
        return original_write(descriptor, payload)

    def record_fsync(descriptor):
        events.append(("fsync", None))
        return original_fsync(descriptor)

    monkeypatch.setattr(verifier.os, "write", record_write)
    monkeypatch.setattr(verifier.os, "fsync", record_fsync)

    verifier._publish_report_create_only(output, rendered)

    assert json.loads(output.read_text(encoding="utf-8"))["status"] == "PASS"
    assert events[0] == ("write", b"!" + rendered.encode("utf-8")[1:])
    assert events[1] == ("fsync", None)
    assert events[2] == ("write", b"{")
    assert events[3] == ("fsync", None)


def test_precommit_fsync_failure_with_total_cleanup_failure_is_unparseable(
    tmp_path, monkeypatch
):
    output = tmp_path / "receipt.json"
    rendered = verifier.render_report({"blockers": [], "ok": True, "status": "PASS"})
    monkeypatch.setattr(
        verifier.os,
        "fsync",
        lambda descriptor: (_ for _ in ()).throw(OSError("synthetic precommit fsync")),
    )
    monkeypatch.setattr(verifier, "_invalidate_failed_publication", lambda *args: None)

    with pytest.raises(verifier.ContractError, match="create-only publication failed"):
        verifier._publish_report_create_only(output, rendered)

    assert output.read_bytes() == b"!" + rendered.encode("utf-8")[1:]
    with pytest.raises(json.JSONDecodeError):
        json.loads(output.read_text(encoding="utf-8"))


def test_partial_precommit_write_with_total_cleanup_failure_is_unparseable(
    tmp_path, monkeypatch
):
    output = tmp_path / "receipt.json"
    rendered = verifier.render_report({"blockers": [], "ok": True, "status": "PASS"})

    def partial_then_fail(descriptor, payload):
        assert verifier.os.write(descriptor, payload[:17]) == 17
        raise OSError("synthetic partial invalid-payload write")

    monkeypatch.setattr(verifier, "_write_all_fd", partial_then_fail)
    monkeypatch.setattr(verifier, "_invalidate_failed_publication", lambda *args: None)

    with pytest.raises(verifier.ContractError, match="create-only publication failed"):
        verifier._publish_report_create_only(output, rendered)

    assert output.read_bytes().startswith(b"!")
    with pytest.raises(json.JSONDecodeError):
        json.loads(output.read_text(encoding="utf-8"))


def test_commit_byte_short_write_with_total_cleanup_failure_is_unparseable(
    tmp_path, monkeypatch
):
    output = tmp_path / "receipt.json"
    rendered = verifier.render_report({"blockers": [], "ok": True, "status": "PASS"})
    original_write = verifier.os.write

    def fail_commit_byte(descriptor, payload):
        if bytes(payload) == b"{":
            return 0
        return original_write(descriptor, payload)

    monkeypatch.setattr(verifier.os, "write", fail_commit_byte)
    monkeypatch.setattr(verifier, "_invalidate_failed_publication", lambda *args: None)

    with pytest.raises(verifier.ContractError, match="create-only publication failed"):
        verifier._publish_report_create_only(output, rendered)

    assert output.read_bytes() == b"!" + rendered.encode("utf-8")[1:]
    with pytest.raises(json.JSONDecodeError):
        json.loads(output.read_text(encoding="utf-8"))


def test_postcommit_fsync_failure_does_not_downgrade_stdout_or_exit(
    tmp_path, monkeypatch, capsys
):
    output = tmp_path / "receipt.json"
    report = {"blockers": [], "ok": True, "status": "PASS"}
    monkeypatch.setattr(
        verifier, "build_report", lambda *args, **kwargs: deepcopy(report)
    )
    original_fsync = verifier.os.fsync
    calls = 0

    def fail_second_fsync(descriptor):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("synthetic postcommit fsync failure")
        return original_fsync(descriptor)

    monkeypatch.setattr(verifier.os, "fsync", fail_second_fsync)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_d14_d16_fresh_install_profile.py",
            "--subject-commit",
            "a" * 40,
            "--subject-tree",
            "b" * 40,
            "--output",
            str(output),
        ],
    )

    assert verifier.main() == 0
    assert calls == 2
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "PASS"
    assert json.loads(capsys.readouterr().out) == payload


def test_postcommit_close_failure_does_not_downgrade_publication(tmp_path, monkeypatch):
    output = tmp_path / "receipt.json"
    rendered = verifier.render_report({"blockers": [], "ok": True, "status": "PASS"})
    original_close = verifier.os.close

    def close_then_fail(descriptor):
        original_close(descriptor)
        raise OSError("synthetic postcommit close failure")

    monkeypatch.setattr(verifier.os, "close", close_then_fail)

    verifier._publish_report_create_only(output, rendered)

    assert json.loads(output.read_text(encoding="utf-8"))["status"] == "PASS"
