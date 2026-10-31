"""Local freeze and native Node probes; never contacts or changes a server."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'web/tools'
spec = importlib.util.spec_from_file_location('unified_deployment', TOOLS / 'deploy_unified_rooms_20261025.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class UnifiedReleasePreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='lifeline-unified-freeze-')
        cls.base = Path(cls.temp.name)
        cls.frontend = cls.base / 'frontend'; cls.frontend.mkdir()
        source = ROOT / 'web/web前端'
        files = {file.relative_to(source).as_posix(): file.read_bytes() for file in source.rglob('*') if file.is_file()
                 and not any(part.startswith('.') for part in file.relative_to(source).parts)
                 and not file.relative_to(source).as_posix().startswith('tests/') and file.name != 'smoke-test.html'}
        cls.envelope = {'release_id': deployment.RELEASE, 'commit': 'a' * 40,
                        'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}}
        raw = json.dumps(cls.envelope).encode()
        (cls.frontend / 'release-manifest.json').write_bytes(raw)
        with zipfile.ZipFile(cls.frontend / 'frontend-overlay.zip', 'x') as archive:
            archive.writestr('release-manifest.json', raw)
            for name, content in files.items(): archive.writestr(name, content)
        before = {key: None if key.endswith(('runtime', 'package')) else '0' * 64 for key in deployment.TARGETS}
        before.update(siteManifest='0' * 64, siteTree='1' * 64, wechatFrontendTree='2' * 64)
        cls.before = cls.base / 'before.json'; cls.before.write_text(json.dumps(before), encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def build(self, frontend=None, before=None, name='output'):
        return subprocess.run([sys.executable, str(TOOLS / 'prepare_unified_rooms_20261025.py'),
                               '--frontend', str(frontend or self.frontend), '--before', str(before or self.before),
                               '--output', str(self.base / name)], capture_output=True, text=True, encoding='utf-8')

    def test_freeze_inventory_native_modules_and_real_two_six_player_probes(self):
        result = self.build(name='valid-output')
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.base / 'valid-output'
        manifest = json.loads((output / 'deployment-manifest.json').read_text())
        self.assertEqual(manifest['archiveSha256'], deployment.sha(output / 'payload.zip'))
        self.assertEqual(manifest['deployerSha256'], deployment.sha(output / 'remote-release.py'))
        self.assertIsNone(manifest['before']['wechat-runtime'])
        with zipfile.ZipFile(output / 'payload.zip') as archive:
            self.assertEqual(set(archive.namelist()), set(deployment.TARGETS) | deployment.EXTRAS)
            for name, expected in manifest['payload'].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected)
            self.assertEqual(archive.read('legacy-runtime'), archive.read('wechat-runtime'))
            self.assertEqual(json.loads(archive.read('wechat-package'))['type'], 'module')
            probe = self.base / 'probe/web'; (probe / 'tools').mkdir(parents=True)
            for name, relative in [('wechat-bridge', 'tools/online_bot_bridge.mjs'), ('wechat-runtime', 'tools/online_bot_runtime.mjs'), ('wechat-package', 'package.json')]:
                (probe / relative).write_bytes(archive.read(name))
        with zipfile.ZipFile(self.frontend / 'frontend-overlay.zip') as archive:
            archive.extractall(probe / 'web前端')
        original_run = deployment.run
        deployment.run = lambda *args, **kwargs: original_run(shutil.which('node'), *args[1:], **kwargs)
        try:
            evidence = deployment.probe(probe, ROOT / 'wechat/minigame/tools/validate-action.mjs')
        finally:
            deployment.run = original_run
        self.assertEqual([entry['players'] for entry in evidence], [2, 6])
        self.assertEqual(evidence[0]['botProfile'], {'strategy': 'minimax', 'depth': 2})
        self.assertEqual(evidence[1]['modelInfo']['id'], 'multiplayer-easy-v1')
        self.assertTrue(all(entry['rules']['authoritativeValidatorMatched'] for entry in evidence))

    def test_incomplete_before_snapshot_is_rejected(self):
        path = self.base / 'bad-before.json'; path.write_text('{}')
        self.assertNotEqual(self.build(before=path, name='invalid-before').returncode, 0)
        self.assertFalse((self.base / 'invalid-before').exists())

    def test_tampered_runtime_and_duplicate_archive_are_rejected(self):
        for mutation in ('tampered', 'duplicate'):
            frontend = self.base / mutation; frontend.mkdir()
            shutil.copyfile(self.frontend / 'release-manifest.json', frontend / 'release-manifest.json')
            with zipfile.ZipFile(self.frontend / 'frontend-overlay.zip') as old, zipfile.ZipFile(frontend / 'frontend-overlay.zip', 'x') as new:
                for name in old.namelist():
                    new.writestr(name, b'changed' if mutation == 'tampered' and name == 'OnlineRoomSettings.js' else old.read(name))
                if mutation == 'duplicate': new.writestr('OnlineRoomSettings.js', old.read('OnlineRoomSettings.js'))
            self.assertNotEqual(self.build(frontend=frontend, name=mutation + '-output').returncode, 0)
            self.assertFalse((self.base / (mutation + '-output')).exists())


if __name__ == '__main__':
    unittest.main()
