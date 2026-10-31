"""Create an isolated, preliminary itch candidate; never writes to its inputs.

Usage: python working/tools/prepare-aligned-itch-20261031.py WEB_FRONTEND ITCH_HOST NEW_OUTPUT [GUIDE_PATCH [TURN_ORDER_PATCH [EXTRA_WEB_PATCH ...]]]
ITCH_HOST includes its pinned node_modules. NEW_OUTPUT must not exist. This is a
package candidate, not a publication or a claim that network policy is enforced.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlparse
from guide_alignment_overlay import apply_overlay, apply_turn_order_overlay
from platform_host_snapshot import validate_snapshot

if len(sys.argv) < 4:
    raise SystemExit(__doc__)
frontend, host, output = (Path(value).resolve() for value in sys.argv[1:4])
guide_patch = Path(sys.argv[4]).resolve() if len(sys.argv) >= 5 else None
turn_patch = Path(sys.argv[5]).resolve() if len(sys.argv) >= 6 else None
extra_web_patches = [Path(value).resolve() for value in sys.argv[6:]]
root = Path(__file__).resolve().parents[2]
allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
if not output.is_relative_to(allowed) or output.exists():
    raise SystemExit('Output must be a new directory inside alignment-20261031 artifacts.')
dependency_root = Path(os.environ.get('LIFELINE_ITCH_DEPENDENCIES', str(host / 'node_modules'))).resolve()
if not (frontend / 'OnlineApp.js').is_file() or not (dependency_root / 'fflate').is_dir():
    raise SystemExit('Expected frontend and installed itch host dependencies.')
if guide_patch is not None and not guide_patch.is_file():
    raise SystemExit('The declared guide patch must be a readable file.')
if turn_patch is not None and not turn_patch.is_file():
    raise SystemExit('The declared turn-order patch must be a readable file.')

def file_hash(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def tree_hash(directory, ignored=()):
    records = []
    for file in sorted(directory.rglob('*')):
        if file.is_file() and file.relative_to(directory).parts[0] not in ignored and '.test-tmp' not in file.relative_to(directory).parts:
            records.append((file.relative_to(directory).as_posix(), file.stat().st_size, file_hash(file)))
    encoded = json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return {'sha256': hashlib.sha256(encoded).hexdigest(), 'files': len(records)}

commit = subprocess.check_output(['git', 'rev-parse', '51e5782d^{commit}'], cwd=root, text=True).strip()
audit = json.loads(subprocess.check_output(
    [sys.executable, str(root / 'working/tools/audit-platform-alignment.py'), str(frontend), commit],
    cwd=root, env={**__import__('os').environ, 'PYTHONUTF8': '1'}, encoding='utf-8'))
if audit['counts']['missing'] or audit['counts']['different']:
    raise SystemExit('Frontend differs from the reference; a strict patch-equivalence verifier is required before rebuilding an overlay.')
for item in audit['extra']:
    name = item['path']
    if not (name.startswith('assets/research-ai/') or name.startswith('frozen-workers/web-topology-fix-20261030-r2/assets/research-ai/')) or not name.endswith(('.json', '.f32')):
        raise SystemExit(f'Unclassified extra frontend file: {name}')
host_snapshot = host.parent / 'HOST-SNAPSHOT.json'
if host_snapshot.is_file():
    host_identity = validate_snapshot(host.parent, 'ce3c79ab4faf31f159fa8f66903638484b2f9ed6')
    host_commit = host_identity['origin_commit']
else:
    host_gitfile = (host.parent / '.git').read_text(encoding='utf-8').strip()
    if not host_gitfile.startswith('gitdir: '):
        raise SystemExit('Expected the host worktree Git pointer.')
    host_gitdir = Path(host_gitfile[8:])
    host_commit = subprocess.check_output(['git', f'--git-dir={host_gitdir}', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if host_commit != 'ce3c79ab4faf31f159fa8f66903638484b2f9ed6':
        raise SystemExit('Unexpected itch host commit.')
    host_identity = {'origin_commit': host_commit, 'kind': 'worktree_file_audit_required'}
inputs = {'reference_commit': commit, 'reference_audit': audit, 'host_head': host_commit,
          'host_identity': host_identity,
          'frontend_inventory': tree_hash(frontend),
          'host_inventory': tree_hash(host, ('local_artifacts', 'dist', '.test-tmp', 'node_modules')),
          'dependency_inventory': tree_hash(dependency_root),
          'builder_script_sha256': file_hash(Path(__file__)),
          'overlay_verifier_sha256': file_hash(root / 'working/tools/guide_alignment_overlay.py'),
          'host_verifier_sha256': file_hash(root / 'working/tools/platform_host_snapshot.py'),
          'guide_patch_sha256': file_hash(guide_patch) if guide_patch else None,
          'guide_patch_note': 'The overlay is verified and applied to the isolated baseline below.'}
output.mkdir(parents=True)
shutil.copytree(frontend, output / 'web/web前端')
if guide_patch:
    inputs['verified_guide_overlay'] = apply_overlay(root, output, guide_patch, commit)
if turn_patch:
    inputs['verified_turn_order_overlay'] = apply_turn_order_overlay(root, output, turn_patch)
inputs['verified_additional_web_overlays'] = [apply_turn_order_overlay(root, output, patch) for patch in extra_web_patches]
def ignore_host(directory, names):
    ignored = {'.test-tmp'}
    if Path(directory) == host:
        ignored.update(('local_artifacts', 'dist', 'node_modules'))
    return ignored.intersection(names)

shutil.copytree(host, output / 'itch', ignore=ignore_host)
shutil.copytree(dependency_root, output / 'itch/node_modules')
itch = output / 'itch'
config_path = itch / 'config/release.json'
config = json.loads(config_path.read_text(encoding='utf-8'))
config.update(candidate_id='lifeline-html5-20261031-local-alignment-preliminary',
              version='0.14.0-local', rules_version='territory-v3',
              asset_version='20261031-alignment-preliminary')
runtime = config['runtime']
configured_socket = os.environ.get('LIFELINE_ITCH_WEBSOCKET_URL', '').strip()
if configured_socket:
    parsed_socket = urlparse(configured_socket)
    runtime.update(networkEnabled=True, websocketUrl=configured_socket,
                   apiBaseUrl=f'https://{parsed_socket.netloc}', trainingContributionEnabled=False)
if runtime.get('trainingContributionEnabled') is True:
    raise RuntimeError('The shared client contribution endpoint is relative; itch contribution is not yet supported.')
if runtime.get('networkEnabled') is True:
    socket = urlparse(runtime.get('websocketUrl') or '')
    if socket.scheme != 'wss' or not socket.hostname or socket.username or socket.password:
        raise RuntimeError('Enabled itch networking requires an explicit credential-free wss:// URL.')
    api = runtime.get('apiBaseUrl')
    parsed_api = urlparse(api) if api else None
    if parsed_api and (parsed_api.scheme != 'https' or parsed_api.netloc != socket.netloc or parsed_api.username or parsed_api.password):
        raise RuntimeError('The current Web client derives the API origin from the WebSocket host.')
inputs['itch_runtime'] = {'networkEnabled': runtime.get('networkEnabled'),
                          'websocketUrl': runtime.get('websocketUrl'),
                          'trainingContributionEnabled': runtime.get('trainingContributionEnabled')}
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one reviewed patch point: {old!r}')
    return text.replace(old, new, 1)

# The older itch configuration was ignored by the new shared Web frontend.
# Adapt this isolated host explicitly; retain a configurable secure online
# endpoint and keep pending contribution queues untouched when disabled.
app_path = output / 'web/web前端/OnlineApp.js'
app = app_path.read_text(encoding='utf-8')
for old, new in (
    ('  setup() {\n    const storedAuth = loadAppStoredAuth();',
     '  setup() {\n    const runtimeConfig = globalThis.__LIFELINE_RUNTIME_CONFIG__ ?? {};\n    const runtimeNetworkEnabled = runtimeConfig.networkEnabled !== false;\n    const runtimeContributionEnabled = runtimeNetworkEnabled && runtimeConfig.trainingContributionEnabled !== false;\n    const storedAuth = loadAppStoredAuth();'),
    ('const initialServerUrl = resolveInitialServerUrl(storedSession.url);',
     'const initialServerUrl = runtimeConfig.websocketUrl || resolveInitialServerUrl(storedSession.url);'),
    ('const contribution = new TrainingContribution({ onChange: (state) => { contributionState.value = state; } });',
     'const contribution = new TrainingContribution({ onChange: (state) => { contributionState.value = state; } });\n    if (!runtimeContributionEnabled) contribution.enabled = false;'),
    ('const retryContributions = () => { void contribution.flush(); };',
     'const retryContributions = () => { if (runtimeContributionEnabled) void contribution.flush(); };'),
    ('const toggleContributions = (enabled) => { contribution.setEnabled(enabled);',
     'const toggleContributions = (enabled) => { if (!runtimeContributionEnabled) return; contribution.setEnabled(enabled);'),
    ('    const attemptReconnect = async () => {',
     '    const attemptReconnect = async () => {\n      if (!runtimeNetworkEnabled) return;'),
    ('    const scheduleReconnect = () => {',
     '    const scheduleReconnect = () => {\n      if (!runtimeNetworkEnabled) return;'),
    ('    const ensureConnected = async () => {',
     '    const ensureConnected = async () => {\n      if (!runtimeNetworkEnabled) throw new Error("Networking is disabled for this build.");'),
    ('    contributionState: { type: Object, required: true },',
     '    contributionAllowed: { type: Boolean, default: true },\n    contributionState: { type: Object, required: true },'),
    ('<ContributionPanel v-if="!roomSetupOpen && boardShape !== \'custom\'"',
     '<ContributionPanel v-if="contributionAllowed && !roomSetupOpen && boardShape !== \'custom\'"'),
    ('            :contribution-state="contributionState"',
     '            :contribution-allowed="runtimeContributionEnabled"\n            :contribution-state="contributionState"'),
    ('    return {\n      auth,\n      authBusy,',
     '    return {\n      runtimeNetworkEnabled,\n      runtimeContributionEnabled,\n      auth,\n      authBusy,'),
    ('v-if="!replayMode"\n                  variant="network"',
     'v-if="!replayMode && runtimeNetworkEnabled"\n                  variant="network"'),
    ('      <UtilityModal\n        variant="network"',
     '      <UtilityModal\n        v-if="runtimeNetworkEnabled"\n        variant="network"'),
):
    app = replace_once(app, old, new)
app_path.write_text(app, encoding='utf-8')

build = itch / 'tools/build-html5.mjs'
source = build.read_text(encoding='utf-8')
source = replace_once(source, r'/\.(?:css|html|js)$/i', r'/\.(?:css|html|js|mjs)$/i')
source = replace_once(source, '["assets", "guide"]', '["assets", "guide", "frozen-workers"]')
start = source.index('function currentCommit() {')
end = source.index('\n\nconst sourceModelAssets', start)
source = source[:start] + 'function currentCommit() { return null; }' + source[end:]
build.write_text(source, encoding='utf-8')

test = itch / 'tests/verify-html5-build.mjs'
source = test.read_text(encoding='utf-8')
start = source.index('const currentCommit = execFileSync(')
end = source.index('\n\nassert.equal(receipt.status', start)
source = source[:start] + 'const currentCommit = null; // Snapshot identity is the source-tree digest.' + source[end:]
source = replace_once(source, 'assert.equal(receipt.rules_version, "territory-v2");',
                      'assert.equal(receipt.rules_version, "territory-v3");')
source = replace_once(source, 'assert.match(runtimeConfig, /"networkEnabled":false/);',
                      'assert.ok(runtimeConfig.includes(`"networkEnabled":${JSON.stringify(config.runtime.networkEnabled)}`));')
source = replace_once(source, 'assert.ok(manifestPaths.has("AIWorker.js"));', '''assert.ok(manifestPaths.has("AIWorker.js"));
for (const required of ["MultiplayerHardAIWorker.bundle.mjs", "frozen-workers/web-topology-fix-20261030-r2/MultiplayerHardAIWorker.bundle.mjs", "frozen-workers/web-topology-fix-20261030-r2/GameEngine.js"]) {
  assert.ok(manifestPaths.has(required), `new Worker dependency ${required} must be packaged`);
}''')
source = replace_once(source, 'itch_runtime_network_disabled: true,',
                      'itch_runtime_config_declares_network_disabled: config.runtime.networkEnabled === false,')
test.write_text(source, encoding='utf-8')
server = itch / 'tools/serve-validation.mjs'
source = server.read_text(encoding='utf-8')
source = replace_once(source, '[".js", "text/javascript; charset=utf-8"],',
                      '[".js", "text/javascript; charset=utf-8"],\n  [".mjs", "text/javascript; charset=utf-8"],')
server.write_text(source, encoding='utf-8')

subprocess.run(['node', 'tools/build-html5.mjs'], cwd=itch, check=True)
subprocess.run(['node', 'tests/verify-html5-build.mjs'], cwd=itch, check=True)
if tree_hash(frontend) != inputs['frontend_inventory'] or tree_hash(host, ('local_artifacts', 'dist', '.test-tmp', 'node_modules')) != inputs['host_inventory'] or tree_hash(dependency_root) != inputs['dependency_inventory'] or file_hash(Path(__file__)) != inputs['builder_script_sha256'] or file_hash(root / 'working/tools/guide_alignment_overlay.py') != inputs['overlay_verifier_sha256'] or file_hash(root / 'working/tools/platform_host_snapshot.py') != inputs['host_verifier_sha256']:
    raise RuntimeError('An input changed during the build; preserve this candidate and rebuild from a stable snapshot.')
if host_snapshot.is_file() and validate_snapshot(host.parent, host_commit) != host_identity:
    raise RuntimeError('The host snapshot changed during build.')
artifact = output / 'local_artifacts/itch-html5'
receipt = artifact / f"{config['candidate_id']}-build-receipt.json"
archive = artifact / f"{config['candidate_id']}.zip"
inputs['adapted_host_inventory'] = tree_hash(itch, ('local_artifacts', 'dist', '.test-tmp'))
inputs['build_receipt_sha256'] = file_hash(receipt)
inputs['asset_manifest_sha256'] = file_hash(artifact / 'dist/asset-manifest.json')
inputs['zip_sha256'] = file_hash(archive)
(output / 'alignment-provenance.json').write_text(json.dumps(inputs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
