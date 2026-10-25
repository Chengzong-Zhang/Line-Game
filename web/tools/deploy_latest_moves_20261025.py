"""Hash-bound latest-move display overlay for both existing frontend trees.

No backend files, databases or service processes are changed. Each frontend
directory is exchanged atomically; failure or explicit rollback restores both.
An interrupted activation is never replayed: inspect its receipt, then rollback.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path('/home/ubuntu/line-game')
RELEASE = 'web-latest-moves-20261025-r1'
PREDECESSOR = 'web-defense15-20261025-r1'
ASSET_VERSION = '20261025-latestmoves1'
OVERLAY_FILES = {'GameController.js', 'Renderer.js', 'OnlineApp.js', 'main.js', 'index.html'}
CACHE_SOURCES = {'OnlineApp.js', 'main.js', 'index.html'}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def trees(root):
    artifacts = root / '.deploy-artifacts'
    return {'site': root / 'web/web前端',
            'wechat': artifacts / 'wechat-service-20261021/release/web/web前端'}


def protected(root):
    wx = root / '.deploy-artifacts/wechat-service-20261021/release'
    return {**{'legacy-' + name: root / relative for name, relative in {
        'server': 'web/web后端/server.py', 'bridge': 'web/tools/online_bot_bridge.mjs',
        'runtime': 'web/tools/online_bot_runtime.mjs', 'package': 'web/package.json'}.items()},
        **{'wechat-' + name: wx / relative for name, relative in {
        'server': 'web/web后端/wechat_online.py', 'bridge': 'web/tools/online_bot_bridge.mjs',
        'runtime': 'web/tools/online_bot_runtime.mjs', 'package': 'web/package.json',
        'validator': 'wechat/minigame/tools/validate-action.mjs'}.items()}}


def tree(path):
    if not path.is_dir() or path.is_symlink():
        raise RuntimeError('expected real frontend directory')
    digest = hashlib.sha256()
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise RuntimeError('frontend symlink rejected')
        if file.is_file():
            name = file.relative_to(path).as_posix().encode()
            digest.update(len(name).to_bytes(8, 'big')); digest.update(name)
            digest.update(bytes.fromhex(sha(file)))
    return digest.hexdigest()


def safe(name):
    return bool(name) and not name.startswith('/') and '\\' not in name and ':' not in name and all(
        part not in ('', '.', '..') for part in name.split('/'))


def resources(frontend, manifest):
    files = manifest.get('files')
    if not isinstance(files, dict) or not files or not all(safe(name) for name in files):
        raise RuntimeError('invalid complete resource manifest')
    for name, expected in files.items():
        file = frontend / name
        if file.is_symlink() or sha(file) != expected:
            raise RuntimeError('resource hash mismatch: ' + name)


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(url):
        with opener.open(url, timeout=5) as response:
            return json.load(response)
    game = get('http://127.0.0.1:8000/api/health')
    wx = get('http://127.0.0.1:8006/api/wechat/status')
    if game.get('status') != 'ok' or wx.get('enabled') is not True:
        raise RuntimeError('existing service health failed')
    return {'game': 'ok', 'wechatEnabled': True, 'playerCounts': wx.get('playerCounts')}


def inspect(root=ROOT):
    fronts = trees(root)
    manifests = {name: json.loads((front / 'release-manifest.json').read_text(encoding='utf-8'))
                 for name, front in fronts.items()}
    for name, front in fronts.items():
        if manifests[name].get('release_id') != PREDECESSOR:
            raise RuntimeError('production release changed; inspect before preparing a new overlay')
        resources(front, manifests[name])
    before = {name: {'tree': tree(front), 'manifest': sha(front / 'release-manifest.json')}
              for name, front in fronts.items()}
    if before['site'] != before['wechat']:
        raise RuntimeError('frontend copies differ; resolve the baseline before release')
    pins = {name: sha(file) for name, file in protected(root).items()}
    result = {'schemaVersion': 1, 'status': 'READ_ONLY_PREDECESSOR_SNAPSHOT',
              'releaseId': PREDECESSOR, 'inspectedAtUtcEpoch': time.time(), 'before': before,
              'protected': pins, 'frontendManifest': manifests['site'], 'health': health(),
              'resourceSizes': {name: (fronts['site'] / name).stat().st_size for name in manifests['site']['files']},
              'cacheSources': {name: (fronts['site'] / name).read_bytes().decode('utf-8')
                               for name in sorted(CACHE_SOURCES)}}
    check_before(root, result)
    return result


def check_before(root, snapshot):
    for name, front in trees(root).items():
        if (tree(front) != snapshot['before'][name]['tree'] or
                sha(front / 'release-manifest.json') != snapshot['before'][name]['manifest']):
            raise RuntimeError('frontend predecessor changed: ' + name)
        current = json.loads((front / 'release-manifest.json').read_text(encoding='utf-8'))
        if current != snapshot['frontendManifest'] or current.get('release_id') != PREDECESSOR:
            raise RuntimeError('snapshot resource inventory differs from the actual predecessor')
    if {name: sha(file) for name, file in protected(root).items()} != snapshot['protected']:
        raise RuntimeError('backend predecessor changed')


def save(path, value):
    temp = path.with_suffix('.pending')
    with temp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n')
        stream.flush(); os.fsync(stream.fileno())
    temp.replace(path)


def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, str(left).encode(), -100, str(right).encode(), 2):
        raise OSError(ctypes.get_errno(), 'atomic frontend exchange failed')


def public_verify(manifest, expected_manifest_sha):
    """Check all public resources with certificates and a 100-second deadline."""
    deadline = time.monotonic() + 100
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def fetch(name):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('public resource verification deadline')
        url = 'https://lifelinegame.cn/' + urllib.parse.quote(name, safe='/')
        request = urllib.request.Request(url + '?v=' + ASSET_VERSION, headers={'Cache-Control': 'no-cache'})
        with opener.open(request, timeout=min(10, remaining)) as response:
            return response.read()
    def verify_file(item):
        name, expected = item
        raw = fetch(name)
        if hashlib.sha256(raw).hexdigest() != expected:
            raise RuntimeError('public resource mismatch: ' + name)
        return len(raw)
    with ThreadPoolExecutor(max_workers=6) as pool:
        sizes = list(pool.map(verify_file, manifest['files'].items()))
    if hashlib.sha256(fetch('release-manifest.json')).hexdigest() != expected_manifest_sha:
        raise RuntimeError('public manifest mismatch')
    if hashlib.sha256(fetch('')).hexdigest() != manifest['files']['index.html']:
        raise RuntimeError('public root mismatch')
    return {'status': 'PASS_ALL_PUBLIC_RESOURCE_HASHES', 'files': len(sizes), 'bytes': sum(sizes),
            'manifestSha256': expected_manifest_sha, 'certificateValidation': True}


def load_release(release, root):
    if release.resolve(strict=True).parent != root / '.deploy-artifacts' or release.name != RELEASE:
        raise RuntimeError('unexpected release directory')
    manifest = json.loads((release / 'deployment-manifest.json').read_text(encoding='utf-8'))
    if (manifest.get('schemaVersion') != 1 or manifest.get('releaseId') != RELEASE or
            sha(release / 'payload.zip') != manifest['archiveSha256'] or
            sha(Path(__file__)) != manifest['deployerSha256']):
        raise RuntimeError('frozen release identity/hash mismatch')
    return manifest


def rollback(release, manifest, root=ROOT):
    state = json.loads((release / 'deployment.json').read_text(encoding='utf-8'))
    failures = []
    for name, front in reversed(list(trees(root).items())):
        expected_old = manifest['snapshot']['before'][name]['tree']
        try:
            if tree(front) == expected_old:
                continue
            if tree(front) != state['candidateTree']:
                raise RuntimeError('live frontend changed; refusing destructive recovery')
            old = next((p for p in (release / ('rollback-' + name), release / ('candidate-' + name))
                        if p.exists() and tree(p) == expected_old), None)
            if old is None:
                raise RuntimeError('validated rollback tree missing')
            exchange(front, old)
        except BaseException as error:
            failures.append(name + ':' + type(error).__name__)
    try:
        check_before(root, manifest['snapshot'])
        restored_health = health()
        if restored_health != manifest['snapshot']['health']:
            raise RuntimeError('restored service capabilities differ from the predecessor')
    except BaseException as error:
        failures.append('verification:' + type(error).__name__); restored_health = None
    state.update(status='ROLLED_BACK_VERIFIED' if not failures else 'RECOVERY_REQUIRES_ATTENTION',
                 recoveryFailures=failures, restoredHealth=restored_health, completedAtUtcEpoch=time.time())
    save(release / 'deployment.json', state)
    if failures:
        raise RuntimeError('rollback requires manual inspection: ' + ','.join(failures))
    return state


def activate(release, manifest, root=ROOT):
    receipt = release / 'deployment.json'
    if receipt.exists():
        raise RuntimeError('receipt exists; inspect it and use verify or rollback, never blind replay')
    check_before(root, manifest['snapshot'])
    initial_health = health()
    if initial_health != manifest['snapshot']['health']:
        raise RuntimeError('service capabilities changed since inspection')
    with zipfile.ZipFile(release / 'payload.zip') as archive:
        expected = set(manifest['overlayFiles']) | {'release-manifest.json'}
        if len(archive.namelist()) != len(expected) or set(archive.namelist()) != expected:
            raise RuntimeError('overlay inventory mismatch')
        if set(manifest['overlayFiles']) != OVERLAY_FILES:
            raise RuntimeError('overlay must contain only reviewed display files and cache pins')
        raw_manifest = archive.read('release-manifest.json')
        frontend_manifest = json.loads(raw_manifest)
        if (hashlib.sha256(raw_manifest).hexdigest() != manifest['frontendManifestSha256'] or
                frontend_manifest.get('release_id') != RELEASE or
                frontend_manifest.get('asset_version') != ASSET_VERSION):
            raise RuntimeError('frontend manifest mismatch')
        old_files = manifest['snapshot']['frontendManifest']['files']
        if set(frontend_manifest['files']) != set(old_files) or any(
                value != old_files[name] for name, value in frontend_manifest['files'].items()
                if name not in OVERLAY_FILES):
            raise RuntimeError('overlay altered a resource outside the display scope')
        for name, front in trees(root).items():
            candidate = release / ('candidate-' + name)
            shutil.copytree(front, candidate)
            if tree(candidate) != manifest['snapshot']['before'][name]['tree']:
                raise RuntimeError('frontend changed while copying')
            for file, expected_sha in manifest['overlayFiles'].items():
                raw = archive.read(file)
                if hashlib.sha256(raw).hexdigest() != expected_sha or expected_sha != frontend_manifest['files'][file]:
                    raise RuntimeError('overlay content hash mismatch: ' + file)
                (candidate / file).write_bytes(raw)
            (candidate / 'release-manifest.json').write_bytes(raw_manifest)
            owner = front.stat()
            for directory, _, names in os.walk(candidate):
                os.chown(directory, owner.st_uid, owner.st_gid)
                for file in names:
                    os.chown(Path(directory) / file, owner.st_uid, owner.st_gid)
            resources(candidate, frontend_manifest)
    candidate_tree = tree(release / 'candidate-site')
    if tree(release / 'candidate-wechat') != candidate_tree:
        raise RuntimeError('frontend candidates differ')
    check_before(root, manifest['snapshot'])
    state = {'status': 'PREFLIGHT_OK', 'releaseId': RELEASE, 'candidateTree': candidate_tree,
             'backendChanged': False, 'databasesChanged': False, 'serviceRestarts': 0,
             'startedAtUtcEpoch': time.time(), 'swapped': []}
    save(receipt, state)
    try:
        for name, front in trees(root).items():
            candidate = release / ('candidate-' + name)
            exchange(front, candidate)
            candidate.rename(release / ('rollback-' + name))
            state['swapped'].append(name); save(receipt, state)
        for front in trees(root).values():
            resources(front, frontend_manifest)
            if tree(front) != candidate_tree:
                raise RuntimeError('installed complete frontend tree mismatch')
        if {name: sha(file) for name, file in protected(root).items()} != manifest['snapshot']['protected']:
            raise RuntimeError('backend files changed during frontend release')
        final_health = health()
        if final_health != initial_health:
            raise RuntimeError('existing service capabilities changed after overlay')
        state.update(status='INSTALLED_BOTH_FRONTENDS_VERIFYING_PUBLIC', health=final_health); save(receipt, state)
        state['public'] = public_verify(frontend_manifest, manifest['frontendManifestSha256'])
        state.update(status='ACTIVATED_BOTH_FRONTENDS_PUBLIC_HASHES_VERIFIED', completedAtUtcEpoch=time.time())
        save(receipt, state)
    except BaseException as error:
        state.update(status='RECOVERY_RUNNING', error=type(error).__name__); save(receipt, state)
        rollback(release, manifest, root)
        raise
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inspect', 'activate', 'verify', 'rollback'))
    parser.add_argument('--release-dir', type=Path)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('existing privileged Linux deployment channel required')
    import fcntl
    artifacts = ROOT / '.deploy-artifacts'
    with (artifacts / 'unified-release.lock').open('a') as shared, (artifacts / 'frontend-release.lock').open('a') as front:
        fcntl.flock(shared, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(front, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'inspect':
            result = inspect()
        else:
            if args.release_dir is None:
                parser.error('--release-dir is required')
            release = args.release_dir.resolve(strict=True)
            manifest = load_release(release, ROOT)
            if args.command == 'activate':
                result = activate(release, manifest)
            elif args.command == 'rollback':
                result = rollback(release, manifest)
            else:
                expected = manifest['frontendManifestSha256']
                for frontend in trees(ROOT).values():
                    if sha(frontend / 'release-manifest.json') != expected:
                        raise RuntimeError('installed release manifest changed')
                    resources(frontend, json.loads((frontend / 'release-manifest.json').read_text(encoding='utf-8')))
                if {name: sha(file) for name, file in protected(ROOT).items()} != manifest['snapshot']['protected']:
                    raise RuntimeError('backend files changed')
                result = {'status': 'PASS_INSTALLED_PUBLIC_AND_SERVICE_HEALTH', 'health': health(),
                          'public': public_verify(json.loads((trees(ROOT)['site'] / 'release-manifest.json').read_text(encoding='utf-8')), expected)}
        print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
