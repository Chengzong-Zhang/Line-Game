"""Read-only capture of the existing collector code and non-secret release site.

Never exports database rows, process environments, credentials or unit contents.
Run on the server; keep its generated source snapshot outside Git.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import urllib.request


def capture(previous_manifest, output, helper):
    spec = importlib.util.spec_from_file_location('collector_capture_base', helper)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    previous = json.loads(previous_manifest.read_text())
    site = previous['site']
    assert site['unit'] == 'lifeline-training-contributions.service'
    live = base.safe_path(site['liveRoot'])
    assert str(live) == '/home/ubuntu/line-game/.deploy-artifacts/collector-v2-current-sync-20261023-r2/service'
    props = base.unit_properties(site['unit'])
    assert props['ActiveState'] == 'active' and props['SubState'] == 'running'
    process = base.process_identity(int(props['MainPID']))
    assert process['uid'] == 1000 and process['cwd'] == str(live / 'web/backend')
    site['properties'] = {name: props.get(name, '') for name in base.STATIC_PROPERTIES}
    site['unitFiles'] = {name: base.sha(base.safe_path(name).read_bytes()) for name in site['unitFiles']}
    database = base.regular(base.safe_path(site['database']['path']))
    site['database'].update(device=database.st_dev, inode=database.st_ino)
    files = base.tree(live)
    allowed = {'.js', '.mjs', '.json', '.f32', '.py'}
    assert all(Path(name).suffix in allowed and not any(part.startswith('.') for part in Path(name).parts) for name in files)
    assert sum((live / name).stat().st_size for name in files) < 50 * 1024 * 1024
    contents = {name: base64.b64encode((live / name).read_bytes()).decode('ascii') for name in files}
    assert base.tree(live) == files, 'Live source changed during capture'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    status = json.load(opener.open('http://127.0.0.1:8005/api/training/contributions/status', timeout=15))
    assert status['enabled'] is True and status['supported_versions'] == [1, 2, 3]
    result = {'site': site, 'files': files, 'contents': contents, 'supportedVersions': status['supported_versions']}
    with output.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False)
    return {'status': 'READ_ONLY_BASELINE_CAPTURED', 'files': len(files), 'supportedVersions': status['supported_versions'],
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'databaseRowsRead': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--helper', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(capture(args.previous_manifest, args.output, args.helper)))
