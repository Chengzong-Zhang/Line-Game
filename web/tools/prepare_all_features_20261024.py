"""Freeze and pin the reviewed release components for one SSH transfer."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import zlib

ROOT = Path(__file__).resolve().parents[2]
RELEASE = 'web-all-features-20261024-r1'
BEFORE = {
    'web/web后端/server.py': 'e7858e42b9301fa5096576f887e149fa8a912d7126beb8efe0117ff0fb61fb6b',
    'web/tools/online_bot_bridge.mjs': '758a4657bbcdd0379760e298b818f8cf087d93fa096a5d87d84c361a3767fc1f',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend', required=True, type=Path)
    parser.add_argument('--service', required=True, type=Path)
    parser.add_argument('--legacy', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
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

    for name in ('frontend-overlay.zip', 'release-manifest.json'):
        copy(args.frontend / name, 'frontend/' + name)
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
    plan = {'schemaVersion': 1, 'release_id': RELEASE,
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
    bootstrap = template.replace('"__PAYLOAD__"', repr(compressed)).replace('"__PINS__"', repr(pins))
    assert '__PAYLOAD__' not in bootstrap and '__PINS__' not in bootstrap
    (output / 'remote-bootstrap.py').write_text(bootstrap, encoding='utf-8')
    receipt = {'release_id': RELEASE, 'status': 'FROZEN_NOT_DEPLOYED',
               'bootstrapSha256': sha(output / 'remote-bootstrap.py'),
               'planSha256': sha(payload / 'plan.json'), 'payloadFiles': len(pins),
               'engineSha256': service['candidate'][engine], 'credentialsIncluded': False}
    (output / 'preparation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
