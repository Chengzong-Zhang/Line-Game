"""Download the versioned public browser assets, validating every SHA-256.

Run after cloning. Existing matching files are reused; mismatches stop without
overwriting. Training checkpoints and credentials are never downloaded.
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

RELEASE = 'web-ai-transfer-v1-20261013'
ROOT = Path(__file__).resolve().parent / 'web前端/assets/research-ai'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', default=RELEASE)
    args = parser.parse_args()
    count = 0
    for name in ('manifest.json', 'transfer-v1/manifest.json', 'model-free-manifest.json'):
        manifest = json.loads((ROOT / name).read_text(encoding='utf-8'))
        for spec in manifest['models']:
            path = (ROOT / spec['asset']).resolve()
            path.relative_to(ROOT.resolve())
            expected = spec['asset_sha256']
            if path.exists():
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                    raise RuntimeError(f'existing asset hash mismatch: {path.name}')
            else:
                url = f'https://github.com/Chengzong-Zhang/Line-Game/releases/download/{quote(args.release, safe="")}/{quote(path.name)}'
                with urlopen(url, timeout=60) as response:
                    raw = response.read()
                if hashlib.sha256(raw).hexdigest() != expected:
                    raise RuntimeError(f'downloaded asset hash mismatch: {path.name}')
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open('xb') as handle:
                    handle.write(raw)
            count += 1
    print(json.dumps({'status': 'PASS', 'assets': count, 'release': args.release}))

if __name__ == '__main__':
    main()
