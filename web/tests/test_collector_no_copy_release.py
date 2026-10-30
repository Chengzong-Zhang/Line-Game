import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('no_copy',ROOT/'web/tools/activate_collector_no_copy_release.py')
mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

class NoCopyTests(unittest.TestCase):
    def contract(self):
        return {'noProductionDatabaseCopy':True,'previousReleaseManifestSha256':mod.PREVIOUS_SHA,
          'baseline':{'web/backend/training_contributions.py':'a'*64},
          'candidate':{'web/backend/training_contributions.py':'a'*64},
          'probeSha256':'b'*64,'orderedProbeSha256':'c'*64,
          'orderedFixtureHashes':{'ordered_grid.json':'d'*64,'ordered_topology.json':'e'*64},
          'fixtureHashes':{f'v{i}.json':'f'*64 for i in range(1,5)}}
    def test_backend_change_and_fixture_drift_rejected(self):
        d=self.contract(); mod.check_contract(d)
        d['candidate']['web/backend/training_contributions.py']='1'*64
        with self.assertRaisesRegex(ValueError,'BACKEND_OR_SCHEMA_CHANGED'): mod.check_contract(d)
        d=self.contract(); del d['orderedFixtureHashes']['ordered_grid.json']
        with self.assertRaisesRegex(ValueError,'ORDERED_FIXTURES'): mod.check_contract(d)
        d=self.contract(); d['noProductionDatabaseCopy']=False
        with self.assertRaisesRegex(ValueError,'NO_COPY_CONTRACT'): mod.check_contract(d)
    def test_snapshot_does_not_read_or_copy_database(self):
        calls=[]
        obj=SimpleNamespace(guard=lambda:calls.append('guard'),check_database=lambda:calls.append('inode'))
        with patch.object(mod.base,'unit_properties',return_value={'MainPID':'0'}), patch.object(mod.base,'command',side_effect=AssertionError('no command')):
            mod.Adapter.snapshot(obj)
        self.assertEqual(calls,['guard','inode'])
    def test_preflight_only_passes_synthetic_paths_to_children(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); bundle=root/'bundle'; bundle.mkdir(); run=root/'run'; run.mkdir(); staged=root/'staged'; staged.mkdir()
            def write(name,raw):
                p=bundle/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(raw); return mod.base.sha(raw)
            doc={'candidate':{},'probeSha256':write('collector-probe.py',b'p'),
                 'orderedProbeSha256':write('collector-ordered-http-probe.py',b'o'),
                 'fixtureHashes':{f'v{i}.json':write(f'fixtures/v{i}.json',b'v') for i in range(1,5)},
                 'orderedFixtureHashes':{f'{n}.json':write(f'ordered-fixtures/{n}.json',b'n') for n in ('ordered_grid','ordered_topology')}}
            commands=[]
            def command(args,**kw):
                commands.append(args)
                if 'collector-probe.py' in str(args[2]): return json.dumps({'status':'PASS_COLLECTOR_MIGRATION_AND_FIXTURES'})
                if 'collector-ordered-http-probe.py' in str(args[2]): return json.dumps({'status':'PASS_ORDERED_V4_ISOLATED_HTTP','productionDatabaseCopied':False})
                return ''
            obj=SimpleNamespace(bundle=bundle,doc=doc,run_dir=run,staged=staged,site={'python':'python','node':'node'},guard=lambda:None)
            with patch.object(mod.base,'command',side_effect=command), patch.object(mod.base,'tree',return_value={}), patch.object(mod.os,'chown',create=True):
                mod.Adapter.preflight(obj)
            self.assertEqual(len(commands),3)
            self.assertFalse(any('line-game-data' in str(arg) for command in commands for arg in command))
            self.assertTrue(json.loads((run/'preflight.json').read_text())['productionDatabaseCopied'] is False)

if __name__=='__main__': unittest.main()
