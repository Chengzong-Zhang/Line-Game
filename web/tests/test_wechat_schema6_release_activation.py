"""Failure recovery model for the complete-runtime release adapter.

These are local transaction checks, not proof of Linux/systemd activation.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("service_release_test", ROOT / "wechat/tools/activate_service_schema6_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Adapter:
    def __init__(self, failure=None, recovery_failure=False):
        self.calls = []
        self.failure = failure
        self.recovery_failure = recovery_failure
        self.recovering = self.journal_incomplete = False
        self.files = {"baseline": {"version": "old"}, "candidate": {"version": "new"}, "rollback": {"version": "old"}}
        self.live = "synthetic-live"
        self.current = self.files["baseline"]
        self.locked = False
        self.raised = False

    def step(self, name):
        self.calls.append(name)
        if self.failure == name and not self.raised:
            self.raised = True
            raise release.GateError("INJECTED_FAILURE")

    def acquire(self):
        self.locked = True
        self.step("acquire")

    def release(self):
        self.step("release")
        self.locked = False

    def prepare(self): self.step("prepare")
    def preflight(self): self.step("preflight")
    def before_stop(self): self.step("before_stop")
    def stop(self): self.step("stop")
    def snapshot(self): self.step("snapshot")

    def switch(self, role, expected):
        assert self.current == expected
        self.current = self.files[role]
        self.step("switch_" + role)

    def start(self, role): self.step("start_" + role)

    def health(self, role):
        self.step("health_" + role)
        if self.recovering and self.recovery_failure:
            raise release.GateError("INJECTED_RECOVERY_FAILURE")

    def event(self, name, **details): self.calls.append("event:" + name)


class ReleaseTransactionTests(unittest.TestCase):
    def run_adapter(self, adapter):
        with patch.object(release.base, "tree", lambda _path: adapter.current):
            return release.base.transact(adapter)

    def test_success_uses_full_candidate_and_releases_lock(self):
        adapter = Adapter()
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "ACTIVATED_PROFILE_SERVICE")
        self.assertEqual(adapter.current, adapter.files["candidate"])
        self.assertFalse(adapter.locked)
        self.assertFalse(result["databaseRestored"])

    def test_preflight_failure_never_stops_service(self):
        adapter = Adapter("preflight")
        with self.assertRaises(release.GateError):
            self.run_adapter(adapter)
        self.assertNotIn("stop", adapter.calls)
        self.assertFalse(adapter.locked)

    def test_partial_stop_failure_restarts_unchanged_baseline(self):
        adapter = Adapter("stop")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_BASELINE")
        self.assertIn("start_baseline", adapter.calls)
        self.assertFalse(adapter.locked)

    def test_failure_after_exchange_recovers_actual_original_tree(self):
        adapter = Adapter("switch_candidate")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_ROLLBACK")
        self.assertEqual(adapter.current, adapter.files["baseline"])
        self.assertIn("health_rollback", adapter.calls)
        self.assertFalse(result["databaseRestored"])
        self.assertFalse(adapter.locked)

    def test_failed_new_health_recovers_old_code_and_keeps_database(self):
        adapter = Adapter("health_candidate")
        result = self.run_adapter(adapter)
        self.assertEqual(result["status"], "RECOVERED_ROLLBACK")
        self.assertEqual(adapter.current, adapter.files["baseline"])
        self.assertFalse(result["databaseRestored"])

    def test_uncertain_recovery_retains_lock(self):
        adapter = Adapter("health_candidate", recovery_failure=True)
        with self.assertRaisesRegex(release.GateError, "RECOVERY_BLOCKED"):
            self.run_adapter(adapter)
        self.assertTrue(adapter.locked)


class RuntimeStagingTests(unittest.TestCase):
    """Exercise real directories and hashes without Linux/systemd mutation."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lifeline-service-staging-")
        self.root = Path(self.temporary.name)
        self.live = self.root / "live"
        self.bundle = self.root / "bundle"
        self.live.mkdir()
        (self.bundle / "service").mkdir(parents=True)
        for index in range(57):
            if index < 51:
                (self.live / (str(index) + ".js")).write_bytes(("previous-" + str(index)).encode())
            (self.bundle / "service" / (str(index) + ".js")).write_bytes(("candidate-" + str(index)).encode())

    def tearDown(self):
        self.temporary.cleanup()

    def adapter(self, metadata=False):
        if metadata:
            (self.live / release.METADATA).write_bytes(b"reviewed-existing-metadata")
        baseline = release.base.tree(self.live)
        candidate = release.base.tree(self.bundle / "service")
        extras = {}
        if metadata:
            extras[release.METADATA] = baseline[release.METADATA]
            candidate.update(extras)
        doc = {"baseline": baseline, "candidate": candidate, "site": {"baselineExtras": extras}}
        adapter = release.ReleaseAdapter.__new__(release.ReleaseAdapter)
        adapter.doc, adapter.live, adapter.bundle = doc, self.live, self.bundle
        adapter.files = {"baseline": baseline, "rollback": baseline, "candidate": candidate}
        adapter.metadata_sha256 = release.retained_metadata(doc)
        return adapter

    def test_51_to_57_source_files_without_metadata_does_not_invent_or_read_it(self):
        adapter = self.adapter()
        self.assertEqual(len(adapter.files["baseline"]), 51)
        self.assertEqual(len(adapter.files["candidate"]), 57)
        adapter.stage_role("candidate", self.root / "candidate")
        adapter.stage_role("rollback", self.root / "rollback")
        self.assertEqual(release.base.tree(self.root / "candidate"), adapter.files["candidate"])
        self.assertEqual(release.base.tree(self.root / "rollback"), adapter.files["baseline"])
        self.assertFalse((self.root / "candidate" / release.METADATA).exists())
        self.assertFalse((self.root / "rollback" / release.METADATA).exists())

    def test_52_to_58_files_with_metadata_preserves_its_exact_bytes(self):
        adapter = self.adapter(metadata=True)
        self.assertEqual(len(adapter.files["baseline"]), 52)
        self.assertEqual(len(adapter.files["candidate"]), 58)
        adapter.stage_role("candidate", self.root / "candidate")
        adapter.stage_role("rollback", self.root / "rollback")
        for role in ("candidate", "rollback"):
            self.assertEqual((self.root / role / release.METADATA).read_bytes(), b"reviewed-existing-metadata")
            self.assertEqual(release.base.tree(self.root / role), adapter.files[role])

    def test_candidate_cannot_invent_unobserved_metadata(self):
        adapter = self.adapter()
        adapter.doc["candidate"][release.METADATA] = "0" * 64
        with self.assertRaisesRegex(release.GateError, "METADATA_PRESENCE_MISMATCH"):
            release.retained_metadata(adapter.doc)

    def test_candidate_cannot_silently_drop_existing_metadata(self):
        adapter = self.adapter(metadata=True)
        del adapter.doc["candidate"][release.METADATA]
        with self.assertRaisesRegex(release.GateError, "METADATA_PRESENCE_MISMATCH"):
            release.retained_metadata(adapter.doc)

    def test_retained_metadata_must_have_the_same_pinned_hash(self):
        adapter = self.adapter(metadata=True)
        adapter.doc["candidate"][release.METADATA] = "0" * 64
        with self.assertRaisesRegex(release.GateError, "RETAINED_METADATA_HASH_MISMATCH"):
            release.retained_metadata(adapter.doc)

    def test_site_extras_must_agree_with_observed_metadata_presence(self):
        adapter = self.adapter()
        adapter.doc["site"]["baselineExtras"] = {release.METADATA: "0" * 64}
        with self.assertRaisesRegex(release.GateError, "METADATA_SITE_MISMATCH"):
            release.retained_metadata(adapter.doc)

    def test_source_hash_drift_still_blocks_candidate_staging(self):
        adapter = self.adapter()
        (self.bundle / "service/0.js").write_bytes(b"changed-after-pinning")
        with self.assertRaisesRegex(release.GateError, "STAGED_TREE_DRIFT"):
            adapter.stage_role("candidate", self.root / "candidate")

    def test_unlisted_source_file_still_blocks_candidate_staging(self):
        adapter = self.adapter()
        (self.bundle / "service/unlisted.js").write_bytes(b"unlisted")
        with self.assertRaisesRegex(release.GateError, "STAGED_TREE_DRIFT"):
            adapter.stage_role("candidate", self.root / "candidate")

    def test_changed_live_metadata_is_rejected_before_copy(self):
        adapter = self.adapter(metadata=True)
        (self.live / release.METADATA).write_bytes(b"changed-after-observation")
        with self.assertRaisesRegex(release.GateError, "RETAINED_METADATA_DRIFT"):
            adapter.stage_role("candidate", self.root / "candidate")


if __name__ == "__main__":
    unittest.main()

class HealthContractTests(unittest.TestCase):
    def setUp(self):
        self.current = {'enabled':True,'accountProfile':True,'webLogin':True,'webAuthMode':'password',
                        'rulesVersion':'territory-v3','supportedRulesVersions':['territory-v2','territory-v3']}
        self.candidate = {**self.current,'supportedRulesVersions':['territory-v2','territory-v3','surface-v1'],
                          'topologyProtocols':['board-topology-v1'],'boardHashSchema':'board-hash-v1','rootRulesVersions':['root-v1','root-v2'],
                          'roomSettings':True,'undoVoting':True}
    def test_exact_baseline_and_candidate_contract(self):
        release.require_health_capabilities(self.current,'baseline')
        release.require_health_capabilities(self.candidate,'candidate')
        with self.assertRaises(release.GateError): release.require_health_capabilities(self.current,'candidate')
        with self.assertRaises(release.GateError): release.require_health_capabilities(self.candidate,'baseline')
    def test_missing_topology_or_root_capability_is_rejected(self):
        for key in ('topologyProtocols','boardHashSchema','rootRulesVersions','undoVoting'):
            bad = dict(self.candidate); bad.pop(key)
            with self.assertRaises(release.GateError): release.require_health_capabilities(bad,'candidate')

class ManualRollbackContractTests(unittest.TestCase):
    def test_reuses_confirmed_old_tree_and_reverses_candidate(self):
        import json
        with tempfile.TemporaryDirectory() as raw:
            artifacts = Path(raw); previous = artifacts / 'prior'; previous.mkdir()
            old = previous / 'rollback'; old.mkdir(); (old / 'runtime').write_text('old')
            doc = {'releaseId':'wechat-service-all-20261029-r1', 'baseline':release.base.tree(old),
                   'candidate':{'runtime':'a'*64}, 'rollbackProbeSha256':'b'*64}
            (previous/'activation.json').write_text(json.dumps({'status':'ACTIVATED_SERVICE_RELEASE',
                'releaseId':doc['releaseId'], 'databaseRestored':False}))
            with patch.object(release, 'ARTIFACTS_ROOT', artifacts), patch.object(release.ReleaseAdapter, '__init__', return_value=None) as init:
                release.RollbackAdapter(doc, artifacts/'bundle', artifacts/'new', previous)
                swapped = init.call_args.args[0]
                self.assertEqual(swapped['baseline'], doc['candidate'])
                self.assertEqual(swapped['candidate'], doc['baseline'])
                self.assertEqual(swapped['probeSha256'], doc['rollbackProbeSha256'])
                (old/'runtime').write_text('changed')
                with self.assertRaisesRegex(release.GateError,'PRIOR_ROLLBACK_TREE_DRIFT'):
                    release.RollbackAdapter(doc, artifacts/'bundle', artifacts/'new', previous)

class SnapshotPrivacyTests(unittest.TestCase):
    def test_snapshot_backups_same_database_without_selecting_user_rows(self):
        import sqlite3, subprocess, sys
        from contextlib import closing
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw); live=root/'live';live.mkdir();run=root/'run';run.mkdir();db=root/'source.sqlite3'
            with closing(sqlite3.connect(db)) as connection:
                self.assertEqual(connection.execute('PRAGMA journal_mode=WAL').fetchone()[0].lower(),'wal')
                connection.execute('PRAGMA user_version=6')
                connection.execute('CREATE TABLE synthetic_room (document TEXT)')
                connection.execute('INSERT INTO synthetic_room VALUES (?)',('test-only-private-value',))
                connection.commit()
            adapter=release.ReleaseAdapter.__new__(release.ReleaseAdapter)
            adapter.live=live;adapter.run_dir=run;adapter.database=db
            adapter.site={'uid':1000,'gid':1000,'python':sys.executable};adapter.files={'baseline':release.base.tree(live)}
            events=[];adapter.assert_quiescent=lambda:None;adapter.check_database=lambda:None
            adapter.event=lambda name,**values:events.append((name,values))
            def command(args,**_kwargs):return subprocess.check_output(args)
            with patch.object(release.os,'chown',create=True),patch.object(release.base,'command',command): adapter.snapshot()
            backup=run/'database-backup'/'before.sqlite3'
            self.assertTrue(backup.is_file()); self.assertEqual(events[0][0],'QUIESCENT_SNAPSHOT_COMPLETE')
            self.assertNotIn('test-only-private-value',repr(events))
            with closing(sqlite3.connect(backup)) as copied:
                self.assertEqual(copied.execute('PRAGMA user_version').fetchone()[0],6)
                self.assertEqual(copied.execute('PRAGMA journal_mode').fetchone()[0].lower(),'delete')
