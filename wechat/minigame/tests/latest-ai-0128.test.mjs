import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { sut, plain } from './helpers.mjs';
import { canonicalTerminalWinningPass } from '../src/worker-pass.js';
import { createModelFreeModel, ModelFreeAI } from '../../../web/web前端/ModelFreeAI.js';

const script = await fs.readFile(new URL('../dist/workers/index.js', import.meta.url), 'utf8');
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/multiplayer-cut-chain-defense-v1.json', import.meta.url)));
function nativeWorker() {
  let receive, resolve, id = 0;
  const context = vm.createContext({ performance: { now: () => 0 },
    worker: { onMessage(fn) { receive = fn; }, postMessage(value) { resolve(plain(value)); } } });
  vm.runInContext(script, context);
  return async (settings, actions, profile = 'greedy', extra = {}) => {
    return new Promise(done => {
      resolve = done;
      receive({ id: ++id, kind: 'ANALYZE', context: { player: sut.restoreGame(settings, actions).currentPlayer },
        payload: { settings, actions, profile, ...extra } });
    });
  };
}
function uniqueWinner(settings) {
  const actions = []; let engine = sut.restoreGame(settings, actions);
  const actor = engine.currentPlayer;
  for (let turn = 0; turn < 4; turn++) {
    let best;
    for (const move of engine.getLegalMoves()) {
      const trial = sut.restoreGame(settings, actions); assert.equal(trial.playMove(move.point).success, true);
      const area = trial.getSnapshot().territories[actor].area;
      if (!best || area > best.area) best = { point: move.point, area };
    }
    assert.ok(best);
    actions.push({ type: 'move', player: engine.currentPlayer, point: [...best.point] });
    assert.equal(sut.applyAction(engine, actions.at(-1)).success, true);
    while (!engine.gameOver && engine.currentPlayer !== actor) {
      actions.push({ type: 'skip', player: engine.currentPlayer }); assert.equal(engine.skipTurn().success, true);
    }
    const trial = sut.restoreGame(settings, actions); assert.equal(trial.skipTurn().success, true);
    if (trial.gameOver && trial.getWinner() === actor) return { actions, engine };
  }
  assert.fail('Expected unique terminal PASS fixture');
}

test('actual compiled Mini Worker voluntarily passes for a unique immediate terminal win and rejects draws/losses', async () => {
  const send = nativeWorker();
  for (const rulesVersion of ['territory-v2', 'territory-v3']) for (const count of [2, 3, 4, 5, 6]) {
    const settings = { ...sut.settingsFor(5, count), rulesVersion };
    const { actions, engine } = uniqueWinner(settings), before = plain(sut.ruleView(engine));
    const profile = count === 2 ? 'greedy' : 'multiplayer-easy-v1';
    const result = await send(settings, actions, profile);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.moves, [{ point: null, type: 'pass', score: 1_000_000 }]);
    assert.equal(result.result.stateHash, before.stateHash);
    assert.deepEqual(plain(sut.ruleView(engine)), before);
  }
  const settings = { ...sut.settingsFor(5), startPlayer: 'WHITE' };
  const draw = await send(settings, [{ type: 'skip', player: 'WHITE' }]);
  assert.equal(draw.ok, true, draw.error); assert.ok(Array.isArray(draw.result.moves[0].point));
  const losing = await send(settings, [{ type: 'move', player: 'WHITE', point: [2, 0] },
    { type: 'move', player: 'BLACK', point: [1, 0] }, { type: 'skip', player: 'WHITE' }]);
  assert.equal(losing.ok, true, losing.error); assert.ok(Array.isArray(losing.result.moves[0].point));
  const ordinary = await send(sut.settingsFor(5), []);
  assert.equal(ordinary.ok, true, ordinary.error); assert.ok(Array.isArray(ordinary.result.moves[0].point));
});

test('PASS preflight cannot bypass profile/model integrity and falls back on deadline/errors without mutating input', async () => {
  const send = nativeWorker(), settings = sut.settingsFor(5), { actions, engine } = uniqueWinner(settings);
  assert.equal((await send(settings, actions, 'human')).error, 'INVALID_CONTROLLERS');
  const model = sut.MODEL_CATALOG[0];
  assert.equal((await send(settings, actions, model.profile, { model: { id: model.id, raw: new ArrayBuffer(4) } })).error, 'MODEL_INTEGRITY');
  const before = plain(sut.ruleView(engine));
  assert.equal(canonicalTerminalWinningPass(engine, 'WHITE', () => 0), null);
  const times = [0, 61]; assert.equal(canonicalTerminalWinningPass(engine, engine.currentPlayer, () => times.shift() ?? 61), null);
  assert.equal(canonicalTerminalWinningPass(engine, engine.currentPlayer, () => { throw new Error('clock'); }), null);
  assert.deepEqual(plain(sut.ruleView(engine)), before);
});

test('model-free action head preserves voluntary PASS among legal actions under strict native tensor verification', () => {
  const entry = sut.MODEL_CATALOG.find(row => row.spec.model_family === 'dqn'); assert.ok(entry);
  const values = new Float32Array(entry.spec.float_count), spec = entry.spec;
  const engine = sut.restoreGame(sut.settingsFor(5));
  const bias = spec.tensors.find(row => row.name === 'layers.4.bias'); assert.ok(bias);
  values[bias.offset + engine.validPositions.length] = 10;
  const before = plain(sut.ruleView(engine));
  const ai = new ModelFreeAI(createModelFreeModel(spec, values.buffer));
  const moves = ai.getTopMoves(engine, engine.currentPlayer, Infinity);
  assert.equal(moves[0].type, 'pass'); assert.equal(moves[0].point, null);
  assert.ok(moves[0].prior > .99); assert.equal(moves.length, engine.getLegalMoves().length + 1);
  assert.deepEqual(plain(sut.ruleView(engine)), before);
});

test('compiled Mini easy and medium policies execute the latest completed countercut defense gate', async () => {
  const send = nativeWorker();
  const variant = fixture.coordinateVariants.triangle, scenario = fixture.fixtures.find(row => row.kind === 'defense');
  const settings = { ...sut.settingsFor(variant.gridSize, 3), startingPointMode: 'custom', initialPositions: variant.initialPositions };
  const actions = [], engine = sut.restoreGame(settings);
  for (const point of scenario.prefix) {
    const action = point === null ? { type: 'skip', player: engine.currentPlayer } : { type: 'move', player: engine.currentPlayer, point };
    actions.push(action); assert.equal(sut.applyAction(engine, action).success, true);
    if (action.player === 'WHITE') while (!engine.gameOver && engine.currentPlayer !== 'BLACK') {
      actions.push({ type: 'skip', player: engine.currentPlayer }); assert.equal(engine.skipTurn().success, true);
    }
  }
  const before = plain(sut.ruleView(engine));
  for (const profile of ['multiplayer-easy-v1', 'multiplayer-medium-v1']) {
    const result = await send(settings, actions, profile);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.moves[0].point, scenario.candidate);
    assert.equal(result.result.search.standardDefenseGate.status, 'selected-strict-defense-improvement');
    assert.equal(result.result.stateHash, before.stateHash);
  }
  assert.deepEqual(plain(sut.ruleView(engine)), before);
});
