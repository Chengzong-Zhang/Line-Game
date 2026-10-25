import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from '../tools/native-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..'), webRoot = path.join(repo, 'web/web前端');
const plain = value => JSON.parse(JSON.stringify(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const queries = { name: 'strip-query', setup(b) {
  b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) }));
} };
const exported = ['core', 'state', 'integrity', 'controllers', 'model-catalog', 'three-player-ai', 'hex-player-ai'];
const bundled = await build({ stdin: { contents: exported.map(name => `export * from './src/${name}.js';`).join('\n'), resolveDir: root },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [queries], logLevel: 'silent' });
const sut = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const profiles = ['three-player-policy-v1', 'three-player-policy-v2', 'three-player-search-v4-round12', 'hex-player-policy-v1', 'hex-player-search-v5'];
const multiplayerLevels = ['multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'];
const nativeOptions = { entryPoints: [path.join(root, 'src/workers/index.js')], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2018', define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' };
async function worker(tamperId = null) {
  const plugins = [queries];
  if (tamperId) plugins.push({ name: 'tamper', setup(b) {
    b.onLoad({ filter: new RegExp(`${tamperId}\\.json$`) }, async args => {
      const payload = JSON.parse(await fs.readFile(args.path, 'utf8')); payload.weights[0] += .01;
      return { contents: JSON.stringify(payload), loader: 'json' };
    });
  } });
  const compiled = await build({ ...nativeOptions, plugins });
  let receive, sequence = 0; const pending = new Map();
  const context = vm.createContext({ worker: { onMessage: callback => { receive = callback; },
    postMessage: answer => { pending.get(answer.id)?.(plain(answer)); pending.delete(answer.id); } } });
  vm.runInContext(compiled.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send(kind, settings, profile, actions = [], extra = {}) {
    const id = ++sequence;
    return new Promise(resolve => { pending.set(id, resolve); receive({ id, kind, context: { epoch: 11 }, payload: { settings, profile, actions, ...extra } }); });
  } };
}
const native = await worker();
const settings = (size, count, boardShape) => ({ ...sut.settingsFor(size, count), ...(boardShape ? { boardShape } : {}) });

test('every selectable AI has exact count, shape and size compatibility; defaults never promote experiments', () => {
  assert.equal(sut.MODEL_CATALOG.length, 17); assert.equal(sut.CONTROLLER_CHOICES.length, 22);
  assert.deepEqual(sut.MULTIPLAYER_AI_CATALOG.map(item => item.profile), [...profiles, ...multiplayerLevels]);
  for (const count of [2, 3, 4, 5, 6]) for (const shape of ['triangle', 'hexagon']) for (const size of [5, 7, 9, 11, 15]) {
    const config = settings(size, count, shape), choices = sut.controllerChoices(config);
    assert.deepEqual(sut.controllerChoices(count, { boardShape: shape, gridSize: size }), choices);
    const generic = shape !== (count >= 4 ? 'hexagon' : 'triangle');
    const legacyExpected = generic ? ['human', 'greedy'] : count === 2 ? sut.CONTROLLER_CHOICES : count === 3
      ? ['human', 'three-player-policy-v1', 'three-player-policy-v2', ...([5, 7, 9].includes(size) ? ['three-player-search-v4-round12'] : [])]
      : ['human', 'hex-player-policy-v1', ...([5, 7].includes(size) ? ['hex-player-search-v5'] : [])];
    const expected = [...legacyExpected, ...(count === 2 ? [] : generic
      ? ['multiplayer-easy-v1', 'multiplayer-hard-v1'] : multiplayerLevels)];
    assert.deepEqual(choices, expected);
    const defaultProfile = sut.defaultAIProfile(config);
    assert.ok(choices.includes(defaultProfile)); assert.notEqual(defaultProfile, 'three-player-policy-v2'); assert.notEqual(defaultProfile, 'hex-player-search-v5');
    for (const profile of choices) {
      const controllers = Object.fromEntries(sut.playerIds(count).map(player => [player, profile]));
      assert.deepEqual(sut.validateControllers(controllers, config), controllers);
    }
    if (generic) assert.equal(defaultProfile, 'greedy');
  }
  assert.equal(sut.presetControllers('ai-white', 'normal', 2, { boardShape: 'hexagon', gridSize: 5 }).WHITE, 'greedy');
});

test('all frozen policy bytes and explicit factories preserve identity and reject unknown policy IDs', async () => {
  const expected = {
    'three-player-policy-v1': '8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794',
    'three-player-policy-v2': '00fc241c500dfd01ff85b5e2a4f1907cc5a9d8307d68bb78be64b0aad129f56e',
    'three-player-search-v4-round12': '9b85f5fff27001d68407c30d6f707b461b1b468d657c8292339e97d23868c230',
    'hex-player-policy-v1': '74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b',
    'hex-player-search-v5': 'e19d45b26e5fb7e2783e392993622bede692838043a9cb4d5af91d170f8448b5',
  };
  for (const [profile, digest] of Object.entries(expected)) {
    assert.equal(sha(await fs.readFile(path.join(webRoot, `assets/research-ai/${profile}.json`))), digest);
    const ai = profile.startsWith('three') ? sut.createEmbeddedThreePlayerAI(profile) : await sut.createEmbeddedHexPlayerAI(profile);
    assert.equal((ai.spec || ai.model?.spec)?.id, profile);
  }
  assert.throws(() => sut.createEmbeddedThreePlayerAI('three-player-policy-v9'), /MODEL_INTEGRITY/);
  await assert.rejects(sut.createEmbeddedHexPlayerAI('hex-player-search-v4'), /MODEL_INTEGRITY/);
});

test('all 17 two-player weight packages and every basic search depth actually infer in the compiled Worker', async () => {
  const config = settings(5, 2), engine = sut.restoreGame(config), before = sut.ruleView(engine);
  for (const profile of sut.CONTROLLER_CHOICES.filter(item => item !== 'human')) {
    const model = sut.modelForProfile(profile), extra = {};
    if (model) {
      const bytes = await fs.readFile(path.join(root, model.sourcePath));
      assert.equal(bytes.length, model.bytes); assert.equal(sha(bytes), model.spec.asset_sha256);
      extra.model = { id: model.id, raw: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    const answer = await native.send('AI', config, profile, [], extra);
    assert.equal(answer.ok, true, `${profile}: ${answer.error}`);
    assert.equal(answer.result.stateHash, before.stateHash); assert.equal(answer.result.player, 'BLACK');
    assert.ok(answer.result.moves.length);
    assert.ok(answer.result.moves.every(move => move.point === null || before.snapshot.legalMoves.some(legal => legal.point.join() === move.point.join())), profile);
  }
});

test('new three-player v2 and v4 policies run with legal replies and preserve full current state', async () => {
  for (const [profile, sizes] of [['three-player-policy-v2', [5, 7, 15]], ['three-player-search-v4-round12', [5, 7, 9]]]) {
    for (const size of sizes) {
      const config = settings(size, 3), engine = sut.restoreGame(config), ai = sut.createEmbeddedThreePlayerAI(profile);
      const before = plain(sut.ruleView(engine));
      const expected = plain(ai.getTopMoves(engine, engine.currentPlayer, 3));
      assert.deepEqual(plain(sut.ruleView(engine)), before);
      assert.ok(expected.length && expected.every(move => engine.getLegalMoves().some(legal => legal.point.join() === move.point.join())));
      const response = await native.send('ANALYZE', config, profile);
      assert.equal(response.ok, true, response.error); assert.deepEqual(response.result.moves, expected);
      assert.equal(response.result.stateHash, before.stateHash); assert.equal(response.result.profile, profile);
      assert.equal(response.result.metric, profile.includes('search') ? 'search-score' : 'policy-score');
    }
  }
});

test('hex v5 runs on 5/7 with each supported count and preserves complete history and caches', async () => {
  let searched = 0;
  for (const size of [5, 7]) for (const count of [4, 5, 6]) {
    const config = settings(size, count), engine = sut.restoreGame(config), actions = [];
    let seed = 20261021 + size * 100 + count;
    engine._isReplayingBatch = true;
    for (let index = 0; index < 16 && !engine.gameOver; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const legal = engine.getLegalMoves(), action = legal.length ? { type: 'move', point: legal[seed % legal.length].point, player: engine.currentPlayer }
        : { type: 'skip', player: engine.currentPlayer };
      assert.equal(sut.applyAction(engine, action).success, true); actions.push(action);
    }
    engine._isReplayingBatch = false; engine._updateTerritories();
    assert.equal(engine.gameOver, false);
    const before = plain(sut.ruleView(engine)), ai = await sut.createEmbeddedHexPlayerAI('hex-player-search-v5');
    const moves = plain(ai.getTopMoves(engine, engine.currentPlayer, 3)); searched += ai.lastSearch.simulations;
    assert.deepEqual(plain(sut.ruleView(engine)), before);
    assert.ok(moves.length && moves.every(move => engine.getLegalMoves().some(legal => legal.point.join() === move.point.join())));
    const answer = await native.send('ANALYZE', config, 'hex-player-search-v5', actions);
    assert.equal(answer.ok, true, answer.error); assert.deepEqual(answer.result.moves, moves);
    assert.equal(answer.result.stateHash, before.stateHash); assert.equal(answer.result.metric, 'search-score');
  }
  assert.ok(searched > 0, 'At least one actual v5 tactical search must run, not only the quiet-position v1 ranking');
});

test('all non-native count/shape combinations run generic Greedy and reject every trained geometry model', async () => {
  for (const count of [2, 3, 4, 5, 6]) {
    const config = settings(5, count, count >= 4 ? 'triangle' : 'hexagon');
    const expected = new sut.GreedyAI().getTopMoves(sut.restoreGame(config), 'BLACK', 1);
    const answer = await native.send('AI', config, 'greedy');
    assert.equal(answer.ok, true, answer.error); assert.deepEqual(answer.result.moves, plain(expected));
    for (const profile of [...profiles, sut.MODEL_CATALOG[0].profile, 'minimax-2']) {
      assert.equal((await native.send('AI', config, profile)).error, 'INVALID_CONTROLLERS');
    }
  }
});

test('explicit unsupported search sizes fail instead of silently substituting v1; no native browser APIs needed', async () => {
  for (const profile of ['three-player-search-v4-round12', 'hex-player-search-v5']) for (const size of [11, 15]) {
    assert.equal((await native.send('AI', settings(size, profile.startsWith('three') ? 3 : 4), profile)).error, 'INVALID_CONTROLLERS');
  }
  for (const name of ['URL', 'fetch', 'structuredClone', 'TextEncoder', 'crypto', 'window', 'document', 'wx', 'require']) {
    assert.equal(vm.runInContext(`typeof ${name}`, native.context), 'undefined', name);
  }
  for (const id of ['three-player-policy-v2', 'three-player-search-v4-round12', 'hex-player-search-v5']) {
    const altered = await worker(id);
    assert.equal((await altered.send('AI', settings(5, id.startsWith('three') ? 3 : 4), id)).error, 'MODEL_INTEGRITY');
  }
});
