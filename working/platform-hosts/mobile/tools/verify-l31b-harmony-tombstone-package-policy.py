#!/usr/bin/env python3
"""Bind L31-B Harmony tombstone-load source and host evidence to fresh packages.

This policy consumes the canonical mobile Web build receipt, the APK and HAP,
both L26 static-verifier receipts, and a focused host-verifier receipt. It does
not treat ABC strings as proof of branch behavior and does not establish device
execution, cache-eviction recovery, crash durability, or platform acceptance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath


SCHEMA = "lifeline-l31b-harmony-tombstone-package-policy-v1"
PASS_STATUS = "PASS_L31B_HARMONY_TOMBSTONE_PACKAGE_POLICY"
IDENTITY_PATH = "mobile/config/release-identity-candidate.json"
SYNC_MANIFEST_PATH = "mobile/config/current-web-sync-source-manifest.json"
RUNTIME_MANIFEST_PATH = "mobile/config/mobile-runtime-source-manifest.json"
PROXY_PATH = "mobile/harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets"
HOST_TEST_PATH = "mobile/tests/verify-harmony-native-bridge.mjs"
HOST_RECEIPT_SCHEMA = "lifeline-harmony-tombstone-load-host-verification-v1"
HOST_RECEIPT_STATUS = "PASS_HARMONY_TOMBSTONE_LOAD_HOST"
EXPECTED_ANDROID = {
    "applicationId": "cn.lifelinegame.mobile",
    "versionCode": 2,
    "versionName": "1.0.1",
}
EXPECTED_HARMONY = {
    "bundleName": "cn.lifelinegame.mobile.harmony",
    "versionCode": 2,
    "versionName": "1.0.1",
}
EXPECTED_RUNTIME_VERSION = "20261024-l30a1"
EXPECTED_SYNC_RELEASE_ID = "web-current-sync-20261024-r13"
EXPECTED_SYNC_ASSET_VERSION = "20261024-current13"
EXPECTED_WEB_RESOURCE_COUNT = 271
TOMBSTONE = "__lifeline_native_session_cleared_v1__"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def safe_relative(value: object) -> str:
    require(isinstance(value, str) and bool(value) and "\\" not in value,
            f"Unsafe receipt source path: {value!r}")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and path.as_posix() != ".",
            f"Unsafe receipt source path: {value!r}")
    return path.as_posix()


def indexed_hash_rows(rows: object, label: str) -> dict[str, str]:
    require(isinstance(rows, list), f"{label} must be a list")
    indexed: dict[str, str] = {}
    for row in rows:
        require(isinstance(row, dict), f"{label} contains a non-object row")
        relative = safe_relative(row.get("path"))
        digest = row.get("sha256")
        require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None,
                f"{label} has an invalid SHA-256 for {relative}")
        require(relative not in indexed, f"{label} contains duplicate path {relative}")
        indexed[relative] = digest
    return indexed


def verify_r13_receipt(receipt: dict, sync: dict, runtime: dict) -> tuple[dict[str, str], str]:
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1",
            "Unexpected mobile Web build receipt schema")
    require(receipt.get("status") == "PASS-CURRENT", "Mobile Web build receipt is not PASS-CURRENT")
    require(receipt.get("runtime_asset_version") == runtime.get("runtime_asset_version")
            == EXPECTED_RUNTIME_VERSION,
            "Mobile receipt/runtime manifest is not pinned to the reviewed R13 runtime")
    require(receipt.get("current_web_sync_release_id") == sync.get("release_id")
            == EXPECTED_SYNC_RELEASE_ID,
            "Mobile receipt/current Web sync manifest is not pinned to R13")
    require(sync.get("asset_version") == EXPECTED_SYNC_ASSET_VERSION,
            "Current Web sync manifest asset version is not pinned to current13")

    dist_rows = indexed_hash_rows(receipt.get("dist_files"), "Receipt dist_files")
    require(len(dist_rows) == EXPECTED_WEB_RESOURCE_COUNT,
            f"Expected {EXPECTED_WEB_RESOURCE_COUNT} R13 Web resources, found {len(dist_rows)}")
    require(receipt.get("dist_file_count") == len(dist_rows),
            "Mobile receipt dist_file_count differs from dist_files")
    canonical_rows = json.dumps(receipt["dist_files"], ensure_ascii=False,
                                 separators=(",", ":")).encode("utf-8")
    manifest_hash = sha256_bytes(canonical_rows)
    require(receipt.get("dist_manifest_sha256") == manifest_hash,
            "Mobile receipt dist manifest hash is inconsistent")

    receipt_sources = indexed_hash_rows(receipt.get("source_files"), "Receipt source_files")
    for relative in (SYNC_MANIFEST_PATH, RUNTIME_MANIFEST_PATH):
        require(relative in receipt_sources,
                f"Mobile receipt does not bind required R13 manifest: {relative}")
    return receipt_sources, manifest_hash


def verify_source_and_host(proxy_bytes: bytes, host_test_bytes: bytes,
                           receipt_sources: dict[str, str], host_report: object) -> dict:
    proxy_hash = sha256_bytes(proxy_bytes)
    host_test_hash = sha256_bytes(host_test_bytes)
    require(receipt_sources.get(PROXY_PATH) == proxy_hash,
            "Web receipt does not bind the current LifelineNativeProxy source hash")
    require(receipt_sources.get(HOST_TEST_PATH) == host_test_hash,
            "Web receipt does not bind the current focused host-verifier source hash")

    proxy_source = proxy_bytes.decode("utf-8-sig")
    require(f"const TOMBSTONE: string = '{TOMBSTONE}';" in proxy_source,
            "Current Harmony source omits the reviewed session tombstone constant")
    tombstone_load_pattern = re.compile(
        r"if \(operation === 'loadRecord'\) \{\s*"
        r'const stored = await this\.store\.get\(SESSION_KEY, ""\);\s*'
        r"if \(typeof stored !== 'string'\) throw new Error\('Native session value has an invalid type\.'\);\s*"
        r"return JSON\.stringify\(\{ value: stored\.length === 0 \|\| stored === TOMBSTONE \? null : stored \}\);\s*\}",
        re.DOTALL,
    )
    require(tombstone_load_pattern.search(proxy_source) is not None,
            "Current Harmony source is missing the exact reviewed tombstone-load mapping structure")

    host_source = host_test_bytes.decode("utf-8-sig")
    required_host_fragments = [
        "an independent facade and proxy can read the flushed value from the shared host backing map",
        "the tombstone maps to null through an independent facade and proxy in the API-shaped host model",
        "not SDK compilation or device durability evidence",
    ]
    for fragment in required_host_fragments:
        require(fragment in host_source,
                f"Focused host verifier is missing required bounded-evidence text: {fragment}")

    require(isinstance(host_report, dict), "Focused host-verifier receipt is not an object")
    require(host_report.get("schema") == HOST_RECEIPT_SCHEMA,
            "Unexpected focused host-verifier receipt schema")
    require(host_report.get("status") == HOST_RECEIPT_STATUS,
            "Focused host verifier did not pass the tombstone-load checks")
    require(host_report.get("source_sha256") == host_test_hash,
            "Focused host-verifier receipt refers to a different verifier source hash")
    required_checks = {
        "missing_session_loads_as_null",
        "independent_facade_reads_shared_backing_map",
        "tombstone_loads_as_null_through_independent_facade",
        "read_and_flush_failures_fail_closed",
    }
    checks = host_report.get("checks")
    require(isinstance(checks, list) and required_checks.issubset(set(checks)),
            "Focused host-verifier receipt omits one or more required passing checks")
    scope = host_report.get("scope")
    require(isinstance(scope, str)
            and "API-shaped host persistence model" in scope
            and "not SDK compilation or device durability evidence" in scope,
            "Focused host-verifier receipt does not state its host-model evidence limit")

    return {
        "proxy_source_sha256": proxy_hash,
        "focused_host_verifier_source_sha256": host_test_hash,
        "focused_host_verifier_receipt_sha256": None,
        "source_structure": "PASS (reviewed tombstone constant and load mapping are present in current source)",
        "host_verifier": {
            "status": HOST_RECEIPT_STATUS,
            "checks": sorted(required_checks),
            "scope": scope,
        },
    }


def verify_l26_report(report: object, *, label: str, expected_status: str,
                      expected_schema: str, expected_package: dict, identity_path: Path,
                      package_hash: str, receipt_hash: str, manifest_hash: str) -> dict:
    require(isinstance(report, dict), f"{label} L26 receipt is not an object")
    require(report.get("schema") == expected_schema, f"Unexpected {label} L26 receipt schema")
    require(report.get("status") == expected_status, f"{label} L26 verifier did not pass")
    identity_source = report.get("identitySource")
    require(isinstance(identity_source, dict)
            and identity_source.get("type") == "EXPLICIT_CANDIDATE_CONFIG",
            f"{label} L26 receipt did not use explicit candidate identity")
    config_path = identity_source.get("configPath")
    require(isinstance(config_path, str) and Path(config_path).resolve() == identity_path.resolve(),
            f"{label} L26 receipt used a different identity config")
    identity = identity_source.get("identity")
    require(isinstance(identity, dict), f"{label} L26 receipt omits its candidate identity")
    for key, expected in expected_package.items():
        require(str(identity.get(key)) == str(expected),
                f"{label} L26 identity {key} does not match the candidate")
    package = report.get("package") if label == "Android" else report.get("app")
    require(isinstance(package, dict), f"{label} L26 receipt omits package metadata")
    for key, expected in expected_package.items():
        require(str(package.get(key)) == str(expected),
                f"{label} package {key} does not match the candidate")
    package_record = report.get("apk" if label == "Android" else "hap")
    require(isinstance(package_record, dict) and package_record.get("sha256") == package_hash,
            f"{label} L26 receipt refers to a different package hash")
    web_record = report.get("webBuildReceipt")
    require(isinstance(web_record, dict) and web_record.get("sha256") == receipt_hash,
            f"{label} L26 receipt refers to a different Web build receipt")
    require(web_record.get("distManifestSha256") == manifest_hash,
            f"{label} L26 receipt is not bound to the R13 Web resource manifest")
    require(web_record.get("resourceCount") == EXPECTED_WEB_RESOURCE_COUNT,
            f"{label} L26 receipt has an unexpected Web resource count")
    require(web_record.get("runtimeAssetVersion") == EXPECTED_RUNTIME_VERSION,
            f"{label} L26 receipt has an unexpected runtime asset version")
    return {
        "status": expected_status,
        "package_sha256": package_hash,
        "web_receipt_sha256": receipt_hash,
        "web_resource_count": EXPECTED_WEB_RESOURCE_COUNT,
        "web_resource_manifest_sha256": manifest_hash,
    }


def verify_candidate_identity(identity: object) -> dict:
    require(isinstance(identity, dict), "Candidate release identity is not an object")
    require(identity.get("schema") == "lifeline-mobile-release-identity-candidate-v1"
            and identity.get("status") == "DEVELOPMENT_CANDIDATE_NOT_FROZEN",
            "Candidate identity must remain explicitly unfrozen")
    for platform, expected in (("android", EXPECTED_ANDROID), ("harmony", EXPECTED_HARMONY)):
        actual = identity.get(platform)
        require(isinstance(actual, dict), f"Candidate identity omits {platform}")
        for key, value in expected.items():
            require(key in actual, f"Candidate {platform} identity omits required field {key}")
            require(str(actual[key]) == str(value),
                    f"Candidate {platform} identity {key} does not match {value!r}")
    return identity


def verify_hap_archive(hap_path: Path) -> dict:
    try:
        with zipfile.ZipFile(hap_path, "r") as archive:
            names = archive.namelist()
            require(len(names) == len(set(names)), "HAP contains duplicate ZIP entries")
            require(archive.testzip() is None, "HAP ZIP CRC verification failed")
            require({"module.json", "pack.info", "ets/modules.abc"} <= set(names),
                    "HAP omits required identity or ArkTS ABC entries")
            module = json.loads(archive.read("module.json").decode("utf-8"))
            pack = json.loads(archive.read("pack.info").decode("utf-8"))
            abc = archive.read("ets/modules.abc")
    except zipfile.BadZipFile as error:
        raise RuntimeError("HAP is not a valid ZIP archive") from error

    app = module.get("app", {})
    for key, expected in EXPECTED_HARMONY.items():
        require(str(app.get(key)) == str(expected), f"HAP module.json {key} does not match candidate identity")
    pack_app = pack.get("summary", {}).get("app", {})
    require(pack_app.get("bundleName") == EXPECTED_HARMONY["bundleName"],
            "HAP pack.info bundleName does not match candidate identity")
    version = pack_app.get("version", {})
    require(str(version.get("code")) == str(EXPECTED_HARMONY["versionCode"])
            and version.get("name") == EXPECTED_HARMONY["versionName"],
            "HAP pack.info version does not match candidate identity")
    abc_markers = ["LifelineNativeProxy", TOMBSTONE, "loadRecord"]
    require(all(marker.encode("utf-8") in abc for marker in abc_markers),
            "HAP ABC does not contain the current proxy's generic identifiers")
    return {
        "module_identity_verified": True,
        "pack_info_identity_verified": True,
        "arkts_abc_entry": "ets/modules.abc",
        "generic_markers_present": abc_markers,
        "marker_interpretation": "Presence only; ABC strings do not establish branch semantics.",
    }


def load_json(path: Path, label: str) -> tuple[dict, bytes]:
    require(path.is_file(), f"{label} not found: {path}")
    payload = path.read_bytes()
    try:
        value = json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is not valid UTF-8 JSON: {path}") from error
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value, payload


def verify(args: argparse.Namespace) -> dict:
    repo_root = Path(__file__).resolve().parents[2]
    receipt_path = args.receipt.resolve()
    apk_path = args.apk.resolve()
    hap_path = args.hap.resolve()
    android_run_dir = args.android_run_dir.resolve()
    harmony_run_dir = args.harmony_run_dir.resolve()
    host_report_path = args.host_verification.resolve()
    policy_path = Path(__file__).resolve()
    identity_path = (repo_root / IDENTITY_PATH).resolve()
    sync_path = (repo_root / SYNC_MANIFEST_PATH).resolve()
    runtime_path = (repo_root / RUNTIME_MANIFEST_PATH).resolve()
    proxy_path = (repo_root / PROXY_PATH).resolve()
    host_test_path = (repo_root / HOST_TEST_PATH).resolve()
    android_report_path = android_run_dir / "android-apk-verification.json"
    harmony_report_path = harmony_run_dir / "harmony-hap-verification.json"

    paths = [receipt_path, apk_path, hap_path, host_report_path, identity_path,
             sync_path, runtime_path, proxy_path, host_test_path,
             android_report_path, harmony_report_path, policy_path]
    for path in paths:
        require(path.is_file(), f"Required input file not found: {path}")
    before = {path: sha256_file(path) for path in paths}

    receipt, receipt_bytes = load_json(receipt_path, "Mobile Web build receipt")
    sync, _ = load_json(sync_path, "Current Web sync manifest")
    runtime, _ = load_json(runtime_path, "Mobile runtime source manifest")
    identity, _ = load_json(identity_path, "Candidate release identity")
    android_report, _ = load_json(android_report_path, "Android L26 verification receipt")
    harmony_report, _ = load_json(harmony_report_path, "Harmony L26 verification receipt")
    host_report, host_report_bytes = load_json(host_report_path, "Focused host-verifier receipt")

    verify_candidate_identity(identity)

    receipt_sources, manifest_hash = verify_r13_receipt(receipt, sync, runtime)
    require(receipt.get("current_web_sync_source_manifest_sha256") == sha256_file(sync_path),
            "Web build receipt does not bind the current Web sync manifest hash")
    require(receipt_sources.get(SYNC_MANIFEST_PATH) == sha256_file(sync_path),
            "Web build receipt does not bind the current Web sync manifest")
    require(receipt_sources.get(RUNTIME_MANIFEST_PATH) == sha256_file(runtime_path),
            "Web build receipt does not bind the current runtime source manifest")

    source_evidence = verify_source_and_host(
        proxy_path.read_bytes(), host_test_path.read_bytes(), receipt_sources, host_report)
    receipt_hash = sha256_bytes(receipt_bytes)
    apk_hash = sha256_file(apk_path)
    hap_hash = sha256_file(hap_path)
    android_l26 = verify_l26_report(
        android_report, label="Android", expected_status="PASS_ANDROID_DEBUG_APK_L26",
        expected_schema="lifeline-l26-android-apk-verification-v1",
        expected_package=EXPECTED_ANDROID, identity_path=identity_path,
        package_hash=apk_hash, receipt_hash=receipt_hash, manifest_hash=manifest_hash)
    harmony_l26 = verify_l26_report(
        harmony_report, label="Harmony", expected_status="PASS_HARMONY_UNSIGNED_HAP_L26",
        expected_schema="lifeline-l26-harmony-hap-verification-v1",
        expected_package=EXPECTED_HARMONY, identity_path=identity_path,
        package_hash=hap_hash, receipt_hash=receipt_hash, manifest_hash=manifest_hash)
    hap_evidence = verify_hap_archive(hap_path)
    source_evidence["focused_host_verifier_receipt_sha256"] = sha256_bytes(host_report_bytes)

    for path, expected in before.items():
        require(path.is_file() and sha256_file(path) == expected,
                f"Input changed during verification: {path}")

    return {
        "schema": SCHEMA,
        "status": PASS_STATUS,
        "verifier": {"path": str(policy_path), "sha256": before[policy_path]},
        "scope": "Source binding, focused API-shaped host-verifier receipt, candidate identity, R13 Web resource binding, HAP metadata, generic ABC marker presence, and L26 receipt consistency only.",
        "identity": {"status": identity["status"], "android": EXPECTED_ANDROID,
                     "harmony": EXPECTED_HARMONY},
        "web": {
            "receipt_path": str(receipt_path),
            "receipt_sha256": receipt_hash,
            "runtime_asset_version": EXPECTED_RUNTIME_VERSION,
            "current_web_sync_release_id": EXPECTED_SYNC_RELEASE_ID,
            "current_web_sync_asset_version": EXPECTED_SYNC_ASSET_VERSION,
            "resource_count": EXPECTED_WEB_RESOURCE_COUNT,
            "resource_manifest_sha256": manifest_hash,
        },
        "source_and_host_evidence": source_evidence,
        "packages": {
            "apk": {"path": str(apk_path), "sha256": apk_hash, "l26": android_l26},
            "hap": {"path": str(hap_path), "sha256": hap_hash,
                    "l26": harmony_l26, **hap_evidence},
        },
        "not_run": [
            "Harmony device execution",
            "cache-eviction recovery",
            "crash durability",
            "release signing",
            "installation or store acceptance",
        ],
        "input_stability": {"status": "PASS", "input_count": len(before)},
    }


def fixture_host_report(source_hash: str) -> dict:
    return {
        "schema": HOST_RECEIPT_SCHEMA,
        "status": HOST_RECEIPT_STATUS,
        "source_sha256": source_hash,
        "checks": [
            "missing_session_loads_as_null",
            "independent_facade_reads_shared_backing_map",
            "tombstone_loads_as_null_through_independent_facade",
            "read_and_flush_failures_fail_closed",
        ],
        "scope": "API-shaped host persistence model only; not SDK compilation or device durability evidence.",
    }


def run_self_test() -> None:
    identity_fixture = {
        "schema": "lifeline-mobile-release-identity-candidate-v1",
        "status": "DEVELOPMENT_CANDIDATE_NOT_FROZEN",
        "android": {**EXPECTED_ANDROID, "namespace": "cn.lifelinegame.mobile", "capacitorAppId": "cn.lifelinegame.mobile", "urlScheme": "lifeline"},
        "harmony": {**EXPECTED_HARMONY, "vendor": "LIFELINE"},
    }
    verify_candidate_identity(identity_fixture)
    for label, mutated_identity in (
        ("required identity value", {**identity_fixture, "android": {**identity_fixture["android"], "versionName": "1.0.0"}}),
        ("missing required identity field", {**identity_fixture, "harmony": {key: value for key, value in identity_fixture["harmony"].items() if key != "bundleName"}}),
    ):
        try:
            verify_candidate_identity(mutated_identity)
        except RuntimeError:
            pass
        else:
            raise RuntimeError(f"Self-test accepted {label} mutation")

    proxy = (f"const TOMBSTONE: string = '{TOMBSTONE}';\n"
             "if (operation === 'loadRecord') {\n"
             '      const stored = await this.store.get(SESSION_KEY, "");\n'
             "      if (typeof stored !== 'string') throw new Error('Native session value has an invalid type.');\n"
             "      return JSON.stringify({ value: stored.length === 0 || stored === TOMBSTONE ? null : stored });\n"
             "    }").encode()
    host = ("an independent facade and proxy can read the flushed value from the shared host backing map\n"
            "the tombstone maps to null through an independent facade and proxy in the API-shaped host model\n"
            "not SDK compilation or device durability evidence").encode()
    source_rows = {PROXY_PATH: sha256_bytes(proxy), HOST_TEST_PATH: sha256_bytes(host)}
    report = fixture_host_report(source_rows[HOST_TEST_PATH])
    valid = verify_source_and_host(proxy, host, source_rows, report)
    require(valid["host_verifier"]["status"] == HOST_RECEIPT_STATUS,
            "Valid synthetic source/host evidence was rejected")

    mutated_proxy = proxy.replace(TOMBSTONE.encode(), b"different-tombstone")
    try:
        verify_source_and_host(mutated_proxy, host, source_rows, report)
    except RuntimeError:
        pass
    else:
        raise RuntimeError("Self-test accepted a tombstone source mutation")

    bad_report = {**report, "source_sha256": "0" * 64}
    try:
        verify_source_and_host(proxy, host, source_rows, bad_report)
    except RuntimeError:
        pass
    else:
        raise RuntimeError("Self-test accepted a host-verifier receipt bound to the wrong source")

    print("PASS_L31B_HARMONY_TOMBSTONE_PACKAGE_POLICY_SELF_TEST (source, host-receipt, and mutation fixtures)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run synthetic pass/fail fixtures without package inputs")
    parser.add_argument("--receipt", type=Path, help="Canonical mobile Web build receipt for this checkpoint")
    parser.add_argument("--apk", type=Path, help="Android APK verified by the matching L26 run")
    parser.add_argument("--hap", type=Path, help="Harmony HAP verified by the matching L26 run")
    parser.add_argument("--android-run-dir", type=Path, help="L26 Android run directory containing android-apk-verification.json")
    parser.add_argument("--harmony-run-dir", type=Path, help="L26 Harmony run directory containing harmony-hap-verification.json")
    parser.add_argument("--host-verification", type=Path, help="Focused tombstone-load host-verifier JSON receipt")
    parser.add_argument("--output-dir", type=Path, help="New directory for the L31-B JSON receipt")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        run_self_test()
        return 0
    required = (args.receipt, args.apk, args.hap, args.android_run_dir,
                args.harmony_run_dir, args.host_verification, args.output_dir)
    require(all(required),
            "--receipt, --apk, --hap, --android-run-dir, --harmony-run-dir, "
            "--host-verification, and --output-dir are required")
    result = verify(args)
    output_dir = args.output_dir.resolve()
    try:
        output_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError as error:
        raise RuntimeError(f"Refusing to overwrite existing output directory: {output_dir}") from error
    output_path = output_dir / "l31b-harmony-tombstone-package-policy.json"
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "receipt": str(output_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"L31-B Harmony tombstone package policy rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
