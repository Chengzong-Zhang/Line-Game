"""Capture audited, source-only desktop and itch host inputs for version control.

Only writes new working/platform-hosts/{desktop,itch} directories. Host commits
are recorded as origins, not presented as the current commit of a fresh clone.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
worktrees = Path('C:/Users/zcz/.codex/worktrees')
targets = {
    'desktop': {'source': worktrees / 'lifeline-steam-m1/line game',
                'commit': 'a90b23d045b345057809a7417340cdc5d1dfcad5',
                'paths': ['package.json', 'package-lock.json', 'desktop/assets', 'desktop/legal',
                          'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/package-metadata.json',
                          'desktop/scripts', 'desktop/src', 'desktop/steam', 'desktop/tests',
                          'web/web前端/ChallengeCampaign.js', 'web/web前端/GameFeedback.js',
                          'web/web前端/LocalProfile.js']},
    'itch': {'source': worktrees / 'lifeline-itch-release/line game',
             'commit': 'ce3c79ab4faf31f159fa8f66903638484b2f9ed6',
             'paths': ['itch/config', 'itch/tools', 'itch/tests', 'itch/package.json',
                       'itch/package-lock.json', 'itch/README.md']},
}

def sha(data): return hashlib.sha256(data).hexdigest()
def blob(data): return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

for name, config in targets.items():
    dest = root / 'working/platform-hosts' / name
    if dest.exists(): raise SystemExit(f'Refusing to replace existing snapshot: {dest}')
    source = config['source']
    raw = subprocess.check_output(['git', '-c', 'core.quotepath=false', 'ls-tree', '-rz', config['commit'], '--', *config['paths']], cwd=root)
    tracked = {}
    for record in raw.split(b'\0'):
        if record:
            metadata, filename = record.split(b'\t', 1)
            _mode, kind, oid = metadata.decode('ascii').split()
            if kind == 'blob': tracked[filename.decode('utf-8')] = oid
    for relative in config['paths']:
        src, target = source / relative, dest / relative
        if src.is_symlink(): raise RuntimeError(f'Linked source rejected: {src}')
        if src.is_dir():
            for item in src.rglob('*'):
                if item.is_symlink(): raise RuntimeError(f'Linked source rejected: {item}')
            shutil.copytree(src, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
    records = []
    for file in sorted(dest.rglob('*')):
        if not file.is_file(): continue
        relative = file.relative_to(dest).as_posix()
        if file.suffix.lower() in ('.key', '.pem', '.pfx', '.db', '.sqlite', '.log', '.zip', '.exe') or file.name.startswith('.env'):
            raise RuntimeError(f'Unexpected private/generated file: {relative}')
        data = file.read_bytes(); expected = tracked.get(relative)
        status = ('untracked' if expected is None else 'exact' if blob(data) == expected else
                  'lf-equivalent' if blob(data.replace(b'\r\n', b'\n')) == expected else 'modified')
        records.append({'path': relative, 'bytes': len(data), 'sha256': sha(data), 'git_status': status,
                        **({'origin_blob': expected} if expected else {})})
    missing = sorted(set(tracked) - {record['path'] for record in records})
    if missing: raise RuntimeError(f'Tracked host files missing: {missing}')
    manifest = {'schema': 'lifeline-platform-host-snapshot-v1', 'origin_commit': config['commit'],
                'origin_worktree_status': 'direct git status was denied; file-level object comparison below',
                'excluded': ['node_modules', 'dist', 'renderer', 'release', 'local artifacts', 'keys', 'models'],
                'files': records}
    (dest / 'HOST-SNAPSHOT.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    counts = {status: sum(item['git_status'] == status for item in records) for status in ('exact', 'lf-equivalent', 'modified', 'untracked')}
    print(name, len(records), counts)
