"""Guarded Collector update with synthetic-only preflight and no production DB copy.

The baseline and candidate backend files must be byte-identical, so this
adapter does not permit backend/schema migrations. It reuses all original
service identity, database inode, writer, runtime hash and recovery gates.
"""
import argparse, importlib.util, json, os, re, signal
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('collector_original', HERE/'activate_collector_unified_release.py')
original = importlib.util.module_from_spec(spec); spec.loader.exec_module(original)
base = original.base
require = base.require
PREVIOUS_SHA = '79d9b649811c738a1b7324f4048e7fc09efb21421817c5d41db9717ef55eeaf7'


def check_contract(doc):
    require(doc.get('noProductionDatabaseCopy') is True and doc.get('previousReleaseManifestSha256') == PREVIOUS_SHA,
            'NO_COPY_CONTRACT')
    before, after = doc['baseline'], doc['candidate']
    names = sorted(n for n in set(before)|set(after) if n.startswith('web/backend/'))
    require(bool(names) and all(before.get(n) == after.get(n) for n in names), 'BACKEND_OR_SCHEMA_CHANGED')
    require(set(doc.get('orderedFixtureHashes',{})) == {'ordered_grid.json','ordered_topology.json'}, 'ORDERED_FIXTURES')
    require(set(doc.get('fixtureHashes',{})) == {'v1.json','v2.json','v3.json','v4.json'}, 'LEGACY_FIXTURES')
    for digest in [doc.get('probeSha256'), doc.get('orderedProbeSha256'), *doc['orderedFixtureHashes'].values(), *doc['fixtureHashes'].values()]:
        require(isinstance(digest,str) and re.fullmatch(r'[a-f0-9]{64}',digest), 'INVALID_PROBE_HASH')


class Adapter(original.Adapter):
    def __init__(self, doc, bundle, run_dir):
        check_contract(doc)
        super().__init__(doc,bundle,run_dir)
        require(base.tree(self.bundle/'baseline-runtime') == self.doc['baseline'], 'BASELINE_BUNDLE_DRIFT')

    def preflight(self):
        self.guard()
        probe=self.bundle/'collector-probe.py'; ordered=self.bundle/'collector-ordered-http-probe.py'
        require(base.sha(probe.read_bytes()) == self.doc['probeSha256'], 'PROBE_DRIFT')
        require(base.sha(ordered.read_bytes()) == self.doc['orderedProbeSha256'], 'ORDERED_PROBE_DRIFT')
        for field, dirname in (('fixtureHashes','fixtures'), ('orderedFixtureHashes','ordered-fixtures')):
            for name,digest in self.doc[field].items():
                require(base.sha((self.bundle/dirname/name).read_bytes()) == digest, 'FIXTURE_DRIFT')
        temp=self.run_dir/'probe-data'; temp.mkdir(); os.chown(temp,1000,1000); os.chmod(temp,0o700)
        # Only captured source is run: this initializes a fresh synthetic DB.
        # The production database path is never passed to the child process.
        baseline_module=self.bundle/'baseline-runtime/web/backend/training_contributions.py'
        synthetic = ("import importlib.util,pathlib,os,sys;"
          "p=pathlib.Path(sys.argv[1]);d=pathlib.Path(sys.argv[2]);s=importlib.util.spec_from_file_location('baseline',p);"
          "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);q=d/'baseline-seed';"
          "m.ContributionStore(q,node=sys.argv[3]);os.replace(q/'contributions.sqlite3',d/'migration.sqlite3')")
        env={**base.SYSTEM_ENV,'PYTHONDONTWRITEBYTECODE':'1'}
        base.command([self.site['python'],'-B','-c',synthetic,str(baseline_module),str(temp),self.site['node']],
                     user=(1000,1000),env=env,timeout=30)
        result=json.loads(base.command([self.site['python'],'-B',str(probe),'--service-root',str(self.staged),
          '--fixtures',str(self.bundle/'fixtures'),'--data',str(temp),'--node',self.site['node'],'--version','4'],
          user=(1000,1000),env=env,timeout=120))
        require(result.get('status')=='PASS_COLLECTOR_MIGRATION_AND_FIXTURES', 'SYNTHETIC_MIGRATION_PROBE_FAILED')
        http=json.loads(base.command([self.site['python'],'-B',str(ordered),'--service',str(self.staged),
          '--fixtures',str(self.bundle/'ordered-fixtures'),'--data',str(temp/'ordered-http'),
          '--python',self.site['python'],'--node',self.site['node']],user=(1000,1000),env=env,timeout=120))
        require(http.get('status')=='PASS_ORDERED_V4_ISOLATED_HTTP' and http.get('productionDatabaseCopied') is False,
                'ORDERED_HTTP_PROBE_FAILED')
        require(base.tree(self.staged)==self.doc['candidate'], 'PROBE_CHANGED_SOURCE')
        (self.run_dir/'preflight.json').write_text(json.dumps({'legacy':result,'ordered':http,
          'productionDatabaseCopied':False,'migrationData':'synthetic baseline schema only'},indent=2))

    def snapshot(self):
        # Deliberately no database read/copy; the original inode and stopped
        # writer checks still run immediately before the atomic code exchange.
        self.guard(); self.check_database()
        require(base.unit_properties(original.UNIT)['MainPID']=='0','STOP_BEFORE_EXCHANGE')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('manifest','bundle','run-dir'): p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--manifest-sha256',required=True); p.add_argument('--check-only',action='store_true'); p.add_argument('--execute',action='store_true')
    a=p.parse_args(); require(a.check_only != a.execute,'CHOOSE_CHECK_ONLY_OR_EXECUTE')
    raw=a.manifest.read_bytes(); require(base.sha(raw)==a.manifest_sha256,'MANIFEST_HASH')
    for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT):
        signal.signal(sig,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    adapter=Adapter(json.loads(raw),a.bundle,a.run_dir); result={'status':'STARTING'}
    try:
        if a.check_only:
            adapter.acquire()
            try: adapter.prepare(); adapter.preflight(); adapter.before_stop(); result={'status':'PASS_NO_COPY_COLLECTOR_PREFLIGHT'}
            finally: adapter.release()
        else: result=original.transact(adapter)
        result.update(databaseRestored=False,productionDatabaseCopied=False,manifestSha256=a.manifest_sha256,
                      previousRuntime=str(adapter.staged),supportedVersions=adapter.doc['supportedVersions'])
    except BaseException as error:
        result={'status':'FAILED_INSPECT_TRANSACTION','errorType':type(error).__name__,
                'errorCode':str(error) if isinstance(error,base.GateError) else 'DETAILS_OMITTED',
                'databaseRestored':False,'productionDatabaseCopied':False}
        raise
    finally: (adapter.run_dir/'activation.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))

if __name__=='__main__': main()
