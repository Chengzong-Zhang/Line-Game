"""Read-only HTTPS verification of a hash-bound multiplayer Web release.

Only frontend runtime files and public status endpoints are fetched. Backend
and tool hashes are compared as manifest declarations, never as live bytes.
Use --dry-run to inspect the request plan without contacting the deployment.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import time
from urllib.parse import quote, urlsplit


SCHEMA = {"name": "lifeline-multiplayer-release", "version": 1}
PREFIXES = {
    "frontend_files": "web/web前端/",
    "backend_files": "web/web后端/",
    "tool_files": "web/tools/",
}
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 2 * 1024 * 1024


class FetchError(Exception):
    """A bounded error code, without a response body or transport diagnostics."""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_manifest(manifest: dict) -> None:
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise ValueError("Unsupported release manifest schema.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", str(manifest.get("release_id", ""))):
        raise ValueError("Invalid release identity.")
    source = manifest.get("git")
    archive = manifest.get("archive")
    if not isinstance(source, dict) or not re.fullmatch(r"[a-f0-9]{40,64}", str(source.get("head", ""))):
        raise ValueError("Invalid source identity.")
    if not isinstance(archive, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(archive.get("sha256", ""))):
        raise ValueError("Invalid archive identity.")
    if not isinstance(manifest.get("defaults"), dict):
        raise ValueError("Missing model defaults.")
    for category, prefix in PREFIXES.items():
        files = manifest.get(category)
        if not isinstance(files, dict) or (category == "frontend_files" and not files):
            raise ValueError(f"Invalid {category} map.")
        for name, item in files.items():
            if (not isinstance(name, str) or not name.startswith(prefix)
                    or len(name) == len(prefix) or PurePosixPath(name).as_posix() != name
                    or any(part in {".", ".."} for part in name.split("/"))
                    or any(c in name for c in "\\?#%\r\n\x00")
                    or not isinstance(item, dict)
                    or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", "")))
                    or type(item.get("bytes")) is not int or not 0 <= item["bytes"] <= MAX_FILE_BYTES):
                raise ValueError(f"Invalid entry in {category}.")


def normalize_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or any(c.isspace() for c in value) or "\\" in value):
        raise ValueError("Base URL must be HTTPS without credentials, query, or fragment.")
    return value.rstrip("/") + "/"


def request_plan(manifest: dict, base_url: str) -> dict:
    validate_manifest(manifest)
    base = normalize_base_url(base_url)
    suffix = "?release=" + quote(manifest["release_id"], safe="")
    return {
        "frontend": {
            name: base + quote(name[len(PREFIXES["frontend_files"]):], safe="/") + suffix
            for name in sorted(manifest["frontend_files"])
        },
        "manifest": base + "release-manifest.json" + suffix,
        "health": base + "api/health" + suffix,
        "collector": base + "api/training/contributions/status" + suffix,
    }


def curl_fetcher(timeout: int = 20, attempts: int = 2):
    if not 1 <= timeout <= 60 or not 1 <= attempts <= 3:
        raise ValueError("Timeout must be 1-60 seconds and attempts must be 1-3.")
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise ValueError("curl is required for certificate-checked HTTPS verification.")

    def fetch(url: str, max_bytes: int) -> bytes:
        # --disable must be first: local curl configuration may otherwise alter
        # certificate verification, destination files, or response handling.
        command = [curl, "--disable", "--noproxy", "*", "--proto", "=https",
                   "--fail", "--silent", "--show-error", "--connect-timeout", str(min(10, timeout)),
                   "--max-time", str(timeout), "--max-filesize", str(max_bytes),
                   "--header", "Cache-Control: no-cache", "--header", "Pragma: no-cache",
                   "--write-out", "%{http_code}", "--url", url]
        error = "transport_error"
        for attempt in range(attempts):
            try:
                result = subprocess.run(command, capture_output=True, timeout=timeout + 3, check=False)
                if result.returncode:
                    error = f"curl_exit_{result.returncode}"
                elif result.stdout[-3:] != b"200":
                    error = "unexpected_http_status"
                elif len(result.stdout) - 3 > max_bytes:
                    error = "response_too_large"
                else:
                    return result.stdout[:-3]
            except subprocess.TimeoutExpired:
                error = "request_timeout"
            except OSError:
                error = "transport_unavailable"
            if attempt + 1 < attempts:
                time.sleep(0.5)
        # curl stderr and HTTP response bodies may contain private diagnostics.
        raise FetchError(error)

    return fetch


def verify_release(manifest: dict, base_url: str = "https://lifelinegame.cn/", *,
                   fetch=None, workers: int = 4, timeout: int = 20, attempts: int = 2) -> dict:
    plan = request_plan(manifest, base_url)
    if not 1 <= workers <= 8:
        raise ValueError("Workers must be 1-8.")
    fetch = fetch or curl_fetcher(timeout, attempts)

    def read_json(url):
        try:
            raw = fetch(url, MAX_JSON_BYTES)
            if len(raw) > MAX_JSON_BYTES:
                return None, "response_too_large"
            value = json.loads(raw)
            return (value, None) if isinstance(value, dict) else (None, "invalid_json_object")
        except FetchError as error:
            return None, str(error)
        except (ValueError, UnicodeError):
            return None, "invalid_json"

    def check_file(item):
        name, url = item
        expected = manifest["frontend_files"][name]
        try:
            raw = fetch(url, max(1, expected["bytes"] + 1))
            digest = sha(raw)
            return {"file": name, "bytes": len(raw), "sha256": digest,
                    "pass": len(raw) == expected["bytes"] and digest == expected["sha256"]}
        except FetchError as error:
            return {"file": name, "pass": False, "error": str(error)}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(check_file, plan["frontend"].items()))

    public, manifest_error = read_json(plan["manifest"])
    mismatches = []
    if public is not None:
        fields = ("schema", "release_id", "defaults", *PREFIXES)
        mismatches = [key for key in fields if public.get(key) != manifest[key]]
        for key, child in (("git", "head"), ("archive", "sha256")):
            section = public.get(key)
            if not isinstance(section, dict) or section.get(child) != manifest[key][child]:
                mismatches.append(f"{key}.{child}")
    public_ok = public is not None and not mismatches
    health, health_error = read_json(plan["health"])
    collector, collector_error = read_json(plan["collector"])
    health_ok = health is not None and health.get("status") == "ok"
    collector_ok = collector is not None and collector.get("enabled") is True
    passed = all(row["pass"] for row in rows) and public_ok and health_ok and collector_ok
    return {
        "schema": {"name": "lifeline-public-multiplayer-verification", "version": 1},
        "status": "PASS_PUBLIC_FRONTEND_AND_HEALTH" if passed else "FAIL",
        "release_id": manifest["release_id"], "source_head": manifest["git"]["head"],
        "archive_sha256": manifest["archive"]["sha256"],
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "base_url": normalize_base_url(base_url), "frontend_files": rows,
        "frontend_passed": sum(row["pass"] for row in rows), "frontend_total": len(rows),
        "public_manifest": {"pass": public_ok, "mismatched_fields": mismatches, "error": manifest_error},
        "health": {"pass": health_ok, "error": health_error},
        "collector": {"enabled": collector_ok, "error": collector_error},
        "backend_runtime": {"status": "NOT_PUBLICLY_VERIFIED", "declared_files": len(manifest["backend_files"])},
        "tool_runtime": {"status": "NOT_PUBLICLY_VERIFIED", "declared_files": len(manifest["tool_files"])},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path, help="directory containing release-manifest.json")
    parser.add_argument("--base-url", default="https://lifelinegame.cn/")
    parser.add_argument("--output", type=Path, help="optional compact JSON receipt; created exclusively")
    parser.add_argument("--dry-run", action="store_true", help="validate and display the plan without network requests")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--attempts", type=int, default=2)
    args = parser.parse_args()
    try:
        manifest = json.loads((args.bundle / "release-manifest.json").read_bytes())
        plan = request_plan(manifest, args.base_url)
        if args.output and args.output.exists():
            raise ValueError("Receipt output already exists; choose a new filename.")
        if args.dry_run:
            result = {"status": "PLAN_ONLY", "release_id": manifest["release_id"],
                      "network_requests_executed": 0, "planned_requests": len(plan["frontend"]) + 3,
                      "plan": plan, "backend_and_tools_fetched": False}
        else:
            result = verify_release(manifest, args.base_url, workers=args.workers,
                                    timeout=args.timeout, attempts=args.attempts)
        encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(encoded + "\n")
            print(json.dumps({key: result[key] for key in ("status", "release_id")}
                             | {"receipt": str(args.output)}, ensure_ascii=True))
        else:
            print(encoded)
        return int(result["status"] == "FAIL")
    except (ValueError, OSError) as error:
        # Do not echo malformed JSON, response text, credentials, or file bodies.
        print(json.dumps({"status": "ERROR", "error_type": type(error).__name__}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
