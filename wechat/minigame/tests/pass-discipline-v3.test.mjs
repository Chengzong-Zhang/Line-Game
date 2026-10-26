import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from '../tools/native-build.mjs';
import { sut, root, plain } from './helpers.mjs';
import { PASS_DISCIPLINE_CONTRACT as PRODUCT_PASS_CONTRACT } from '../../../web/web前端/AIPassDisciplineV3.js';
import { passDisciplineRuleState, protectedRootInvariantHolds } from '../../../web/web前端/AIPassDisciplineV2.js';
const fixture = JSON.parse(await fs.readFile(new URL('../../../web/web前端/tests/fixtures/pass-discipline-v3-real-states.json', import.meta.url), 'utf8'));
const queries = { name: 'strip-cache-query', setup(ctx) {
  ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
async function nativeWorker(forcedRawPassGuardProbe = false) {
  const forced = { name: 'forced-raw-pass-guard-probe-only', setup(ctx) {
    ctx.onLoad({ filter: /[\\/]MultiplayerHardRuntime\.js$/ }, () => ({ loader: 'js', contents: `
      export function createHardRuntimeV2() { return {
        modelInfo: { implementationId: 'forced-raw-pass-guard-probe-only', forcedRawPassGuardProbe: true },
        ai: { lastSearch: { algorithm: 'forced-raw-pass-guard-probe-only' }, getTopMoves(_source, _actor, n) {
          return n > 0 ? [{ type: 'pass', point: null, score: 100, prior: 1, visits: 1 }] : [];
        } }
      }; }
    ` }));
  } };
  const built = await build({ entryPoints: [path.join(root, 'src/workers/index.js')], bundle: true, write: false,
    platform: 'browser', target: 'es2018', format: 'iife', plugins: [queries, ...(forcedRawPassGuardProbe ? [forced] : [])],
    define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });
  let receive, next = 0; const pending = new Map();
  const context = vm.createContext({ worker: { onMessage: fn => { receive = fn; },
    postMessage: answer => { pending.get(answer.id)?.(plain(answer)); pending.delete(answer.id); } } });
  vm.runInContext(built.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send: (kind, settings, actions, player, profile = 'multiplayer-easy-v1') => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    receive({ id, kind, payload: { settings, actions, profile }, context: { player } });
  }) };
}
const real = await nativeWorker(), probe = await nativeWorker(true);
const key = point => point.join(',');
const pieces = (engine, actor) => ({ nodes: new Set(engine._getPlayerNodes(actor).map(key)),
  coverage: new Set([...engine._getPlayerNodes(actor), ...engine._getPlayerLines(actor)].map(key)) });
const area = (engine, actor) => engine._computeOwnedWallArea(
  [...engine._getPlayerNodes(actor), ...engine._getPlayerLines(actor)],
  engine._getOpponents(actor).flatMap(p => [...engine._getPlayerNodes(p), ...engine._getPlayerLines(p)]));
function stateFor(entry) {
  const settings = { ...fixture.openingState };
  const actions = fixture.prefix.slice(0, entry.ply).map(action => ({ type: action.point === null ? 'skip' : 'move', point: action.point }));
  const engine = sut.restoreGame(settings, actions), before = sut.ruleView(engine);
  return { settings, actions, engine, before, beforePieces: pieces(engine, entry.actor), beforeArea: area(engine, entry.actor),
    expectedHash: `sha256:${createHash('sha256').update(JSON.stringify(passDisciplineRuleState(engine))).digest('hex')}` };
}
function assertStrictSafeGrowth(result, source, entry) {
  assert.ok(Array.isArray(result.moves[0].point), 'A real policy PASS must not survive this certified growth opportunity');
  const trial = sut.restoreGame(source.settings, source.actions);
  assert.equal(trial.playMove(result.moves[0].point).success, true);
  assert.ok(area(trial, entry.actor) > source.beforeArea);
  assert.ok(area(trial, entry.actor) >= entry.minimumArea);
  // Independently retain the full structural safety premise for original
  // placements too, rather than accepting an arbitrary legal/risky move.
  assert.equal(protectedRootInvariantHolds(trial, entry.actor, source.beforePieces, source.beforeArea), true);
}
function assertV3Witness(receipt, expectedHash, entry) {
  assert.equal(receipt.schema, PRODUCT_PASS_CONTRACT.schema);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.witness.proofOrder, 'bounded-structural-precheck-before-V2');
  assert.ok(receipt.rootsExamined <= 12);
  assert.ok(receipt.quickElapsedMs <= receipt.quickBudgetMs && receipt.quickBudgetMs <= 8);
  assert.equal(receipt.sourceStateHash, expectedHash);
  assert.equal(receipt.witness.proofType, 'immutable-birth-root-protection-invariant');
  assert.equal(receipt.witness.completeOpponentRound, false);
  assert.equal(receipt.witness.replyActionsCompleted, undefined);
  assert.equal(receipt.witness.minimumReplyAreaLowerBound, entry.minimumArea);
}
// Keep the original real Easy route and also exercise real Hard. More completed
// search can choose a placement before the PASS guard; the guard intentionally
// preserves it. Such a placement still has to prove this fixture's safety.
for (const profile of ['multiplayer-easy-v1', 'multiplayer-hard-v1']) for (const entry of fixture.cases)
  test(`real native ${profile} retains protected strict growth: ${fixture.gameId}/${entry.ply}`, async () => {
    const source = stateFor(entry);
    for (const kind of ['AI', 'HINT', 'ANALYZE']) {
      const answer = await real.send(kind, source.settings, source.actions, entry.actor, profile);
      assert.equal(answer.ok, true, answer.error); assert.equal(answer.context.player, entry.actor);
      assert.equal(answer.result.player, entry.actor); assert.equal(answer.result.stateHash, source.before.stateHash);
      assert.equal(answer.result.modelInfo.forcedRawPassGuardProbe, undefined);
      assertStrictSafeGrowth(answer.result, source, entry);
      const receipt = answer.result.passDiscipline;
      if (receipt.status === 'placement-policy-preserved') {
        assert.equal(receipt.schema, 'lifeline-ai-pass-discipline-v1');
        assert.equal(receipt.witness, null);
      } else {
        assert.equal(receipt.status, 'safe-profitable-expansion'); assert.equal(receipt.complete, true);
        assert.equal(receipt.witness.beforeArea, source.beforeArea);
        assert.ok(receipt.witness.minimumReplyAreaLowerBound >= entry.minimumArea);
        if (receipt.schema === PRODUCT_PASS_CONTRACT.schema) assertV3Witness(receipt, source.expectedHash, entry);
      }
      const state = await real.send('STATE', source.settings, source.actions, entry.actor, profile);
      assert.deepEqual(state.result, plain(source.before), 'Complete Worker rule/snapshot state survives speculation unchanged');
      assert.deepEqual(sut.ruleView(source.engine), source.before);
    }
  });

for (const entry of fixture.cases) test(`explicit in-memory rawPASS stub routes through the real V3 guard: ${fixture.gameId}/${entry.ply}`, async () => {
  const source = stateFor(entry);
  for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    // This stub is only a deterministic guard-path probe; it is not a natural
    // model decision, strength result or latency measurement. Guard budgets
    // and clocks remain the actual native product settings.
    const answer = await probe.send(kind, source.settings, source.actions, entry.actor, 'multiplayer-hard-v1');
    assert.equal(answer.ok, true, answer.error); assert.equal(answer.context.player, entry.actor);
    assert.equal(answer.result.modelInfo.forcedRawPassGuardProbe, true);
    assert.equal(answer.result.player, entry.actor); assert.equal(answer.result.stateHash, source.before.stateHash);
    assert.deepEqual(answer.result.moves[0].point, entry.expectedPoint);
    assertV3Witness(answer.result.passDiscipline, source.expectedHash, entry);
    assertStrictSafeGrowth(answer.result, source, entry);
    const state = await probe.send('STATE', source.settings, source.actions, entry.actor, 'multiplayer-hard-v1');
    assert.deepEqual(state.result, plain(source.before));
  }
});
test('native v3 structural precheck has no browser globals and keeps wrong-actor rejection', async () => {
  for (const key of ['URL', 'fetch', 'structuredClone', 'TextEncoder', 'crypto', 'window', 'document', 'wx', 'require'])
    for (const worker of [real, probe]) assert.equal(vm.runInContext(`typeof ${key}`, worker.context), 'undefined', key);
  const entry = fixture.cases[0], game = fixture;
  const actions = game.prefix.slice(0, entry.ply).map(action => ({ type: action.point === null ? 'skip' : 'move', point: action.point }));
  assert.equal((await real.send('AI', game.openingState, actions, 'PURPLE')).error, 'WRONG_PLAYER');
  assert.equal((await probe.send('AI', game.openingState, actions, 'PURPLE', 'multiplayer-hard-v1')).error, 'WRONG_PLAYER');
});
