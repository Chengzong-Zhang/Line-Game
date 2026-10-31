"""Audit new reachable Git blobs without printing credentials or modifying Git."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    def git(*command):
        return subprocess.check_output(['git', *command], cwd=root)
    records = git('rev-list', '--objects', f'{args.base}..{args.head}').splitlines()
    names = {}
    for record in records:
        oid, _, name = record.partition(b' ')
        names.setdefault(oid.decode(), name.decode('utf-8', errors='replace'))
    checks = b'' if not names else subprocess.check_output(
        ['git', 'cat-file', '--batch-check'], input=('\n'.join(names)+'\n').encode(), cwd=root)
    blobs = []
    for row in checks.splitlines():
        oid, kind, size = row.decode().split()
        if kind == 'blob': blobs.append((oid, int(size)))
    credential_patterns = [
        re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
        re.compile(rb'github_pat_[A-Za-z0-9_]{70,}'),
        re.compile(rb'gh[pousr]_[A-Za-z0-9]{36,}'),
        re.compile(rb'AKIA[0-9A-Z]{16}'),
    ]
    forbidden = re.compile(r'(?:^|/)(?:node_modules|__pycache__|\.pytest_cache)(?:/|$)|\.(?:apk|hap|ipa|exe|zip|7z|mp4|sqlite3?|db|p12|pfx|jks|key|pem)$|(?:^|/)\.env(?:$|\.(?!example$|sample$|template$))',re.I)
    issues = []
    process = subprocess.Popen(['git','cat-file','--batch'], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    total = 0
    try:
        for oid, size in blobs:
            process.stdin.write((oid+'\n').encode()); process.stdin.flush()
            header = process.stdout.readline().decode().strip().split()
            if header != [oid,'blob',str(size)]: raise RuntimeError('Unexpected Git object response')
            data = process.stdout.read(size)
            if len(data) != size or process.stdout.read(1) != b'\n': raise RuntimeError('Truncated Git object response')
            total += size
            reasons = []
            if size > 2_000_000: reasons.append('blob_over_2MB_review_required')
            if forbidden.search(names[oid]): reasons.append('artifact_or_sensitive_filename_review_required')
            if any(pattern.search(data) for pattern in credential_patterns): reasons.append('credential_pattern_review_required')
            if reasons: issues.append({'object':oid,'path':names[oid],'bytes':size,'reasons':reasons})
    finally:
        process.stdin.close()
        if process.wait() != 0: raise RuntimeError('Git object audit failed')
    receipt = {'base':git('rev-parse',args.base).decode().strip(),'head':git('rev-parse',args.head).decode().strip(),
               'scope':'new reachable blobs compared with the existing remote default branch; exact token/private-key and artifact-path checks only, not a security proof',
               'blobs':len(blobs),'bytes':total,'issues':issues,'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'blobs':len(blobs),'bytes':total,'issues':len(issues),'head':receipt['head']}))
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
