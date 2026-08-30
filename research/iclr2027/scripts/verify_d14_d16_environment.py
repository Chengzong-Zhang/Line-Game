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
    / "formal"
    / "d14_d16"
    / "run_v1"
    / "execution_metadata.json"
)
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_lock(path: Path) -> dict[str, str]:
    """Parse exact package pins and reject local-path or ranged entries."""

    pins: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
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


def build_report(lock_path: Path, metadata_path: Path) -> dict[str, object]:
    pins = parse_lock(lock_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
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
        "lock": {
            "path": lock_path.as_posix(),
            "sha256": sha256_file(lock_path),
            "package_count": len(pins),
        },
        "formal_execution_metadata": {
            "path": metadata_path.as_posix(),
            "sha256": sha256_file(metadata_path),
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

    report = build_report(args.lock.resolve(), args.metadata.resolve())
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
    sys.stdout.write(rendered)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
