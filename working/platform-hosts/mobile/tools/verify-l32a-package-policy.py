#!/usr/bin/env python3
"""Verify the current L32-A R14 Web and native markers inside fresh APK/HAP packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath


SHA256 = re.compile(r"^[a-f0-9]{64}$")
EXPECTED_WEB_RESOURCE_COUNT = 274
CAPACITOR_EXTRA_RESOURCES = {"cordova.js", "cordova_plugins.js"}
ADMITTED_HARD_RESOURCES = {
    "LocalAIWorkerFactory.js": ("a60dadfc9603a9739c73a0e58125f1643e9c4358c7c61e9462c691aefd55d66a", 1562),
    "MultiplayerHardAIWorker.bundle.mjs": ("bea2a7c9587a8697e71a981a4e5f3cb92ff7bd92d8ad107b845ba6ba004e6911", 240388),
    "MultiplayerHardAIWorker.bundle.manifest.json": ("65451533e0bedd23f5f1df5fc67fff4a5f99f0b116635befec9c2c4ce6895589", 2472),
}
BUNDLE_INTERNAL_SOURCES = {
    "MultiplayerHardFallback.js": "0df510a7455f94c64d1d77db61b0acc31e14fefea661e83b2eb1c3e47e46a753",
    "MultiplayerHardResources.js": "474c61781743a91b78a3edde8f03d7cd23d8dff635fbabd27197a0b4bf2502f5",
    "MultiplayerHardRollout.js": "436096c1aa2147f589808330bd992e91c5d5eb9815b1c96e70a792fee539853a",
    "MultiplayerHardRuntime.js": "252452374945f9dcbb963a8201b83b163dbb8f8218542704aa20541c93f03c43",
    "MultiplayerHardValue.js": "53f1f6f6d515538d73e31393e814b7b2e02c0fde8093d30142c1aaa1222247fb",
    "MultiplayerHardWorkerEntry.js": "18bc32c996ed1933e6aad2889dfee6b0cef46d9c32eb6c1f83f411457dca7688",
    "MultiplayerHardWorkerRuntime.js": "60281b21de9a6c85b9a271b0893b81ad60d5971ccb94585f7005424bba204302",
}
BROWSER_AUDIT_RELATIVE = "docs/verification/multiplayer-20261022/hard-dual-rules-browser-r6.json"
BROWSER_AUDIT_SHA256 = "2755732e69d8dfb5801c0f377a96d38341364bd33ec6a9e3fa3984a6cecbb10e"
BROWSER_REPORT_SHA256 = "c9857fe19252c2835ac99475a2828a7288deb5f966a8f438acdf8a3b3f064f14"
HARD_BUILD_RECEIPT_SHA256 = "8a847a5df1626fdde4f99d142ba52b0d6f29610657eff74e8fd8f261dca4c751"
REQUIRED_POLICY_SOURCES = [
    "mobile/tools/verify-l32a-package-policy.py",
    "mobile/tools/verify-l30a-package-policy.py",
    "mobile/tests/verify-local-ai-worker-route.mjs",
    BROWSER_AUDIT_RELATIVE,
    "mobile/tools/verify-l28a-package-policy.py",
    "mobile/tools/verify-l29f-package-policy.py",
    "mobile/tests/verify-l27f-ultimate-admission.mjs",
    "mobile/tests/verify-session-integration.mjs",
    "mobile/tests/verify-harmony-host-recovery.mjs",
    "mobile/harmony/entry/src/main/ets/bridge/HostContentRecovery.ets",
    "web/web前端/tests/verify-local-runtime-loaders.mjs",
    "web/web前端/tests/verify-territory-v3.mjs",
    "web/web前端/tests/verify-guide-content.mjs",
    "web/web前端/tests/verify-territory-pool.mjs",
    "web/web前端/tests/verify-replay-codec.mjs",
    "mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java",
    "mobile/harmony/entry/src/main/ets/pages/Index.ets",
    "mobile/tests/verify-tutorial-host.mjs",
    "web/web前端/tests/fixtures/minimax-defense.json",
    "web/web前端/tests/verify-ai-control-flow.mjs",
    "web/web前端/tests/verify-ai-search-15.mjs",
    "web/web前端/tests/verify-minimax-defense.mjs",
    "web/web前端/tests/verify-minimax-defense-invariants.mjs",
]


def verify_v3_rule_markers(game_engine: bytes, guide_content: bytes, label: str) -> None:
    require_text_markers(
        game_engine,
        [
            "Count friendly points plus enemy-free pockets cut off by friendly points.",
            "open chains, several pockets and ring-shaped structures with holes",
            "area: this._computeOwnedWallArea(ownedPoints, enemyPoints)",
            "displayArea: territory.polygon ? territory.displayArea : ownedPoints.length",
        ],
        f"{label} territory-v3 multi-pocket scoring and displayArea separation",
    )
    require_text_markers(
        guide_content,
        [
            "Every enemy-free pocket cut off from the board exterior by friendly points also counts",
            "pockets containing an enemy are excluded",
            "multiple pockets and donut holes are evaluated separately",
            "Each point counts once",
            "does not determine the official score",
            "含敌方元素的空腔不计",
            "同一格点只算一次",
        ],
        f"{label} territory-v3 guide semantics",
    )


def run_self_test() -> None:
    engine = b"Count friendly points plus enemy-free pockets cut off by friendly points. open chains, several pockets and ring-shaped structures with holes area: this._computeOwnedWallArea(ownedPoints, enemyPoints) displayArea: territory.polygon ? territory.displayArea : ownedPoints.length"
    guide_text = "Every enemy-free pocket cut off from the board exterior by friendly points also counts; pockets containing an enemy are excluded; multiple pockets and donut holes are evaluated separately. Each point counts once. The displayed outline (displayArea) is for presentation and does not determine the official score. 含敌方元素的空腔不计。同一格点只算一次。"
    guide = guide_text.encode("utf-8")
    verify_v3_rule_markers(engine, guide, "fixture")
    negative_markers = [
        ("English enemy-pocket exclusion", "pockets containing an enemy are excluded"),
        ("English unique-point scoring", "Each point counts once"),
        ("Chinese enemy-pocket exclusion", "含敌方元素的空腔不计"),
        ("Chinese unique-point scoring", "同一格点只算一次"),
        ("displayArea presentation-only", "does not determine the official score"),
    ]
    for label, marker in negative_markers:
        negative_guide = guide.replace(marker.encode("utf-8"), b"removed semantic marker")
        try:
            verify_v3_rule_markers(engine, negative_guide, f"negative fixture: {label}")
        except RuntimeError:
            continue
        raise RuntimeError(f"V3 verifier self-test accepted missing guide marker: {label}")
    r14 = {"runtime_asset_version": "20261024-l32a1", "current_web_sync_release_id": "web-current-sync-20261024-r14"}
    runtime = {"runtime_asset_version": "20261024-l32a1"}
    sync = {"release_id": "web-current-sync-20261024-r14", "asset_version": "20261024-current14"}
    verify_r14_release_identity(r14, runtime, sync)
    try:
        verify_r14_release_identity(
            {**r14, "current_web_sync_release_id": "web-current-sync-20261024-r13"},
            {"runtime_asset_version": "20261024-l30a1"},
            {**sync, "release_id": "web-current-sync-20261024-r13", "asset_version": "20261024-current13"},
        )
    except RuntimeError:
        pass
    else:
        raise RuntimeError("R14 verifier self-test accepted the historical R13 identity")
    internal_records = [{
        "path": name,
        "source_sha256": digest,
        "classification": "bundle_internal_source",
        "bundle": "MultiplayerHardAIWorker.bundle.mjs",
        "packaged": False,
        "reason": "Self-test bundle-internal source.",
    } for name, digest in BUNDLE_INTERNAL_SOURCES.items()]
    hard_sync = {
        "source_files": {name: digest for name, (digest, _size) in ADMITTED_HARD_RESOURCES.items()},
        "bundle_internal_sources": internal_records,
    }
    hard_runtime = {
        "files": list(ADMITTED_HARD_RESOURCES),
        "bundle_internal_sources": internal_records,
    }
    verify_hard_manifest_records(hard_sync, hard_runtime)
    rejected_runtime = {**hard_runtime, "files": hard_runtime["files"] + [next(iter(BUNDLE_INTERNAL_SOURCES))]}
    try:
        verify_hard_manifest_records(hard_sync, rejected_runtime)
    except RuntimeError:
        pass
    else:
        raise RuntimeError("R14 verifier self-test accepted a standalone bundle-internal source")
    bad_records = [{**item} for item in internal_records]
    bad_records[0]["source_sha256"] = "0" * 64
    try:
        verify_hard_manifest_records(
            {**hard_sync, "bundle_internal_sources": bad_records},
            {**hard_runtime, "bundle_internal_sources": bad_records},
        )
    except RuntimeError:
        pass
    else:
        raise RuntimeError("R14 verifier self-test accepted a changed bundle-internal source hash")


def verify_r14_release_identity(receipt: dict, runtime: dict, sync: dict) -> None:
    require(receipt.get("runtime_asset_version") == runtime.get("runtime_asset_version") == "20261024-l32a1",
            "Runtime asset version is not bound to the reviewed L32-A R14 build")
    require(receipt.get("current_web_sync_release_id") == sync.get("release_id") == "web-current-sync-20261024-r14",
            "Current Web sync release is not bound to R14")
    require(sync.get("asset_version") == "20261024-current14",
            "Current Web sync asset version is not bound to current14")


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


def require_replay_export_policy(payload: bytes, label: str) -> None:
    source = payload.decode("utf-8-sig", errors="replace")
    patterns = {
        "export generation state": r"let\s+replayExportGeneration\s*=\s*0\s*;",
        "export busy ownership state": r"let\s+replayExportOwnsBusy\s*=\s*false\s*;",
        "duplicate export rejection": r"if\s*\(\s*appDisposed\s*\|\|\s*replayBusy\.value\s*\)\s*return\s+false\s*;",
        "generation-owned export request": r"const\s+requestGeneration\s*=\s*\+\+replayExportGeneration\s*;",
        "current export owner guard": r"const\s+isCurrent\s*=\s*\(\)\s*=>\s*!appDisposed\s*&&\s*replayExportOwnsBusy\s*&&\s*requestGeneration\s*===\s*replayExportGeneration\s*;",
        "export busy acquisition": r"replayExportOwnsBusy\s*=\s*true\s*;\s*replayBusy\.value\s*=\s*true\s*;",
        "import respects another replay busy owner": r"const\s+busyOwnedElsewhere\s*=\s*replayBusy\.value\s*&&\s*!replayImportOwnsBusy\s*;",
        "export invalidation advances generation": r"const\s+invalidateReplayExport\s*=\s*\(\)\s*=>\s*\{\s*replayExportGeneration\s*(?:\+\+|\+=\s*1)\s*;",
        "unmount invalidates export after disposal": r"onBeforeUnmount\s*\(\s*\(\)\s*=>\s*\{\s*appDisposed\s*=\s*true\s*;[\s\S]{0,2500}?invalidateReplayExport\s*\(\s*\)\s*;",
        "late export completion isolation": r"if\s*\(\s*requestGeneration\s*===\s*replayExportGeneration\s*&&\s*replayExportOwnsBusy\s*\)\s*\{\s*replayExportOwnsBusy\s*=\s*false\s*;\s*replayBusy\.value\s*=\s*false\s*;",
    }
    missing = [name for name, pattern in patterns.items()
               if re.search(pattern, source) is None]
    require(not missing, f"{label} lacks replay export/share ownership policy: {missing}")
    stale_guards = re.findall(r"if\s*\(\s*!isCurrent\(\)\s*\)\s*return\s+false\s*;", source)
    require(len(stale_guards) >= 2,
            f"{label} does not isolate late replay export preparation and share results")


def require_minimax_policy(payload: bytes, label: str) -> None:
    require_text_markers(
        payload,
        [
            "const MINIMAX_WEIGHTS = Object.freeze({",
            "rootRiskAversion: 1.5",
            "function immediateRiskPenalty(engine, player, previousOpponentMaterial)",
            "function evaluateMinimax(engine, player)",
            "function orderMinimaxMoves(engine, moves, player)",
            "export { GreedyAI, MCTSAI, MinimaxAI, MINIMAX_WEIGHTS, evaluate, evaluateMinimax, fastTerritoryBFS, saveState, restoreState };",
        ],
        f"{label} Minimax behavior",
    )
    source = payload.decode("utf-8-sig", errors="replace")
    require(re.search(r"immediateRiskPenalty\(engine,\s*aiPlayer,\s*previousOpponentMaterial\)", source) is not None,
            f"{label} root move scoring omits immediate opponent-risk evaluation")
    require(re.search(r"score\s*-\s*MINIMAX_WEIGHTS\.rootRiskAversion\s*\*\s*immediateRisk", source) is not None,
            f"{label} root risk aversion is not applied to candidate scores")


def require_tutorial_policy(payload: bytes, label: str) -> None:
    require_text_markers(
        payload,
        [
            "getAll(\"tutorial\").length === 1",
            "get(\"tutorial\") === \"1\"",
            "tutorialPolicy.content = \"connect-src 'none'\"",
        ],
        f"{label} standalone tutorial policy",
    )


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


def verify_hard_manifest_records(sync: dict, runtime: dict) -> list[dict]:
    runtime_files = set(runtime.get("files", []))
    sync_files = sync.get("source_files", {})
    for name in ADMITTED_HARD_RESOURCES:
        require(name in runtime_files and name in sync_files,
                f"Admitted Hard resource is missing from a package manifest: {name}")
    records = sync.get("bundle_internal_sources", [])
    require(records == runtime.get("bundle_internal_sources", []),
            "Bundle-internal source records differ between manifests")
    require(isinstance(records, list) and len(records) == len(BUNDLE_INTERNAL_SOURCES),
            "Bundle-internal source inventory has the wrong size")
    indexed = {item.get("path"): item for item in records if isinstance(item, dict)}
    require(len(indexed) == len(records) and set(indexed) == set(BUNDLE_INTERNAL_SOURCES),
            "Bundle-internal source inventory has missing or duplicate paths")
    for name, expected_hash in BUNDLE_INTERNAL_SOURCES.items():
        item = indexed[name]
        require(item.get("source_sha256") == expected_hash,
                f"Bundle-internal source hash changed: {name}")
        require(item.get("classification") == "bundle_internal_source"
                and item.get("bundle") == "MultiplayerHardAIWorker.bundle.mjs"
                and item.get("packaged") is False
                and isinstance(item.get("reason"), str) and item["reason"].strip(),
                f"Bundle-internal source policy changed: {name}")
        require(name not in runtime_files and name not in sync_files,
                f"Bundle-internal source entered a standalone package manifest: {name}")
    return records


def verify_browser_audit(repo_root: Path) -> dict:
    audit_path = repo_root / BROWSER_AUDIT_RELATIVE
    require(audit_path.is_file(), f"Saved browser audit is missing: {audit_path}")
    require(sha256_file(audit_path) == BROWSER_AUDIT_SHA256,
            "Saved browser audit SHA-256 changed")
    audit = json.loads(audit_path.read_text(encoding="utf-8-sig"))
    require(audit.get("schema") == "lifeline-hard-rules-browser-static-audit-v1"
            and audit.get("status") == "PASS_SAVED_BROWSER_CONTRACT_AUDIT"
            and audit.get("browserReportedStatus") == "PASS_HARD_DUAL_RULES_BROWSER_SMOKE",
            "Saved browser audit status or schema changed")
    require(audit.get("bundleSha256") == ADMITTED_HARD_RESOURCES["MultiplayerHardAIWorker.bundle.mjs"][0]
            and audit.get("timingClaim") is False,
            "Saved browser audit bundle binding or timing boundary changed")
    source_checks = audit.get("sourceChecks", {})
    require(source_checks.get("frozenSources") == 68
            and source_checks.get("allFrozenHashesMatch") is True
            and source_checks.get("allCurrentOriginalHashesMatch") is True
            and source_checks.get("buildDependenciesMatch") is True
            and source_checks.get("factoryCacheTag") == "20261024-v3-pocket1"
            and source_checks.get("bundleAndNodeVerificationShareBuild") is True,
            "Saved browser audit source checks changed")
    expected_contexts = [(3, "territory-v3"), (4, "territory-v3"), (5, "territory-v3"),
                         (6, "territory-v3"), (6, "territory-v2")]
    rows = audit.get("rows", [])
    require([(row.get("playerCount"), row.get("rulesVersion")) for row in rows] == expected_contexts,
            "Saved browser audit context matrix changed")
    for row in rows:
        require(row.get("messageTypes") == ["READY", "RESULT"]
                and row.get("reportedNativeLegal") is True
                and row.get("modelId") == "multiplayer-hard-v1"
                and row.get("terminalEvaluation") == f"native-{row.get('rulesVersion')}"
                and row.get("timingClaim") is False,
                "Saved browser audit row no longer proves the bounded READY/RESULT contract")
    lifetime = audit.get("lifetime", {})
    require(lifetime.get("reason") == "STOP" and lifetime.get("stoppedBeforeDeadline") is True,
            "Saved browser audit lifetime boundary changed")
    evidence = {str(row.get("path", "")).replace("\\", "/").rsplit("/", 1)[-1]: row.get("sha256")
                for row in audit.get("evidence", [])}
    require(evidence.get("browser-report.json") == BROWSER_REPORT_SHA256,
            "Saved browser audit no longer binds the reviewed browser report")
    require(audit.get("buildReceipt", {}).get("sha256") == HARD_BUILD_RECEIPT_SHA256,
            "Saved browser audit no longer binds the reviewed Hard build receipt")
    return {"sha256": BROWSER_AUDIT_SHA256, "rowCount": len(rows),
            "browserReportedStatus": audit["browserReportedStatus"], "timingClaim": False}


def verify_hard_payloads(factory: bytes, bundle: bytes, manifest_bytes: bytes, online_app: bytes, label: str) -> dict:
    require(sha256_bytes(factory) == ADMITTED_HARD_RESOURCES["LocalAIWorkerFactory.js"][0],
            f"{label} LocalAIWorkerFactory.js SHA-256 changed")
    require(sha256_bytes(bundle) == ADMITTED_HARD_RESOURCES["MultiplayerHardAIWorker.bundle.mjs"][0],
            f"{label} Hard Worker bundle SHA-256 changed")
    require(sha256_bytes(manifest_bytes) == ADMITTED_HARD_RESOURCES["MultiplayerHardAIWorker.bundle.manifest.json"][0],
            f"{label} Hard Worker manifest SHA-256 changed")
    require_text_markers(factory, [
        './AIWorker.js?v=20261024-l32a1',
        './MultiplayerHardAIWorker.bundle.mjs?v=20261024-v3-pocket1',
        '["territory-v2", "territory-v3"]',
        'profile.modelId === "multiplayer-hard-v1"',
        '{ type: "module" }',
    ], f"{label} Hard Worker factory route")
    require_text_markers(online_app, [
        'import { createLocalAIWorker } from "./LocalAIWorkerFactory.js?v=20261024-l32a1";',
        'const worker = createLocalAIWorker(controller.value?.engine,',
        'APP_ALL_PLAYERS.slice(0, activeSoloSettings.value.playerCount).map(player => selectedAiProfile(player))',
        'if (!appDisposed && (!isMobileShell() || mobileAppActive) && !aiWorker && canRunLocalAI())',
        'if (appDisposed || aiWorker !== worker || (isMobileShell() && !mobileAppActive)) return;',
    ], f"{label} mobile Hard Worker route and lifecycle guards")
    manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
    require(manifest.get("schema") == "lifeline-application-hard-worker-bundle-v1"
            and manifest.get("publicModelId") == "multiplayer-hard-v1"
            and manifest.get("implementationId") == "multiplayer-hard-heuristic-deadline-v2"
            and manifest.get("bundleSha256") == sha256_bytes(bundle)
            and manifest.get("bundleBytes") == len(bundle)
            and manifest.get("verified") is False,
            f"{label} Hard Worker bundle manifest changed")
    for name, expected_hash in BUNDLE_INTERNAL_SOURCES.items():
        require(manifest.get("sourceHashes", {}).get(name) == expected_hash,
                f"{label} Hard Worker manifest source hash changed: {name}")
    return {"bundleSha256": sha256_bytes(bundle), "manifestSha256": sha256_bytes(manifest_bytes),
            "factorySha256": sha256_bytes(factory), "publicModelId": manifest["publicModelId"],
            "implementationId": manifest["implementationId"], "manifestVerifiedField": False}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--hap", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--sync-manifest", type=Path)
    parser.add_argument("--runtime-manifest", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        run_self_test()
        print("PASS_L32A_PACKAGE_POLICY_SELF_TEST")
        return 0
    require(all([args.apk, args.hap, args.receipt, args.sync_manifest, args.runtime_manifest]),
            "APK, HAP, receipt, sync manifest, and runtime manifest are required")
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
    repo_root = Path(__file__).resolve().parents[2]
    web_root = repo_root / "web" / "web前端"
    dist_root = repo_root / "mobile" / "dist"
    require(receipt.get("schema") == "lifeline-mobile-web-build-v1", "Unexpected Mobile Web build receipt schema")
    require(receipt.get("status") == "PASS-CURRENT", "Mobile Web build receipt is not current PASS")
    verify_r14_release_identity(receipt, runtime, sync)
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
                f"Build receipt does not bind required L32-A policy source: {relative}")

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
    require(wired == [] and unwired == [],
            "R14 has no unqualified live Hard exclusions; admitted resources and bundle internals use explicit inventories")
    bundle_internal_records = verify_hard_manifest_records(sync, runtime)
    for name, (expected_hash, expected_bytes) in ADMITTED_HARD_RESOURCES.items():
        source_path = web_root / name
        dist_path = dist_root / name
        require(source_path.is_file() and dist_path.is_file(), f"Admitted Hard resource is missing: {name}")
        require(source_path.stat().st_size == expected_bytes and dist_path.stat().st_size == expected_bytes,
                f"Admitted Hard resource byte length changed: {name}")
        require(sha256_file(source_path) == expected_hash and sha256_file(dist_path) == expected_hash,
                f"Admitted Hard resource hash changed: {name}")
        require(source_rows.get(f"web/web前端/{name}") == expected_hash,
                f"Build receipt does not bind the admitted Hard resource: {name}")
    for name in BUNDLE_INTERNAL_SOURCES:
        require(not (web_root / name).exists() and not (dist_root / name).exists(),
                f"Bundle-internal source was copied as a standalone mobile resource: {name}")
    browser_evidence = verify_browser_audit(repo_root)

    dist_rows = receipt.get("dist_files")
    require(isinstance(dist_rows, list) and dist_rows,
            "Build receipt contains no Web resources")
    require(len(dist_rows) == receipt.get("dist_file_count"), "Receipt does not enumerate every built Web resource")
    require(len(dist_rows) == EXPECTED_WEB_RESOURCE_COUNT,
            f"L32-A requires exactly {EXPECTED_WEB_RESOURCE_COUNT} Web resources, receipt has {len(dist_rows)}")
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
            packaged_web_resources = {
                name[len(prefix):] for name in members
                if name.startswith(prefix) and name[len(prefix):] and not name.endswith("/")
            }
            expected_package_resources = set(dist_hashes)
            if label == "APK":
                expected_package_resources.update(CAPACITOR_EXTRA_RESOURCES)
            require(packaged_web_resources == expected_package_resources,
                    f"{label} Web resource inventory differs from the {len(dist_hashes)}-resource receipt"
                    f" (plus known Capacitor APK extras): "
                    f"missing={sorted(expected_package_resources - packaged_web_resources)}, "
                    f"extra={sorted(packaged_web_resources - expected_package_resources)}")
            for relative, expected_hash in dist_hashes.items():
                payload = read_zip_member(archive, prefix + relative, label)
                require(sha256_bytes(payload) == expected_hash,
                        f"{label} Web resource hash mismatch: {prefix + relative}")
            internal_members = [name for name in members if PurePosixPath(name).name in BUNDLE_INTERNAL_SOURCES]
            require(not internal_members, f"{label} contains standalone bundle-internal sources: {internal_members}")
            hard_payloads = {}
            for name, (expected_hash, expected_bytes) in ADMITTED_HARD_RESOURCES.items():
                payload = read_zip_member(archive, prefix + name, label)
                require(len(payload) == expected_bytes and sha256_bytes(payload) == expected_hash,
                        f"{label} admitted Hard resource changed: {name}")
                hard_payloads[name] = payload

            game_engine = read_zip_member(archive, prefix + "GameEngine.js", label)
            require_text_markers(game_engine, ["territory-v1", "territory-v2", "territory-v3"],
                                 f"{label} versioned territory rule engine")
            verify_v3_rule_markers(
                game_engine,
                read_zip_member(archive, prefix + "GuideContent.js", label),
                f"{label} packaged",
            )
            replay_codec = read_zip_member(archive, prefix + "ReplayCodec.js", label)
            require_text_markers(replay_codec, ["SUPPORTED_RULES", "territory-v1", "territory-v2",
                                                "territory-v3", "validateReplayDocument", "new GameEngine"],
                                 f"{label} versioned replay codec")
            ai_engine = read_zip_member(archive, prefix + "AIEngine.js", label)
            require_minimax_policy(ai_engine, f"{label} packaged AIEngine.js")
            tutorial_host = read_zip_member(archive, prefix + "platform/TutorialHost.js", label)
            require_text_markers(
                tutorial_host,
                [
                    "export function createTutorialTarget(currentHref)",
                    "target.searchParams.set('tutorial', '1')",
                    "platform.openTutorial(target)",
                    "open(target, '_blank', 'noopener')",
                ],
                f"{label} packaged platform/TutorialHost.js",
            )
            mobile_entry = read_zip_member(archive, prefix + "mobile-entry.js", label)
            require_tutorial_policy(mobile_entry, f"{label} packaged mobile-entry.js")
            online_app = read_zip_member(archive, prefix + "OnlineApp.js", label)
            require_text_markers(
                online_app,
                [
                    "startNativeNetworkRecovery",
                    "stopNativeNetworkRecovery",
                    "subscribeNetworkStatus",
                    "lastExplicitNativeNetworkAvailability",
                    "retryContributions();",
                    "if (pendingRoomReconnect) startPendingRoomReconnect();",
                    "else if (roomStatus.value === \"offline\") scheduleReconnect();",
                    "System availability is only a retry signal.",
                ],
                f"{label} native network recovery consumption path",
            )
            require_replay_export_policy(online_app, f"{label} packaged OnlineApp.js")
            hard_policy = verify_hard_payloads(
                hard_payloads["LocalAIWorkerFactory.js"],
                hard_payloads["MultiplayerHardAIWorker.bundle.mjs"],
                hard_payloads["MultiplayerHardAIWorker.bundle.manifest.json"],
                online_app,
                f"{label} packaged",
            )
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
                "web_resource_manifest_sha256": receipt.get("dist_manifest_sha256"),
                "admitted_hard_resources": hard_policy,
                "bundle_internal_source_count": len(BUNDLE_INTERNAL_SOURCES),
                "bundle_internal_sources_absent": sorted(BUNDLE_INTERNAL_SOURCES),
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
        tutorial_dex_markers = [
            "LifelineTutorialHostPlugin",
            "Only a same-origin tutorial URL may be opened.",
            "connect-src 'none'",
        ]
        tutorial_dex_match = next((name for name in dex_entries
                                   if all(marker.encode("utf-8") in apk.read(name)
                                          for marker in tutorial_dex_markers)), None)
        require(tutorial_dex_match is not None,
                "APK DEX lacks the tutorial-host class, same-origin rejection, or restrictive CSP marker")

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
        watchdog_markers = [
            "HostContentRecovery",
            "MAIN_PAGE_LOAD_TIMEOUT_MS",
            "RECOVERY_PAGE_LOAD_TIMEOUT_MS",
            "主页面加载超时",
            "恢复页面加载超时",
            "LIFELINE recovery page load timed out.",
            "pages/HostRecovery",
        ]
        watchdog_match = None
        for name in abc_entries:
            payload = hap.read(name)
            if all(marker.encode("utf-8") in payload for marker in watchdog_markers):
                watchdog_match = name
                break
        require(watchdog_match is not None,
                "Harmony ABC lacks the bounded main/recovery-page watchdog markers")
        tutorial_abc_markers = ["tutorialController", "Tutorial network access is disabled."]
        tutorial_abc_match = next((name for name in abc_entries
                                   if all(marker.encode("utf-8") in hap.read(name)
                                          for marker in tutorial_abc_markers)), None)
        require(tutorial_abc_match is not None,
                "Harmony ABC lacks the tutorial controller or fail-closed network interception marker")

    require(packages[0]["ultimate_model_manifest_sha256"] == packages[1]["ultimate_model_manifest_sha256"],
            "APK and HAP Ultimate model manifests differ")
    require(packages[0]["ultimate_model_asset_sha256"] == packages[1]["ultimate_model_asset_sha256"],
            "APK and HAP Ultimate F32 assets differ")
    result = {
        "schema": "lifeline-mobile-l32a-package-policy-v1",
        "status": "PASS_L32A_NATIVE_PACKAGE_POLICY",
        "reviewedPolicyBasis": "R14 Hard Worker admission layered over the retained L30-A resource, replay, recovery, admission, territory-v3, Minimax and tutorial checks",
        "receipt_sha256": sha256_bytes(receipt_bytes),
        "runtime_asset_version": runtime["runtime_asset_version"],
        "current_web_sync_release_id": sync["release_id"],
        "current_web_sync_asset_version": sync["asset_version"],
        "current_web_sync_manifest_sha256": sha256_file(sync_path),
        "runtime_source_manifest_sha256": sha256_file(runtime_path),
        "web_resource_count": len(dist_hashes),
        "web_resource_manifest_sha256": receipt.get("dist_manifest_sha256"),
        "wired_unqualified_hard_count": len(wired),
        "unwired_hard_worker_count": len(unwired),
        "admitted_hard_resources": {name: {"sha256": digest, "bytes": size}
                                    for name, (digest, size) in ADMITTED_HARD_RESOURCES.items()},
        "bundle_internal_sources": bundle_internal_records,
        "bundle_internal_sources_packaged": False,
        "browser_contract_evidence": browser_evidence,
        "hard_worker_claim_boundaries": {
            "strengthPreservationClaim": False,
            "timingClaim": False,
            "deviceRun": False,
            "bundleManifestVerifiedField": False,
        },
        "historical_r13_policy_source_bound": True,
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
        "native_network_recovery": {
            "packaged_for": ["APK", "HAP"],
            "subscription_marker": "subscribeNetworkStatus",
            "contribution_retry_marker": "retryContributions();",
            "room_recovery_markers": ["startPendingRoomReconnect", "scheduleReconnect"],
            "server_state_remains_authoritative": True,
        },
        "harmony_host_watchdog": {
            "abc_entry": watchdog_match,
            "main_page_timeout_ms": 15000,
            "recovery_page_timeout_ms": 10000,
            "late_callback_isolation_source_bound": True,
        },
        "minimax_package_policy": {
            "weight_table": "MINIMAX_WEIGHTS",
            "root_risk_aversion": "rootRiskAversion",
            "immediate_opponent_risk": "immediateRiskPenalty",
            "evaluation": "evaluateMinimax",
            "move_ordering": "orderMinimaxMoves",
            "exportedMinimaxWeightsAndEvaluation": True,
            "rootRiskAppliedToScoredMoves": True,
        },
        "tutorial_package_policy": {
            "hostModule": "platform/TutorialHost.js",
            "singleTutorialQueryParameterRequired": True,
            "connectSrcNone": True,
            "androidNativeHostSourceBound": True,
            "harmonyNativeHostSourceBound": True,
            "androidDexEntry": tutorial_dex_match,
            "androidDexMarkers": tutorial_dex_markers,
            "harmonyAbcEntry": tutorial_abc_match,
            "harmonyAbcMarkers": tutorial_abc_markers,
        },
        "territory_v3_package_policy": {
            "multiPocketAndDonutHoleScoring": True,
            "enemyOccupiedPocketsExcluded": True,
            "displayAreaIsPresentationOnly": True,
            "guideContentBoundInBothPackages": True,
        },
        "current_release_identity": {
            "runtime_asset_version": runtime.get("runtime_asset_version"),
            "sync_release_id": sync.get("release_id"),
            "sync_asset_version": sync.get("asset_version"),
            "sync_manifest_sha256": sha256_file(sync_path),
            "runtime_manifest_sha256": sha256_file(runtime_path),
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
        print(f"L32-A package policy rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
