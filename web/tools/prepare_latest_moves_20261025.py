"""Freeze only the latest-move display files over a freshly inspected baseline.

This builder performs no network operations and never modifies application
sources. Cache pins are transformed inside the frozen overlay only; all other
resources stay byte-identical to the inspected production manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile
from deploy_latest_moves_20261025 import ASSET_VERSION, CACHE_SOURCES, OVERLAY_FILES, PREDECESSOR, RELEASE, safe, sha

ROOT = Path(__file__).resolve().parents[2]


def replace(text, expression, replacement, expected):
    result, count = re.subn(expression, replacement, text)
    if count != expected:
        raise ValueError('cache dependency changed; review the new entry graph')
    return result


def prepare(before_path, output, source_root=ROOT):
    snapshot = json.loads(before_path.read_text(encoding='utf-8'))
    if 'stdout' in snapshot:
        snapshot = json.loads(snapshot['stdout'])
    old = snapshot.get('frontendManifest', {})
    if (snapshot.get('schemaVersion') != 1 or snapshot.get('status') != 'READ_ONLY_PREDECESSOR_SNAPSHOT'
            or snapshot.get('releaseId') != PREDECESSOR or old.get('release_id') != PREDECESSOR
            or set(snapshot.get('cacheSources', {})) != CACHE_SOURCES):
        raise ValueError('fresh, complete production predecessor snapshot required')
    if not isinstance(old.get('files'), dict) or not OVERLAY_FILES.issubset(old['files']) or not all(safe(n) for n in old['files']):
        raise ValueError('invalid full predecessor resource manifest')
    if snapshot['before']['site'] != snapshot['before']['wechat']:
        raise ValueError('production frontend copies differ')
    for name, text in snapshot['cacheSources'].items():
        if hashlib.sha256(text.encode('utf-8')).hexdigest() != old['files'][name]:
            raise ValueError('cache source text does not match production: ' + name)
    frontend = source_root / 'web/web前端'
    sources = {name: (frontend / name).read_bytes() for name in ('GameController.js', 'Renderer.js')}
    files = {**sources, **{name: text.encode('utf-8') for name, text in snapshot['cacheSources'].items()}}
    files['GameController.js'] = replace(files['GameController.js'].decode('utf-8'),
        r'(\./Renderer\.js)(?:\?v=[^\s\'\"]+)?', r'\1?v=' + ASSET_VERSION, 1).encode('utf-8')
    files['OnlineApp.js'] = replace(files['OnlineApp.js'].decode('utf-8'),
        r'(\./GameController\.js)(?:\?v=[^\s\'\"]+)?', r'\1?v=' + ASSET_VERSION, 1).encode('utf-8')
    main = replace(files['main.js'].decode('utf-8'), r'const APP_ASSET_VERSION = "[^\"]+";',
                   'const APP_ASSET_VERSION = "' + ASSET_VERSION + '";', 1)
    # Static fallback URLs must select the same entry as the dynamic version.
    main = replace(main, r'(\./OnlineApp\.js\?v=)[A-Za-z0-9_-]+', r'\g<1>' + ASSET_VERSION, 2)
    files['main.js'] = main.encode('utf-8')
    files['index.html'] = replace(files['index.html'].decode('utf-8'),
        r'(\./main\.js\?v=)[A-Za-z0-9_-]+', r'\g<1>' + ASSET_VERSION, 1).encode('utf-8')
    if set(files) != OVERLAY_FILES:
        raise ValueError('unexpected display overlay scope')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, encoding='utf-8').strip()
    hashes = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
    sizes = snapshot.get('resourceSizes', {})
    if set(sizes) != set(old['files']) or not all(isinstance(size, int) and size >= 0 for size in sizes.values()):
        raise ValueError('complete predecessor resource sizes are required')
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain', '--', 'web/web前端'],
                                        cwd=ROOT, text=True, encoding='utf-8').strip())
    manifest = {**old, 'release_id': RELEASE, 'asset_version': ASSET_VERSION, 'commit': commit,
                'workspace_dirty': dirty, 'source_bytes': sum(len(files[name]) if name in files else size for name, size in sizes.items()),
                'deployment_scope': 'latest-move-renderer-controller-overlay-both-frontends',
                'files': {**old['files'], **hashes}, 'predecessor_release_id': PREDECESSOR,
                'source_transforms': 'only display dependency cache pins; all other runtime bytes preserved'}
    raw_manifest = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    output.mkdir(parents=True, exist_ok=False)
    deployer = Path(__file__).with_name('deploy_latest_moves_20261025.py')
    shutil.copyfile(deployer, output / 'remote-release.py')
    archive = output / 'payload.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, raw in sorted(files.items()):
            bundle.writestr(name, raw)
        bundle.writestr('release-manifest.json', raw_manifest)
    (output / 'release-manifest.json').write_bytes(raw_manifest)
    for name, raw in sources.items():
        if (frontend / name).read_bytes() != raw:
            raise ValueError('source changed while freezing: ' + name)
    deployment = {'schemaVersion': 1, 'releaseId': RELEASE, 'commit': commit,
                  'snapshot': snapshot, 'overlayFiles': hashes,
                  'sourceHashes': {name: hashlib.sha256(raw).hexdigest() for name, raw in sources.items()},
                  'archiveSha256': sha(archive), 'deployerSha256': sha(output / 'remote-release.py'),
                  'frontendManifestSha256': hashlib.sha256(raw_manifest).hexdigest()}
    (output / 'deployment-manifest.json').write_text(json.dumps(deployment, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    receipt = {'status': 'FROZEN_NOT_DEPLOYED', 'releaseId': RELEASE, 'commit': commit,
               'overlayFiles': sorted(files), 'totalRuntimeFiles': len(manifest['files']),
               'preservedBackendFiles': len(snapshot['protected']), 'databaseReplacement': False,
               'serviceRestarts': 0, 'sourceMutation': False, 'archiveSha256': deployment['archiveSha256'],
               'deployerSha256': deployment['deployerSha256']}
    (output / 'preparation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.before.resolve(strict=True), args.output.resolve())))
