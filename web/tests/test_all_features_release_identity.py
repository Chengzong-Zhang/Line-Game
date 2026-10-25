"""Local-only envelope/identity tests: no SSH, service activation or credentials."""
import argparse
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
NEW = 'web-all-features-20261025-r1'
OLD = 'web-all-features-20261024-r1'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'web/tools' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}):
        spec.loader.exec_module(module)
    return module


PREPARE = load('prepare_all_features_20261024')
DEPLOY = load('deploy_all_features_20261024')
sha = lambda value: hashlib.sha256(value).hexdigest()


def frontend_fixture(folder):
    folder.mkdir()
    engine = b'export const newRules = "territory-v3";\n'
    manifest = {'release_id': OLD, 'asset_version': '20261024-all1',
                'files': {'GameEngine.js': sha(engine)}, 'runtime_files': {'GameEngine.js': sha(engine)}}
    raw = (json.dumps(manifest, indent=2) + '\n').encode()
    (folder / 'release-manifest.json').write_bytes(raw)
    with zipfile.ZipFile(folder / 'frontend-overlay.zip', 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('release-manifest.json', raw)
        archive.writestr('GameEngine.js', engine)
    return engine


class IdentityTests(unittest.TestCase):
    def test_valid_new_and_default_release_ids(self):
        for module in (PREPARE, DEPLOY):
            self.assertEqual(module.release_identity(OLD), OLD)
            self.assertEqual(module.release_identity(NEW), NEW)
            for value in ('../outside', '/root', 'web-all-features-20261025-r0', NEW + '/child',
                          'web-all-features-20261025-r1;id', NEW + '\\child', 'unrelated-release'):
                with self.assertRaises(argparse.ArgumentTypeError):
                    module.release_identity(value)

    def test_worker_derives_unique_directory_and_keeps_old_default(self):
        self.assertEqual(DEPLOY.configure_release(['--release-id', NEW]), NEW)
        self.assertEqual(DEPLOY.RELEASE, NEW)
        self.assertEqual(DEPLOY.HERE, DEPLOY.ARTIFACTS / NEW)
        self.assertEqual(DEPLOY.configure_release([]), OLD)
        self.assertEqual(DEPLOY.HERE, DEPLOY.ARTIFACTS / OLD)

    def test_new_envelope_preserves_all_runtime_bytes_and_original_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; engine = frontend_fixture(source)
            original = {path.name: path.read_bytes() for path in source.iterdir()}
            result = PREPARE.rebind_frontend(source, root / 'new', NEW)
            self.assertEqual(result['runtimeMembersUnchanged'], 1)
            manifest = json.loads((root / 'new/release-manifest.json').read_text())
            self.assertEqual(manifest['release_id'], NEW)
            self.assertEqual(manifest['asset_version'], '20261024-all1')
            with zipfile.ZipFile(root / 'new/frontend-overlay.zip') as archive:
                self.assertEqual(archive.read('GameEngine.js'), engine)
                self.assertEqual(archive.read('release-manifest.json'), (root / 'new/release-manifest.json').read_bytes())
            self.assertEqual(original, {path.name: path.read_bytes() for path in source.iterdir()})

    def test_default_identity_retains_archive_and_manifest_exactly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; frontend_fixture(source)
            PREPARE.rebind_frontend(source, root / 'same', OLD)
            for name in ('frontend-overlay.zip', 'release-manifest.json'):
                self.assertEqual((source / name).read_bytes(), (root / 'same' / name).read_bytes())

    def test_tampered_runtime_is_rejected_before_rebinding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; frontend_fixture(source)
            raw = (source / 'release-manifest.json').read_bytes()
            with zipfile.ZipFile(source / 'frontend-overlay.zip', 'w') as archive:
                archive.writestr('release-manifest.json', raw)
                archive.writestr('GameEngine.js', 'changed')
            with self.assertRaisesRegex(AssertionError, 'Runtime hash mismatch'):
                PREPARE.rebind_frontend(source, root / 'bad', NEW)

    def test_complete_preparer_renders_new_identity_without_touching_source_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); frontend = root / 'frontend'; engine = frontend_fixture(frontend)
            source_hash = sha((frontend / 'frontend-overlay.zip').read_bytes())
            service = root / 'service'; (service / 'package').mkdir(parents=True)
            (service / 'package/fixture.py').write_text('pass\n')
            (service / 'release-manifest.json').write_text(json.dumps({'candidate': {'web/web前端/GameEngine.js': sha(engine)}}))
            for name in ('activate_service_release.py', 'activate_profile_service_live.py'):
                (service / name).write_text('pass\n')
            legacy = root / 'legacy'
            for name in (*PREPARE.BEFORE, 'web/web前端/GameEngine.js'):
                path = legacy / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(engine if name.endswith('GameEngine.js') else b'fixture\n')
            fixtures = root / 'fixture-root'
            for name in ('deploy_all_features_20261024.py', 'atomic_frontend_release.py', 'activate_legacy_release.py'):
                path = fixtures / 'web/tools' / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('pass\n')
            path = fixtures / 'web/tools/release_all_bootstrap_template.py'
            path.write_text((ROOT / 'web/tools/release_all_bootstrap_template.py').read_text(encoding='utf-8'), encoding='utf-8')
            for name in ('legacy-probe.py', 'verify-live-scoring.mjs'):
                path = fixtures / 'docs/verification/release-all-20261024' / name
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text('fixture\n')
            output = root / 'output'
            argv = ['prepare', '--frontend', str(frontend), '--service', str(service), '--legacy', str(legacy),
                    '--output', str(output), '--release-id', NEW]
            with patch.object(PREPARE, 'ROOT', fixtures), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                PREPARE.main()
            bootstrap = (output / 'remote-bootstrap.py').read_text(encoding='utf-8')
            ast.parse(bootstrap)
            self.assertIn('RELEASE = ' + repr(NEW), bootstrap)
            self.assertNotIn('__RELEASE__', bootstrap)
            self.assertIn("'--release-id', RELEASE", bootstrap)
            self.assertEqual(json.loads((output / 'payload/plan.json').read_text())['release_id'], NEW)
            self.assertEqual(sha((frontend / 'frontend-overlay.zip').read_bytes()), source_hash)

    def test_failed_tool_emits_safe_readable_codes_without_raw_output(self):
        report = DEPLOY.safe_command_report(b'{"status":"SERVICE_RELEASE_NOT_CONFIRMED","code":"BASELINE_SOURCE_HASHES","errorType":"GateError","error":"never-forward-this-secret"}')
        self.assertEqual(report['code'], 'BASELINE_SOURCE_HASHES')
        self.assertNotIn('error', report)
        self.assertNotIn('secret', json.dumps(report))
        with tempfile.TemporaryDirectory() as temp, patch.object(DEPLOY, 'HERE', Path(temp)):
            code = 'import json,sys; print(json.dumps({"code":"BASELINE_SOURCE_HASHES","status":"SERVICE_RELEASE_NOT_CONFIRMED"}));sys.exit(4)'
            with self.assertRaises(DEPLOY.CommandFailure) as failure:
                DEPLOY.run([sys.executable, '-c', code], timeout=5)
            self.assertEqual(failure.exception.details['exitCode'], 4)
            self.assertEqual(failure.exception.details['reported']['code'], 'BASELINE_SOURCE_HASHES')
            self.assertTrue((Path(temp) / failure.exception.details['log']).is_file())

    def test_service_subruns_and_bootstrap_have_no_reused_old_attempt_paths(self):
        DEPLOY.configure_release(['--release-id', NEW])
        self.addCleanup(DEPLOY.configure_release, [])
        # Match the real service adapter's constructor contract. Its service
        # container and both new run dirs must be direct artifact siblings.
        live = Path('/home/ubuntu/line-game/.deploy-artifacts/wechat-service-20261021/release')
        preflight = DEPLOY.service_run_directory('preflight')
        activation = DEPLOY.service_run_directory('activation')
        self.assertEqual(preflight.parent, live.parent.parent)
        self.assertEqual(activation.parent, live.parent.parent)
        self.assertNotEqual(preflight, activation)
        self.assertIn(NEW, preflight.name)
        self.assertIn(NEW, activation.name)
        with self.assertRaisesRegex(ValueError, 'UNREVIEWED_SERVICE_PHASE'):
            DEPLOY.service_run_directory('../live')
        template = (ROOT / 'web/tools/release_all_bootstrap_template.py').read_text(encoding='utf-8')
        self.assertIn("'--unit=lifeline-' + RELEASE[4:]", template)
        self.assertIn("assert p==pathlib.Path('/home/ubuntu/line-game/.deploy-artifacts')/r", template)
        self.assertIn('assert not HERE.is_symlink()', template)


if __name__ == '__main__':
    unittest.main()
