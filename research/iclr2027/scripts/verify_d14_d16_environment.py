"""Verify the retained D14--D16 software environment without running games.

The verifier is intentionally offline and read-only unless ``--output`` is
provided. Hardware identity is reported but is not folded into the software
lock decision; the formal receipts remain authoritative for the original GPU.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
from pathlib import Path
from typing import Callable, Mapping


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOCK = RESEARCH_ROOT / "requirements-d14-d16-win-cu118.lock.txt"
DEFAULT_METADATA = (
    RESEARCH_ROOT
    / "results"
    / "validation"
    / "d14_d16_execution_metadata_portable_20260831.json"
)
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORMAL_EXECUTION_METADATA_SHA256 = (
    "77fb2c380a6a694f897f063409fabdc7e77068eb4f6240a052816b20855f9188"
)
EXPECTED_PORTABLE_METADATA: dict[str, object] = {
    "schema_name": "lifeline-d14-d16-portable-execution-metadata",
    "schema_version": 1,
    "source_execution_metadata_sha256": FORMAL_EXECUTION_METADATA_SHA256,
    "python": "3.10.20",
    "torch_version": "2.7.1+cu118",
    "cuda_runtime_version": "11.8",
    "cudnn_version": 90100,
    "device_name": "NVIDIA GeForce RTX 4060 Laptop GPU",
}
PORTABLE_METADATA_KEYS = set(EXPECTED_PORTABLE_METADATA)
MAX_PORTABLE_METADATA_BYTES = 64 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode(
        "utf-8"
    )


def strict_json_object(data: bytes) -> dict[str, object]:
    if len(data) > MAX_PORTABLE_METADATA_BYTES:
        raise ValueError("portable execution metadata exceeds the size limit")

    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(
                    f"portable execution metadata has duplicate key: {key}"
                )
            result[key] = value
        return result

    try:
        raw = json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("portable execution metadata is not valid UTF-8 JSON") from exc
    if not isinstance(raw, dict):
        raise ValueError("portable execution metadata must be a JSON object")
    if data != canonical_json_bytes(raw):
        raise ValueError("portable execution metadata is not canonical UTF-8/LF JSON")
    return raw


def portable_path_label(path: Path) -> str:
    resolved = path.resolve()
    repository_root = RESEARCH_ROOT.parents[1]
    try:
        return resolved.relative_to(repository_root).as_posix()
    except ValueError:
        return "<external>"


def parse_lock(path: Path) -> dict[str, str]:
    """Parse exact package pins and reject local-path or ranged entries."""

    pins: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("--"):
            continue
        if "==" not in line:
            raise ValueError(f"lock line {line_number} is not an exact pin: {line!r}")
        name, version = line.split("==", 1)
        if not PACKAGE_NAME.fullmatch(name) or not version or "@" in version:
            raise ValueError(f"lock line {line_number} is not portable: {line!r}")
        key = name.lower().replace("_", "-").replace(".", "-")
        if key in pins:
            raise ValueError(f"duplicate package pin at line {line_number}: {name}")
        pins[key] = version
    if not pins:
        raise ValueError("dependency lock contains no exact package pins")
    return pins


def parse_portable_execution_metadata(path: Path) -> dict[str, object]:
    """Load the exact path-free projection of the formal execution metadata."""

    raw = strict_json_object(path.read_bytes())
    if set(raw) != PORTABLE_METADATA_KEYS:
        raise ValueError("portable execution metadata keys do not match schema v1")
    if (
        type(raw.get("schema_version")) is not int
        or type(raw.get("cudnn_version")) is not int
        or not isinstance(raw.get("source_execution_metadata_sha256"), str)
        or SHA256.fullmatch(str(raw["source_execution_metadata_sha256"])) is None
        or raw != EXPECTED_PORTABLE_METADATA
    ):
        raise ValueError(
            "portable execution metadata values do not match the frozen formal projection"
        )
    return raw


def verify_packages(
    pins: Mapping[str, str],
    version_lookup: Callable[[str], str] = importlib.metadata.version,
) -> tuple[dict[str, str | None], list[str]]:
    observed: dict[str, str | None] = {}
    errors: list[str] = []
    for name, expected in sorted(pins.items()):
        try:
            actual = version_lookup(name)
        except importlib.metadata.PackageNotFoundError:
            actual = None
        observed[name] = actual
        if actual != expected:
            errors.append(f"{name}: expected {expected}, observed {actual}")
    return observed, errors


def collect_torch_facts() -> dict[str, object]:
    import torch

    cuda_available = bool(torch.cuda.is_available())
    return {
        "torch_version": torch.__version__,
        "cuda_runtime_version": torch.version.cuda,
        "cudnn_version": torch.backends.cudnn.version(),
        "cuda_available": cuda_available,
        "device_name": torch.cuda.get_device_name(0) if cuda_available else None,
    }


def build_report(
    lock_path: Path,
    metadata_path: Path,
    output_path: Path | None = None,
) -> dict[str, object]:
    pins = parse_lock(lock_path)
    metadata = parse_portable_execution_metadata(metadata_path)
    installed, package_errors = verify_packages(pins)
    torch_facts = collect_torch_facts()
    python_version = platform.python_version()

    errors = list(package_errors)
    expected_python = str(metadata["python"])
    expected_torch = str(metadata["torch_version"])
    expected_cuda = str(metadata["cuda_runtime_version"])
    expected_cudnn = int(metadata["cudnn_version"])
    if python_version != expected_python:
        errors.append(f"python: expected {expected_python}, observed {python_version}")
    if torch_facts["torch_version"] != expected_torch:
        errors.append(
            f"torch runtime: expected {expected_torch}, observed {torch_facts['torch_version']}"
        )
    if torch_facts["cuda_runtime_version"] != expected_cuda:
        errors.append(
            "CUDA runtime: expected "
            f"{expected_cuda}, observed {torch_facts['cuda_runtime_version']}"
        )
    if torch_facts["cudnn_version"] != expected_cudnn:
        errors.append(
            f"cuDNN: expected {expected_cudnn}, observed {torch_facts['cudnn_version']}"
        )

    return {
        "schema_name": "lifeline-d14-d16-environment-verification",
        "schema_version": 1,
        "ok": not errors,
        "errors": errors,
        "verifier": {
            "path": portable_path_label(Path(__file__)),
            "sha256": sha256_file(Path(__file__)),
            "semantic_command": [
                "python",
                "-B",
                portable_path_label(Path(__file__)),
                "--lock",
                portable_path_label(lock_path),
                "--metadata",
                portable_path_label(metadata_path),
                *(
                    ["--output", portable_path_label(output_path)]
                    if output_path is not None
                    else []
                ),
            ],
        },
        "lock": {
            "path": portable_path_label(lock_path),
            "sha256": sha256_file(lock_path),
            "package_count": len(pins),
        },
        "formal_execution_metadata": {
            "path": portable_path_label(metadata_path),
            "sha256": sha256_file(metadata_path),
            "source_execution_metadata_sha256": metadata[
                "source_execution_metadata_sha256"
            ],
            "expected_python": expected_python,
            "expected_torch": expected_torch,
            "expected_cuda_runtime": expected_cuda,
            "expected_cudnn": expected_cudnn,
            "original_device_name": metadata.get("device_name"),
        },
        "observed": {
            "python": python_version,
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "packages": installed,
            **torch_facts,
        },
        "hardware_note": (
            "Hardware identity is diagnostic only. Reproducing the original formal "
            "training receipt additionally requires the frozen runner/protocol hashes "
            "and compatible NVIDIA hardware."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    output_path = args.output.resolve() if args.output is not None else None
    report = build_report(
        args.lock.resolve(),
        args.metadata.resolve(),
        output_path=output_path,
    )
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
    sys.stdout.write(rendered)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
