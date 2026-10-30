"""Freeze a hash-bound schema-6 WeChat service bundle from an inspected baseline.

This is a local packaging operation. It does not connect to, modify, or deploy
any server. Inputs must be generated from the current live service and audited.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
R6_MANIFEST_SHA256 = 'be66a221143f501ecb6b20869c333558d0c6279b96c89ba36a9ccdc9060d03d7'
R6_PREFIX = 'ranked-predecessor-r6'
spec = importlib.util.spec_from_file_location('schema6_primitives', ROOT / 'wechat/tools/activate_profile_service_live.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--predecessor-bundle', type=Path, required=True)
    parser.add_argument('--site', type=Path, help='Optional exact copy of the r6 site description')
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'wechat-service-all-[0-9]{8}-r[1-9][0-9]*', args.release_id):
        raise ValueError('Invalid release identity')
    predecessor = base.safe_path(args.predecessor_bundle.absolute())
    predecessor_manifest = predecessor / 'release-manifest.json'
    base.regular(predecessor_manifest)
    raw = predecessor_manifest.read_bytes()
    if hashlib.sha256(raw).hexdigest() != R6_MANIFEST_SHA256:
        raise ValueError('Unexpected predecessor manifest hash')
    r6 = json.loads(raw)
    baseline = r6.get('candidate')
    if (r6.get('schemaVersion') != 1 or r6.get('kind') != 'wechat-complete-runtime-release'
        or r6.get('releaseId') != 'wechat-service-all-20261029-r6'
        or not isinstance(baseline, dict) or len(baseline) != 266):
        raise ValueError('Unexpected predecessor manifest schema or inventory')
    if base.tree(predecessor / 'service') != baseline:
        raise ValueError('Predecessor complete runtime differs from manifest')
    site = r6.get('site')
    if not isinstance(site, dict):
        raise ValueError('Missing site in pinned predecessor manifest')
    if args.site and json.loads(args.site.read_text(encoding='utf-8-sig')) != site:
        raise ValueError('Site differs from pinned predecessor manifest')
    if (site.get('database', {}).get('path') != '/var/lib/lifeline-wechat/wechat.sqlite3'
        or site['database'].get('device') != 64514 or site['database'].get('inode') != 1053174):
        raise ValueError('Database identity differs from inspected r6 service')
    previous_metadata = baseline.get('service-manifest.json')
    expected_extras = {'service-manifest.json': previous_metadata} if previous_metadata is not None else {}
    if site.get('baselineExtras') != expected_extras:
        raise ValueError('Unexpected live service metadata; inspect drift')
    entries = set(baseline)
    entries.update(['web/web后端/board_validation.py', 'web/tools/online_bot_bridge.mjs',
                    'web/tools/online_bot_runtime.mjs', 'web/tools/generate_online_roots.mjs'])
    for prefix, suffixes in (
        ('web/web前端', {'.js', '.mjs'}),
        ('web/web前端/assets/research-ai', {'.json', '.f32', '.bin'}),
        ('wechat/minigame/src', {'.js', '.mjs'}),
        ('wechat/minigame/node_modules/@noble/hashes', {'.js', '.json', '.txt', '.md'}),
    ):
        directory = ROOT / prefix
        if not directory.is_dir():
            raise ValueError('Missing runtime directory: ' + prefix)
        for path in directory.rglob('*'):
            if 'tests' in path.relative_to(directory).parts or any(part.startswith('.') for part in path.relative_to(directory).parts):
                continue
            if path.is_symlink():
                raise ValueError('Runtime symlink not allowed')
            if path.is_file() and (path.suffix.lower() in suffixes or path.name == 'LICENSE'):
                entries.add(path.relative_to(ROOT).as_posix())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    service = output / 'service'
    candidate = {}
    for name in sorted(entries):
        if name == 'service-manifest.json':
            candidate[name] = baseline[name]
            continue
        parts = Path(name).parts
        if not parts or '..' in parts or Path(name).is_absolute() or '\\' in name or ':' in name:
            raise ValueError('Unsafe inventory path')
        src = base.safe_path(ROOT / name)
        base.regular(src)
        if not src.is_file() or src.is_symlink():
            raise ValueError('Missing regular runtime file: ' + name)
        dest = service / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        candidate[name] = digest(dest)
    # Prevent a mixed bundle if a shared checkout changed during the copy.
    for name, expected in candidate.items():
        if name == 'service-manifest.json':
            continue
        if digest(ROOT / name) != expected:
            raise ValueError('Runtime source changed during packaging: ' + name)
    # The predecessor is part of the candidate and bound to all 266 r6 files.
    nested = service / R6_PREFIX
    nested.mkdir()
    (nested / 'release-manifest.json').write_bytes(raw)
    shutil.copytree(predecessor / 'service', nested / 'service')
    if base.tree(nested / 'service') != baseline or base.tree(predecessor / 'service') != baseline:
        raise ValueError('Predecessor changed during copy')
    candidate[R6_PREFIX + '/release-manifest.json'] = R6_MANIFEST_SHA256
    candidate.update({R6_PREFIX + '/service/' + name: value for name, value in baseline.items()})
    if base.tree(service) != {name: value for name, value in candidate.items() if name != 'service-manifest.json'}:
        raise ValueError('Candidate runtime inventory differs from files')
    for source, name in [(ROOT/'web/tests/wechat_unified_release_probe.py','probe.py'),
                         (ROOT/'web/tests/wechat_unified_release_probe.py','rollback-probe.py'),
                         (ROOT/'wechat/tools/schema6_synthetic_rehearsal_r6.py','rehearsal.py')]:
        if not source.is_file():
            raise ValueError('Missing compatibility probe: ' + str(source))
        shutil.copyfile(source, output/name)
    manifest = {'schemaVersion':1, 'kind':'wechat-complete-runtime-release', 'releaseId':args.release_id,
                'baseline':baseline, 'candidate':candidate, 'site':site,
                'probeSha256':digest(output/'probe.py'), 'rollbackProbeSha256':digest(output/'rollback-probe.py'),
                'rehearsalSha256':digest(output/'rehearsal.py')}
    path = output / 'release-manifest.json'
    path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'releaseId':args.release_id,'runtimeFiles':len(candidate),'manifestSha256':digest(path)}))


if __name__ == '__main__':
    main()
