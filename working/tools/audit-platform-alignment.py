"""Read-only comparison of a frontend snapshot with a selected Git commit.

Usage: python working/tools/audit-platform-alignment.py SNAPSHOT [COMMIT]
Reports Git blob identities and physical SHA-256 digests; never changes input.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
snapshot = Path(sys.argv[1]).resolve()
commit = sys.argv[2] if len(sys.argv) > 2 else '51e5782d'
prefix = 'web/web前端/'
raw = subprocess.check_output(
    ['git', '-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', commit, '--', 'web/web前端'],
    cwd=ROOT,
)
counts = {'matched_bytes': 0, 'matched_lf_normalized': 0, 'different': 0, 'missing': 0}
changes = []
tracked = set()
for entry in raw.split(b'\0'):
    if not entry:
        continue
    metadata, name = entry.split(b'\t', 1)
    mode, kind, expected = metadata.decode('ascii').split(' ')
    if kind != 'blob':
        continue
    relative = name.decode('utf-8')[len(prefix):]
    tracked.add(relative)
    file = snapshot / relative
    if not file.is_file():
        counts['missing'] += 1
        changes.append({'path': relative, 'status': 'missing', 'git_blob': expected})
        continue
    data = file.read_bytes()
    def blob_sha(content):
        return hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
    if blob_sha(data) == expected:
        counts['matched_bytes'] += 1
    elif blob_sha(data.replace(b'\r\n', b'\n')) == expected:
        counts['matched_lf_normalized'] += 1
    else:
        counts['different'] += 1
        changes.append({'path': relative, 'status': 'different', 'git_blob': expected,
                        'sha256': hashlib.sha256(data).hexdigest()})
extra = []
for file in sorted(snapshot.rglob('*')):
    if file.is_file():
        relative = file.relative_to(snapshot).as_posix()
        if relative not in tracked:
            data = file.read_bytes()
            extra.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
print(json.dumps({'commit': commit, 'snapshot': str(snapshot), 'counts': counts, 'changes': changes, 'extra': extra},
                 ensure_ascii=False, indent=2))
