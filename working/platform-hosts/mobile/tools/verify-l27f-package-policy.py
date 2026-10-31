#!/usr/bin/env python3
"""Verify L27-F Web resources and scoped native markers inside fresh APK/HAP packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath


SHA256 = re.compile(r"^[a-f0-9]{64}$")
EXPECTED_WIRED_HARD = {
    "LocalAIWorkerFactory.js",
    "MultiplayerHardAIWorker.bundle.mjs",
    "MultiplayerHardFallback.js",
    "MultiplayerHardResources.js",
    "MultiplayerHardRollout.js",
    "MultiplayerHardRuntime.js",
    "MultiplayerHardValue.js",
}
EXPECTED_UNWIRED_HARD = {
    "MultiplayerHardWorkerEntry.js",
    "MultiplayerHardWorkerRuntime.js",
}
REQUIRED_POLICY_SOURCES = [
    "mobile/tools/verify-l27f-package-policy.py",
    "mobile/tests/verify-l27f-ultimate-admission.mjs",
    "web/web前端/tests/verify-local-runtime-loaders.mjs",
    "web/web前端/tests/verify-territory-v3.mjs",
    "web/web前端/tests/verify-territory-pool.mjs",
    "web/web前端/tests/verify-replay-codec.mjs",
]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def safe_relative(value: str) -> str:
    require(isinstance(value, str) and value != "" and "\\" not in value,
            f"Unsafe package path: {value}")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and path.as_posix() != ".",
            f"Unsafe package path: {value}")
    return path.as_posix()


def read_zip_member(archive: zipfile.ZipFile, name: str, label: str) -> bytes:
    try:
        return archive.read(name)
    except KeyError as error:
        raise RuntimeError(f"{label} is missing package member {name}") from error


def require_text_markers(payload: bytes, markers: list[str], label: str) -> None:
    missing = [marker for marker in markers if marker.encode("utf-8") not in payload]
    require(not missing, f"{label} is missing required compiled markers: {missing}")


def indexed_hash_rows(rows, label: str) -> dict[str, str]:
    require(isinstance(rows, list), f"{label} must be a list")
    indexed: dict[str, str] = {}
    for row in rows:
        require(isinstance(row, dict), f"{label} contains a non-object row")
        relative = safe_relative(row.get("path", ""))
        digest = row.get("sha256")
        require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None,
                f"{label} has an invalid SHA-256 for {relative}")
        require(relative not in indexed, f"{label} contains duplicate path {relative}")
        indexed[relative] = digest
    return indexed


def rows_manifest_sha256(rows: list[dict[str, str]]) -> str:
    canonical = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(canonical)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--hap", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--sync-manifest", required=True, type=Path)
    parser.add_argument("--runtime-manifest", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    apk_path = args.apk.resolve()
    hap_path = args.hap.resolve()
    receipt_path = args.receipt.resolve()
    require(apk_path.is_file(), f"APK not found: {apk_path}")
    require(hap_path.is_file(), f"HAP not found: {hap_path}")
    require(receipt_path.is_file(), f"Mobile Web build receipt not found: {receipt_path}")

    sync_path = args.sync_manifest.resolve()
    runtime_path = args.runtime_manifest.resolve()
    require(sync_path.is_file(), f"Current Web sync manifest not found: {sync_path}")
    require(runtime_path.is_file(), f"Runtime source manifest not found: {runtime_path}")
    receipt_bytes = receipt_path.read_bytes()
    sync_bytes = sync_path.read_bytes()
    runtime_bytes = runtime_path.read_bytes()
    receipt = json.loads(receipt_bytes.decode("utf-8-sig"))
    sync = json.loads(sync_bytes.decode("utf-8-sig"))
    runtime = json.loads(runtime_bytes.decode("utf-8-sig"))
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1", "Unexpected Mobile Web build receipt schema")
    require(receipt.get("status") == "PASS-CURRENT", "Mobile Web build receipt is not current PASS")
    require(receipt.get("runtime_asset_version") == runtime.get("runtime_asset_version") == "20261023-l27f1",
            "Runtime asset version is not bound to L27-F")
    require(receipt.get("current_web_sync_release_id") == sync.get("release_id") == "web-current-sync-20261023-r8",
            "Current Web sync release is not bound to R8")
    require(receipt.get("current_web_sync_source_manifest_sha256") == sha256_file(sync_path),
            "Build receipt hash does not match the current Web sync manifest")
    closure = receipt.get("current_web_runtime_closure", {})
    require(closure.get("status") == "PASS_CURRENT_WEB_RUNTIME_CLOSURE" and closure.get("mode") == "package",
            "Build receipt does not bind a passing package-mode Web closure audit")
    source_rows = indexed_hash_rows(receipt.get("source_files"), "Build receipt source_files")
    require(source_rows.get("mobile/config/current-web-sync-source-manifest.json") == sha256_file(sync_path),
            "Build receipt source list does not bind the current Web sync manifest")
    require(source_rows.get("mobile/config/mobile-runtime-source-manifest.json") == sha256_file(runtime_path),
            "Build receipt source list does not bind the runtime source manifest")
    for relative in REQUIRED_POLICY_SOURCES:
        require(SHA256.fullmatch(source_rows.get(relative, "")) is not None,
                f"Build receipt does not bind required L27-F policy source: {relative}")

    adaptation_by_path = {item["path"]: item for item in sync.get("mobile_adaptations", [])}
    for relative, live_hash in sync.get("source_files", {}).items():
        safe_relative(relative)
        require(isinstance(live_hash, str) and SHA256.fullmatch(live_hash) is not None,
                f"Current Web sync manifest has an invalid source hash: {relative}")
        expected_mobile_hash = adaptation_by_path.get(relative, {}).get("mobile_sha256", live_hash)
        require(isinstance(expected_mobile_hash, str) and SHA256.fullmatch(expected_mobile_hash) is not None,
                f"Current Web sync manifest has an invalid packaged hash: {relative}")
        receipt_key = f"web/web前端/{relative}"
        require(source_rows.get(receipt_key) == expected_mobile_hash,
                f"Build receipt source hash mismatch: {receipt_key}")

    runtime_files = set(runtime.get("files", []))
    require(runtime_files.issubset(sync.get("source_files", {})),
            "Runtime manifest contains a source not bound by the current Web sync manifest")
    wired = sync.get("excluded_live_wired_unqualified_experiments", [])
    unwired = sync.get("excluded_live_unwired_experiments", [])
    require(wired == runtime.get("excluded_live_wired_unqualified_experiments", []),
            "Wired exclusion records differ between manifests")
    require(unwired == runtime.get("excluded_live_unwired_experiments", []),
            "Unwired exclusion records differ between manifests")
    wired_names = {item["path"] for item in wired}
    unwired_names = {item["path"] for item in unwired}
    require(wired_names == EXPECTED_WIRED_HARD and unwired_names == EXPECTED_UNWIRED_HARD,
            "L27-F Hard exclusion inventory is not the reviewed 7 wired + 2 unwired set")
    require(all(item.get("packaged") is False for item in [*wired, *unwired])
            and all(item.get("classification") == "wired_unqualified_runtime_path"
                    and item.get("runtime_reachable") is True for item in wired)
            and all(item.get("classification") == "unwired_unqualified_experiment"
                    and item.get("runtime_reachable") is False for item in unwired),
            "An unqualified Hard artifact has an invalid exclusion classification")
    hard_names = wired_names | unwired_names
    for name in hard_names:
        require(name not in runtime_files and name not in sync.get("source_files", {}),
                f"Unqualified Hard source entered a package manifest: {name}")

    dist_rows = receipt.get("dist_files")
    require(isinstance(dist_rows, list) and dist_rows,
            "Build receipt contains no Web resources")
    require(len(dist_rows) == receipt.get("dist_file_count"), "Receipt does not enumerate every built Web resource")
    canonical_dist_rows = [{"path": safe_relative(row.get("path", "")), "sha256": row.get("sha256")}
                           for row in dist_rows]
    dist_hashes = indexed_hash_rows(canonical_dist_rows, "Build receipt dist_files")
    require(rows_manifest_sha256(canonical_dist_rows) == receipt.get("dist_manifest_sha256"),
            "Build receipt dist manifest digest is inconsistent")
    harmony_rows = receipt.get("harmony_rawfile_files")
    require(harmony_rows == dist_rows, "Build receipt Harmony rawfile inventory differs from dist_files")
    require(rows_manifest_sha256(canonical_dist_rows) == receipt.get("harmony_rawfile_manifest_sha256"),
            "Build receipt Harmony rawfile manifest digest is inconsistent")

    packages = []
    for label, package_path, prefix in [
        ("APK", apk_path, "assets/public/"),
        ("HAP", hap_path, "resources/rawfile/web/"),
    ]:
        with zipfile.ZipFile(package_path, "r", metadata_encoding="utf-8") as archive:
            members = set(archive.namelist())
            for relative, expected_hash in dist_hashes.items():
                payload = read_zip_member(archive, prefix + relative, label)
                require(sha256_bytes(payload) == expected_hash,
                        f"{label} Web resource hash mismatch: {prefix + relative}")
            hard_members = [name for name in members if name.startswith(prefix)
                            and PurePosixPath(name[len(prefix):]).name in hard_names]
            require(not hard_members, f"{label} contains excluded Hard artifacts: {hard_members}")
            bundle_members = [name for name in members if PurePosixPath(name).name == "MultiplayerHardAIWorker.bundle.mjs"]
            require(not bundle_members, f"{label} contains the excluded worker bundle: {bundle_members}")

            game_engine = read_zip_member(archive, prefix + "GameEngine.js", label)
            require_text_markers(game_engine, ["territory-v1", "territory-v2", "territory-v3",
                                                       "const owned = new Set([",
                                                       "displayArea: territory.polygon ? territory.displayArea : owned.size"],
                                 f"{label} territory-v3 rule engine")
            replay_codec = read_zip_member(archive, prefix + "ReplayCodec.js", label)
            require_text_markers(replay_codec, ["SUPPORTED_RULES", "territory-v1", "territory-v2",
                                                "territory-v3", "validateReplayDocument", "new GameEngine"],
                                 f"{label} versioned replay codec")
            admission_source = read_zip_member(archive, prefix + "MultiplayerUltimateAdmission.js", label).decode("utf-8-sig")
            require(re.search(r"export const ACCEPTED_ULTIMATE_RELEASES\s*=\s*Object\.freeze\(\s*\[\s*\]\s*\)",
                              admission_source) is not None,
                    f"{label} Ultimate admission registry is not explicitly empty")
            require("ULTIMATE_NOT_QUALIFIED" in admission_source and "preserveSelection: true" in admission_source
                    and "preserveSave: true" in admission_source,
                    f"{label} Ultimate empty-registry rejection policy is missing")
            runtime_source = read_zip_member(archive, prefix + "MultiplayerRuntime.js", label)
            require_text_markers(runtime_source, ["createUltimateAdmissionGuard", "checkProfile",
                                                  "admission.allowed", "error.code=admission.code", "throw error"],
                                 f"{label} Ultimate runtime admission path")

            model_manifest_path = "assets/research-ai/multiplayer-v1/manifest.json"
            model_manifest_bytes = read_zip_member(archive, prefix + model_manifest_path, label)
            model_manifest = json.loads(model_manifest_bytes.decode("utf-8-sig"))
            require(model_manifest.get("schema", {}).get("name") == "lifeline-multiplayer-runtime"
                    and model_manifest.get("rulesVersion") == "territory-v2",
                    f"{label} has an unexpected multiplayer model manifest")
            ultimate = next((model for model in model_manifest.get("models", [])
                             if model.get("id") == "multiplayer-ultimate-v1"), None)
            require(ultimate is not None, f"{label} model manifest omits the Ultimate model identity")
            require(model_manifest.get("strength_verified") is False
                    and ultimate.get("strength_evaluated") is False
                    and ultimate.get("status") == "TRAINED_NUMERICALLY_VERIFIED_STRENGTH_PENDING",
                    f"{label} model manifest no longer records strength as pending")
            weight_relative = "assets/research-ai/multiplayer-v1/" + ultimate["asset"]
            weight_bytes = read_zip_member(archive, prefix + weight_relative, label)
            weight_hash = sha256_bytes(weight_bytes)
            require(weight_hash == ultimate.get("asset_sha256"), f"{label} Ultimate F32 hash mismatch")
            require(weight_hash == dist_hashes.get(weight_relative), f"{label} F32 differs from the build receipt")

            packages.append({
                "kind": label,
                "path": str(package_path),
                "bytes": package_path.stat().st_size,
                "sha256": sha256_file(package_path),
                "web_resource_count": len(dist_hashes),
                "excluded_hard_artifact_count": len(hard_names),
                "ultimate_model_manifest_sha256": sha256_bytes(model_manifest_bytes),
                "ultimate_model_asset": weight_relative,
                "ultimate_model_asset_sha256": weight_hash,
            })

    with zipfile.ZipFile(apk_path, "r", metadata_encoding="utf-8") as apk:
        dex_entries = sorted(name for name in apk.namelist() if re.fullmatch(r"classes\d*\.dex", name))
        markers = ["LifelineReplayImportPlugin", "LifelineReplayImport", "selectReplay", "handleDocumentPicker",
                   "pickerActive", "activeCallId", "android.intent.action.OPEN_DOCUMENT",
                   "android.intent.category.OPENABLE", "application/json", "text/json", "text/plain",
                   "application/octet-stream", "selected", "cancelled", "too-large", "busy", "read-failed",
                   "Replay file selection is already active.", "Invalid replay import request."]
        dex_match = None
        for name in dex_entries:
            payload = apk.read(name)
            if all(marker.encode("utf-8") in payload for marker in markers):
                dex_match = name
                break
        require(dex_match is not None, "APK DEX does not contain the replay picker plugin, selectReplay, busy rejection, and refusal text")

    with zipfile.ZipFile(hap_path, "r", metadata_encoding="utf-8") as hap:
        abc_entries = sorted(name for name in hap.namelist() if name.endswith(".abc"))
        harmony_markers = ["LifelineNativeProxy", "importReplay", "replayImport", "executeImportReplay",
                           "activeImportId", "DocumentViewPicker", "fileSuffixFilters", ".json",
                           "maxSelectNumber", "selected", "cancelled", "too-large",
                           "Replay file selection is already active.", "Invalid replay import request.",
                           "Replay owner changed.", "Replay selection was invalid."]
        abc_match = None
        for name in abc_entries:
            payload = hap.read(name)
            if all(marker.encode("utf-8") in payload for marker in harmony_markers):
                abc_match = name
                break
        require(abc_match is not None,
                "Harmony ABC lacks the replay import bridge, activeImportId lock, or duplicate-selection refusal copy")

    require(packages[0]["ultimate_model_manifest_sha256"] == packages[1]["ultimate_model_manifest_sha256"],
            "APK and HAP Ultimate model manifests differ")
    require(packages[0]["ultimate_model_asset_sha256"] == packages[1]["ultimate_model_asset_sha256"],
            "APK and HAP Ultimate F32 assets differ")
    result = {
        "schema": "lifeline-mobile-l27f-package-policy-v1",
        "status": "PASS_L27F_NATIVE_PACKAGE_POLICY",
        "runtime_asset_version": runtime["runtime_asset_version"],
        "current_web_sync_release_id": sync["release_id"],
        "current_web_sync_asset_version": sync["asset_version"],
        "current_web_sync_manifest_sha256": sha256_file(sync_path),
        "runtime_source_manifest_sha256": sha256_file(runtime_path),
        "web_resource_count": len(dist_hashes),
        "wired_unqualified_hard_count": len(wired),
        "unwired_hard_worker_count": len(unwired),
        "excluded_worker_bundle": "MultiplayerHardAIWorker.bundle.mjs",
        "packages": packages,
        "android_replay_plugin": {
            "dex_entry": dex_match,
            "plugin_marker": "LifelineReplayImportPlugin",
            "method_marker": "selectReplay",
            "busy_rejection": True,
            "refusal_text": "Replay file selection is already active.",
        },
        "harmony_replay_import": {
            "abc_entry": abc_match,
            "proxy_marker": "LifelineNativeProxy",
            "operation_marker": "importReplay",
            "capability_marker": "replayImport",
            "active_import_lock": "activeImportId",
            "refusal_text": "Replay file selection is already active.",
            "duplicate_selection_rejected": True,
        },
        "scope": "Package/hash and compiled-marker verification; no device execution, signing, store, or release acceptance claim.",
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    require(receipt_path.read_bytes() == receipt_bytes, "Build receipt changed during verification")
    require(sync_path.read_bytes() == sync_bytes, "Current Web sync manifest changed during verification")
    require(runtime_path.read_bytes() == runtime_bytes, "Runtime source manifest changed during verification")
    if args.output:
        output = args.output.resolve()
        require(not output.exists(), f"Refusing to overwrite existing policy receipt: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"L27-F package policy rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
