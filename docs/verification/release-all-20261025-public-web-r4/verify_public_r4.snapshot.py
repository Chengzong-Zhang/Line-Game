"""Read-only HTTPS verification of the frozen r4 Web runtime.

The default invocation prepares a local plan without sending network requests.
Run with --execute only after the deployment owner confirms r4 activation.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
MANIFEST_SHA256 = "313ff7f9b09655b25479dad68734df6711c85d43c900f817ab0a261b404cd02a"
SCORING_SHA256 = "e044aa564abf799c324ba143ab8d392c9b853813f54137e1ecccf483b227e756"
RELEASE_ID = "web-all-features-20261025-r4"
ASSET_VERSION = "20261025-unified1"
EXPECTED_COUNT = 121


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_json(path: Path, payload: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def inventory() -> tuple[dict, dict[str, str]]:
    manifest_bytes = (ROOT / "web-release-manifest.json").read_bytes()
    if digest(manifest_bytes) != MANIFEST_SHA256:
        raise ValueError("Frozen manifest identity mismatch")
    original_source = ROOT.parent / "release-all-20261025-r4-frozen/payload/frontend/release-manifest.json"
    if digest(original_source.read_bytes()) != MANIFEST_SHA256:
        raise ValueError("Original r4 frozen source manifest identity mismatch")
    r3_bytes = (ROOT / "r3-web-release-manifest.json").read_bytes()
    if digest(r3_bytes) != "a99f981627c52861f244dca7e1487361dc6e4021e963769b270a2fdd7a632ad8":
        raise ValueError("Original r3 runtime evidence identity mismatch")
    original_r3 = json.loads(r3_bytes)
    manifest = json.loads(manifest_bytes)
    if manifest["runtime_files"] != original_r3["runtime_files"] or manifest["source_bytes"] != original_r3["source_bytes"]:
        raise ValueError("r4 runtime is no longer byte-identical to reviewed r3")
    if manifest.get("release_id") != RELEASE_ID or manifest.get("asset_version") != ASSET_VERSION:
        raise ValueError("Frozen release identity mismatch")
    files = manifest["runtime_files"]
    if files != manifest["files"] or len(files) != EXPECTED_COUNT:
        raise ValueError("Frozen runtime inventory mismatch")
    for name, expected in files.items():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
            raise ValueError("Unsafe manifest path")
        if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            raise ValueError("Invalid expected SHA-256")
    if digest((ROOT / "verify-live-scoring.mjs").read_bytes()) != SCORING_SHA256:
        raise ValueError("Existing scoring probe identity mismatch")
    return manifest, files


def download_one(base: str, name: str, expected: str, target: Path) -> dict:
    url = base + "/" + urllib.parse.quote(name, safe="/") + "?v=" + ASSET_VERSION
    row = {"path": name, "url": url, "expected_sha256": expected, "status": "FAIL"}
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={
            "User-Agent": "LIFELINE-Frozen-Release-ReadOnly-Verification/20261025-r4",
            "Cache-Control": "no-cache", "Pragma": "no-cache", "Accept-Encoding": "identity",
        })
        # Use a per-request direct opener. This only bypasses inherited proxy
        # settings in this verification process; standard TLS checks remain on.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=35) as response:
            final_url = response.geturl()
            if urllib.parse.urlsplit(final_url).netloc != urllib.parse.urlsplit(base).netloc:
                raise ValueError("Unexpected cross-origin redirect")
            if urllib.parse.urlsplit(final_url).scheme != "https":
                raise ValueError("Unexpected non-HTTPS response")
            row.update({"http_status": response.status, "final_url": final_url,
                "headers": {key: response.headers.get(key) for key in (
                    "Content-Type", "Content-Length", "Content-Encoding", "Cache-Control",
                    "ETag", "Last-Modified", "Date", "Content-Security-Policy")}})
            if response.status != 200:
                raise ValueError("HTTP status is not 200")
            payload = response.read(25 * 1024 * 1024 + 1)
            if len(payload) > 25 * 1024 * 1024:
                raise ValueError("Response exceeds the fixed verification size bound")
        path = target.joinpath(*PurePosixPath(name).parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        actual = digest(payload)
        row.update({"bytes": len(payload), "sha256": actual})
        if actual != expected:
            raise ValueError("Downloaded bytes differ from frozen manifest")
        row["status"] = "PASS"
    except Exception as error:
        row["error"] = f"{type(error).__name__}: {error}"
    row["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Fetch public HTTPS bytes after r4 activation")
    parser.add_argument("--base-url", default="https://lifelinegame.cn")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    manifest, files = inventory()
    base = args.base_url.rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("An HTTPS base URL without credentials, query or fragment is required")
    plan = {"status": "PREPARED_NOT_EXECUTED", "release_id": RELEASE_ID,
        "asset_version": ASSET_VERSION, "manifest_sha256": MANIFEST_SHA256,
        "frozen_source_manifest": str(ROOT.parent / "release-all-20261025-r4-frozen/payload/frontend/release-manifest.json"),
        "same_runtime_as_r3": True, "r3_manifest_sha256": "a99f981627c52861f244dca7e1487361dc6e4021e963769b270a2fdd7a632ad8",
        "scoring_probe_sha256": SCORING_SHA256, "expected_files": EXPECTED_COUNT,
        "expected_total_bytes": manifest["source_bytes"], "base_url": base,
        "network_route": "direct HTTPS; inherited proxies bypassed; TLS verification enabled",
        "scope": "Public HTTPS runtime bytes and 21 assertions on the downloaded GameEngine; no UI or device claim",
        "files": files}
    if not args.execute:
        save_json(ROOT / "prepared-plan.json", plan)
        print(json.dumps({key: value for key, value in plan.items() if key != "files"}, ensure_ascii=False))
        return 0
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run = ROOT / "runs" / (stamp + "-" + uuid.uuid4().hex[:8])
    run.mkdir(parents=True, exist_ok=False)
    target = run / "downloaded"
    target.mkdir()
    receipt = {key: value for key, value in plan.items() if key != "files"}
    receipt.update({"status": "RUNNING", "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "script_sha256": digest(Path(__file__).read_bytes()), "files": [],
        "no_deployment_or_account_mutations": True})
    save_json(run / "receipt.json", receipt)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(download_one, base, name, expected, target): name for name, expected in files.items()}
        for future in concurrent.futures.as_completed(pending):
            receipt["files"].append(future.result())
            save_json(run / "receipt.json", receipt)
    receipt["files"].sort(key=lambda row: row["path"])
    receipt["matched_files"] = sum(row["status"] == "PASS" for row in receipt["files"])
    receipt["downloaded_total_bytes"] = sum(row.get("bytes", 0) for row in receipt["files"])
    engine = next(row for row in receipt["files"] if row["path"] == "GameEngine.js")
    if engine["status"] == "PASS":
        command = [args.node, str(ROOT / "verify-live-scoring.mjs"), "--engine", str(target / "GameEngine.js")]
        try:
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=60)
            receipt["scoring"] = {"command": command, "exit_code": result.returncode,
                "stdout": result.stdout, "stderr": result.stderr,
                "status": "PASS" if result.returncode == 0 else "FAIL"}
        except Exception as error:
            receipt["scoring"] = {"status": "FAIL", "error": f"{type(error).__name__}: {error}"}
    else:
        receipt["scoring"] = {"status": "NOT_RUN_ENGINE_IDENTITY_FAILED"}
    passed = (receipt["matched_files"] == EXPECTED_COUNT
        and receipt["downloaded_total_bytes"] == manifest["source_bytes"]
        and receipt["scoring"]["status"] == "PASS")
    receipt["status"] = "PASS_PUBLIC_HTTPS_R4_BYTES_AND_V3_SCORING" if passed else "FAIL_PUBLIC_HTTPS_R4_VERIFICATION"
    receipt["completed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    save_json(run / "receipt.json", receipt)
    print(json.dumps({"status": receipt["status"], "matched_files": receipt["matched_files"],
        "downloaded_total_bytes": receipt["downloaded_total_bytes"], "scoring": receipt["scoring"],
        "receipt": str(run / "receipt.json")}, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
