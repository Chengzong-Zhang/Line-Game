"""Plan or guardedly install exact legacy Worker URL routing; no API changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

CONFIG = Path('/etc/nginx/conf.d/lifeline.conf')
LIVE = Path('/home/ubuntu/line-game/web/web前端')
ARTIFACTS = Path('/home/ubuntu/line-game/.deploy-artifacts')
PLAN_HASH = 'ef174067a1b8c30cef1f698ab34dda62e6e56c5ddd05b79b953fa435ae2dc0b7'
PREDECESSOR_HASH = '376e599578f59e2dc96b625749f694173a596e2621969a03076f5425ed5579f5'
PREFIX = 'frozen-workers/web-topology-fix-20261030-r2/'
TOKENS = ['20261029-unified-r1', '20261030-topology-fix-r2']
ROOT_MARKER = b'    location / {\n        proxy_pass http://127.0.0.1:8000;'
DIGEST = re.compile(r'^[0-9a-f]{64}$')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json_checked(path, expected):
    raw = path.read_bytes()
    if not DIGEST.fullmatch(expected or '') or sha(raw) != expected:
        raise ValueError('INPUT_HASH_MISMATCH')
    return json.loads(raw)


def safe_file(root, name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9._/-]+', name):
        raise ValueError('INVALID_PATH')
    if name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')):
        raise ValueError('INVALID_PATH')
    target = root / name
    if target.resolve(strict=True) != target or not target.is_file():
        raise ValueError('SYMLINK_OR_MISSING_FILE')
    return target


def validate(plan, candidate, frontend):
    if (plan.get('schema') != 'lifeline-legacy-worker-root-routing-plan-v1'
        or plan.get('predecessor_manifest_sha256') != PREDECESSOR_HASH
        or plan.get('match_query_v') != TOKENS or plan.get('rewrite_prefix') != '/' + PREFIX):
        raise ValueError('INVALID_PLAN_CONTRACT')
    files = plan.get('root_module_sha256'); assets = plan.get('asset_sha256')
    if not isinstance(files, dict) or len(files) != 54 or not isinstance(assets, dict) or len(assets) != 29:
        raise ValueError('INVALID_PLAN_INVENTORY')
    if candidate.get('predecessor_manifest_sha256') != PREDECESSOR_HASH or candidate.get('frozen_worker_snapshot') != 'web-topology-fix-20261030-r2':
        raise ValueError('CANDIDATE_SNAPSHOT_MISMATCH')
    if candidate.get('asset_version') in TOKENS:
        raise ValueError('CANDIDATE_TOKEN_COLLIDES')
    candidate_files = candidate.get('files', {})
    pred = safe_file(frontend, PREFIX + 'predecessor-release-manifest.json').read_bytes()
    if sha(pred) != PREDECESSOR_HASH:
        raise ValueError('SNAPSHOT_PREDECESSOR_DRIFT')
    predecessor = json.loads(pred)
    if files != predecessor.get('immutable_worker_dependencies'):
        raise ValueError('WORKER_CLOSURE_DRIFT')
    if assets != {n:d for n,d in predecessor['files'].items() if n.startswith('assets/research-ai/')}:
        raise ValueError('WORKER_ASSET_INVENTORY_DRIFT')
    for name, old in files.items():
        if not re.fullmatch(r'[A-Za-z0-9._-]+\.(?:js|mjs)', name):
            raise ValueError('INVALID_MODULE_PATH')
        for path, expected in ((name, candidate_files.get(name)), (PREFIX + name, old)):
            if candidate_files.get(path) != expected or not DIGEST.fullmatch(expected or '') or sha(safe_file(frontend, path).read_bytes()) != expected:
                raise ValueError('CANDIDATE_MODULE_DRIFT: ' + path)
    for name, old in assets.items():
        if not name.startswith('assets/research-ai/'):
            raise ValueError('INVALID_ASSET_PATH')
        for path in (name, PREFIX + name):
            if candidate_files.get(path) != old or sha(safe_file(frontend, path).read_bytes()) != old:
                raise ValueError('CANDIDATE_ASSET_DRIFT: ' + path)
    return files, assets


def propose(raw, plan):
    if raw.count(ROOT_MARKER) != 1 or b'$lifeline_legacy_worker_target' in raw or not raw.startswith(b'server {'):
        raise ValueError('UNEXPECTED_NGINX_STRUCTURE')
    entries = []
    for name in sorted(plan['root_module_sha256']):
        for token in TOKENS:
            entries.append(f'    "/{name}|{token}" "/{PREFIX}{name}";')
    mapping = ('# Frozen Worker compatibility: exact root path and exact v only.\n'
               'map_hash_bucket_size 256;\n'
               'map "$uri|$arg_v" $lifeline_legacy_worker_target {\n'
               '    volatile;\n    default "";\n' + '\n'.join(entries) + '\n}\n\n').encode()
    injection = (b'    location / {\n'
                 b'        if ($lifeline_legacy_worker_target != "") {\n'
                 b'            rewrite ^ $lifeline_legacy_worker_target last;\n'
                 b'        }\n        proxy_pass http://127.0.0.1:8000;')
    return mapping + raw.replace(ROOT_MARKER, injection, 1)


def replace(path, raw):
    stat = path.stat()
    temp = path.with_name(path.name + '.worker-map-staged')
    with temp.open('xb') as handle:
        handle.write(raw); handle.flush(); os.fsync(handle.fileno())
    try:
        os.chmod(temp, stat.st_mode & 0o777); os.chown(temp, stat.st_uid, stat.st_gid)
        os.replace(temp, path)
    finally:
        if temp.exists(): temp.unlink()


def run(command):
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def install_config(config, before, after, result, verify_live):
    installed = False
    try:
        if config.read_bytes() != before:
            raise ValueError('NGINX_BASELINE_DRIFT')
        replace(config, after); installed = True
        run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
        if config.read_bytes() != after: raise ValueError('POST_RELOAD_CONFIG_DRIFT')
        verify_live()
        result['status'] = 'WORKER_ROUTING_UPDATED_AND_NGINX_RELOADED'
    except BaseException:
        current = config.read_bytes()
        if not installed and current == before:
            result['status'] = 'FAILED_BEFORE_CONFIG_REPLACED'
            raise
        result['status'] = 'FAILED_RESTORE_ATTEMPTED'
        try:
            if current != after or config.read_bytes() != after: raise RuntimeError('REFUSE_OVERWRITE_CONCURRENT_CONFIG')
            replace(config, before); run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
            result['status'] = 'FAILED_ORIGINAL_CONFIG_RESTORED'
        except BaseException as restore_error:
            result['restoreError'] = type(restore_error).__name__ + ': ' + str(restore_error)
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--execute', action='store_true')
    p.add_argument('--config', type=Path, default=CONFIG)
    p.add_argument('--frontend', type=Path, default=LIVE)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--plan-sha256', required=True)
    p.add_argument('--candidate-manifest', type=Path, required=True)
    p.add_argument('--candidate-sha256', required=True)
    p.add_argument('--expected-before-sha256', required=True)
    p.add_argument('--receipt-dir', type=Path)
    p.add_argument('--output-config', type=Path)
    args = p.parse_args()
    if args.plan_sha256 != PLAN_HASH: raise ValueError('UNRECOGNIZED_PLAN_HASH')
    plan = read_json_checked(args.plan, args.plan_sha256)
    candidate = read_json_checked(args.candidate_manifest, args.candidate_sha256)
    frontend = args.frontend.resolve(strict=True)
    validate(plan, candidate, frontend)
    before = args.config.read_bytes()
    if sha(before) != args.expected_before_sha256: raise ValueError('NGINX_BASELINE_DRIFT')
    after = propose(before, plan)
    result = {'status':'PLANNED_NO_CHANGE', 'beforeSha256':sha(before), 'afterSha256':sha(after),
              'candidateManifestSha256':args.candidate_sha256, 'planSha256':args.plan_sha256,
              'modules':54, 'oldTokens':TOKENS, 'rootAssets':29}
    if args.output_config:
        with args.output_config.open('xb') as handle: handle.write(after)
    if args.execute:
        import fcntl
        if os.geteuid() != 0 or args.config != CONFIG or frontend != LIVE or args.receipt_dir is None:
            raise ValueError('ROOT_AND_EXACT_PRODUCTION_PATHS_REQUIRED')
        if args.candidate_manifest.resolve(strict=True) != (LIVE / 'release-manifest.json'):
            raise ValueError('LIVE_CANDIDATE_MANIFEST_REQUIRED')
        parent = ARTIFACTS.resolve(strict=True); directory = args.receipt_dir
        if directory.parent.resolve(strict=True) != parent or not re.fullmatch(r'[a-z0-9][a-z0-9-]{3,100}', directory.name):
            raise ValueError('INVALID_RECEIPT_DIRECTORY')
        with (parent / 'nginx-worker-route.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if CONFIG.read_bytes() != before: raise ValueError('NGINX_BASELINE_DRIFT')
            validate(plan, read_json_checked(args.candidate_manifest, args.candidate_sha256), frontend)
            run(['nginx', '-t'])
            directory.mkdir(mode=0o700, exist_ok=False)
            backup = directory / 'nginx-before.conf'
            with backup.open('xb') as handle:
                handle.write(before); handle.flush(); os.fsync(handle.fileno())
            os.chmod(backup, 0o600)
            (directory / 'planned.json').write_text(json.dumps(result, indent=2))
            try:
                install_config(CONFIG, before, after, result, lambda: validate(
                    plan, read_json_checked(args.candidate_manifest, args.candidate_sha256), frontend))
            finally:
                (directory / 'receipt.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__': main()
