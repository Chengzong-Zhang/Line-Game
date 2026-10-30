"""Verify the complete deployed runtime over certificate-checked public HTTPS."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import time
from urllib.parse import quote


def verify(bundle, base_url="https://lifelinegame.cn/", request_timeout=30, resolve=None):
    if not 30 <= request_timeout <= 300:
        raise ValueError('Request timeout must be between 30 and 300 seconds')
    manifest = json.loads((bundle / "release-manifest.json").read_text(encoding="utf-8"))
    curl = shutil.which('curl.exe') or shutil.which('curl')
    if not curl:
        raise RuntimeError('Certificate-checking curl is required')

    def fetch(path):
        result = subprocess.run([curl, "--noproxy", "*", "--fail", "--silent", "--show-error",
            "--max-time", str(request_timeout), "--header", "Cache-Control: no-cache",
            *(["--resolve", resolve] if resolve else []), base_url + path], capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
        return result.stdout

    def check(item):
        name, expected = item
        raw = fetch(quote(name, safe="/") + "?v=" + manifest["asset_version"])
        actual = hashlib.sha256(raw).hexdigest()
        return {"file": name, "bytes": len(raw), "sha256": actual, "expected_sha256": expected, "pass": actual == expected}

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(check, manifest["files"].items()))
    health = json.loads(fetch("api/health"))
    collector = json.loads(fetch("api/training/contributions/status"))
    passed = all(row["pass"] for row in rows) and health.get("status") == "ok" and collector.get("enabled") is True
    result = {"release_id": manifest["release_id"], "asset_version": manifest["asset_version"], "commit": manifest["commit"],
        "verified_epoch": time.time(), "curl_resolve": resolve, "request_timeout_seconds": request_timeout,
        "files": rows, "health_ok": health.get("status") == "ok", "collector_enabled": collector.get("enabled"),
        "consent_policy": collector.get("consent_policy"), "status": "PASS_PUBLIC_HASH_AND_HEALTH" if passed else "FAIL"}
    (bundle / "public-after.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not passed:
        raise RuntimeError("Public runtime hash or health check failed")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--request-timeout", type=int, default=30)
    parser.add_argument("--resolve", help="Optional curl DNS override; certificate hostname verification stays enabled")
    args = parser.parse_args()
    result = verify(args.bundle.resolve(), request_timeout=args.request_timeout, resolve=args.resolve)
    print(json.dumps({"status": result["status"], "files": len(result["files"]), "release_id": result["release_id"]}))
