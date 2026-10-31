"""Pin validation and launch gates without SSH or any production mutation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'wechat/tools/queue_frozen_release.py'
spec = importlib.util.spec_from_file_location('frozen_queue', SOURCE)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class QueueTests(unittest.TestCase):
    def setup_paths(self, root):
        (root / 'requests').mkdir()
        (root / 'results').mkdir()
        (root / 'status.json').write_text('{"status":"AUTHENTICATED"}', encoding='utf-8')
        bootstrap = root / 'bootstrap.py'
        bootstrap.write_bytes(b'print("synthetic only")\n')
        return bootstrap

    def test_changed_bootstrap_is_rejected_without_any_queue_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bootstrap = self.setup_paths(root)
            with self.assertRaisesRegex(ValueError, 'BOOTSTRAP_HASH_CHANGED'):
                queue.transfer(bootstrap, '0' * 64, root, 'web-all-features-20261025-r99', root / 'state.json')
            self.assertEqual(list((root / 'requests').iterdir()), [])
            self.assertFalse((root / 'state.json').exists())

    def test_launch_requires_exact_remote_assembly_and_cannot_be_replayed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bootstrap = self.setup_paths(root)
            sha = hashlib.sha256(bootstrap.read_bytes()).hexdigest()
            state_path = root / 'state.json'
            state = queue.transfer(bootstrap, sha, root, 'web-all-features-20261025-r99', state_path)
            with self.assertRaises(FileNotFoundError):
                queue.launch(state_path)
            receipt = root / 'results' / (state['assembleId'] + '.json')
            receipt.write_text(json.dumps({'exitCode': 0, 'stdout': json.dumps({
                'status': 'BOOTSTRAP_VERIFIED', 'sha256': '0' * 64})}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'REMOTE_BOOTSTRAP_RECEIPT_MISMATCH'):
                queue.launch(state_path)
            receipt.write_text(json.dumps({'exitCode': 0, 'stdout': json.dumps({
                'status': 'BOOTSTRAP_VERIFIED', 'sha256': sha})}), encoding='utf-8')
            self.assertEqual(queue.launch(state_path)['status'], 'VERIFIED_BOOTSTRAP_LAUNCH_QUEUED')
            with self.assertRaisesRegex(ValueError, 'REQUEST_ALREADY_EXISTS'):
                queue.launch(state_path)

    def test_large_shell_argument_and_unsafe_identity_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'REMOTE_SHELL_ARGUMENT_TOO_LARGE'):
            queue.request('fixture', 'x' * 120000)
        for value in ('../../live', 'web-all-features-20261025-r1; echo bad', '', None):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                queue.release_id(value)


if __name__ == '__main__':
    unittest.main()
