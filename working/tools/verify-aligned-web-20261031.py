"""Verify and extract a local Web archive without deploying it.

Usage: python working/tools/verify-aligned-web-20261031.py WEB_RELEASE_DIR NEW_PREVIEW_DIR
The preview directory must be new and inside alignment-20261031.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

if len(sys.argv) != 3: raise SystemExit(__doc__)
release, preview = (Path(value).resolve() for value in sys.argv[1:])
root = Path(__file__).resolve().parents[2]
allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
if not release.is_relative_to(allowed) or not preview.is_relative_to(allowed) or preview.exists():
    raise SystemExit('Release and new preview must be within the local candidate directory.')
archive = release / 'frontend-overlay.zip'
manifest = json.loads((release / 'release-manifest.json').read_text(encoding='utf-8'))
receipt = json.loads((release / 'bundle-receipt.json').read_text(encoding='utf-8'))
sha = lambda data: hashlib.sha256(data).hexdigest()
if sha(archive.read_bytes()) != receipt['archive_sha256'] or manifest['commit'] is not None:
    raise RuntimeError('Web archive identity or isolated-source identity is invalid.')
files = manifest['files']
if not manifest.get('immutable_worker_dependencies') or not manifest.get('frozen_worker_snapshot'):
    raise RuntimeError('Frozen Worker closure is missing.')
with zipfile.ZipFile(archive) as bundle:
    names = bundle.namelist()
    if len(names) != len(set(names)) or set(names) != set(files) | {'release-manifest.json'}:
        raise RuntimeError('Archive file inventory differs from its manifest.')
    for name in names:
        pure = PurePosixPath(name)
        if pure.is_absolute() or '..' in pure.parts or '\\' in name:
            raise RuntimeError(f'Unsafe archive path: {name}')
        data = bundle.read(name)
        if name != 'release-manifest.json' and sha(data) != files[name]:
            raise RuntimeError(f'Web archive hash mismatch: {name}')
        if name == 'release-manifest.json' and data != (release / name).read_bytes():
            raise RuntimeError('Embedded manifest differs from the verified manifest.')
    preview.mkdir(parents=True)
    bundle.extractall(preview)
print(json.dumps({'status': 'PASS_LOCAL_WEB_ARCHIVE', 'files': len(files),
                  'archive_sha256': receipt['archive_sha256'], 'preview': str(preview),
                  'public_or_server_verification': 'NOT_RUN'}))
