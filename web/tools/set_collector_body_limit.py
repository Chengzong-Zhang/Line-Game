"""Guarded, bounded Nginx adjustment for v4 replay bodies; no other routes change."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

CONFIG = Path('/etc/nginx/conf.d/lifeline.conf')
LOCATION = re.compile(rb'(location\s+/api/training/\s*\{)([^{}]*)(\})')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def propose(raw):
    matches = list(LOCATION.finditer(raw))
    if len(matches) != 1:
        raise ValueError('EXPECTED_ONE_COLLECTOR_LOCATION')
    match = matches[0]
    block = match.group(2)
    if block.count(b'client_max_body_size 512k;') != 1 or b'proxy_pass http://127.0.0.1:8005;' not in block:
        raise ValueError('COLLECTOR_BASELINE_CHANGED')
    return raw[:match.start(2)] + block.replace(b'client_max_body_size 512k;', b'client_max_body_size 2m;') + raw[match.end(2):]


def check():
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)


def replace(raw):
    info = CONFIG.stat()
    temporary = CONFIG.with_name('lifeline.conf.collector-limit-staged')
    with temporary.open('xb') as handle:
        handle.write(raw); handle.flush(); os.fsync(handle.fileno())
    os.chmod(temporary, info.st_mode & 0o777)
    os.chown(temporary, info.st_uid, info.st_gid)
    os.replace(temporary, CONFIG)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--expected-sha256')
    parser.add_argument('--receipt-dir', type=Path)
    args = parser.parse_args()
    before = CONFIG.read_bytes()
    after = propose(before)
    check()
    result = {'status': 'PLANNED_NO_CHANGE', 'beforeSha256': digest(before), 'afterSha256': digest(after),
              'route': '/api/training/', 'previousLimitBytes': 524288, 'limitBytes': 2097152}
    if args.execute:
        if os.geteuid() != 0 or args.expected_sha256 != digest(before):
            raise ValueError('ROOT_AND_EXACT_BASELINE_REQUIRED')
        directory = args.receipt_dir.resolve()
        directory.relative_to(Path('/home/ubuntu/line-game/.deploy-artifacts'))
        directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        backup = directory / 'nginx-before.conf'
        backup.write_bytes(before); os.chmod(backup, 0o600)
        (directory / 'planned.json').write_text(json.dumps(result, indent=2))
        try:
            replace(after); check()
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
            assert CONFIG.read_bytes() == after
            result['status'] = 'COLLECTOR_LIMIT_UPDATED_AND_NGINX_RELOADED'
        except BaseException:
            replace(before); check()
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
            result['status'] = 'FAILED_ORIGINAL_CONFIG_RESTORED'
            raise
        finally:
            (directory / 'receipt.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
