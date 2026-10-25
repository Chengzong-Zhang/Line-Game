import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from '../tools/native-build.mjs';
import { sut, root, plain } from './helpers.mjs';
import { passDisciplineRuleState } from '../../../web/web前端/AIPassDisciplineV2.js';
const fixture = JSON.parse(await fs.readFile(new URL('../../../web/web前端/tests/fixtures/pass-discipline-v2-real-states.json', import.meta.url), 'utf8'));
const queries = { name: 'strip-cache-query', setup(ctx) {
  ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
const built = await build({ entryPoints: [path.join(root, 'src/workers/index.js')], bundle: true, write: false,
  platform: 'browser', target: 'es2018', format: 'iife', plugins: [queries],
  define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });
let receive, next = 0; const pending = new Map();
const context = vm.createContext({ worker: { onMessage: fn => { receive = fn; },
  postMessage: answer => { pending.get(answer.id)?.(plain(answer)); pending.delete(answer.id); } } });
vm.runInContext(built.outputFiles[0].text, context, { timeout: 10000 });
const send = (kind, settings, actions, player) => new Promise(resolve => {
  const id = ++next; pending.set(id, resolve);
  receive({ id, kind, payload: { settings, actions, profile: 'multiplayer-easy-v1' }, context: { player } });
});
for (const entry of fixture.cases) test(`real native Worker replaces conservative PASS with protected strict growth: ${entry.gameId}/${entry.ply}`, async () => {
  const game = fixture.games[entry.gameId], settings = { ...game.openingState };
  const actions = game.prefix.slice(0, entry.ply).map(action => ({ type: action.point === null ? 'skip' : 'move', point: action.point }));
  const engine = sut.restoreGame(settings, actions), before = sut.ruleView(engine);
  const expectedHash = `sha256:${createHash('sha256').update(JSON.stringify(passDisciplineRuleState(engine))).digest('hex')}`;
  for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    const answer = await send(kind, settings, actions, entry.actor);
    assert.equal(answer.ok, true, answer.error); assert.equal(answer.context.player, entry.actor);
    assert.equal(answer.result.player, entry.actor); assert.equal(answer.result.stateHash, before.stateHash);
    const receipt = answer.result.passDiscipline;
    assert.equal(receipt.schema, 'lifeline-ai-pass-discipline-v2');
    assert.equal(receipt.sourceStateHash, expectedHash);
    assert.equal(receipt.witness.proofType, 'immutable-birth-root-protection-invariant');
    assert.equal(receipt.witness.completeOpponentRound, false);
    assert.equal(receipt.witness.replyActionsCompleted, undefined);
    assert.equal(receipt.witness.minimumReplyAreaLowerBound, entry.minimumArea);
    assert.ok(Array.isArray(answer.result.moves[0].point));
    const trial = sut.restoreGame(settings, actions);
    assert.equal(trial.playMove(answer.result.moves[0].point).success, true);
    assert.ok(trial._computeOwnedWallArea([...trial._getPlayerNodes(entry.actor), ...trial._getPlayerLines(entry.actor)],
      trial._getOpponents(entry.actor).flatMap(p => [...trial._getPlayerNodes(p), ...trial._getPlayerLines(p)])) > receipt.witness.beforeArea);
    const state = await send('STATE', settings, actions, entry.actor);
    assert.equal(state.result.stateHash, before.stateHash, 'Worker cache survives speculation unchanged');
  }
});
test('native v2 structural proof has no browser globals and keeps wrong-actor rejection', async () => {
  for (const key of ['URL', 'fetch', 'structuredClone', 'TextEncoder', 'crypto', 'window', 'document', 'wx', 'require'])
    assert.equal(vm.runInContext(`typeof ${key}`, context), 'undefined', key);
  const entry = fixture.cases[0], game = fixture.games[entry.gameId];
  const actions = game.prefix.slice(0, entry.ply).map(action => ({ type: action.point === null ? 'skip' : 'move', point: action.point }));
  assert.equal((await send('AI', game.openingState, actions, 'WHITE')).error, 'WRONG_PLAYER');
});
