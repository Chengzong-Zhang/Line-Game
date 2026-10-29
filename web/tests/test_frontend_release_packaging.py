import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == '__main__':
    unittest.main()
