import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLiveWebRuntimeDelta } from '../tools/audit-live-web-runtime-delta.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const toolPath = path.join(mobileRoot, 'tools/audit-live-web-runtime-delta.mjs');
const auditRelative = 'docs/verification/mobile-current-web-post-r13-delta-audit-20261024.json';
const auditBytes = await readFile(path.join(repositoryRoot, ...auditRelative.split('/')));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const protectedPaths = [
  'mobile/config/current-web-sync-source-manifest.json',
  'mobile/config/mobile-runtime-source-manifest.json',
  'mobile/package.json',
  'docs/verification/mobile-prototype-20261014/parent-checkpoint-l30-a.json',
];
const protectedBefore = new Map(await Promise.all(protectedPaths.map(async (name) => [name, digest(await readFile(path.join(repositoryRoot, ...name.split('/'))))])));

const shared = {
  'index.html': '<script type="module" src="./main.js?v=fixture"></script>',
  'main.js': 'import "./Core.js";',
  'Core.js': 'export const ready = true;',
};
const sourceBase = {
  ...shared,
  'Adapt.js': 'export const platform = "web";',
  'Hard.js': 'export const admitted = false;',
  'model.training-receipt.json': '{"formal":false}',
  'tests/check.mjs': 'export const check = true;',
  'tests/.test-tmp/generated.mjs': 'export const scratch = true;',
};
const mobileBase = {
  ...shared,
  'Adapt.js': 'export const platform = "mobile";',
  'MobileOnly.js': 'export const native = true;',
};

async function writeTree(root, files) {
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
}

function sha(source) { return digest(Buffer.from(source)); }

async function makeFixture({ mutateSource, mutateMobile, reviewedMobileOnlyTests = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lifeline-live-delta-'));
  const sourceRoot = path.join(root, 'source');
  const mobileWebRoot = path.join(root, 'mobile');
  await mkdir(sourceRoot);
  await mkdir(mobileWebRoot);
  const sourceFiles = structuredClone(sourceBase);
  const mobileFiles = structuredClone(mobileBase);
  mutateSource?.(sourceFiles);
  mutateMobile?.(mobileFiles);
  await Promise.all([writeTree(sourceRoot, sourceFiles), writeTree(mobileWebRoot, mobileFiles)]);
  const baseline = {
    schema: 'lifeline-mobile-live-runtime-delta-baseline-v1',
    accepted_checkpoint: 'FIXTURE/R13',
    sync_release_id: 'fixture-r13',
    runtime_asset_version: 'fixture-runtime',
    post_r13_audit: { path: auditRelative, sha256: digest(auditBytes) },
    reviewed_runtime_differences: [{
      path: 'Adapt.js', source_sha256: sha(sourceBase['Adapt.js']), mobile_sha256: sha(mobileBase['Adapt.js']),
      classification: 'reviewed_semantic_adaptation',
    }],
    mobile_only_runtime: [{ path: 'MobileOnly.js', sha256: sha(mobileBase['MobileOnly.js']), reason: 'Fixture native path.' }],
    excluded_hard: [{ path: 'Hard.js', sha256: sha(sourceBase['Hard.js']), product_admitted: false, reason: 'Fixture Hard path is unqualified.' }],
    reviewed_mobile_only_tests: reviewedMobileOnlyTests,
    classification_rules: {
      temporary_prefixes: ['tests/.test-tmp/'],
      test_prefixes: ['tests/'],
      exact_test_paths: [],
      research_receipt_suffixes: ['.training-receipt.json'],
    },
  };
  const sync = {
    release_id: 'fixture-r13',
    source_files: Object.fromEntries(Object.entries(shared).map(([name, value]) => [name, sha(value)])),
    mobile_adaptations: [],
  };
  const runtime = { runtime_asset_version: 'fixture-runtime', files: Object.keys(shared), mobile_adaptations: [] };
  const syncBytes = Buffer.from(JSON.stringify(sync));
  const runtimeBytes = Buffer.from(JSON.stringify(runtime));
  baseline.sync_manifest_sha256 = digest(syncBytes);
  baseline.runtime_manifest_sha256 = digest(runtimeBytes);
  const baselinePath = path.join(root, 'baseline.json');
  const syncManifestPath = path.join(root, 'sync.json');
  const runtimeManifestPath = path.join(root, 'runtime.json');
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(baseline)),
    writeFile(syncManifestPath, syncBytes),
    writeFile(runtimeManifestPath, runtimeBytes),
  ]);
  return { root, sourceRoot, mobileWebRoot, baselinePath, syncManifestPath, runtimeManifestPath };
}

async function runFixture(options) {
  const fixture = await makeFixture(options);
  try {
    return await auditLiveWebRuntimeDelta({ ...fixture, sourceWebRoot: fixture.sourceRoot,
      mobileWebRoot: fixture.mobileWebRoot, includeGit: false });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

const clean = await runFixture();
assert.equal(clean.status, 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA');
assert.equal(clean.differencePathCount, 6);
assert.equal(clean.classifiedDifferencePathCount, 6);
assert.deepEqual(clean.classificationCounts, {
  generatedTestScratch: 1,
  testsAndBenchmarks: 1,
  researchReceipts: 1,
  excludedHard: 1,
  mobileOnlyRuntime: 1,
  reviewedRuntimeDifferences: 1,
  adaptationChanges: 0,
  runtimeCandidates: 0,
  hardPolicyViolations: 0,
});

const newProduct = await runFixture({ mutateSource: (files) => { files['NewFeature.js'] = 'export const feature = true;'; } });
assert.equal(newProduct.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');
assert.deepEqual(newProduct.classifications.runtimeCandidates.map((item) => item.path), ['NewFeature.js']);

const newHardName = await runFixture({ mutateSource: (files) => { files['HardFoo.js'] = 'export const candidate = true;'; } });
assert.deepEqual(newHardName.classifications.runtimeCandidates.map((item) => item.path), ['HardFoo.js'],
  'a name containing Hard is not silently excluded');

const changedKnownHard = await runFixture({ mutateSource: (files) => { files['Hard.js'] += '\nexport const changed = true;'; } });
assert.equal(changedKnownHard.status, 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA');
assert.equal(changedKnownHard.classifications.excludedHard[0].baselineChanged, true);

const reachableHard = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; import "./Hard.js";';
} });
assert.equal(reachableHard.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA',
  'a new import of a known Hard artifact makes the changed caller require review');
assert(reachableHard.classifications.excludedHard.some((item) => item.path === 'Hard.js'),
  'an unchanged, frozen Hard source may remain excluded when the live Web caller is reviewed');

const reachableChangedHard = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; import "./Hard.js";';
  files['Hard.js'] += '\nexport const admitted = true;';
} });
assert.equal(reachableChangedHard.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');
assert(reachableChangedHard.classifications.hardPolicyViolations.some((item) => item.path === 'Hard.js'),
  'a reachable excluded Hard artifact changed from its frozen hash must require review');

const hardInMobile = await runFixture({ mutateMobile: (files) => { files['Hard.js'] = sourceBase['Hard.js']; } });
assert.equal(hardInMobile.baselinePolicyViolations.length, 1);
assert.equal(hardInMobile.reviewRequiredCount, 1);

const adaptationDrift = await runFixture({ mutateSource: (files) => { files['Adapt.js'] += '\nexport const changed = true;'; } });
assert.deepEqual(adaptationDrift.classifications.adaptationChanges.map((item) => item.path), ['Adapt.js']);

const testsOnly = await runFixture({ mutateSource: (files) => {
  files['tests/new-check.mjs'] = 'export const check = true;';
  files['tests/.test-tmp/new-scratch.mjs'] = 'export const scratch = true;';
} });
assert.equal(testsOnly.status, 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA');
assert.equal(testsOnly.classifications.testsAndBenchmarks.length, 2);
assert.equal(testsOnly.classifications.generatedTestScratch.length, 2);

const reachableTemporaryRuntime = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; import "./tests/.test-tmp/NewRuntime.js";';
  files['tests/.test-tmp/NewRuntime.js'] = 'export const runtime = true;';
} });
assert(reachableTemporaryRuntime.classifications.runtimeCandidates.some((item) => item.path === 'tests/.test-tmp/NewRuntime.js'),
  'runtime reachability takes precedence over the temporary-test exemption');

const equalSharedReachableTest = await runFixture({
  mutateSource: (files) => {
    files['main.js'] = 'import "./Core.js"; import "./tests/.test-tmp/shared-runtime.json";';
    files['tests/.test-tmp/shared-runtime.json'] = '{}';
  },
  mutateMobile: (files) => {
    files['main.js'] = 'import "./Core.js"; import "./tests/.test-tmp/shared-runtime.json";';
    files['tests/.test-tmp/shared-runtime.json'] = '{}';
  },
});
assert(equalSharedReachableTest.baselineChanges.some((item) => item.path === 'tests/.test-tmp/shared-runtime.json'),
  'an equal shared runtime-reachable test/temp path still requires baseline review');
assert.equal(equalSharedReachableTest.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');

const hardNamedTest = await runFixture({ mutateMobile: (files) => {
  files['tests/NewHardRuntime.js'] = 'export const candidate = true;';
} });
assert.equal(hardNamedTest.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA',
  'a Hard runtime artifact under tests must not be unconditionally exempted');
assert(hardNamedTest.classifications.hardPolicyViolations.some((item) => item.path === 'tests/NewHardRuntime.js')
  || hardNamedTest.classifications.runtimeCandidates.some((item) => item.path === 'tests/NewHardRuntime.js'));

const mobileOnlyTest = await runFixture({ mutateMobile: (files) => {
  files['tests/new-mobile-check.mjs'] = 'export const check = true;';
} });
assert.equal(mobileOnlyTest.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA',
  'a mobile-only test path requires review instead of using the test-prefix exemption');

const reviewedMobileOnlyTestText = 'export const check = "reviewed";';
const reviewedMobileOnlyTest = await runFixture({
  reviewedMobileOnlyTests: [{ path: 'tests/mobile-reviewed-check.mjs', sha256: sha(reviewedMobileOnlyTestText), reason: 'Fixture-specific reviewed test.' }],
  mutateMobile: (files) => { files['tests/mobile-reviewed-check.mjs'] = reviewedMobileOnlyTestText; },
});
assert.equal(reviewedMobileOnlyTest.status, 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA',
  'an exact path and hash in the mobile-only test baseline is accepted');
assert(reviewedMobileOnlyTest.classifications.testsAndBenchmarks.some((item) => item.path === 'tests/mobile-reviewed-check.mjs'));

const missingReviewedMobileOnlyTest = await runFixture({
  reviewedMobileOnlyTests: [{ path: 'tests/mobile-reviewed-check.mjs', sha256: sha(reviewedMobileOnlyTestText), reason: 'Fixture-specific reviewed test.' }],
});
assert.equal(missingReviewedMobileOnlyTest.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA',
  'a missing reviewed mobile-only test requires review');

const changedReviewedMobileOnlyTest = await runFixture({
  reviewedMobileOnlyTests: [{ path: 'tests/mobile-reviewed-check.mjs', sha256: sha(reviewedMobileOnlyTestText), reason: 'Fixture-specific reviewed test.' }],
  mutateMobile: (files) => { files['tests/mobile-reviewed-check.mjs'] = `${reviewedMobileOnlyTestText}\nexport const changed = true;`; },
});
assert.equal(changedReviewedMobileOnlyTest.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA',
  'a changed reviewed mobile-only test requires review');

const reachableReceipt = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; import "./model.training-receipt.json";';
} });
assert(reachableReceipt.classifications.runtimeCandidates.some((item) => item.path === 'model.training-receipt.json'));
assert.equal(reachableReceipt.classifications.researchReceipts.length, 0);

const fetchedReceipt = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; fetch("./model.training-receipt.json");';
} });
assert(fetchedReceipt.classifications.runtimeCandidates.some((item) => item.path === 'model.training-receipt.json'),
  'a fetched training receipt is runtime-reachable and must require review');
assert.equal(fetchedReceipt.classifications.researchReceipts.length, 0);

const fetchedBareReceipt = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; fetch("model.training-receipt.json");';
} });
assert(fetchedBareReceipt.classifications.runtimeCandidates.some((item) => item.path === 'model.training-receipt.json'),
  'a bare relative fetch receipt remains runtime-reachable');

const templateFetchReceipt = await runFixture({ mutateSource: (files) => {
  files['main.js'] = "import \"./Core.js\"; fetch(`model.training-receipt.json`);";
} });
assert(templateFetchReceipt.classifications.runtimeCandidates.some((item) => item.path === 'model.training-receipt.json'),
  'a static template fetch receipt remains runtime-reachable');

const fetchedAssetPaths = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; import "./nested/Fetch.js";';
  files['nested/Fetch.js'] = [
    'fetch("./dot.training-receipt.json");',
    'fetch("../parent.training-receipt.json");',
    'fetch("assets/bare.json");',
    'fetch("/assets/root.json");',
    'fetch("https://example.test/outside.json");',
  ].join('\n');
  files['nested/dot.training-receipt.json'] = '{}';
  files['parent.training-receipt.json'] = '{}';
  files['nested/assets/bare.json'] = '{}';
  files['assets/root.json'] = '{}';
} });
for (const name of ['nested/dot.training-receipt.json', 'parent.training-receipt.json', 'nested/assets/bare.json', 'assets/root.json']) {
  assert(fetchedAssetPaths.runtimeClosure.files.includes(name), `fetch closure must include ${name}`);
  assert(fetchedAssetPaths.classifications.runtimeCandidates.some((item) => item.path === name), `${name} must require runtime review`);
}

const bareUrlAndMjsWorker = await runFixture({ mutateSource: (files) => {
  files['main.js'] = 'import "./Core.js"; new URL("assets/foo.json", import.meta.url); new Worker("./worker.mjs");';
  files['assets/foo.json'] = '{}';
  files['worker.mjs'] = 'export const worker = true;';
} });
assert(bareUrlAndMjsWorker.runtimeClosure.files.includes('assets/foo.json'), 'a bare new URL asset is reachable');
assert(bareUrlAndMjsWorker.runtimeClosure.files.includes('worker.mjs'), 'a direct .mjs Worker is reachable');

const templateRuntimeReferences = await runFixture({ mutateSource: (files) => {
  files['main.js'] = "import \"./Core.js\"; new URL(`assets/template-url.json`, import.meta.url); new Worker(`./template-worker.mjs`); import(`./template-dynamic.js`);";
  files['assets/template-url.json'] = '{}';
  files['template-worker.mjs'] = 'export const worker = true;';
  files['template-dynamic.js'] = 'export const loaded = true;';
} });
for (const name of ['assets/template-url.json', 'template-worker.mjs', 'template-dynamic.js']) {
  assert(templateRuntimeReferences.runtimeClosure.files.includes(name), `static template reference must include ${name}`);
}

const interpolatedTemplateReference = await runFixture({ mutateSource: (files) => {
  files['main.js'] = "import \"./Core.js\"; fetch(`model.training-receipt.json${suffix}`);";
} });
assert(!interpolatedTemplateReference.runtimeClosure.files.includes('model.training-receipt.json'),
  'an interpolated template must not be treated as a complete static URL');
assert(interpolatedTemplateReference.classifications.researchReceipts.some((item) => item.path === 'model.training-receipt.json'));

const equalSharedDrift = await runFixture({
  mutateSource: (files) => { files['Core.js'] = 'export const ready = "changed";'; },
  mutateMobile: (files) => { files['Core.js'] = 'export const ready = "changed";'; },
});
assert.deepEqual(equalSharedDrift.baselineChanges.map((item) => item.path), ['Core.js']);
assert.equal(equalSharedDrift.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');

const unknownSharedProduct = await runFixture({
  mutateSource: (files) => { files['SharedFeature.js'] = 'export const shared = true;'; },
  mutateMobile: (files) => { files['SharedFeature.js'] = 'export const shared = true;'; },
});
assert.deepEqual(unknownSharedProduct.baselineChanges.map((item) => item.path), ['SharedFeature.js']);
assert.equal(unknownSharedProduct.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');

const manifestTamper = await makeFixture();
try {
  const sourceManifest = JSON.parse(await readFile(manifestTamper.syncManifestPath, 'utf8'));
  sourceManifest.source_files['main.js'] = '0'.repeat(64);
  await writeFile(manifestTamper.syncManifestPath, JSON.stringify(sourceManifest));
  await assert.rejects(() => auditLiveWebRuntimeDelta({ ...manifestTamper,
    sourceWebRoot: manifestTamper.sourceRoot, mobileWebRoot: manifestTamper.mobileWebRoot, includeGit: false }),
  /sync manifest SHA-256/);
} finally {
  await rm(manifestTamper.root, { recursive: true, force: true });
}

const cliFixture = await makeFixture({ mutateSource: (files) => { files['NewFeature.js'] = 'export const feature = true;'; } });
try {
  const cliBaseline = JSON.parse(await readFile(cliFixture.baselinePath, 'utf8'));
  const liveSyncManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json'), 'utf8'));
  const liveRuntimeManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json'), 'utf8'));
  cliBaseline.sync_manifest_sha256 = digest(await readFile(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json')));
  cliBaseline.runtime_manifest_sha256 = digest(await readFile(path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json')));
  cliBaseline.sync_release_id = liveSyncManifest.release_id;
  cliBaseline.runtime_asset_version = liveRuntimeManifest.runtime_asset_version;
  await writeFile(cliFixture.baselinePath, JSON.stringify(cliBaseline));
  const cli = spawnSync(process.execPath, [toolPath,
    '--source-web-root', cliFixture.sourceRoot,
    '--mobile-web-root', cliFixture.mobileWebRoot,
    '--baseline', cliFixture.baselinePath,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.status, 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA');
  assert.equal(report.writesPerformed, false);
} finally {
  await rm(cliFixture.root, { recursive: true, force: true });
}

const liveSourceCandidates = [
  process.env.LIFELINE_CURRENT_WEB_ROOT,
  'C:\\coding\\py\\line game\\web\\web前端',
  path.join(repositoryRoot, 'web', 'web前端'),
].filter(Boolean);
let liveSourceRoot;
for (const candidate of liveSourceCandidates) {
  try { await readFile(path.join(candidate, 'index.html')); liveSourceRoot = candidate; break; } catch {}
}
if (liveSourceRoot) {
  const live = await auditLiveWebRuntimeDelta({ sourceWebRoot: liveSourceRoot, includeGit: false });
  assert.equal(live.status, 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA');
  assert.equal(live.source.fileCount, 433);
  assert.equal(live.mobile.fileCount, 185);
  assert.equal(live.differencePathCount, 332);
  assert.equal(live.classifiedDifferencePathCount, 332);
  assert.deepEqual(live.classificationCounts, {
    generatedTestScratch: 103,
    testsAndBenchmarks: 178,
    researchReceipts: 4,
    excludedHard: 10,
    mobileOnlyRuntime: 4,
    reviewedRuntimeDifferences: 33,
    adaptationChanges: 0,
    runtimeCandidates: 0,
    hardPolicyViolations: 0,
  });
  assert.equal(live.reviewRequiredCount, 0);
} else process.stdout.write(`SKIP real Web tree delta assertions: no known Web source root found (checked ${liveSourceCandidates.join(', ')}). Fixture assertions still ran.\n`);

const protectedAfter = new Map(await Promise.all(protectedPaths.map(async (name) => [name, digest(await readFile(path.join(repositoryRoot, ...name.split('/'))))])));
assert.deepEqual(protectedAfter, protectedBefore, 'the sidecar delta gate must not mutate R13 manifests, package scripts, or checkpoint evidence');
console.log('Live Web runtime delta gate is a manual review check (not wired into package.json verify); fixtures classify paths once, preserve R13 inputs, and reject reviewable product drift.');
