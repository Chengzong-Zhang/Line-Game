"""Fail-closed offline preflight for a D14--D16 dependency wheelhouse.

This command never creates an environment, installs a package, accesses the
network, imports Torch, or runs a game.  With no ``--output`` it is fully
read-only.  An explicitly requested receipt contains only repository-relative
or redacted input paths and is rendered as deterministic LF JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Mapping

try:
    from scripts.verify_d14_d16_environment import parse_lock, sha256_file
except ModuleNotFoundError:  # Direct execution from research/iclr2027/scripts.
    from verify_d14_d16_environment import parse_lock, sha256_file


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = RESEARCH_ROOT.parents[1]
DEFAULT_LOCK = RESEARCH_ROOT / "requirements-d14-d16-win-cu118.lock.txt"
MANIFEST_SCHEMA_NAME = "lifeline-d14-d16-wheelhouse-manifest"
RECEIPT_SCHEMA_NAME = "lifeline-d14-d16-fresh-install-preflight"
SCHEMA_VERSION = 1
EXPECTED_TARGET = {
    "python_version": "3.10.20",
    "implementation": "CPython",
    "platform_tag": "win_amd64",
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def canonical_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def normalized_wheel_component(value: str) -> str:
    return re.sub(r"[-_.]+", "_", value).lower()


def portable_path(path: Path, external_label: str) -> str:
    """Return a repository-relative path or a stable redaction label."""

    resolved = path.resolve(strict=False)
    try:
        return resolved.relative_to(REPOSITORY_ROOT).as_posix()
    except ValueError:
        return f"<external-{external_label}>"


def parse_wheel_filename(
    filename: str,
    package: str,
    version: str,
) -> dict[str, object]:
    """Parse and bind the wheel filename to its declared exact package pin."""

    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("artifact filename must be a basename")
    if not filename.lower().endswith(".whl"):
        raise ValueError("artifact is not a wheel")

    stem = filename[:-4]
    try:
        distribution_version, python_tag, abi_tag, platform_tag = stem.rsplit("-", 3)
        distribution, filename_version, *build_parts = distribution_version.split("-")
    except ValueError as exc:
        raise ValueError("wheel filename does not have PEP 427 fields") from exc

    if not distribution or not filename_version or len(build_parts) > 1:
        raise ValueError(
            "wheel filename has an invalid distribution/version/build prefix"
        )
    if normalized_wheel_component(distribution) != normalized_wheel_component(package):
        raise ValueError("wheel distribution does not match manifest package")
    if normalized_wheel_component(filename_version) != normalized_wheel_component(
        version
    ):
        raise ValueError("wheel version does not match exact lock pin")

    python_tags = python_tag.split(".")
    abi_tags = abi_tag.split(".")
    platform_tags = platform_tag.split(".")
    if not all(python_tags) or not all(abi_tags) or not all(platform_tags):
        raise ValueError("wheel filename contains an empty compatibility tag")

    compatible = wheel_tags_compatible(python_tags, abi_tags, platform_tags)
    return {
        "python_tags": python_tags,
        "abi_tags": abi_tags,
        "platform_tags": platform_tags,
        "build_tag": build_parts[0] if build_parts else None,
        "compatible_with_target": compatible,
    }


def wheel_tags_compatible(
    python_tags: list[str],
    abi_tags: list[str],
    platform_tags: list[str],
) -> bool:
    """Conservatively check CPython 3.10 / Windows x86-64 wheel tags."""

    platform_ok = any(tag in {"any", "win_amd64"} for tag in platform_tags)
    if not platform_ok:
        return False

    for python_tag in python_tags:
        for abi_tag in abi_tags:
            if python_tag in {"py3", "py310"} and abi_tag == "none":
                return True
            if python_tag == "cp310" and abi_tag in {"cp310", "abi3", "none"}:
                return True
            match = re.fullmatch(r"cp3(\d+)", python_tag)
            if match and abi_tag == "abi3" and int(match.group(1)) <= 10:
                return True
    return False


def _base_report(
    lock_path: Path, wheelhouse: Path, manifest_path: Path
) -> dict[str, object]:
    implementation_path = Path(__file__).resolve()
    return {
        "schema_name": RECEIPT_SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "status": "BLOCKED",
        "ok": False,
        "blockers": [],
        "implementation": {
            "path": portable_path(implementation_path, "preflight-implementation"),
            "sha256": sha256_file(implementation_path),
        },
        "inputs": {
            "lock": {
                "path": portable_path(lock_path, "lock"),
                "sha256": None,
                "package_count": None,
            },
            "manifest": {
                "path": portable_path(manifest_path, "manifest"),
                "sha256": None,
            },
            "wheelhouse": {
                "path": portable_path(wheelhouse, "wheelhouse"),
                "discovered_wheel_count": None,
            },
        },
        "target": dict(EXPECTED_TARGET),
        "artifacts": [],
        "scope_boundary": {
            "preflight_only": True,
            "environment_created": False,
            "packages_installed": False,
            "network_accessed": False,
            "tests_or_games_run": False,
            "retraining_reproduced": False,
            "later_extension_formal_readiness_established": False,
            "statement": (
                "PASS means only that the declared offline wheels are complete, "
                "hash-matched, and tag-compatible with the retained D14--D16 target. "
                "It is not a clean-install execution receipt, a retraining result, "
                "or evidence that any later extension is formal-ready."
            ),
        },
    }


def _add_blocker(blockers: list[str], message: str) -> None:
    if message not in blockers:
        blockers.append(message)


def _read_manifest(
    manifest_path: Path, blockers: list[str]
) -> Mapping[str, object] | None:
    if not manifest_path.is_file():
        _add_blocker(blockers, "manifest: file is missing or not regular")
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _add_blocker(blockers, "manifest: not valid UTF-8 JSON")
        return None
    if not isinstance(payload, dict):
        _add_blocker(blockers, "manifest: top level must be an object")
        return None
    return payload


def _has_exact_keys(value: Mapping[str, object], expected: set[str]) -> bool:
    return set(value) == expected


def build_report(
    lock_path: Path, wheelhouse: Path, manifest_path: Path
) -> dict[str, object]:
    """Inspect immutable inputs and return a deterministic PASS/BLOCKED report."""

    report = _base_report(lock_path, wheelhouse, manifest_path)
    blockers = report["blockers"]
    assert isinstance(blockers, list)
    inputs = report["inputs"]
    assert isinstance(inputs, dict)

    pins: dict[str, str] | None = None
    if not lock_path.is_file():
        _add_blocker(blockers, "lock: file is missing or not regular")
    else:
        try:
            inputs["lock"]["sha256"] = sha256_file(lock_path)
            pins = parse_lock(lock_path)
        except OSError:
            _add_blocker(blockers, "lock: file could not be read or hashed")
        except (UnicodeError, ValueError) as exc:
            _add_blocker(blockers, f"lock: {exc}")
        if pins is not None:
            inputs["lock"]["package_count"] = len(pins)

    manifest = _read_manifest(manifest_path, blockers)
    if manifest_path.is_file():
        try:
            inputs["manifest"]["sha256"] = sha256_file(manifest_path)
        except OSError:
            _add_blocker(blockers, "manifest: file could not be hashed")

    discovered_names: list[str] | None = None
    if not wheelhouse.is_dir():
        _add_blocker(blockers, "wheelhouse: directory is missing or not a directory")
    else:
        try:
            discovered_names = sorted(
                entry.name
                for entry in wheelhouse.iterdir()
                if entry.is_file() and entry.suffix.lower() == ".whl"
            )
            inputs["wheelhouse"]["discovered_wheel_count"] = len(discovered_names)
        except OSError:
            _add_blocker(blockers, "wheelhouse: directory could not be enumerated")

    if manifest is None or pins is None:
        report["blockers"] = sorted(blockers)
        return report

    if manifest.get("schema_name") != MANIFEST_SCHEMA_NAME:
        _add_blocker(blockers, f"manifest: schema_name must be {MANIFEST_SCHEMA_NAME}")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        _add_blocker(blockers, f"manifest: schema_version must be {SCHEMA_VERSION}")
    if manifest.get("lock_sha256") != inputs["lock"]["sha256"]:
        _add_blocker(
            blockers,
            "manifest: lock_sha256 is missing or does not match the exact lock",
        )
    if manifest.get("target") != EXPECTED_TARGET:
        _add_blocker(
            blockers, "manifest: target must exactly match the retained D14--D16 target"
        )
    if not _has_exact_keys(
        manifest,
        {"schema_name", "schema_version", "lock_sha256", "target", "artifacts"},
    ):
        _add_blocker(blockers, "manifest: keys do not match the required schema")

    declared_artifacts = manifest.get("artifacts")
    if not isinstance(declared_artifacts, list):
        _add_blocker(blockers, "manifest: artifacts must be a list")
        declared_artifacts = []

    artifact_reports: list[dict[str, object]] = []
    declared_filenames: list[str] = []
    package_counts: dict[str, int] = {}
    filename_counts: dict[str, int] = {}
    for index, artifact in enumerate(declared_artifacts):
        prefix = f"manifest artifact {index}"
        if not isinstance(artifact, dict):
            _add_blocker(blockers, f"{prefix}: entry must be an object")
            continue
        if not _has_exact_keys(
            artifact,
            {"package", "version", "filename", "size_bytes", "sha256"},
        ):
            _add_blocker(blockers, f"{prefix}: keys do not match the required schema")
        package_value = artifact.get("package")
        version = artifact.get("version")
        filename = artifact.get("filename")
        expected_size = artifact.get("size_bytes")
        expected_sha256 = artifact.get("sha256")
        if not isinstance(package_value, str) or not package_value:
            _add_blocker(blockers, f"{prefix}: package is missing or invalid")
            continue
        if not PACKAGE_NAME_PATTERN.fullmatch(package_value):
            _add_blocker(
                blockers, f"{prefix}: package is not a portable distribution name"
            )
            continue
        package = canonical_package_name(package_value)
        package_counts[package] = package_counts.get(package, 0) + 1
        if not isinstance(version, str) or not version:
            _add_blocker(blockers, f"{prefix}: version is missing or invalid")
            continue
        if not isinstance(filename, str) or not filename:
            _add_blocker(blockers, f"{prefix}: filename is missing or invalid")
            continue
        filename_is_basename = (
            Path(filename).name == filename
            and "/" not in filename
            and "\\" not in filename
        )
        safe_filename = filename if filename_is_basename else "<invalid-filename>"
        filename_key = (
            filename.lower() if filename_is_basename else "<invalid-filename>"
        )
        filename_counts[filename_key] = filename_counts.get(filename_key, 0) + 1
        if filename_is_basename:
            declared_filenames.append(filename)

        expected_version = pins.get(package)

        item: dict[str, object] = {
            "package": package,
            "version": version if version == expected_version else "<mismatch>",
            "filename": safe_filename,
            "size_bytes": expected_size if isinstance(expected_size, int) else None,
            "sha256": expected_sha256 if isinstance(expected_sha256, str) else None,
            "observed_size_bytes": None,
            "observed_sha256": None,
            "python_tags": None,
            "abi_tags": None,
            "platform_tags": None,
            "build_tag": None,
            "compatible_with_target": False,
            "verified": False,
        }

        if expected_version is None:
            _add_blocker(
                blockers, f"{prefix}: package {package!r} is not in the exact lock"
            )
        elif version != expected_version:
            _add_blocker(
                blockers, f"{prefix}: version does not match exact pin for {package}"
            )

        filename_valid = True
        try:
            wheel_facts = parse_wheel_filename(filename, package, version)
            item.update(wheel_facts)
            if not wheel_facts["compatible_with_target"]:
                _add_blocker(
                    blockers, f"{prefix}: wheel tags are incompatible with the target"
                )
        except ValueError as exc:
            filename_valid = False
            _add_blocker(blockers, f"{prefix}: {exc}")

        metadata_valid = True
        if (
            isinstance(expected_size, bool)
            or not isinstance(expected_size, int)
            or expected_size < 0
        ):
            metadata_valid = False
            _add_blocker(blockers, f"{prefix}: size_bytes is missing or invalid")
        if not isinstance(expected_sha256, str) or not SHA256_PATTERN.fullmatch(
            expected_sha256
        ):
            metadata_valid = False
            _add_blocker(blockers, f"{prefix}: sha256 is missing or not lowercase hex")

        artifact_path = wheelhouse / filename if filename_is_basename else wheelhouse
        file_valid = True
        try:
            if not filename_is_basename:
                file_valid = False
            elif artifact_path.is_symlink():
                file_valid = False
                _add_blocker(blockers, f"{prefix}: wheel must not be a symlink")
            elif not artifact_path.is_file():
                file_valid = False
                _add_blocker(blockers, f"{prefix}: declared wheel is missing")
            else:
                actual_size = artifact_path.stat().st_size
                actual_sha256 = sha256_file(artifact_path)
                item["observed_size_bytes"] = actual_size
                item["observed_sha256"] = actual_sha256
                if metadata_valid:
                    if actual_size != expected_size:
                        file_valid = False
                        _add_blocker(blockers, f"{prefix}: size_bytes mismatch")
                    if actual_sha256 != expected_sha256:
                        file_valid = False
                        _add_blocker(blockers, f"{prefix}: sha256 mismatch")
        except OSError:
            file_valid = False
            _add_blocker(blockers, f"{prefix}: wheel could not be inspected")

        item["verified"] = bool(
            expected_version == version
            and filename_valid
            and item["compatible_with_target"]
            and metadata_valid
            and file_valid
        )
        artifact_reports.append(item)

    for package in sorted(pins):
        count = package_counts.get(package, 0)
        if count == 0:
            _add_blocker(
                blockers, f"manifest: exact pin {package} has no declared wheel"
            )
        elif count > 1:
            _add_blocker(
                blockers, f"manifest: exact pin {package} has {count} declared wheels"
            )
    for package, count in sorted(package_counts.items()):
        if count > 1 and package not in pins:
            _add_blocker(
                blockers, f"manifest: package {package} has {count} declared wheels"
            )
    for filename_key, count in sorted(filename_counts.items()):
        if count > 1:
            _add_blocker(
                blockers, f"manifest: wheel filename {filename_key!r} is duplicated"
            )

    if discovered_names is not None:
        discovered_keys = {name.lower() for name in discovered_names}
        declared_keys = {name.lower() for name in declared_filenames}
        for name in sorted(discovered_keys - declared_keys):
            _add_blocker(blockers, f"wheelhouse: undeclared wheel {name!r}")
        for name in sorted(declared_keys - discovered_keys):
            _add_blocker(
                blockers, f"wheelhouse: declared wheel {name!r} was not discovered"
            )

    report["artifacts"] = sorted(
        artifact_reports,
        key=lambda item: (str(item["package"]), str(item["filename"]).lower()),
    )
    report["blockers"] = sorted(blockers)
    if not blockers:
        report["status"] = "PASS"
        report["ok"] = True
    return report


def render_report(report: Mapping[str, object]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def _output_overlaps_input(
    output: Path,
    lock_path: Path,
    wheelhouse: Path,
    manifest_path: Path,
) -> bool:
    resolved_output = output.resolve(strict=False)
    if resolved_output in {
        lock_path.resolve(strict=False),
        manifest_path.resolve(strict=False),
    }:
        return True
    resolved_wheelhouse = wheelhouse.resolve(strict=False)
    try:
        resolved_output.relative_to(resolved_wheelhouse)
    except ValueError:
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    lock_path = args.lock.resolve(strict=False)
    wheelhouse = args.wheelhouse.resolve(strict=False)
    manifest_path = args.manifest.resolve(strict=False)
    if args.output is not None and _output_overlaps_input(
        args.output, lock_path, wheelhouse, manifest_path
    ):
        parser.error("--output must not overwrite or be placed inside an input")
    if args.output is not None and (args.output.exists() or args.output.is_symlink()):
        parser.error("--output must not already exist")

    report = build_report(lock_path, wheelhouse, manifest_path)
    rendered = render_report(report)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
    sys.stdout.write(rendered)
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
