"""Activate the reviewed legacy room API and Node bridge; never replace a DB."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import sys
import time
import urllib.request

helper = Path(__file__).with_name('activate_profile_service_live.py')
if not helper.exists():
    helper = Path(__file__).resolve().parents[2] / 'wechat/tools/activate_profile_service_live.py'
spec = importlib.util.spec_from_file_location('release_primitives', helper)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require = base.require
LIVE = Path('/home/ubuntu/line-game')
BACK = LIVE / 'web/web后端'
UNIT = 'lifeline-game.service'
TARGETS = ('web/web后端/server.py', 'web/tools/online_bot_bridge.mjs')


def require_healthy_response(value):
    require(value.get('status') == 'ok' and value.get('sensitiveFilterReady') is True,
            'LEGACY_HEALTH_FAILED')


def legacy_unit_properties():
    properties = base.unit_properties(UNIT)
    # systemctl may omit an empty list property even with --all. This unit uses
    # inline environment entries; absence means there is no EnvironmentFile.
    properties.setdefault('EnvironmentFiles', '')
    require(all(key in properties for key in (*base.STATIC_PROPERTIES, 'MainPID', 'ActiveState', 'SubState')),
            'LEGACY_UNIT_PROPERTIES_INCOMPLETE')
    return properties


def transact(adapter):
    adapter.acquire()
    stopped = changed = recovered = False
    try:
        adapter.prepare()
        adapter.preflight()
        adapter.before_stop()
        stopped = True
        adapter.stop()
        changed = True
        adapter.replace('candidate')
        adapter.start()
        adapter.verify('candidate')
        recovered = True
        return {'status': 'ACTIVATED_LEGACY_V3_SETTINGS_UNDO', 'databaseRestored': False,
                'changedFiles': list(TARGETS)}
    except BaseException:
        if not stopped:
            recovered = True
            raise
        try:
            adapter.stop()
            if changed:
                adapter.replace('baseline')
            adapter.start()
            adapter.verify('baseline')
            recovered = True
        except BaseException:
            raise base.GateError('LEGACY_RECOVERY_UNCONFIRMED_KEEP_LOCK') from None
        raise base.GateError('LEGACY_ACTIVATION_FAILED_ORIGINAL_CODE_RECOVERED') from None
    finally:
        if recovered:
            adapter.release()


class Adapter:
    def __init__(self, manifest, payload, run_dir, frontend, node):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'LINUX_ROOT_REQUIRED')
        self.doc = manifest
        self.payload = base.safe_path(payload)
        self.root = base.safe_path(LIVE)
        self.frontend = base.safe_path(frontend)
        self.run_dir = base.safe_path(run_dir, exists=False)
        require(not self.run_dir.exists() and self.run_dir.parent.parent == LIVE / '.deploy-artifacts', 'NEW_TASK_RUN_REQUIRED')
        self.node = str(base.safe_path(node))
        # A virtualenv's interpreter is normally a symlink. Preserve its path
        # so Python discovers the existing virtualenv rather than system site
        # packages; this executable is only run, never replaced.
        python = BACK / '.venv/bin/python'
        require(python.is_file() and os.access(python, os.X_OK), 'LEGACY_PYTHON_UNAVAILABLE')
        self.python = str(python)
        self.database = base.safe_path('/tmp/line-game/game.db')
        info = base.regular(self.database)
        self.database_id = (info.st_dev, info.st_ino)
        require(set(manifest['files']) == set(TARGETS), 'ONLY_REVIEWED_TARGETS_ALLOWED')
        self.before = {}
        self.modes = {}
        for name in TARGETS:
            path = base.safe_path(LIVE / name)
            self.modes[name] = base.regular(path)
            self.before[name] = path.read_bytes()
            require(base.sha(self.before[name]) == manifest['files'][name]['beforeSha256'], 'LEGACY_BASELINE_DRIFT')
            target = base.safe_path(self.payload / name)
            base.regular(target)
            require(base.sha(target.read_bytes()) == manifest['files'][name]['sha256'], 'LEGACY_CANDIDATE_DRIFT')
        self.original = self.capture()
        self.environment = base.relevant_environment(base.process_environment(self.original['pid']))
        self.props = legacy_unit_properties()
        require(self.props['WorkingDirectory'] == str(BACK) and self.props['User'] == 'ubuntu'
                and self.props['KillMode'] == 'control-group', 'UNREVIEWED_LEGACY_UNIT')
        self.unit_files = {name: base.sha(base.safe_path(name).read_bytes()) for name in
                           [self.props['FragmentPath'], *self.props['DropInPaths'].split()]}
        base.create_run_directory(self.run_dir, 1000)
        self.lock = LIVE / '.deploy-artifacts/.legacy-all-features-release.lock'

    def capture(self):
        props = legacy_unit_properties()
        require(props.get('ActiveState') == 'active' and props.get('SubState') == 'running', 'LEGACY_NOT_RUNNING')
        result = base.process_identity(int(props['MainPID']))
        require(result['uid'] == 1000 and result['cwd'] == str(BACK), 'LEGACY_PROCESS_CHANGED')
        return result

    def acquire(self):
        self.fd = os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self.lock_id = os.fstat(self.fd)
        os.write(self.fd, json.dumps({'pid': os.getpid(), 'run': str(self.run_dir)}).encode())
        os.fsync(self.fd)

    def guard(self):
        info = base.regular(self.lock)
        require((info.st_dev, info.st_ino) == (self.lock_id.st_dev, self.lock_id.st_ino), 'LEGACY_LOCK_REPLACED')
        require(self.database_id == tuple(getattr(self.database.stat(), key) for key in ('st_dev', 'st_ino')), 'LEGACY_DATABASE_IDENTITY_CHANGED')
        props = legacy_unit_properties()
        for key in base.STATIC_PROPERTIES:
            require(props[key] == self.props[key] or (key == 'ControlGroup' and not props[key]
                    and props['MainPID'] == '0'), 'LEGACY_UNIT_CHANGED')
        require(self.unit_files == {name: base.sha(base.safe_path(name).read_bytes()) for name in self.unit_files}, 'LEGACY_UNIT_FILE_CHANGED')

    def release(self):
        self.guard()
        os.close(self.fd)
        self.lock.unlink()
        base.fsync_directory(self.lock.parent)

    def prepare(self):
        self.guard()
        self.pending = {'baseline': {}, 'candidate': {}}
        for role in self.pending:
            for index, name in enumerate(TARGETS):
                path = self.run_dir / (role + '-' + str(index))
                content = self.before[name] if role == 'baseline' else (self.payload / name).read_bytes()
                with path.open('xb') as stream:
                    os.fchown(stream.fileno(), self.modes[name].st_uid, self.modes[name].st_gid)
                    os.fchmod(stream.fileno(), stat.S_IMODE(self.modes[name].st_mode))
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
                self.pending[role][name] = path
        self.stage = self.run_dir / 'probe-source/web'
        stage_back = self.stage / 'web后端'
        stage_back.mkdir(parents=True)
        for source in BACK.iterdir():
            if source.is_file() and (source.suffix == '.py' or source.name == 'sensitive_words.txt'):
                require(not source.is_symlink(), 'LEGACY_SOURCE_LINK')
                shutil.copyfile(source, stage_back / source.name)
        shutil.copyfile(self.payload / TARGETS[0], stage_back / 'server.py')
        (self.stage / 'tools').mkdir()
        shutil.copyfile(self.payload / TARGETS[1], self.stage / 'tools/online_bot_bridge.mjs')
        shutil.copytree(self.frontend, self.stage / 'web前端')
        pending_files = {path for paths in self.pending.values() for path in paths.values()}
        for directory, _, files in os.walk(self.run_dir):
            os.chown(directory, 0, 1000); os.chmod(directory, 0o750)
            for name in files:
                path = Path(directory) / name
                if path in pending_files:
                    continue
                os.chown(path, 0, 1000); os.chmod(path, 0o640)

    def preflight(self):
        probe = self.payload / self.doc['probe']['path']
        require(base.sha(probe.read_bytes()) == self.doc['probe']['sha256'], 'LEGACY_PROBE_DRIFT')
        env = {**base.SYSTEM_ENV, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8',
               'LINE_GAME_DB_PATH': str(self.run_dir / 'synthetic.sqlite3'),
               'JWT_SECRET_KEY': 'fixture-only-legacy-release-probe-key', 'LIFELINE_NODE': self.node}
        # The temporary DB is created by the synthetic user, outside all live DBs.
        temp = self.run_dir / 'synthetic-user'
        temp.mkdir(); os.chown(temp, 1000, 1000); os.chmod(temp, 0o700)
        env['LINE_GAME_DB_PATH'] = str(temp / 'accounts.sqlite3')
        raw = base.command([self.python, '-B', str(probe), '--root', str(self.stage.parent)],
                           timeout=90, user=(1000, 1000), env=env)
        require(json.loads(raw).get('status') == 'PASS_LEGACY_V3_SETTINGS_UNDO_PROBE', 'LEGACY_PROBE_FAILED')

    def before_stop(self):
        self.guard()
        require(self.capture() == self.original, 'LEGACY_MAIN_PROCESS_CHANGED')
        for name in TARGETS:
            require((LIVE / name).read_bytes() == self.before[name], 'LEGACY_SOURCE_CHANGED_BEFORE_STOP')

    def stop(self):
        self.guard()
        base.command(['systemctl', 'stop', UNIT], timeout=35)
        props = legacy_unit_properties()
        require(props['MainPID'] == '0' and props['ActiveState'] in ('inactive', 'failed'), 'LEGACY_NOT_STOPPED')

    def replace(self, role):
        self.guard()
        require(legacy_unit_properties()['MainPID'] == '0', 'STOP_LEGACY_BEFORE_REPLACE')
        for name in TARGETS:
            current = (LIVE / name).read_bytes()
            require(current in (self.before[name], (self.payload / name).read_bytes()), 'UNOWNED_LEGACY_SOURCE_DRIFT')
            desired = self.before[name] if role == 'baseline' else (self.payload / name).read_bytes()
            if current != desired:
                os.replace(self.pending[role][name], LIVE / name)
                base.fsync_directory((LIVE / name).parent)

    def start(self):
        self.guard()
        base.command(['systemctl', 'start', UNIT], timeout=35)

    def verify(self, role):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(20):
            try:
                with opener.open('http://127.0.0.1:8000/api/health', timeout=3) as response:
                    value = json.loads(response.read(8192))
                require_healthy_response(value)
                current = self.capture()
                require(base.relevant_environment(base.process_environment(current['pid'])) == self.environment, 'LEGACY_ENVIRONMENT_CHANGED')
                break
            except (OSError, ValueError):
                time.sleep(.3)
        else:
            raise base.GateError('LEGACY_RESTART_FAILED')
        self.guard()
        for name in TARGETS:
            expected = self.before[name] if role == 'baseline' else (self.payload / name).read_bytes()
            require((LIVE / name).read_bytes() == expected, 'LEGACY_POST_START_DRIFT')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--frontend', type=Path, required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    raw = args.manifest.read_bytes()
    require(base.sha(raw) == args.manifest_sha256, 'LEGACY_MANIFEST_HASH_MISMATCH')
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt()
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, interrupt)
    adapter = Adapter(json.loads(raw), args.payload, args.run_dir, args.frontend, args.node)
    if args.check_only:
        adapter.acquire()
        try:
            adapter.prepare()
            adapter.preflight()
            adapter.before_stop()
            result = {'status': 'PASS_LEGACY_RELEASE_PREFLIGHT', 'liveChanged': False}
        finally:
            adapter.release()
    else:
        result = transact(adapter)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
