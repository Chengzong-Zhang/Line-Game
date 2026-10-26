// Reproduce the old non-Hard branches without touching the working tree or
// weakening release gates. This is attribution, not a passing full-suite claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../../..');
const mini = path.join(repo, 'wechat/minigame');
const baseline = '14685b2c883991a2e870ef179941456ff7df6f31';
const runtimePath = 'wechat/minigame/src/worker-runtime.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const slash = value => value.split(path.sep).join('/');
const old = relative => execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
const normalizeCheckout = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
const checkoutLineEndingOnlyDifferences = [];
function assertUnchangedSource(relative, actual, historical) {
  if (sha(actual) !== sha(historical)) {
    assert.equal(normalizeCheckout(actual), normalizeCheckout(historical), `Historical source changed: ${relative}`);
    checkoutLineEndingOnlyDifferences.push(relative);
  }
}
const { build } = await import(pathToFileURL(path.join(mini, 'tools/native-build.mjs')).href);
const { sut } = await import(pathToFileURL(path.join(mini, 'tests/helpers.mjs')).href);
const oldRuntime = old(runtimePath);
const queries = { name: 'baseline-cache-query', setup(builder) {
  builder.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
const baselineRuntime = { name: 'baseline-worker-runtime-only', setup(builder) {
  builder.onLoad({ filter: /[\\/]src[\\/]worker-runtime\.js$/ }, args => ({
    contents: oldRuntime, loader: 'js', resolveDir: path.dirname(args.path),
  }));
} };
const compiled = await build({ absWorkingDir: mini,
  entryPoints: [path.join(mini, 'src/workers/index.js')], bundle: true,
  write: false, minify: true, platform: 'browser', target: 'es2018',
  format: 'iife', plugins: [queries, baselineRuntime], metafile: true,
  define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });

// All dependencies, including both native compatibility sides, must equal
// baseline Git source content. Clean checkout CRLF/LF differences are recorded
// explicitly; they do not change the JavaScript parsed by the compiler.
const compiledInputs = Object.keys(compiled.metafile.inputs).map(input =>
  slash(path.relative(repo, path.resolve(mini, input))));
const thirdPartyInputs = compiledInputs.filter(input => input.includes('/node_modules/'));
const dependencies = new Set(compiledInputs.filter(input => !input.includes('/node_modules/')));
for (const extra of ['wechat/minigame/compat/web/manifest.json',
  'wechat/minigame/tools/native-build.mjs', 'wechat/minigame/tools/web-compat.mjs']) dependencies.add(extra);
const compatibility = JSON.parse(await fs.readFile(path.join(mini, 'compat/web/manifest.json')));
for (const [canonical, record] of Object.entries(compatibility.overrides)) {
  if (dependencies.has(canonical)) dependencies.add(record.override);
}
const dependencyHashes = {};
for (const relative of [...dependencies].sort()) {
  const historical = old(relative);
  const actual = relative === runtimePath ? oldRuntime : await fs.readFile(path.join(repo, relative));
  assertUnchangedSource(relative, actual, historical);
  dependencyHashes[relative] = sha(actual);
}
const thirdPartyHashes = {};
for (const relative of [...thirdPartyInputs].sort()) {
  thirdPartyHashes[relative] = sha(await fs.readFile(path.join(repo, relative)));
}
// node_modules are untracked. Compare old/new with the same installed bytes,
// and prove the lock's dependency entries are unchanged (only app version
// 0.12.15 -> 0.12.16 is permitted to differ).
const lockPath = 'wechat/minigame/package-lock.json';
const historicalLock = JSON.parse(old(lockPath));
const currentLock = JSON.parse(await fs.readFile(path.join(repo, lockPath)));
for (const lock of [historicalLock, currentLock]) {
  delete lock.version; delete lock.packages[''].version;
}
assert.deepEqual(currentLock, historicalLock);

function worker(script) {
  let receive, sequence = 0;
  const pending = new Map();
  const context = vm.createContext({ performance: { now: () => 0 }, worker: {
    onMessage(callback) { receive = callback; },
    postMessage(answer) { pending.get(answer.id)?.(plain(answer)); pending.delete(answer.id); },
  } });
  vm.runInContext(script, context, { timeout: 10000 });
  return (kind, settings, profile, actions = []) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    receive({ id, kind, context: { epoch: 11 }, payload: { settings, profile, actions } });
  });
}
const currentBytes = await fs.readFile(path.join(mini, 'dist/workers/index.js'));
const historical = worker(compiled.outputFiles[0].text), current = worker(currentBytes.toString());

const genericCases = [];
for (const count of [2, 3, 4, 5, 6]) {
  const settings = { ...sut.settingsFor(5, count), boardShape: count >= 4 ? 'triangle' : 'hexagon' };
  const directGreedy = plain(new sut.GreedyAI().getTopMoves(sut.restoreGame(settings), 'BLACK', 1));
  const oldGeneric = await historical('AI', settings, 'greedy');
  const newGeneric = await current('AI', settings, 'greedy');
  assert.equal(oldGeneric.ok, true); assert.equal(newGeneric.ok, true);
  assert.deepEqual(newGeneric.result.moves, oldGeneric.result.moves);
  genericCases.push({ count, shape: settings.boardShape, directLegacyExpectation: directGreedy,
    baselineMoves: oldGeneric.result.moves, currentMoves: newGeneric.result.moves,
    equal: true, originalAssertionPasses: JSON.stringify(directGreedy) === JSON.stringify(oldGeneric.result.moves) });
}
const failedGeneric = genericCases.find(row => !row.originalAssertionPasses);
assert.ok(failedGeneric, 'Expected the unchanged historical generic-Greedy mismatch');
assert.deepEqual(failedGeneric.directLegacyExpectation, []);
assert.deepEqual(failedGeneric.baselineMoves, [{ point: null, type: 'pass', score: 0,
  visits: 1, evaluation: 'canonical-forced-pass' }]);

function uniqueWinner(config) {
  const actions = [], engine = sut.restoreGame(config), actor = engine.currentPlayer;
  for (let turn = 0; turn < 4; turn++) {
    let best;
    for (const move of engine.getLegalMoves()) {
      const trial = sut.restoreGame(config, actions);
      assert.equal(trial.playMove(move.point).success, true);
      const area = trial.getSnapshot().territories[actor].area;
      if (!best || area > best.area) best = { point: move.point, area };
    }
    assert.ok(best);
    actions.push({ type: 'move', player: engine.currentPlayer, point: [...best.point] });
    assert.equal(sut.applyAction(engine, actions.at(-1)).success, true);
    while (!engine.gameOver && engine.currentPlayer !== actor) {
      actions.push({ type: 'skip', player: engine.currentPlayer });
      assert.equal(engine.skipTurn().success, true);
    }
    const trial = sut.restoreGame(config, actions);
    assert.equal(trial.skipTurn().success, true);
    if (trial.gameOver && trial.getWinner() === actor) return actions;
  }
  assert.fail('Expected historical immediate terminal-PASS fixture');
}
const winnerSettings = { ...sut.settingsFor(5, 2), rulesVersion: 'territory-v2' };
const winnerActions = uniqueWinner(winnerSettings);
const oldWinner = await historical('ANALYZE', winnerSettings, 'greedy', winnerActions);
const newWinner = await current('ANALYZE', winnerSettings, 'greedy', winnerActions);
assert.equal(oldWinner.ok, true); assert.equal(newWinner.ok, true);
assert.deepEqual(newWinner.result.moves, oldWinner.result.moves);
assert.ok(Array.isArray(oldWinner.result.moves[0].point));
assert.notDeepEqual(oldWinner.result.moves, [{ point: null, type: 'pass', score: 1000000 }]);

const verifierPath = 'web/tools/verify-terminal-release-admission-v4.mjs';
const oldVerifierBytes = old(verifierPath), currentVerifierBytes = await fs.readFile(path.join(repo, verifierPath));
assertUnchangedSource(verifierPath, currentVerifierBytes, oldVerifierBytes);
// Omit only its executable CLI tail: fileURLToPath(import.meta.url) there
// expects a disk module rather than this isolated data-URL import.
const cliStart = oldVerifierBytes.toString().indexOf('\nif (process.argv[1]');
assert.ok(cliStart > 0);
const oldVerifierModule = oldVerifierBytes.subarray(0, cliStart);
const oldVerifier = await import(`data:text/javascript;base64,${oldVerifierModule.toString('base64')}`);
const currentVerifier = await import(pathToFileURL(path.join(repo, verifierPath)).href);
const policyPath = 'web/web前端/PassTrainedPolicyData.js';
assertUnchangedSource(policyPath, await fs.readFile(path.join(repo, policyPath)), old(policyPath));
const gateOptions = { dataPath: path.join(repo, policyPath) };
const gateError = async verifier => {
  try { await verifier.verifyTerminalReleaseAdmission(gateOptions); assert.fail('Missing admission accepted'); }
  catch (error) { return error.message; }
};
const oldGate = await gateError(oldVerifier), newGate = await gateError(currentVerifier);
assert.equal(newGate, oldGate);
assert.equal(oldGate, 'Use --terminal-admission with the sealed combined scoped admission report');

const unchangedTestFiles = ['all-ai-0110.test.mjs', 'candidate-package.test.mjs',
  'candidate-review-boundaries.test.mjs', 'hex-player-worker.test.mjs',
  'latest-ai-0128.test.mjs', 'online-candidate.test.mjs'];
const unchangedTests = {};
for (const name of unchangedTestFiles) {
  const relative = `wechat/minigame/tests/${name}`;
  const bytes = await fs.readFile(path.join(repo, relative));
  const historicalBytes = old(relative);
  assertUnchangedSource(relative, bytes, historicalBytes);
  unchangedTests[name] = { workingTreeSha256: sha(bytes), baselineGitSha256: sha(historicalBytes),
    byteIdentical: sha(bytes) === sha(historicalBytes) };
}
const nativeAiPath = 'wechat/minigame/compat/web/AIEngine.js';
const nativeAiHash = sha(await fs.readFile(path.join(repo, nativeAiPath)));
assert.equal(nativeAiHash, sha(old(nativeAiPath)));
const obsoletePin = 'fd43cd3053a0b92569a4d26524a036f45a2920271cc06a49ef0200aec07ffabf';
assert.ok((await fs.readFile(path.join(mini, 'tests/hex-player-worker.test.mjs'), 'utf8')).includes(obsoletePin));
assert.notEqual(nativeAiHash, obsoletePin);

const report = { schema: 'lifeline-inherited-native-failure-attribution-v1',
  status: 'PASS_BASELINE_ATTRIBUTION_NOT_FULL_SUITE', baseline,
  command: 'node docs/verification/hard-budget-20261026/verify-inherited-native-failures-v1.mjs',
  verifier_sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  historicalWorker: { injectedRuntimeSha256: sha(oldRuntime), dependencyCount: dependencies.size,
    dependencyHashesSha256: sha(JSON.stringify(dependencyHashes)),
    allOtherDependencySourceContentEqualsBaseline: true,
    thirdPartyModuleCount: thirdPartyInputs.length,
    thirdPartyHashesSha256: sha(JSON.stringify(thirdPartyHashes)),
    dependencyLockUnchangedExceptAppVersion: true,
    checkoutLineEndingOnlyDifferences: [...new Set(checkoutLineEndingOnlyDifferences)].sort() },
  currentWorkerSha256: sha(currentBytes), unchangedTests,
  cases: [
    { tests: ['all-ai-0110:generic-Greedy'], genericCases, firstOriginalAssertionFailureCount: failedGeneric.count },
    { tests: ['latest-ai-0128:unique-terminal-PASS'], baselineMoves: oldWinner.result.moves,
      currentMoves: newWinner.result.moves, equal: true, fixtureActions: winnerActions.length },
    { tests: ['hex-player-worker:old-native-pin'], obsoletePin, baselineAndCurrentNativeAiSha256: nativeAiHash },
    { tests: ['candidate-package:fresh-candidate', 'candidate-review-boundaries:floating-library',
      'candidate-review-boundaries:legacy-schema', 'online-candidate:explicit-origin', 'online-candidate:isolated-recipe'],
      baselineVerifierSha256: sha(oldVerifierBytes), currentVerifierSha256: sha(currentVerifierBytes),
      baselineAndCurrentError: oldGate },
  ],
  scope: 'Two failing non-Hard Worker branches reproduced using historical worker-runtime and unchanged dependency source content, with clean checkout CRLF/LF differences recorded; one stale pin and five unchanged missing-admission gate failures attributed. Original full suite remains 514 pass / 8 fail. No original assertions or admission gates were weakened.',
};
const output = path.resolve(process.argv[2] ?? path.join(repo,
  'working/docs/verification/hard-budget-20261026/inherited-native-failures-v1.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, output, dependencyCount: dependencies.size,
  genericEqual: true, winnerEqual: true, inheritedFailureCount: 8 }));
