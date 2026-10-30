"""Local r6 provenance gates; synthetic files only, no production access."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('schema6_r6', ROOT / 'wechat/tools/activate_service_schema6_r6_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class R6ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.manifest = self.root / 'release-manifest.json'
        self.predecessor = self.root / 'service' / release.R6_PREFIX
        files = self.predecessor / 'service'
        files.mkdir(parents=True)
        for number in range(266):
            (files / f'{number}.js').write_bytes(f'r6-{number}'.encode())
        self.inventory = release.base.tree(files)
        r6 = {'schemaVersion': 1, 'kind': 'wechat-complete-runtime-release',
              'releaseId': 'wechat-service-all-20261029-r6', 'candidate': self.inventory,
              'site': {'baselineExtras': {}, 'database': {'path': '/var/lib/lifeline-wechat/wechat.sqlite3',
                                                         'device': 64514, 'inode': 1053174}}}
        data = json.dumps(r6).encode()
        (self.predecessor / 'release-manifest.json').write_bytes(data)
        self.pin = sha(data)
        self.doc = {'schemaVersion': 1, 'kind': 'wechat-complete-runtime-release',
                    'releaseId': 'wechat-service-all-20261030-r1', 'baseline': dict(self.inventory),
                    'candidate': {**{f'{release.R6_PREFIX}/service/{k}': v for k, v in self.inventory.items()},
                                  f'{release.R6_PREFIX}/release-manifest.json': self.pin},
                    'site': {'baselineExtras': {}, 'database': {'path': '/var/lib/lifeline-wechat/wechat.sqlite3',
                                                               'device': 64514, 'inode': 1053174}}}

    def tearDown(self):
        self.temp.cleanup()

    def load(self):
        raw = json.dumps(self.doc).encode()
        self.manifest.write_bytes(raw)
        with patch.object(release, 'R6_MANIFEST_SHA256', self.pin):
            return release.load_manifest(self.manifest, sha(raw))

    def test_exact_inventory_is_accepted(self):
        self.assertEqual(self.load()['baseline'], self.inventory)

    def test_baseline_drift_rejected(self):
        self.doc['baseline']['0.js'] = 'a' * 64
        with self.assertRaisesRegex(release.GateError, 'R6_BASELINE_INVENTORY_DRIFT'):
            self.load()

    def test_missing_and_extra_predecessor_files_rejected(self):
        del self.doc['candidate'][f'{release.R6_PREFIX}/service/0.js']
        with self.assertRaisesRegex(release.GateError, 'R6_PREDECESSOR_INVENTORY_DRIFT'):
            self.load()
        self.doc['candidate'][f'{release.R6_PREFIX}/service/0.js'] = self.inventory['0.js']
        self.doc['candidate'][f'{release.R6_PREFIX}/unlisted.js'] = 'a' * 64
        with self.assertRaisesRegex(release.GateError, 'R6_PREDECESSOR_EXTRA_FILES'):
            self.load()

    def test_predecessor_bytes_and_manifest_are_hash_bound(self):
        (self.predecessor / 'service/0.js').write_bytes(b'tampered')
        with self.assertRaisesRegex(release.GateError, 'R6_PREDECESSOR_TREE_DRIFT'):
            self.load()
        (self.predecessor / 'service/0.js').write_bytes(b'r6-0')
        (self.predecessor / 'release-manifest.json').write_bytes(b'{}')
        with self.assertRaisesRegex(release.GateError, 'R6_MANIFEST_DRIFT'):
            self.load()

    def test_wrong_database_inode_rejected(self):
        self.doc['site']['database']['inode'] += 1
        with self.assertRaisesRegex(release.GateError, 'DATABASE_IDENTITY_PIN'):
            self.load()

    def test_symlink_in_predecessor_rejected(self):
        target = self.predecessor / 'service/0.js'
        try:
            target.unlink()
            target.symlink_to(self.predecessor / 'service/1.js')
        except OSError:
            self.skipTest('creating symlinks is unavailable')
        with self.assertRaises(release.GateError):
            self.load()

    def test_both_health_roles_require_r6_topology_contract(self):
        health = {'enabled': True, 'accountProfile': True, 'webLogin': True, 'webAuthMode': 'password',
                  'rulesVersion': 'territory-v3', 'supportedRulesVersions': ['territory-v2', 'territory-v3', 'surface-v1'],
                  'topologyProtocols': ['board-topology-v1'], 'boardHashSchema': 'board-hash-v1',
                  'rootRulesVersions': ['root-v1', 'root-v2'], 'roomSettings': True, 'undoVoting': True}
        for role in ('baseline', 'candidate'):
            release.require_health_capabilities(health, role)
            with self.assertRaises(release.GateError):
                release.require_health_capabilities({**health, 'roomSettings': False}, role)

    def test_candidate_bundle_rejects_probe_and_runtime_drift(self):
        for filename, data in [('probe.py', b'probe'), ('rollback-probe.py', b'rollback'), ('rehearsal.py', b'rehearsal')]:
            (self.root / filename).write_bytes(data)
        self.doc.update(probeSha256=sha(b'probe'), rollbackProbeSha256=sha(b'rollback'), rehearsalSha256=sha(b'rehearsal'))
        adapter = release.ReleaseAdapter.__new__(release.ReleaseAdapter)
        adapter.doc, adapter.bundle = self.doc, self.root
        adapter.files = {'candidate': self.doc['candidate']}
        adapter.verify_bundle()
        (self.root / 'rollback-probe.py').write_bytes(b'tampered')
        with self.assertRaisesRegex(release.GateError, 'ROLLBACK_PROBE_DRIFT'):
            adapter.verify_bundle()
        (self.root / 'rollback-probe.py').write_bytes(b'rollback')
        (self.predecessor / 'service/0.js').write_bytes(b'tampered')
        with self.assertRaisesRegex(release.GateError, 'BUNDLE_RUNTIME_DRIFT'):
            adapter.verify_bundle()


class RollbackRoomGateTests(unittest.TestCase):
    R6 = '4d36330909bacc0f2e69657da168b01194a617536d8589048b45c26de013ab6a'

    def setUp(self):
        import sqlite3
        from contextlib import closing
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / 'synthetic.sqlite3'
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('PRAGMA user_version=6')
            db.execute('CREATE TABLE wx_rooms (code TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL, document TEXT NOT NULL)')
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def room(self, status='playing', **fields):
        import time
        return {'status': status, 'settings': {'playerCount':2, 'rulesVersion':'territory-v3'},
                'state': {'currentPlayer':'BLACK', 'stateHash':'test', 'gameOver':False},
                'players': {'BLACK':'fixture'}, 'actions': [], 'seq':0, 'matchId':'fixture-match',
                'expiresAt': int(time.time()) + 3600, **fields}

    def insert(self, code, room, raw=None):
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('INSERT INTO wx_rooms VALUES (?, 1, ?, ?)',
                       (code, room['expiresAt'], json.dumps(room) if raw is None else raw))
            db.commit()

    def scan(self):
        import subprocess, sys
        output = subprocess.check_output([sys.executable, '-B', '-c', release.ROLLBACK_SCAN_SOURCE, str(self.database)])
        return json.loads(output)

    def test_legacy_active_rooms_are_counted_but_not_represented_as_unaffected(self):
        self.insert('a', self.room())
        self.insert('b', self.room(rankedAI='configured', rankedContext={'runtime': self.R6}))
        counts = self.scan()
        self.assertEqual(counts, {'activeOrdinary': 1, 'activeRankedR6': 1, 'turnOrderRooms': 0,
                                  'otherRuntimeRooms': 0, 'unknownRooms': 0})

    def test_turn_order_new_fingerprint_corruption_and_unknown_are_counted(self):
        self.insert('a', self.room(settings={'playerCount':2, 'rulesVersion':'territory-v3', 'turnOrder':['WHITE', 'BLACK']}))
        self.insert('b', self.room(rankedAI='configured', rankedContext={'runtime':'a'*64}))
        self.insert('c', self.room(), raw='{broken')
        self.insert('d', self.room(status='unknown'))
        self.insert('e', self.room(rankedAI='configured'))
        counts = self.scan()
        self.assertEqual((counts['turnOrderRooms'], counts['otherRuntimeRooms'], counts['unknownRooms']), (1, 1, 3))

    def test_expired_rooms_are_excluded_but_finished_new_state_is_conservatively_blocked(self):
        import time
        expired = self.room(settings={'playerCount':2, 'rulesVersion':'territory-v3', 'turnOrder':['BLACK', 'WHITE']}); expired['expiresAt'] = int(time.time()) - 60
        self.insert('a', expired)
        self.insert('b', self.room(status='finished', pendingSettings={'turnOrder':['WHITE', 'BLACK']}))
        self.assertEqual(self.scan()['turnOrderRooms'], 1)

    def test_duplicate_json_key_is_unknown_and_no_content_is_output(self):
        room = self.room()
        raw = '{"status":"playing","status":"waiting","private":"secret-value"}'
        self.insert('a', room, raw=raw)
        counts = self.scan()
        self.assertEqual(counts['unknownRooms'], 1)
        self.assertNotIn('secret-value', repr(counts))

    def test_gate_rejects_and_only_emits_aggregate(self):
        import subprocess, sys
        self.insert('a', self.room(settings={'playerCount':2, 'rulesVersion':'territory-v3', 'turnOrder':['WHITE', 'BLACK']}))
        events = []
        adapter = type('Fake', (), {})()
        adapter.database = self.database
        adapter.site = {'python': sys.executable, 'uid': 1, 'gid': 1}
        adapter.assert_quiescent = lambda: events.append(('quiescent', {}))
        adapter.event = lambda name, **data: events.append((name, data))
        def command(args, **kwargs):
            return subprocess.check_output(args)
        with patch.object(release.base, 'command', command):
            with self.assertRaisesRegex(release.GateError, 'R6_ROLLBACK_INCOMPATIBLE_OR_UNKNOWN_ROOMS'):
                release.require_r6_rollback_safe(adapter)
        self.assertEqual([x[0] for x in events], ['quiescent', 'quiescent', 'R6_ROLLBACK_ROOM_AGGREGATE'])
        self.assertEqual(events[-1][1]['turnOrderRooms'], 1)
        self.assertNotIn('WHITE', repr(events))

    def test_race_after_snapshot_refuses_exchange_and_restarts_new_code(self):
        import subprocess, sys
        owner = self
        class FakeRollback(release.RollbackAdapter):
            def __init__(self):
                self.database = owner.database
                self.site = {'python':sys.executable, 'uid':1, 'gid':1}
                self.calls = []
                self.recovering = self.journal_incomplete = False
                self.live = 'live'; self.prepared = {'rollback':'same-new-tree'}
                self.files = {'baseline':{'new':'1'}, 'candidate':{'old':'2'}, 'rollback':{'new':'1'}}
                self.current = self.files['baseline']
            def event(self, name, **details): self.calls.append(name)
            def acquire(self): self.calls.append('acquire')
            def release(self): self.calls.append('release')
            def prepare(self): pass
            def preflight(self): pass
            def before_stop(self): pass
            def assert_quiescent(self): self.calls.append('quiescent')
            def stop(self): self.calls.append('stop')
            def snapshot(self):
                super().snapshot()
                owner.insert('race', owner.room(settings={'playerCount':2, 'rulesVersion':'territory-v3', 'turnOrder':['WHITE', 'BLACK']}))
            def start(self, role): self.calls.append('start_' + role)
            def health(self, role): self.calls.append('health_' + role)
        adapter = FakeRollback()
        def command(args, **kwargs): return subprocess.check_output(args)
        with patch.object(release.base, 'command', command), patch.object(release.ReleaseAdapter, 'snapshot', lambda self: None), \
             patch.object(release.base, 'tree', lambda path: adapter.current), patch.object(release.base, 'exchange') as exchange:
            result = release.base.transact(adapter)
        self.assertEqual(result['status'], 'RECOVERED_ROLLBACK')
        self.assertFalse(result['databaseRestored'])
        self.assertEqual(adapter.current, adapter.files['baseline'])
        self.assertIn('start_rollback', adapter.calls)
        exchange.assert_not_called()
        self.assertEqual(self.scan()['turnOrderRooms'], 1)

    def test_automatic_recovery_does_not_switch_to_r6_when_new_room_exists(self):
        import subprocess, sys
        owner = self
        class FakeActivation(release.ReleaseAdapter):
            def __init__(self):
                self.database=owner.database; self.site={'python':sys.executable,'uid':1,'gid':1}
                self.live='live'; self.prepared={'rollback':'old-tree'}
                self.files={'baseline':{'old':'1'},'candidate':{'new':'2'},'rollback':{'old':'1'}}
                self.current=self.files['baseline']; self.recovering=self.journal_incomplete=False
                self.calls=[]
            def acquire(self): self.calls.append('acquire')
            def release(self): self.calls.append('release')
            def prepare(self): pass
            def preflight(self): pass
            def before_stop(self): pass
            def snapshot(self): pass
            def assert_quiescent(self): pass
            def stop(self): self.calls.append('stop')
            def event(self,name,**details): self.calls.append(name)
            def start(self,role): self.calls.append('start_'+role)
            def health(self,role):
                if role == 'candidate':
                    owner.insert('new',owner.room(settings={'playerCount':2,'rulesVersion':'territory-v3',
                                                           'turnOrder':['WHITE','BLACK']}))
                    raise release.GateError('HEALTH_FAILED')
            def switch(self,role,expected):
                if role == 'candidate':
                    self.current=self.files['candidate']
                else:
                    super().switch(role,expected)
        adapter=FakeActivation()
        with patch.object(release.base,'command',lambda args,**kwargs: subprocess.check_output(args)), \
             patch.object(release.base,'tree',lambda path: adapter.current), patch.object(release.base,'exchange') as exchange:
            with self.assertRaisesRegex(release.GateError,'RECOVERY_BLOCKED_KEEP_LATEST_DATABASE_LOCK_AND_JOURNAL'):
                release.base.transact(adapter)
        self.assertEqual(adapter.current,adapter.files['candidate'])
        self.assertNotIn('release',adapter.calls)
        self.assertNotIn('start_rollback',adapter.calls)
        exchange.assert_not_called()

    def test_sql_scan_returns_only_aggregate_and_never_projects_documents(self):
        import re
        source = release.ROLLBACK_SCAN_SOURCE
        self.assertNotRegex(source, r'(?i)select\s+(?:\w+\s*,\s*)*document\b')
        self.assertNotIn('json.loads', source)
        self.assertNotRegex(source, r'(?i)json_extract\s*\(\s*document\s*,\s*[\"\']\$\.(?:players|actions)[\"\']')
        self.assertIn("db.execute('PRAGMA query_only=ON')", source)
        self.insert('a', self.room(players={'BLACK':'sensitive-account'}, actions=[{'private':'private-action'}]))
        self.assertNotIn('sensitive-account', repr(self.scan()))
        self.assertNotIn('private-action', repr(self.scan()))

    def test_snapshot_checks_original_in_place_without_copy_or_write(self):
        import subprocess, sys
        root = self.database.parent
        adapter = release.ReleaseAdapter.__new__(release.ReleaseAdapter)
        adapter.live = root / 'runtime'; adapter.live.mkdir()
        adapter.database = self.database
        adapter.run_dir = root / 'run'; adapter.run_dir.mkdir()
        adapter.site = {'python':sys.executable, 'uid':1, 'gid':1}
        adapter.files = {'baseline':release.base.tree(adapter.live)}
        events=[]
        adapter.assert_quiescent=lambda:events.append(('quiescent',{}))
        adapter.event=lambda name,**values:events.append((name,values))
        before=sha(self.database.read_bytes())
        with patch.object(release.base,'command',lambda args,**kwargs: subprocess.check_output(args)):
            adapter.snapshot()
        self.assertEqual(sha(self.database.read_bytes()),before)
        self.assertEqual(list(adapter.run_dir.iterdir()),[])
        self.assertEqual(events[-1],('QUIESCENT_DATABASE_READ_ONLY_VERIFIED',{'schema':6,'copied':False}))

    def test_preflight_synthetic_rehearsal_never_receives_production_database(self):
        import inspect
        source=inspect.getsource(release.ReleaseAdapter.preflight)
        rehearsal_call=source[source.index('raw = base.command([self.site["python"], "-B", str(rehearsal)'):]
        rehearsal_call=rehearsal_call[:rehearsal_call.index('require(json.loads(raw)')]
        self.assertNotIn('self.database',rehearsal_call)
        self.assertNotIn('--source',rehearsal_call)
        self.assertIn('PASS_SCHEMA6_SYNTHETIC_BOTH_REVISIONS', source)

    def test_snapshot_rejects_bad_schema_without_copy_or_change(self):
        import sqlite3, subprocess, sys
        from contextlib import closing
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('PRAGMA user_version=5'); db.commit()
        adapter=release.ReleaseAdapter.__new__(release.ReleaseAdapter)
        adapter.database=self.database
        adapter.live=self.database.parent/'runtime'; adapter.live.mkdir()
        adapter.run_dir=self.database.parent/'run'; adapter.run_dir.mkdir()
        adapter.site={'python':sys.executable,'uid':1,'gid':1}
        adapter.files={'baseline':release.base.tree(adapter.live)}
        adapter.assert_quiescent=lambda:None
        adapter.event=lambda *args,**kwargs:None
        before=sha(self.database.read_bytes())
        with patch.object(release.base,'command',lambda args,**kwargs: subprocess.check_output(args)):
            with self.assertRaisesRegex(release.GateError,'DATABASE_READ_ONLY_CHECK_FAILED'):
                adapter.snapshot()
        self.assertEqual(sha(self.database.read_bytes()),before)
        self.assertEqual(list(adapter.run_dir.iterdir()),[])


if __name__ == '__main__':
    unittest.main()
