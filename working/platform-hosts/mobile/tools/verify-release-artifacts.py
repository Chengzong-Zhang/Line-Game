#!/usr/bin/env python3
"""Fail-closed static checks for signed Android APK and Harmony HAP candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


def fail(message: str) -> None:
    raise ValueError(message)


def run(command: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(command, capture_output=True, timeout=120, check=False, env=env)
    if result.returncode != 0:
        fail(f"Artifact verification command failed: {Path(command[0]).name}.")
    return result


def build_tools(root: Path) -> Path:
    candidates = [Path(os.environ[key]) for key in ("ANDROID_SDK_ROOT", "ANDROID_HOME") if os.environ.get(key)]
    candidates.append(root / "mobile/local_artifacts/android-sdk")
    for sdk in candidates:
        tools = sdk / "build-tools"
        if tools.is_dir():
            for version in sorted((p for p in tools.iterdir() if p.is_dir()), reverse=True):
                if (version / "aapt.exe").is_file() and (version / "apksigner.bat").is_file():
                    return version
                if (version / "aapt").is_file() and (version / "apksigner").is_file():
                    return version
    fail("Android SDK build-tools containing aapt and apksigner were not found.")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_web_resources(root: Path) -> tuple[dict[str, str], str]:
    receipt_path = root / "mobile/local_artifacts/mobile-web-build-receipt.json"
    require(receipt_path.is_file(), "Current mobile Web build receipt is missing.")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    source_manifest = root / "mobile/config/current-web-sync-source-manifest.json"
    require(source_manifest.is_file(), "Tracked current Web sync source manifest is missing.")
    require(receipt.get("current_web_sync_source_manifest_sha256") == sha256(source_manifest),
            "Current Web build receipt does not match the tracked source manifest.")
    rows = receipt.get("dist_files")
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1" and receipt.get("status") == "PASS-CURRENT",
            "Current mobile Web build receipt is not PASS-CURRENT.")
    require(isinstance(rows, list) and receipt.get("dist_file_count") == len(rows) and rows,
            "Current mobile Web build receipt has invalid resource metadata.")
    expected: dict[str, str] = {}
    normalized: list[dict[str, str]] = []
    for row in rows:
        name, digest = row.get("path"), row.get("sha256")
        require(isinstance(name, str) and name and not name.startswith("/") and ".." not in Path(name).parts,
                "Current Web receipt contains an invalid resource path.")
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest),
                "Current Web receipt contains an invalid resource hash.")
        require(name not in expected, "Current Web receipt contains a duplicate resource.")
        expected[name] = digest
        normalized.append({"path": name, "sha256": digest})
    canonical = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    manifest_digest = hashlib.sha256(canonical).hexdigest()
    require(receipt.get("dist_manifest_sha256") == manifest_digest, "Current Web receipt manifest hash is inconsistent.")
    return expected, sha256(receipt_path)


def verify_web_resources(archive: zipfile.ZipFile, prefix: str, expected: dict[str, str]) -> None:
    packaged = {name[len(prefix):] for name in archive.namelist() if name.startswith(prefix) and not name.endswith("/")}
    require(packaged == set(expected),
            f"Packaged Web resource set differs from current receipt: missing={len(set(expected) - packaged)}, extra={len(packaged - set(expected))}.")
    for name, digest in expected.items():
        actual = hashlib.sha256(archive.read(prefix + name)).hexdigest()
        require(actual == digest, f"Packaged Web resource hash mismatch: {name}.")


def verify_android(root: Path, apk: Path, identity: dict, expected_resources: dict[str, str], receipt_hash: str) -> dict:
    require(apk.is_file() and apk.suffix.lower() == ".apk", "Android artifact must be an existing APK.")
    tools = build_tools(root)
    aapt = tools / ("aapt.exe" if os.name == "nt" else "aapt")
    apksigner = tools / ("apksigner.bat" if os.name == "nt" else "apksigner")
    java_home = os.environ.get("JAVA_HOME")
    if not java_home:
        candidates = sorted((root / "mobile/local_artifacts/native-build-20261022-parent01/temurin21").glob("*/"))
        java_home = str(candidates[0]) if candidates else None
    process_env = os.environ.copy()
    if java_home:
        process_env["JAVA_HOME"] = java_home
        process_env["PATH"] = str(Path(java_home) / "bin") + os.pathsep + process_env.get("PATH", "")
    signature = run([str(apksigner), "verify", "--verbose", "--print-certs", str(apk)], env=process_env)
    cert_text = (signature.stdout + signature.stderr).decode("utf-8", "replace")
    subjects = re.findall(r"Signer #\d+ certificate DN: (.+)", cert_text)
    require(len(subjects) == 1, "Android APK must have exactly one signer.")
    subject = re.search(r"Signer #1 certificate DN: (.+)", cert_text)
    require(subject is not None, "Android certificate subject is missing.")
    require("android debug" not in subject.group(1).lower(), "Android Debug certificate is forbidden for release.")
    fingerprint = re.search(r"Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F:]+)", cert_text)
    require(fingerprint is not None, "Android release certificate SHA-256 is missing.")
    fingerprint = fingerprint.group(1).replace(":", "").lower()
    expected_fingerprint = identity.get("releaseCertificateFingerprints", {}).get("androidSha256")
    require(isinstance(expected_fingerprint, str) and re.fullmatch(r"[0-9a-f]{64}", expected_fingerprint),
            "Android release certificate SHA-256 is not frozen.")
    require(fingerprint == expected_fingerprint, "Android release certificate fingerprint differs from frozen identity.")
    require("Verified using v2 scheme (APK Signature Scheme v2): true" in cert_text
            or "Verified using v3 scheme (APK Signature Scheme v3): true" in cert_text,
            "Android APK v2 or v3 signature scheme is required.")
    badging = run([str(aapt), "dump", "badging", str(apk)]).stdout.decode("utf-8", "replace")
    require("application-debuggable" not in badging, "Android APK is debuggable.")
    package_match = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    require(package_match is not None, "Android package identity is unreadable.")
    require(package_match.group(1) == identity["android"]["applicationId"], "Android applicationId mismatch.")
    require(package_match.group(2) == str(identity["android"]["versionCode"]), "Android versionCode mismatch.")
    require(package_match.group(3) == identity["android"]["versionName"], "Android versionName mismatch.")
    with zipfile.ZipFile(apk, "r") as archive:
        names = archive.namelist()
        normalized_names = [name.replace("\\", "/") for name in names]
        require(len(names) == len(set(names)), "Android APK contains duplicate ZIP entries.")
        require(all(name and not name.startswith("/") and ".." not in Path(name).parts for name in normalized_names),
                "Android APK contains an unsafe ZIP path.")
        require(archive.testzip() is None, "Android APK ZIP CRC verification failed.")
        dex_files = [name for name in names if re.fullmatch(r"classes(?:\d+)?\.dex", name)]
        require(dex_files, "Android APK contains no DEX bytecode.")
        for name in dex_files:
            require(archive.getinfo(name).file_size > 8 and archive.read(name)[:4] == b"dex\n",
                    f"Android APK DEX entry is invalid: {name}.")
        verify_web_resources(archive, "assets/public/", expected_resources)
    return {"status": "PASS_SIGNED_RELEASE_APK_STATIC", "sha256": sha256(apk), "webReceiptSha256": receipt_hash,
            "certificateSha256": fingerprint, "applicationId": package_match.group(1),
            "versionCode": package_match.group(2), "versionName": package_match.group(3),
            "certificateSubject": subject.group(1)}


def verify_harmony(root: Path, hap: Path, identity: dict, expected_resources: dict[str, str], receipt_hash: str, java: str | None, sign_tool: str | None) -> dict:
    require(hap.is_file() and hap.suffix.lower() == ".hap", "Harmony artifact must be an existing HAP.")
    with zipfile.ZipFile(hap, "r") as archive:
        require(archive.testzip() is None, "Harmony HAP ZIP integrity check failed.")
        names = set(archive.namelist())
        require("module.json" in names, "Harmony HAP module.json is missing.")
        module = json.loads(archive.read("module.json"))
        verify_web_resources(archive, "resources/rawfile/web/", expected_resources)
    app = module.get("app", {})
    require(app.get("debug") is False, "Harmony HAP is debug or its debug state is unknown.")
    require(app.get("bundleName") == identity["harmony"]["bundleName"], "Harmony bundleName mismatch.")
    require(app.get("versionCode") == identity["harmony"]["versionCode"], "Harmony versionCode mismatch.")
    require(app.get("versionName") == identity["harmony"]["versionName"], "Harmony versionName mismatch.")
    fallback_tool = root / "mobile/local_artifacts/harmony-native-20261022-01/tools/command-line-tools/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar"
    selected_tool = Path(sign_tool).resolve() if sign_tool else fallback_tool
    selected_java = java or shutil.which("java")
    require(selected_tool.is_file() and selected_java, "Harmony official verifier or Java runtime was not found.")
    expected_fingerprint = identity.get("releaseCertificateFingerprints", {}).get("harmonyCertChainSha256")
    require(isinstance(expected_fingerprint, str) and re.fullmatch(r"[0-9a-f]{64}", expected_fingerprint),
            "Harmony release certificate SHA-256 is not frozen.")
    with tempfile.TemporaryDirectory(prefix="lifeline-hap-release-verify-") as temporary:
        cert_chain = Path(temporary) / "certificate-chain.cer"
        profile = Path(temporary) / "profile.p7b"
        run([selected_java, "-jar", str(selected_tool), "verify-app", "-inFile", str(hap),
             "-outCertChain", str(cert_chain), "-outProfile", str(profile)])
        require(cert_chain.is_file() and profile.is_file(), "Harmony signing verifier did not export certificate/profile.")
        certificate_fingerprint = hashlib.sha256(cert_chain.read_bytes()).hexdigest()
        require(certificate_fingerprint == expected_fingerprint, "Harmony release certificate fingerprint differs from frozen identity.")
    return {"status": "PASS_SIGNED_RELEASE_HAP_STATIC", "sha256": sha256(hap), "webReceiptSha256": receipt_hash,
            "certificateChainSha256": certificate_fingerprint, "bundleName": app["bundleName"],
            "versionCode": app["versionCode"], "versionName": app["versionName"]}


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--android-apk")
    parser.add_argument("--harmony-hap")
    parser.add_argument("--java")
    parser.add_argument("--hap-sign-tool")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    identity = json.loads((root / "mobile/config/release-identity-candidate.json").read_text(encoding="utf-8"))
    require(identity.get("schema") == "lifeline-mobile-release-identity-candidate-v1",
            "Release identity schema is invalid.")
    require(identity.get("status") == "FROZEN", "Release identity must be FROZEN before artifact verification.")
    expected_resources, receipt_hash = current_web_resources(root)
    report: dict[str, dict] = {}
    if not args.android_apk and not args.harmony_hap:
        fail("Provide at least one release artifact for static verification.")
    if args.android_apk:
        report["android"] = verify_android(root, Path(args.android_apk).resolve(), identity, expected_resources, receipt_hash)
    if args.harmony_hap:
        report["harmony"] = verify_harmony(root, Path(args.harmony_hap).resolve(), identity, expected_resources, receipt_hash, args.java, args.hap_sign_tool)
    print(json.dumps({"status": "PASS_STATIC_ARTIFACTS", "artifacts": report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "BLOCKED", "reason": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
