"""Integrity failures must reject export without touching campaign evidence."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/export_web_size_transfer.py'
spec = importlib.util.spec_from_file_location('web_size_export', SCRIPT)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

class ExportIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export.torch.set_num_threads(1)
        cls.source_run = export.CAMPAIGN / 'grid_gnn/transfer_all.seed2026092201.stage3'
        cls.record = export.audit_stage(cls.source_run, 'grid_gnn', 2026092201, 3)

    def isolated_stage(self, root):
        run = Path(root) / self.source_run.name
        (run / 'checkpoints').mkdir(parents=True)
        for name in ('stage_receipt.json', 'initialization.json', 'resolved_config.json'):
            shutil.copyfile(self.source_run / name, run / name)
        shutil.copyfile(self.source_run / 'checkpoints/latest.json', run / 'checkpoints/latest.json')
        shutil.copyfile(self.record['checkpoint'], run / 'checkpoints' / self.record['checkpoint'].name)
        return run

    def test_checkpoint_byte_corruption_rejected(self):
        with tempfile.TemporaryDirectory(prefix='lifeline-export-') as tmp:
            run = self.isolated_stage(tmp)
            path = run / 'checkpoints' / self.record['checkpoint'].name
            with path.open('r+b') as handle:
                handle.seek(-1, 2); handle.write(b'X')
            with self.assertRaisesRegex(ValueError, 'SHA/size'):
                export.audit_stage(run, 'grid_gnn', 2026092201, 3)

    def test_receipt_config_corruption_rejected(self):
        with tempfile.TemporaryDirectory(prefix='lifeline-export-') as tmp:
            run = self.isolated_stage(tmp)
            path = run / 'stage_receipt.json'
            body = export.read(path); body['config_hash'] = '0' * 64
            path.write_text(json.dumps(body))
            with self.assertRaisesRegex(ValueError, 'full config hash'):
                export.audit_stage(run, 'grid_gnn', 2026092201, 3)

    def test_receipt_source_corruption_rejected(self):
        with tempfile.TemporaryDirectory(prefix='lifeline-export-') as tmp:
            run = self.isolated_stage(tmp)
            path = run / 'stage_receipt.json'
            body = export.read(path); body['source_hash'] = '0' * 64
            path.write_text(json.dumps(body))
            with self.assertRaisesRegex(ValueError, 'source mismatch'):
                export.audit_stage(run, 'grid_gnn', 2026092201, 3)

    def test_f32_byte_corruption_rejected(self):
        model, raw = export.export_spec(self.record)
        with tempfile.TemporaryDirectory(prefix='lifeline-export-') as tmp:
            path = Path(tmp) / 'asset.f32'
            path.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
            with self.assertRaisesRegex(ValueError, 'export manifest/bytes'):
                export.verify_asset(self.record, model, path)

if __name__ == '__main__':
    unittest.main()
