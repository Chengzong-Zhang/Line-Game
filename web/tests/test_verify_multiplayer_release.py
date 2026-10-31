"""Offline public-verifier fixtures: no live requests or deployment changes."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit


SPEC = importlib.util.spec_from_file_location(
    "verify_multiplayer_release", Path(__file__).resolve().parents[1] / "tools/verify_multiplayer_release.py"
)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


class PublicReleaseVerifierTests(unittest.TestCase):
    def setUp(self):
        self.assets = {
            "web/web前端/index.html": b"<html>fixture</html>\n",
            "web/web前端/guide/规则 fixture.md": "# 离线测试\n".encode(),
        }
        self.manifest = {
            "schema": verify.SCHEMA, "release_id": "fixture-20261021", "git": {"head": "a" * 40},
            "archive": {"sha256": "b" * 64},
            "defaults": {"three_player_model": "three-player-policy-v1", "hex_player_model": "hex-player-policy-v1"},
            "frontend_files": {name: {"sha256": verify.sha(data), "bytes": len(data)} for name, data in self.assets.items()},
            "backend_files": {"web/web后端/server.py": {"sha256": "c" * 64, "bytes": 123}},
            "tool_files": {"web/tools/online_bot_bridge.mjs": {"sha256": "d" * 64, "bytes": 456}},
        }
        self.responses = {"/" + name[len(verify.PREFIXES["frontend_files"]):]: data for name, data in self.assets.items()}
        self.responses.update({
            "/release-manifest.json": json.dumps(self.manifest).encode(),
            "/api/health": b'{"status":"ok","sensitiveWordsMasked":["PRIVATE_FIXTURE"],"sensitiveWordsFile":"PRIVATE_PATH"}',
            "/api/training/contributions/status": b'{"enabled":true,"private_detail":"PRIVATE_FIXTURE"}',
        })
        self.calls = []

    def fetch(self, url, max_bytes):
        parsed = urlsplit(url)
        self.calls.append((url, max_bytes))
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "example.test")
        self.assertEqual(parsed.query, "release=fixture-20261021")
        return self.responses[unquote(parsed.path)]

    def run_verifier(self):
        return verify.verify_release(self.manifest, "https://example.test", fetch=self.fetch)

    def test_exact_runtime_and_identity_pass_without_backend_fetch_or_private_output(self):
        result = self.run_verifier()
        self.assertEqual(result["status"], "PASS_PUBLIC_FRONTEND_AND_HEALTH")
        self.assertEqual(result["frontend_passed"], 2)
        self.assertEqual(result["backend_runtime"]["status"], "NOT_PUBLICLY_VERIFIED")
        self.assertEqual(result["tool_runtime"]["status"], "NOT_PUBLICLY_VERIFIED")
        self.assertEqual(len(self.calls), 5)
        self.assertFalse(any("server.py" in url or "bridge.mjs" in url for url, _ in self.calls))
        self.assertTrue(any("%20" in url and "%E8" in url for url, _ in self.calls))
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_byte_count_and_digest_both_required(self):
        name = "web/web前端/index.html"
        self.manifest["frontend_files"][name]["bytes"] += 1
        self.responses["/release-manifest.json"] = json.dumps(self.manifest).encode()
        result = self.run_verifier()
        row = next(row for row in result["frontend_files"] if row["file"] == name)
        self.assertEqual(row["sha256"], self.manifest["frontend_files"][name]["sha256"])
        self.assertFalse(row["pass"])
        self.assertEqual(result["status"], "FAIL")
        self.manifest["frontend_files"][name]["bytes"] -= 1
        self.responses["/index.html"] = b"x" * len(self.assets[name])
        self.responses["/release-manifest.json"] = json.dumps(self.manifest).encode()
        self.assertEqual(self.run_verifier()["status"], "FAIL")

    def test_wrong_release_default_archive_source_and_private_maps_fail(self):
        for field in ("release_id", "defaults", "frontend_files", "backend_files", "tool_files", "git", "archive"):
            with self.subTest(field=field):
                public = copy.deepcopy(self.manifest)
                public[field] = "wrong"
                self.responses["/release-manifest.json"] = json.dumps(public).encode()
                result = self.run_verifier()
                self.assertEqual(result["status"], "FAIL")
                self.assertFalse(result["public_manifest"]["pass"])
                self.assertTrue(result["public_manifest"]["mismatched_fields"])

    def test_health_and_collector_require_exact_values_and_redact_invalid_bodies(self):
        for path, body in (("/api/health", b'{"status":"down"}'),
                           ("/api/training/contributions/status", b'{"enabled":"true"}'),
                           ("/api/health", b"PRIVATE_FIXTURE not JSON"),
                           ("/release-manifest.json", b"[]")):
            with self.subTest(path=path, body=body):
                old = self.responses[path]
                self.responses[path] = body
                result = self.run_verifier()
                self.assertEqual(result["status"], "FAIL")
                self.assertNotIn("PRIVATE", json.dumps(result))
                self.responses[path] = old

    def test_fetch_failure_is_recorded_without_aborting_other_checks(self):
        def failed_asset(url, max_bytes):
            if urlsplit(url).path == "/index.html":
                raise verify.FetchError("request_timeout")
            return self.fetch(url, max_bytes)
        result = verify.verify_release(self.manifest, "https://example.test", fetch=failed_asset)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["frontend_passed"], 1)
        self.assertTrue(result["health"]["pass"])
        self.assertTrue(result["public_manifest"]["pass"])

    def test_bad_manifest_or_non_https_plan_rejected_before_network(self):
        bad_names = ["web/web前端/../server.py", "web/web前端//index.html", "web/web前端/%2e%2e/file", "/index.html", "web/web后端/server.py"]
        for name in bad_names:
            with self.subTest(name=name):
                manifest = copy.deepcopy(self.manifest)
                manifest["frontend_files"] = {name: {"sha256": "a" * 64, "bytes": 10}}
                with self.assertRaises(ValueError):
                    verify.verify_release(manifest, "https://example.test", fetch=self.fetch)
        for base in ("http://example.test", "https://name:password@example.test", "https://example.test/?token=secret"):
            with self.assertRaises(ValueError):
                verify.verify_release(self.manifest, base, fetch=self.fetch)
        for field in ("git", "archive"):
            manifest = copy.deepcopy(self.manifest)
            manifest[field] = None
            with self.assertRaises(ValueError):
                verify.request_plan(manifest, "https://example.test")
        self.assertFalse(self.calls)

    def test_curl_secure_options_timeout_retry_and_body_extraction(self):
        good = subprocess.CompletedProcess([], 0, b"fixture200", b"PRIVATE_STDERR")
        with patch.object(verify.shutil, "which", return_value="curl.exe"), \
                patch.object(verify.subprocess, "run", side_effect=[subprocess.TimeoutExpired("curl", 1), good]) as run, \
                patch.object(verify.time, "sleep"):
            fetch = verify.curl_fetcher(timeout=1, attempts=2)
            self.assertEqual(fetch("https://example.test/file", 50), b"fixture")
            self.assertEqual(run.call_count, 2)
            command = run.call_args.args[0]
            self.assertEqual(command[:2], ["curl.exe", "--disable"])
            self.assertEqual(command[command.index("--noproxy") + 1], "*")
            self.assertEqual(command[command.index("--proto") + 1], "=https")
            self.assertNotIn("--insecure", command)
            self.assertNotIn("--location", command)
            self.assertEqual(run.call_args.kwargs["timeout"], 4)

    def test_curl_retries_are_bounded_and_error_does_not_echo_body_or_stderr(self):
        bad = subprocess.CompletedProcess([], 22, b"PRIVATE_BODY", b"PRIVATE_STDERR")
        with patch.object(verify.shutil, "which", return_value="curl"), \
                patch.object(verify.subprocess, "run", return_value=bad) as run, \
                patch.object(verify.time, "sleep"):
            with self.assertRaisesRegex(verify.FetchError, "^curl_exit_22$"):
                verify.curl_fetcher(attempts=2)("https://example.test/file", 10)
            self.assertEqual(run.call_count, 2)
        for stdout, reason in ((b"{}302", "unexpected_http_status"), (b"oversized200", "response_too_large")):
            with patch.object(verify.shutil, "which", return_value="curl"), \
                    patch.object(verify.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout, b"")):
                with self.assertRaisesRegex(verify.FetchError, reason):
                    verify.curl_fetcher(attempts=1)("https://example.test/file", 2)

    def test_dry_run_has_no_network_and_preserves_existing_receipts(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-public-verifier-") as temp:
            root = Path(temp)
            (root / "release-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
            output = root / "plan.json"
            argv = ["verify", "--bundle", str(root), "--dry-run", "--output", str(output)]
            with patch("sys.argv", argv), patch.object(verify, "curl_fetcher") as network, patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(verify.main(), 0)
                network.assert_not_called()
                before = output.read_bytes()
                self.assertEqual(json.loads(before)["network_requests_executed"], 0)
                self.assertEqual(verify.main(), 2)
                self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
