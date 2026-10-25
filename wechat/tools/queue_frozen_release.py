"""Transfer a pinned bootstrap through an already authenticated local relay.

Only new task artifact paths are written. Launch is a separate operation and
requires the remote assembly's exact SHA256 receipt. No password or SSH key is
read, and the existing relay connection is reused.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import zlib

ARTIFACTS = '/home/ubuntu/line-game/.deploy-artifacts/'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def release_id(value):
    if not re.fullmatch(r'web-all-features-[0-9]{8}-r[1-9][0-9]*', value):
        raise ValueError('INVALID_RELEASE_ID')
    return value


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_new(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def check_queue(folder):
    folder = Path(folder).resolve(strict=True)
    if read(folder / 'status.json').get('status') not in ('AUTHENTICATED', 'RUNNING_COMMAND'):
        raise ValueError('AUTHENTICATED_RELAY_REQUIRED')
    if not all((folder / part).is_dir() for part in ('requests', 'results')):
        raise ValueError('INVALID_RELAY_QUEUE')
    return folder


def request(ident, source, timeout=90):
    command = 'python3 -B -c ' + shlex.quote(source)
    if len(command.encode('utf-8')) >= 120000:
        raise ValueError('REMOTE_SHELL_ARGUMENT_TOO_LARGE')
    return {'id': ident, 'command': command, 'timeout': timeout}


def enqueue(folder, value):
    target = folder / 'requests' / (value['id'] + '.json')
    if target.exists() or target.with_suffix('.claimed').exists():
        raise ValueError('REQUEST_ALREADY_EXISTS_INSPECT_WITHOUT_REPLAY')
    pending = target.with_suffix('.pending')
    write_new(pending, value)
    pending.replace(target)


def transfer(bootstrap, expected, queue_folder, ident, state_path):
    ident = release_id(ident)
    content = Path(bootstrap).read_bytes()
    if digest(content) != expected:
        raise ValueError('BOOTSTRAP_HASH_CHANGED')
    queue_folder = check_queue(queue_folder)
    state_path = Path(state_path).resolve()
    if state_path.exists():
        raise ValueError('TRANSFER_STATE_ALREADY_EXISTS')
    compressed = zlib.compress(content, 9)
    chunks = [compressed[offset:offset + 80 * 1024]
              for offset in range(0, len(compressed), 80 * 1024)]
    remote = ARTIFACTS + ident + '-transport'
    values = [request(ident + '-000-init',
        "from pathlib import Path; import json; p=Path(" + repr(remote) + "); "
        "assert p.parent.resolve(strict=True)==Path(" + repr(ARTIFACTS.rstrip('/')) + "); "
        "p.mkdir(mode=0o700); (p/'parts').mkdir(mode=0o700); "
        "print(json.dumps({'status':'NEW_TRANSFER_CREATED'}))")]
    for index, chunk in enumerate(chunks):
        encoded = base64.b64encode(chunk).decode('ascii')
        source = ("import base64,hashlib,json,os; from pathlib import Path; "
                  "p=Path(" + repr(remote + '/parts/' + str(index).zfill(6)) + "); "
                  "d=base64.b64decode(" + repr(encoded) + ",validate=True); "
                  "assert hashlib.sha256(d).hexdigest()==" + repr(digest(chunk)) + "; "
                  "f=p.open('xb'); f.write(d); f.flush(); os.fsync(f.fileno()); f.close(); "
                  "print(json.dumps({'status':'PART_VERIFIED','index':" + str(index) + "}))")
        values.append(request(ident + '-100-part-' + str(index).zfill(6), source))
    assemble_id = ident + '-200-assemble'
    source = ("import hashlib,json,os,zlib; from pathlib import Path; "
              "p=Path(" + repr(remote) + "); "
              "d=b''.join((p/'parts'/str(i).zfill(6)).read_bytes() for i in range(" + str(len(chunks)) + ")); "
              "assert hashlib.sha256(d).hexdigest()==" + repr(digest(compressed)) + "; "
              "raw=zlib.decompress(d); assert hashlib.sha256(raw).hexdigest()==" + repr(expected) + "; "
              "f=(p/'remote-bootstrap.py').open('xb'); f.write(raw); f.flush(); os.fsync(f.fileno()); f.close(); "
              "print(json.dumps({'status':'BOOTSTRAP_VERIFIED','sha256':" + repr(expected) + "}))")
    values.append(request(assemble_id, source))
    # Fail before enqueueing anything if a previous partial queue is present.
    for value in values:
        path = queue_folder / 'requests' / (value['id'] + '.json')
        if path.exists() or path.with_suffix('.claimed').exists():
            raise ValueError('PREVIOUS_TRANSFER_REQUEST_EXISTS')
    state = {'releaseId': ident, 'status': 'TRANSFER_QUEUED_NOT_LAUNCHED',
             'queueFolder': str(queue_folder), 'bootstrapSha256': expected,
             'compressedSha256': digest(compressed), 'compressedBytes': len(compressed),
             'partCount': len(chunks), 'assembleId': assemble_id,
             'remoteBootstrap': remote + '/remote-bootstrap.py', 'credentialsCaptured': False}
    write_new(state_path, state)
    for value in values:
        enqueue(queue_folder, value)
    return state


def launch(state_path):
    state = read(state_path)
    ident = release_id(state['releaseId'])
    queue_folder = check_queue(state['queueFolder'])
    result = read(queue_folder / 'results' / (state['assembleId'] + '.json'))
    if result.get('exitCode') != 0 or result.get('truncated'):
        raise ValueError('REMOTE_ASSEMBLY_NOT_CONFIRMED')
    assembled = json.loads(result['stdout'])
    if assembled != {'status': 'BOOTSTRAP_VERIFIED', 'sha256': state['bootstrapSha256']}:
        raise ValueError('REMOTE_BOOTSTRAP_RECEIPT_MISMATCH')
    remote = ARTIFACTS + ident + '-transport/remote-bootstrap.py'
    if state['remoteBootstrap'] != remote:
        raise ValueError('REMOTE_BOOTSTRAP_PATH_CHANGED')
    value = {'id': ident + '-300-launch', 'command': 'python3 -B ' + shlex.quote(remote), 'timeout': 900}
    enqueue(queue_folder, value)
    return {'status': 'VERIFIED_BOOTSTRAP_LAUNCH_QUEUED', 'releaseId': ident, 'requestId': value['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('transfer', 'launch'))
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--bootstrap', type=Path)
    parser.add_argument('--bootstrap-sha256')
    parser.add_argument('--queue', type=Path)
    parser.add_argument('--release-id')
    args = parser.parse_args()
    if args.action == 'transfer':
        result = transfer(args.bootstrap, args.bootstrap_sha256, args.queue, args.release_id, args.state)
    else:
        result = launch(args.state)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
