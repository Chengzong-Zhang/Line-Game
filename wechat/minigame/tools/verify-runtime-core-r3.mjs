import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Run only after the parent has integrated the independently verified core.
// A required source hash prevents a build against an accidental intermediate.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [expectedEngineHash, baselineEvidence, outputFile] = process.argv.slice(2);
assert.match(expectedEngineHash || '', /^[0-9a-f]{64}$/);
assert.ok(baselineEvidence && outputFile, 'Pass <engine-sha256> <baseline-r4-failures.json> <new-receipt.json>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['web/web前端/GameEngine.js', 'wechat/minigame/src/worker-runtime.js',
  'wechat/minigame/src/board.js', 'wechat/minigame/src/scheduler.js', 'wechat/minigame/src/session.js',
  'wechat/minigame/src/app.js', 'wechat/minigame/src/platform.js'];
const tests = ['worker-runtime-cache-r2', 'warm-worker', 'scheduler', 'worker-transport', 'hex-ui',
  'rules', 'multiplayer-rules-codec', 'production-worker', 'local-features-0110',
  'replay-settings', 'multiplayer-reconnection'].map(name => `wechat/minigame/tests/${name}.test.mjs`);
const hashFiles = async files => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, sha(await fs.readFile(path.resolve(repo, file)))])));
const sourceHashes = await hashFiles(sourceFiles), testSourceHashes = await hashFiles(tests);
assert.equal(sourceHashes[sourceFiles[0]], expectedEngineHash);
assert.equal(sourceHashes[sourceFiles[1]], '23019d04030b952699b08e1f188738b184ca46cb3f7352b6f056e6cc82b99b88', 'Unexpected runtime changes require review');
const baselineBytes = await fs.readFile(path.resolve(baselineEvidence));
const baseline = JSON.parse(baselineBytes);
assert.equal(testSourceHashes['wechat/minigame/tests/multiplayer-rules-codec.test.mjs'], baseline.suiteSha256);
assert.equal(baseline.sameFailureNamesAndAssertions, true);
const target = path.resolve(repo, outputFile);
await assert.rejects(fs.access(target), { code: 'ENOENT' }, 'Evidence receipts are append-only');
const rawDirectory = path.join(repo, 'local_artifacts/territory-performance-20261022-r3/integration', path.basename(target, '.json'));
await fs.mkdir(rawDirectory, { recursive: true });
const frozenPath = path.join(repo, 'local_artifacts/territory-performance-20261022-r3/baseline/source-hashes.json');
const frozenBytes = await fs.readFile(frozenPath), frozen = JSON.parse(frozenBytes);
const previousManifestPath = path.join(repo, 'wechat/minigame/dist/build-manifest.json');
const previousManifestBytes = await fs.readFile(previousManifestPath), previousManifest = JSON.parse(previousManifestBytes);
const frozenManifest = frozen.files.find(file => file.path === 'wechat/minigame/dist/build-manifest.json');
assert.equal(sha(previousManifestBytes), frozenManifest.sha256, 'Another task rebuilt dist after the r3 freeze; review the current build before replacing it');
for (const output of previousManifest.outputs) {
  assert.equal(sha(await fs.readFile(path.join(repo, 'wechat/minigame/dist', output.path))), output.sha256, `Pre-build output mismatch: ${output.path}`);
}
const sourceChangesSincePreviousBuild = [];
for (const [file, previousSha256] of Object.entries(previousManifest.sourceHashes)) {
  const currentSha256 = sha(await fs.readFile(path.join(repo, file)));
  if (currentSha256 !== previousSha256) sourceChangesSincePreviousBuild.push({ file, previousSha256, currentSha256 });
}
// Rebuild from the current checkout. The newer UI is never copied back from an
// older baseline; source hashes above and after the tests guard concurrent edits.

function invoke(args, timeout) {
  const child = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout,
    maxBuffer: 32 * 1024 * 1024 });
  if (child.error) throw child.error;
  return { status: child.status, output: `${child.stdout || ''}${child.stderr || ''}` };
}
const buildArgs = ['wechat/minigame/tools/build.mjs'];
const build = invoke(buildArgs, 60000);
await fs.writeFile(path.join(rawDirectory, 'build.log'), build.output);
assert.equal(build.status, 0, build.output.slice(-4000));
const manifestPath = path.join(repo, 'wechat/minigame/dist/build-manifest.json');
const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
for (const file of sourceFiles) assert.equal(manifest.sourceHashes[file], sourceHashes[file], file);
const testArgs = ['--test', '--test-concurrency=1', '--test-timeout=180000', ...tests];
const regression = invoke(testArgs, 240000);
await fs.writeFile(path.join(rawDirectory, 'tests.tap'), regression.output);
const failures = [...regression.output.matchAll(/^not ok \d+ - (.+)\r?\n([\s\S]*?)(?=^# Subtest:|^1\.\.|$(?![\s\S]))/gm)].map(match => ({
  name: match[1],
  assertion: match[2].match(/  error: \|-\r?\n([\s\S]*?)\r?\n  code:/)?.[1].replaceAll('\r\n', '\n'),
}));
const count = name => Number(regression.output.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
assert.deepEqual(await hashFiles(sourceFiles), sourceHashes, 'Product source changed during integration');
assert.deepEqual(await hashFiles(tests), testSourceHashes, 'Tests changed during integration');
for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
  assert.equal(sha(await fs.readFile(path.join(repo, file))), expected, file);
}
for (const output of manifest.outputs) {
  assert.equal(sha(await fs.readFile(path.join(repo, 'wechat/minigame/dist', output.path))), output.sha256, output.path);
}
const baselineMatches = JSON.stringify(failures) === JSON.stringify(baseline.failures);
const receipt = {
  status: baselineMatches && regression.status === 1 && count('cancelled') === 0 && count('skipped') === 0
    ? 'PASS_R3_CORE_INTEGRATION_WITH_3_EXISTING_R4_TEST_FAILURES' : 'FAIL_INTEGRATION_REQUIRES_INVESTIGATION',
  recordedAtUtc: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
  sourceHashes, testSourceHashes,
  previousBuild: { frozenReceiptSha256: sha(frozenBytes), manifestSha256: sha(previousManifestBytes),
    outputs: previousManifest.outputs.filter(file => ['game.js', 'workers/index.js'].includes(file.path)),
    allOutputsMatchedBeforeBuild: true, sourceChangesSincePreviousBuild,
    currentCheckoutUiPreserved: true },
  verifierSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  build: { command: `node ${buildArgs.join(' ')}`, exitCode: build.status, status: 'BUILT_NOT_WECHAT_VERIFIED',
    manifestSha256: sha(manifestBytes), totalBytes: manifest.totalBytes, mainPackageBytes: manifest.mainPackageBytes,
    outputs: manifest.outputs.filter(file => ['game.js', 'workers/index.js'].includes(file.path)),
    allSourceAndOutputHashesVerifiedAfterTests: true },
  regression: { command: `node ${testArgs.join(' ')}`, exitCode: regression.status,
    tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    rawLog: path.relative(repo, path.join(rawDirectory, 'tests.tap')).split(path.sep).join('/'),
    rawLogSha256: sha(regression.output), failures },
  historicalFailures: { evidencePath: path.resolve(baselineEvidence), sha256: sha(baselineBytes),
    originalSuiteUnchanged: true, exactFailureNamesAndAssertionsMatch: baselineMatches },
  boundaries: ['R1/r2 evidence and raw logs remain untouched; this is a separate r3 core integration.',
    'This step measures no new latency and does not establish native wx device or public-service acceptance.',
    'No commit, push, upload, publication or deployment.'],
};
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, build: receipt.build,
  tests: receipt.regression.tests, pass: receipt.regression.pass, fail: receipt.regression.fail,
  exactHistoricalFailures: baselineMatches, outputFile }, null, 2));
assert.equal(receipt.status, 'PASS_R3_CORE_INTEGRATION_WITH_3_EXISTING_R4_TEST_FAILURES');
