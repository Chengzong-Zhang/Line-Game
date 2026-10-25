"""Rendered only after immutable component packages have passed verification."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import zlib

ENCODED = "__PAYLOAD__"
PINS = "__PINS__"
RELEASE = "__RELEASE__"
assert len(RELEASE) <= 100 and re.fullmatch(r'web-all-features-[0-9]{8}-r[1-9][0-9]*', RELEASE)
ARTIFACTS = Path('/home/ubuntu/line-game/.deploy-artifacts')
HERE = ARTIFACTS / RELEASE
assert ARTIFACTS.resolve(strict=True) == ARTIFACTS
assert not HERE.is_symlink()
print(json.dumps({'stage': 'AUTHENTICATED_PREFLIGHT', 'release_id': RELEASE}), flush=True)


def observe():
    last = None
    for _ in range(600):
        receipt = HERE / 'deployment.json'
        if receipt.exists():
            value = json.loads(receipt.read_text(encoding='utf-8'))
            if value.get('phase') != last:
                last = value.get('phase')
                print('Deployment phase: ' + str(last), flush=True)
            if value.get('status') != 'RUNNING':
                print(json.dumps(value, ensure_ascii=False), flush=True)
                return 0 if value['status'] == 'ACTIVATED_ALL_COMPONENTS_VERIFIED' else 2
        time.sleep(2)
    print(json.dumps({'release_id': RELEASE, 'status': 'WORKER_STILL_RUNNING_DO_NOT_REPLAY'}), flush=True)
    return 3


if HERE.exists():
    # The release name is single-use, even if a previous upload failed before
    # its first receipt. Inspect partial evidence instead of relaunching it.
    if (HERE / 'deployment.json').exists():
        raise SystemExit(observe())
    print(json.dumps({'release_id': RELEASE, 'status': 'EXISTING_ATTEMPT_NO_RECEIPT_INSPECT_FIRST'}), flush=True)
    raise SystemExit(4)
HERE.mkdir(mode=0o750)
assert HERE.resolve(strict=True) == HERE
with (HERE / 'upload.lock').open('x') as guard:
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    files = json.loads(zlib.decompress(base64.b64decode(ENCODED, validate=True)))
    assert set(files) == set(PINS)
    for name, content in files.items():
        path = PurePosixPath(name)
        assert name and str(path) == name and not path.is_absolute() and '..' not in path.parts and '\\' not in name
        data = base64.b64decode(content, validate=True)
        assert hashlib.sha256(data).hexdigest() == PINS[name]
        target = HERE / name
        target.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        assert target.parent.resolve() == target.parent
        with target.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    # The existing sudo authorization is used once to freeze the uploaded tree
    # and launch independently from the interactive SSH connection.
    harden = ("import os,pathlib,re,sys; p=pathlib.Path(sys.argv[1]); r=sys.argv[2]; "
              "assert len(r)<=100 and re.fullmatch(r'web-all-features-[0-9]{8}-r[1-9][0-9]*',r); "
              "assert p==pathlib.Path('/home/ubuntu/line-game/.deploy-artifacts')/r; "
              "assert p.resolve(strict=True)==p; "
              "assert all(not q.is_symlink() for q in [p,*p.rglob('*')]); "
              "[(os.chown(q,0,1000),os.chmod(q,0o750 if q.is_dir() else 0o640)) "
              "for q in [p,*p.rglob('*')]]")
    subprocess.run(['sudo', '-n', '/usr/bin/python3', '-c', harden, str(HERE), RELEASE], check=True)
    subprocess.run(['sudo', '-n', 'systemd-run', '--unit=lifeline-' + RELEASE[4:],
                    '--property=Type=exec', '--property=UMask=0077',
                    '--property=KillMode=control-group', '--property=TimeoutStopSec=240',
                    '--property=RuntimeMaxSec=20min', '--property=Restart=no',
                    '--collect', '/usr/bin/python3', '-B', str(HERE / 'remote-release.py'),
                    '--release-id', RELEASE], check=True)
raise SystemExit(observe())
