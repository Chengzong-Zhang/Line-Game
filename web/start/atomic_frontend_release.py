"""Linux-only atomic frontend overlays, preserving the complete live rollback.

Prepare is read-only for the live directory. Activate / rollback use one
renameat2(RENAME_EXCHANGE), requiring unchanged hash-bound source trees.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
import zipfile

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def tree(path):
    h = hashlib.sha256()
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise RuntimeError(f'symlink not supported: {file}')
        if file.is_file():
            label = file.relative_to(path).as_posix().encode()
            h.update(len(label).to_bytes(8, 'big')); h.update(label)
            h.update(bytes.fromhex(sha(file)))
    return h.hexdigest()

def write_new(path, body):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(body, handle, ensure_ascii=False, indent=2); handle.write('\n')

def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.renameat2(-100, str(left).encode(), -100, str(right).encode(), 2)
    if result:
        raise OSError(ctypes.get_errno(), 'atomic directory exchange failed')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'activate', 'rollback'])
    parser.add_argument('--root', type=Path, default=Path('/home/ubuntu/line-game'))
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--archive-sha256')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{3,100}', args.release_id):
        raise ValueError('invalid release identity')
    root = args.root.resolve(strict=True)
    live = root / 'web/web前端'
    if live.resolve(strict=True) != live or not live.is_dir():
        raise RuntimeError('live frontend must be a real directory under root')
    artifacts = root / '.deploy-artifacts'; artifacts.mkdir(exist_ok=True)
    candidate = artifacts / f'{args.release_id}.candidate'
    rollback = artifacts / f'{args.release_id}.rollback-web前端'
    prepare_receipt = artifacts / f'{args.release_id}.prepare.json'
    activation_receipt = artifacts / f'{args.release_id}.activation.json'
    with (artifacts / 'frontend-release.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == 'prepare':
            archive = args.archive.resolve(strict=True)
            archive.relative_to(artifacts.resolve())
            if sha(archive) != args.archive_sha256:
                raise RuntimeError('archive SHA-256 mismatch')
            before = tree(live)
            if candidate.exists() or rollback.exists() or prepare_receipt.exists():
                raise RuntimeError('release identity already exists')
            shutil.copytree(live, candidate)
            if tree(live) != before or tree(candidate) != before:
                raise RuntimeError('live directory changed during snapshot')
            with zipfile.ZipFile(archive) as bundle:
                manifest = json.loads(bundle.read('release-manifest.json'))
                if manifest['release_id'] != args.release_id:
                    raise RuntimeError('bundle identity mismatch')
                if set(bundle.namelist()) != set(manifest['files']) | {'release-manifest.json'}:
                    raise RuntimeError('bundle inventory mismatch')
                for name, expected in manifest['files'].items():
                    destination = candidate / name
                    destination.resolve().relative_to(candidate.resolve())
                    if Path(name).is_absolute() or '..' in Path(name).parts:
                        raise RuntimeError('archive path escape')
                    raw = bundle.read(name)
                    if hashlib.sha256(raw).hexdigest() != expected:
                        raise RuntimeError(f'bundle file hash mismatch: {name}')
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(raw)
                (candidate / 'release-manifest.json').write_bytes(bundle.read('release-manifest.json'))
            write_new(prepare_receipt, {'status': 'PREPARED_NOT_ACTIVE', 'release_id': args.release_id,
                'commit': manifest['commit'], 'overlay_files': len(manifest['files']), 'archive_sha256': args.archive_sha256,
                'live_tree_sha256': before, 'candidate_tree_sha256': tree(candidate), 'time_utc_epoch': time.time()})
            print('PREPARED_NOT_ACTIVE')
        elif args.command == 'activate':
            receipt = json.loads(prepare_receipt.read_text())
            if activation_receipt.exists() or rollback.exists():
                raise RuntimeError('already activated')
            if tree(live) != receipt['live_tree_sha256'] or tree(candidate) != receipt['candidate_tree_sha256']:
                raise RuntimeError('live/candidate tree changed since preflight')
            exchange(live, candidate)
            candidate.rename(rollback)
            write_new(activation_receipt, {**receipt, 'status': 'ATOMIC_SWITCH_OK', 'rollback': str(rollback),
                'active_tree_sha256': tree(live), 'rollback_tree_sha256': tree(rollback), 'time_utc_epoch': time.time()})
            print('ATOMIC_SWITCH_OK')
        else:
            receipt = json.loads(activation_receipt.read_text())
            if tree(live) != receipt['active_tree_sha256'] or tree(rollback) != receipt['rollback_tree_sha256']:
                raise RuntimeError('active/rollback tree changed; refusing rollback')
            exchange(live, rollback)
            write_new(artifacts / f'{args.release_id}.rollback.json', {'status': 'ROLLED_BACK', 'time_utc_epoch': time.time()})
            print('ROLLED_BACK')

if __name__ == '__main__':
    main()
