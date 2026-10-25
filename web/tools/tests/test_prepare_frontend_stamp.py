"""Release stamping must preserve an already-frozen module graph byte for byte."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class FrozenStampTests(unittest.TestCase):
    def test_same_stamp_preserves_mixed_line_endings_and_worker_references(self):
        with tempfile.TemporaryDirectory(prefix='lifeline-frozen-stamp-') as name:
            root = Path(name)
            tool = root / 'web/tools/prepare_frontend_release.py'
            tool.parent.mkdir(parents=True)
            shutil.copyfile(Path(__file__).resolve().parents[1] / tool.name, tool)
            frontend = root / 'web/web前端'
            frontend.mkdir()
            files = {
                'main.js': b'const APP_ASSET_VERSION = "frozen";\r\nimport "./guard.js?v=frozen";\r\n',
                'guard.js': b'const worker = "./worker.bundle.mjs?v=frozen";\r\n',
                'worker.bundle.mjs': b'export const frozen = true;\n',
                'index.html': b'<script src="main.js?v=frozen"></script>\r\n',
            }
            for relative, raw in files.items():
                (frontend / relative).write_bytes(raw)
            subprocess.run([sys.executable, str(tool), '--stamp-only', '--release-id', 'fixture',
                            '--asset-version', 'frozen'], check=True, capture_output=True)
            for relative, raw in files.items():
                self.assertEqual((frontend / relative).read_bytes(), raw, relative)
            subprocess.run([sys.executable, str(tool), '--stamp-only', '--release-id', 'fixture',
                            '--asset-version', 'next'], check=True, capture_output=True)
            self.assertIn(b'APP_ASSET_VERSION = "next"', (frontend / 'main.js').read_bytes())
            self.assertIn(b'worker.bundle.mjs?v=next', (frontend / 'guard.js').read_bytes())
            self.assertIn(b'main.js?v=next', (frontend / 'index.html').read_bytes())
            self.assertEqual((frontend / 'worker.bundle.mjs').read_bytes(), files['worker.bundle.mjs'])


if __name__ == '__main__':
    unittest.main()
