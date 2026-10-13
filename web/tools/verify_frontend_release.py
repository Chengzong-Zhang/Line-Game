"""Verify the complete deployed runtime over certificate-checked public HTTPS."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import quote


def verify(bundle, base_url="https://lifelinegame.cn/"):
    manifest = json.loads((bundle / "release-manifest.json").read_text(encoding="utf-8"))

    def fetch(path):
        result = subprocess.run(["curl.exe", "--noproxy", "*", "--fail", "--silent", "--show-error",
            "--max-time", "30", "--header", "Cache-Control: no-cache", base_url + path], capture_output=True)
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
        "verified_epoch": time.time(), "files": rows, "health_ok": health.get("status") == "ok", "collector_enabled": collector.get("enabled"),
        "consent_policy": collector.get("consent_policy"), "status": "PASS_PUBLIC_HASH_AND_HEALTH" if passed else "FAIL"}
    (bundle / "public-after.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not passed:
        raise RuntimeError("Public runtime hash or health check failed")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.bundle.resolve())
    print(json.dumps({"status": result["status"], "files": len(result["files"]), "release_id": result["release_id"]}))
