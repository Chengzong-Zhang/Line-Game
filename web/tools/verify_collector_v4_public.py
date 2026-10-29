"""Check public v4 capabilities and proxy limits without submitting any replay."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request


def verify(origin):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(origin + '/api/training/contributions/status', timeout=20) as response:
        capability = json.load(response)
    assert capability['enabled'] is True
    assert capability['supported_versions'] == [1, 2, 3, 4]
    assert capability['consent_policies']['4'] == 'anonymous-replay-training-v4'
    assert capability['max_request_bytes_by_version']['4'] == 2 * 1024 * 1024
    assert capability['supported_rules_versions']['4'] == ['territory-v3', 'surface-v1']
    results = []
    # text/plain is rejected before parsing a body or accepting a contribution.
    # The first crosses the former 512 KiB proxy limit; the second crosses 2 MiB.
    for size, expected in [(600 * 1024, 415), (2 * 1024 * 1024 + 1, 413)]:
        request = urllib.request.Request(origin + '/api/training/contributions',
            data=b'x' * size, headers={'Content-Type': 'text/plain'}, method='POST')
        try:
            with opener.open(request, timeout=20) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        assert status == expected, (size, status, expected)
        results.append({'bytes': size, 'contentType': 'text/plain', 'status': status})
    return {'status': 'PASS_PUBLIC_V4_CAPABILITY_AND_PROXY_LIMIT', 'origin': origin,
        'capability': capability, 'rejectionProbes': results, 'replaysSubmitted': 0,
        'scope': 'HTTPS API capability and invalid-content rejection; no device verification'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='https://lifelinegame.cn')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    report = verify(args.origin.rstrip('/'))
    report['verifierSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with args.output.open('x', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps({'status': report['status'], 'replaysSubmitted': 0}))
