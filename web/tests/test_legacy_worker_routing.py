import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'tools/configure_legacy_worker_routing.py'
spec = importlib.util.spec_from_file_location('legacy_route', path)
routing = importlib.util.module_from_spec(spec); spec.loader.exec_module(routing)

class RoutingTests(unittest.TestCase):
    def test_exact_routes_and_no_api_changes(self):
        source = b'server {\n}\nserver {\n    location /api/ { proxy_pass http://api; }\n    location / {\n        proxy_pass http://127.0.0.1:8000;\n    }\n}\n'
        plan = {'root_module_sha256': {f'Module{i}.js': 'a'*64 for i in range(54)}}
        target = routing.propose(source, plan)
        self.assertEqual(target.count(b'"/Module'), 108)
        self.assertIn(b'map_hash_bucket_size 256;', target)
        self.assertIn(b'location /api/ { proxy_pass http://api; }', target)
        with self.assertRaisesRegex(ValueError, 'STRUCTURE'):
            routing.propose(source.replace(b'8000', b'8001'), plan)
        with self.assertRaisesRegex(ValueError, 'STRUCTURE'):
            routing.propose(target, plan)

    def test_paths_and_hashes_reject_tamper(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t).resolve()
            file = root / 'source.js'; file.write_bytes(b'ok')
            self.assertEqual(routing.safe_file(root, 'source.js'), file)
            for name in ('../source.js', '/source.js', 'x/../source.js', 'x?y.js'):
                with self.assertRaises(ValueError): routing.safe_file(root, name)
            link = root / 'link.js'
            try: link.symlink_to(file)
            except OSError: pass
            else:
                with self.assertRaises(ValueError): routing.safe_file(root, 'link.js')
            manifest = root / 'm.json'; manifest.write_text('{"a":1}')
            digest = routing.sha(manifest.read_bytes())
            self.assertEqual(routing.read_json_checked(manifest, digest), {'a':1})
            manifest.write_text('{"a":2}')
            with self.assertRaisesRegex(ValueError, 'HASH_MISMATCH'):
                routing.read_json_checked(manifest, digest)

    def test_failed_reload_restores_original_and_reloads(self):
        with tempfile.TemporaryDirectory() as t:
            config = Path(t) / 'nginx.conf'; config.write_bytes(b'before'); result = {}
            commands = []
            def fake_run(cmd):
                commands.append(cmd)
                if len(commands) == 2: raise RuntimeError('reload failed')
            with patch.object(routing, 'replace', lambda p, raw: p.write_bytes(raw)), patch.object(routing, 'run', fake_run):
                with self.assertRaisesRegex(RuntimeError, 'reload failed'):
                    routing.install_config(config, b'before', b'after', result, lambda: None)
            self.assertEqual(config.read_bytes(), b'before')
            self.assertEqual(result['status'], 'FAILED_ORIGINAL_CONFIG_RESTORED')
            self.assertEqual(commands, [['nginx', '-t'], ['systemctl', 'reload', 'nginx'], ['nginx', '-t'], ['systemctl', 'reload', 'nginx']])

    def test_candidate_closure_and_asset_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t).resolve()
            modules = {f'Module{i}.js': routing.sha(f'old{i}'.encode()) for i in range(54)}
            assets = {f'assets/research-ai/model{i}.json': routing.sha(f'asset{i}'.encode()) for i in range(29)}
            predecessor = {'immutable_worker_dependencies': modules, 'files': assets}
            predecessor_raw = json.dumps(predecessor).encode(); predecessor_hash = routing.sha(predecessor_raw)
            plan = {'schema':'lifeline-legacy-worker-root-routing-plan-v1',
                    'predecessor_manifest_sha256':predecessor_hash, 'match_query_v':routing.TOKENS,
                    'rewrite_prefix':'/' + routing.PREFIX, 'root_module_sha256':modules, 'asset_sha256':assets}
            candidate = {'predecessor_manifest_sha256':predecessor_hash,
                         'frozen_worker_snapshot':'web-topology-fix-20261030-r2',
                         'asset_version':'new-release', 'files':{}}
            def write(name, data):
                p = root / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
                candidate['files'][name] = routing.sha(data)
            write(routing.PREFIX + 'predecessor-release-manifest.json', predecessor_raw)
            for i in range(54):
                name = f'Module{i}.js'; write(name, f'new{i}'.encode()); write(routing.PREFIX + name, f'old{i}'.encode())
            for i in range(29):
                name = f'assets/research-ai/model{i}.json'; raw = f'asset{i}'.encode()
                write(name, raw); write(routing.PREFIX + name, raw)
            with patch.object(routing, 'PREDECESSOR_HASH', predecessor_hash):
                routing.validate(plan, candidate, root)
                (root / (routing.PREFIX + 'Module0.js')).write_bytes(b'tamper')
                with self.assertRaisesRegex(ValueError, 'MODULE_DRIFT'): routing.validate(plan, candidate, root)
                (root / (routing.PREFIX + 'Module0.js')).write_bytes(b'old0')
                (root / 'assets/research-ai/model0.json').write_bytes(b'tamper')
                with self.assertRaisesRegex(ValueError, 'ASSET_DRIFT'): routing.validate(plan, candidate, root)

    def test_failed_restore_is_reported_and_concurrent_edit_is_preserved(self):
        with tempfile.TemporaryDirectory() as t:
            config = Path(t) / 'nginx.conf'; config.write_bytes(b'before'); result = {}
            def fake_run(cmd):
                config.write_bytes(b'other-operator'); raise RuntimeError('reload failed')
            with patch.object(routing, 'replace', lambda p, raw: p.write_bytes(raw)), patch.object(routing, 'run', fake_run):
                with self.assertRaises(RuntimeError):
                    routing.install_config(config, b'before', b'after', result, lambda: None)
            self.assertEqual(config.read_bytes(), b'other-operator')
            self.assertEqual(result['status'], 'FAILED_RESTORE_ATTEMPTED')
            self.assertIn('REFUSE_OVERWRITE_CONCURRENT_CONFIG', result['restoreError'])

if __name__ == '__main__': unittest.main()
