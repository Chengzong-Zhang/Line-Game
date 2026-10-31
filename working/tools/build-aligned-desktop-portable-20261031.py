"""Build a local Windows portable candidate from a verified isolated desktop.

Usage: python working/tools/build-aligned-desktop-portable-20261031.py DESKTOP_ROOT TOOLCHAIN_ROOT NEW_OUTPUT_NAME
TOOLCHAIN_ROOT must contain nsis/, resources/ and 7za.exe copied from the local
toolchain. No network, upload, signing credential or production deployment is
required. The portable executable still needs its own runtime acceptance.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 4:
    raise SystemExit(__doc__)
candidate = Path(sys.argv[1]).resolve()
toolchain = Path(sys.argv[2]).resolve()
name = sys.argv[3]
root = Path(__file__).resolve().parents[2]
allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
if not candidate.is_relative_to(allowed) or not toolchain.is_relative_to(allowed) or not name.replace('-', '').replace('_', '').isalnum():
    raise SystemExit('Inputs must be isolated candidates and the output name must be a simple directory name.')
out = candidate / 'desktop' / name
if out.exists():
    raise SystemExit('Output already exists; use a new candidate name.')
def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()
def tree_hash(directory):
    records = [(file.relative_to(directory).as_posix(), sha(file)) for file in sorted(directory.rglob('*')) if file.is_file()]
    return hashlib.sha256(json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
provenance_path = candidate / 'alignment-provenance.json'
provenance = json.loads(provenance_path.read_text(encoding='utf-8'))
baseline = candidate / 'desktop/release/win-unpacked/resources/app.asar'
if sha(baseline) != provenance['asar_sha256']:
    raise SystemExit('Directory candidate differs from its recorded asar.')
for file in (toolchain / 'nsis/Bin/makensis.exe', toolchain / '7za.exe', candidate / 'node_modules/electron/dist/electron.exe'):
    if not file.is_file():
        raise SystemExit(f'Missing local build tool: {file}')
if not (toolchain / 'resources/plugins').is_dir():
    raise SystemExit('Missing local NSIS resources.')
toolchain_hash = tree_hash(toolchain)
environment = {**os.environ, 'ELECTRON_BUILDER_NSIS_DIR': str(toolchain / 'nsis'),
               'ELECTRON_BUILDER_NSIS_RESOURCES_DIR': str(toolchain / 'resources'),
               'ELECTRON_BUILDER_7ZIP_PATH': str(toolchain / '7za.exe')}
subprocess.run([str(candidate / 'node_modules/.bin/electron-builder.cmd'), '--win', 'portable',
                '--config.electronDist=node_modules/electron/dist',
                f'--config.directories.output=desktop/{name}'], cwd=candidate, env=environment, check=True)
embedded = out / 'win-unpacked/resources/app.asar'
if sha(embedded) != provenance['asar_sha256'] or sha(baseline) != provenance['asar_sha256']:
    raise RuntimeError('Portable input asar differs from the verified directory candidate.')
if tree_hash(toolchain) != toolchain_hash:
    raise RuntimeError('Portable build toolchain changed during packaging.')
files = list(out.glob('*.exe'))
if len(files) != 1:
    raise RuntimeError('Expected exactly one portable executable.')
receipt = {'status': 'BUILT_LOCAL_RUNTIME_ACCEPTANCE_REQUIRED',
           'source_provenance_sha256': sha(provenance_path), 'embedded_asar_sha256': sha(embedded),
           'portable_exe': files[0].name, 'portable_exe_sha256': sha(files[0]),
           'toolchain_tree_sha256': toolchain_hash,
           'nsis_exe_sha256': sha(toolchain / 'nsis/Bin/makensis.exe'), 'sevenzip_sha256': sha(toolchain / '7za.exe')}
(out / 'alignment-portable-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))
