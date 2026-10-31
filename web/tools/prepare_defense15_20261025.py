"""Freeze the defense/15-seat runtime and a complete Web frontend bundle.

--before is a freshly inspected server snapshot, never an inferred old receipt.
This builder has no network or activation behavior and does not stamp sources.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile
from deploy_defense15_20261025 import RELEASE, TARGETS, EXTRAS, sha

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    'legacy-server': 'web/web后端/server.py',
    'legacy-bridge': 'web/tools/online_bot_bridge.mjs',
    'legacy-runtime': 'web/tools/online_bot_runtime.mjs',
    'legacy-package': 'web/package.json',
    'wechat-server': 'web/web后端/wechat_online.py',
    'wechat-bridge': 'web/tools/online_bot_bridge.mjs',
    'wechat-runtime': 'web/tools/online_bot_runtime.mjs',
    'wechat-package': 'web/package.json',
    'wechat-validator': 'wechat/minigame/tools/validate-action.mjs',
}
TREE_KEYS = {'siteManifest', 'siteTree', 'wechatFrontendTree'}


def safe(name):
    return bool(name) and not name.startswith('/') and '\\' not in name and ':' not in name and all(part not in ('', '.', '..') for part in name.split('/'))


def prepare(frontend, before_path, output, validator_bundle):
    validator = json.loads(validator_bundle.with_name('manifest.json').read_text(encoding='utf-8'))
    if validator.get('schemaVersion') != 1 or sha(validator_bundle) != validator.get('bundleSha256'):
        raise ValueError('validator bundle integrity mismatch')
    hashes = validator.get('sourceHashes', {})
    required = {'wechat/minigame/src/state.js', 'web/web前端/GameEngine.js'}
    if not required.issubset(hashes):
        raise ValueError('validator missing current rule sources')
    for name, expected in hashes.items():
        if not safe(name) or sha(ROOT / name) != expected:
            raise ValueError('validator source drift: ' + name)
    before = json.loads(before_path.read_text(encoding='utf-8'))
    before = before.get('before', before)
    if set(before) != set(TARGETS) | TREE_KEYS or any(
        (value is None and key in TREE_KEYS) or (value is not None and not re.fullmatch('[a-f0-9]{64}', str(value)))
        for key, value in before.items()):
        raise ValueError('incomplete or invalid freshly inspected predecessor snapshot')
    raw_manifest = (frontend / 'release-manifest.json').read_bytes()
    envelope = json.loads(raw_manifest)
    if envelope.get('release_id') != RELEASE or not re.fullmatch('[a-f0-9]{40}', envelope.get('commit', '')):
        raise ValueError('frontend release/commit identity mismatch')
    files = envelope.get('files')
    if not isinstance(files, dict) or not files or not all(safe(name) for name in files):
        raise ValueError('invalid complete frontend inventory')
    source_front = ROOT / 'web/web前端'
    required = {file.relative_to(source_front).as_posix() for file in source_front.rglob('*') if file.is_file()
                and not any(part.startswith('.') for part in file.relative_to(source_front).parts)
                and not file.relative_to(source_front).as_posix().startswith('tests/') and file.name != 'smoke-test.html'}
    if set(files) != required:
        raise ValueError('prepared frontend does not contain the complete current runtime')
    archive_path = frontend / 'frontend-overlay.zip'
    archive_hash = sha(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(files) | {'release-manifest.json'} or archive.read('release-manifest.json') != raw_manifest:
            raise ValueError('frontend archive envelope/inventory mismatch')
        for name, expected in files.items():
            source = source_front / name
            if source.is_symlink() or sha(source) != expected or hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise ValueError('frontend source/archive changed: ' + name)
    if json.loads((ROOT / 'web/package.json').read_text(encoding='utf-8')).get('type') != 'module':
        raise ValueError('native Node runtime requires web/package.json type=module')
    output.mkdir(parents=True, exist_ok=False)
    staged = output / 'payload'; staged.mkdir()
    for key, name in SOURCES.items():
        # Native source dependencies are compiled together. The old service's
        # six-seat src/ cannot leak into the authoritative validation runtime.
        source = validator_bundle if key == 'wechat-validator' else ROOT / name
        if source.is_symlink() or not source.is_file():
            raise ValueError('invalid runtime source: ' + name)
        raw = source.read_bytes(); (staged / key).write_bytes(raw)
        if source.read_bytes() != raw:
            raise ValueError('concurrent source change: ' + name)
    shutil.copyfile(archive_path, staged / 'frontend-overlay.zip')
    shutil.copyfile(ROOT / 'web/tools/atomic_frontend_release.py', staged / 'atomic_frontend_release.py')
    deployer = ROOT / 'web/tools/deploy_defense15_20261025.py'
    shutil.copyfile(deployer, output / 'remote-release.py')
    if sha(archive_path) != archive_hash or (frontend / 'release-manifest.json').read_bytes() != raw_manifest:
        raise ValueError('frontend changed during freeze')
    payload = {file.name: sha(file) for file in sorted(staged.iterdir())}
    if set(payload) != set(TARGETS) | EXTRAS:
        raise ValueError('payload inventory mismatch')
    archive = output / 'payload.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in payload:
            bundle.write(staged / name, name)
    manifest = {'schemaVersion': 1, 'releaseId': RELEASE, 'commit': envelope['commit'], 'before': before,
                'payload': payload, 'archiveSha256': sha(archive), 'deployerSha256': sha(output / 'remote-release.py'),
                'siteCandidateManifestSha256': hashlib.sha256(raw_manifest).hexdigest()}
    (output / 'deployment-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    receipt = {'status': 'FROZEN_NOT_DEPLOYED', 'releaseId': RELEASE, 'commit': envelope['commit'],
               'completeFrontendFiles': len(files), 'sameFrontendForService': True, 'databaseReplacement': False,
               'payloadFiles': len(payload), 'archiveSha256': manifest['archiveSha256'], 'deployerSha256': manifest['deployerSha256']}
    (output / 'preparation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend', type=Path, required=True)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--validator-bundle', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.frontend.resolve(), args.before.resolve(), args.output.resolve(), args.validator_bundle.resolve(strict=True))))
