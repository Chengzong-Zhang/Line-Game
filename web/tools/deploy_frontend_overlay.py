"""Deploy a frozen overlay over existing SSH authentication; never stores secrets."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import time


def prepare(bundle, predecessor):
    manifest = json.loads((bundle / "release-manifest.json").read_text(encoding="utf-8"))
    receipt = json.loads((bundle / "bundle-receipt.json").read_text(encoding="utf-8"))
    archive = (bundle / "frontend-overlay.zip").read_bytes()
    assert hashlib.sha256(archive).hexdigest() == receipt["archive_sha256"]
    atomic = Path(__file__).with_name("atomic_frontend_release.py").read_bytes()
    compile(atomic, "atomic_frontend_release.py", "exec")
    predecessors = {name: hashlib.sha256((predecessor / name).read_bytes()).hexdigest()
                    for name in ("index.html", "OnlineApp.js", "TrainingContribution.js", "release-manifest.json")}
    # The uploaded payload contains only reviewed runtime files and deployment
    # code. SSH obtains the password from its interactive console, not this file.
    bootstrap = f'''import base64,fcntl,hashlib,importlib.util,json,pathlib,subprocess,sys,urllib.request
release_id={manifest['release_id']!r}
archive_raw=base64.b64decode({base64.b64encode(archive).decode()!r},validate=True)
atomic_raw=base64.b64decode({base64.b64encode(atomic).decode()!r},validate=True)
assert hashlib.sha256(archive_raw).hexdigest()=={receipt['archive_sha256']!r}
assert hashlib.sha256(atomic_raw).hexdigest()=={hashlib.sha256(atomic).hexdigest()!r}
root=pathlib.Path('/home/ubuntu/line-game').resolve(strict=True)
live=root/'web/web前端'
artifacts=root/'.deploy-artifacts';artifacts.mkdir(mode=0o700,exist_ok=True)
assert live.resolve(strict=True)==live and artifacts.resolve(strict=True)==artifacts
ops=__import__('types').ModuleType('release_ops');exec(compile(atomic_raw,'<atomic_release>','exec'),ops.__dict__)
activation=artifacts/(release_id+'.activation.json')
if activation.exists():
 result=json.loads(activation.read_text());assert ops.tree(live)==result['active_tree_sha256'];print(json.dumps(result,ensure_ascii=False));sys.exit(0)
for endpoint in ('api/health','api/training/contributions/status'):
 response=json.loads(urllib.request.urlopen('https://lifelinegame.cn/'+endpoint,timeout=15).read())
 if endpoint=='api/health':assert response.get('status')=='ok'
 else:assert response.get('enabled') is True and response.get('consent_policy')=='anonymous-replay-training-v1'
with (artifacts/'frontend-release.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 for name,expected in {predecessors!r}.items():assert ops.sha(live/name)==expected,'Production changed: '+name
 baseline=ops.tree(live)
print(json.dumps({{'status':'REMOTE_PREFLIGHT_OK','release_id':release_id,'live_tree_sha256':baseline}}),flush=True)
archive_path=artifacts/(release_id+'.frontend-overlay.zip')
atomic_path=artifacts/(release_id+'.atomic.py')
for path,raw in ((archive_path,archive_raw),(atomic_path,atomic_raw)):
 if path.exists():assert ops.sha(path)==hashlib.sha256(raw).hexdigest(),'Existing staging mismatch'
 else:
  with path.open('xb') as handle:handle.write(raw)
prepare_receipt=artifacts/(release_id+'.prepare.json')
if not prepare_receipt.exists():
 subprocess.run(['python3',str(atomic_path),'prepare','--release-id',release_id,'--archive',str(archive_path),'--archive-sha256',{receipt['archive_sha256']!r},'--expected-live-tree',baseline],check=True)
else:assert json.loads(prepare_receipt.read_text())['live_tree_sha256']==baseline
subprocess.run(['python3',str(atomic_path),'activate','--release-id',release_id],check=True)
result=json.loads(activation.read_text());assert result['status']=='ATOMIC_SWITCH_OK'
print(json.dumps(result,ensure_ascii=False),flush=True)
'''
    compile(bootstrap, "remote_bootstrap.py", "exec")
    (bundle / "remote_bootstrap.py").write_text(bootstrap, encoding="utf-8")
    return bootstrap.encode(), manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--predecessor", type=Path, required=True)
    parser.add_argument("--host", default="ubuntu@81.70.240.251")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    payload, manifest = prepare(bundle, args.predecessor.resolve())
    if not args.execute:
        print("DEPLOYMENT_PREPARED; existing SSH password authentication required")
        return
    print("LIFELINE release " + manifest["release_id"], flush=True)
    print("Enter the existing server password in the SSH prompt. It is not stored.", flush=True)
    started = time.time()
    result = subprocess.run(["ssh", "-E", str(bundle / "ssh-diagnostics.txt"), "-o", "LogLevel=VERBOSE",
                             "-o", "BatchMode=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
                             "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                             args.host, "python3 -"], input=payload, stdout=subprocess.PIPE)
    (bundle / "ssh-output.txt").write_bytes(result.stdout)
    output = result.stdout.decode("utf-8", errors="replace")
    print(output, flush=True)
    rows = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
    for row in rows:
        if row.get("status") == "ATOMIC_SWITCH_OK":
            (bundle / "activation.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    (bundle / "ssh-exit.json").write_text(json.dumps({"exit_code": result.returncode, "started_epoch": started,
        "finished_epoch": time.time(), "authentication": "existing interactive SSH; no keys created or passwords stored"}, indent=2), encoding="utf-8")
    if result.returncode == 0:
        from verify_frontend_release import verify
        verified = verify(bundle)
        print(f"PUBLIC_VERIFIED: {len(verified['files'])} runtime files; game and collector healthy.", flush=True)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
