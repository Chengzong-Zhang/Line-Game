"""Isolated fixtures for the read-only multiplayer release builder."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "prepare_multiplayer_release", Path(__file__).resolve().parents[1] / "tools/prepare_multiplayer_release.py"
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class MultiplayerReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lifeline-release-fixture-")
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.output = self.root / "build"
        self.frontend = self.root / release.FRONTEND
        self.frontend.mkdir(parents=True)
        for name in (*release.BACKEND_FILES, *release.TOOL_FILES, *release.FROZEN_SOURCES):
            self.write(name, "// frozen fixture source\n")
        models = {}
        for version in (1, 2, 3):
            name = f"three-player-policy-v{version}"
            raw = json.dumps({"id": name}).encode()
            self.write(f"web/web前端/assets/research-ai/{name}.json", raw)
            models[name] = release.sha(raw)
        self.write("web/web前端/assets/research-ai/hex-player-policy-v1.json", '{"id":"hex-player-policy-v1"}')
        self.write("web/web前端/ThreePlayerModels.js", "\n".join([
            'export const DEFAULT_THREE_PLAYER_MODEL_ID = "three-player-policy-v1";',
            "export const THREE_PLAYER_MODEL_HASHES = Object.freeze(" + json.dumps({key: value for key, value in models.items() if not key.endswith("v3")}) + ");",
        ]))
        self.write("web/web前端/LocalAIModes.js", '\n'.join([
            'if (config.choice === "three-player") return { modelId: "three-player-policy-v1" };',
            'if (config.choice === "hex-player") return { modelId: "hex-player-policy-v1" };',
        ]))
        self.write("web/web前端/index.html", '<script src="main.js?v=frozen-tag"></script>')
        self.write("web/web前端/main.js", 'import "./GameEngine.js?v=frozen-tag";\r\n')
        self.write("web/web前端/smoke-test.html", "excluded")
        self.write("web/web前端/tests/fixture.json", "{}")
        self.write("web/web前端/assets/research-ai/three-player-policy-v1.training-receipt.json", "{}")
        self.git = patch.object(release, "git", side_effect=lambda root, *args: {
            "rev-parse": "a" * 40, "branch": "codex/fixture", "status": " M fixture",
        }[args[0]])
        self.git.start()
        self.addCleanup(self.git.stop)

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else value.encode())
        return path

    def build(self, output=None):
        return release.prepare_release(self.root, output or self.output, "multiplayer-fixture")

    def test_exact_paths_hashes_defaults_and_no_source_mutation(self):
        before = {name: (self.root / name).read_bytes() for name in release.FROZEN_SOURCES}
        manifest = self.build()
        archive = self.output / manifest["archive"]["name"]
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            expected = set(manifest["frontend_files"]) | set(release.BACKEND_FILES) | set(release.TOOL_FILES)
            self.assertEqual(names, expected)
            self.assertTrue(all(name.startswith("web/") and ".." not in Path(name).parts for name in names))
            self.assertFalse(any("tests/" in name or "smoke-test" in name or "training-receipt" in name or "policy-v3" in name for name in names))
            self.assertIn("web/web前端/assets/research-ai/three-player-policy-v2.json", names)
            self.assertIn(b"?v=frozen-tag", bundle.read("web/web前端/main.js"))
            for category in ("frontend_files", "backend_files", "tool_files"):
                for name, item in manifest[category].items():
                    self.assertEqual(release.sha(bundle.read(name)), item["sha256"])
                    self.assertEqual(len(bundle.read(name)), item["bytes"])
        self.assertEqual(release.sha(archive.read_bytes()), manifest["archive"]["sha256"])
        self.assertEqual(manifest["defaults"]["three_player_model"], "three-player-policy-v1")
        self.assertEqual(manifest["frozen_source_sha256_before"], manifest["frozen_source_sha256_after"])
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in release.FROZEN_SOURCES})
        self.assertEqual(manifest["schema"], {"name": "lifeline-multiplayer-release", "version": 1})
        second = self.build(self.root / "second")
        self.assertEqual(manifest["archive"]["sha256"], second["archive"]["sha256"])
        with self.assertRaisesRegex(ValueError, "already exist"):
            self.build()

    def test_sensitive_names_and_unexpected_extensions_fail_before_output(self):
        for name in (".env", ".env.production", "local.sqlite3", "credentials.json", "tls.key", "id_rsa", "debug.log"):
            with self.subTest(name=name):
                path = self.write("web/web前端/" + name, "fixture")
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.output.exists())
                path.unlink()

    def test_private_key_payload_is_not_echoed(self):
        marker = "DO_NOT_ECHO_FIXTURE_PAYLOAD"
        self.write("web/web前端/innocent.js", "-----BEGIN OPENSSH PRIVATE KEY-----\n" + marker)
        with self.assertRaisesRegex(ValueError, "Private-key material") as raised:
            self.build()
        self.assertNotIn(marker, str(raised.exception))
        self.assertFalse(self.output.exists())

    def test_registered_model_hash_mismatch_rejected(self):
        self.write("web/web前端/assets/research-ai/three-player-policy-v2.json", '{"id":"three-player-policy-v2","changed":true}')
        with self.assertRaisesRegex(ValueError, "hash/identity"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_default_drift_rejected_without_rewriting(self):
        path = self.root / "web/web前端/LocalAIModes.js"
        changed = path.read_bytes().replace(b"three-player-policy-v1", b"three-player-policy-v2")
        path.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "Unexpected existing default"):
            self.build()
        self.assertEqual(path.read_bytes(), changed)
        self.assertFalse(self.output.exists())

    def test_source_output_location_rejected(self):
        with self.assertRaisesRegex(ValueError, "inside the frontend"):
            self.build(self.frontend / "generated-release")

    def test_concurrent_source_change_fails_without_verified_manifest(self):
        original = zipfile.ZipFile.writestr
        changed = False
        fixture = self

        def mutate(bundle, *args, **kwargs):
            nonlocal changed
            result = original(bundle, *args, **kwargs)
            if not changed:
                fixture.write(release.FROZEN_SOURCES[-1], "changed while packaging")
                changed = True
            return result

        with patch.object(zipfile.ZipFile, "writestr", mutate):
            with self.assertRaisesRegex(ValueError, "Frozen source changed"):
                self.build()
        self.assertFalse((self.output / "release-manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
