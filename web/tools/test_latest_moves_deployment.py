"""Portable, synthetic fault tests for the two-frontend display deployment.

Run: python web/tools/test_latest_moves_deployment.py
No network, credentials or production paths are used. Directory exchange and
ownership are mocked on every platform; these tests do not validate Linux's
native renameat2 syscall, public HTTPS, browser behaviour or device acceptance.
"""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import deploy_latest_moves_20261025 as deploy
import prepare_latest_moves_20261025 as prepare


class LatestMovesDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='latest-moves-deployment-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.healthy = {'game': 'ok', 'wechatEnabled': True, 'playerCounts': list(range(2, 16))}
        for mocked in (
            patch.object(deploy, 'health', side_effect=lambda: self.healthy.copy()),
            patch.object(deploy.os, 'chown', lambda *args: None, create=True),
            patch.object(deploy, 'exchange', side_effect=self.exchange),
            patch.object(deploy, 'public_verify', return_value={
                'status': 'PASS_SYNTHETIC_PUBLIC_CHECK', 'files': 6}),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)
        self.front = self.root / 'web/web前端'
        self.front.mkdir(parents=True)
        self.originals = {
            'GameController.js': b'import Renderer from "./Renderer.js?v=20261025-defense15";\n// original controller\n',
            'Renderer.js': b'// original renderer\n',
            'OnlineApp.js': b'import C from "./GameController.js?v=20261025-defense15";\n',
            'main.js': (b'const APP_ASSET_VERSION = "20261025-defense15";\n'
                        b'const a="./OnlineApp.js?v=20261025-defense15";\n'
                        b'const b="./OnlineApp.js?v=20261025-defense15";\n'),
            'index.html': b'<script src="./main.js?v=20261025-defense15"></script>\n',
            'GameEngine.js': b'// existing rules must stay byte-identical\n',
        }
        for name, raw in self.originals.items():
            (self.front / name).write_bytes(raw)
        previous = {'release_id': deploy.PREDECESSOR, 'asset_version': '20261025-defense15',
                    'commit': 'a' * 40, 'files': {name: hashlib.sha256(raw).hexdigest()
                                                for name, raw in self.originals.items()}}
        (self.front / 'release-manifest.json').write_text(json.dumps(previous), encoding='utf-8')
        shutil.copytree(self.front, deploy.trees(self.root)['wechat'])
        for name, target in deploy.protected(self.root).items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(('unchanged backend ' + name).encode())
        self.snapshot = deploy.inspect(self.root)
        before = self.root / 'before.json'
        before.write_text(json.dumps(self.snapshot), encoding='utf-8')
        self.source_root = self.root / 'source'
        self.source_front = self.source_root / 'web/web前端'
        self.source_front.mkdir(parents=True)
        self.sources = {'GameController.js': self.originals['GameController.js'] + b'// highlight state\n',
                        'Renderer.js': b'// highlight renderer\n'}
        for name, raw in self.sources.items():
            (self.source_front / name).write_bytes(raw)
        self.release = self.root / '.deploy-artifacts' / deploy.RELEASE
        self.prepared = prepare.prepare(before, self.release, self.source_root)
        self.manifest = deploy.load_release(self.release, self.root)

    def exchange(self, left, right):
        # A portable fault-injection substitute, never the production syscall.
        for target in (left, right):
            self.assertTrue(target.resolve().is_relative_to(self.root))
        transient = left.with_name(left.name + '.fixture-exchange')
        self.assertFalse(transient.exists())
        left.rename(transient)
        right.rename(left)
        transient.rename(right)

    def assert_restored(self):
        deploy.check_before(self.root, self.snapshot)
        for frontend in deploy.trees(self.root).values():
            for name, raw in self.originals.items():
                self.assertEqual((frontend / name).read_bytes(), raw)

    def test_display_overlay_preserves_sources_rules_and_both_complete_frontends(self):
        self.assertFalse(self.prepared['sourceMutation'])
        self.assertEqual(set(self.prepared['overlayFiles']), deploy.OVERLAY_FILES)
        result = deploy.activate(self.release, self.manifest, self.root)
        self.assertEqual(result['status'], 'ACTIVATED_BOTH_FRONTENDS_PUBLIC_HASHES_VERIFIED')
        self.assertEqual(result['serviceRestarts'], 0)
        self.assertFalse(result['backendChanged'])
        self.assertFalse(result['databasesChanged'])
        for name, raw in self.sources.items():
            self.assertEqual((self.source_front / name).read_bytes(), raw)
        for frontend in deploy.trees(self.root).values():
            self.assertEqual((frontend / 'GameEngine.js').read_bytes(), self.originals['GameEngine.js'])
            current = json.loads((frontend / 'release-manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(set(current['files']), set(self.originals))
            self.assertIn(deploy.ASSET_VERSION, (frontend / 'OnlineApp.js').read_text(encoding='utf-8'))
            self.assertEqual((frontend / 'main.js').read_text(encoding='utf-8').count(deploy.ASSET_VERSION), 3)
            deploy.resources(frontend, current)
        self.assertEqual(deploy.tree(self.front), deploy.tree(deploy.trees(self.root)['wechat']))
        self.assertEqual({name: deploy.sha(target) for name, target in deploy.protected(self.root).items()},
                         self.snapshot['protected'])

    def test_explicit_rollback_restores_both_validated_predecessors(self):
        deploy.activate(self.release, self.manifest, self.root)
        result = deploy.rollback(self.release, self.manifest, self.root)
        self.assertEqual(result['status'], 'ROLLED_BACK_VERIFIED')
        self.assert_restored()

    def test_public_hash_failure_automatically_rolls_back_both_frontends(self):
        with patch.object(deploy, 'public_verify', side_effect=RuntimeError('injected public hash failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected public hash failure'):
                deploy.activate(self.release, self.manifest, self.root)
        self.assert_restored()
        state = json.loads((self.release / 'deployment.json').read_text(encoding='utf-8'))
        self.assertEqual(state['status'], 'ROLLED_BACK_VERIFIED')

    def test_concurrent_production_drift_is_rejected_before_any_swap(self):
        wx = deploy.trees(self.root)['wechat']
        (wx / 'GameEngine.js').write_bytes(b'concurrent rule update')
        with self.assertRaisesRegex(RuntimeError, 'predecessor changed'):
            deploy.activate(self.release, self.manifest, self.root)
        self.assertFalse((self.release / 'deployment.json').exists())
        self.assertEqual(deploy.tree(self.front), self.snapshot['before']['site']['tree'])
        self.assertEqual((wx / 'GameEngine.js').read_bytes(), b'concurrent rule update')

    def test_interruption_between_swaps_restores_the_first_frontend(self):
        calls = 0
        def interrupt_second(left, right):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt('injected interruption after first swap')
            self.exchange(left, right)
        with patch.object(deploy, 'exchange', side_effect=interrupt_second):
            with self.assertRaisesRegex(KeyboardInterrupt, 'injected interruption'):
                deploy.activate(self.release, self.manifest, self.root)
        self.assert_restored()
        state = json.loads((self.release / 'deployment.json').read_text(encoding='utf-8'))
        self.assertEqual(state['status'], 'ROLLED_BACK_VERIFIED')


if __name__ == '__main__':
    unittest.main(verbosity=2)
