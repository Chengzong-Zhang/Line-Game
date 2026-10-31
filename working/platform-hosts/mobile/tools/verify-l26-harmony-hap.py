#!/usr/bin/env python3
"""Independently verify an L26 unsigned HarmonyOS HAP.

The caller must supply the newly built HAP, its successful build log and a
fresh output directory.  The official HAP signing verifier is used to confirm
that no HAP signing block is present; Web resources are bound to the current
mobile Web build receipt rather than an historical package receipt.
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
import tempfile
import zipfile


MINIMUM_WEB_RESOURCE_COUNT = 267
L26_IDENTITY = {"bundleName": "cn.lifelinegame.mobile.harmony", "versionCode": 1, "versionName": "1.0.0"}
EXPECTED_COMPILE_SDK_TYPE = "HarmonyOS"
EXPECTED_COMPILE_SDK_VERSION = "5.0.0.71"
EXPECTED_ENCODED_API = 50000012
EXPECTED_API = 12
WARMUP_PATH = "MultiplayerAIWarmup.js"
ADMISSION_PATH = "MultiplayerUltimateAdmission.js"
NATIVE_GEOMETRY_PATH = "MultiplayerNativeGeometry.js"
OUTPUT_NAME = "harmony-hap-verification.json"


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


def resolve_sign_tool(root: Path, explicit: str | None) -> Path:
    fallback = root / (
        "mobile/local_artifacts/harmony-native-20261022-01/tools/command-line-tools/sdk/default/"
        "openharmony/toolchains/lib/hap-sign-tool.jar"
    )
    return resolve_file(explicit, fallback, "hap-sign-tool.jar")


def verify_unsigned(hap: Path, java: Path, sign_tool: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="lifeline-l26-hap-sign-check-") as temporary:
        temp = Path(temporary)
        command = [
            str(java), "-jar", str(sign_tool), "verify-app",
            "-inFile", str(hap),
            "-outCertChain", str(temp / "certificate-chain.cer"),
            "-outProfile", str(temp / "profile.p7b"),
        ]
        completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
    stdout = completed.stdout.decode("utf-8", errors="replace")
    stderr = completed.stderr.decode("utf-8", errors="replace")
    combined = f"{stdout}\n{stderr}"
    require(completed.returncode != 0, "Official HAP verifier unexpectedly accepted a signed package")
    require("signature not found" in combined.lower()
            and "No Hap Signing Block before ZIP Central Directory" in combined,
            "Official HAP verifier did not identify the package as unsigned")
    return {
        "unsigned": True,
        "officialVerifierExitCode": completed.returncode,
        "officialVerifierStdoutSha256": sha256_bytes(completed.stdout),
        "officialVerifierStderrSha256": sha256_bytes(completed.stderr),
        "reason": "No Hap Signing Block before ZIP Central Directory",
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
            "bundleName": identity_data["harmony"]["bundleName"],
            "versionCode": identity_data["harmony"]["versionCode"],
            "versionName": identity_data["harmony"]["versionName"],
        }
        identity_source = "EXPLICIT_CANDIDATE_CONFIG"
    hap = Path(args.hap).expanduser().resolve()
    build_log = Path(args.build_log).expanduser().resolve()
    receipt_path = Path(args.receipt).expanduser().resolve()
    require(hap.is_file() and hap.suffix.lower() == ".hap", f"HAP not found: {hap}")
    require(hap.name.endswith("-unsigned.hap"), "Expected an explicitly named *-unsigned.hap package")
    require(build_log.is_file(), f"Harmony build log not found: {build_log}")
    require(receipt_path.is_file(), f"Web build receipt not found: {receipt_path}")
    require(hap.stat().st_mtime_ns >= receipt_path.stat().st_mtime_ns,
            "HAP predates the current Web build receipt; rebuild the native package")

    log_bytes = build_log.read_bytes()
    log_text = log_bytes.decode("utf-8", errors="replace")
    require("BUILD SUCCESSFUL" in log_text, "Harmony build log does not contain BUILD SUCCESSFUL")
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes.decode("utf-8"))
    _, expected, manifest_digest = receipt_resources(receipt)
    hap_digest = sha256_file(hap)

    java = resolve_java(root, args.java)
    sign_tool = resolve_sign_tool(root, args.hap_sign_tool)
    signing = verify_unsigned(hap, java, sign_tool)

    with zipfile.ZipFile(hap, "r", metadata_encoding="utf-8") as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "HAP contains duplicate ZIP entries")
        require(all(safe_archive_name(name) for name in names), "HAP contains an unsafe ZIP path")
        require(archive.testzip() is None, "HAP ZIP CRC verification failed")
        prefix = "resources/rawfile/web/"
        rawfiles = {name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith("/")}
        require(rawfiles == set(expected),
                f"HAP Web resources differ from receipt: missing={sorted(set(expected) - rawfiles)!r}, "
                f"extra={sorted(rawfiles - set(expected))!r}")
        for name, digest in expected.items():
            require(archive_member_sha256(archive, prefix + name) == digest, f"HAP resource hash mismatch: {name}")
        resource_bytes = sum(archive.getinfo(prefix + name).file_size for name in expected)
        warmup_digest = archive_member_sha256(archive, prefix + WARMUP_PATH)
        admission_digest = archive_member_sha256(archive, prefix + ADMISSION_PATH)
        native_geometry_digest = archive_member_sha256(archive, prefix + NATIVE_GEOMETRY_PATH)

        required_entries = {"module.json", "pack.info", "ets/modules.abc", "resources.index",
                            "resources/base/profile/main_pages.json"}
        require(required_entries <= set(names), f"HAP is missing native metadata: {sorted(required_entries - set(names))}")
        module = json.loads(archive.read("module.json"))
        pack = json.loads(archive.read("pack.info"))
        main_pages = json.loads(archive.read("resources/base/profile/main_pages.json"))
        bytecode = archive.read("ets/modules.abc")
        resource_index = archive.read("resources.index")
        entry_count = len(names)

    app = module.get("app", {})
    module_info = module.get("module", {})
    require(app.get("bundleName") == identity["bundleName"], "Unexpected Harmony bundle name")
    require(app.get("versionCode") == identity["versionCode"], "Unexpected Harmony versionCode")
    require(app.get("versionName") == identity["versionName"], "Unexpected Harmony versionName")
    require(app.get("debug") is True, "Harmony package is not a debug package")
    require(app.get("compileSdkType") == EXPECTED_COMPILE_SDK_TYPE, "Unexpected Harmony compile SDK type")
    require(app.get("compileSdkVersion") == EXPECTED_COMPILE_SDK_VERSION, "Unexpected Harmony compile SDK version")
    require(app.get("minAPIVersion") == EXPECTED_ENCODED_API, "Unexpected Harmony minimum API")
    require(app.get("targetAPIVersion") == EXPECTED_ENCODED_API, "Unexpected Harmony target API")
    require(module_info.get("name") == "entry" and module_info.get("type") == "entry", "Unexpected Harmony module identity")
    require(module_info.get("mainElement") == "EntryAbility", "Unexpected Harmony main ability")
    require(module_info.get("compileMode") == "esmodule", "Harmony module was not compiled in ES module mode")
    require(str(module_info.get("virtualMachine", "")).startswith("ark"), "Harmony module omitted Ark VM metadata")
    permissions = {item.get("name") for item in module_info.get("requestPermissions", []) if isinstance(item, dict)}
    required_permissions = {"ohos.permission.INTERNET", "ohos.permission.GET_NETWORK_INFO", "ohos.permission.VIBRATE"}
    require(required_permissions <= permissions, "Harmony package omitted required permissions")

    summary = pack.get("summary", {})
    require(summary.get("app", {}).get("bundleName") == identity["bundleName"], "pack.info bundle name mismatch")
    require(summary.get("app", {}).get("version") == {"code": identity["versionCode"], "name": identity["versionName"]},
            "pack.info version mismatch")
    modules = summary.get("modules", [])
    require(isinstance(modules, list) and len(modules) == 1, "pack.info must describe exactly one module")
    require(modules[0].get("apiVersion") == {"compatible": EXPECTED_API, "releaseType": "Release", "target": EXPECTED_API},
            "pack.info API metadata mismatch")
    require(modules[0].get("mainAbility") == "EntryAbility", "pack.info main ability mismatch")
    source_pages = json.loads((root / "mobile/harmony/entry/src/main/resources/base/profile/main_pages.json").read_text(encoding="utf-8"))
    require(main_pages == source_pages, "Packaged Harmony page metadata differs from current source")
    require(bytecode.startswith(b"PANDA\x00") and len(bytecode) > 1000, "ArkTS bytecode is missing or invalid")
    require(resource_index.startswith(b"Restool ") and len(resource_index) > 32, "Harmony resources.index metadata is invalid")
    require(warmup_digest == expected[WARMUP_PATH], f"{WARMUP_PATH} hash mismatch")
    require(admission_digest == expected[ADMISSION_PATH], f"{ADMISSION_PATH} hash mismatch")
    require(native_geometry_digest == expected[NATIVE_GEOMETRY_PATH],
            f"{NATIVE_GEOMETRY_PATH} hash mismatch")
    require(receipt_path.read_bytes() == receipt_bytes, "Web build receipt changed during verification")
    require(build_log.read_bytes() == log_bytes, "Harmony build log changed during verification")
    require(sha256_file(hap) == hap_digest, "HAP changed during verification")

    return {
        "schema": "lifeline-l26-harmony-hap-verification-v1",
        "status": "PASS_HARMONY_UNSIGNED_HAP_L26",
        "verifiedAt": utc_now(),
        "verificationHead": git_head(root),
        "scope": "Static unsigned-package, identity, API, ArkTS bytecode, ZIP and receipt-bound Web-resource verification; no device runtime, release signing or store acceptance.",
        "identitySource": {"type": identity_source, "configPath": str(identity_config) if identity_config else None,
                           "identity": identity},
        "hap": {"path": display_path(hap, root), "bytes": hap.stat().st_size, "sha256": hap_digest},
        "buildLog": {
            "path": display_path(build_log, root),
            "sha256": sha256_bytes(log_bytes),
            "buildSuccessful": True,
            "unsignedWarningPresent": "No signingConfig found for product default" in log_text,
        },
        "webBuildReceipt": {
            "path": display_path(receipt_path, root),
            "sha256": sha256_bytes(receipt_bytes),
            "distManifestSha256": manifest_digest,
            "resourceCount": len(expected),
            "resourceBytes": resource_bytes,
            "runtimeAssetVersion": receipt.get("runtime_asset_version"),
        },
        "app": app,
        "module": {
            "name": module_info.get("name"),
            "type": module_info.get("type"),
            "mainElement": module_info.get("mainElement"),
            "virtualMachine": module_info.get("virtualMachine"),
            "compileMode": module_info.get("compileMode"),
            "permissions": sorted(permissions),
        },
        "apiVersion": modules[0]["apiVersion"],
        "signing": signing,
        "zip": {"integrity": True, "entryCount": entry_count, "webResourceCount": len(expected)},
        "arkts": {"bytecodeBytes": len(bytecode), "bytecodeSha256": sha256_bytes(bytecode), "pandaHeader": True},
        "resourceMetadata": {
            "indexBytes": len(resource_index),
            "indexSha256": sha256_bytes(resource_index),
            "restoolHeader": True,
            "mainPages": main_pages.get("src"),
        },
        "multiplayerAIWarmupSha256": warmup_digest,
        "multiplayerUltimateAdmissionSha256": admission_digest,
        "multiplayerNativeGeometrySha256": native_geometry_digest,
        "tools": {"java": display_path(java, root), "hapSignTool": display_path(sign_tool, root)},
        "deviceAcceptance": False,
        "releaseSigning": False,
        "storeAcceptance": False,
    }


def parse_args(root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hap", required=True, help="Explicit path to the newly built L26 unsigned HAP")
    parser.add_argument("--build-log", required=True, help="Log from the successful HAP build")
    parser.add_argument("--run-dir", required=True, help="Fresh directory that will receive the JSON result")
    parser.add_argument("--receipt", required=True, help="Explicit resource build receipt to bind this verification")
    parser.add_argument("--identity-config", help="Explicit candidate identity JSON; omitted means fixed L26 identity")
    parser.add_argument("--java")
    parser.add_argument("--hap-sign-tool")
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
            "schema": "lifeline-l26-harmony-hap-verification-v1",
            "status": "FAIL",
            "verifiedAt": utc_now(),
            "hap": str(Path(args.hap).expanduser()),
            "buildLog": str(Path(args.build_log).expanduser()),
            "receipt": str(Path(args.receipt).expanduser()),
            "error": {"type": type(error).__name__, "message": str(error)},
        }
        exit_code = 1
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "output": str(output)}, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
