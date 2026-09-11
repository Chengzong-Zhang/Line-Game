from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence


TARGET_CANDIDATE = (
    "research/iclr2027/results/validation/"
    "targeted_history_twin_n6_stage5_search_25k_v1.json"
)
TARGET_RECEIPT = (
    "research/iclr2027/results/validation/"
    "targeted_history_twin_n6_stage5_verification_v1.json"
)
PYTHON_VERIFIER = "research/iclr2027/scripts/verify_targeted_history_twin.py"
ASCII_ENGINE = "web/GameEngine.js"
ASCII_WEB_WITNESS = "web/history_twin_web_witness.mjs"
RUNTIME_ENGINE = "web/web\u524d\u7aef/GameEngine.js"
RUNTIME_WEB_WITNESS = (
    "web/web\u524d\u7aef/guide/interesting/verify-superko-history-divergence.mjs"
)
COMPARISON_FIELDS = (
    "schema_version",
    "artifact_kind",
    "status",
    "ok",
    "candidate_binding",
    "source_binding",
    "verified_witness",
    "claim_boundary",
    "cross_engine_replay",
)


class PortableVerificationError(RuntimeError):
    """Fail-closed portable history-twin verification error."""


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def _strict_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8")
        value = json.loads(
            text,
            parse_constant=lambda token: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON token: {token}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise PortableVerificationError(f"{label} is not strict UTF-8 JSON") from exc
    return value


def _require_file(root: Path, relative: str) -> Path:
    path = root.joinpath(*relative.split("/"))
    if not path.is_file() or path.is_symlink():
        raise PortableVerificationError(f"required candidate file is missing: {relative}")
    return path


def _copy_runtime_dependency(root: Path, source: str, destination: str) -> None:
    source_path = _require_file(root, source)
    destination_path = root.joinpath(*destination.split("/"))
    if destination_path.exists() or destination_path.is_symlink():
        raise PortableVerificationError(
            f"runtime dependency destination already exists: {destination}"
        )
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, destination_path)
    if _sha256(source_path) != _sha256(destination_path):
        raise PortableVerificationError(
            f"runtime dependency copy changed bytes: {destination}"
        )


def verify_candidate(candidate_root: Path, python: str) -> dict[str, Any]:
    candidate_root = candidate_root.resolve(strict=True)
    if not candidate_root.is_dir():
        raise PortableVerificationError("candidate root is not a directory")

    expected_receipt = _strict_json(
        _require_file(candidate_root, TARGET_RECEIPT).read_bytes(),
        "frozen targeted history-twin receipt",
    )
    if not isinstance(expected_receipt, dict):
        raise PortableVerificationError("frozen targeted receipt is not an object")
    source_binding = expected_receipt.get("source_binding")
    if not isinstance(source_binding, dict):
        raise PortableVerificationError("frozen targeted receipt lacks source bindings")
    expected_engine = source_binding.get("tracked_web_engine_sha256")
    expected_witness = source_binding.get("tracked_web_source_sha256")
    if (
        _sha256(_require_file(candidate_root, ASCII_ENGINE)) != expected_engine
        or _sha256(_require_file(candidate_root, ASCII_WEB_WITNESS))
        != expected_witness
    ):
        raise PortableVerificationError(
            "ASCII Web dependency bytes do not match the frozen receipt"
        )

    with tempfile.TemporaryDirectory(prefix="lifeline-history-twin-") as temp_name:
        runtime_root = Path(temp_name) / "candidate-runtime"
        shutil.copytree(candidate_root, runtime_root, symlinks=False)
        _copy_runtime_dependency(runtime_root, ASCII_ENGINE, RUNTIME_ENGINE)
        _copy_runtime_dependency(
            runtime_root,
            ASCII_WEB_WITNESS,
            RUNTIME_WEB_WITNESS,
        )
        command = [
            python,
            "-B",
            str(_require_file(runtime_root, PYTHON_VERIFIER)),
            "--candidate",
            str(_require_file(runtime_root, TARGET_CANDIDATE)),
            "--require-web-replay",
        ]
        completed = subprocess.run(
            command,
            cwd=runtime_root,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="replace")[-4000:]
            raise PortableVerificationError(
                f"history-twin verifier failed with exit {completed.returncode}: {stderr}"
            )
        observed = _strict_json(completed.stdout, "portable verifier output")
        if not isinstance(observed, dict):
            raise PortableVerificationError("portable verifier output is not an object")

    for field in COMPARISON_FIELDS:
        if observed.get(field) != expected_receipt.get(field):
            raise PortableVerificationError(
                f"portable verifier output differs from frozen receipt at {field}"
            )
    return {
        "schema_version": 1,
        "status": "PASS",
        "candidate_status": "candidate_only_not_approved",
        "author_approval_required": True,
        "candidate_sha256": _sha256(_require_file(candidate_root, TARGET_CANDIDATE)),
        "receipt_sha256": _sha256(_require_file(candidate_root, TARGET_RECEIPT)),
        "portable_dependency_projection": {
            ASCII_ENGINE: RUNTIME_ENGINE,
            ASCII_WEB_WITNESS: RUNTIME_WEB_WITNESS,
        },
        "verified_fields": list(COMPARISON_FIELDS),
        "runtime_boundary": "temporary copy only; candidate bytes were not modified",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run the original history-twin Python and Web verifiers from an ASCII-path "
            "supplement candidate without changing candidate bytes."
        )
    )
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--python", default=sys.executable)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = verify_candidate(args.candidate_root, args.python)
    except (OSError, PortableVerificationError, subprocess.SubprocessError) as exc:
        print(
            json.dumps(
                {"status": "FAIL", "error": str(exc)},
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
