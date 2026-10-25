import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The current independent 0.11.2 fixture replaces the old r2 allowance for
// three failures. Expected results are never generated from this candidate.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [expectedEngineHash, referenceEvidence, outputFile, baselineReceiptArg, expectedPreviousManifestHash] = process.argv.slice(2);
assert.match(expectedEngineHash || '', /^[0-9a-f]{64}$/);
assert.ok(referenceEvidence && outputFile, 'Pass <engine-sha256> <reference-receipt.json> <new-receipt.json>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const engineFile = 'web/web前端/GameEngine.js', suiteFile = 'wechat/minigame/tests/multiplayer-rules-codec.test.mjs';
const tests = ['worker-runtime-cache-r2', 'warm-worker', 'scheduler', 'worker-transport', 'hex-ui', 'rules',
  'multiplayer-rules-codec', 'production-worker', 'local-features-0110', 'replay-settings', 'multiplayer-reconnection']
  .map(name => `wechat/minigame/tests/${name}.test.mjs`);
const hashFiles = async files => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, sha(await fs.readFile(path.resolve(repo, file)))])));
const target = path.resolve(repo, outputFile);
await assert.rejects(fs.access(target), { code: 'ENOENT' });
const rawDirectory = path.join(repo, 'local_artifacts/territory-performance-20261022-r3/integration', path.basename(target, '.json'));
await fs.mkdir(rawDirectory, { recursive: true });
const referenceBytes = await fs.readFile(path.resolve(repo, referenceEvidence)), reference = JSON.parse(referenceBytes);
assert.equal(reference.status, 'PASS_INDEPENDENT_UPLOADED_0112_REFERENCE');
assert.equal(reference.boundaries.currentEngineUsedToGenerateExpected, false);
assert.equal(reference.originalEvidencePreserved, true);
assert.equal(reference.oldReferenceReexecution.checkpoints, 302);
const referenceHashes = await hashFiles(Object.keys(reference.evidenceSha256));
assert.deepEqual(referenceHashes, reference.evidenceSha256, 'Independent fixtures or suite changed');
const frozenPath = path.join(repo, 'local_artifacts/territory-performance-20261022-r3/baseline/source-hashes.json');
const frozenBytes = await fs.readFile(frozenPath), frozen = JSON.parse(frozenBytes);
const frozenEngineFile = path.join(path.dirname(frozenPath), 'GameEngine.js');
const frozenEngineHash = sha(await fs.readFile(frozenEngineFile));
assert.equal(frozenEngineHash, 'b97a09d18c701ca5290fe993f582152ddc38fa3144307603f1056f2edeac14d0');
assert.equal(frozen.files.find(file => file.path === engineFile).sha256, frozenEngineHash);
const manifestPath = path.join(repo, 'wechat/minigame/dist/build-manifest.json');
const previousBytes = await fs.readFile(manifestPath), previous = JSON.parse(previousBytes);
if (baselineReceiptArg) assert.match(expectedPreviousManifestHash || '', /^[0-9a-f]{64}$/);
assert.equal(sha(previousBytes), expectedPreviousManifestHash || 'f150468109e8b245715e5e264be5a68610c8144916625c0d9a3e2bde54190858',
  'The reviewed 0.12.1 manifest changed; inspect it before replacing dist');
assert.equal(previous.sourceHashes[engineFile], baselineReceiptArg ? expectedEngineHash : frozenEngineHash);
const sourceFiles = [...new Set([...Object.keys(previous.sourceHashes), 'wechat/minigame/tools/build.mjs',
  'wechat/minigame/tools/client-config.mjs', 'wechat/minigame/tools/model-packaging.mjs',
  'wechat/minigame/game.json', 'wechat/minigame/package.json', ...Object.keys(referenceHashes)])];
const sourceHashes = await hashFiles(sourceFiles), testSourceHashes = await hashFiles(tests);
assert.equal(sourceHashes[engineFile], expectedEngineHash);
assert.equal(sourceHashes['wechat/minigame/src/worker-runtime.js'], '23019d04030b952699b08e1f188738b184ca46cb3f7352b6f056e6cc82b99b88');
await fs.writeFile(path.join(rawDirectory, 'pre-build-manifest.json'), previousBytes, { flag: 'wx' });
for (const output of previous.outputs) {
  const bytes = await fs.readFile(path.join(repo, 'wechat/minigame/dist', output.path));
  assert.equal(sha(bytes), output.sha256, `Pre-build output mismatch: ${output.path}`);
  if (['game.js', 'workers/index.js'].includes(output.path))
    await fs.writeFile(path.join(rawDirectory, `pre-build-${output.path.replaceAll('/', '-')}`), bytes, { flag: 'wx' });
}
const changedSources = Object.entries(previous.sourceHashes).filter(([file, hash]) => sourceHashes[file] !== hash)
  .map(([file, previousSha256]) => ({ file, previousSha256, currentSha256: sourceHashes[file] }));
function invoke(args, timeout) {
  const child = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (child.error) throw child.error;
  return { status: child.status, output: `${child.stdout || ''}${child.stderr || ''}` };
}
const counts = output => Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped']
  .map(name => [name, Number(output.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1])]));
async function guardSources() {
  assert.deepEqual(await hashFiles(sourceFiles), sourceHashes, 'Product/fixture source changed');
  assert.deepEqual(await hashFiles(tests), testSourceHashes, 'Tests changed');
}
let baselineCounts, baselineTarget, baselineReceiptBytes;
if (baselineReceiptArg) {
  baselineTarget = path.resolve(repo, baselineReceiptArg);
  baselineReceiptBytes = await fs.readFile(baselineTarget, 'utf8');
  const existing = JSON.parse(baselineReceiptBytes);
  assert.equal(existing.status, 'PASS_CURRENT_SUITE_ON_ISOLATED_B97');
  assert.equal(existing.engineSha256, frozenEngineHash);
  assert.equal(existing.originalSuiteSha256, testSourceHashes[suiteFile]);
  assert.equal(existing.independentReferenceReceiptSha256, sha(referenceBytes));
  assert.deepEqual(existing.testSourceHashes, testSourceHashes);
  for (const [file, hash] of Object.entries(existing.sourceHashes)) assert.equal(sourceHashes[file], hash, file);
  const baselineLog = path.join(repo, 'local_artifacts/territory-performance-20261022-r3/integration/final-integration/baseline-tests.tap');
  assert.equal(sha(await fs.readFile(baselineLog)), existing.logSha256);
  baselineCounts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key, existing[key]]));
  assert.deepEqual(baselineCounts, { tests: 9, pass: 9, fail: 0, cancelled: 0, skipped: 0 });
} else {
// Keep original assertions and anchor paths to the original test; esbuild
// substitutes only GameEngine. Worktree engine and dist are never swapped.
const suiteBytes = await fs.readFile(path.join(repo, suiteFile)), suite = suiteBytes.toString('utf8');
const marker = "plugins: [{ name: 'cache-query'";
assert.equal(suite.split(marker).length, 2);
const plugin = `plugins: [{ name: 'isolated-b97-engine', setup(b) { b.onResolve({ filter: /(^|\\/)GameEngine\\.js(?:\\?v=.*)?$/ }, () => ({ path: ${JSON.stringify(frozenEngineFile)} })); } }, { name: 'cache-query'`;
const isolated = suite.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(repo, suiteFile)).href))
  .replace("from 'esbuild'", `from ${JSON.stringify(pathToFileURL(path.join(repo, 'wechat/minigame/node_modules/esbuild/lib/main.js')).href)}`)
  .replace(marker, plugin);
const isolatedPath = path.join(rawDirectory, 'baseline-multiplayer.test.mjs');
await fs.writeFile(isolatedPath, isolated, { flag: 'wx' });
const baselineArgs = ['--test', '--test-concurrency=1', '--test-timeout=180000', isolatedPath];
const baselineRun = invoke(baselineArgs, 180000);
baselineCounts = counts(baselineRun.output);
await fs.writeFile(path.join(rawDirectory, 'baseline-tests.tap'), baselineRun.output, { flag: 'wx' });
await guardSources();
assert.equal(sha(await fs.readFile(manifestPath)), sha(previousBytes));
assert.equal(baselineRun.status, 0, baselineRun.output.slice(-6000));
assert.deepEqual(baselineCounts, { tests: 9, pass: 9, fail: 0, cancelled: 0, skipped: 0 });
const baselineReceipt = { status: 'PASS_CURRENT_SUITE_ON_ISOLATED_B97', recordedAtUtc: new Date().toISOString(),
  engineSha256: frozenEngineHash, originalSuiteSha256: sha(suiteBytes), isolatedHarnessSha256: sha(isolated),
  command: `node ${baselineArgs.map(arg => JSON.stringify(arg)).join(' ')}`, exitCode: baselineRun.status,
  ...baselineCounts, logSha256: sha(baselineRun.output), independentReferenceReceiptSha256: sha(referenceBytes),
  method: 'Original test assertions unchanged; original import.meta URL anchored and esbuild resolves only GameEngine to frozen b97. Worktree engine and dist never replaced.',
  sourceHashes, testSourceHashes };
await fs.mkdir(path.dirname(target), { recursive: true });
baselineTarget = path.join(path.dirname(target), 'current-suite-b97-baseline.json');
baselineReceiptBytes = JSON.stringify(baselineReceipt, null, 2) + '\n';
await fs.writeFile(baselineTarget, baselineReceiptBytes, { flag: 'wx' });
}
const buildArgs = ['wechat/minigame/tools/build.mjs'], build = invoke(buildArgs, 60000);
await fs.writeFile(path.join(rawDirectory, 'build.log'), build.output, { flag: 'wx' });
assert.equal(build.status, 0, build.output.slice(-4000));
const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
await guardSources();
for (const [file, hash] of Object.entries(manifest.sourceHashes)) assert.equal(sourceHashes[file], hash, file);
const testArgs = ['--test', '--test-concurrency=1', '--test-timeout=180000', ...tests];
const regression = invoke(testArgs, 240000);
await fs.writeFile(path.join(rawDirectory, 'tests.tap'), regression.output, { flag: 'wx' });
await guardSources();
assert.equal(sha(await fs.readFile(manifestPath)), sha(manifestBytes), 'Build manifest changed during regression');
for (const output of manifest.outputs)
  assert.equal(sha(await fs.readFile(path.join(repo, 'wechat/minigame/dist', output.path))), output.sha256, output.path);
const regressionCounts = counts(regression.output);
const pass = regression.status === 0 && regressionCounts.tests === 62 && regressionCounts.pass === 62
  && regressionCounts.fail === 0 && regressionCounts.cancelled === 0 && regressionCounts.skipped === 0;
const receipt = { status: pass ? 'PASS_R3_CORE_INTEGRATION_CURRENT_REFERENCE' : 'FAIL_INTEGRATION_REQUIRES_INVESTIGATION',
  recordedAtUtc: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
  sourceHashes, testSourceHashes, verifierSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  baseline: { receipt: path.basename(baselineTarget), sha256: sha(baselineReceiptBytes), engineSha256: frozenEngineHash,
    ...baselineCounts, exactCurrentSuiteAssertions: true, reusedCompletedBaseline: Boolean(baselineReceiptArg) },
  independentReference: { path: referenceEvidence, sha256: sha(referenceBytes), evidenceHashes: referenceHashes,
    oldR4EvidencePreserved: true, obsoleteR2FailuresNotAllowed: true },
  previousBuild: { earlyR3FreezeSha256: sha(frozenBytes), manifestSha256: sha(previousBytes),
    outputs: previous.outputs.filter(file => ['game.js', 'workers/index.js'].includes(file.path)),
    allOutputsMatchedBeforeBuild: true, sourceChangesSincePreviousBuild: changedSources, currentCheckoutUiPreserved: true },
  build: { command: `node ${buildArgs.join(' ')}`, exitCode: build.status, status: 'BUILT_NOT_WECHAT_VERIFIED',
    manifestSha256: sha(manifestBytes), totalBytes: manifest.totalBytes, mainPackageBytes: manifest.mainPackageBytes,
    outputs: manifest.outputs.filter(file => ['game.js', 'workers/index.js'].includes(file.path)),
    allSourceAndOutputHashesVerifiedAfterTests: true },
  regression: { command: `node ${testArgs.join(' ')}`, exitCode: regression.status, ...regressionCounts,
    rawLog: path.relative(repo, path.join(rawDirectory, 'tests.tap')).split(path.sep).join('/'), rawLogSha256: sha(regression.output) },
  boundaries: ['R1/r2 evidence and early r3 frozen bundles remain untouched.',
    'Only GameEngine copied from main; current Mini UI and independent test fixtures preserved.',
    'No latency, native WeChat device, Canvas, upload or release claim.'] };
await fs.writeFile(target, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, baseline: baselineCounts, build: receipt.build, regression: regressionCounts, outputFile }, null, 2));
assert.equal(pass, true);
