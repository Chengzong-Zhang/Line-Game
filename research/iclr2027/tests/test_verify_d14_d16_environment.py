from __future__ import annotations

import importlib.metadata
import sys

import pytest

from scripts import verify_d14_d16_environment as environment_verifier
from scripts.verify_d14_d16_environment import parse_lock, verify_packages


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


def test_main_writes_canonical_lf_receipt(tmp_path, monkeypatch):
    output = tmp_path / "receipt.json"
    monkeypatch.setattr(
        environment_verifier,
        "build_report",
        lambda _lock, _metadata: {"details": {"value": 1}, "ok": True},
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
