from __future__ import annotations

import importlib.metadata
import json
import sys
from copy import deepcopy

import pytest

from scripts import verify_d14_d16_environment as environment_verifier
from scripts.verify_d14_d16_environment import (
    canonical_json_bytes,
    parse_lock,
    parse_portable_execution_metadata,
    verify_packages,
)


def write_portable_metadata(path, value=None):
    payload = (
        deepcopy(environment_verifier.EXPECTED_PORTABLE_METADATA)
        if value is None
        else value
    )
    path.write_bytes(canonical_json_bytes(payload))
    return payload


def test_parse_lock_accepts_only_exact_portable_pins(tmp_path):
    lock = tmp_path / "requirements.lock.txt"
    lock.write_text(
        "# comment\n"
        "--extra-index-url https://download.pytorch.org/whl/cu118\n"
        "torch==2.7.1+cu118\n"
        "typing_extensions==4.15.0\n",
        encoding="utf-8",
    )

    assert parse_lock(lock) == {
        "torch": "2.7.1+cu118",
        "typing-extensions": "4.15.0",
    }


@pytest.mark.parametrize(
    "entry",
    [
        "torch>=2.7\n",
        "package @ file:///C:/private/build\n",
        "torch==2.7.1\ntorch==2.7.1\n",
    ],
)
def test_parse_lock_rejects_nonportable_or_duplicate_entries(tmp_path, entry):
    lock = tmp_path / "bad.lock.txt"
    lock.write_text(entry, encoding="utf-8")

    with pytest.raises(ValueError):
        parse_lock(lock)


def test_verify_packages_reports_missing_and_mismatched_versions():
    versions = {"torch": "2.7.1+cu118", "pytest": "8.0.0"}

    def lookup(name: str) -> str:
        if name == "missing":
            raise importlib.metadata.PackageNotFoundError(name)
        return versions[name]

    observed, errors = verify_packages(
        {"torch": "2.7.1+cu118", "pytest": "9.0.3", "missing": "1.0"},
        version_lookup=lookup,
    )

    assert observed == {
        "missing": None,
        "pytest": "8.0.0",
        "torch": "2.7.1+cu118",
    }
    assert errors == [
        "missing: expected 1.0, observed None",
        "pytest: expected 9.0.3, observed 8.0.0",
    ]


def test_portable_execution_metadata_is_path_free_and_source_bound(tmp_path):
    metadata = tmp_path / "portable.json"
    write_portable_metadata(metadata)

    parsed = parse_portable_execution_metadata(metadata)

    assert parsed["source_execution_metadata_sha256"] == (
        environment_verifier.FORMAL_EXECUTION_METADATA_SHA256
    )
    assert all(
        "/" not in str(value) and "\\" not in str(value) for value in parsed.values()
    )


def test_portable_execution_metadata_rejects_schema_drift(tmp_path):
    metadata = tmp_path / "portable.json"
    payload = write_portable_metadata(metadata)
    payload["unexpected"] = True
    write_portable_metadata(metadata, payload)

    with pytest.raises(ValueError, match="keys"):
        parse_portable_execution_metadata(metadata)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_execution_metadata_sha256", "0" * 64),
        ("python", "3.10.19"),
        ("device_name", r"C:\private\host"),
        ("schema_version", True),
        ("schema_version", 1.0),
        ("cudnn_version", True),
        ("cudnn_version", 90100.0),
    ],
)
def test_portable_execution_metadata_rejects_projection_tamper(tmp_path, field, value):
    metadata = tmp_path / "portable.json"
    payload = write_portable_metadata(metadata)
    payload[field] = value
    write_portable_metadata(metadata, payload)

    with pytest.raises(ValueError, match="frozen formal projection"):
        parse_portable_execution_metadata(metadata)


def test_portable_execution_metadata_rejects_duplicate_keys(tmp_path):
    metadata = tmp_path / "portable.json"
    payload = write_portable_metadata(metadata)
    canonical = canonical_json_bytes(payload).decode("utf-8")
    duplicate = canonical.replace(
        '  "python": "3.10.20",\n',
        '  "python": "3.10.20",\n  "python": "3.10.20",\n',
    )
    metadata.write_text(duplicate, encoding="utf-8", newline="\n")

    with pytest.raises(ValueError, match="duplicate key"):
        parse_portable_execution_metadata(metadata)


def test_portable_execution_metadata_rejects_noncanonical_json(tmp_path):
    metadata = tmp_path / "portable.json"
    payload = deepcopy(environment_verifier.EXPECTED_PORTABLE_METADATA)
    metadata.write_text(json.dumps(payload), encoding="utf-8", newline="\n")

    with pytest.raises(ValueError, match="not canonical"):
        parse_portable_execution_metadata(metadata)


def test_portable_path_label_never_exposes_external_absolute_path(tmp_path):
    assert (
        environment_verifier.portable_path_label(environment_verifier.DEFAULT_LOCK)
        == "research/iclr2027/requirements-d14-d16-win-cu118.lock.txt"
    )
    assert environment_verifier.portable_path_label(tmp_path / "private.json") == (
        "<external>"
    )


def test_main_writes_canonical_lf_receipt(tmp_path, monkeypatch):
    output = tmp_path / "receipt.json"
    monkeypatch.setattr(
        environment_verifier,
        "build_report",
        lambda _lock, _metadata, output_path=None: {
            "details": {"value": 1},
            "ok": True,
        },
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["verify_d14_d16_environment.py", "--output", str(output)],
    )

    assert environment_verifier.main() == 0
    payload = output.read_bytes()
    assert payload.endswith(b"\n")
    assert b"\r\n" not in payload
