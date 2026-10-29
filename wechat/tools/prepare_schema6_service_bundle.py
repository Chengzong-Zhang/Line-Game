"""Freeze a hash-bound schema-6 WeChat service bundle from an inspected baseline.

This is a local packaging operation. It does not connect to, modify, or deploy
any server. Inputs must be generated from the current live service and audited.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-inventory', type=Path, required=True)
    parser.add_argument('--site', type=Path, required=True)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'wechat-service-all-[0-9]{8}-r[1-9][0-9]*', args.release_id):
        raise ValueError('Invalid release identity')
    baseline = json.loads(args.baseline_inventory.read_text(encoding='utf-8-sig'))
    site = json.loads(args.site.read_text(encoding='utf-8-sig'))
    if (baseline.get('web/web后端/wechat_online.py') != '2001d14accc6a0b40f4b36f686e75e48cbe3a5834f1087d290e3f18f9f1b8965'
        or baseline.get('web/web前端/GameEngine.js') != 'c23cd12d0ca01e794f1b044a90c271cb907ce288473861763a2366dcd10b99bb'
        or len(baseline) != 98):
        raise ValueError('Live baseline differs from inspected schema-6 inventory')
    if site.get('baselineExtras') != {}:
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
        parts = Path(name).parts
        if not parts or '..' in parts or Path(name).is_absolute() or '\\' in name or ':' in name:
            raise ValueError('Unsafe inventory path')
        src = ROOT / name
        if not src.is_file() or src.is_symlink():
            raise ValueError('Missing regular runtime file: ' + name)
        dest = service / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        candidate[name] = digest(dest)
    # Prevent a mixed bundle if a shared checkout changed during the copy.
    for name, expected in candidate.items():
        if digest(ROOT / name) != expected:
            raise ValueError('Runtime source changed during packaging: ' + name)
    for source, name in [(ROOT/'web/tests/wechat_unified_release_probe.py','probe.py'),
                         (ROOT/'web/tests/wechat_combined_release_probe.py','rollback-probe.py'),
                         (ROOT/'wechat/tools/schema6_rehearsal.py','rehearsal.py')]:
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
