import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditR16LiveWebRuntimeDelta, captureR16BaselineSnapshot } from '../tools/audit-live-web-runtime-delta-r16.mjs';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-r16-delta-'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const r16ReceiptPath = 'docs/verification/mobile-harmony-session-presence-l35-b-20261024.json';
const webReceiptPath = 'mobile/local_artifacts/mobile-web-build-receipt.json';
let fixtureCount = 0;

async function put(root, name, source) {
  const full = path.join(root, ...name.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, source);
}

async function fixture({ wiredExperiment = false, adapted = false } = {}) {
  fixtureCount += 1;
  const fixtureRoot = path.join(tempRoot, `fixture-${fixtureCount}`);
  const sourceWebRoot = path.join(fixtureRoot, 'web');
  const mobileWebRoot = path.join(fixtureRoot, 'mobile');
  await mkdir(sourceWebRoot, { recursive: true });
  await mkdir(mobileWebRoot, { recursive: true });
  const files = {
    'index.html': '<script type="module" src="./main.js"></script>',
    'main.js': `import "./Core.js"; import "./MultiplayerUltimateAdmission.js";${wiredExperiment ? ' import "./Experiment.js";' : ''}`,
    'Core.js': 'export const ready = true;',
    'MultiplayerUltimateAdmission.js': 'export const ACCEPTED_ULTIMATE_RELEASES = Object.freeze([]);',
    'HardWorker.bundle.mjs': 'export const worker = true;',
    'MultiplayerHardResources.js': 'export const resource = "fixture";',
    'Experiment.js': 'export const candidate = true;',
    'guide.md': 'accepted guide content',
    'tests/check.txt': 'fixture test evidence',
    'research.training-receipt.json': '{"formal":false}',
  };
  for (const [name, source] of Object.entries(files)) await put(sourceWebRoot, name, source);
  for (const name of ['index.html', 'main.js', 'Core.js', 'MultiplayerUltimateAdmission.js', 'HardWorker.bundle.mjs']) {
    await put(mobileWebRoot, name, files[name]);
  }
  const mobileCore = adapted ? 'export const ready = "mobile";' : files['Core.js'];
  await put(mobileWebRoot, 'Core.js', mobileCore);
  const experiment = {
    path: 'Experiment.js', source_sha256: hash(files['Experiment.js']),
    classification: wiredExperiment ? 'wired_unqualified_runtime_path' : 'unwired_unqualified_experiment',
    runtime_reachable: wiredExperiment, packaged: false, direct_imports: [],
    reason: 'Fixture experiment is not admitted to the product.',
  };
  const bundleInternal = {
    path: 'MultiplayerHardResources.js', source_sha256: hash(files['MultiplayerHardResources.js']),
    classification: 'bundle_internal_source', bundle: 'HardWorker.bundle.mjs', packaged: false,
    reason: 'Fixture helper is represented by the admitted bundle.',
  };
  const mobileAdaptation = adapted ? [{ path: 'Core.js', source_sha256: hash(files['Core.js']),
    mobile_sha256: hash(mobileCore), reason: 'Fixture reviewed mobile adaptation.' }] : [];
  const syncManifest = {
    schema: 'lifeline-mobile-current-web-sync-source-v1', release_id: 'fixture-r16', asset_version: 'fixture-current16',
    source_files: Object.fromEntries(['main.js', 'Core.js', 'MultiplayerUltimateAdmission.js', 'HardWorker.bundle.mjs']
      .map((name) => [name, hash(files[name])])),
    mobile_adaptations: mobileAdaptation, mobile_only_extras: [], required_runtime_closure: ['main.js'],
    excluded_live_unwired_experiments: wiredExperiment ? [] : [experiment],
    excluded_live_wired_unqualified_experiments: wiredExperiment ? [experiment] : [],
    bundle_internal_sources: [bundleInternal],
    classification_rules: { temporary_prefixes: ['tests/.test-tmp/'], test_prefixes: ['tests/'], exact_test_paths: [], research_receipt_suffixes: ['.training-receipt.json'] },
  };
  const runtimeManifest = {
    schema: 'lifeline-mobile-runtime-source-manifest-v1', runtime_asset_version: 'fixture-l34a1',
    files: ['main.js', 'Core.js', 'MultiplayerUltimateAdmission.js', 'HardWorker.bundle.mjs'],
    required_runtime_closure: ['main.js'], mobile_adaptations: mobileAdaptation, excluded_live_unwired_experiments: wiredExperiment ? [] : [experiment],
    excluded_live_wired_unqualified_experiments: wiredExperiment ? [experiment] : [], bundle_internal_sources: [bundleInternal],
  };
  const syncManifestBytes = Buffer.from(JSON.stringify(syncManifest));
  const runtimeManifestBytes = Buffer.from(JSON.stringify(runtimeManifest));
  const webBuildReceiptBytes = Buffer.from('{"status":"PASS-CURRENT","fixture":true}');
  await put(fixtureRoot, 'mobile/local_artifacts/mobile-web-build-receipt.json', webBuildReceiptBytes);
  await put(fixtureRoot, 'mobile/src/NativeHost.java', 'class NativeHost { static final int VERSION = 1; }');
  const l35bReceipt = { status: 'PASS_SCOPED_R16_HARMONY_SESSION_PRESENCE_PACKAGES',
    source: { postR16WebDelta: 'NO_POST_R16_WEB_DELTA' },
    webBuildReceipt: { path: webReceiptPath, sha256: hash(webBuildReceiptBytes) } };
  const l35bReceiptBytes = Buffer.from(JSON.stringify(l35bReceipt));
  const baseline = await captureR16BaselineSnapshot({ sourceWebRoot, mobileWebRoot, syncManifest, runtimeManifest,
    syncManifestBytes, runtimeManifestBytes, l35bReceiptPath: r16ReceiptPath, l35bReceipt, l35bReceiptBytes });
  return { sourceWebRoot, mobileWebRoot, syncManifest, runtimeManifest, syncManifestBytes, runtimeManifestBytes,
    baseline, l35bReceiptPath: r16ReceiptPath, l35bReceiptBytes,
    currentBuildReceiptPath: path.join(fixtureRoot, ...webReceiptPath.split('/')),
    nativeHostSourcePath: path.join(fixtureRoot, 'mobile/src/NativeHost.java') };
}

async function audit(f) {
  return auditR16LiveWebRuntimeDelta(f);
}

try {
  const clean = await fixture();
  assert.equal((await audit(clean)).status, 'NO_NEW_RUNTIME_DELTA');
  assert.equal(clean.baseline.accepted_checkpoint, 'R16/L35-B');
  assert.equal(clean.baseline.runtime_closure.file_count, 3);
  assert.equal(clean.baseline.bundle_internal_sources.length, 1);
  assert.equal(clean.baseline.bindings.historical_web_build_receipt.sha256,
    JSON.parse(clean.l35bReceiptBytes).webBuildReceipt.sha256);
  await writeFile(clean.nativeHostSourcePath, 'class NativeHost { static final int VERSION = 2; }');
  await writeFile(clean.currentBuildReceiptPath, '{"status":"PASS-CURRENT","fixture":true,"nativeHostVersion":2}');
  assert.equal((await audit(clean)).status, 'NO_NEW_RUNTIME_DELTA',
    'a current Web build receipt rewritten after mobile-host-only changes is not the frozen L35-B Web receipt');

  const bindingDrift = { ...clean, syncManifestBytes: Buffer.from(`${clean.syncManifestBytes} `) };
  const driftReport = await audit(bindingDrift);
  assert.equal(driftReport.status, 'FAIL_CLOSED_BASELINE_BINDING_DRIFT');
  assert(driftReport.changedBindings.includes('current-web-sync-manifest'));
  const runtimeBindingDrift = { ...clean, runtimeManifestBytes: Buffer.from(`${clean.runtimeManifestBytes} `) };
  const runtimeDriftReport = await audit(runtimeBindingDrift);
  assert.equal(runtimeDriftReport.status, 'FAIL_CLOSED_BASELINE_BINDING_DRIFT');
  assert(runtimeDriftReport.changedBindings.includes('mobile-runtime-manifest'));

  const adapted = await fixture({ adapted: true });
  await put(adapted.mobileWebRoot, 'Core.js', 'export const ready = "unreviewed mobile change";');
  assert.equal((await audit(adapted)).status, 'FAIL_CLOSED_MOBILE_ADAPTATION_DRIFT');

  await put(clean.sourceWebRoot, 'Core.js', 'export const ready = false;');
  const runtimeDrift = await audit(clean);
  assert.equal(runtimeDrift.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');
  assert.deepEqual(runtimeDrift.runtimeCandidates.map((item) => item.path), ['Core.js']);
  await put(clean.sourceWebRoot, 'Core.js', 'export const ready = true;');

  await put(clean.sourceWebRoot, 'guide.md', 'new explanatory text');
  await put(clean.sourceWebRoot, 'tests/check.txt', 'new test evidence');
  await put(clean.sourceWebRoot, 'research.training-receipt.json', '{"formal":true}');
  await put(clean.sourceWebRoot, 'MultiplayerHardResources.js', 'export const resource = "new bundle build input";');
  const evidenceDrift = await audit(clean);
  assert.equal(evidenceDrift.status, 'NO_NEW_RUNTIME_DELTA');
  assert.deepEqual(evidenceDrift.classifiedNonRuntimeChanges.documentationAndGuides.map((item) => item.path), ['guide.md']);
  assert.deepEqual(evidenceDrift.classifiedNonRuntimeChanges.testsAndBenchmarks.map((item) => item.path), ['tests/check.txt']);
  assert.deepEqual(evidenceDrift.classifiedNonRuntimeChanges.trainingAndResearchEvidence.map((item) => item.path), ['research.training-receipt.json']);
  assert.deepEqual(evidenceDrift.classifiedNonRuntimeChanges.bundleInternalSources.map((item) => item.path), ['MultiplayerHardResources.js']);

  const wired = await fixture();
  const wiredRecord = { path: 'Experiment.js', source_sha256: hash('export const candidate = true;'),
    classification: 'wired_unqualified_runtime_path', runtime_reachable: true, packaged: false, direct_imports: [],
    reason: 'Fixture experiment is not admitted to the product.' };
  await put(wired.sourceWebRoot, 'main.js', 'import "./Core.js"; import "./MultiplayerUltimateAdmission.js"; import "./Experiment.js";');
  wired.syncManifest.excluded_live_unwired_experiments = [];
  wired.syncManifest.excluded_live_wired_unqualified_experiments = [wiredRecord];
  wired.runtimeManifest.excluded_live_unwired_experiments = [];
  wired.runtimeManifest.excluded_live_wired_unqualified_experiments = [wiredRecord];
  wired.syncManifestBytes = Buffer.from(JSON.stringify(wired.syncManifest));
  wired.runtimeManifestBytes = Buffer.from(JSON.stringify(wired.runtimeManifest));
  wired.baseline.bindings.sync_manifest_sha256 = hash(wired.syncManifestBytes);
  wired.baseline.bindings.runtime_manifest_sha256 = hash(wired.runtimeManifestBytes);
  const wiredReport = await audit(wired);
  assert.equal(wiredReport.status, 'FAIL_CLOSED_UNQUALIFIED_RUNTIME');
  assert.equal(wiredReport.unqualifiedWiredRuntimePaths[0].path, 'Experiment.js');

  await put(clean.sourceWebRoot, 'MultiplayerUltimateAdmission.js', 'export const ACCEPTED_ULTIMATE_RELEASES = Object.freeze([{ modelId: "multiplayer-ultimate-v1" }]);');
  const ultimateReport = await audit(clean);
  assert.equal(ultimateReport.status, 'FAIL_CLOSED_ULTIMATE_NOT_ADMITTED');
  process.stdout.write('PASS R16 live Web delta baseline binding, runtime drift, non-runtime evidence, bundle internals, and fail-closed experiment/Ultimate cases\n');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
