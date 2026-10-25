"""Freeze and pin the reviewed release components for one SSH transfer."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
RELEASE = 'web-all-features-20261024-r1'
BEFORE = {
    'web/web后端/server.py': 'e7858e42b9301fa5096576f887e149fa8a912d7126beb8efe0117ff0fb61fb6b',
    'web/tools/online_bot_bridge.mjs': '758a4657bbcdd0379760e298b818f8cf087d93fa096a5d87d84c361a3767fc1f',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def release_identity(value):
    if len(value) > 100 or not re.fullmatch(r'web-all-features-[0-9]{8}-r[1-9][0-9]*', value):
        raise argparse.ArgumentTypeError('Invalid one-shot release ID')
    return value


def rebind_frontend(source, destination, release):
    """Create a new envelope; every runtime member retains its original bytes."""
    release_identity(release)
    source_manifest = source / 'release-manifest.json'
    source_archive = source / 'frontend-overlay.zip'
    assert all(path.is_file() and not path.is_symlink() for path in (source_manifest, source_archive))
    manifest_bytes = source_manifest.read_bytes()
    archive_hash = sha(source_archive)
    manifest = json.loads(manifest_bytes)
    original_release = manifest['release_id']
    assert isinstance(manifest['files'], dict) and manifest['files']
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source_archive) as old:
        names = old.namelist()
        assert len(names) == len(set(names)), 'Duplicate archive members'
        assert set(names) == set(manifest['files']) | {'release-manifest.json'}
        assert old.read('release-manifest.json') == manifest_bytes, 'Manifest envelope mismatch'
        for name, digest in manifest['files'].items():
            assert not name.startswith('/') and '\\' not in name and '..' not in name.split('/')
            assert hashlib.sha256(old.read(name)).hexdigest() == digest, 'Runtime hash mismatch'
        if original_release == release:
            (destination / 'release-manifest.json').write_bytes(manifest_bytes)
            (destination / 'frontend-overlay.zip').write_bytes(source_archive.read_bytes())
        else:
            manifest['release_id'] = release
            rebound = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            (destination / 'release-manifest.json').write_bytes(rebound)
            with zipfile.ZipFile(destination / 'frontend-overlay.zip', 'x') as new:
                for member in old.infolist():
                    data = rebound if member.filename == 'release-manifest.json' else old.read(member.filename)
                    new.writestr(member, data)
    assert source_manifest.read_bytes() == manifest_bytes and sha(source_archive) == archive_hash, 'Concurrent source change'
    with zipfile.ZipFile(destination / 'frontend-overlay.zip') as new:
        for name, digest in manifest['files'].items():
            assert hashlib.sha256(new.read(name)).hexdigest() == digest, 'Runtime bytes changed during rebind'
    return {'sourceReleaseId': original_release, 'release_id': release,
            'sourceManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
            'sourceArchiveSha256': archive_hash, 'runtimeMembersUnchanged': len(manifest['files'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend', required=True, type=Path)
    parser.add_argument('--service', required=True, type=Path)
    parser.add_argument('--legacy', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--release-id', type=release_identity, default=RELEASE)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    payload = output / 'payload'
    payload.mkdir()

    def copy(source, name):
        assert not source.is_symlink() and source.is_file()
        target = payload / name
        target.parent.mkdir(parents=True, exist_ok=True)
        content = source.read_bytes()
        target.write_bytes(content)
        assert source.read_bytes() == content, 'Concurrent source change'

    rebound = rebind_frontend(args.frontend, payload / 'frontend', args.release_id)
    for path in (args.service / 'package').rglob('*'):
        if path.is_file():
            copy(path, 'service/package/' + path.relative_to(args.service / 'package').as_posix())
    copy(args.service / 'release-manifest.json', 'service/release-manifest.json')
    for name in BEFORE:
        copy(args.legacy / name, 'legacy/' + name)
    copy(ROOT / 'docs/verification/release-all-20261024/legacy-probe.py', 'legacy/legacy-probe.py')
    legacy = {'files': {name: {'beforeSha256': digest, 'sha256': sha(payload / 'legacy' / name)}
                        for name, digest in BEFORE.items()},
              'probe': {'path': 'legacy-probe.py', 'sha256': sha(payload / 'legacy/legacy-probe.py')}}
    (payload / 'legacy/manifest.json').write_text(json.dumps(legacy, indent=2) + '\n', encoding='utf-8')
    for name, source in (
        ('remote-release.py', ROOT / 'web/tools/deploy_all_features_20261024.py'),
        ('atomic_frontend_release.py', ROOT / 'web/tools/atomic_frontend_release.py'),
        ('activate_legacy_release.py', ROOT / 'web/tools/activate_legacy_release.py'),
        ('activate_service_release.py', args.service / 'activate_service_release.py'),
        ('activate_profile_service_live.py', args.service / 'activate_profile_service_live.py'),
        ('verify-live-scoring.mjs', ROOT / 'docs/verification/release-all-20261024/verify-live-scoring.mjs'),
    ):
        copy(source, name)
    manifest = json.loads((payload / 'frontend/release-manifest.json').read_text(encoding='utf-8'))
    service = json.loads((payload / 'service/release-manifest.json').read_text(encoding='utf-8'))
    engine = 'web/web前端/GameEngine.js'
    assert manifest['runtime_files']['GameEngine.js'] == service['candidate'][engine]
    assert sha(args.legacy / engine) == service['candidate'][engine], 'Legacy model probe engine differs'
    plan = {'schemaVersion': 1, 'release_id': args.release_id,
            'files': {path.relative_to(payload).as_posix(): sha(path)
                      for path in sorted(payload.rglob('*')) if path.is_file()},
            'rulesVersion': 'territory-v3', 'databaseReplacement': False,
            'successStatus': 'ACTIVATED_ALL_COMPONENTS_VERIFIED'}
    (payload / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    items = {path.relative_to(payload).as_posix(): base64.b64encode(path.read_bytes()).decode('ascii')
             for path in sorted(payload.rglob('*')) if path.is_file()}
    raw = json.dumps(items, separators=(',', ':')).encode('utf-8')
    compressed = base64.b64encode(zlib.compress(raw, level=9)).decode('ascii')
    pins = {path.relative_to(payload).as_posix(): sha(path)
            for path in sorted(payload.rglob('*')) if path.is_file()}
    template = (ROOT / 'web/tools/release_all_bootstrap_template.py').read_text(encoding='utf-8')
    bootstrap = template.replace('"__PAYLOAD__"', repr(compressed)).replace('"__PINS__"', repr(pins)).replace('"__RELEASE__"', repr(args.release_id))
    assert all(token not in bootstrap for token in ('__PAYLOAD__', '__PINS__', '__RELEASE__'))
    (output / 'remote-bootstrap.py').write_text(bootstrap, encoding='utf-8')
    receipt = {'release_id': args.release_id, 'status': 'FROZEN_NOT_DEPLOYED',
               'bootstrapSha256': sha(output / 'remote-bootstrap.py'),
               'planSha256': sha(payload / 'plan.json'), 'payloadFiles': len(pins),
               'engineSha256': service['candidate'][engine], 'credentialsIncluded': False,
               'frontendRebind': rebound}
    (output / 'preparation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
