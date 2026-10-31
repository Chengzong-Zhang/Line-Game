#!/usr/bin/env python3
"""Independently verify an L26 Android debug APK.

The verifier has no default APK path: callers must name the newly built package
and a fresh output directory.  Web resources are taken from the current mobile
Web build receipt, so an older APK cannot pass by reusing an historical hash.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import zipfile


MINIMUM_WEB_RESOURCE_COUNT = 267
L26_IDENTITY = {"applicationId": "cn.lifelinegame.mobile", "versionCode": "1", "versionName": "1.0"}
EXPECTED_MIN_SDK = "24"
EXPECTED_TARGET_SDK = "36"
EXPECTED_COMPILE_SDK = "36"
CAPACITOR_EXTRAS = {"cordova.js", "cordova_plugins.js"}
WARMUP_PATH = "MultiplayerAIWarmup.js"
ADMISSION_PATH = "MultiplayerUltimateAdmission.js"
NATIVE_GEOMETRY_PATH = "MultiplayerNativeGeometry.js"
OUTPUT_NAME = "android-apk-verification.json"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_member_sha256(archive: zipfile.ZipFile, name: str) -> str:
    digest = hashlib.sha256()
    with archive.open(name) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def safe_archive_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    return bool(normalized) and not normalized.startswith("/") and ".." not in parts


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def receipt_resources(receipt: dict) -> tuple[list[dict[str, str]], dict[str, str], str]:
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1", "Unexpected Web build receipt schema")
    require(receipt.get("status") == "PASS-CURRENT", "Web build receipt is not PASS-CURRENT")
    rows = receipt.get("dist_files")
    require(isinstance(rows, list), "Web build receipt has no dist_files list")
    require(receipt.get("dist_file_count") == len(rows), "Web build receipt resource count is inconsistent")
    require(len(rows) >= MINIMUM_WEB_RESOURCE_COUNT,
            f"At least {MINIMUM_WEB_RESOURCE_COUNT} Web resources are required, receipt has {len(rows)}")
    normalized: list[dict[str, str]] = []
    expected: dict[str, str] = {}
    for row in rows:
        require(isinstance(row, dict), "Invalid Web resource row")
        name, digest = row.get("path"), row.get("sha256")
        require(isinstance(name, str) and safe_archive_name(name), f"Unsafe Web resource path: {name!r}")
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest) is not None,
                f"Invalid Web resource digest: {name}")
        require(name not in expected, f"Duplicate Web resource in receipt: {name}")
        expected[name] = digest
        normalized.append({"path": name, "sha256": digest})
    canonical = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    manifest_digest = sha256_bytes(canonical)
    require(receipt.get("dist_manifest_sha256") == manifest_digest,
            "Web build receipt dist manifest digest is inconsistent")
    require(WARMUP_PATH in expected, f"Receipt does not include {WARMUP_PATH}")
    require(ADMISSION_PATH in expected, f"Receipt does not include {ADMISSION_PATH}")
    require(NATIVE_GEOMETRY_PATH in expected, f"Receipt does not include {NATIVE_GEOMETRY_PATH}")
    return normalized, expected, manifest_digest


def version_key(path: Path) -> tuple[int, ...]:
    values = [int(value) for value in re.findall(r"\d+", path.name)]
    return tuple(values) if values else (0,)


def resolve_build_tools(root: Path, explicit_sdk: str | None) -> Path:
    candidates: list[Path] = []
    if explicit_sdk:
        candidates.append(Path(explicit_sdk).expanduser().resolve())
    for key in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        if os.environ.get(key):
            candidates.append(Path(os.environ[key]).expanduser().resolve())
    candidates.append(root / "mobile/local_artifacts/android-sdk")
    for sdk in candidates:
        build_tools = sdk / "build-tools"
        if build_tools.is_dir():
            versions = sorted((item for item in build_tools.iterdir() if item.is_dir()), key=version_key, reverse=True)
            for version in versions:
                if (version / ("aapt.exe" if os.name == "nt" else "aapt")).is_file():
                    return version
    raise FileNotFoundError("Could not locate Android SDK build-tools; pass --android-sdk")


def resolve_file(explicit: str | None, fallback: Path, label: str) -> Path:
    path = Path(explicit).expanduser().resolve() if explicit else fallback
    require(path.is_file(), f"{label} not found: {path}")
    return path


def resolve_java(root: Path, explicit: str | None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java"))
    candidates.extend(sorted((root / "mobile/local_artifacts/native-build-20261022-parent01/temurin21").glob(
        "*/bin/java.exe" if os.name == "nt" else "*/bin/java")))
    discovered = shutil.which("java")
    if discovered:
        candidates.append(Path(discovered))
    for path in candidates:
        if path.is_file():
            return path.resolve()
    raise FileNotFoundError("Could not locate Java; pass --java")


def run_tool(command: list[str], label: str) -> dict:
    completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
    stdout = completed.stdout.decode("utf-8", errors="replace")
    stderr = completed.stderr.decode("utf-8", errors="replace")
    require(completed.returncode == 0,
            f"{label} failed with exit {completed.returncode}: {(stderr or stdout).strip()[:500]}")
    return {
        "exitCode": completed.returncode,
        "stdoutSha256": sha256_bytes(completed.stdout),
        "stderrSha256": sha256_bytes(completed.stderr),
        "stdout": stdout,
        "stderr": stderr,
    }


def parse_badging(text: str, identity: dict[str, str]) -> dict[str, str | bool]:
    lines = text.splitlines()
    package_line = next((line for line in lines if line.startswith("package:")), None)
    require(package_line is not None, "aapt badging omitted the package line")
    attributes = dict(re.findall(r"([A-Za-z][A-Za-z0-9]*)='([^']*)'", package_line))
    sdk_match = next((re.fullmatch(r"sdkVersion:'([^']+)'", line) for line in lines if line.startswith("sdkVersion:")), None)
    target_match = next((re.fullmatch(r"targetSdkVersion:'([^']+)'", line)
                         for line in lines if line.startswith("targetSdkVersion:")), None)
    label_match = next((re.fullmatch(r"application-label:'([^']*)'", line)
                        for line in lines if line.startswith("application-label:")), None)
    require(sdk_match is not None and target_match is not None, "aapt badging omitted SDK versions")
    result: dict[str, str | bool] = {
        "applicationId": attributes.get("name", ""),
        "versionCode": attributes.get("versionCode", ""),
        "versionName": attributes.get("versionName", ""),
        "compileSdk": attributes.get("compileSdkVersion", ""),
        "minSdk": sdk_match.group(1),
        "targetSdk": target_match.group(1),
        "label": label_match.group(1) if label_match else "",
        "debuggable": "application-debuggable" in lines,
    }
    require(result["applicationId"] == identity["applicationId"], "Unexpected Android application ID")
    require(result["versionCode"] == identity["versionCode"], "Unexpected Android versionCode")
    require(result["versionName"] == identity["versionName"], "Unexpected Android versionName")
    require(result["compileSdk"] == EXPECTED_COMPILE_SDK, "Unexpected Android compile SDK")
    require(result["minSdk"] == EXPECTED_MIN_SDK, "Unexpected Android min SDK")
    require(result["targetSdk"] == EXPECTED_TARGET_SDK, "Unexpected Android target SDK")
    require(result["debuggable"] is True, "Android package is not debuggable")
    return result


def parse_signer(text: str) -> dict[str, str | int | bool]:
    lines = text.splitlines()
    dn = next((line.removeprefix("Signer #1 certificate DN: ")
               for line in lines if line.startswith("Signer #1 certificate DN: ")), None)
    certificate = next((line.removeprefix("Signer #1 certificate SHA-256 digest: ")
                        for line in lines if line.startswith("Signer #1 certificate SHA-256 digest: ")), None)
    signers = next((line.removeprefix("Number of signers: ")
                    for line in lines if line.startswith("Number of signers: ")), None)
    require("Verified using v2 scheme (APK Signature Scheme v2): true" in text,
            "APK Signature Scheme v2 verification did not pass")
    require(dn is not None and "CN=Android Debug" in dn, "APK is not signed by an Android Debug certificate")
    require(certificate is not None and re.fullmatch(r"[0-9a-f]{64}", certificate) is not None,
            "apksigner omitted certificate SHA-256")
    require(signers == "1", "Expected exactly one APK signer")
    return {
        "verified": True,
        "v2": True,
        "signerCount": 1,
        "certificateDn": dn,
        "certificateSha256": certificate,
    }


def git_head(root: Path) -> str | None:
    completed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, check=False)
    return completed.stdout.decode("ascii", errors="replace").strip() if completed.returncode == 0 else None


def verify(args: argparse.Namespace, root: Path) -> dict:
    identity_source = "L26_FIXED"
    identity = L26_IDENTITY
    identity_config = None
    if args.identity_config:
        identity_config = Path(args.identity_config).expanduser().resolve()
        identity_data = json.loads(identity_config.read_text(encoding="utf-8"))
        identity = {
            "applicationId": identity_data["android"]["applicationId"],
            "versionCode": str(identity_data["android"]["versionCode"]),
            "versionName": identity_data["android"]["versionName"],
        }
        identity_source = "EXPLICIT_CANDIDATE_CONFIG"
    apk = Path(args.apk).expanduser().resolve()
    receipt_path = Path(args.receipt).expanduser().resolve()
    require(apk.is_file() and apk.suffix.lower() == ".apk", f"APK not found: {apk}")
    require(receipt_path.is_file(), f"Web build receipt not found: {receipt_path}")
    require(apk.stat().st_mtime_ns >= receipt_path.stat().st_mtime_ns,
            "APK predates the current Web build receipt; rebuild the native package")

    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes.decode("utf-8"))
    _, expected, manifest_digest = receipt_resources(receipt)
    apk_digest = sha256_file(apk)

    build_tools = resolve_build_tools(root, args.android_sdk)
    aapt = resolve_file(args.aapt, build_tools / ("aapt.exe" if os.name == "nt" else "aapt"), "aapt")
    zipalign = resolve_file(args.zipalign, build_tools / ("zipalign.exe" if os.name == "nt" else "zipalign"), "zipalign")
    signer_jar = resolve_file(args.apksigner_jar, build_tools / "lib/apksigner.jar", "apksigner.jar")
    java = resolve_java(root, args.java)

    badging_tool = run_tool([str(aapt), "dump", "badging", str(apk)], "aapt dump badging")
    package = parse_badging(str(badging_tool["stdout"]), identity)
    signer_tool = run_tool([str(java), "-jar", str(signer_jar), "verify", "--verbose", "--print-certs", str(apk)],
                           "apksigner verify")
    signing = parse_signer(str(signer_tool["stdout"]))
    alignment_tool = run_tool([str(zipalign), "-c", "-P", "16", "-v", "4", str(apk)], "zipalign check")

    with zipfile.ZipFile(apk, "r", metadata_encoding="utf-8") as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "APK contains duplicate ZIP entries")
        require(all(safe_archive_name(name) for name in names), "APK contains an unsafe ZIP path")
        require(archive.testzip() is None, "APK ZIP CRC verification failed")
        prefix = "assets/public/"
        public = {name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith("/")}
        require(public == set(expected) | CAPACITOR_EXTRAS,
                f"APK public assets differ from receipt: missing={sorted(set(expected) - public)!r}, "
                f"extra={sorted(public - (set(expected) | CAPACITOR_EXTRAS))!r}")
        for name, digest in expected.items():
            member = prefix + name
            require(archive_member_sha256(archive, member) == digest, f"APK resource hash mismatch: {name}")
        for name in CAPACITOR_EXTRAS:
            require(archive.getinfo(prefix + name).file_size == 0, f"Capacitor extra is not zero bytes: {name}")
        dex_files = sorted(name for name in names if re.fullmatch(r"classes(?:\d+)?\.dex", name))
        require(dex_files, "APK contains no DEX bytecode")
        for name in dex_files:
            info = archive.getinfo(name)
            require(info.file_size > 8, f"DEX entry is empty: {name}")
            with archive.open(name) as stream:
                require(stream.read(4) == b"dex\n", f"DEX header is invalid: {name}")
        resource_bytes = sum(archive.getinfo(prefix + name).file_size for name in expected)
        warmup_digest = archive_member_sha256(archive, prefix + WARMUP_PATH)
        admission_digest = archive_member_sha256(archive, prefix + ADMISSION_PATH)
        native_geometry_digest = archive_member_sha256(archive, prefix + NATIVE_GEOMETRY_PATH)
        entry_count = len(names)

    require(warmup_digest == expected[WARMUP_PATH], f"{WARMUP_PATH} hash mismatch")
    require(admission_digest == expected[ADMISSION_PATH], f"{ADMISSION_PATH} hash mismatch")
    require(native_geometry_digest == expected[NATIVE_GEOMETRY_PATH],
            f"{NATIVE_GEOMETRY_PATH} hash mismatch")
    require(receipt_path.read_bytes() == receipt_bytes, "Web build receipt changed during verification")
    require(sha256_file(apk) == apk_digest, "APK changed during verification")
    return {
        "schema": "lifeline-l26-android-apk-verification-v1",
        "status": "PASS_ANDROID_DEBUG_APK_L26",
        "verifiedAt": utc_now(),
        "verificationHead": git_head(root),
        "scope": "Static package, signature, identity, API, DEX, ZIP and receipt-bound Web-resource verification; no device runtime or store acceptance.",
        "identitySource": {"type": identity_source, "configPath": str(identity_config) if identity_config else None,
                           "identity": identity},
        "apk": {"path": display_path(apk, root), "bytes": apk.stat().st_size, "sha256": apk_digest},
        "webBuildReceipt": {
            "path": display_path(receipt_path, root),
            "sha256": sha256_bytes(receipt_bytes),
            "distManifestSha256": manifest_digest,
            "resourceCount": len(expected),
            "resourceBytes": resource_bytes,
            "runtimeAssetVersion": receipt.get("runtime_asset_version"),
        },
        "package": package,
        "signing": signing,
        "zip": {
            "integrity": True,
            "alignment": True,
            "entryCount": entry_count,
            "dexFiles": dex_files,
            "publicExtras": sorted(CAPACITOR_EXTRAS),
            "publicExtrasZeroBytes": True,
        },
        "multiplayerAIWarmupSha256": warmup_digest,
        "multiplayerUltimateAdmissionSha256": admission_digest,
        "multiplayerNativeGeometrySha256": native_geometry_digest,
        "tools": {
            "aapt": display_path(aapt, root),
            "aaptOutputSha256": badging_tool["stdoutSha256"],
            "apksignerJar": display_path(signer_jar, root),
            "apksignerOutputSha256": signer_tool["stdoutSha256"],
            "zipalign": display_path(zipalign, root),
            "zipalignOutputSha256": alignment_tool["stdoutSha256"],
            "java": display_path(java, root),
        },
        "deviceAcceptance": False,
        "storeAcceptance": False,
    }


def parse_args(root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, help="Explicit path to the newly built L26 debug APK")
    parser.add_argument("--run-dir", required=True, help="Fresh directory that will receive the JSON result")
    parser.add_argument("--receipt", required=True, help="Explicit resource build receipt to bind this verification")
    parser.add_argument("--identity-config", help="Explicit candidate identity JSON; omitted means fixed L26 identity")
    parser.add_argument("--android-sdk")
    parser.add_argument("--aapt")
    parser.add_argument("--zipalign")
    parser.add_argument("--apksigner-jar")
    parser.add_argument("--java")
    return parser.parse_args()


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    args = parse_args(root)
    run_dir = Path(args.run_dir).expanduser().resolve()
    try:
        run_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        print(f"Refusing to overwrite existing verification directory: {run_dir}", file=sys.stderr)
        return 2
    output = run_dir / OUTPUT_NAME
    try:
        result = verify(args, root)
        exit_code = 0
    except Exception as error:  # Preserve a compact failure receipt in the caller-selected fresh directory.
        result = {
            "schema": "lifeline-l26-android-apk-verification-v1",
            "status": "FAIL",
            "verifiedAt": utc_now(),
            "apk": str(Path(args.apk).expanduser()),
            "receipt": str(Path(args.receipt).expanduser()),
            "error": {"type": type(error).__name__, "message": str(error)},
        }
        exit_code = 1
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "output": str(output)}, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
