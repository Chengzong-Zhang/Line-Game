"""Protocol-v4 HTTP and storage boundaries; the JS validator is separately tested."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('training_contributions_v4', ROOT / 'web/web后端/training_contributions.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def payload():
    return {'format': 'lifeline-training-contribution', 'version': 4, 'consent': True,
            'consent_policy': 'anonymous-replay-training-v4', 'replay': {'synthetic': True},
            'context': {'source': 'local', 'actors': {'BLACK': {'kind': 'human'}, 'WHITE': {'kind': 'human'}},
                        'mixedProfiles': False, 'hintsEnabled': False,
                        'undo': {'enabled': False, 'maxCount': 3, 'usedCount': 0}}}


def run_validator(command, *, input, **kwargs):
    supplied = json.loads(input)
    verified = {'game_id': 'a' * 64, 'protocol_version': 4, 'player_count': 2,
                'context': supplied['context'], 'replay': supplied['replay'], 'engine_sources': {}}
    return type('Result', (), {'returncode': 0, 'stdout': json.dumps(verified).encode()})()


class ContributionV4StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Model an existing database before v4 deployment and preserve bytes.
        db = sqlite3.connect(Path(self.temp.name) / 'contributions.sqlite3')
        try:
            for table in ('inbox', 'inbox_v2', 'inbox_v3'):
                db.execute(f'CREATE TABLE {table} (game_id TEXT PRIMARY KEY, document TEXT NOT NULL, received_at INTEGER NOT NULL)')
                db.execute(f'INSERT INTO {table} VALUES (?, ?, ?)', (table, '{"frozen":true}', 123))
            db.commit()
        finally:
            db.close()
        self.store = module.ContributionStore(self.temp.name)
        app = FastAPI(); app.include_router(module.create_router(self.store))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close(); self.temp.cleanup()

    def test_migration_receipt_dedup_export_and_context_conflict(self):
        with patch.object(module.subprocess, 'run', side_effect=run_validator):
            first = self.store.accept(payload())
            self.assertEqual(first, {'game_id': 'a' * 64, 'status': 'awaiting_review'})
            self.assertEqual(self.store.accept(payload())['status'], 'duplicate')
            altered = payload(); altered['context']['undo'] = {'enabled': True, 'maxCount': 3, 'usedCount': 1}
            with self.assertRaisesRegex(ValueError, 'Conflicting gameplay metadata'):
                self.store.accept(altered)
        with self.store.connect() as db:
            for table in ('inbox', 'inbox_v2', 'inbox_v3'):
                self.assertEqual(db.execute(f'SELECT game_id,document,received_at FROM {table}').fetchall(),
                                 [(table, '{"frozen":true}', 123)])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM inbox_v4').fetchone()[0], 1)
        destination = Path(self.temp.name) / 'v4-export'
        self.assertEqual(self.store.export(destination, version=4), 1)
        record = json.loads(next(destination.glob('*.json')).read_text(encoding='utf-8'))
        self.assertEqual((record['status'], record['protocol_version']), ('awaiting_review', 4))

    def test_status_and_versioned_request_limits(self):
        status = self.client.get('/api/training/contributions/status').json()
        self.assertEqual(status['supported_versions'], [1, 2, 3, 4])
        self.assertEqual(status['max_request_bytes'], 512000)
        self.assertEqual(status['max_request_bytes_by_version']['4'], 2 * 1024 * 1024)
        large = payload(); large['replay']['padding'] = 'x' * 530000
        body = json.dumps(large).encode()
        with patch.object(module.subprocess, 'run', side_effect=run_validator):
            self.assertEqual(self.client.post('/api/training/contributions', content=body, headers={'content-type': 'application/json'}).status_code, 200)
            legacy = {**large, 'version': 3, 'consent_policy': 'anonymous-replay-training-v3'}
            self.assertEqual(self.client.post('/api/training/contributions', json=legacy).status_code, 413)
        self.assertEqual(self.client.post('/api/training/contributions', content=b'x' * (2 * 1024 * 1024 + 1),
                                          headers={'content-type': 'application/json'}).status_code, 413)

    def test_privacy_consent_and_validator_are_fail_closed(self):
        candidates = []
        p = payload(); p['context']['actors']['BLACK']['name'] = 'private'; candidates.append(p)
        p = payload(); p['context']['mixedProfiles'] = True; candidates.append(p)
        p = payload(); p['consent'] = False; candidates.append(p)
        p = payload(); p['account'] = 'private'; candidates.append(p)
        with patch.object(module.subprocess, 'run', side_effect=run_validator):
            for candidate in candidates:
                self.assertEqual(self.client.post('/api/training/contributions', json=candidate).status_code, 422)
        with patch.object(module.subprocess, 'run', return_value=type('Result', (), {'returncode': 1, 'stdout': b''})()):
            self.assertEqual(self.client.post('/api/training/contributions', json=payload()).status_code, 422)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM inbox_v4').fetchone()[0], 0)

    def test_storage_limit_includes_legacy_tables(self):
        constrained = module.ContributionStore(self.temp.name, maximum_bytes=1)
        with patch.object(module.subprocess, 'run', side_effect=run_validator):
            with self.assertRaises(OverflowError): constrained.accept(payload())


if __name__ == '__main__': unittest.main()
