// Differential correctness fixtures only; no strength or wall-clock speed claim.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GameEngine } from '../GameEngine.js';
import { saveState } from '../AIEngine.js';
import { isolatedSearchEngine } from '../MultiplayerSearch.js';
import { MultiplayerRolloutAI } from '../MultiplayerHardRollout.js';
import { HardDeadlineFallbackV2 } from '../MultiplayerHardFallback.js';

const rows = [], key = point => point === null ? 'PASS' : point.join(',');
const load = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
// Keep the complete production implementation and switch ONLY the continuation
// call back to its previous full-sort/full-softmax expression. No reference
// implementation of legality, transitions, features or leaf scores is invented.
async function referenceModule(name, from, to, suffix = '') {
  let source = await load(name);
  assert.equal(source.split(from).length, 2, `Expected exactly one continuation call in ${name}`);
  source = source.replace(from, to).replace(/from\s+(['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${JSON.stringify(new URL(path, new URL(`../${name}`, import.meta.url)).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source + suffix).toString('base64')}`);
}
const referenceRollout = await referenceModule('MultiplayerHardRollout.js',
  'const action = policyAction(policy)?.point ?? null;',
  'const action = policyActions(policy)[0]?.point ?? null;');
const referenceFallback = await referenceModule('MultiplayerHardFallback.js',
  'const reply = linearAction(engine, engine.currentPlayer, spec, check)?.point ?? null;',
  'const reply = linearRanking(engine, engine.currentPlayer, spec, check)[0]?.point ?? null;',
  '\nexport { linearAction, linearRanking };\n');
const three = JSON.parse(await readFile(new URL('../assets/research-ai/three-player-search-v4-round12.json', import.meta.url)));
const hex = JSON.parse(await readFile(new URL('../assets/research-ai/hex-player-policy-v1.json', import.meta.url)));
const flat = { weights: Array(16).fill(0), temperature: 1 };
function position(playerCount, rulesVersion = 'territory-v3') {
  const engine = new GameEngine({ gridSize: 5, playerCount, rulesVersion,
    boardShape: playerCount === 3 ? 'triangle' : 'hexagon', deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  // Use canonical placements to vary topology/history while keeping fixtures small.
  for (let ply = 0; ply < 2 && !engine.gameOver; ply++) {
    const point = engine.getLegalMoves()[0]?.point;
    assert.equal((point ? engine.playMove(point) : engine.skipTurn()).success, true);
  }
  return engine;
}
function forcedPass() {
  const engine = position(3);
  // Explicit synthetic no-placement state; no scientific reachability claim.
  const states = engine._getPlayerStates(engine.currentPlayer);
  for (const point of engine.validPositions) engine._setState(point, states.node);
  engine.gameOver = false; engine.consecutiveSkips = 0;
  assert.equal(engine.getLegalMoves().length, 0);
  return engine;
}
const withoutTimes = value => {
  if (Array.isArray(value)) return value.map(withoutTimes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !['elapsedMs', 'fallbackMs', 'rootPreparationMs'].includes(name))
    .map(([name, item]) => [name, withoutTimes(item)]));
};
function withClock(clock, work) {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: clock });
  try { return work(); }
  finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor);
    else delete performance.now;
  }
}
function compareRollouts(source, options, label, clockStep = 0) {
  const snapshot = saveState(source);
  const run = Type => {
    let clock = 0;
    return withClock(() => clockStep ? clock += clockStep : 0, () => {
      const ai = new Type(options), moves = ai.getTopMoves(source, source.currentPlayer, 5);
      assert.deepEqual(saveState(source), snapshot, `${label}: source changed`);
      return { moves, stats: withoutTimes(ai.lastSearch) };
    });
  };
  const old = run(referenceRollout.MultiplayerRolloutAI), current = run(MultiplayerRolloutAI);
  assert.deepEqual(current, old, `${label}: full-sort continuation differs`);
  return current;
}
function compareFallbacks(source, spec, searchV4, label, deadline = Infinity, clockStep = 0) {
  const snapshot = saveState(source);
  const run = Type => {
    let clock = 0;
    const ai = new Type(spec, { searchV4 });
    const moves = ai.getTopMoves(source, source.currentPlayer, 5,
      { deadline, now: () => clockStep ? clock += clockStep : 0 });
    assert.deepEqual(saveState(source), snapshot, `${label}: source changed`);
    return { moves, ranking: ai.fullRanking, stats: withoutTimes(ai.lastSearch) };
  };
  const old = run(referenceFallback.HardDeadlineFallbackV2), current = run(HardDeadlineFallbackV2);
  assert.deepEqual(current, old, `${label}: full-sort/softmax continuation differs`);
  return current;
}

for (const count of [3, 4, 6]) for (const rules of ['territory-v2', 'territory-v3']) {
  const source = position(count, rules), policy = count === 3 ? three : hex;
  for (const spec of [policy, flat]) {
    const engine = isolatedSearchEngine(source), snapshot = saveState(engine);
    let sortedChecks = 0, streamedChecks = 0;
    const sorted = referenceFallback.linearRanking(engine, engine.currentPlayer, spec, () => sortedChecks++)[0] ?? null;
    const streamed = referenceFallback.linearAction(engine, engine.currentPlayer, spec, () => streamedChecks++);
    assert.equal(key(streamed?.point ?? null), key(sorted?.point ?? null));
    assert.equal(streamed?.score, sorted?.score);
    assert.equal(streamedChecks, sortedChecks, 'Every candidate and final deadline poll must remain');
    assert.deepEqual(saveState(engine), snapshot);
  }
  rows.push({ case: 'argmax-score-tie-polls', players: count, rules });
}
// A complete old-history entry makes a formerly legal action illegal. The
// streaming selector must retain the native Superko mask and state exactly.
const historical = position(4), excluded = historical.getLegalMoves()[0].point;
const future = isolatedSearchEngine(historical);
assert.equal(future.playMove(excluded).success, true);
historical.historyHashes.add([...future.historyHashes].at(-1));
assert.equal(historical.getLegalMoves().some(move => key(move.point) === key(excluded)), false);
const historyEngine = isolatedSearchEngine(historical), historySnapshot = saveState(historyEngine);
const oldHistory = referenceFallback.linearRanking(historyEngine, historyEngine.currentPlayer, flat, () => {});
const newHistory = referenceFallback.linearAction(historyEngine, historyEngine.currentPlayer, flat, () => {});
assert.deepEqual(newHistory.point, oldHistory[0].point);
assert.notEqual(key(newHistory.point), key(excluded));
assert.deepEqual(saveState(historyEngine), historySnapshot);
rows.push({ case: 'complete-history-superko' });

for (const stopAt of [2, 5, 6]) {
  const expired = Symbol('deterministic continuation deadline');
  const source = position(4), snapshot = saveState(source), polls = [];
  for (const select of [referenceFallback.linearRanking, referenceFallback.linearAction]) {
    let checks = 0;
    assert.throws(() => select(source, source.currentPlayer, hex, () => {
      if (++checks === stopAt) throw expired;
    }), error => error === expired);
    assert.deepEqual(saveState(source), snapshot);
    polls.push(checks);
  }
  assert.deepEqual(polls, [stopAt, stopAt]);
}
rows.push({ case: 'identical-before-after-candidate-interruption-polls' });

for (const publishCompletedComparisons of [false, true]) {
  for (const count of [3, 4]) {
    const source = position(count), policy = count === 3 ? three : hex;
    const options = { basePolicy: policy, responsePolicies: [policy, flat],
      // Tiny test horizons only; production 650ms / 12-24 settings are unchanged.
      rolloutPlies: [1, 2], timeMs: 650, publishCompletedComparisons };
    const result = compareRollouts(source, options, `rollout-${count}-${publishCompletedComparisons}`);
    assert.ok(result.stats.simulatedActions > result.stats.legalRoots);
    assert.ok(result.stats.completedPhases.length > 0);
    const interrupted = compareRollouts(source, options, `deadline-${count}-${publishCompletedComparisons}`, 20);
    assert.equal(interrupted.stats.timedOut, true);
    const nodeLimited = compareRollouts(source, { ...options, nodeBudget: 20 },
      `node-budget-${count}-${publishCompletedComparisons}`);
    assert.equal(nodeLimited.stats.timedOut, true);
    rows.push({ case: 'rollout-values-stats-and-deadline', players: count, publishCompletedComparisons });
  }
}
const shortV4 = structuredClone(three);
shortV4.search.rootWidth = 2; shortV4.search.rolloutPlies = 2;
const fallbackComplete = compareFallbacks(position(3), shortV4, true, 'v4-fallback-complete');
assert.ok(fallbackComplete.stats.simulations > 0);
assert.equal(fallbackComplete.stats.completed, true);
const fallbackDeadline = compareFallbacks(position(3), shortV4, true, 'v4-fallback-deadline', 30, 1);
assert.equal(fallbackDeadline.stats.timedOut, true);
rows.push({ case: 'fallback-root-ranking-priors-values-and-deadline' });

const pass = forcedPass(), privatePass = isolatedSearchEngine(pass), passSnapshot = saveState(privatePass);
assert.deepEqual(referenceFallback.linearRanking(privatePass, privatePass.currentPlayer, flat, () => {}), []);
assert.equal(referenceFallback.linearAction(privatePass, privatePass.currentPlayer, flat, () => {}), null);
assert.deepEqual(saveState(privatePass), passSnapshot);
const passRollout = compareRollouts(pass, { basePolicy: flat, responsePolicies: [flat],
  rolloutPlies: [1], timeMs: 650, nodeBudget: 1 }, 'forced-pass');
assert.equal(passRollout.moves[0].point, null);
const passFallback = compareFallbacks(pass, flat, false, 'forced-pass-fallback');
assert.equal(passFallback.moves[0].point, null);
rows.push({ case: 'forced-pass-and-empty-argmax' });

const poisoned = { weights: Array(16).fill(NaN), temperature: 1 };
const poisonedEngine = isolatedSearchEngine(position(3)), poisonedSnapshot = saveState(poisonedEngine);
for (const select of [referenceFallback.linearRanking, referenceFallback.linearAction])
  assert.throws(() => select(poisonedEngine, poisonedEngine.currentPlayer, poisoned, () => {}), /Invalid isolated Hard linear score/);
assert.deepEqual(saveState(poisonedEngine), poisonedSnapshot);
rows.push({ case: 'nonfinite-score-and-exception-state' });

console.log(JSON.stringify({ status: 'PASS_HARD_CONTINUATION_ARGMAX_DIFFERENTIAL',
  cases: rows, productionDefaultsUnchanged: { hardTimeMs: 650, hardHorizons: [12, 24] },
  fullCandidateDomain: true, rootRankingAndSoftmaxUnchanged: true, sourceStatePreserved: true,
  scope: 'Small deterministic source-level differential fixtures against prior sort calls; no latency, strength, browser/device or publication claim.' }));
