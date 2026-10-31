"""Export a local, source-and-resource-only desktop tree for Mac follow-up.

Usage: python working/tools/export-desktop-macos-handoff-20261031.py CANDIDATE NEW.zip
CANDIDATE must be an already built alignment candidate with provenance. The
archive excludes dependencies and release binaries; model resources remain
because the desktop renderer needs them. No signing or publication occurs.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

if len(sys.argv) != 3:
    raise SystemExit(__doc__)
root = Path(__file__).resolve().parents[2]
allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
candidate, archive = (Path(value).resolve() for value in sys.argv[1:])
if not candidate.is_relative_to(allowed) or not archive.is_relative_to(allowed) or archive.exists():
    raise SystemExit('Candidate and a new output archive must be inside the local alignment artifacts.')
provenance_path = candidate / 'alignment-provenance.json'
if not provenance_path.is_file():
    raise SystemExit('Desktop candidate provenance is required.')
provenance = json.loads(provenance_path.read_text(encoding='utf-8'))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def tree_hash(directory):
    rows = [(f.relative_to(directory).as_posix(), f.stat().st_size, digest(f))
            for f in sorted(directory.rglob('*')) if f.is_file()]
    return {'files': len(rows), 'sha256': hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}

if tree_hash(candidate / 'web/web前端') != provenance['adapted_frontend_inventory']:
    raise SystemExit('Adapted desktop frontend differs from the build receipt.')
if digest(candidate / 'package.json') != provenance['adapted_package_sha256']:
    raise SystemExit('Desktop package configuration differs from the build receipt.')
if tree_hash(candidate / 'desktop/renderer') != provenance.get('adapted_renderer_inventory'):
    raise SystemExit('Desktop renderer differs from, or is not bound by, the build receipt.')
if digest(candidate / 'package-lock.json') != provenance.get('adapted_lock_sha256'):
    raise SystemExit('Desktop dependency lock differs from, or is not bound by, the build receipt.')
if digest(candidate / 'desktop/package-metadata.json') != provenance['adapted_desktop_metadata_sha256']:
    raise SystemExit('Desktop metadata differs from the build receipt.')
excluded = {'node_modules', 'release', 'local_artifacts', '.test-tmp', '__pycache__', '.git'}
forbidden_extensions = {'.exe', '.dll', '.node', '.pdb', '.dmg', '.msi', '.apk', '.hap'}
items = [candidate / 'package.json', candidate / 'package-lock.json']
for base in (candidate / 'web/web前端', candidate / 'desktop'):
    for path in base.rglob('*'):
        if any(part in excluded or part.startswith('portable-') for part in path.relative_to(candidate).parts):
            continue
        if path.is_symlink():
            raise SystemExit(f'Symbolic link requires manual review: {path}')
        if path.is_file():
            if path.suffix.lower() in forbidden_extensions:
                raise SystemExit(f'Unexpected executable or install artifact: {path}')
            items.append(path)
items.sort(key=lambda path: path.relative_to(candidate).as_posix())
rows = [{'path': f.relative_to(candidate).as_posix(), 'bytes': f.stat().st_size, 'sha256': digest(f)} for f in items]
manifest = {'schema': 'lifeline-desktop-macos-handoff-v1', 'candidate_provenance_sha256': digest(provenance_path),
            'platform_status': 'SOURCE_AND_RESOURCES_ONLY_NOT_BUILT_ON_MACOS', 'files': rows}
archive.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
    for path, item in zip(items, rows):
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise RuntimeError(f'Input changed during export: {path}')
        info = zipfile.ZipInfo(item['path'], (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        target.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
    info = zipfile.ZipInfo('MACOS-HANDOFF-MANIFEST.json', (2026, 1, 1, 0, 0, 0))
    target.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8') + b'\n')
receipt = {'status': manifest['platform_status'], 'archive': str(archive), 'sha256': digest(archive),
           'files': len(rows), 'candidate_provenance_sha256': manifest['candidate_provenance_sha256']}
archive.with_suffix(archive.suffix + '.receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False))
