"""Verify an immutable source-only platform host snapshot."""
import hashlib
import json
from pathlib import Path


def validate_snapshot(root, expected_commit):
    root = Path(root)
    manifest_path = root / 'HOST-SNAPSHOT.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schema') != 'lifeline-platform-host-snapshot-v1' or manifest.get('origin_commit') != expected_commit:
        raise ValueError('Unexpected host snapshot identity.')
    records = manifest.get('files')
    if not isinstance(records, list) or len({item['path'] for item in records}) != len(records):
        raise ValueError('Host snapshot manifest contains invalid or duplicate paths.')
    expected = {item['path']: item for item in records}
    actual = set()
    for file in root.rglob('*'):
        if 'node_modules' in file.relative_to(root).parts: continue
        if file.is_symlink():
            raise ValueError(f'Linked snapshot entry: {file}')
        if not file.is_file(): continue
        relative = file.relative_to(root).as_posix()
        if relative == 'HOST-SNAPSHOT.json': continue
        actual.add(relative)
        record = expected.get(relative)
        if not record or len(file.read_bytes()) != record['bytes'] or hashlib.sha256(file.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError(f'Host snapshot mismatch or unclassified file: {relative}')
    if actual != set(expected):
        raise ValueError(f'Host snapshot missing files: {sorted(set(expected) - actual)}')
    return {'origin_commit': manifest['origin_commit'],
            'snapshot_manifest_sha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            'files': len(records), 'kind': 'verified_source_snapshot'}
