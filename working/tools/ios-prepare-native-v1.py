"""Build an isolated iOS resource candidate; never compiles, signs, or releases it."""
import argparse, hashlib, json, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / 'working/ios/native-v1'
BRIDGE = ROOT / 'working/ios/web-native-v1/src/ios-bridge.js'
RECOVERY = ROOT / 'working/ios/web-native-v1/src/ios-session-recovery.js'
CREDENTIAL_RECOVERY = ROOT / 'working/ios/web-native-v1/src/ios-credential-recovery.js'
DOCUMENT_LEASE = ROOT / 'working/ios/web-native-v1/src/ios-document-lease.js'
POLLING = ROOT / 'working/ios/web-native-v1/src/ios-polling.js'
RECEIPT = 'ios-native-v1-receipt.json'

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def inventory(root):
    out = {}
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise ValueError(f'Linked input is not allowed: {p}')
        if p.is_file(): out[p.relative_to(root).as_posix()] = digest(p)
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', type=Path, required=True, help='frozen mobile web distribution')
    parser.add_argument('--dist-receipt', type=Path, required=True, help='frozen iOS preparation receipt with source_files')
    parser.add_argument('--release-receipt', type=Path, required=True, help='frozen mobile package receipt')
    parser.add_argument('--capacitor-core', type=Path, required=True, help='@capacitor/core package directory')
    parser.add_argument('--assets', type=Path, required=True, help='reviewed iOS Assets.xcassets directory')
    parser.add_argument('--output', type=Path, required=True, help='new candidate under this workspace')
    parser.add_argument('--native-trial', action='store_true', help='enable iOS entry for explicit Mac testing only')
    parser.add_argument('--check', action='store_true', help='verify an existing candidate and all current inputs')
    a = parser.parse_args()
    output = a.output.resolve()
    if not output.is_relative_to(ROOT.resolve()): raise ValueError('Output must be inside the workspace')
    dist = a.dist.resolve(); core = a.capacitor_core.resolve(); assets = a.assets.resolve()
    if output == ROOT.resolve() or dist == output or output.is_relative_to(dist) or dist.is_relative_to(output): raise ValueError('Input and output overlap')
    metadata = json.loads((core/'package.json').read_text(encoding='utf-8'))
    if metadata['name'] != '@capacitor/core' or metadata['version'] != '8.5.3': raise ValueError('Expected @capacitor/core 8.5.3')
    source_receipt = json.loads(a.dist_receipt.read_text(encoding='utf-8'))
    package_receipt = json.loads(a.release_receipt.read_text(encoding='utf-8'))
    dist_files = inventory(dist)
    if source_receipt.get('source_files') != dist_files: raise ValueError('Distribution does not match the frozen per-file inventory')
    if source_receipt.get('dist_manifest_sha256') != package_receipt.get('dist_manifest_sha256') or not source_receipt.get('dist_manifest_sha256'):
        raise ValueError('Frozen iOS and mobile release manifests disagree')
    assets_inv = inventory(assets)
    for rel, expected in inventory(PROJECT/'App/App/Assets.xcassets').items():
        if assets_inv.get(rel) != expected: raise ValueError(f'Asset catalog metadata mismatch: {rel}')
    for rel in ('AppIcon.appiconset/AppIcon-512@2x.png', 'Splash.imageset/splash-2732x2732.png', 'Splash.imageset/splash-2732x2732-1.png', 'Splash.imageset/splash-2732x2732-2.png'):
        if rel not in assets_inv: raise ValueError(f'Missing asset: {rel}')
    inputs = {'dist': dist_files, 'dist_manifest_sha256': source_receipt['dist_manifest_sha256'], 'dist_receipt_sha256': digest(a.dist_receipt), 'release_receipt_sha256': digest(a.release_receipt), 'project': inventory(PROJECT), 'assets': assets_inv, 'bridge': digest(BRIDGE), 'recovery': digest(RECOVERY), 'credential_recovery': digest(CREDENTIAL_RECOVERY), 'document_lease': digest(DOCUMENT_LEASE), 'polling': digest(POLLING), 'core': digest(core/'dist/index.js'), 'script': digest(Path(__file__))}
    if a.check:
        saved = json.loads((output/RECEIPT).read_text(encoding='utf-8'))
        actual = inventory(output); actual.pop(RECEIPT)
        if saved['inputs'] != inputs or saved['candidate'] != actual or saved['native_trial'] != a.native_trial: raise ValueError('Candidate or input differs from its receipt')
        print('iOS candidate integrity: PASS (static only; no Xcode or device validation)'); return
    if output.exists(): raise ValueError('Output already exists; choose a fresh path')
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PROJECT, output)
    shutil.copytree(assets, output/'App/App/Assets.xcassets', dirs_exist_ok=True)
    public = output/'App/App/public'
    if public.exists(): raise ValueError('Project unexpectedly contains public assets')
    shutil.copytree(dist, public)
    shutil.copyfile(core/'dist/index.js', public/'platform/capacitor-core-ios.js')
    bridge = BRIDGE.read_text(encoding='utf-8').replace("from '@capacitor/core'", "from './capacitor-core-ios.js'")
    (public/'platform/ios-bridge.js').write_text(bridge, encoding='utf-8', newline='\n')
    tutorial_file = public/'platform/TutorialHost.js'
    tutorial = tutorial_file.read_text(encoding='utf-8')
    original_check = "  if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {"
    original_origin = "requested.origin !== source.origin || requested.searchParams.get('tutorial') !== '1'"
    if tutorial.count(original_check) != 1 or tutorial.count(original_origin) != 1: raise ValueError('Unsupported tutorial host source')
    ios_check = """  if (current.protocol === 'capacitor:') {
    if (current.hostname !== 'localhost' || current.port || current.username || current.password || !['/', '/index.html'].includes(current.pathname)) throw new Error('invalid-tutorial-url');
    const target = new URL('capacitor://localhost/index.html');
    target.searchParams.set('tutorial', '1');
    return target.href;
  }
"""
    tutorial = tutorial.replace(original_check, ios_check + original_check)
    tutorial = tutorial.replace(original_origin, "(source.protocol === 'capacitor:' ? (requested.protocol !== source.protocol || requested.host !== source.host) : requested.origin !== source.origin) || requested.searchParams.get('tutorial') !== '1'")
    tutorial_file.write_text(tutorial, encoding='utf-8', newline='\n')
    recovery = RECOVERY.read_text(encoding='utf-8').replace("from '@capacitor/core'", "from './capacitor-core-ios.js'")
    (public/'platform/ios-session-recovery.js').write_text(recovery, encoding='utf-8', newline='\n')
    shutil.copyfile(CREDENTIAL_RECOVERY, public/'platform/ios-credential-recovery.js')
    shutil.copyfile(DOCUMENT_LEASE, public/'platform/ios-document-lease.js')
    shutil.copyfile(POLLING, public/'platform/ios-polling.js')
    entry = public/'mobile-entry.js'; original = entry.read_text(encoding='utf-8')
    old = '  await import("./platform/native-back-bootstrap.js");'
    begin = '  const { installHarmonyNativeBridge } = await import("./platform/harmony-native-bridge.js");'
    end = '  await module.initializePlatform();'
    if original.count(old) != 1 or original.count(begin) != 1 or original.count(end) != 1: raise ValueError('Unsupported distribution entry structure')
    original = original.replace(old+'\n', '')
    start = original.index(begin); finish = original.index(end, start)+len(end)
    original = original[:start]+'''  const { createMoveHapticsController } = await import("./platform/haptics-controller.js");
  globalThis.__LIFELINE_CREATE_MOVE_HAPTICS_CONTROLLER__ = createMoveHapticsController;
  const { assertNoRecoveryPending } = await import("./platform/ios-session-recovery.js");
  assertNoRecoveryPending();
  const module = await import("./platform/ios-bridge.js");
  await module.initializePlatform();'''+original[finish:]
    catch = '  showStartupFailure();'
    if original.count(catch) != 1: raise ValueError('Unsupported startup failure handler')
    original = original.replace(catch, '''  try {
    const { showIOSSessionRecovery } = await import("./platform/ios-session-recovery.js");
    if (!await showIOSSessionRecovery()) showStartupFailure();
  } catch (_recoveryError) { showStartupFailure(); }''')
    (public/'mobile-entry.ios-trial.js').write_text(original,encoding='utf-8',newline='\n')
    if a.native_trial: entry.write_text(original,encoding='utf-8',newline='\n')
    else: entry.write_text('''const panel = document.createElement('main');
panel.setAttribute('role', 'alert');
panel.textContent = /^en/i.test(navigator.language) ? 'iOS native verification is pending. This build is not ready for use.' : 'iOS 原生验证尚未完成，此版本暂不可使用。';
document.body.replaceChildren(panel);
''',encoding='utf-8',newline='\n')
    record = {'status':'MAC-VERIFICATION-PENDING', 'native_trial':a.native_trial, 'inputs':inputs, 'candidate':inventory(output), 'limits':['no Swift compilation','no device validation','no signing','no release']}
    (output/RECEIPT).write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('iOS candidate prepared: MAC-VERIFICATION-PENDING')
if __name__ == '__main__': main()
