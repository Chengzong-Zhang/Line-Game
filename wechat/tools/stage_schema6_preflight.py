"""Stage an already-frozen WeChat bundle and run only remote preflight.

No activation, service stop, restart, database replacement, or secret output.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, subprocess, sys, zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
ARTIFACTS='/home/ubuntu/line-game/.deploy-artifacts'
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','lifeline-cloud']


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def call(args,**kw):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kw)
    if result.returncode:
        raise RuntimeError('COMMAND_FAILED:'+str(result.returncode)+':'+result.stderr.decode('utf-8',errors='replace')[-600:])
    return result.stdout


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--transport',type=Path,required=True)
    args=p.parse_args();bundle=args.bundle.resolve(strict=True)
    manifest=bundle/'release-manifest.json';doc=json.loads(manifest.read_text(encoding='utf-8'))
    release=doc['releaseId']
    if not re.fullmatch(r'wechat-service-all-20261029-r[1-9][0-9]*',release):raise ValueError('INVALID_ID')
    service=bundle/'service';actual={}
    for path in service.rglob('*'):
        if path.is_symlink():raise ValueError('SYMLINK')
        if path.is_file():actual[path.relative_to(service).as_posix()]=digest(path)
    if actual!=doc['candidate']:raise ValueError('CANDIDATE_DRIFT')
    for name,key in [('probe.py','probeSha256'),('rollback-probe.py','rollbackProbeSha256'),('rehearsal.py','rehearsalSha256')]:
        if digest(bundle/name)!=doc[key]:raise ValueError('PROBE_DRIFT')
    bundle_files={}
    for path in bundle.rglob('*'):
        if path.is_symlink():raise ValueError('BUNDLE_SYMLINK')
        if path.is_file():bundle_files[path.relative_to(bundle).as_posix()]=path
    expected={f'service/{name}' for name in doc['candidate']} | {'release-manifest.json','probe.py','rollback-probe.py','rehearsal.py'}
    if set(bundle_files)!=expected:raise ValueError('BUNDLE_INVENTORY_DRIFT')
    files={f'bundle/{name}':path for name,path in bundle_files.items()}
    operator_hashes={}
    for name in ('activate_profile_service_live.py','activate_service_schema6_release.py'):
        path=ROOT/'wechat/tools'/name
        if path.is_symlink() or not path.is_file():raise ValueError('OPERATOR_SOURCE_INVALID')
        files['ops/'+name]=path
        operator_hashes[name]=digest(path)
    manifest_sha=digest(manifest)
    with zipfile.ZipFile(args.transport,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for name,path in sorted(files.items()):archive.write(path,name)
    expected_archive = {f'bundle/service/{name}':value for name,value in doc['candidate'].items()}
    expected_archive.update({'bundle/release-manifest.json':manifest_sha,
        'bundle/probe.py':doc['probeSha256'], 'bundle/rollback-probe.py':doc['rollbackProbeSha256'],
        'bundle/rehearsal.py':doc['rehearsalSha256'],
        **{f'ops/{name}':value for name,value in operator_hashes.items()}})
    with zipfile.ZipFile(args.transport) as archive:
        if set(archive.namelist()) != set(expected_archive):raise ValueError('ARCHIVE_INVENTORY_DRIFT')
        for name, expected in expected_archive.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:raise ValueError('ARCHIVE_FILE_DRIFT')
    archive_sha=digest(args.transport)
    stage=f'{ARTIFACTS}/{release}-preflight-transport';run=f'{ARTIFACTS}/{release}-check'
    remote_code=r'''import pathlib,zipfile,hashlib,sys,os
root=pathlib.Path(sys.argv[1]); archive=root/'bundle.zip'
if hashlib.sha256(archive.read_bytes()).hexdigest()!=sys.argv[2]: raise SystemExit('ARCHIVE_HASH_MISMATCH')
with zipfile.ZipFile(archive) as z:
 for item in z.infolist():
  rel=pathlib.PurePosixPath(item.filename)
  if rel.is_absolute() or '..' in rel.parts or '\\' in item.filename or item.is_dir(): raise SystemExit('INVALID_ARCHIVE_ENTRY')
  target=root.joinpath(*rel.parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open('xb') as f:f.write(z.read(item))
print('STAGED_ARCHIVE_HASH_VERIFIED')'''
    call(SSH+['mkdir','-m','700',stage])
    call(['scp','-o','BatchMode=yes','-o','ConnectTimeout=15',str(args.transport),f'lifeline-cloud:{stage}/bundle.zip'])
    call(SSH+['python3','-',stage,archive_sha],input=remote_code.encode())
    output=call(SSH+['sudo','-n','python3',f'{stage}/ops/activate_service_schema6_release.py','preflight',
        '--manifest',f'{stage}/bundle/release-manifest.json','--expected-sha256',manifest_sha,
        '--bundle',f'{stage}/bundle','--run-dir',run])
    result=json.loads(output)
    if result.get('status')!='PREFLIGHT_PASSED_NO_LIVE_CHANGE' or result.get('databaseRestored') is not False:
        raise RuntimeError('PREFLIGHT_NOT_CONFIRMED')
    print(json.dumps({'status':result['status'],'releaseId':release,'archiveSha256':archive_sha,
                      'manifestSha256':manifest_sha,'remoteBundle':f'{stage}/bundle',
                      'remoteOps':f'{stage}/ops','preflightRun':run,'runtimeFiles':result['runtimeFiles'],
                      'operatorHashes':operator_hashes}))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'status':'PREFLIGHT_NOT_CONFIRMED','type':type(e).__name__,'detail':str(e)}),file=sys.stderr)
        raise SystemExit(1)
