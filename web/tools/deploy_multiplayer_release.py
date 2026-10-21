"""Hash-bound Linux deployment for the inspected 2026-10-21 multiplayer release.

Run prepare before activate. Activation must run under systemd-run, independently
of SSH. Database backups are private and are never automatically restored over
new writes. The old frontend, overwritten files and service settings are retained.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.request
import zipfile

ROOT = Path('/home/ubuntu/line-game')
RELEASE = ROOT / '.deploy-artifacts/web-multiplayer-ai-20261021'
STAGE = RELEASE / 'candidate'
BACK = ROOT / 'web/web后端'
PYTHON = BACK / '.venv/bin/python'
NODE = ROOT / '.deploy-artifacts/web-training-data-v1-20261013-node/node'
GAME_UNIT = 'lifeline-game.service'
COLLECTOR_UNIT = 'lifeline-training-contributions.service'
DROPIN = Path('/etc/systemd/system/lifeline-training-contributions.service.d/60-multiplayer-live.conf')
GAME_UNIT_PATH = Path('/etc/systemd/system') / GAME_UNIT
DATABASES = [Path('/tmp/line-game/game.db'), Path('/home/ubuntu/line-game-data/training-contributions-v1/contributions.sqlite3')]
COLORS = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, value):
    path = RELEASE / name
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def run(args, **kwargs):
    result = subprocess.run([str(a) for a in args], stdin=kwargs.pop('stdin', subprocess.DEVNULL),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kwargs.pop('timeout', 40), **kwargs)
    if result.returncode:
        raise RuntimeError('Command failed: ' + str(args[0]) + '; exit=' + str(result.returncode))
    return result.stdout


def exchange(left, right):
    result = ctypes.CDLL(None, use_errno=True).renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2)
    if result:
        raise OSError(ctypes.get_errno(), 'Atomic directory exchange failed')


def tree(path):
    records = {}
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise RuntimeError('Unexpected symlink in release tree')
        if file.is_file() and '__pycache__' not in file.parts:
            records[file.relative_to(path).as_posix()] = sha(file)
    return records


def manifest():
    return json.loads((RELEASE / 'release-manifest.json').read_text())


def verify_files(base):
    m = manifest()
    for group in ('frontend_files', 'backend_files', 'tool_files'):
        for name, info in m[group].items():
            path = base / name
            if path.is_symlink() or sha(path) != info['sha256'] or path.stat().st_size != info['bytes']:
                raise RuntimeError('Runtime hash mismatch: ' + name)


def read_json(url):
    with urllib.request.urlopen(url, timeout=4) as response:
        return json.load(response)


def health(port):
    result = read_json(f'http://127.0.0.1:{port}/api/health')
    if result.get('status') != 'ok' or not result.get('sensitiveFilterReady', False):
        raise RuntimeError('Game health not ready')
    return {'status': result['status'], 'filter_ready': True}


def wait_health(port):
    deadline = time.monotonic() + 30
    while True:
        try:
            return health(port)
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.5)


def wait_collector(port):
    deadline = time.monotonic() + 30
    while True:
        try:
            value = read_json(f'http://127.0.0.1:{port}/api/training/contributions/status')
            assert value.get('enabled') is True and value.get('consent_policy') == 'anonymous-replay-training-v1'
            return value
        except Exception:
            if time.monotonic() >= deadline: raise
            time.sleep(.5)


def process_running(pid):
    try:
        return (Path('/proc') / str(pid) / 'stat').read_text().split(') ', 1)[1][0] != 'Z'
    except FileNotFoundError:
        return False


def check_database(path):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=10) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity failure')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                  for table in ('users', 'inbox') if table in tables}
    return {'path': str(path), 'integrity': 'ok', 'counts': counts}


def bridge_checks(base):
    results = []
    for count in (3, 4, 5, 6):
        settings = {'playerCount': count, 'gridSize': 5, 'rulesVersion': 'territory-v2', 'startPlayer': 'WHITE'}
        data = json.dumps({'settings': settings, 'actions': [], 'botColors': COLORS[1:count]}).encode()
        raw = subprocess.run([str(NODE), str(base / 'web/tools/online_bot_bridge.mjs')], input=data,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
        if raw.returncode:
            raise RuntimeError('Node bridge failed')
        result = json.loads(raw.stdout)
        if not result.get('success') or result.get('fallback') or not result.get('action'):
            raise RuntimeError('AI model fallback or missing action')
        results.append({'players': count, 'success': True, 'fallback': False})
    validator = base / 'web/tools/validate_contribution.mjs'
    code = 'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(await m.engineSources()));'
    sources = json.loads(run([NODE, '--input-type=module', '-e', code, validator]))
    if sources['GameEngine.js'] != manifest()['frontend_files']['web/web前端/GameEngine.js']['sha256']:
        raise RuntimeError('Contribution validator source identity differs')
    return {'models': results, 'contribution_validator_sources': sources}


def prepare():
    if STAGE.exists() or (RELEASE / 'prepared.json').exists():
        raise RuntimeError('Candidate already prepared')
    m = manifest()
    archive = RELEASE / 'multiplayer-overlay.zip'
    if not archive.exists():
        with archive.open('xb') as output:
            for path in sorted((RELEASE / 'upload').iterdir()):
                output.write(path.read_bytes())
    if sha(archive) != m['archive']['sha256'] or archive.stat().st_size != m['archive']['bytes']:
        raise RuntimeError('Uploaded archive mismatch')
    files = {**m['frontend_files'], **m['backend_files'], **m['tool_files']}
    STAGE.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as bundle:
        if set(bundle.namelist()) != set(files):
            raise RuntimeError('Archive allowlist mismatch')
        for name in files:
            path = STAGE / name
            if Path(name).is_absolute() or '..' in Path(name).parts or not path.resolve().is_relative_to(STAGE):
                raise RuntimeError('Archive path escape')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bundle.read(name))
    verify_files(STAGE)
    shutil.copy2(RELEASE / 'release-manifest.json', STAGE / 'web/web前端/release-manifest.json')
    support = {}
    for name in ('database.py', 'models.py', 'sensitive_filter.py', 'sensitive_words.txt'):
        shutil.copy2(BACK / name, STAGE / 'web/web后端' / name)
        support[name] = sha(BACK / name)
    # Exercise the exact filesystem primitive before touching live files.
    left, right = RELEASE / 'exchange-test-a', RELEASE / 'exchange-test-b'
    left.mkdir(); right.mkdir(); (left / 'a').touch(); (right / 'b').touch()
    exchange(left, right)
    assert (left / 'b').exists() and (right / 'a').exists()
    exchange(left, right)
    assert (left / 'a').exists() and (right / 'b').exists()
    rollback = RELEASE / 'rollback'; rollback.mkdir(mode=0o700)
    prior = {}
    for name in (*m['backend_files'], *m['tool_files']):
        path = ROOT / name
        prior[name] = sha(path) if path.exists() else None
        if path.exists():
            dest = rollback / name; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, dest)
    if GAME_UNIT_PATH.exists() or DROPIN.exists():
        raise RuntimeError('Unexpected service configuration already exists')
    collector_settings = run(['systemctl', 'show', COLLECTOR_UNIT, '-p', 'User', '-p', 'ExecStart', '-p', 'MainPID', '-p', 'ReadWritePaths', '-p', 'ReadOnlyPaths', '-p', 'InaccessiblePaths']).decode()
    assert 'User=ubuntu' in collector_settings and '-m uvicorn contribution_asgi:app' in collector_settings
    for line in collector_settings.splitlines():
        if line.startswith('ReadWritePaths='):
            assert line.split('=', 1)[1] == str(DATABASES[1].parent), 'Collector writable data path changed'
        if line.startswith(('ReadOnlyPaths=', 'InaccessiblePaths=')):
            assert not line.split('=', 1)[1], 'Collector has unreviewed filesystem restrictions'
    collector_pid = int(next(line.split('=', 1)[1] for line in collector_settings.splitlines() if line.startswith('MainPID=')))
    collector_env = dict(part.split('=', 1) for part in (Path('/proc') / str(collector_pid) / 'environ').read_bytes().decode().split('\0') if '=' in part)
    assert collector_env.get('LIFELINE_NODE') == str(NODE)
    assert collector_env.get('LIFELINE_CONTRIBUTIONS_DIR') == str(DATABASES[1].parent)
    assert not collector_env.get('PYTHONPATH')
    old_pid = 933703
    assert (Path('/proc') / str(old_pid) / 'cwd').resolve() == BACK
    cmdline = (Path('/proc') / str(old_pid) / 'cmdline').read_bytes()
    assert b'server:app' in cmdline
    environment = dict(part.split('=', 1) for part in (Path('/proc') / str(old_pid) / 'environ').read_bytes().decode().split('\0') if '=' in part)
    if environment.get('JWT_SECRET_KEY') or environment.get('LINE_GAME_DB_PATH'):
        raise RuntimeError('Live environment changed since inspected preflight')
    checks = bridge_checks(STAGE)
    isolated = RELEASE / 'candidate-data'; isolated.mkdir(mode=0o700)
    env = {**os.environ, 'LINE_GAME_DB_PATH': str(isolated / 'accounts.db'),
           'LIFELINE_CONTRIBUTIONS_DIR': str(isolated / 'contributions'), 'LIFELINE_NODE': str(NODE),
           'JWT_SECRET_KEY': 'isolated-candidate-only-not-production', 'PYTHONDONTWRITEBYTECODE': '1'}
    with (RELEASE / 'candidate.log').open('wb') as log:
        proc = subprocess.Popen([str(PYTHON), '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '18041', '--no-access-log'],
                                cwd=STAGE / 'web/web后端', env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        try:
            checks['candidate_health'] = wait_health(18041)
            checks['candidate_contributions'] = read_json('http://127.0.0.1:18041/api/training/contributions/status')
            with urllib.request.urlopen('http://127.0.0.1:18041/', timeout=5) as response:
                assert hashlib.sha256(response.read()).hexdigest() == m['frontend_files']['web/web前端/index.html']['sha256']
        finally:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    save('prepared.json', {'status': 'PREPARED_NOT_ACTIVE', 'release_id': m['release_id'], 'checks': checks,
                           'old_pid': old_pid, 'old_cmdline_sha256': hashlib.sha256(cmdline).hexdigest(),
                           'live_frontend': tree(ROOT / 'web/web前端'), 'candidate_frontend': tree(STAGE / 'web/web前端'),
                           'old_files': prior, 'support_files': support,
                           'collector_unit_sha256': sha(Path('/etc/systemd/system') / COLLECTOR_UNIT),
                           'databases': [check_database(p) for p in DATABASES]})
    print('PREPARED_NOT_ACTIVE')


def atomic_copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.multiplayer-new')
    shutil.copy2(source, temporary)
    temporary.replace(destination)


def install_services():
    unit = f'''[Unit]
Description=LIFELINE game server
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5
[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory={BACK}
Environment=LINE_GAME_DB_PATH={DATABASES[0]}
Environment=LIFELINE_NODE={NODE}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONPYCACHEPREFIX={RELEASE}/fresh-pycache
ExecStart={PYTHON} -m uvicorn server:app --host 0.0.0.0 --port 8000 --no-access-log
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=30
PrivateTmp=false
[Install]
WantedBy=multi-user.target
'''
    (RELEASE / GAME_UNIT).write_text(unit)
    (RELEASE / 'collector-override.conf').write_text(f'[Service]\nWorkingDirectory={BACK}\nEnvironment=PYTHONDONTWRITEBYTECODE=1\nEnvironment=PYTHONPYCACHEPREFIX={RELEASE}/fresh-pycache\n')
    run(['sudo', '-n', 'install', '-m', '644', RELEASE / GAME_UNIT, GAME_UNIT_PATH])
    run(['sudo', '-n', 'mkdir', '-p', DROPIN.parent])
    run(['sudo', '-n', 'install', '-m', '644', RELEASE / 'collector-override.conf', DROPIN])
    run(['sudo', '-n', 'systemctl', 'daemon-reload'])


def activate():
    prepared = json.loads((RELEASE / 'prepared.json').read_text())
    if (RELEASE / 'activation.json').exists():
        raise RuntimeError('Activation has already been attempted; inspect journal')
    verify_files(STAGE)
    assert tree(ROOT / 'web/web前端') == prepared['live_frontend']
    assert tree(STAGE / 'web/web前端') == prepared['candidate_frontend']
    for name, digest in prepared['old_files'].items():
        assert (sha(ROOT / name) if (ROOT / name).exists() else None) == digest
    for name, digest in prepared['support_files'].items():
        assert sha(BACK / name) == digest
    assert sha(Path('/etc/systemd/system') / COLLECTOR_UNIT) == prepared['collector_unit_sha256']
    assert not GAME_UNIT_PATH.exists() and not DROPIN.exists()
    old_pid = prepared['old_pid']; procpath = Path('/proc') / str(old_pid)
    assert hashlib.sha256((procpath / 'cmdline').read_bytes()).hexdigest() == prepared['old_cmdline_sha256']
    state = {'status': 'ACTIVATING', 'started_at': time.time(), 'frontend_swapped': False, 'files_replaced': [], 'old_stopped': False, 'stop_requested': False, 'collector_stopped': False, 'services_installed': False}
    def journal(): save('activation.json', state)
    journal()
    try:
        run(['sudo', '-n', 'systemctl', 'stop', COLLECTOR_UNIT]); state['collector_stopped'] = True; journal()
        state['stop_requested'] = True; journal(); os.kill(old_pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while process_running(old_pid):
            if time.monotonic() > deadline: raise RuntimeError('Old process did not exit; refusing to force kill')
            time.sleep(.2)
        state['old_stopped'] = True; journal()
        with socket.socket() as sock:
            assert sock.connect_ex(('127.0.0.1', 8000)) != 0
        backups = RELEASE / 'database-backups'; backups.mkdir(mode=0o700)
        state['database_backups'] = []
        for source in DATABASES:
            target = backups / source.name
            with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as db, sqlite3.connect(target) as out:
                db.backup(out)
            target.chmod(0o600)
            state['database_backups'].append({**check_database(target), 'sha256': sha(target)})
        journal()
        exchange(ROOT / 'web/web前端', STAGE / 'web/web前端'); state['frontend_swapped'] = True; journal()
        for name in prepared['old_files']:
            atomic_copy(STAGE / name, ROOT / name); state['files_replaced'].append(name); journal()
        state['services_installed'] = True; journal(); install_services()
        run(['sudo', '-n', 'systemctl', 'enable', '--now', GAME_UNIT])
        run(['sudo', '-n', 'systemctl', 'start', COLLECTOR_UNIT])
        state['health'] = wait_health(8000)
        status = wait_collector(8005)
        state['collector'] = status
        verify_files(ROOT)
        state['runtime_checks'] = bridge_checks(ROOT)
        state['databases'] = [check_database(path) for path in DATABASES]
        for old, new in zip(prepared['databases'], state['databases']):
            for table, count in old['counts'].items(): assert new['counts'][table] >= count
        pid = int(run(['systemctl', 'show', GAME_UNIT, '-p', 'MainPID', '--value']).strip())
        fds = [str(path.resolve()) for path in (Path('/proc') / str(pid) / 'fd').iterdir()]
        assert str(DATABASES[0]) in fds
        state.update(status='ACTIVATED_VERIFIED', finished_at=time.time(), main_pid=pid,
                     rollback_frontend=str(STAGE / 'web/web前端'), database_restore_performed=False)
        journal(); print('ACTIVATED_VERIFIED')
    except BaseException as error:
        state['failure_type'] = type(error).__name__; state['status'] = 'ROLLING_BACK'
        try: journal()
        except Exception: pass
        try:
            rollback(state, prepared)
            state['status'] = 'ROLLED_BACK_AFTER_FAILURE'
        except BaseException as rollback_error:
            state['status'] = 'ROLLBACK_NEEDS_ATTENTION'; state['rollback_error_type'] = type(rollback_error).__name__
        try: journal()
        except Exception: pass
        raise


def rollback(state, prepared):
    errors = []
    def attempt(action):
        try: return action()
        except Exception as error: errors.append(type(error).__name__)
    if state['services_installed']:
        attempt(lambda: run(['sudo', '-n', 'systemctl', 'stop', COLLECTOR_UNIT]))
        if GAME_UNIT_PATH.exists():
            attempt(lambda: run(['sudo', '-n', 'systemctl', 'daemon-reload']))
            attempt(lambda: run(['sudo', '-n', 'systemctl', 'stop', GAME_UNIT]))
            attempt(lambda: run(['sudo', '-n', 'systemctl', 'disable', GAME_UNIT]))
        for path in (GAME_UNIT_PATH, DROPIN):
            if path.exists(): attempt(lambda path=path: run(['sudo', '-n', 'rm', '--', path]))
        attempt(lambda: run(['sudo', '-n', 'systemctl', 'daemon-reload']))
    for name in reversed(state['files_replaced']):
        if prepared['old_files'][name] is None:
            attempt(lambda name=name: (ROOT / name).unlink())
        else:
            attempt(lambda name=name: atomic_copy(RELEASE / 'rollback' / name, ROOT / name))
    if state['frontend_swapped']:
        attempt(lambda: exchange(ROOT / 'web/web前端', STAGE / 'web/web前端'))
    if state['old_stopped'] or (state.get('stop_requested') and not process_running(prepared['old_pid'])):
        attempt(lambda: run(['sudo', '-n', 'systemd-run', '--unit=lifeline-game-rollback', '--uid=ubuntu', '--gid=ubuntu',
             '--property=WorkingDirectory=' + str(BACK), '--property=Restart=on-failure',
             '--setenv=LINE_GAME_DB_PATH=' + str(DATABASES[0]), str(PYTHON), '-m', 'uvicorn', 'server:app', '--host', '0.0.0.0', '--port', '8000']))
    attempt(lambda: wait_health(8000))
    if state['collector_stopped']:
        attempt(lambda: run(['sudo', '-n', 'systemctl', 'start', COLLECTOR_UNIT]))
        attempt(lambda: wait_collector(8005))
    if errors:
        raise RuntimeError('Rollback steps require inspection: ' + ','.join(errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'activate'])
    args = parser.parse_args()
    with (RELEASE / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (prepare if args.command == 'prepare' else activate)()
