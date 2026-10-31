import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSerializedSessionMirror } from '../src/session-mirror.js';
import { createSessionEnvelope, inspectSessionEnvelope, reconcileSessionEnvelopes, createSessionEnvelopeWriter } from '../src/session-envelope.js';
import { selectSessionRecovery } from '../src/session-recovery.js';
import { escapeHtml } from '../tools/generate-third-party-notices.mjs';
import { generateHarmonyPlaceholderAssets } from '../tools/generate-harmony-placeholder-assets.mjs';
import { createLocalGameSession, parseLocalGameSessionRecord, wasTutorialDismissed } from '../../web/web前端/LocalGameSession.js';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const dist = path.join(mobileRoot, 'dist');
const manifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/release-baseline-manifest.json'), 'utf8'));
const runtimeSourceManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json'), 'utf8'));
const currentWebSyncManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json'), 'utf8'));
const adaptationBaseline = JSON.parse(await readFile(path.join(mobileRoot, 'config/mobile-adaptation-baseline.json'), 'utf8'));
const textEquivalence = JSON.parse(await readFile(path.join(mobileRoot, 'config/text-line-ending-equivalence.json'), 'utf8'));
const licenseManifest = JSON.parse(await readFile(path.join(mobileRoot, 'legal/license-manifest.json'), 'utf8'));
const receiptPath = process.env.LIFELINE_MOBILE_BUILD_RECEIPT
  ? path.resolve(process.env.LIFELINE_MOBILE_BUILD_RECEIPT)
  : path.join(mobileRoot, 'local_artifacts/mobile-web-build-receipt.json');
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
const harmonyBuildScript = await readFile(path.join(mobileRoot, 'tools/build-harmony-native.ps1'), 'utf8');
assert.match(harmonyBuildScript,
  /& \$nodeExe \$hvigorJs assembleHap --mode module -p module=entry@default --no-daemon --no-incremental 2>&1/,
  'Harmony assemble always disables incremental builds');
assert.match(harmonyBuildScript,
  /command = 'node <tools>\/hvigor\/hvigor\/bin\/hvigor\.js assembleHap --mode module -p module=entry@default --no-daemon --no-incremental'/,
  'Harmony build receipt records the exact non-incremental command');
const transformedResources = new Set(['index.html', 'styles.css']);
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
// Reviewed shared-source revisions may advance beyond the frozen release baseline; receipt and packed-copy checks below still bind them.
const mobileSourceOverrides = new Set([
  'NetworkManager.js', 'OnlineApp.js', 'OnlineAppI18n.js', 'OnlineAppState.js', 'LocalGameSession.js', 'TrainingContribution.js', 'ReplayCodec.js', 'ModelFreeAI.js', 'main.js', 'GameController.js', 'OnlineRoomSync.js', 'styles.css',
  'AIEngine.js', 'AIStateProtocol.js', 'AIWorker.js', 'GameEngine.js', 'LocalAIModes.js', 'Renderer.js', 'TerritoryWorker.js', 'index.html', 'ResearchAIOptions.js',
  'HintWorkerSession.js', 'TerritoryWorkerSession.js', 'ResearchAI.js',
  ...Object.keys(currentWebSyncManifest.source_files),
]);
assert.equal(runtimeSourceManifest.schema, 'lifeline-mobile-runtime-source-manifest-v1');
const expectedRuntimeSources = [
  'OnlineRoomSync.js', 'OnlineActionSync.js', 'OnlineActionSyncCoordinator.js', 'AIWorker.js',
  'LocalAIWorkerFactory.js', 'MultiplayerHardAIWorker.bundle.mjs', 'MultiplayerHardAIWorker.bundle.manifest.json',
  'LocalAIModes.js', 'LocalGameSession.js',
  'StartingPointSetup.js', 'StartingPoints.js', 'LocalPlayerSetup.js', 'ThreePlayerAI.js', 'ThreePlayerModels.js', 'ThreePlayerRuntime.js',
  'ThreePlayerSearchAI.js', 'ThreePlayerSearchOptions.js', 'HexPlayerAI.js', 'HexPlayerRuntime.js', 'HexSearchOptions.js', 'HexFastSearchAI.js',
  'assets/research-ai/three-player-policy-v1.json', 'assets/research-ai/three-player-policy-v2.json', 'assets/research-ai/three-player-policy-v3.json',
  'assets/research-ai/three-player-search-v4-round12.json', 'assets/research-ai/hex-player-policy-v1.json', 'assets/research-ai/hex-player-search-v5.json',
  'GuideArticleFormat.js', 'GuideImplementation.js', 'GuideImplementationNotes.js', 'GuideMathChapters.js', 'GuideTechnicalChapters.js',
  'HexSearchAI.js', 'LocalUndo.js', 'MultiplayerModel.js', 'MultiplayerRollout.js', 'MultiplayerUltimateAdmission.js', 'MultiplayerRuntime.js', 'MultiplayerSearch.js', 'MultiplayerNativeGeometry.js',
  'TerritoryWorkerPool.js', 'assets/research-ai/multiplayer-v1/manifest.json', 'assets/research-ai/multiplayer-v1/multiplayer-ultimate-v1.f32',
  'guide/rule/math rule.en.md', 'MultiplayerAIWarmup.js', 'platform/TutorialHost.js',
];
assert.deepEqual(runtimeSourceManifest.files, expectedRuntimeSources, 'runtime manifest contains the current Web runtime and AI asset closure');
const cacheKeyTextExtensions = new Set(['.js', '.mjs', '.html', '.css', '.md', '.json']);
for (const relative of runtimeSourceManifest.files) {
  if (!cacheKeyTextExtensions.has(path.extname(relative).toLowerCase())) continue;
  const sourceText = await readFile(path.join(repoRoot, 'web/web前端', relative), 'utf8');
  assert.ok(!sourceText.includes('20261023-l29e1'), `runtime source has no stale L29-E1 cache key: ${relative}`);
  assert.ok(!sourceText.includes('20261024-l30a1'), `runtime source has no stale L30-A1 cache key: ${relative}`);
}
assert.deepEqual(runtimeSourceManifest.packaged_additional_files, ['platform/runtime.js'], 'separately copied runtime module is explicitly classified');
assert.deepEqual(currentWebSyncManifest.required_runtime_closure,
  ['main.js', 'OnlineApp.js', 'AIWorker.js', 'MultiplayerRuntime.js', 'LocalAIWorkerFactory.js', 'MultiplayerHardAIWorker.bundle.mjs']);
assert.deepEqual(runtimeSourceManifest.required_runtime_closure, currentWebSyncManifest.required_runtime_closure, 'both manifests pin runtime closure anchors');
assert.deepEqual(runtimeSourceManifest.excluded_predecessor_files?.map(({ path: name }) => name).sort(),
  ['CrossPlatformNetwork.js', 'SharedRoomClient.js'], 'only absent predecessor-only network artifacts are excluded');
for (const item of runtimeSourceManifest.excluded_predecessor_files ?? []) {
  assert.ok(item.reason.length > 0, `predecessor exclusion reason is recorded: ${item.path}`);
  await assert.rejects(readFile(path.join(repoRoot, 'web/web前端', item.path)), { code: 'ENOENT' }, `excluded artifact is absent from current source: ${item.path}`);
}
assert.equal(runtimeSourceManifest.runtime_asset_version, '20261024-l34a1');
assert.equal(receipt.current_web_runtime_closure?.status, 'PASS_CURRENT_WEB_RUNTIME_CLOSURE', 'build receipt includes a strict current Web runtime closure audit');
assert.equal(receipt.current_web_runtime_closure?.mode, 'package', 'build receipt identifies packaged-source closure scope');
for (const entry of ['OnlineApp.js', 'AIWorker.js', 'MultiplayerRuntime.js', 'LocalAIWorkerFactory.js', 'MultiplayerHardAIWorker.bundle.mjs']) {
  assert.ok(receipt.current_web_runtime_closure.source_files.includes(entry), `build closure receipt includes runtime entry: ${entry}`);
}
assert.equal(new Set(runtimeSourceManifest.files).size, runtimeSourceManifest.files.length, 'runtime source paths are unique');
assert.equal(currentWebSyncManifest.schema, 'lifeline-mobile-current-web-sync-source-v1');
assert.equal(currentWebSyncManifest.release_id, 'web-current-sync-20261024-r16');
assert.equal(currentWebSyncManifest.asset_version, '20261024-current16');
assert.equal(currentWebSyncManifest.source_declared_commit, '19221448d92798d88877b3b9a9c955c2da2a22bd');
assert.equal(currentWebSyncManifest.source_checkout_commit, 'abb1b1db6e4dcdce38ef3318b80d24631cb65c4e');
assert.equal(Object.keys(currentWebSyncManifest.source_files).length, 116, 'receipt binds the R14 runtime closure and mobile runtime extras');
assert.deepEqual(currentWebSyncManifest.excluded_predecessor_files.map(({ path: name }) => name).sort(),
  ['CrossPlatformNetwork.js', 'SharedRoomClient.js'], 'only unavailable predecessor-only artifacts are outside the package');
assert.deepEqual(Object.keys(currentWebSyncManifest.source_files).sort(),
  [...new Set([...Object.keys(manifest.files), ...runtimeSourceManifest.files])].sort(),
  'packaged Web source closure equals the current available closure plus mobile-only runtime modules');
assert.deepEqual(currentWebSyncManifest.mobile_only_extras,
  ['OnlineActionSync.js', 'OnlineActionSyncCoordinator.js', 'platform/TutorialHost.js'],
  'mobile-only action coordination and native tutorial host remain explicit package extras');
assert.deepEqual(currentWebSyncManifest.excluded_live_unwired_experiments, runtimeSourceManifest.excluded_live_unwired_experiments,
  'runtime and source manifests agree on classified live-source experiment exclusions');
assert.deepEqual(currentWebSyncManifest.excluded_live_wired_unqualified_experiments,
  runtimeSourceManifest.excluded_live_wired_unqualified_experiments,
  'runtime and source manifests agree on wired but unqualified runtime exclusions');
for (const item of currentWebSyncManifest.excluded_live_unwired_experiments) {
  assert.match(item.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(item.classification, 'unwired_unqualified_experiment');
  assert.equal(item.runtime_reachable, false);
  assert.equal(item.packaged, false);
  assert.ok(item.reason.length > 0);
  assert.ok(!runtimeSourceManifest.files.includes(item.path), `unwired experiment is excluded from runtime package: ${item.path}`);
  assert.ok(!Object.hasOwn(currentWebSyncManifest.source_files, item.path), `unwired experiment is excluded from source package: ${item.path}`);
}
const admittedHardResources = [
  'LocalAIWorkerFactory.js', 'MultiplayerHardAIWorker.bundle.mjs', 'MultiplayerHardAIWorker.bundle.manifest.json',
];
const bundleInternalHardSources = [
  'MultiplayerHardFallback.js', 'MultiplayerHardResources.js', 'MultiplayerHardRollout.js',
  'MultiplayerHardRuntime.js', 'MultiplayerHardValue.js', 'MultiplayerHardWorkerEntry.js', 'MultiplayerHardWorkerRuntime.js',
];
assert.deepEqual(currentWebSyncManifest.excluded_live_unwired_experiments, [], 'no absent un-wired experiments are listed as live');
assert.deepEqual(runtimeSourceManifest.excluded_live_unwired_experiments, [], 'runtime manifest has no absent un-wired experiments');
assert.deepEqual(currentWebSyncManifest.excluded_live_wired_unqualified_experiments, [], 'no absent wired experiments are listed as live');
assert.deepEqual(runtimeSourceManifest.excluded_live_wired_unqualified_experiments, [], 'runtime manifest has no absent wired experiments');
for (const name of admittedHardResources) {
  assert.ok(runtimeSourceManifest.files.includes(name), `admitted Hard resource is included in the runtime manifest: ${name}`);
  assert.ok(Object.hasOwn(currentWebSyncManifest.source_files, name), `admitted Hard resource is source-bound: ${name}`);
  assert.equal(await hash(path.join(dist, name)), receipt.dist_files.find(({ path: relative }) => relative === name)?.sha256,
    `admitted Hard resource is hash-bound in dist: ${name}`);
  for (const packagedRoot of [
    path.join(mobileRoot, 'android/app/src/main/assets/public'),
    path.join(mobileRoot, 'harmony/entry/src/main/resources/rawfile/web'),
  ]) assert.equal(await hash(path.join(packagedRoot, name)), await hash(path.join(dist, name)),
    `admitted Hard resource matches dist in ${packagedRoot}: ${name}`);
}
assert.deepEqual(currentWebSyncManifest.bundle_internal_sources, runtimeSourceManifest.bundle_internal_sources,
  'both manifests keep one identical bundle-internal source inventory');
assert.deepEqual(currentWebSyncManifest.bundle_internal_sources.map(({ path: name }) => name), bundleInternalHardSources);
for (const item of currentWebSyncManifest.bundle_internal_sources) {
  assert.match(item.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(item.classification, 'bundle_internal_source');
  assert.equal(item.bundle, 'MultiplayerHardAIWorker.bundle.mjs');
  assert.equal(item.packaged, false);
  assert.ok(item.reason.length > 0);
  assert.ok(!runtimeSourceManifest.files.includes(item.path), `bundle-internal source is not a standalone runtime file: ${item.path}`);
  assert.ok(!Object.hasOwn(currentWebSyncManifest.source_files, item.path), `bundle-internal source is not a standalone synced file: ${item.path}`);
  await assert.rejects(readFile(path.join(repoRoot, 'web/web前端', item.path)), { code: 'ENOENT' },
    `bundle-internal source is absent from the mobile source projection: ${item.path}`);
  await assert.rejects(readFile(path.join(dist, item.path)), { code: 'ENOENT' }, `bundle-internal source is absent from dist: ${item.path}`);
  assert.ok(!receipt.dist_files.some(({ path: relative }) => relative.split('/').at(-1) === item.path),
    `bundle-internal source is absent from receipt-bound package files: ${item.path}`);
  for (const packagedRoot of [
    path.join(mobileRoot, 'android/app/src/main/assets/public'),
    path.join(mobileRoot, 'harmony/entry/src/main/resources/rawfile/web'),
  ]) await assert.rejects(readFile(path.join(packagedRoot, item.path)), { code: 'ENOENT' },
    `bundle-internal source is absent from ${packagedRoot}: ${item.path}`);
}
assert.equal(await hash(path.join(repoRoot, 'web/web前端/MultiplayerHardAIWorker.bundle.mjs')),
  'bea2a7c9587a8697e71a981a4e5f3cb92ff7bd92d8ad107b845ba6ba004e6911');
assert.equal(await hash(path.join(repoRoot, 'web/web前端/MultiplayerHardAIWorker.bundle.manifest.json')),
  '65451533e0bedd23f5f1df5fc67fff4a5f99f0b116635befec9c2c4ce6895589');
const adaptationRecords = currentWebSyncManifest.mobile_adaptations;
assert.ok(Array.isArray(adaptationRecords), 'current web sync records mobile adaptations with source and mobile hashes');
assert.deepEqual(adaptationRecords.map(({ path: name }) => name).sort(), runtimeSourceManifest.mobile_adaptations.map(({ path: name }) => name).sort(),
  'runtime and current web sync manifests agree on the adaptation inventory');
assert.deepEqual(adaptationRecords, runtimeSourceManifest.mobile_adaptations,
  'runtime and current web sync manifests keep identical adaptation evidence');
assert.equal(adaptationBaseline.schema, 'lifeline-mobile-adaptation-baseline-v1');
const adaptationBaselineByPath = new Map(adaptationBaseline.files.map((entry) => [entry.path, entry]));
const expectedAdaptations = [...adaptationBaselineByPath.keys(), 'LocalAIWorkerFactory.js', 'MultiplayerAIWarmup.js', 'MultiplayerRuntime.js', 'assets/research-ai/manifest.json', 'HexFastSearchAI.js', 'HexPlayerRuntime.js'];
assert.deepEqual(adaptationRecords.map(({ path: name }) => name).sort(), expectedAdaptations.sort(),
  'only adaptations present in the compact frozen baseline and the documented snapshot supplement are recorded');
for (const adaptation of adaptationRecords) {
  assert.match(adaptation.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(adaptation.mobile_sha256, /^[a-f0-9]{64}$/);
  assert.ok(adaptation.reason.length > 0);
  assert.equal(await hash(path.join(dist, adaptation.path)), adaptation.mobile_sha256,
    `adaptation mobile hash matches packaged source: ${adaptation.path}`);
  const snapshotEntry = adaptationBaselineByPath.get(adaptation.path);
  if (snapshotEntry && adaptation.source_snapshot?.includes('post-snapshot live source supplement')) {
    assert.notEqual(adaptation.source_sha256, snapshotEntry.source_sha256,
      `post-snapshot source update remains explicit while the frozen baseline is retained: ${adaptation.path}`);
  } else if (snapshotEntry) assert.equal(adaptation.source_sha256, snapshotEntry.source_sha256,
    `adaptation source hash matches compact frozen web snapshot: ${adaptation.path}`);
  else assert.match(adaptation.source_snapshot ?? '', /snapshot supplement/, 'new source records why it is outside the frozen table');
}
const runtimeCacheAdaptation = adaptationRecords.find(({ path: name }) => name === 'MultiplayerRuntime.js');
assert.ok(runtimeCacheAdaptation, 'mobile runtime cache-key adaptation is recorded');
assert.match(runtimeCacheAdaptation.reason, /cache-buster/);
assert.match(await readFile(path.join(repoRoot, 'web/web前端/MultiplayerRuntime.js'), 'utf8'),
  /MultiplayerUltimateAdmission\.js\?v=20261024-l34a1/,
  'the shared runtime module already carries the selected mobile-compatible cache key');
assert.match(await readFile(path.join(dist, 'MultiplayerRuntime.js'), 'utf8'), /MultiplayerUltimateAdmission\.js\?v=20261024-l34a1/);
const textEquivalencePaths = Object.keys(textEquivalence.files).sort();
assert.equal(textEquivalencePaths.length, 9, 'newline equivalence remains an explicit nine-file allowlist');
for (const name of textEquivalencePaths) {
  assert.match(path.posix.extname(name), /^\.(json|md|tex)$/i, `newline equivalence allows text extensions only: ${name}`);
  assert.doesNotMatch(name, /\.(f32|png|jpe?g|gif|ico)$/i, `binary and image assets cannot use text equivalence: ${name}`);
}
const hashNormalizedText = async (file) => createHash('sha256').update((await readFile(file, 'utf8')).replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
assert.equal(receipt.status, 'PASS-CURRENT');
assert.equal(receipt.runtime_asset_version, runtimeSourceManifest.runtime_asset_version);
assert.equal(receipt.current_web_sync_release_id, currentWebSyncManifest.release_id);
assert.equal(receipt.current_web_sync_source_manifest_sha256,
  await hash(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json')));
assert.equal(receipt.frozen_file_count, 74);
assert.equal(receipt.model_asset_count, 18);
assert.deepEqual(receipt.excluded_predecessor_files, runtimeSourceManifest.excluded_predecessor_files);
const playContext = { aiMode: 'ai_duel', aiDepth: 4, aiStrategy: 'topology-gnn', aiModelVersion: '2026092203', aiSeed: 2026092203, aiDuelPaused: true, tutorialDismissed: true };
const contextualSession = createLocalGameSession({ playerCount: 2, gridSize: 5, startPlayer: 'BLACK', rulesVersion: 'territory-v2' }, [], playContext);
assert.deepEqual(parseLocalGameSessionRecord(JSON.stringify(contextualSession)).playContext, playContext);
assert.equal(wasTutorialDismissed(parseLocalGameSessionRecord(JSON.stringify(contextualSession)), false), true,
  'native-restored tutorial completion survives missing WebView flag, including zero-action saves');
assert.equal(parseLocalGameSessionRecord(JSON.stringify({ ...contextualSession, playContext: { ...playContext, aiStrategy: 'unknown-ai' } })), null);
assert.equal(parseLocalGameSessionRecord(JSON.stringify({ ...contextualSession, playContext: { ...playContext, aiDepth: 999 } })), null);
assert.deepEqual(selectSessionRecovery({ wasCleared: false, localValue: '{broken', nativeValue: JSON.stringify(contextualSession), parse: parseLocalGameSessionRecord }), {
  action: 'restore-native-to-local', value: JSON.stringify(contextualSession),
});
assert.equal(selectSessionRecovery({ wasCleared: true, localValue: JSON.stringify(contextualSession), nativeValue: JSON.stringify(contextualSession), parse: parseLocalGameSessionRecord }).action, 'clear');

const payloadA = JSON.stringify(contextualSession);
const payloadB = JSON.stringify({ ...contextualSession, savedAt: contextualSession.savedAt + 1 });
const envelope = (revision, state, payload) => JSON.stringify(createSessionEnvelope({ revision, state, payload }));
const saved1 = envelope(1, 'saved', payloadA);
const saved2 = envelope(2, 'saved', payloadB);
const cleared2 = envelope(2, 'cleared');
assert.equal(reconcileSessionEnvelopes({ localValue: saved2, nativeValue: saved1, parseSession: parseLocalGameSessionRecord }).selected.raw, saved2, 'newer local envelope repairs an older native copy');
assert.equal(reconcileSessionEnvelopes({ localValue: saved1, nativeValue: saved2, parseSession: parseLocalGameSessionRecord }).selected.raw, saved2, 'newer native envelope restores over an older local copy');
assert.equal(reconcileSessionEnvelopes({ localValue: cleared2, nativeValue: saved1, parseSession: parseLocalGameSessionRecord }).selected.kind, 'cleared', 'a later envelope clear wins over an older save');
assert.equal(reconcileSessionEnvelopes({ localValue: saved2, nativeValue: '__LIFELINE_CLEARED_V1__', parseSession: parseLocalGameSessionRecord }).status, 'conflict', 'unordered legacy tombstones cannot silently erase an envelope save');
assert.equal(reconcileSessionEnvelopes({ localValue: saved2, nativeValue: cleared2, parseSession: parseLocalGameSessionRecord }).status, 'conflict', 'same-revision save/clear differences are explicit conflicts');
assert.equal(reconcileSessionEnvelopes({ localValue: envelope(2, 'saved', payloadA), nativeValue: envelope(2, 'saved', payloadB), parseSession: parseLocalGameSessionRecord }).status, 'conflict', 'same-revision payload differences are explicit conflicts');
assert.equal(reconcileSessionEnvelopes({ localValue: saved2, nativeValue: '{broken', parseSession: parseLocalGameSessionRecord }).status, 'corrupt-peer', 'a valid copy does not silently overwrite a corrupt peer');
assert.equal(reconcileSessionEnvelopes({ localValue: payloadA, nativeValue: payloadA, parseSession: parseLocalGameSessionRecord }).selected.legacy, true, 'matching legacy copies are migration inputs');
assert.equal(reconcileSessionEnvelopes({ localValue: payloadA, nativeValue: payloadB, parseSession: parseLocalGameSessionRecord }).status, 'conflict', 'different unordered legacy copies conflict');
assert.equal(inspectSessionEnvelope('__LIFELINE_CLEARED_V1__', { parseSession: parseLocalGameSessionRecord }).kind, 'cleared', 'Android legacy tombstone remains distinguishable');
assert.equal(inspectSessionEnvelope('__lifeline_native_session_cleared_v1__', { parseSession: parseLocalGameSessionRecord }).kind, 'cleared', 'Harmony legacy tombstone remains distinguishable');
assert.equal(inspectSessionEnvelope(null, { parseSession: parseLocalGameSessionRecord }).kind, 'missing', 'missing is distinct from a tombstone');
let nativeWrites = 0;
let localWriteFails = true;
const failingStorage = { setItem() { if (localWriteFails) throw new Error('quota'); } };
const failedWriter = createSessionEnvelopeWriter({ storage: failingStorage, key: 'key', onWrite() { nativeWrites += 1; } });
assert.equal(failedWriter.writeSaved(payloadA), null);
assert.equal(nativeWrites, 0, 'local write failure must not enqueue a native write');
localWriteFails = false;
assert.equal(failedWriter.writeSaved(payloadA) && failedWriter.revision, 1, 'revision is captured only after a successful local write');
assert.equal(nativeWrites, 1);

const recordedSource = new Map(receipt.source_files.map(({ path: name, sha256 }) => [name, sha256]));
assert.equal(recordedSource.size, receipt.source_files.length, 'source receipt paths are unique');
assert.ok(recordedSource.size >= 87, 'receipt binds each release web file and mobile build input');
assert.ok(recordedSource.has('mobile/tools/update-current-web-sync-manifests.mjs'), 'build receipt binds the manifest refresh tool');
assert.ok(recordedSource.has('mobile/tools/verify-l28a-package-policy.py'), 'build receipt binds the L28-A package policy verifier');
assert.ok(recordedSource.has('mobile/tools/verify-l28b-package-policy.py'), 'build receipt binds the L28-B package policy verifier');
assert.ok(recordedSource.has('mobile/tools/verify-l30a-package-policy.py'), 'build receipt binds the current L30-A/R13 package policy verifier');
assert.ok(recordedSource.has('mobile/tools/verify-l32a-package-policy.py'), 'build receipt binds the current L32-A/R14 package policy verifier');
assert.ok(recordedSource.has('mobile/tests/verify-local-ai-worker-route.mjs'), 'build receipt binds the focused mobile Worker route regression');
assert.ok(recordedSource.has('docs/verification/multiplayer-20261022/hard-dual-rules-browser-r6.json'),
  'build receipt binds the saved Chrome Hard Worker contract audit');
for (const path of [
  'mobile/tools/current-web-sync-closure.mjs',
  'mobile/tools/audit-current-web-sync-closure.mjs',
  'mobile/tests/verify-current-web-sync-closure.mjs',
]) assert.ok(recordedSource.has(path), `build receipt binds the live Web closure audit evidence: ${path}`);
assert.ok(recordedSource.has('mobile/tests/verify-multiplayer-native-geometry.mjs'), 'build receipt binds the native geometry regression');
assert.ok(recordedSource.has('mobile/tests/verify-tutorial-host.mjs'), 'build receipt binds native tutorial-host regressions');
assert.ok(recordedSource.has('mobile/tests/verify-replay-import-client.mjs'), 'build receipt binds replay import lifecycle and privacy regressions');
for (const path of [
  'mobile/tests/verify-android-capabilities.py',
  'mobile/tests/verify-android-credential-store.py',
  'mobile/tests/verify-android-network-status.py',
  'mobile/tests/verify-android-haptics.py',
  'mobile/tests/verify-android-session-store.py',
  'mobile/tests/verify-android-main-page-recovery.py',
  'mobile/tests/verify-android-replay-import.py',
  'mobile/tests/verify-android-tutorial-host.py',
  'mobile/tests/verify-android-app-host.py',
]) assert.ok(recordedSource.has(path), `build receipt binds Android host-stub suite: ${path}`);
assert.ok(recordedSource.has('mobile/tools/verify-android-host.mjs'), 'build receipt binds the Android host-stub suite runner');
assert.ok(recordedSource.has('mobile/tools/verify-android-replay-import.mjs'), 'build receipt binds the Android replay picker verifier launcher');
assert.ok(recordedSource.has('mobile/tests/verify-mobile-back-integration.mjs'), 'build receipt binds the native-back to mounted-app integration regression');
assert.ok(recordedSource.has('web/web前端/tests/verify-online-bot-ui.mjs'), 'build receipt binds the online bot UI regression');
for (const [relative, expected] of recordedSource) {
  assert.equal(await hash(path.join(repoRoot, relative)), expected, `source receipt mismatch: ${relative}`);
}
for (const name of runtimeSourceManifest.files) {
  const sourcePath = path.join(repoRoot, 'web/web前端', name);
  const outputPath = path.join(dist, name);
  assert.equal(recordedSource.get(`web/web前端/${name}`), await hash(sourcePath), `runtime source is bound once: ${name}`);
  assert.equal(await hash(outputPath), await hash(sourcePath), `runtime module package matches its reviewed source: ${name}`);
}
const adaptationByPath = new Map(adaptationRecords.map((adaptation) => [adaptation.path, adaptation]));
for (const [name, liveExpected] of Object.entries(currentWebSyncManifest.source_files)) {
  const sourcePath = path.join(repoRoot, 'web/web前端', name);
  const outputPath = path.join(dist, name);
  const mobileExpected = adaptationByPath.get(name)?.mobile_sha256 ?? liveExpected;
  assert.equal(await hash(sourcePath), mobileExpected, `current Web sync mobile source hash: ${name}`);
  if (!transformedResources.has(name)) assert.equal(await hash(outputPath), mobileExpected, `current Web sync packaged hash: ${name}`);
}
for (const name of ['OnlineApp.js', 'AIWorker.js', 'LocalGameSession.js', 'main.js']) {
  const bundled = await readFile(path.join(dist, name), 'utf8');
  assert.ok(bundled.includes(`v=${runtimeSourceManifest.runtime_asset_version}`), `cache version is current in ${name}`);
  assert.doesNotMatch(bundled, /\?v=202610(?:13|20|21)-|\?v=20261023-l26a[12]/, `stale module cache version is absent from ${name}`);
}
const mobileEntrySource = await readFile(path.join(dist, 'mobile-entry.js'), 'utf8');
assert.ok(mobileEntrySource.includes(`main.js?v=${runtimeSourceManifest.runtime_asset_version}`), 'mobile bootstrap imports the current versioned application entry');
assert.doesNotMatch(mobileEntrySource, /\?v=202610(?:13|20|21)-|\?v=20261023-l26a[12]/, 'mobile bootstrap does not reuse an older cache version');
const mobileIndex = await readFile(path.join(dist, 'index.html'), 'utf8');
assert.doesNotMatch(mobileIndex, /\?v=202610(?:13|20|21)-|\?v=20261023-l26a[12]/, 'mobile HTML has no stale module cache version');
const actionSyncSource = await readFile(path.join(dist, 'OnlineActionSync.js'), 'utf8');
const actionCoordinatorSource = await readFile(path.join(dist, 'OnlineActionSyncCoordinator.js'), 'utf8');
const onlineAppSource = await readFile(path.join(dist, 'OnlineApp.js'), 'utf8');
assert.match(onlineAppSource, /from "\.\/OnlineActionSync\.js\?/);
assert.match(onlineAppSource, /from "\.\/OnlineActionSyncCoordinator\.js\?/);
assert.ok(actionSyncSource.length > 0 && actionCoordinatorSource.length > 0, 'OnlineApp runtime imports resolve to packed action-sync modules');
for (const [relative, expected] of Object.entries(manifest.files)) {
  const sourcePath = path.join(repoRoot, 'web/web前端', relative);
  const outputPath = path.join(dist, relative);
  const sourceHash = await hash(sourcePath);
  assert.equal(recordedSource.get(`web/web前端/${relative}`), sourceHash, `source receipt mismatch: ${relative}`);
  if (!transformedResources.has(relative)) {
    assert.equal(await hash(outputPath), sourceHash, `packed resource differs from current shared source: ${relative}`);
  }
  if (!mobileSourceOverrides.has(relative)) {
    const equivalencePath = `web/web前端/${relative}`;
    const equivalence = textEquivalence.files[equivalencePath];
    if (equivalence) {
      assert.equal(expected, equivalence.raw_sha256, `raw baseline binding mismatch: ${relative}`);
      assert.equal(await hashNormalizedText(sourcePath), equivalence.normalized_sha256,
        `normalized source equivalence mismatch: ${relative}`);
      const normalizedRecorded = receipt.source_files.find(({ path: name }) => name === equivalencePath)?.normalized_text_sha256;
      assert.equal(normalizedRecorded, equivalence.normalized_sha256, `receipt omits normalized text hash: ${relative}`);
    } else assert.equal(sourceHash, expected, `frozen baseline mismatch: ${relative}`);
  }
}
for (const item of receipt.model_assets) assert.equal(await hash(path.join(dist, item.path)), item.sha256, `model hash: ${item.path}`);
assert.equal(licenseManifest.native_transitive_status, 'PENDING_TOOLCHAIN_AND_CHANNEL_CONFIGURATION');
assert.ok(licenseManifest.packages.length >= 9);
for (const license of licenseManifest.packages) {
  const source = path.join(mobileRoot, 'legal', license.path);
  const output = path.join(dist, 'legal', license.path);
  assert.equal((await readFile(source)).byteLength, license.bytes, `license size: ${license.name}`);
  assert.equal(await hash(source), license.sha256, `license source hash: ${license.name}`);
  assert.equal(await hash(output), license.sha256, `bundled license hash: ${license.name}`);
  assert.ok(recordedSource.has(`mobile/legal/${license.path}`), `license bound in source receipt: ${license.name}`);
}
assert.equal(await hash(path.join(dist, 'legal/license-manifest.json')), await hash(path.join(mobileRoot, 'legal/license-manifest.json')));
assert.equal(await hash(path.join(dist, 'legal/THIRD_PARTY_NOTICES.md')), await hash(path.join(mobileRoot, 'legal/THIRD_PARTY_NOTICES.md')));
const noticesHtml = await readFile(path.join(dist, 'legal/THIRD_PARTY_NOTICES.html'), 'utf8');
assert.equal((noticesHtml.match(/class="license-card"/g) ?? []).length, 9, 'HTML notice contains all nine complete license sections');
assert.match(noticesHtml, /href="\.\.\/index\.html"/, 'HTML notice has an offline game return link');
assert.match(noticesHtml, /<script type="module" src="\.\.\/platform\/native-back-bootstrap\.js"><\/script>/,
  'standalone notices load the local native back handler after Capacitor resets page listeners');
assert.doesNotMatch(noticesHtml, /<script\b[^>]+(?:https?:|src=["']\/\/)|<link\b|@import\b/i,
  'HTML notice uses no remote scripts or linked stylesheets');
assert.equal(escapeHtml('<tag a="&">'), '&lt;tag a=&quot;&amp;&quot;&gt;');
for (const [index, license] of licenseManifest.packages.entries()) {
  const text = await readFile(path.join(mobileRoot, 'legal', license.path), 'utf8');
  assert.ok(noticesHtml.includes(`<h2>${escapeHtml(license.name)}</h2>`), `HTML notice package name: ${license.name}`);
  assert.ok(noticesHtml.includes(`Version ${escapeHtml(license.version)} · ${escapeHtml(license.license)}`), `HTML notice metadata: ${license.name}`);
  assert.ok(noticesHtml.includes(`<pre>${escapeHtml(text)}</pre>`), `HTML notice contains escaped complete license text: ${license.name}`);
  assert.ok(noticesHtml.includes(`href="#license-${index + 1}"`), `HTML notice contents link: ${license.name}`);
}
assert.ok(recordedSource.has('mobile/tools/generate-third-party-notices.mjs'), 'license HTML generator is bound in build receipt');
assert.ok(recordedSource.has('mobile/tools/generate-harmony-placeholder-assets.mjs'), 'Harmony resource generator is bound in build receipt');
assert.ok(recordedSource.has('mobile/config/mobile-runtime-source-manifest.json'), 'runtime source manifest is bound in build receipt');
assert.ok(recordedSource.has('mobile/config/current-web-sync-source-manifest.json'), 'current Web sync source manifest is bound in build receipt');
for (const relative of [
  'mobile/tools/audit-live-web-runtime-delta-r16.mjs',
  'mobile/tests/verify-live-web-runtime-delta-r16.mjs',
  'mobile/config/live-web-runtime-delta-baseline-r16.json',
  'docs/verification/mobile-harmony-session-presence-l35-b-20261024.json',
]) {
  const expectedHash = await hash(path.join(repoRoot, relative));
  assert.equal(recordedSource.get(relative), expectedHash,
    `R16 live Web delta audit source path and hash are bound in build receipt: ${relative}`);
}
const appConfig = JSON.parse(await readFile(path.join(mobileRoot, 'harmony/AppScope/app.json5'), 'utf8'));
const moduleConfig = JSON.parse(await readFile(path.join(mobileRoot, 'harmony/entry/src/main/module.json5'), 'utf8'));
const appBase = path.join(mobileRoot, 'harmony/AppScope/resources/base');
const moduleBase = path.join(mobileRoot, 'harmony/entry/src/main/resources/base');
const appStrings = JSON.parse(await readFile(path.join(appBase, 'element/string.json'), 'utf8'));
const moduleStrings = JSON.parse(await readFile(path.join(moduleBase, 'element/string.json'), 'utf8'));
const moduleColors = JSON.parse(await readFile(path.join(moduleBase, 'element/color.json'), 'utf8'));
const ability = moduleConfig.module.abilities.find(({ name }) => name === 'EntryAbility');
const resolveRef = async (reference, base, kind, entries) => {
  const match = String(reference).match(new RegExp(`^\\$${kind}:([A-Za-z0-9_]+)$`));
  assert.ok(match, `valid $${kind} resource reference: ${reference}`);
  if (kind === 'media') {
    const media = await Promise.any(['png', 'jpg', 'jpeg', 'svg'].map((extension) => readFile(path.join(base, `media/${match[1]}.${extension}`))));
    assert.deepEqual(media.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `PNG signature for ${reference}`);
    assert.equal(media.readUInt32BE(16), 512, `PNG width for ${reference}`);
    assert.equal(media.readUInt32BE(20), 512, `PNG height for ${reference}`);
    return;
  }
  assert.ok(entries[kind].some((item) => item.name === match[1]), `resource entry exists for ${reference}`);
};
await resolveRef(appConfig.app.icon, appBase, 'media', { media: [] });
await resolveRef(appConfig.app.label, appBase, 'string', { string: appStrings.string });
await resolveRef(ability.icon, moduleBase, 'media', { media: [] });
await resolveRef(ability.label, moduleBase, 'string', { string: moduleStrings.string });
await resolveRef(ability.startWindowIcon, moduleBase, 'media', { media: [] });
await resolveRef(ability.startWindowBackground, moduleBase, 'color', { color: moduleColors.color });
for (const relative of [
  'mobile/harmony/AppScope/app.json5', 'mobile/harmony/entry/src/main/module.json5',
  'mobile/harmony/AppScope/resources/base/element/string.json', 'mobile/harmony/AppScope/resources/base/media/app_icon.png',
  'mobile/harmony/entry/src/main/resources/base/element/string.json', 'mobile/harmony/entry/src/main/resources/base/element/color.json',
  'mobile/harmony/entry/src/main/resources/base/media/app_icon.png', 'mobile/harmony/entry/src/main/resources/base/media/startIcon.png',
]) assert.ok(recordedSource.has(relative), `Harmony resource input bound in build receipt: ${relative}`);
const androidTestRelative = 'mobile/android/app/src/androidTest/java/cn/lifelinegame/mobile/LifelineApplicationIdentityTest.java';
const androidTestSource = await readFile(path.join(repoRoot, androidTestRelative), 'utf8');
assert.ok(recordedSource.has(androidTestRelative), 'Android instrumentation source is bound in build receipt');
assert.match(androidTestSource, /assertEquals\("cn\.lifelinegame\.mobile",\s*appContext\.getPackageName\(\)\)/, 'Android instrumentation smoke test matches the configured application ID');
assert.doesNotMatch(androidTestSource, /com\.getcapacitor\.app|2\s*\+\s*2/, 'no Capacitor identity or arithmetic example remains');
await assert.rejects(
  readFile(path.join(repoRoot, 'mobile/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java')),
  (error) => error.code === 'ENOENT',
  'generated arithmetic unit-test template was removed',
);
assert.doesNotMatch(await readFile(path.join(mobileRoot, 'tools/build-web.mjs'), 'utf8'), /(?:import\s+.*from\s+['"][^'"]*generate-harmony-placeholder-assets|generateHarmonyPlaceholderAssets\s*\()/,
  'ordinary web build does not generate or overwrite Harmony placeholder resources');
const placeholderGenerator = await readFile(path.join(mobileRoot, 'tools/generate-harmony-placeholder-assets.mjs'), 'utf8');
assert.match(placeholderGenerator, /flag:\s*'wx'/, 'explicit Harmony placeholder generator creates files without overwriting');
const placeholderTestRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-harmony-placeholder-'));
try {
  const preservedResource = path.join(placeholderTestRoot, 'harmony/AppScope/resources/base/element/string.json');
  await mkdir(path.dirname(preservedResource), { recursive: true });
  await writeFile(preservedResource, 'future-brand-resource');
  await assert.rejects(generateHarmonyPlaceholderAssets({ root: placeholderTestRoot }), /Refusing to overwrite existing Harmony resource/);
  assert.equal(await readFile(preservedResource, 'utf8'), 'future-brand-resource', 'placeholder generation preserves an existing resource');
} finally {
  await rm(placeholderTestRoot, { recursive: true, force: true });
}
const appSource = await readFile(path.join(repoRoot, 'web/web前端/OnlineApp.js'), 'utf8');
assert.match(appSource, /v-if="mobileShell" href="\.\/legal\/THIRD_PARTY_NOTICES\.html"/);
assert.match(appSource, /v-if="!mobileShell" href="https:\/\/beian\.mps\.gov\.cn/);
assert.match(await readFile(path.join(mobileRoot, 'harmony/README.md'), 'utf8'), /checked against the same Preferences instance[\s\S]*not evidence about Harmony's Preferences cache eviction or disk durability[\s\S]*cross-proxy races remain NOT-RUN/);
assert.equal(receipt.dist_files.length, receipt.dist_file_count, 'receipt contains every dist output');
const outputRows = [];
const visitDist = async (folder, prefix = '') => {
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) await visitDist(folder, relative);
    else outputRows.push({ path: relative, sha256: await hash(path.join(folder, relative)) });
  }
};
await visitDist(dist);
outputRows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
assert.deepEqual(outputRows, receipt.dist_files, 'receipt hashes match every final web output');
assert.equal(createHash('sha256').update(JSON.stringify(outputRows)).digest('hex'), receipt.dist_manifest_sha256,
  'complete dist manifest digest matches');
const harmonyRawfileRoot = path.join(mobileRoot, 'harmony/entry/src/main/resources/rawfile/web');
const harmonyRows = [];
const visitHarmony = async (folder, prefix = '') => {
  for (const entry of await readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll('\\', '/'), entry.name);
    if (relative === '.lifeline-generated-assets') continue;
    if (entry.isDirectory()) await visitHarmony(folder, relative);
    else harmonyRows.push({ path: relative, sha256: await hash(path.join(folder, relative)) });
  }
};
await visitHarmony(harmonyRawfileRoot);
harmonyRows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
assert.deepEqual(harmonyRows, receipt.harmony_rawfile_files, 'generated Harmony rawfiles match receipt');
assert.deepEqual(harmonyRows, receipt.dist_files, 'Harmony rawfiles exactly match web dist');
assert.equal(createHash('sha256').update(JSON.stringify(harmonyRows)).digest('hex'), receipt.harmony_rawfile_manifest_sha256);
const androidPublicRoot = path.join(mobileRoot, 'android/app/src/main/assets/public');
for (const name of runtimeSourceManifest.files) {
  const expected = await hash(path.join(dist, name));
  assert.equal(await hash(path.join(androidPublicRoot, name)), expected, `Android packaged runtime resource matches: ${name}`);
  assert.equal(await hash(path.join(harmonyRawfileRoot, name)), expected, `Harmony packaged runtime resource matches: ${name}`);
}
const harmonyAssetManifest = path.join(mobileRoot, 'harmony/entry/src/main/ets/generated/AssetManifest.ets');
assert.equal(await hash(harmonyAssetManifest), receipt.harmony_asset_manifest_ets_sha256);
const harmonyPage = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
const harmonyProxy = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets'), 'utf8');
const harmonyNetworkMonitor = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/bridge/NetworkStatusMonitor.ets'), 'utf8');
assert.match(harmonyPage, /https:\/\/lifeline\.appassets\.invalid/);
assert.match(harmonyPage, /onInterceptRequest/);
assert.match(harmonyPage, /PACKAGED_FILE_SET\.has\(relativePath\)/);
assert.match(harmonyPage, /decodeURIComponent/);
assert.match(harmonyPage, /\.fileAccess\(false\)/);
assert.match(harmonyPage, /setResponseMimeType/);
assert.match(harmonyPage, /mainPageWeb\(controller: webview\.WebviewController, generation: number, proxy: LifelineNativeProxy\)/);
assert.match(harmonyPage, /javaScriptProxy\(\{ object: proxy, name: 'LifelineArkTS', methodList: \['callNative'\], controller: controller \}\)/);
assert.match(harmonyPage, /\.onErrorReceive\([\s\S]*recoverMainPage\([\s\S]*\.onRenderExited\([\s\S]*recoverMainPage\(/,
  'main Harmony renderer failures enter generation-guarded recovery');
assert.match(harmonyPage, /\.onHttpErrorReceive\(\(event\) => \{[\s\S]*shouldRecoverHttpError\([\s\S]*event\.request\.isMainFrame\(\)[\s\S]*event\.response\.getResponseCode\(\)[\s\S]*recoverMainPage\(/,
  'only main-frame HTTP 4xx/5xx responses enter generation-guarded recovery');
assert.ok(recordedSource.has('mobile/harmony/entry/src/main/ets/bridge/MainWebRecoveryPolicy.ets'),
  'Harmony main-page recovery policy is bound in the build receipt');
assert.match(harmonyPage, /url\.URL/);
assert.match(harmonyPage, /onOverrideUrlLoading/);
assert.ok(recordedSource.has('mobile/tests/verify-harmony-external-navigation.mjs'), 'Harmony external-navigation callback test is bound in build receipt');
assert.match(harmonyPage, /parsed\.origin !== LOCAL_ORIGIN/);
assert.match(harmonyPage, /存储初始化仍在等待/, 'pending storage startup has a bounded visible state');
assert.match(harmonyPage, /Button\('重试初始化'\)/, 'a settled startup rejection has a Chinese retry control');
assert.match(harmonyPage, /aboutToDisappear\(\)[\s\S]*WebControllerRegistry\.detach\(this\.controller\)/,
  'page teardown detaches its controller by identity');
assert.match(harmonyPage, /\.onPageEnd\([\s\S]*WebControllerRegistry\.markReady\(controller\)/,
  'lifecycle scripts are enabled only after the Web page finishes loading');
const harmonyAbility = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
assert.match(harmonyAbility, /onForeground\(\)[\s\S]*lifeline:foreground/);
assert.match(harmonyAbility, /onBackground\(\)[\s\S]*lifeline:background/);
assert.match(harmonyAbility, /hostContentRecovery\.start\(windowStage\)/);
assert.match(harmonyAbility, /onWindowStageDestroy\(\)[\s\S]*hostContentRecovery\.destroyStage\(\)/);
const harmonyRecovery = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/bridge/HostContentRecovery.ets'), 'utf8');
const harmonyRecoveryPage = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/pages/HostRecovery.ets'), 'utf8');
const harmonyPages = JSON.parse(await readFile(path.join(mobileRoot, 'harmony/entry/src/main/resources/base/profile/main_pages.json'), 'utf8'));
assert.deepEqual(harmonyPages.src, ['pages/Index', 'pages/HostRecovery']);
assert.match(harmonyRecovery, /recoveryAttempted/);
assert.match(harmonyRecovery, /if \(this\.stage !== stage \|\| this\.generation !== generation \|\| this\.pending \|\| this\.recoveryAttempted\) return/);
assert.match(harmonyRecovery, /this\.activeRequestId === requestId/);
assert.match(harmonyRecoveryPage, /重试打开/);
const harmonyRegistry = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/bridge/WebControllerRegistry.ets'), 'utf8');
assert.match(harmonyRegistry, /runJavaScript/);
assert.match(harmonyRegistry, /catch \(error\)[\s\S]*Could not dispatch/,
  'synchronous WebView invocation failures are contained');
assert.match(harmonyRegistry, /\.catch\(\(error: Error\)/,
  'asynchronous WebView invocation failures are contained');
assert.match(harmonyProxy, /SESSION_KEY/);
assert.match(harmonyProxy, /TOMBSTONE/);
assert.match(harmonyProxy, /await this\.store\.flush\(\)/);
assert.match(harmonyProxy, /cache consistency check failed after flush/);
assert.match(harmonyProxy, /LifelineNativeProxy\.queue\.then/);
assert.match(harmonyProxy, /private static activeShareIds:[\s\S]*private static activeImportId:/,
  'system share and picker leases survive renderer proxy recreation');
assert.match(harmonyProxy, /NetworkStatusMonitor\.start/);
assert.match(harmonyNetworkMonitor, /from '@kit\.NetworkKit'/);
assert.match(harmonyNetworkMonitor, /register\(/);
assert.match(harmonyNetworkMonitor, /unregister\(/);
assert.ok(recordedSource.has('mobile/harmony/entry/src/main/ets/bridge/NetworkStatusMonitor.ets'), 'Harmony network monitor is bound in the build receipt');
assert.match(await readFile(path.join(dist, 'platform/harmony-native-bridge.js'), 'utf8'), /__lifelineNativeComplete/);
assert.match(await readFile(path.join(dist, 'platform/harmony-bridge.js'), 'utf8'), /\.\/capability-contract\.js/);
assert.match(await readFile(path.join(dist, 'platform/mobile-bridge.js'), 'utf8'), /LifelineCapabilities/);
assert.match(await readFile(path.join(dist, 'platform/haptics-controller.js'), 'utf8'), /MOVE_HAPTICS_STORAGE_KEY/);
assert.match(await readFile(path.join(dist, 'mobile-entry.js'), 'utf8'), /__LIFELINE_CREATE_MOVE_HAPTICS_CONTROLLER__/);
assert.ok(recordedSource.has('mobile/src/haptics-controller.js'), 'haptics controller is bound in build receipt');
assert.ok(recordedSource.has('mobile/tests/verify-move-haptics.mjs'), 'haptics lifecycle regressions are bound in build receipt');
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineHapticsPlugin.java'), 'Android haptics plugin is bound in build receipt');
await readFile(path.join(dist, 'platform/capability-contract.js'));
const packedNetworkStatus = path.join(dist, 'platform/network-status.js');
assert.equal(await hash(packedNetworkStatus), await hash(path.join(mobileRoot, 'src/network-status.js')),
  'shared network-status controller is copied unchanged into the offline platform bundle');
assert.ok(recordedSource.has('mobile/src/network-status.js'), 'network-status controller is bound in the build receipt');
assert.ok(recordedSource.has('mobile/tests/verify-network-status.mjs'), 'network-status regressions are bound in the build receipt');
assert.ok(recordedSource.has('mobile/tests/verify-harmony-network-monitor.mjs'), 'Harmony network monitor regressions are bound in the build receipt');

const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const entry = await readFile(path.join(dist, 'mobile-entry.js'), 'utf8');
const styles = await readFile(path.join(dist, 'styles.css'), 'utf8');
assert.match(index, /vendor\/vue\.global\.prod\.js/);
assert.match(index, /vendor\/mathjax\/es5\/tex-chtml\.js/);
assert.match(index, /mobile-entry\.js/);
assert.doesNotMatch(index, /https:\/\/cdn\.|fonts\.googleapis\.com/);
assert.doesNotMatch(styles, /fonts\.googleapis\.com/);
assert.match(entry, /const platform = selectMobilePlatform\(\);[\s\S]*import\(platform === "harmony" \? "\.\/platform\/harmony-bridge\.js" : "\.\/platform\/mobile-bridge\.js"\)[\s\S]*await import\("\.\/main\.js\?/);
assert.match(entry, /showStartupFailure[\s\S]*重试启动[\s\S]*location\.reload\(\)/, 'generated entry exposes an explicit startup retry');
assert.doesNotMatch(entry, /unhandledrejection|Promise\.race/, 'startup does not consume global rejection events or race uncancelled initialization');
const mobileBridgeBundle = await readFile(path.join(dist, 'platform/mobile-bridge.js'), 'utf8');
assert.match(mobileBridgeBundle, /new Promise\(\(\w+, \w+\) => \w+\.then\(\(\) => \w+\(\{ remove:/, 'built Capacitor listener promise forwards rejection');
assert.match(mobileBridgeBundle, /LifelineNetwork/);
assert.match(mobileBridgeBundle, /networkStatusChange/);
assert.match(mobileBridgeBundle, /getNetworkStatus/);
assert.match(mobileBridgeBundle, /subscribeNetworkStatus/);
assert.match(await readFile(path.join(dist, 'platform/mobile-bridge.js'), 'utf8'), /LifelineStorage/);
assert.match(await readFile(path.join(dist, 'platform/harmony-bridge.js'), 'utf8'), /LifelineBridge\.loadRecord/);
assert.match(await readFile(path.join(dist, 'platform/session-authority.js'), 'utf8'), /\.\.\/LocalGameSession\.js\?/);
for (const name of ['session-authority.js', 'session-envelope.js']) await readFile(path.join(dist, 'platform', name));
for (const name of ['session-mirror.js', 'session-recovery.js']) await readFile(path.join(dist, 'platform', name));
assert.match(await readFile(path.join(dist, 'platform/harmony-native-bridge.js'), 'utf8'), /Harmony native request timed out/);
assert.match(await readFile(path.join(dist, 'platform/harmony-native-bridge.js'), 'utf8'), /pageNonce/);
const androidPlugin = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineStoragePlugin.java'), 'utf8');
const androidCapabilities = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java'), 'utf8');
const androidReplayImport = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineReplayImportPlugin.java'), 'utf8');
const androidTutorialHost = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java'), 'utf8');
const androidHaptics = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineHapticsPlugin.java'), 'utf8');
const androidNetwork = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/LifelineNetworkPlugin.java'), 'utf8');
const androidActivity = await readFile(path.join(mobileRoot, 'android/app/src/main/java/cn/lifelinegame/mobile/MainActivity.java'), 'utf8');
const androidManifest = await readFile(path.join(mobileRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const capacitorBridge = await readFile(path.join(mobileRoot, 'src/mobile-bridge.js'), 'utf8');
assert.match(capacitorBridge, /getCapabilities:\s*native\s*\?\s*\(\)\s*=>\s*queryCapabilities/);
assert.doesNotMatch(capacitorBridge, /getCapabilities\(\)/, 'platform initialization does not eagerly query capabilities');
const harmonyBridgeSource = await readFile(path.join(mobileRoot, 'src/harmony-bridge.js'), 'utf8');
assert.match(harmonyBridgeSource, /getCapabilities:\s*\(\)\s*=>\s*queryCapabilities/);
assert.doesNotMatch(harmonyBridgeSource, /getCapabilities\(\)/, 'Harmony initialization does not eagerly query capabilities');
assert.match(capacitorBridge, /initializeSessionAuthority/);
assert.match(capacitorBridge, /flushSessionMirror: \(\) => nativeStorage\.flushSessionMirror\(\)/);
assert.match(androidActivity, /registerPlugin\(LifelineStoragePlugin\.class\)/);
assert.match(androidActivity, /registerPlugin\(LifelineCapabilitiesPlugin\.class\)/);
assert.match(androidActivity, /registerPlugin\(LifelineNetworkPlugin\.class\)/);
assert.match(androidActivity, /registerPlugin\(LifelineHapticsPlugin\.class\)/);
assert.match(androidActivity, /registerPlugin\(LifelineReplayImportPlugin\.class\)/);
assert.match(androidActivity, /registerPlugin\(LifelineTutorialHostPlugin\.class\)/);
assert.match(androidActivity, /MainRendererRecoveryCoordinator/);
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/MainRendererRecoveryCoordinator.java'),
  'Android renderer recovery coordinator is bound in the build receipt');
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/MainPageRecoveryWebViewClient.java'),
  'Android main-page recovery WebView client is bound in the build receipt');
assert.ok(recordedSource.has('mobile/android/app/src/test/java/cn/lifelinegame/mobile/MainRendererRecoveryCoordinatorTest.java'),
  'Android renderer recovery regression test is bound in the build receipt');
assert.match(androidCapabilities, /tutorialHost.*implemented.*native/s);
assert.match(androidTutorialHost, /uri\.getQueryParameterNames\(\)\.size\(\) == 1/);
assert.match(androidTutorialHost, /new WebView\(activity\)/);
assert.match(androidReplayImport, /ACTION_OPEN_DOCUMENT/);
assert.match(androidReplayImport, /MAX_BYTES = 4_000_000/);
assert.match(androidReplayImport, /CodingErrorAction\.REPORT/);
assert.match(androidReplayImport, /status\", \"cancelled/);
assert.match(androidReplayImport, /status\", \"selected/);
assert.match(androidReplayImport, /activeCallId/);
assert.match(androidReplayImport, /activePickerCall != call/);
assert.match(androidReplayImport, /callbackGeneration != pageGeneration/);
assert.match(androidReplayImport, /call\.release\(getBridge\(\)\)/);
assert.doesNotMatch(androidReplayImport, /put\(\"(?:path|uri|url)\"/i, 'Android picker URI and filesystem paths never leave the native plugin');
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineReplayImportPlugin.java'), 'Android replay picker is bound in build receipt');
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java'), 'Android tutorial host is bound in build receipt');
assert.match(androidHaptics, /HapticFeedbackConstants\.VIRTUAL_KEY/);
assert.doesNotMatch(androidHaptics, /VIBRATE/);
assert.match(androidHaptics, /MAX_DISPATCH_AGE_MS = 350/);
assert.match(androidHaptics, /pageGeneration/);
assert.match(androidHaptics, /!foreground \|\| !pageReady \|\| inFlight/);
assert.match(androidHaptics, /foreground = false; pageGeneration\+\+/);
assert.match(androidHaptics, /isAttachedToWindow\(\).*isShown\(\)/s);
assert.match(androidHaptics, /handleOnDestroy/);
assert.match(androidManifest, /android\.permission\.ACCESS_NETWORK_STATE/);
const harmonyManifest = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/module.json5'), 'utf8');
assert.match(harmonyManifest, /ohos\.permission\.VIBRATE/);
assert.match(harmonyProxy, /@kit\.SensorServiceKit/);
assert.match(harmonyProxy, /usage: 'touch'/);
assert.match(harmonyProxy, /hapticInFlight/);
assert.match(harmonyProxy, /private static hapticInFlight/);
assert.match(androidNetwork, /@CapacitorPlugin\(name = "LifelineNetwork"\)/);
assert.match(androidNetwork, /registerDefaultNetworkCallback/);
assert.ok(recordedSource.has('mobile/android/app/src/main/AndroidManifest.xml'), 'Android network permission is bound in the build receipt');
assert.ok(recordedSource.has('mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineNetworkPlugin.java'), 'Android network plugin is bound in the build receipt');
assert.match(androidCapabilities, /@CapacitorPlugin\(name = "LifelineCapabilities"\)/);
assert.match(androidCapabilities, /call\.getData\(\)\.length\(\) != 1/);
assert.match(androidCapabilities, /schemaVersion/);
assert.match(androidCapabilities, /replayImport.*implemented.*native/s);
assert.match(capacitorBridge, /getCapabilities:/);
assert.match(capacitorBridge, /source: 'capacitor-webview-fallback'/);
assert.match(await readFile(path.join(mobileRoot, 'src/harmony-bridge.js'), 'utf8'), /source: 'harmony-webview-fallback'/);
assert.match(await readFile(path.join(mobileRoot, 'src/harmony-bridge.js'), 'utf8'), /getCapabilities: \(\) => queryCapabilities/);
assert.match(androidPlugin, /@CapacitorPlugin\(name = "LifelineStorage"\)/);
assert.match(androidPlugin, /stream\.getFD\(\)\.sync\(\)/);
assert.match(androidPlugin, /atomic\.finishWrite\(stream\)/);
assert.match(androidPlugin, /readRaw\(atomic\)/);
assert.match(androidPlugin, /TOMBSTONE/);
assert.match(await readFile(path.join(dist, 'vendor/mathjax/es5/tex-chtml.js'), 'utf8'), /MathJax/);
assert.ok((await readdir(path.join(dist, 'fonts/files'))).length > 0, 'bundled local fonts exist');

const runtimePath = receipt.runtime_config_path;
const { loadRuntimeConfig, canonicalRuntimeConfig } = await import('../tools/runtime-config.mjs');
const runtimeRelative = runtimePath.startsWith('mobile/') ? runtimePath.slice('mobile/'.length) : '';
const runtimeArgs = receipt.runtime_environment === 'release' ? [] : ['--environment', 'staging', '--runtime-config', runtimeRelative];
const runtimeSelection = await loadRuntimeConfig({ mobileRoot, args: runtimeArgs });
assert.equal(runtimePath, `mobile/${runtimeSelection.configRelativePath}`, 'receipt config path is inside mobile and resolves to the selected file');
const runtimeBytes = await readFile(runtimeSelection.configPath);
const runtime = runtimeSelection.config;
const { validateRuntimeConfig } = await import('../tools/runtime-config.mjs');
assert.equal(validateRuntimeConfig(runtime, receipt.runtime_environment), runtime);
assert.equal(createHash('sha256').update(runtimeBytes).digest('hex'), receipt.runtime_config_file_sha256);
assert.equal(createHash('sha256').update(canonicalRuntimeConfig(runtime)).digest('hex'), receipt.runtime_config_sha256);
assert.equal(recordedSource.get(runtimePath), receipt.runtime_config_file_sha256, 'selected runtime config is source-bound');
assert.equal(await readFile(path.join(dist, 'mobile-config.js'), 'utf8'), `globalThis.__LIFELINE_MOBILE_APP__ = true;\nglobalThis.__LIFELINE_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(runtime)});\n`, 'generated config contains exactly the selected runtime fields');

const cspMatch = index.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*>/i);
assert.ok(cspMatch, 'generated mobile document contains a CSP meta policy');
const cspPolicy = cspMatch[1];
assert.equal((index.match(/http-equiv="Content-Security-Policy"/gi) ?? []).length, 1, 'exactly one CSP is emitted');
const cspOffset = index.indexOf(cspMatch[0]);
const firstResourceOffset = index.search(/<(?:script|link)\b/i);
assert.ok(firstResourceOffset >= 0 && cspOffset < firstResourceOffset,
  'CSP appears before the first script or stylesheet resource so it governs the full document load');
assert.equal(createHash('sha256').update(cspPolicy).digest('hex'), receipt.csp_sha256, 'receipt binds the emitted CSP');
const directives = new Map(cspPolicy.split(';').map((directive) => {
  const [name, ...sources] = directive.trim().split(/\s+/);
  assert.ok(name && sources.length, `CSP directive has sources: ${directive}`);
  return [name, sources];
}));
assert.deepEqual([...directives.keys()].sort(), [
  'base-uri', 'connect-src', 'default-src', 'font-src', 'form-action', 'frame-src', 'img-src',
  'object-src', 'script-src', 'style-src', 'worker-src',
].sort(), 'CSP directives are explicit and minimal');
assert.deepEqual(directives.get('default-src'), ["'self'"]);
assert.deepEqual(directives.get('script-src'), ["'self'", "'unsafe-eval'"],
  'the only script exception is Vue runtime compilation for the existing template strings');
assert.ok(!cspPolicy.includes("'unsafe-inline'" ) || directives.get('style-src').includes("'unsafe-inline'"),
  'unsafe-inline is limited to the existing inline styles');
assert.deepEqual(directives.get('style-src'), ["'self'", "'unsafe-inline'"]);
assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:']);
assert.deepEqual(directives.get('font-src'), ["'self'", 'data:', 'blob:']);
assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:']);
assert.deepEqual(directives.get('object-src'), ["'none'"]);
assert.deepEqual(directives.get('base-uri'), ["'none'"]);
assert.deepEqual(directives.get('form-action'), ["'none'"]);
assert.deepEqual(directives.get('frame-src'), ["'none'"]);
const expectedConnectOrigins = [...new Set([runtime.apiBaseUrl, runtime.websocketUrl, runtime.trainingContributionUrl]
  .map((endpoint) => new URL(endpoint).origin))].sort();
assert.deepEqual(directives.get('connect-src').slice(1).sort(), expectedConnectOrigins,
  'online-app connect-src contains only validated runtime endpoint origins plus self');
assert.ok(directives.get('connect-src').includes("'self'"));
const mobileBuilderSource = await readFile(path.join(mobileRoot, 'tools/build-web.mjs'), 'utf8');
assert.match(mobileBuilderSource,
  /getAll\("tutorial"\)\.length === 1[\s\S]*?tutorialPolicy\.content = .*connect-src/,
  'standalone tutorial applies an additional connect-src none policy before importing app modules');
assert.doesNotMatch(cspPolicy, /(?:https:|wss:|\*)\s*(?:;|$)/, 'CSP has no wildcard scheme or wildcard source');
assert.ok(!cspPolicy.includes("'unsafe-eval'") || receipt.vue_runtime_compiler_csp_exception ===
  'unsafe-eval required by bundled Vue runtime compiler for current component template strings');
assert.equal(receipt.vue_runtime_compiler_csp_exception,
  'unsafe-eval required by bundled Vue runtime compiler for current component template strings');
const vueRuntimeCompiler = await readFile(path.join(dist, 'vendor/vue.global.prod.js'), 'utf8');
assert.match(vueRuntimeCompiler, /Function\(l\)/, 'bundled Vue runtime compiler invokes the Function constructor');
assert.match(await readFile(path.join(repoRoot, 'web/web前端/OnlineApp.js'), 'utf8'), /template:\s*`/,
  'current Vue components supply template strings that require the runtime compiler');
const scriptTags = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
assert.ok(scriptTags.length > 0);
assert.ok(scriptTags.every(([, attributes, body]) => /\bsrc\s*=/.test(attributes) && !body.trim()),
  'every generated script is external and no inline script remains');
for (const [, attributes] of scriptTags) {
  const src = attributes.match(/\bsrc="([^"]+)"/i)?.[1];
  assert.ok(src && !/^(?:https?:)?\/\//i.test(src), `script source is local: ${src}`);
}
assert.match(index, /mathjax-config\.js/);
assert.equal(receipt.mathjax_config_sha256, await hash(path.join(dist, 'mathjax-config.js')),
  'build receipt binds the generated local MathJax configuration');
const sourceIndexForMathJax = await readFile(path.join(repoRoot, 'web/web前端/index.html'), 'utf8');
const sourceMathJaxConfigs = [...sourceIndexForMathJax.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && /\bwindow\.MathJax\s*=/.test(body));
assert.equal(sourceMathJaxConfigs.length, 1, 'source retains exactly one MathJax configuration for the mobile extraction');
assert.equal(await readFile(path.join(dist, 'mathjax-config.js'), 'utf8'), `${sourceMathJaxConfigs[0][2].trim()}\n`,
  'local MathJax configuration is byte-for-byte equivalent to the source inline configuration body');
assert.doesNotMatch(index, /https?:\/\/[^"'\s>]+\.js/i, 'generated document has no remote script URLs');

const order = [];
let releaseFirstWrite;
const mirror = createSerializedSessionMirror({
  write: async (value) => {
    order.push(`write-start:${value}`);
    if (value === 'old') await new Promise((resolve) => { releaseFirstWrite = resolve; });
    order.push(`write-end:${value}`);
  },
  remove: async () => { order.push('remove'); },
});
const savingOld = mirror.save('old');
const clearing = mirror.clear();
const savingNew = mirror.save('new');
await new Promise((resolve) => setImmediate(resolve));
releaseFirstWrite();
await Promise.all([savingOld, clearing, savingNew]);
assert.deepEqual(order, ['write-start:old', 'write-end:old', 'remove', 'write-start:new', 'write-end:new']);

let releaseQueuedWrite;
let failQueuedClear;
const revisionMirror = createSerializedSessionMirror({
  write: async (value) => {
    if (value === 'first') await new Promise((resolve) => { releaseQueuedWrite = resolve; });
    if (value === 'second') await new Promise((resolve) => { releaseQueuedWrite = resolve; });
  },
  remove: async () => new Promise((_resolve, reject) => { failQueuedClear = reject; }),
});
const firstWrite = revisionMirror.save('first');
const secondWrite = revisionMirror.save('second');
assert.equal(firstWrite.isCurrent(), false, 'older save cannot claim latest storage state');
await new Promise((resolve) => setImmediate(resolve));
releaseQueuedWrite();
await firstWrite;
assert.equal(secondWrite.isCurrent(), true, 'latest save owns confirmed status');
const failedClear = revisionMirror.clear();
assert.equal(secondWrite.isCurrent(), false, 'queued clear invalidates older save status');
await new Promise((resolve) => setImmediate(resolve));
releaseQueuedWrite();
await secondWrite;
await new Promise((resolve) => setImmediate(resolve));
failQueuedClear(new Error('simulated flush failure'));
await assert.rejects(failedClear, /simulated flush failure/);
assert.equal(failedClear.isCurrent(), true, 'latest failed operation owns the error state');
await assert.rejects(revisionMirror.settled(), /simulated flush failure/, 'callers can await and observe the latest native failure');

console.log(JSON.stringify({ status: 'PASS-CURRENT', release_files: 74, current_web_sync_files: Object.keys(currentWebSyncManifest.source_files).length, model_hashes: 18, offline_entry: true, serialized_session_mirror: 'save-clear-save' }));
