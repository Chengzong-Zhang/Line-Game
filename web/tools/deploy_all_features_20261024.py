"""Coordinate the frozen Web and two API releases on the existing server.

This is a one-shot supervised worker. Each API owns its own rollback; the
frontend is switched last and restored if its post-switch checks fail. No
environment, account rows, passwords, or database snapshots are serialized.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/home/ubuntu/line-game')
ARTIFACTS = ROOT / '.deploy-artifacts'
DEFAULT_RELEASE = 'web-all-features-20261024-r1'
RELEASE = DEFAULT_RELEASE
HERE = ARTIFACTS / RELEASE
LIVE = ROOT / 'web/web前端'
NODE = ARTIFACTS / 'wechat-service-20261021/runtime/node'


def release_identity(value):
    if len(value) > 100 or not re.fullmatch(r'web-all-features-[0-9]{8}-r[1-9][0-9]*', value):
        raise argparse.ArgumentTypeError('Invalid one-shot release ID')
    return value


def configure_release(argv=None):
    global RELEASE, HERE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-id', type=release_identity, default=DEFAULT_RELEASE)
    args = parser.parse_args(argv)
    RELEASE = args.release_id
    HERE = ARTIFACTS / args.release_id
    return args.release_id


def safe_error_code(error):
    text = str(error).upper()
    for needle, code in (('SOURCE', 'SOURCE_BINDING_MISMATCH'), ('PREDECESSOR', 'PREDECESSOR_MISMATCH'),
                         ('ENVIRONMENT', 'ENVIRONMENT_GUARD_FAILED'), ('DATABASE', 'DATABASE_GUARD_FAILED'),
                         ('HEALTH', 'HEALTH_CHECK_FAILED'), ('FROZEN', 'FROZEN_PAYLOAD_MISMATCH')):
        if needle in text:
            return code
    return 'OPERATION_FAILED'


def safe_command_report(stdout):
    """Expose only fixed machine codes; raw output stays in the local root log."""
    text = stdout[-32768:].decode('utf-8', errors='replace')
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict):
            return {key: value[key] for key in ('code', 'errorCode', 'status', 'phase', 'errorType')
                    if isinstance(value.get(key), str)
                    and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,95}', value[key])}
    return {}


class CommandFailure(RuntimeError):
    def __init__(self, args, code, exit_code, log, stdout=b''):
        self.details = {'code': code, 'tool': Path(str(args[1])).name,
                        'exitCode': exit_code, 'log': log.name, 'reported': safe_command_report(stdout)}
        super().__init__(code)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save(state):
    pending = HERE / 'deployment.pending'
    with pending.open('w', encoding='utf-8') as stream:
        os.fchown(stream.fileno(), 0, 1000)
        os.fchmod(stream.fileno(), 0o640)
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    pending.replace(HERE / 'deployment.json')


def run(args, timeout=180):
    process = subprocess.Popen(list(map(str, args)), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException as error:
        # Let an in-flight activation handle TERM and restore its own code.
        # subprocess.run(timeout=...) would kill it without that recovery.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = process.communicate(timeout=150)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        log = HERE / ('interrupted-command-' + str(time.time_ns()) + '.txt')
        log.write_bytes(stdout + stderr)
        code = 'COMMAND_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'COMMAND_INTERRUPTED'
        raise CommandFailure(args, code, process.returncode, log, stdout) from None
    if process.returncode:
        # Tools return fixed failure codes; keep raw process output local.
        log = HERE / ('failed-command-' + str(time.time_ns()) + '.txt')
        log.write_bytes(stdout + stderr)
        raise CommandFailure(args, 'COMMAND_FAILED', process.returncode, log, stdout)
    return stdout


def health():
    result = {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for name, url in (
        ('game', 'http://127.0.0.1:8000/api/health'),
        ('wechat', 'http://127.0.0.1:8006/api/wechat/status'),
        ('collector', 'http://127.0.0.1:8005/api/training/contributions/status'),
    ):
        with opener.open(url, timeout=8) as response:
            value = json.load(response)
        assert value.get('status') == 'ok' if name == 'game' else value.get('enabled') is True
        result[name] = value
    return result


def recover_frontend(ops):
    """Account for interruption between exchange, rename and receipt creation."""
    preparation = ARTIFACTS / (RELEASE + '.prepare.json')
    activation = ARTIFACTS / (RELEASE + '.activation.json')
    if not preparation.exists():
        return False
    with (ARTIFACTS / 'frontend-release.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if activation.exists():
            return True
        receipt = read(preparation)
        current = ops.tree(LIVE)
        if current == receipt['live_tree_sha256']:
            return False
        assert current == receipt['candidate_tree_sha256'], 'Unowned live frontend change'
        candidate = ARTIFACTS / (RELEASE + '.candidate')
        rollback = ARTIFACTS / (RELEASE + '.rollback-web前端')
        if candidate.exists() and not rollback.exists():
            assert ops.tree(candidate) == receipt['live_tree_sha256']
            candidate.rename(rollback)
        assert rollback.exists() and not candidate.exists()
        assert ops.tree(rollback) == receipt['live_tree_sha256']
        ops.write_new(activation, {**receipt, 'status': 'RECOVERED_INCOMPLETE_SWITCH',
            'rollback': str(rollback), 'active_tree_sha256': current,
            'rollback_tree_sha256': receipt['live_tree_sha256']})
    return True


def service_run_directory(phase):
    if phase not in ('preflight', 'activation'):
        raise ValueError('UNREVIEWED_SERVICE_PHASE')
    # ReleaseAdapter requires direct siblings of the current service container.
    # An attempt-local nested directory is deliberately rejected by that gate.
    return ARTIFACTS / (RELEASE + '-wechat-' + phase)


def main(argv=None):
    global RELEASE
    RELEASE = configure_release(argv)
    assert sys.platform == 'linux' and os.geteuid() == 0
    assert HERE.resolve(strict=True) == HERE
    assert Path(__file__).resolve().parent == HERE, 'Worker directory does not match release ID'
    worker = (HERE / 'worker.lock').open('a')
    fcntl.flock(worker, fcntl.LOCK_EX | fcntl.LOCK_NB)
    global_lock = (ARTIFACTS / 'wechat-service-release.lock').open('a')
    fcntl.flock(global_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert not (HERE / 'deployment.json').exists(), 'Inspect existing attempt; do not replay'
    state = {'release_id': RELEASE, 'status': 'RUNNING', 'phase': 'PREFLIGHT',
             'startedAtUtc': datetime.now(timezone.utc).isoformat(),
             'frontend': {'status': 'NOT_CHANGED'}, 'legacy': {'status': 'NOT_CHANGED'},
             'wechat': {'status': 'NOT_CHANGED'}, 'databaseRestored': False}
    save(state)
    ops = None
    try:
        spec = importlib.util.spec_from_file_location('atomic', HERE / 'atomic_frontend_release.py')
        ops = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ops)
        plan = read(HERE / 'plan.json')
        assert plan['release_id'] == RELEASE
        for name, digest in plan['files'].items():
            assert sha(HERE / name) == digest, 'Frozen upload drift: ' + name
        manifest = read(HERE / 'frontend/release-manifest.json')
        assert manifest['release_id'] == RELEASE
        assert sha(LIVE / 'release-manifest.json') == manifest['predecessor_manifest_sha256']
        for name, digest in manifest['predecessor_files'].items():
            assert sha(LIVE / name) == digest, 'Production predecessor drift: ' + name
        state['healthBefore'] = health()
        before = ops.tree(LIVE)
        atomic = ['python3', HERE / 'atomic_frontend_release.py']
        run([*atomic, 'prepare', '--release-id', RELEASE,
             '--archive', HERE / 'frontend/frontend-overlay.zip',
             '--archive-sha256', plan['files']['frontend/frontend-overlay.zip'],
             '--expected-live-tree', before])
        frontend = ARTIFACTS / (RELEASE + '.candidate')
        # ZIP-created new modules inherit the supervisor's restrictive umask.
        # Public static assets must be readable by the existing HTTP workers.
        for directory, _, files in os.walk(frontend):
            os.chown(directory, 0, 1000)
            os.chmod(directory, 0o755)
            for name in files:
                path = Path(directory) / name
                assert not path.is_symlink()
                os.chown(path, 0, 1000)
                os.chmod(path, 0o644)
        for name, digest in manifest['runtime_files'].items():
            assert sha(frontend / name) == digest, 'Prepared runtime mismatch: ' + name
        service_base = ['python3', HERE / 'activate_service_release.py']
        service_args = ['--manifest', HERE / 'service/release-manifest.json',
                        '--expected-sha256', plan['files']['service/release-manifest.json'],
                        '--bundle', HERE / 'service/package']
        legacy_base = ['python3', HERE / 'activate_legacy_release.py',
                       '--manifest', HERE / 'legacy/manifest.json',
                       '--manifest-sha256', plan['files']['legacy/manifest.json'],
                       '--payload', HERE / 'legacy', '--frontend', frontend, '--node', NODE]
        state['wechat']['preflight'] = json.loads(run([*service_base, 'preflight', *service_args,
            '--run-dir', service_run_directory('preflight')], timeout=300))
        state['legacy']['preflight'] = json.loads(run([*legacy_base,
            '--run-dir', HERE / 'legacy-preflight', '--check-only']))
        save(state)
        state['phase'] = 'WECHAT_SERVICE_ACTIVATION'
        save(state)
        state['wechat'].update(json.loads(run([*service_base, 'activate', *service_args,
            '--run-dir', service_run_directory('activation'), '--execute'], timeout=360)))
        assert state['wechat']['status'] == 'ACTIVATED_SERVICE_RELEASE'
        state['phase'] = 'LEGACY_SERVICE_ACTIVATION'
        save(state)
        state['legacy'].update(json.loads(run([*legacy_base, '--run-dir', HERE / 'legacy-activation'], timeout=240)))
        assert state['legacy']['status'] == 'ACTIVATED_LEGACY_V3_SETTINGS_UNDO'
        state['phase'] = 'FRONTEND_ACTIVATION'
        save(state)
        run([*atomic, 'activate', '--release-id', RELEASE])
        for name, digest in manifest['runtime_files'].items():
            assert sha(LIVE / name) == digest, 'Live runtime mismatch: ' + name
        state['healthAfter'] = health()
        assert state['healthAfter']['wechat']['rulesVersion'] == 'territory-v3'
        state['territoryFixture'] = json.loads(run([NODE, HERE / 'verify-live-scoring.mjs',
                                                    '--engine', LIVE / 'GameEngine.js']))
        assert state['territoryFixture']['status'] == 'PASS_ACTUAL_V3_ENGINE'
        assert state['healthAfter']['collector'] == state['healthBefore']['collector']
        state['frontend'] = {'status': 'ACTIVATED_HASHES_V3_FIXTURE_VERIFIED',
                             'runtimeFilesMatched': len(manifest['runtime_files']),
                             'activeTreeSha256': ops.tree(LIVE)}
        state['status'] = 'ACTIVATED_ALL_COMPONENTS_VERIFIED'
    except BaseException as error:
        state['failure'] = error.details if isinstance(error, CommandFailure) else {
            'code': safe_error_code(error), 'errorType': type(error).__name__}
        state['error'] = type(error).__name__ + ': ' + state['failure']['code']
        state['status'] = 'INCOMPLETE_INSPECT_COMPONENT_RECEIPTS'
        try:
            if ops is not None and recover_frontend(ops):
                run(['python3', HERE / 'atomic_frontend_release.py', 'rollback', '--release-id', RELEASE])
                state['frontend']['status'] = 'ROLLED_BACK_SAME_DATABASES'
        except BaseException as recovery:
            state['frontend']['recoveryError'] = type(recovery).__name__ + ': ' + safe_error_code(recovery)
            state['status'] = 'RECOVERY_NEEDS_ATTENTION'
        # Successful backwards-compatible APIs remain active. Each failed API
        # transaction restores its own old code; accepted account writes stay.
        try:
            state['healthAtStop'] = health()
        except (OSError, ValueError, AssertionError):
            state['healthAtStop'] = 'HEALTH_UNCONFIRMED'
    state['phase'] = 'FINISHED'
    state['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
    save(state)
    print(json.dumps(state, ensure_ascii=False), flush=True)
    return 0 if state['status'] == 'ACTIVATED_ALL_COMPONENTS_VERIFIED' else 2


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt()
    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    raise SystemExit(main())
