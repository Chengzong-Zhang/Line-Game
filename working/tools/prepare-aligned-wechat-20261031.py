"""Rebuild a local Web/Mini candidate from Git objects and verified overlays.

Usage: python working/tools/prepare-aligned-wechat-20261031.py FRONTEND MINI_NODE_MODULES NEW_OUTPUT GUIDE_PATCH TURN_ORDER_PATCH MINI_PATCH [EXTRA_WEB_PATCH ...]
Inputs are read-only. The output must be new inside alignment-20261031. The
online candidate is local only; this script never uploads or changes services.
Run with permission for loopback-only synthetic tests when the environment
requires it. A model manifest and all referenced weights are required.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from guide_alignment_overlay import apply_overlay, apply_turn_order_overlay, apply_mini_overlay

if len(sys.argv) < 7: raise SystemExit(__doc__)
frontend, dependencies, output, guide, order, mini_patch = (Path(x).resolve() for x in sys.argv[1:7])
extra_web_patches = [Path(value).resolve() for value in sys.argv[7:]]
root = Path(__file__).resolve().parents[2]
allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
if not output.is_relative_to(allowed) or output.exists():
    raise SystemExit('Output must be a new local alignment candidate.')
if not (frontend / 'OnlineApp.js').is_file() or not (dependencies / 'esbuild').is_dir():
    raise SystemExit('Missing Web input or pinned Mini dependencies.')
commit = subprocess.check_output(['git', 'rev-parse', '51e5782d^{commit}'], cwd=root, text=True).strip()
audit = json.loads(subprocess.check_output([sys.executable, str(root / 'working/tools/audit-platform-alignment.py'),
    str(frontend), commit], cwd=root, env={**os.environ, 'PYTHONUTF8':'1'}, encoding='utf-8'))
if audit['counts']['missing'] or audit['counts']['different']: raise SystemExit('Web input differs from the selected baseline.')
for item in audit['extra']:
    name = item['path']
    if not (name.startswith('assets/research-ai/') or name.startswith('frozen-workers/web-topology-fix-20261030-r2/assets/research-ai/')) or not name.endswith(('.json', '.f32')):
        raise SystemExit(f'Unclassified Web input: {name}')
def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()
def tree_hash(directory):
    rows = [(f.relative_to(directory).as_posix(), f.stat().st_size, digest(f)) for f in sorted(directory.rglob('*')) if f.is_file()]
    return {'files': len(rows), 'sha256': hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}
inputs = {'reference_commit': commit, 'reference_audit': audit, 'frontend_inventory': tree_hash(frontend),
          'dependencies_inventory': tree_hash(dependencies), 'builder_script_sha256': digest(Path(__file__)),
          'overlay_verifier_sha256': digest(root / 'working/tools/guide_alignment_overlay.py')}
output.mkdir(parents=True)
shutil.copytree(frontend, output / 'web/web前端')

# Restore only tracked source and test fixtures as Git blob bytes.  Avoid tar's
# Windows code-page conversion and never copy node_modules, local databases or
# generated deployment folders from the original checkout.
paths = ['web/package.json', 'web/tools', 'web/web后端', 'wechat/minigame', 'wechat/ci/transfer.mjs',
         'wechat/device-bench/project.config.json', 'wechat/tools/wechat_service_asgi_draft.py',
         'wechat/tools/check_service_config.py', 'wechat/tools/maintain_store.py',
         'working/docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json']
raw = subprocess.check_output(['git', '-c', 'core.quotepath=false', 'ls-tree', '-rz', commit, '--', *paths], cwd=root)
entries = []
for row in raw.split(b'\0'):
    if not row: continue
    metadata, name = row.split(b'\t', 1); mode, kind, oid = metadata.decode('ascii').split()
    if kind == 'blob': entries.append((name.decode('utf-8'), oid))
process = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
try:
    for name, oid in entries:
        process.stdin.write((oid + '\n').encode()); process.stdin.flush()
        header = process.stdout.readline().decode('ascii').strip().split()
        if len(header) != 3 or header[0] != oid or header[1] != 'blob': raise RuntimeError(f'Cannot restore Git blob: {name}')
        size = int(header[2]); data = process.stdout.read(size)
        if len(data) != size or process.stdout.read(1) != b'\n': raise RuntimeError(f'Truncated Git blob: {name}')
        target = output / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
finally:
    process.stdin.close()
    if process.wait() != 0: raise RuntimeError('Git object export failed.')
inputs['exported_git_blobs'] = len(entries)
inputs['verified_guide_overlay'] = apply_overlay(root, output, guide, commit)
inputs['verified_turn_order_overlay'] = apply_turn_order_overlay(root, output, order)
inputs['verified_additional_web_overlays'] = [apply_turn_order_overlay(root, output, patch) for patch in extra_web_patches]
inputs['verified_mini_overlay'] = apply_mini_overlay(root, output, mini_patch)
mini = output / 'wechat/minigame'
shutil.copytree(dependencies, mini / 'node_modules')
for name in ('package.json', 'package-lock.json'):
    file = mini / name; data = json.loads(file.read_text(encoding='utf-8')); data['version'] = '0.14.1'
    if name == 'package-lock.json': data['packages']['']['version'] = '0.14.1'
    file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
def run(args, log):
    with (output / log).open('w', encoding='utf-8') as stream:
        subprocess.run(args, cwd=mini, stdout=stream, stderr=subprocess.STDOUT, check=True)
# The stock packager identifies a real checkout with git HEAD. This isolated
# tree has no Git identity; bind it through our provenance instead of letting
# Git walk upwards and accidentally report an unrelated checkout's HEAD.
web_packager = output / 'web/tools/prepare_frontend_release.py'
source = web_packager.read_text(encoding='utf-8')
old_commit = 'subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, encoding="utf-8").strip()'
old_dirty = 'bool(subprocess.check_output(["git", "status", "--porcelain", "--", "web/web前端"], cwd=root, text=True, encoding="utf-8").strip())'
if source.count(old_commit) != 1 or source.count(old_dirty) != 1:
    raise RuntimeError('Unexpected Web packager provenance patch points.')
source = source.replace(old_commit, 'None', 1).replace(old_dirty, 'True', 1)
web_packager.write_text(source, encoding='utf-8')
snapshot = output / 'web/web前端/frozen-workers/web-topology-fix-20261030-r2'
predecessor = snapshot / 'predecessor-release-manifest.json'
with (output / 'web-build.log').open('w', encoding='utf-8') as stream:
    subprocess.run([sys.executable, str(web_packager), '--output', str(output / 'web-release'),
        '--release-id', 'web-alignment-20261031-local', '--asset-version', '20261031-alignment-local',
        '--predecessor-manifest', str(predecessor), '--predecessor-sha256', digest(predecessor),
        '--frozen-worker-snapshot', str(snapshot)], cwd=output, stdout=stream, stderr=subprocess.STDOUT, check=True)
run(['node', 'tools/stage-models.mjs', str((frontend / 'assets/research-ai').resolve())], 'model-stage.log')
run(['npm.cmd', 'run', 'build'], 'build.log')
if os.environ.get('LIFELINE_MINI_BUILD_ONLY') == '1':
    print(json.dumps({'status': 'DIAGNOSTIC_BUILD_ONLY', 'output': str(output), 'exported_git_blobs': len(entries)}))
    raise SystemExit(0)
run(['node', '--test', '--test-concurrency=1', '--test-timeout=180000', 'tests/*.test.mjs'], 'test.log')
admission = output / 'working/docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json'
run(['node', 'tools/prepare-candidate.mjs', '--online', '--api-base', 'https://lifelinegame.cn',
     '--terminal-admission', str(admission)], 'candidate.log')
summary = json.loads((output / 'candidate.log').read_text(encoding='utf-8'))
candidate = Path(summary['directory'])
run(['node', 'tools/prepare-candidate.mjs', '--verify', str(candidate)], 'candidate-verify.log')
if tree_hash(frontend) != inputs['frontend_inventory'] or tree_hash(dependencies) != inputs['dependencies_inventory'] or digest(Path(__file__)) != inputs['builder_script_sha256'] or digest(root / 'working/tools/guide_alignment_overlay.py') != inputs['overlay_verifier_sha256']:
    raise RuntimeError('Build input changed; preserve this candidate and repeat with stable input.')
inputs['candidate'] = summary
inputs['candidate_receipt_sha256'] = digest(candidate / 'candidate.json')
inputs['build_manifest_sha256'] = digest(mini / 'dist/build-manifest.json')
inputs['tests_log_sha256'] = digest(output / 'test.log')
inputs['web_release_receipt_sha256'] = digest(output / 'web-release/bundle-receipt.json')
inputs['web_release_archive_sha256'] = digest(output / 'web-release/frontend-overlay.zip')
(output / 'alignment-provenance.json').write_text(json.dumps(inputs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': 'LOCAL_MINI_BUILT_TESTED_NOT_UPLOADED', **summary}))
