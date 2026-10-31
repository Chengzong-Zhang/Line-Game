"""Build an isolated diagnostic Windows candidate from Web and desktop inputs.

Usage: python working/tools/prepare-aligned-desktop-20261031.py WEB_FRONTEND DESKTOP_REPO NEW_OUTPUT [GUIDE_PATCH [TURN_ORDER_PATCH [EXTRA_WEB_PATCH ...]]]
The inputs must include local node_modules and Electron. Output is preliminary:
desktop-only challenge/profile integration and real startup remain release gates.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
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
dependency_root = Path(os.environ.get('LIFELINE_DESKTOP_DEPENDENCIES', str(host / 'node_modules'))).resolve()
if not (frontend / 'OnlineApp.js').is_file() or not (dependency_root / 'electron/dist/electron.exe').is_file():
    raise SystemExit('Expected frontend and installed desktop Electron dependencies.')
if guide_patch is not None and not guide_patch.is_file():
    raise SystemExit('The declared guide patch must be readable.')
if turn_patch is not None and not turn_patch.is_file():
    raise SystemExit('The declared turn-order patch must be readable.')

def file_hash(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def tree_hash(directory, ignored=()):
    records = []
    for file in sorted(directory.rglob('*')):
        if file.is_file() and file.relative_to(directory).parts[0] not in ignored and '.test-tmp' not in file.relative_to(directory).parts:
            records.append((file.relative_to(directory).as_posix(), file.stat().st_size, file_hash(file)))
    data = json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return {'sha256': hashlib.sha256(data).hexdigest(), 'files': len(records)}

commit = subprocess.check_output(['git', 'rev-parse', '51e5782d^{commit}'], cwd=root, text=True).strip()
audit = json.loads(subprocess.check_output(
    [sys.executable, str(root / 'working/tools/audit-platform-alignment.py'), str(frontend), commit],
    cwd=root, env={**os.environ, 'PYTHONUTF8': '1'}, encoding='utf-8'))
if audit['counts']['missing'] or audit['counts']['different']:
    raise SystemExit('Frontend differs from the reference; a strict patch-equivalence verifier is required before rebuilding an overlay.')
for item in audit['extra']:
    name = item['path']
    if not (name.startswith('assets/research-ai/') or name.startswith('frozen-workers/web-topology-fix-20261030-r2/assets/research-ai/')) or not name.endswith(('.json', '.f32')):
        raise SystemExit(f'Unclassified extra frontend file: {name}')
host_snapshot = host / 'HOST-SNAPSHOT.json'
if host_snapshot.is_file():
    host_identity = validate_snapshot(host, 'a90b23d045b345057809a7417340cdc5d1dfcad5')
    host_commit = host_identity['origin_commit']
else:
    git_pointer = (host / '.git').read_text(encoding='utf-8').strip()
    if not git_pointer.startswith('gitdir: '):
        raise SystemExit('Expected the host worktree Git pointer.')
    host_commit = subprocess.check_output(['git', f'--git-dir={git_pointer[8:]}', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if host_commit != 'a90b23d045b345057809a7417340cdc5d1dfcad5':
        raise SystemExit('Unexpected desktop host commit.')
    host_identity = {'origin_commit': host_commit, 'kind': 'worktree_file_audit_required'}
inputs = {'reference_commit': commit, 'reference_audit': audit, 'host_head': host_commit,
          'host_identity': host_identity,
          'frontend_inventory': tree_hash(frontend),
          'host_code_inventory': tree_hash(host / 'desktop', ('renderer', 'release', 'local_artifacts', '.test-tmp')),
          'host_dependencies_inventory': tree_hash(dependency_root),
          'host_package_sha256': file_hash(host / 'package.json'),
          'host_lock_sha256': file_hash(host / 'package-lock.json'),
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
# Reuse the final desktop host's content and storage contracts; the adapter
# runs challenges in a separate engine and never replaces the current match.
for name in ('ChallengeCampaign.js', 'GameFeedback.js', 'LocalProfile.js'):
    shutil.copy2(host / 'web/web前端' / name, output / 'web/web前端' / name)
adapter = root / 'working/tools/desktop-alignment/DesktopModes.js'
shutil.copy2(adapter, output / 'web/web前端/DesktopModes.js')
inputs['desktop_adapter_sha256'] = file_hash(adapter)
inputs['desktop_legacy_module_sha256'] = {name: file_hash(host / 'web/web前端' / name)
    for name in ('ChallengeCampaign.js', 'GameFeedback.js', 'LocalProfile.js')}
# The old desktop transform expects this binding, while the unified Web entry
# does not define it. Keep existing contribution queues intact and never flush
# or toggle them in this offline diagnostic host.
app_path = output / 'web/web前端/OnlineApp.js'
app = app_path.read_text(encoding='utf-8')
for old, new in (
    ('import GameEngine', 'import { openDesktopCampaign, createDesktopProfileController } from "./DesktopModes.js";\nimport { CHALLENGE_LEVELS } from "./ChallengeCampaign.js";\nimport GameEngine'),
    ('  setup() {\n    const storedAuth = loadAppStoredAuth();',
     '  setup() {\n    const desktopPlatform = globalThis.lifelineDesktop?.isDesktop === true;\n    const desktopProfile = desktopPlatform ? createDesktopProfileController() : null;\n    const desktopChallengeOpen = ref(false);\n    const storedAuth = loadAppStoredAuth();'),
    ('    const language = ref(getAppInitialLanguage());',
     '    const language = ref(desktopProfile?.preferences().language ?? getAppInitialLanguage());\n    watch(language, value => { if (desktopProfile) desktopProfile.setPreferences({ language: value }); });'),
    ('    return {\n      auth,\n      authBusy,',
     '    return {\n      desktopPlatform,\n      challengeLevels: CHALLENGE_LEVELS,\n      openDesktopChallenges,\n      auth,\n      authBusy,'),
    ('const retryContributions = () => { void contribution.flush(); };',
     'const retryContributions = () => { if (!desktopPlatform) void contribution.flush(); };'),
    ('const contribution = new TrainingContribution({ onChange: (state) => { contributionState.value = state; } });',
     'const contribution = new TrainingContribution({ onChange: (state) => { contributionState.value = state; } });\n    if (desktopPlatform) contribution.enabled = false;'),
    ('const toggleContributions = (enabled) => { contribution.setEnabled(enabled);',
     'const toggleContributions = (enabled) => { if (desktopPlatform) return; contribution.setEnabled(enabled);'),
    ('    const attemptReconnect = async () => {',
     '    const attemptReconnect = async () => {\n      if (desktopPlatform) return;'),
    ('    const scheduleReconnect = () => {',
     '    const scheduleReconnect = () => {\n      if (desktopPlatform) return;'),
    ('    const ensureConnected = async () => {',
     '    const ensureConnected = async () => {\n      if (desktopPlatform) throw new Error("Networking is unavailable in this desktop build.");'),
    ('    contributionState: { type: Object, required: true },',
     '    contributionAllowed: { type: Boolean, default: true },\n    contributionState: { type: Object, required: true },'),
    ('<ContributionPanel v-if="!roomSetupOpen && boardShape !== \'custom\'"',
     '<ContributionPanel v-if="contributionAllowed && !roomSetupOpen && boardShape !== \'custom\'"'),
    ('            :contribution-state="contributionState"',
     '            :contribution-allowed="!desktopPlatform"\n            :contribution-state="contributionState"'),
    ('    const restartLocalAiWorker = () => {\n      terminateAiWorker();\n      scheduleAiMove();\n    };',
     '    const restartLocalAiWorker = () => {\n      terminateAiWorker();\n      scheduleAiMove();\n    };\n    const openDesktopChallenges = () => {\n      if (!desktopPlatform || desktopChallengeOpen.value || !controller.value || roomStatus.value !== "solo" || tutorialActive.value || replayMode.value || localGameRestoring.value) return;\n      const remaining = turnTimerId !== null ? Math.max(1, turnTimerDeadline - Date.now()) : null;\n      desktopChallengeOpen.value = true;\n      terminateAiWorker();\n      cancelHintRequest();\n      clearTurnTimer();\n      const resume = () => { desktopChallengeOpen.value = false; restartTurnTimer(); if (remaining !== null && turnTimerId !== null) { turnTimerDeadline = Date.now() + remaining; updateTurnTimerRemaining(); } restartLocalAiWorker(); };\n      try { openDesktopCampaign({ language: language.value, profileController: desktopProfile, onLanguageChange: value => { language.value = value; }, onClose: resume }); } catch (error) { resume(); throw error; }\n    };'),
    ('    const canRunLocalAI = (state = gameState.value) => (\n      !tutorialActive.value',
     '    const canRunLocalAI = (state = gameState.value) => (\n      !desktopChallengeOpen.value\n      && !tutorialActive.value'),
    ('      if (tutorialActive.value || replayMode.value || replayRestoring.value || !turnTimerEnabled.value || !controller.value) {',
     '      if (desktopChallengeOpen.value || tutorialActive.value || replayMode.value || replayRestoring.value || !turnTimerEnabled.value || !controller.value) {'),
    ('    const finishTutorial = () => leaveTutorial(true);',
     '    const finishTutorial = async () => { const restored = await leaveTutorial(true); if (restored && desktopProfile) { const saved = desktopProfile.finishTutorial(); if (!saved.ok) setActionFeedback(language.value === "zh" ? "教学进度保存失败，原数据已保留。" : "Tutorial progress could not be saved; original data was retained.", "error"); } return restored; };'),
    ('    const handleStateChange = (nextState) => {\n      cancelHintRequest();\n      clearActiveHint();\n      gameState.value = nextState;',
     '    const handleStateChange = (nextState) => {\n      cancelHintRequest();\n      clearActiveHint();\n      if (desktopProfile && !localGameRestoring.value && !replayMode.value && Number(nextState.positionRevision) !== Number(gameState.value.positionRevision)) desktopProfile.playFeedback(gameState.value?.snapshot, nextState.snapshot, nextState.lastAction ?? controller.value?.lastAction, language.value);\n      gameState.value = nextState;'),
    ('    <main class="app-shell app-shell-focus">',
     '    <main class="app-shell app-shell-focus">\n      <button v-if="desktopPlatform" type="button" style="position:fixed;top:12px;right:12px;z-index:150;padding:8px 12px;border-radius:8px" :disabled="tutorialActive || replayMode || roomStatus !== \'solo\' || localGameRestoring" @click="openDesktopChallenges">{{ language === \'zh\' ? \'挑战关卡\' : \'Challenges\' }}</button>'),
):
    if app.count(old) != 1:
        raise RuntimeError(f'Unexpected desktop adaptation patch point: {old}')
    app = app.replace(old, new, 1)
app_path.write_text(app, encoding='utf-8')
def ignore_desktop(directory, names):
    ignored = {'.test-tmp'}
    if Path(directory) == host / 'desktop':
        ignored.update(('renderer', 'release', 'local_artifacts'))
    return ignored.intersection(names)
shutil.copytree(host / 'desktop', output / 'desktop', ignore=ignore_desktop)
shutil.copytree(dependency_root, output / 'node_modules')
for name in ('package.json', 'package-lock.json'):
    shutil.copy2(host / name, output / name)
package_path = output / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '0.14.0-local.1'
files = package['build']['files']
for name in ('desktop/renderer/*.mjs', 'desktop/renderer/frozen-workers/**/*'):
    if name not in files:
        files.append(name)
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')
metadata_path = output / 'desktop/package-metadata.json'
metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
metadata['version'] = package['version']
metadata['baselineHead'] = commit
metadata['baselineKind'] = 'isolated-alignment-snapshot'
metadata['webSync'] = {'date': '2026-10-31', 'sourceHead': commit,
                       'snapshotSha256': inputs['frontend_inventory']['sha256'],
                       'guidePatchSha256': inputs['guide_patch_sha256'],
                       'turnOrderPatchSha256': file_hash(turn_patch) if turn_patch else None}
metadata_path.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
subprocess.run(['npm.cmd', 'run', 'desktop:prepare'], cwd=output, check=True)
subprocess.run([str(output / 'node_modules/.bin/electron-builder.cmd'), '--win', 'dir',
                '--config.electronDist=node_modules/electron/dist'], cwd=output, check=True)
if tree_hash(frontend) != inputs['frontend_inventory'] or tree_hash(host / 'desktop', ('renderer', 'release', 'local_artifacts', '.test-tmp')) != inputs['host_code_inventory'] or tree_hash(dependency_root) != inputs['host_dependencies_inventory'] or file_hash(host / 'package.json') != inputs['host_package_sha256'] or file_hash(host / 'package-lock.json') != inputs['host_lock_sha256'] or file_hash(Path(__file__)) != inputs['builder_script_sha256'] or file_hash(root / 'working/tools/guide_alignment_overlay.py') != inputs['overlay_verifier_sha256'] or file_hash(root / 'working/tools/platform_host_snapshot.py') != inputs['host_verifier_sha256'] or file_hash(adapter) != inputs['desktop_adapter_sha256'] or any(file_hash(host / 'web/web前端' / name) != digest for name, digest in inputs['desktop_legacy_module_sha256'].items()):
    raise RuntimeError('An input changed during build; preserve this candidate and rebuild from a stable snapshot.')
if host_snapshot.is_file() and validate_snapshot(host, host_commit) != host_identity:
    raise RuntimeError('The host snapshot changed during build.')
inputs['adapted_frontend_inventory'] = tree_hash(output / 'web/web前端')
inputs['adapted_renderer_inventory'] = tree_hash(output / 'desktop/renderer')
inputs['adapted_lock_sha256'] = file_hash(output / 'package-lock.json')
inputs['adapted_package_sha256'] = file_hash(package_path)
inputs['adapted_desktop_metadata_sha256'] = file_hash(metadata_path)
inputs['asar_sha256'] = file_hash(output / 'desktop/release/win-unpacked/resources/app.asar')
inputs['exe_sha256'] = file_hash(output / 'desktop/release/win-unpacked/LIFELINE.exe')
(output / 'alignment-provenance.json').write_text(json.dumps(inputs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
