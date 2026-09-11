#!/usr/bin/env python3
"""Run the D20 calibration gate and, only after PASS, the D20-v2 matrix.

This is a thin immutable-order orchestration layer for the AutoDL job.  It
does not implement game logic or compute reported statistics; both formal
executors and their independent verifiers remain the scientific authorities.
Only compact decision-relevant evidence is written to ``--export-summary``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence


SCRIPT_PATH = Path(__file__).resolve()
RESEARCH_ROOT = SCRIPT_PATH.parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
CALIBRATION_SCRIPT = RESEARCH_ROOT / "scripts" / "d20_strong_opponent_calibration.py"
D20_RUNNER = RESEARCH_ROOT / "scripts" / "d20_matched_ablation_runner.py"
D20_VERIFIER = RESEARCH_ROOT / "scripts" / "verify_d20_matched_ablation.py"


class OrchestrationError(RuntimeError):
    pass


def _repo_path(raw: Path) -> Path:
    candidate = raw if raw.is_absolute() else REPO_ROOT / raw
    resolved = candidate.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise OrchestrationError(f"path escapes repository: {raw}") from exc
    return resolved


def _sha256(path: Path) -> str:
    if not path.is_file() or path.is_symlink():
        raise OrchestrationError(f"not a regular evidence file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise OrchestrationError(f"cannot read {label}: {exc}") from exc
    if not isinstance(payload, dict):
        raise OrchestrationError(f"{label} must be an object")
    return payload


def _write_new_json(path: Path, payload: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise OrchestrationError(f"refusing to overwrite export: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _evidence(path: Path) -> dict[str, Any]:
    return {"path": path.as_posix(), "sha256": _sha256(path), "content": _read_json(path, path.name)}


def _run(command: list[str]) -> None:
    completed = subprocess.run(command, cwd=REPO_ROOT, check=False)
    if completed.returncode != 0:
        raise OrchestrationError(f"subprocess failed with exit code {completed.returncode}: {command[1]}")


def run(
    *,
    calibration_root: Path,
    d20_root: Path,
    export_summary: Path,
    calibration_workers: int,
) -> dict[str, Any]:
    calibration = _repo_path(calibration_root)
    formal = _repo_path(d20_root)
    if calibration.exists() or formal.exists():
        raise OrchestrationError("formal output root already exists")
    if calibration_workers < 1:
        raise OrchestrationError("calibration_workers must be positive")

    calibration_command = [
        sys.executable,
        "-B",
        str(CALIBRATION_SCRIPT),
        "--run-formal",
        "--output-root",
        str(calibration),
        "--workers",
        str(calibration_workers),
    ]
    try:
        _run(calibration_command)
    except OrchestrationError:
        report_path = calibration / "independent_verification.json"
        payload = {
            "status": "CALIBRATION_DID_NOT_AUTHORIZE_D20",
            "d20_started": False,
            "calibration": _evidence(report_path) if report_path.is_file() else None,
        }
        _write_new_json(export_summary, payload)
        return payload

    calibration_report_path = calibration / "independent_verification.json"
    calibration_report = _read_json(calibration_report_path, "calibration report")
    required = {
        "status": "PASS",
        "formal_ready": True,
        "candidate_id": "minimax_d2_cap8_v1",
        "passed_sizes": [10, 12],
    }
    if any(calibration_report.get(key) != expected for key, expected in required.items()):
        payload = {
            "status": "CALIBRATION_DID_NOT_AUTHORIZE_D20",
            "d20_started": False,
            "calibration": _evidence(calibration_report_path),
        }
        _write_new_json(export_summary, payload)
        return payload

    reverify_path = formal / "postrun_independent_reverification.json"
    try:
        _run(
            [
                sys.executable,
                "-B",
                str(D20_RUNNER),
                "--run-formal",
                "--output-root",
                str(formal),
                "--calibration-report",
                str(calibration_report_path),
                "--device",
                "cuda",
            ]
        )
        _run(
            [
                sys.executable,
                "-B",
                str(D20_VERIFIER),
                "--run-root",
                str(formal),
                "--report-output",
                str(reverify_path),
            ]
        )
    except OrchestrationError:
        partial = {
            name: _evidence(formal / name)
            for name in ("completion.json", "independent_verification.json", "canonical_numeric.json")
            if (formal / name).is_file()
        }
        payload = {
            "status": "D20_RUN_FAILED",
            "d20_started": True,
            "calibration": _evidence(calibration_report_path),
            "d20_partial_evidence": partial,
        }
        _write_new_json(export_summary, payload)
        return payload
    payload = {
        "status": "D20_FORMAL_COMPLETED",
        "d20_started": True,
        "calibration": {
            "completion": _evidence(calibration / "completion.json"),
            "verification": _evidence(calibration_report_path),
            "numeric": _evidence(calibration / "canonical_numeric.json"),
        },
        "d20": {
            "completion": _evidence(formal / "completion.json"),
            "verification": _evidence(formal / "independent_verification.json"),
            "numeric": _evidence(formal / "canonical_numeric.json"),
            "postrun_reverification": _evidence(reverify_path),
        },
    }
    _write_new_json(export_summary, payload)
    return payload


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--calibration-root", type=Path, required=True)
    result.add_argument("--d20-root", type=Path, required=True)
    result.add_argument("--export-summary", type=Path, required=True)
    result.add_argument("--calibration-workers", type=int, default=8)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        payload = run(
            calibration_root=args.calibration_root,
            d20_root=args.d20_root,
            export_summary=args.export_summary,
            calibration_workers=args.calibration_workers,
        )
    except Exception as exc:
        print(json.dumps({"status": "FAIL_CLOSED", "issue": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if payload.get("status") == "D20_FORMAL_COMPLETED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
