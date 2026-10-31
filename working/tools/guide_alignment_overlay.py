"""Verify and apply the reviewed guide-only overlay to an isolated candidate."""
import hashlib
import json
from pathlib import Path
import subprocess


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def apply_checked_patch(root, output, patch, files, metadata_path, allowed_prefix="web/web前端/"):
    if len({item['path'] for item in files}) != len(files):
        raise RuntimeError('Guide patch manifest has duplicate paths.')
    raw = subprocess.check_output(['git', 'apply', '--numstat', '-z', str(patch)], cwd=root)
    patch_paths = []
    for record in raw.split(b'\0'):
        if not record:
            continue
        parts = record.split(b'\t', 2)
        if len(parts) != 3 or not parts[2]:
            raise RuntimeError('Unsupported rename or malformed guide patch.')
        patch_paths.append(parts[2].decode('utf-8'))
    if len(patch_paths) != len(set(patch_paths)) or set(patch_paths) != {item['path'] for item in files}:
        raise RuntimeError('Guide patch paths do not exactly match the reviewed manifest.')
    normalized_paths = []
    for item in files:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts or not item['path'].startswith(allowed_prefix):
            raise RuntimeError(f'Guide patch touches an unapproved path: {relative}')
        source = output / relative
        expected = item['beforeSha256']
        if expected is not None and source.is_file() and sha256(source) != expected:
            raw = source.read_bytes()
            normalized = raw.replace(b'\r\n', b'\n')
            if raw != normalized and hashlib.sha256(normalized).hexdigest() == expected:
                source.write_bytes(normalized)
                normalized_paths.append(item['path'])
        if (expected is None and source.exists()) or (expected is not None and (not source.is_file() or sha256(source) != expected)):
            raise RuntimeError(f'Guide baseline mismatch: {relative}')
    command = ['git', 'apply', '--unsafe-paths', f'--directory={output}', str(patch)]
    subprocess.run(command[:2] + ['--check'] + command[2:], cwd=root, check=True)
    subprocess.run(command, cwd=root, check=True)
    for item in files:
        if sha256(output / item['path']) != item['afterSha256']:
            raise RuntimeError(f'Guide overlay result mismatch: {item["path"]}')
    return {'patch_sha256': sha256(patch), 'manifest_sha256': sha256(metadata_path),
            'files': files, 'line_endings_normalized': normalized_paths, 'verification': 'baseline and result SHA-256 matched'}


def apply_overlay(root, output, patch, reference):
    patch = Path(patch).resolve()
    metadata_path = patch.with_suffix('.json')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    if metadata['reference'] != reference or metadata['patchSha256'] != sha256(patch):
        raise RuntimeError('Guide patch identity or reference commit mismatch.')
    return apply_checked_patch(root, output, patch, metadata['files'], metadata_path)


def apply_turn_order_overlay(root, output, patch):
    patch = Path(patch).resolve()
    metadata_path = patch.with_name(patch.stem + '-hashes.json')
    if not metadata_path.is_file() and patch.stem.endswith('-overlay'):
        metadata_path = patch.with_name(patch.stem[:-len('-overlay')] + '-hashes.json')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    files = [{'path': name, 'beforeSha256': item['before_sha256'], 'afterSha256': item['after_sha256']}
             for name, item in metadata.items()]
    # Some reviewed overlays include a small build tool. Materialize only its
    # exact baseline Git blob when a channel candidate did not need that tool.
    for item in files:
        name = item['path']
        target = output / name
        if name.startswith('web/tools/') and not target.exists() and item['beforeSha256'] is not None:
            if '..' in Path(name).parts:
                raise RuntimeError('Invalid tool overlay path.')
            blob = subprocess.check_output(['git', 'show', f'51e5782d:{name}'], cwd=root)
            if hashlib.sha256(blob).hexdigest() != item['beforeSha256']:
                raise RuntimeError(f'Tool overlay baseline mismatch: {name}')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(blob)
    return apply_checked_patch(root, output, patch, files, metadata_path, ('web/web前端/', 'web/tools/'))


def apply_mini_overlay(root, output, patch):
    patch = Path(patch).resolve()
    metadata_path = patch.with_name(patch.stem + '-hashes.json')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    files = [{'path': name, 'beforeSha256': item['before_sha256'], 'afterSha256': item['after_sha256']}
             for name, item in metadata.items()]
    return apply_checked_patch(root, output, patch, files, metadata_path, 'wechat/minigame/')
