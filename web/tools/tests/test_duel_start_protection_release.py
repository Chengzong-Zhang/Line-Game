"""Portable payload integrity fixtures, not product model admission evidence."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location(
    "duel_start_payload", TOOLS / "prepare_duel_start_protection_20261026.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def write(file, raw):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(raw if isinstance(raw, bytes) else raw.encode())


def encoded(body):
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()


class DuelStartPayloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix="duel-start-payload-fixture-",
            dir=TOOLS.parents[1] / "local_artifacts",
        )
        self.addCleanup(self.temp.cleanup)
        self.area = Path(self.temp.name)
        self.root, self.web, self.validator = (
            self.area / name for name in ("source", "web", "validator")
        )
        self.out = self.area / "output"
        self.head = "a" * 40
        self.before = self.area / "before.json"
        write(
            self.before,
            encoded({key: "b" * 64 for key in set(module.TARGETS) | module.TREE_KEYS}),
        )
        for name in set(module.SOURCES.values()) | {
            module.BUILDER,
            "wechat/minigame/src/state.js",
            "web/web前端/GameEngine.js",
            "wechat/minigame/tools/web-compat.mjs",
            "web/tools/atomic_frontend_release.py",
            "web/tools/deploy_duel_start_protection_20261026.py",
        }:
            write(self.root / name, "// fixture\n")
        native_name = "web/web前端/GameEngine.js"
        native_override = "wechat/minigame/compat/web/GameEngine.js"
        write(self.root / native_override, "// fixture native override\n")
        native_row = {
            "canonicalSha256": module.sha(self.root / native_name),
            "override": native_override,
            "overrideSha256": module.sha(self.root / native_override),
        }
        write(
            self.root / "wechat/minigame/compat/web/manifest.json",
            encoded(
                {
                    "schemaVersion": 1,
                    "overrides": {
                        native_name: {
                            **native_row,
                            "reason": "Fixture rationale is preserved in the source manifest.",
                        }
                    },
                }
            ),
        )
        write(self.root / "web/package.json", encoded({"type": "module"}))
        write(
            self.root / module.VERIFIER,
            (TOOLS / "verify-terminal-release-admission-v4.mjs").read_bytes(),
        )
        self.policy = {
            "schema": "lifeline-terminal-trained-policies-v4",
            "activation": "PASS_DISCIPLINE_SCOPED",
            "admission_report_sha256": module.digest(b"fixture admission"),
            "reward": {
                "gamma": 1,
                "nonterminal_reward": 0,
                "type": "terminal-outcome-native-margin-area-v1",
            },
            "models": {
                alias: {
                    "weights": [0.125] * 17,
                    "passBias": 0.125,
                    "candidate_sha256": module.digest(alias.encode()),
                }
                for alias in sorted(module.ALIASES)
            },
        }
        self.summary = {
            "schema": "lifeline-terminal-release-admission-v4",
            "status": "PASS_TERMINAL_RELEASE_ADMISSION_V4",
            "admission_report_sha256": self.policy["admission_report_sha256"],
            "verifier_sha256": module.sha(self.root / module.VERIFIER),
            "candidate_hashes": {
                alias: model["candidate_sha256"]
                for alias, model in self.policy["models"].items()
            },
            "runtime_parameters_sha256": {
                alias: module.digest(
                    encoded(
                        {
                            "weights": [0.125] * 16,
                            "passBias": 0.125,
                            "temperature": 1,
                            "rules_version": "territory-v3",
                        }
                    )
                )
                for alias in module.ALIASES
            },
            "scope": "Portable integrity fixture only, never product admission.",
        }
        self.web_seal()
        compiler = self.area / "tool"
        compiler_files = {
            "package": compiler / "node_modules/esbuild/package.json",
            "lock": compiler / "package-lock.json",
            "javascript": compiler / "node_modules/esbuild/lib/main.js",
            "binary": compiler / "node_modules/@esbuild/win32-x64/esbuild.exe",
        }
        for file in compiler_files.values():
            write(file, "fixture toolchain")
        names = {
            module.BUILDER,
            "wechat/minigame/tools/validate-action.mjs",
            "wechat/minigame/src/state.js",
            "web/web前端/GameEngine.js",
            "wechat/minigame/tools/web-compat.mjs",
            "wechat/minigame/compat/web/manifest.json",
            native_override,
        }
        raw = b"// fixture standalone validator\n"
        write(self.validator / "validate-action.mjs", raw)
        self.validator_manifest = {
            "schemaVersion": 1,
            "kind": "standalone-native-rule-validator-v2",
            "target": "node22",
            "compiler": "0.25.12",
            "bundleSha256": module.digest(raw),
            "bundleBytes": len(raw),
            "compilerHashes": {
                key: {"path": str(file), "sha256": module.sha(file)}
                for key, file in compiler_files.items()
            },
            "sourceHashes": {name: module.sha(self.root / name) for name in names},
            "nativeCompatibility": {native_name: native_row},
        }
        probes = {
            "status": "PASS_NODE22_CANONICAL_STATE_APPLY_2_6_7_15",
            "node": "v22.22.3",
            "bundleSha256": module.digest(raw),
            "records": [
                {"players": count, "kind": kind}
                for _ in range(3)
                for count in (2, 6, 7, 15)
                for kind in ("STATE", "APPLY")
            ],
        }
        write(self.validator / "verification.json", encoded(probes))
        self.validator_seal()

    def web_seal(self):
        policy_raw = (
            b"export const PASS_TRAINED_POLICY_DATA = Object.freeze("
            + encoded(self.policy)
            + b");\n"
        )
        write(self.root / "web/web前端/PassTrainedPolicyData.js", policy_raw)
        self.summary["policy_data_sha256"] = module.digest(policy_raw)
        self.summary.pop("summary_sha256", None)
        self.summary["summary_sha256"] = module.digest(encoded(self.summary))
        frontend = self.root / "web/web前端"
        files = {
            file.relative_to(frontend).as_posix(): module.sha(file)
            for file in frontend.rglob("*")
            if file.is_file()
        }
        self.envelope = {
            "release_id": module.RELEASE,
            "commit": self.head,
            "files": files,
            "terminal_trained_policy": self.policy,
            "terminal_admission": self.summary,
        }
        self.web_archive()

    def web_archive(self):
        raw = encoded(self.envelope)
        write(self.web / "release-manifest.json", raw)
        with zipfile.ZipFile(self.web / "frontend-overlay.zip", "w") as archive:
            archive.writestr("release-manifest.json", raw)
            for name in self.envelope["files"]:
                archive.writestr(name, (self.root / "web/web前端" / name).read_bytes())

    def validator_seal(self):
        write(self.validator / "manifest.json", encoded(self.validator_manifest))
        receipt = {
            "status": "BUILT_AND_VERIFIED_LOCAL_NOT_DEPLOYED",
            "probes": 24,
            "sourceCount": len(self.validator_manifest["sourceHashes"]),
            "nativeCompatibilityCount": len(
                self.validator_manifest["nativeCompatibility"]
            ),
            "compilerHashes": self.validator_manifest["compilerHashes"],
            **{
                key: {"sha256": module.sha(self.validator / name)}
                for key, name in (
                    ("bundle", "validate-action.mjs"),
                    ("manifest", "manifest.json"),
                    ("verification", "verification.json"),
                )
            },
        }
        write(self.validator / "build-receipt.json", encoded(receipt))

    def run_prepare(self):
        # Structural fixtures use tiny fake source/toolchain trees. The actual
        # source-closure rebuild is exercised separately against a real bundle.
        with (
            patch.object(module, "current_head", return_value=self.head),
            patch.object(module, "verify_validator_inputs"),
        ):
            return module.prepare(
                self.web,
                self.validator / "validate-action.mjs",
                self.before,
                self.out,
                root=self.root,
            )

    def rejects(self, message, exception=ValueError):
        with self.assertRaisesRegex(exception, message):
            self.run_prepare()
        self.assertFalse(self.out.exists())

    def test_fixed_inventory_and_all_payload_hashes(self):
        result = self.run_prepare()
        self.assertEqual(result["status"], "FROZEN_LOCAL_NOT_DEPLOYED")
        manifest = json.loads((self.out / "deployment-manifest.json").read_bytes())
        self.assertEqual(manifest["commit"], self.head)
        with zipfile.ZipFile(self.out / "payload.zip") as archive:
            self.assertEqual(
                set(archive.namelist()), set(module.TARGETS) | module.EXTRAS
            )
            self.assertEqual(len(archive.namelist()), 11)
            for name, digest in manifest["payload"].items():
                self.assertEqual(module.digest(archive.read(name)), digest)
        self.assertEqual(
            module.sha(self.out / "payload.zip"), manifest["archiveSha256"]
        )

    def test_existing_output_preserved(self):
        self.out.mkdir()
        write(self.out / "sentinel", "preserve")
        with self.assertRaisesRegex(ValueError, "new output"):
            self.run_prepare()
        self.assertEqual((self.out / "sentinel").read_text(), "preserve")

    def test_incomplete_before_snapshot_rejected(self):
        write(self.before, encoded({"siteTree": "b" * 64}))
        self.rejects("predecessor")

    def test_validator_byte_corruption_rejected(self):
        write(self.validator / "validate-action.mjs", "// changed")
        self.rejects("bundle/target/compiler")

    def test_compiler_hash_drift_rejected(self):
        write(
            Path(self.validator_manifest["compilerHashes"]["binary"]["path"]), "changed"
        )
        self.rejects("compiler hash changed")

    def test_compiler_secret_path_rejected_before_read(self):
        self.validator_manifest["compilerHashes"]["package"]["path"] = str(
            self.area / ".env"
        )
        self.validator_seal()
        self.rejects("compiler package path")

    def test_source_drift_rejected(self):
        write(self.root / "web/web前端/PassTrainedPolicyData.js", "// drift")
        self.rejects("frontend source/archive drift")

    def test_missing_frontend_file_rejected(self):
        self.envelope["files"].pop("GameEngine.js")
        self.web_archive()
        self.rejects("complete current runtime")

    def test_unexpected_frontend_archive_entry_rejected(self):
        with zipfile.ZipFile(self.web / "frontend-overlay.zip", "a") as archive:
            archive.writestr("unexpected", b"not in inventory")
        self.rejects("archive inventory/envelope")

    def test_evaluation_policy_rejected_after_resealing_web(self):
        self.policy["activation"] = "EVALUATION_ONLY"
        self.web_seal()
        self.rejects("scoped admission")

    def test_resealed_policy_weight_tampering_rejected(self):
        self.policy["models"]["hex-v1"]["weights"][0] += 0.125
        self.web_seal()
        self.rejects("", subprocess.CalledProcessError)

    def test_native_override_forgery_rejected(self):
        self.validator_manifest["nativeCompatibility"]["web/web前端/GameEngine.js"] = {
            "override": "fake"
        }
        self.validator_seal()
        self.rejects("native compatibility binding")

    def test_native_override_deletion_rejected_after_resealing(self):
        self.validator_manifest["nativeCompatibility"] = {}
        self.validator_seal()
        self.rejects("native compatibility inventory/count")

    def test_stale_frontend_commit_rejected(self):
        self.envelope["commit"] = "c" * 40
        self.web_archive()
        self.rejects("current HEAD mismatch")


class DeploymentProbeTests(unittest.TestCase):
    def test_actual_probe_binds_exemption_to_white_start_player(self):
        import deploy_duel_start_protection_20261026 as deploy

        repo = TOOLS.parents[1]
        expected_node = str(deploy.ARTIFACTS / "wechat-service-20261021/runtime/node")

        def local_node(*args, **kwargs):
            command = ("node", *args[1:]) if args and args[0] == expected_node else args
            if kwargs.get("text"):
                kwargs.setdefault("encoding", "utf-8")
            return subprocess.run(
                command,
                check=True,
                timeout=90,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                **kwargs,
            )

        with patch.object(deploy, "run", side_effect=local_node):
            evidence = deploy.probe(
                repo / "web", repo / "wechat/minigame/tools/validate-action.mjs"
            )
        self.assertEqual([row["players"] for row in evidence], [2, 6, 7, 15])
        duel = evidence[0]
        self.assertEqual(duel["startPlayer"], "WHITE")
        self.assertEqual(duel["protectionRule"], "duel-first-unprotected-v1")
        self.assertEqual(
            duel["rules"]["protectionProof"],
            {
                "startPlayer": "WHITE",
                "laterPlayer": "BLACK",
                "firstCanEnterLaterStartZone": False,
                "laterCanEnterFirstStartZone": True,
                "firstBlockedByLaterProtection": True,
                "laterBlockedByFirstProtection": False,
                "nextToLater": [1, 0],
                "nextToFirst": [3, 0],
            },
        )
        self.assertEqual(duel["rules"]["currentPlayer"], "BLACK")
        self.assertTrue(duel["rules"]["authoritativeValidatorMatched"])
        for row in evidence[1:]:
            self.assertEqual(row["protectionRule"], "symmetric-v1")
            self.assertIsNone(row["rules"]["protectionProof"])
            self.assertTrue(row["rules"]["authoritativeValidatorMatched"])


if __name__ == "__main__":
    unittest.main()
