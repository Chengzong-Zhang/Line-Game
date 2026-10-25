"""Exercise rollback after partial legacy source changes without touching a service."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('legacy_activation', ROOT / 'web/tools/activate_legacy_release.py')
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


class Fake:
    def __init__(self, root, fault):
        self.root, self.fault = root, fault
        self.running, self.locked = True, False
        self.before = [b'old API', b'old bridge']
        self.files = [root / 'server.py', root / 'bridge.mjs']
        for path, raw in zip(self.files, self.before):
            path.write_bytes(raw)
        self.db = root / 'accounts.sqlite3'
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('create table users(name text)')
            db.execute("insert into users values ('before')")
        self.db_id = self.db.stat().st_ino

    def step(self, name):
        if self.fault == name:
            self.fault = None
            raise RuntimeError('synthetic ' + name)

    def acquire(self): self.locked = True
    def release(self): self.locked = False
    def prepare(self): self.step('prepare')
    def preflight(self): self.step('preflight')
    def before_stop(self): self.step('before-stop')

    def stop(self):
        self.running = False
        self.step('stop')

    def replace(self, role):
        assert not self.running
        for index, path in enumerate(self.files):
            path.write_bytes(self.before[index] if role == 'baseline' else b'new code')
            self.step('partial-replace' if role == 'candidate' and index == 0 else 'replace-' + role)

    def start(self):
        self.running = True
        self.step('start')

    def verify(self, role):
        if role == 'candidate':
            with closing(sqlite3.connect(self.db)) as db, db:
                db.execute("insert into users values ('after restart')")
        self.step('health-' + role)


class ActivationTests(unittest.TestCase):
    def test_omitted_empty_environment_files_does_not_break_live_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            adapter = activation.Adapter.__new__(activation.Adapter)
            adapter.lock = root / 'lock'
            adapter.lock.write_bytes(b'fixture lock')
            adapter.lock_id = adapter.lock.stat()
            adapter.database = root / 'db'
            adapter.database.write_bytes(b'identity fixture')
            info = adapter.database.stat()
            adapter.database_id = info.st_dev, info.st_ino
            adapter.unit_files = {}
            adapter.props = {key: key for key in activation.base.STATIC_PROPERTIES}
            adapter.props.update(EnvironmentFiles='', MainPID='123', ActiveState='active', SubState='running')
            omitted = {key: value for key, value in adapter.props.items() if key != 'EnvironmentFiles'}
            with patch.object(activation.base, 'unit_properties', return_value=omitted):
                adapter.guard()
            changed = {**omitted, 'EnvironmentFiles': '/unexpected/file'}
            with patch.object(activation.base, 'unit_properties', return_value=changed), self.assertRaises(activation.base.GateError):
                adapter.guard()
            del omitted['User']
            with patch.object(activation.base, 'unit_properties', return_value=omitted), self.assertRaisesRegex(activation.base.GateError, 'LEGACY_UNIT_PROPERTIES_INCOMPLETE'):
                adapter.guard()

    def test_actual_server_health_contract_is_accepted(self):
        # This is the public server.py health contract, also returned by the
        # unchanged production service on 2026-10-25.
        activation.require_healthy_response({'status': 'ok', 'sensitiveFilterReady': True,
                                            'sensitiveWordCount': 20})

    def test_filter_must_be_explicitly_ready_before_activation_is_confirmed(self):
        for response in ({'status': 'ok', 'sensitiveFilterReady': False},
                         {'status': 'ok', 'filter_ready': True},
                         {'status': 'error', 'sensitiveFilterReady': True}):
            with self.subTest(response=response), self.assertRaises(activation.base.GateError):
                activation.require_healthy_response(response)

    def test_success_keeps_account_database_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter = Fake(Path(folder), None)
            self.assertEqual(activation.transact(adapter)['status'], 'ACTIVATED_LEGACY_V3_SETTINGS_UNDO')
            self.assertFalse(adapter.locked)
            self.assertEqual(adapter.db.stat().st_ino, adapter.db_id)

    def test_failures_restore_both_source_files_without_restoring_old_accounts(self):
        for fault in ('prepare', 'preflight', 'before-stop', 'stop', 'partial-replace', 'start', 'health-candidate'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                adapter = Fake(Path(folder), fault)
                with self.assertRaises(Exception):
                    activation.transact(adapter)
                self.assertTrue(adapter.running)
                self.assertFalse(adapter.locked)
                self.assertEqual([p.read_bytes() for p in adapter.files], adapter.before)
                self.assertEqual(adapter.db.stat().st_ino, adapter.db_id)
                if fault == 'health-candidate':
                    with closing(sqlite3.connect(adapter.db)) as db:
                        self.assertEqual(db.execute('select count(*) from users').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
