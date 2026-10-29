"""Time synthetic replay validation only; never submit or write to an inbox."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time


def benchmark(node, validator, fixture, timeout):
    raw = fixture.read_bytes()
    payload = json.loads(raw)
    started = time.monotonic()
    result = {'fixtureSha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
        'actions': len(payload['replay']['actions']), 'rulesVersion': payload['replay']['rulesVersion'],
        'validatorSha256': hashlib.sha256(validator.read_bytes()).hexdigest(),
        'timeoutSeconds': timeout, 'productionInboxWritten': False}
    try:
        process = subprocess.run([node, str(validator)], input=raw,
            capture_output=True, timeout=timeout, check=False)
        result['status'] = 'PASS_VALIDATION_WITHIN_TIMEOUT' if process.returncode == 0 else 'VALIDATION_FAILED'
        result['exitCode'] = process.returncode
        if process.returncode == 0:
            verified = json.loads(process.stdout)
            result['protocolVersion'] = verified['protocol_version']
            result['engineSources'] = verified['engine_sources']
    except subprocess.TimeoutExpired:
        result['status'] = 'VALIDATION_TIMEOUT'
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--validator', required=True, type=Path)
    parser.add_argument('--fixture', required=True, type=Path)
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = benchmark(args.node, args.validator, args.fixture, args.timeout)
    with args.output.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps({key: result[key] for key in ['status', 'actions', 'elapsedSeconds']}))
