// Bounded source/compiled-native correctness checks with deterministic clocks.
// This is not a phone-latency or population-strength benchmark.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/native-build.mjs';
import { GameEngine as WebGameEngine } from '../../../web/web前端/GameEngine.js';
import { MinimaxAI as WebMinimaxAI } from '../../../web/web前端/AIEngine.js';
import { BudgetedMinimaxAI } from '../../../web/web前端/BudgetedMinimaxAI.js';
import { serializeEngineState } from '../../../web/web前端/AIStateProtocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const PREFIX = [[0, 2], [1, 3], [0, 3], [3, 1]];
const settings = { gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
  boardShape: 'triangle', rulesVersion: 'territory-v3' };
const actions = PREFIX.map(point => ({ type: 'move', point }));
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const queries = { name: 'strip-native-cache-query', setup(ctx) {
  ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };

// Both bundles use the real compatibility loader and frozen manifest hashes.
// write:false leaves dist and all release evidence untouched.
const coreBuild = await build({ stdin: { contents: [
  "export { GameEngine, MinimaxAI } from './src/core.js';",
  "export { restoreGame, ruleView } from './src/state.js';",
  "export { multiplayerClock as clock } from '../../web/web前端/MultiplayerClock.js';",
].join('\n'), resolveDir: root }, bundle: true, write: false, platform: 'browser',
  target: 'es2018', format: 'iife', globalName: 'nativeMinimax', plugins: [queries], logLevel: 'silent' });
const workerBuild = await build({ entryPoints: [path.join(root, 'src/workers/index.js')],
  bundle: true, write: false, minify: true, platform: 'browser', target: 'es2018', format: 'iife',
  plugins: [queries], define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });

function clockDate(now) {
  return class NativeDate extends Date { static now() { return now(); } };
}
const sourceContext = vm.createContext({ Date: clockDate(() => 0) });
vm.runInContext(coreBuild.outputFiles[0].text, sourceContext, { timeout: 10000 });
const native = sourceContext.nativeMinimax;
function webPosition() {
  const engine = new WebGameEngine({ ...settings, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  try { for (const point of PREFIX) assert.equal(engine.playMove(point).success, true); }
  finally { engine._isReplayingBatch = false; }
  return engine;
}
function capture(engine) {
  engine.getSnapshot();
  return { state: JSON.stringify(serializeEngineState(engine)),
    caches: JSON.stringify(engine.cachedTerritories),
    territoryRevision: engine._territoryStateRevision,
    territoryCacheRevision: engine._territoryCacheRevision,
    replayFlag: engine._isReplayingBatch,
    playMove: engine.playMove, skipTurn: engine.skipTurn, autoSkip: engine._checkAndAutoSkip };
}
const reference = new Map();
for (const depth of [2, 3, 4, 5, 6]) {
  const engine = webPosition(), before = capture(engine), ai = new WebMinimaxAI(depth);
  reference.set(depth, plain(ai.getTopMoves(engine, engine.currentPlayer, 5)));
  assert.deepEqual(capture(engine), before, `Web depth ${depth} changed its source`);
}

test('native overrides bind exact canonical search and preserve only documented native imports', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'compat/web/manifest.json')));
  const normalize = source => source.replaceAll('\r\n', '\n')
    .replace(/^import .*from ["']\.\/MultiplayerClock\.js[^\n]*\n/gm, '')
    .replace(/^import .*from ["']\.\/PortableClone\.js[^\n]*\n/gm, '')
    .replace(/\?v=[^"']+/g, '');
  for (const filename of ['AIEngine.js', 'MultiplayerHardRollout.js', 'MultiplayerHardFallback.js']) {
    const entry = manifest.overrides[`web/web前端/${filename}`];
    const canonical = await fs.readFile(path.join(repo, 'web/web前端', filename));
    const override = await fs.readFile(path.join(repo, entry.override));
    assert.equal(sha(canonical), entry.canonicalSha256);
    assert.equal(sha(override), entry.overrideSha256);
    assert.equal(normalize(override.toString()), normalize(canonical.toString()));
  }
  const source = await fs.readFile(path.join(root, 'compat/web/AIEngine.js'), 'utf8');
  assert.ok(source.includes('GameEngine.js?v=20261020-three1'));
  assert.ok(source.includes('multiplayerClock as performance'));
});

for (const depth of [2, 3, 4, 5, 6]) test(`native exact depth ${depth} matches Web scores, actions and complete state`, () => {
  const engine = native.restoreGame(settings, actions), before = capture(engine);
  const ai = new native.MinimaxAI(depth);
  assert.deepEqual(plain(ai.getTopMoves(engine, engine.currentPlayer, 5)), reference.get(depth));
  assert.equal(ai.lastSearch.depth, depth);
  assert.deepEqual(capture(engine), before);
});

test('native Hard completes base four first and publishes only complete fifth/sixth iterations', () => {
  const engine = native.restoreGame(settings, actions), before = capture(engine);
  const ai = new native.MinimaxAI(4, { iterativeDeepening: true, now: () => 0 });
  assert.equal(ai.extensionTimeMs, 100); assert.equal(ai.maxExtraDepth, 2);
  assert.deepEqual(plain(ai.getTopMoves(engine, engine.currentPlayer, 5)), reference.get(6));
  assert.deepEqual(reference.get(4)[0].point, [2, 2]);
  assert.deepEqual(reference.get(6)[0].point, [2, 0]);
  assert.equal(ai.depth, 4); assert.equal(ai.lastSearch.baseDepth, 4); assert.equal(ai.lastSearch.completedDepth, 6);
  assert.deepEqual(plain(ai.lastSearch.deeperIterations.map(row => [row.depth, row.complete])), [[5, true], [6, true]]);
  assert.deepEqual(capture(engine), before);
});

for (const expireAt of [2, 8, 40]) test(`native deadline at poll ${expireAt} keeps complete base four and restores state`, () => {
  const engine = native.restoreGame(settings, actions), before = capture(engine);
  let polls = 0;
  const ai = new native.MinimaxAI(4, { iterativeDeepening: true,
    now: () => ++polls >= expireAt ? 1000 : 0 });
  assert.deepEqual(plain(ai.getTopMoves(engine, engine.currentPlayer, 5)), reference.get(4));
  assert.equal(ai.lastSearch.baseDepth, 4); assert.equal(ai.lastSearch.completedDepth, 4);
  assert.equal(ai.lastSearch.extensionInterrupted, true); assert.equal(ai.depth, 4);
  if (expireAt === 40) assert.ok(ai.lastSearch.deeperIterations.some(row => !row.complete && row.exactRoots > 0));
  assert.deepEqual(capture(engine), before);
});

test('native clock remains monotonic in milliseconds with no performance global', () => {
  const times = [10, 5, 20], context = vm.createContext({ Date: clockDate(() => times.shift() ?? 20) });
  vm.runInContext(coreBuild.outputFiles[0].text, context, { timeout: 10000 });
  assert.equal(vm.runInContext('typeof performance', context), 'undefined');
  assert.deepEqual([context.nativeMinimax.clock.now(), context.nativeMinimax.clock.now(), context.nativeMinimax.clock.now()], [10, 10, 20]);
});

function actualWorker(now = () => 0) {
  let receive, sequence = 0;
  const pending = new Map();
  const context = vm.createContext({ Date: clockDate(now), worker: {
    onMessage: callback => { receive = callback; },
    postMessage: message => { pending.get(message.id)?.(plain(message)); pending.delete(message.id); },
  } });
  vm.runInContext(workerBuild.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send(kind, profile) {
    const id = ++sequence;
    return new Promise(resolve => {
      pending.set(id, resolve);
      receive({ id, kind, payload: { settings, actions, ...(profile ? { profile } : {}) }, context: { player: 'BLACK' } });
    });
  } };
}
const worker = actualWorker();
const budgetedReference = new BudgetedMinimaxAI({ timeMs: 3000, reserveMs: 200, maxDepth: 8, now: () => 0 });
const hardRanking = plain(budgetedReference.getTopMoves(webPosition(), 'BLACK', 5, { startedAt: 0, deadline: 3000 }));
for (const [profile, depth] of [['minimax-2', 2], ['minimax-3', 3], ['minimax-4', null]])
  test(`actual compiled native ${profile} exposes the correct completed search through result.search`, async () => {
    const before = await worker.send('STATE'); assert.equal(before.ok, true, before.error);
    for (const kind of ['AI', 'HINT', 'ANALYZE']) {
      const answer = await worker.send(kind, profile); assert.equal(answer.ok, true, answer.error);
      const result = answer.result, expected = (profile === 'minimax-4' ? hardRanking : reference.get(depth)).slice(0, kind === 'ANALYZE' ? 3 : 1);
      assert.deepEqual(result.moves, expected);
      assert.equal(result.profile, profile); assert.equal(result.stateHash, before.result.stateHash);
      if (profile === 'minimax-4') {
        // Quality tradeoff: product Hard obeys a shared deadline. The old core
        // base4 + completed5/6 behavior remains tested, unchanged, above.
        assert.equal(result.search.algorithm, 'budgeted-minimax-candidate-v1');
        assert.equal(result.search.requestedDepth, 8);
        assert.equal(result.search.completedDepth, budgetedReference.lastSearch.completedDepth);
        assert.equal(result.search.timeMs, 3000); assert.equal(result.search.guardReserveMs, 200);
        assert.equal(result.search.totalDeadline - result.search.startedAt, 3000);
        assert.equal(result.search.trainingLabel, false);
        assert.ok(result.search.iterations.every(row => row.complete));
      } else {
        assert.equal(result.search.depth, depth);
        assert.equal(result.search.iterativeDeepening, undefined);
        assert.equal(result.search.deeperIterations, undefined);
      }
      const after = await worker.send('STATE'); assert.equal(after.ok, true, after.error);
      assert.deepEqual(after.result, before.result);
    }
    for (const name of ['performance', 'URL', 'fetch', 'structuredClone', 'window', 'document', 'wx', 'require'])
      assert.equal(vm.runInContext(`typeof ${name}`, worker.context), 'undefined', name);
  });

test('actual compiled Hard expiry reports its shallow/fallback quality tradeoff without an unlimited base four', async () => {
  let polls = 0;
  const limited = actualWorker(() => ++polls >= 2 ? 5000 : 0);
  const before = await limited.send('STATE'); assert.equal(before.ok, true, before.error);
  const answer = await limited.send('ANALYZE', 'minimax-4'); assert.equal(answer.ok, true, answer.error);
  assert.ok(answer.result.moves.length > 0);
  assert.equal(answer.result.search.completedDepth, 0);
  assert.equal(answer.result.search.fallback, 'legal-placement');
  assert.equal(answer.result.search.shallowQualityTradeoff, true);
  assert.equal(answer.result.search.requestedDepth, 8);
  assert.equal(answer.result.search.trainingLabel, false);
  assert.ok(Array.isArray(answer.result.moves[0].point));
  const after = await limited.send('STATE'); assert.deepEqual(after.result, before.result);
});
