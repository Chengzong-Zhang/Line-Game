import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import shutil

MODULE_PATH = Path(__file__).resolve().parents[1] / 'tools' / 'prepare_frontend_release.py'
spec = importlib.util.spec_from_file_location('frontend_release', MODULE_PATH)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FrontendReleaseTests(unittest.TestCase):
    def test_asset_base_is_preserved_but_actual_import_and_worker_are_stamped(self):
        text = '''const a = new URL("./ThreePlayerAI.js", self.location.href).href;
const b = new URL('./HexPlayerAI.js', self.location.href).href;
import x from "./ThreePlayerAI.js?old";
const x = import("./HexPlayerAI.js?old");
new Worker(new URL("./ThreePlayerRuntime.js?old", import.meta.url));
const other = new URL("./ThreePlayerModels.js?old", self.location.href).href;'''
        stamped = release.stamp_module_urls(text, 'new')
        self.assertIn('new URL("./ThreePlayerAI.js", self.location.href).href', stamped)
        self.assertIn("new URL('./HexPlayerAI.js', self.location.href).href", stamped)
        for value in ['import x from "./ThreePlayerAI.js?v=new"',
                      'import("./HexPlayerAI.js?v=new")',
                      'new URL("./ThreePlayerRuntime.js?v=new", import.meta.url)',
                      'new URL("./ThreePlayerModels.js?v=new", self.location.href)']:
            self.assertIn(value, stamped)

    def test_closure_requires_all_real_refs_and_correct_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parent = root / 'main.js'
            target = root / 'ThreePlayerAI.js'
            target.write_text('export {};', encoding='utf8')
            parent.write_text('import "./ThreePlayerAI.js?v=old";', encoding='utf8')
            paths = [parent, target]
            with self.assertRaisesRegex(RuntimeError, 'stale module token'):
                release.validate_module_closure(root, paths, {parent: parent.read_text()}, 'new')
            with self.assertRaisesRegex(RuntimeError, 'excluded module'):
                release.validate_module_closure(root, [parent], {parent: 'import "./ThreePlayerAI.js?v=new";'}, 'new')
            release.validate_module_closure(root, paths, {parent: 'new URL("./ThreePlayerAI.js", self.location.href).href;'}, 'new')
            target.unlink()
            with self.assertRaisesRegex(RuntimeError, 'missing module'):
                release.validate_module_closure(root, paths, {parent: 'new URL("./ThreePlayerAI.js", self.location.href).href;'}, 'new')

    def test_rejects_bundle_source_or_proposed_stamp_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / 'MultiplayerHardAIWorker.bundle.mjs'
            source = root / 'AIEngine.js'
            bundle.write_text('bundle', encoding='utf8')
            source.write_text('source', encoding='utf8')
            manifest = {'schema': 'lifeline-application-hard-worker-bundle-v1',
                        'bundleSha256': release.sha(bundle.read_bytes()),
                        'sourceHashes': {source.name: release.sha(source.read_bytes())}}
            (root / 'MultiplayerHardAIWorker.bundle.manifest.json').write_text(json.dumps(manifest), encoding='utf8')
            release.validate_hard_worker(root, {bundle: 'bundle', source: 'source'})
            with self.assertRaisesRegex(RuntimeError, 'Stamp would change frozen'):
                release.validate_hard_worker(root, {bundle: 'bundle changed', source: 'source'})
            with self.assertRaisesRegex(RuntimeError, 'Stamp would change frozen'):
                release.validate_hard_worker(root, {bundle: 'bundle', source: 'source changed'})
            bundle.write_text('tampered', encoding='utf8')
            with self.assertRaisesRegex(RuntimeError, 'input drift'):
                release.validate_hard_worker(root, {})
            bundle.write_text('bundle', encoding='utf8')
            source.write_text('tampered', encoding='utf8')
            with self.assertRaisesRegex(RuntimeError, 'input drift'):
                release.validate_hard_worker(root, {})

    def test_immutable_worker_requires_unchanged_transitive_public_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            bundle = root / 'MultiplayerHardAIWorker.bundle.mjs'
            module = root / 'AIEngine.js'
            dependency = root / 'Shared.js'
            bundle.write_text('import "./AIEngine.js?v=old";', encoding='utf8')
            module.write_text('import "./Shared.js?v=old";', encoding='utf8')
            dependency.write_text('export const value = 1;', encoding='utf8')
            manifest = {'sourceHashes': {module.name: release.sha(module.read_bytes())}}
            (root / 'MultiplayerHardAIWorker.bundle.manifest.json').write_text(json.dumps(manifest), encoding='utf8')
            predecessor = {'asset_version': 'old-v1', 'files': {p.name: release.sha(p.read_bytes()) for p in [bundle, module, dependency]}}
            closure = release.immutable_worker_closure(root, predecessor)
            self.assertEqual(set(closure), {bundle.name, module.name, dependency.name})
            dependency.write_text('export const value = 2;', encoding='utf8')
            with self.assertRaisesRegex(RuntimeError, 'dependency changed: Shared.js'):
                release.immutable_worker_closure(root, predecessor)

    def test_incoming_import_uses_the_pinned_immutable_module_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            parent, target = root / 'NewUI.js', root / 'AIEngine.js'
            target.write_text('export {};', encoding='utf8')
            versions = {target: 'old-v1'}
            text = 'import "./AIEngine.js?v=new-ui";'
            stamped = release.stamp_module_urls(text, 'new-ui', source_path=parent, immutable_versions=versions)
            self.assertEqual(stamped, 'import "./AIEngine.js?v=old-v1";')
            release.validate_module_closure(root, [parent, target], {parent: stamped}, 'new-ui', versions)
            with self.assertRaisesRegex(RuntimeError, 'stale module token'):
                release.validate_module_closure(root, [parent, target], {parent: text}, 'new-ui', versions)

    def test_real_frozen_snapshot_preserves_transitive_graph_and_assets(self):
        repo = MODULE_PATH.parents[2]
        snapshot = repo / 'web/web前端/frozen-workers' / release.FROZEN_RELEASE_ID
        raw = (snapshot / 'predecessor-release-manifest.json').read_bytes()
        self.assertEqual(release.sha(raw), release.FROZEN_PREDECESSOR_SHA256)
        predecessor = json.loads(raw)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frontend = repo / 'web/web前端'
            bundle = 'MultiplayerHardAIWorker.bundle.mjs'
            shutil.copyfile(frontend / bundle, root / bundle)
            worker_manifest = 'MultiplayerHardAIWorker.bundle.manifest.json'
            shutil.copyfile(frontend / worker_manifest, root / worker_manifest)
            for name in predecessor['files']:
                if name.startswith('assets/research-ai/'):
                    destination = root / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(frontend / name, destination)
            closure, versions = release.stage_frozen_worker(root, snapshot, predecessor, release.sha(raw))
            self.assertEqual(len(closure), 54)
            self.assertEqual(set(closure), set(predecessor['immutable_worker_dependencies']))
            target = root / 'frozen-workers' / release.FROZEN_RELEASE_ID
            for name, digest in predecessor['files'].items():
                if name.startswith('assets/research-ai/'):
                    self.assertEqual(release.sha((target / name).read_bytes()), digest)
            release.validate_module_closure(root, release.runtime_paths(root), {
                target / name: (target / name).read_text(encoding='utf8') for name in closure
            }, 'current', versions)
            (root / 'assets/research-ai/hex-player-policy-v1.json').write_text('tampered')
            shutil.rmtree(target)
            with self.assertRaisesRegex(RuntimeError, 'asset drift'):
                release.stage_frozen_worker(root, snapshot, predecessor, release.sha(raw))
            with self.assertRaisesRegex(RuntimeError, 'Unexpected frozen Worker predecessor'):
                release.stage_frozen_worker(root, snapshot, predecessor, '0' * 64)


if __name__ == '__main__':
    unittest.main()
