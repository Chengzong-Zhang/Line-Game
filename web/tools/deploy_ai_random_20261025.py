"""One-shot Web/WeChat AI and random-start release on the existing Linux host.

The payload and predecessor hashes are frozen in a local release manifest.
The script keeps the old service files and frontend trees for recovery.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/home/ubuntu/line-game')
ARTIFACTS = ROOT / '.deploy-artifacts'
WECHAT = ARTIFACTS / 'wechat-service-20261021/release'
SITE = ROOT / 'web/web前端'
TARGETS = {
    'legacy-server': ROOT / 'web/web后端/server.py',
    'legacy-bridge': ROOT / 'web/tools/online_bot_bridge.mjs',
    'wechat-server': WECHAT / 'web/web后端/wechat_online.py',
    'wechat-bridge': WECHAT / 'web/tools/online_bot_bridge.mjs',
}
UNITS = ('lifeline-game.service', 'lifeline-wechat.service')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def command(*args):
    subprocess.run(args, check=True, timeout=90, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE)


def health():
    result = {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for name, url in (('game', 'http://127.0.0.1:8000/api/health'),
                      ('wechat', 'http://127.0.0.1:8006/api/wechat/status')):
        for _ in range(20):
            try:
                with opener.open(url, timeout=3) as response:
                    value = json.load(response)
                if (value.get('status') == 'ok' if name == 'game' else value.get('enabled') is True):
                    result[name] = True
                    break
            except (OSError, ValueError):
                time.sleep(.5)
        else:
            raise RuntimeError(name + ' health failed')
    return result


def save(path, value):
    temp = path.with_suffix('.pending')
    temp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def install(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    old = target.stat() if target.exists() else None
    temp = target.with_name(target.name + '.release-pending')
    if temp.exists():
        raise RuntimeError('stale pending file: ' + str(temp))
    shutil.copyfile(source, temp)
    os.chown(temp, old.st_uid if old else 0, old.st_gid if old else 1000)
    os.chmod(temp, (old.st_mode & 0o777) if old else 0o640)
    temp.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release-dir', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('root on Linux required')
    release = args.release_dir.resolve(strict=True)
    if release.parent != ARTIFACTS or release.name != 'web-ai-random-20261025-r1':
        raise RuntimeError('unexpected release directory')
    state_path = release / 'deployment.json'
    if state_path.exists():
        raise RuntimeError('existing deployment receipt; inspect before retry')
    manifest = json.loads((release / 'deployment-manifest.json').read_text(encoding='utf-8'))
    archive = release / 'payload.zip'
    if digest(archive) != manifest['archiveSha256']:
        raise RuntimeError('payload hash mismatch')
    if digest(SITE / 'release-manifest.json') != manifest['before']['siteManifest']:
        raise RuntimeError('site predecessor changed')
    live_manifest = json.loads((SITE / 'release-manifest.json').read_text(encoding='utf-8'))
    for name, expected in live_manifest.get('runtime_files', {}).items():
        if digest(SITE / name) != expected:
            raise RuntimeError('site runtime drift: ' + name)
    for key, path in TARGETS.items():
        expected = manifest['before'][key]
        if (digest(path) if path.exists() else None) != expected:
            raise RuntimeError(key + ' predecessor changed')
    wechat_front = WECHAT / 'web/web前端'
    for name, expected in manifest['before']['wechatFrontend'].items():
        if digest(wechat_front / name) != expected:
            raise RuntimeError('WeChat frontend predecessor changed: ' + name)
    health()
    stage = release / 'stage'
    if stage.exists():
        raise RuntimeError('stage already exists')
    stage.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        if set(bundle.namelist()) != set(manifest['payload']):
            raise RuntimeError('payload inventory changed')
        for name, expected in manifest['payload'].items():
            path = Path(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name:
                raise RuntimeError('invalid payload path')
            raw = bundle.read(name)
            if hashlib.sha256(raw).hexdigest() != expected:
                raise RuntimeError('payload member changed: ' + name)
            output = stage / name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(raw)
    backup = release / 'rollback'
    backup.mkdir()
    for key, path in TARGETS.items():
        if path.exists():
            shutil.copy2(path, backup / key)
    site_ops = stage / 'atomic_frontend_release.py'
    command('python3', str(site_ops), 'prepare', '--release-id', release.name,
            '--archive', str(stage / 'frontend-overlay.zip'),
            '--archive-sha256', manifest['payload']['frontend-overlay.zip'])
    site_candidate = ARTIFACTS / (release.name + '.candidate')
    for directory, _, names in os.walk(site_candidate):
        os.chmod(directory, 0o755)
        for name in names:
            os.chmod(Path(directory) / name, 0o644)
    shutil.copytree(wechat_front, stage / 'wechat-candidate')
    for name in manifest['before']['wechatFrontend']:
        shutil.copyfile(stage / 'wechat-frontend' / name, stage / 'wechat-candidate' / name)
    for directory, _, names in os.walk(stage / 'wechat-candidate'):
        os.chown(directory, 0, 1000); os.chmod(directory, 0o750)
        for name in names:
            os.chown(Path(directory) / name, 0, 1000)
            os.chmod(Path(directory) / name, 0o640)
    # Exercise the actual 2-player bot bridge against the staged runtime.
    probe = stage / 'probe/web'
    (probe / 'tools').mkdir(parents=True)
    shutil.copyfile(stage / 'wechat-bridge', probe / 'tools/online_bot_bridge.mjs')
    shutil.copytree(stage / 'wechat-candidate', probe / 'web前端')
    request = {'settings': {'gridSize': 5, 'playerCount': 2, 'boardShape': 'triangle',
                           'rulesVersion': 'territory-v3', 'startPlayer': 'WHITE'},
               'actions': [], 'botColors': ['WHITE']}
    trial = subprocess.run([str(ARTIFACTS / 'wechat-service-20261021/runtime/node'),
                            str(probe / 'tools/online_bot_bridge.mjs')],
                           input=json.dumps(request), text=True, capture_output=True, timeout=25)
    if trial.returncode or not json.loads(trial.stdout).get('success'):
        raise RuntimeError('staged bot probe failed')
    state = {'status': 'PREFLIGHT_OK', 'release': release.name, 'healthBefore': True,
             'servicesChanged': False, 'siteChanged': False}
    save(state_path, state)
    changed = False
    site_changed = False
    try:
        changed = True
        for unit in UNITS:
            command('systemctl', 'stop', unit)
        for key, path in TARGETS.items():
            install(stage / key, path)
        wechat_front.rename(backup / 'wechat-frontend')
        (stage / 'wechat-candidate').rename(wechat_front)
        for unit in UNITS:
            command('systemctl', 'start', unit)
        health()
        state['servicesChanged'] = True
        save(state_path, state)
        command('python3', str(site_ops), 'activate', '--release-id', release.name)
        site_changed = True
        state['siteChanged'] = True
        for key, path in TARGETS.items():
            if digest(path) != manifest['payload'][key]:
                raise RuntimeError(key + ' post-activation hash mismatch')
        for name in manifest['before']['wechatFrontend']:
            if digest(wechat_front / name) != manifest['payload']['wechat-frontend/' + name]:
                raise RuntimeError('WeChat module post-activation mismatch: ' + name)
        if digest(SITE / 'release-manifest.json') != manifest['siteCandidateManifestSha256']:
            raise RuntimeError('site post-activation manifest mismatch')
        state.update(status='ACTIVATED_ALL_COMPONENTS_VERIFIED', healthAfter=health())
        save(state_path, state)
    except BaseException:
        state['status'] = 'RECOVERY_RUNNING'
        save(state_path, state)
        if site_changed or digest(SITE / 'release-manifest.json') == manifest['siteCandidateManifestSha256']:
            activation = ARTIFACTS / (release.name + '.activation.json')
            if activation.exists():
                command('python3', str(site_ops), 'rollback', '--release-id', release.name)
            else:
                spec = importlib.util.spec_from_file_location('site_ops', site_ops)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                old = ARTIFACTS / (release.name + '.candidate')
                if not old.exists():
                    old = ARTIFACTS / (release.name + '.rollback-web前端')
                if not old.exists():
                    raise RuntimeError('site recovery source missing')
                module.exchange(SITE, old)
        if changed:
            for unit in UNITS:
                command('systemctl', 'stop', unit)
            for key, path in TARGETS.items():
                old = backup / key
                if old.exists():
                    install(old, path)
                elif path.exists():
                    path.unlink()
            old_front = backup / 'wechat-frontend'
            if old_front.exists():
                if wechat_front.exists():
                    wechat_front.rename(stage / 'wechat-failed')
                old_front.rename(wechat_front)
            for unit in UNITS:
                command('systemctl', 'start', unit)
            health()
        state['status'] = 'ROLLED_BACK_AFTER_FAILURE'
        save(state_path, state)
        raise
    print(json.dumps({'status': state['status'], 'release': release.name}))


if __name__ == '__main__':
    main()
