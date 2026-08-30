from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

from scripts import d14_d16_fresh_install_preflight as preflight


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _write_fixture(
    tmp_path: Path,
    *,
    lock_text: str = "torch==2.7.1+cu118\ntyping_extensions==4.15.0\n",
    torch_filename: str = "torch-2.7.1+cu118-cp310-cp310-win_amd64.whl",
) -> tuple[Path, Path, Path]:
    lock = tmp_path / "requirements.lock.txt"
    lock.write_text(lock_text, encoding="utf-8", newline="\n")
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    wheels = {
        torch_filename: b"synthetic torch wheel",
        "typing_extensions-4.15.0-py3-none-any.whl": b"synthetic typing wheel",
    }
    artifacts = []
    for filename, payload in wheels.items():
        (wheelhouse / filename).write_bytes(payload)
        package = "torch" if filename.startswith("torch-") else "typing_extensions"
        version = "2.7.1+cu118" if package == "torch" else "4.15.0"
        artifacts.append(
            {
                "package": package,
                "version": version,
                "filename": filename,
                "size_bytes": len(payload),
                "sha256": _sha256(payload),
            }
        )
    manifest = tmp_path / "wheelhouse-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_name": preflight.MANIFEST_SCHEMA_NAME,
                "schema_version": 1,
                "lock_sha256": preflight.sha256_file(lock),
                "target": preflight.EXPECTED_TARGET,
                "artifacts": list(reversed(artifacts)),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return lock, wheelhouse, manifest


def test_complete_synthetic_wheelhouse_passes_with_bound_tags_and_redacted_paths(
    tmp_path,
):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)

    first = preflight.build_report(lock, wheelhouse, manifest)
    second = preflight.build_report(lock, wheelhouse, manifest)

    assert first == second
    assert first["status"] == "PASS"
    assert first["ok"] is True
    assert first["blockers"] == []
    input_paths = [
        first["inputs"]["lock"]["path"],
        first["inputs"]["manifest"]["path"],
        first["inputs"]["wheelhouse"]["path"],
    ]
    assert all(not Path(value).is_absolute() for value in input_paths)
    assert all(":" not in value and "\\" not in value for value in input_paths)
    assert [item["package"] for item in first["artifacts"]] == [
        "torch",
        "typing-extensions",
    ]
    assert first["artifacts"][0]["python_tags"] == ["cp310"]
    assert all(item["verified"] for item in first["artifacts"])
    assert first["scope_boundary"]["retraining_reproduced"] is False
    assert first["scope_boundary"]["d17_d19_formal_readiness_established"] is False


@pytest.mark.parametrize("field", ["sha256", "size_bytes"])
def test_missing_required_artifact_hash_or_size_blocks(tmp_path, field):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    del payload["artifacts"][0][field]
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = preflight.build_report(lock, wheelhouse, manifest)

    assert report["status"] == "BLOCKED"
    assert report["ok"] is False
    assert any(field in blocker for blocker in report["blockers"])


def test_missing_pin_and_undeclared_wheel_both_block(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["artifacts"] = [
        artifact for artifact in payload["artifacts"] if artifact["package"] == "torch"
    ]
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = preflight.build_report(lock, wheelhouse, manifest)

    assert report["status"] == "BLOCKED"
    assert (
        "manifest: exact pin typing-extensions has no declared wheel"
        in report["blockers"]
    )
    assert any("undeclared wheel" in blocker for blocker in report["blockers"])


def test_incompatible_linux_wheel_blocks_windows_target(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(
        tmp_path,
        torch_filename="torch-2.7.1+cu118-cp310-cp310-manylinux_2_17_x86_64.whl",
    )

    report = preflight.build_report(lock, wheelhouse, manifest)

    assert report["status"] == "BLOCKED"
    assert any(
        "wheel tags are incompatible" in blocker for blocker in report["blockers"]
    )


def test_non_exact_lock_blocks_before_fresh_install(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(
        tmp_path,
        lock_text="torch>=2.7\ntyping_extensions==4.15.0\n",
    )

    report = preflight.build_report(lock, wheelhouse, manifest)

    assert report["status"] == "BLOCKED"
    assert any("not an exact pin" in blocker for blocker in report["blockers"])


def test_main_writes_deterministic_lf_receipt_and_returns_two_when_blocked(
    tmp_path, monkeypatch, capsys
):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["artifacts"][0]["sha256"] = "0" * 64
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    output = tmp_path / "receipts" / "preflight-a.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "d14_d16_fresh_install_preflight.py",
            "--lock",
            str(lock),
            "--wheelhouse",
            str(wheelhouse),
            "--manifest",
            str(manifest),
            "--output",
            str(output),
        ],
    )

    assert preflight.main() == 2
    first = output.read_bytes()
    assert first.endswith(b"\n")
    assert b"\r\n" not in first
    assert first.decode("utf-8") == capsys.readouterr().out
    second_output = tmp_path / "receipts" / "preflight-b.json"
    sys.argv[-1] = str(second_output)
    assert preflight.main() == 2
    assert second_output.read_bytes() == first


def test_unknown_manifest_or_artifact_keys_block(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["unexpected"] = True
    payload["artifacts"][0]["unexpected"] = True
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = preflight.build_report(lock, wheelhouse, manifest)

    assert report["status"] == "BLOCKED"
    assert "manifest: keys do not match the required schema" in report["blockers"]
    assert any(
        "artifact" in blocker and "keys do not match" in blocker
        for blocker in report["blockers"]
    )


def test_existing_output_is_rejected(tmp_path, monkeypatch):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    output = tmp_path / "preflight.json"
    output.write_text("preserve\n", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "d14_d16_fresh_install_preflight.py",
            "--lock",
            str(lock),
            "--wheelhouse",
            str(wheelhouse),
            "--manifest",
            str(manifest),
            "--output",
            str(output),
        ],
    )

    with pytest.raises(SystemExit) as caught:
        preflight.main()

    assert caught.value.code == 2
    assert output.read_text(encoding="utf-8") == "preserve\n"


def test_output_may_not_overlap_any_input(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)

    assert preflight._output_overlaps_input(manifest, lock, wheelhouse, manifest)
    assert preflight._output_overlaps_input(
        wheelhouse / "receipt.json", lock, wheelhouse, manifest
    )
    assert not preflight._output_overlaps_input(
        tmp_path / "receipts" / "receipt.json", lock, wheelhouse, manifest
    )


def test_invalid_manifest_filename_is_redacted_from_blocked_receipt(tmp_path):
    lock, wheelhouse, manifest = _write_fixture(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    private_segment = "private-segment"
    payload["artifacts"][0]["filename"] = (
        "Z:" + "\\outside\\" + private_segment + ".whl"
    )
    manifest.write_text(json.dumps(payload), encoding="utf-8")

    report = preflight.build_report(lock, wheelhouse, manifest)
    rendered = preflight.render_report(report)

    assert report["status"] == "BLOCKED"
    assert private_segment not in rendered
    assert any(item["filename"] == "<invalid-filename>" for item in report["artifacts"])
