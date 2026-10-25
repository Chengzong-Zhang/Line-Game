"""Apply the hash-bound name-only Web overlay without restarting services."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import urllib.request


ROOT = Path('/home/ubuntu/line-game')
ART = ROOT / '.deploy-artifacts'
LIVE = ROOT / 'web/web前端'
RELEASE = 'web-name-20261025-r1'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def command(args):
    result = subprocess.run(list(map(str, args)), capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('LOCAL_DEPLOY_COMMAND_FAILED')
    return result.stdout


def service_pids():
    return {name: command(['systemctl', 'show', name, '--property=MainPID', '--value']).decode().strip()
            for name in ['lifeline-game.service', 'lifeline-wechat.service']}


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    result = {}
    for name, port, suffix in [('game', 8000, 'health'), ('wechat', 8006, 'wechat/status'),
                               ('collector', 8005, 'training/contributions/status')]:
        with opener.open(f'http://127.0.0.1:{port}/api/{suffix}', timeout=8) as response:
            value = json.load(response)
        assert value.get('status') == 'ok' if name == 'game' else value.get('enabled') is True
        result[name] = {'ok': True}
        if name == 'wechat':
            assert value['rulesVersion'] == 'territory-v3'
            result[name]['rulesVersion'] = value['rulesVersion']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    assert sha(args.plan) == args.plan_sha256
    plan = read(args.plan)
    here = ART / RELEASE
    assert args.plan.resolve().parent == here.resolve()
    assert plan['release_id'] == RELEASE
    assert read(ART / 'web-all-features-20261025-r4/deployment.json')['status'] == 'ACTIVATED_ALL_COMPONENTS_VERIFIED'
    assert sha(LIVE / 'release-manifest.json') == plan['predecessor_manifest_sha256']
    atomic = ART / 'web-all-features-20261025-r4/atomic_frontend_release.py'
    assert sha(atomic) == plan['atomic_sha256']
    assert sha(here / 'frontend-overlay.zip') == plan['archive_sha256']
    spec = importlib.util.spec_from_file_location('name_atomic', atomic)
    ops = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ops)
    manifest = read(here / 'release-manifest.json')
    for name, expected in manifest['predecessor_files'].items():
        assert sha(LIVE / name) == expected, 'PRODUCTION_PREDECESSOR_DRIFT'
    state = {'release_id': RELEASE, 'status': 'PREFLIGHT_PASSED_NOT_ACTIVE',
             'startedAtUtc': datetime.now(timezone.utc).isoformat(), 'changedRuntimeFiles': list(manifest['files']),
             'healthBefore': health(), 'servicePidsBefore': service_pids(), 'databasesModified': False}
    if not args.execute:
        print(json.dumps(state))
        return
    with (ART / 'wechat-service-release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert not (here / 'receipt.json').exists(), 'INSPECT_EXISTING_ATTEMPT_DO_NOT_REPLAY'
        before = ops.tree(LIVE)
        activated = False
        try:
            command(['python3', atomic, 'prepare', '--release-id', RELEASE, '--archive', here / 'frontend-overlay.zip',
                     '--archive-sha256', plan['archive_sha256'], '--expected-live-tree', before])
            candidate = ART / (RELEASE + '.candidate')
            for name, expected in manifest['runtime_files'].items():
                assert sha(candidate / name) == expected
            assert health() == state['healthBefore']
            command(['python3', atomic, 'activate', '--release-id', RELEASE])
            activated = True
            for name, expected in manifest['runtime_files'].items():
                assert sha(LIVE / name) == expected
            state['healthAfter'] = health()
            state['servicePidsAfter'] = service_pids()
            assert state['servicePidsAfter'] == state['servicePidsBefore']
            state.update(status='ACTIVATED_NAME_OVERLAY_121_RUNTIME_HASHES_VERIFIED', runtimeFilesMatched=len(manifest['runtime_files']),
                         activeTreeSha256=ops.tree(LIVE), rollback=str(ART / (RELEASE + '.rollback-web前端')))
        except BaseException as error:
            state.update(status='FAILED_BEFORE_SWITCH', errorType=type(error).__name__)
            if activated:
                command(['python3', atomic, 'rollback', '--release-id', RELEASE])
                state['status'] = 'FAILED_POSTCHECK_ROLLED_BACK'
            raise
        finally:
            state['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
            ops.write_new(here / 'receipt.json', state)
    print(json.dumps(state))


if __name__ == '__main__':
    main()
