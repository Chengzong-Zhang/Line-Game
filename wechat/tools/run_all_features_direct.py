"""Use native SSH for a pinned one-shot release; never capture a password."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

RELEASE = 'web-all-features-20261024-r1'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preparation', required=True, type=Path)
    parser.add_argument('--preparation-sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--wait-for-ready', action='store_true')
    args = parser.parse_args()
    raw = args.preparation.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == args.preparation_sha256, 'Preparation changed'
    prepared = json.loads(raw)
    assert prepared['release_id'] == RELEASE and prepared['status'] == 'FROZEN_NOT_DEPLOYED'
    bootstrap = args.preparation.parent / 'remote-bootstrap.py'
    assert hashlib.sha256(bootstrap.read_bytes()).hexdigest() == prepared['bootstrapSha256']
    if args.check_only:
        print(json.dumps({'status': 'PASS_FROZEN_TRANSPORT', 'release_id': RELEASE}))
        return 0
    args.output.mkdir(parents=True, exist_ok=False)
    state_path = args.output / 'transport.json'
    state = {'release_id': RELEASE, 'status': 'WAITING_FOR_NATIVE_SSH_AUTHENTICATION',
             'startedAtUtc': datetime.now(timezone.utc).isoformat(),
             'credentialsCaptured': False, 'automaticRetry': False}

    def save():
        pending = state_path.with_suffix('.pending')
        pending.write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')
        pending.replace(state_path)

    print('LIFELINE - deploy latest rules and all prepared features', flush=True)
    print('Enter the Tencent Cloud WEBSITE SERVER password at password: then press Enter.', flush=True)
    print('Characters stay hidden. After login, deployment continues automatically.', flush=True)
    if args.wait_for_ready:
        state['status'] = 'WAITING_FOR_USER_READY'
        save()
        input('Press Enter when ready to connect, then type the password at password: ')
        state['status'] = 'WAITING_FOR_NATIVE_SSH_AUTHENTICATION'
    save()
    with bootstrap.open('rb') as source, (args.output / 'ssh-output.txt').open('xb') as log:
        process = subprocess.Popen([
            r'C:\Windows\System32\OpenSSH\ssh.exe', '-o', 'BatchMode=no',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            'ubuntu@81.70.240.251', 'python3 -'], stdin=source, stdout=subprocess.PIPE)
        state['sshPid'] = process.pid
        save()
        for line in process.stdout:
            log.write(line)
            log.flush()
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                print(line.decode('utf-8', errors='replace')[:400].rstrip(), flush=True)
                continue
            if value.get('stage') == 'AUTHENTICATED_PREFLIGHT':
                state['status'] = 'AUTHENTICATED_DEPLOYMENT_IN_PROGRESS'
                save()
                print('LOGIN SUCCESSFUL. Reviewed deployment continues automatically.', flush=True)
            elif value.get('release_id') == RELEASE:
                (args.output / 'deployment.json').write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
                state['deploymentStatus'] = value.get('status')
                save()
                print('Deployment result: ' + str(value.get('status')), flush=True)
        state['sshExitCode'] = process.wait()
    state['status'] = ('DEPLOYED_VERIFIED' if state.get('deploymentStatus') == 'ACTIVATED_ALL_COMPONENTS_VERIFIED'
                       else 'CONNECTION_FINISHED_INSPECT_DURABLE_RECEIPTS')
    state['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
    save()
    print(json.dumps({key: state.get(key) for key in ('status', 'deploymentStatus', 'sshExitCode')}), flush=True)
    return state['sshExitCode']


if __name__ == '__main__':
    raise SystemExit(main())
