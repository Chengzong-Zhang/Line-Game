import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, readNativeWebSource } from '../tools/native-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.resolve(root, '../../web/web前端');
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const queries = { name: 'strip-query', setup(b) {
  b.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
const common = { bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2018',
  define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' };
const sources = `
export * from './src/core.js';
export * from './src/state.js';
export * from './src/multiplayer-ai.js';
export * from './src/worker-pass.js';
export * from './src/three-player-ai.js';
export * from './src/hex-player-ai.js';
export { loadMultiplayerRuntime as resourceRuntime } from '../../web/web前端/MultiplayerRuntime.js';
export { default as easyManifest } from '../../web/web前端/assets/research-ai/multiplayer-v1/easy.json' with { type: 'json' };
`;
const compiledAPI = await build({ ...common, stdin: { contents: sources, resolveDir: root }, globalName: 'SUT', plugins: [queries] });
function api(clock) {
  const context = vm.createContext(clock ? { performance: clock } : {});
  vm.runInContext(compiledAPI.outputFiles[0].text, context, { timeout: 10000 });
  return { sut: context.SUT, context };
}
async function worker({ clock, tamper = null } = {}) {
  const plugins = [queries];
  if (tamper) plugins.push({ name: 'tamper-model', setup(b) {
    b.onLoad({ filter: new RegExp(`${tamper}\\.json$`) }, async args => {
      const value = JSON.parse(await fs.readFile(args.path, 'utf8'));
      (value.models?.[0] || value).weights[0] += 0.125;
      return { contents: JSON.stringify(value), loader: 'json' };
    });
  } });
  const result = await build({ ...common, entryPoints: [path.join(root, 'src/workers/index.js')], plugins });
  let receive, sequence = 0;
  const pending = new Map();
  const context = vm.createContext({ ...(clock ? { performance: clock } : {}),
    worker: { onMessage: handler => { receive = handler; }, postMessage: response => {
      pending.get(response.id)?.(plain(response)); pending.delete(response.id);
    } } });
  vm.runInContext(result.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send(kind, settings, profile, actions = [], extra = {}, requestContext = {}) {
    const id = ++sequence, context = { epoch: 5, ...requestContext };
    return new Promise(resolve => {
      pending.set(id, response => { assert.equal(response.id, id); assert.deepEqual(response.context, context); resolve(response); });
      receive({ id, kind, context, payload: { settings, profile, actions, ...extra } });
    });
  } };
}
const { sut } = api();
const native = await worker();
const profiles = ['multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'];
const settings = (count = 3, size = 5, shape) => ({ ...sut.settingsFor(size, count),
  boardShape: shape || (count === 3 ? 'triangle' : 'hexagon') });
function assertLegal(engine, moves) {
  assert.ok(moves.length);
  for (const move of moves) {
    assert.ok(Number.isFinite(move.score));
    if (move.point === null) assert.equal(move.type, 'pass');
    else assert.ok(engine._evaluateMove(move.point, engine.currentPlayer).legal, JSON.stringify(move));
  }
}
function stamp(engine) {
  return { view: plain(sut.ruleView(engine)), revision: engine.positionRevision,
    territoryRevision: engine._territoryStateRevision, history: [...engine.historyHashes],
    grid: engine.grid, edges: engine.edges, territories: engine.cachedTerritories };
}
function assertUnchanged(engine, before) {
  const after = stamp(engine);
  assert.deepEqual(after.view, before.view); assert.deepEqual(after.history, before.history);
  for (const key of ['revision', 'territoryRevision', 'grid', 'edges', 'territories']) assert.equal(after[key], before[key], key);
}

test('shared search and rollout retain the frozen 2026-10-24 Web source after the clock import', async () => {
  for (const [name, expected] of [
    ['MultiplayerSearch.js', '4d282be9ea2b825dc5efc025cfb5d5c7955788c6880509e821088e33b05605ef'],
    ['MultiplayerRollout.js', '58b6040c7c3592ea3c701b22fb6a6054468b2acf3c6d4ab77f791321a14e6117'],
  ]) {
    const content = (await readNativeWebSource(name)).replace(/\r\n/g, '\n');
    const boundary = content.indexOf('\n') + 1;
    assert.equal(content.slice(0, boundary),
      'import { multiplayerClock as performance } from "./MultiplayerClock.js";\n');
    const frozenSource = content.slice(boundary);
    const v3Admission = '!["territory-v2", "territory-v3"].includes(source.rulesVersion)';
    assert.equal(frozenSource.split(v3Admission).length - 1, 1);
    const normalized = frozenSource.replace(v3Admission, 'source.rulesVersion !== "territory-v2"');
    assert.equal(sha(normalized), expected);
  }
  assert.equal(sut.easyManifest.sourceManifestSha256, 'd7560db53483ab9ee2a7c423509142924545f1679ec35201b369e3b91fe161a0');
  assert.deepEqual(plain(sut.easyManifest.models.map(item => item.id)), ['multiplayer-easy-v1']);
});

test('all three tiers execute in the real compiled Worker without browser globals and preserve cached state', async () => {
  for (const count of [3, 4, 5, 6]) {
    const config = settings(count), engine = sut.restoreGame(config), actions = [];
    for (let i = 0; i < 2; i++) {
      const action = { type: 'move', player: engine.currentPlayer, point: [...engine.getLegalMoves()[0].point] };
      assert.equal(sut.applyAction(engine, action).success, true); actions.push(action);
    }
    const before = plain(sut.ruleView(engine));
    for (const profile of profiles) {
      const response = await native.send('AI', config, profile, actions, {}, { player: engine.currentPlayer });
      assert.equal(response.ok, true, `${count}/${profile}: ${response.error}`);
      assert.equal(response.result.modelInfo.id, profile); assert.equal(response.result.profile, profile);
      assert.equal(response.result.player, engine.currentPlayer); assert.equal(response.result.stateHash, before.stateHash);
      assertLegal(engine, response.result.moves);
      const after = await native.send('STATE', config, null, actions);
      assert.deepEqual(after.result, before);
    }
  }
  for (const name of ['performance', 'URL', 'fetch', 'crypto', 'TextEncoder', 'structuredClone', 'window', 'document', 'wx', 'require']) {
    assert.equal(vm.runInContext(`typeof ${name}`, native.context), 'undefined', name);
  }
});

test('easy and medium include size 15, while medium keeps the exact original v4/v1 lineage routing', async () => {
  for (const [count, size, lineage] of [[3, 5, 'three-player-search-v4-round12'], [3, 9, 'three-player-search-v4-round12'],
    [3, 11, 'three-player-policy-v1'], [3, 15, 'three-player-policy-v1'], [4, 15, 'hex-player-policy-v1'], [6, 15, 'hex-player-policy-v1']]) {
    const config = settings(count, size), engine = sut.restoreGame(config), before = stamp(engine);
    const runtime = await sut.createEmbeddedMultiplayerRuntime('multiplayer-medium-v1', engine);
    assert.equal(runtime.modelInfo.lineage, lineage);
    assertLegal(engine, runtime.ai.getTopMoves(engine, engine.currentPlayer, 3)); assertUnchanged(engine, before);
    const medium = await native.send('ANALYZE', config, 'multiplayer-medium-v1');
    assert.equal(medium.ok, true, medium.error);
    assert.equal(medium.result.metric, lineage === 'three-player-search-v4-round12' ? 'search-score' : 'policy-score');
    assertLegal(engine, medium.result.moves);
    if (size === 15) {
      const reply = await native.send('ANALYZE', config, 'multiplayer-easy-v1');
      assert.equal(reply.ok, true, reply.error); assertLegal(engine, reply.result.moves);
      assert.equal(reply.result.metric, 'policy-score');
    }
  }
});

test('native and alternate shapes run easy/hard; medium and ultimate reject unsupported configuration', async () => {
  for (const count of [3, 4, 5, 6]) {
    const config = settings(count, 5, count === 3 ? 'hexagon' : 'triangle');
    const engine = sut.restoreGame(config);
    for (const profile of ['multiplayer-easy-v1', 'multiplayer-hard-v1']) {
      const reply = await native.send('ANALYZE', config, profile);
      assert.equal(reply.ok, true, reply.error); assertLegal(engine, reply.result.moves);
      if (profile.includes('hard')) assert.equal(reply.result.search.algorithm, 'paranoid-alpha-beta');
    }
    assert.equal((await native.send('AI', config, 'multiplayer-medium-v1')).error, 'INVALID_CONTROLLERS');
    await assert.rejects(sut.createEmbeddedMultiplayerRuntime('multiplayer-medium-v1', engine), /INVALID_CONTROLLERS/);
  }
  for (const profile of [...profiles, 'multiplayer-ultimate-v1']) {
    assert.equal((await native.send('AI', settings(2, 5, 'triangle'), profile)).error, 'INVALID_CONTROLLERS');
  }
  for (const profile of ['multiplayer-ultimate-v1', 'multiplayer-easy-v2']) {
    assert.equal((await native.send('AI', settings(), profile)).error, 'INVALID_CONTROLLERS');
    await assert.rejects(sut.createEmbeddedMultiplayerRuntime(profile, sut.restoreGame(settings())), /INVALID_CONTROLLERS/);
  }
  for (const patch of [{ gridSize: 4 }, { gridSize: 16 }, { gridSize: 5.5 }, { playerCount: 7 },
    { rulesVersion: 'territory-v1' }, { boardShape: 'square' }]) {
    await assert.rejects(sut.createEmbeddedMultiplayerRuntime(profiles[0], { ...sut.restoreGame(settings()), ...patch }), /INVALID_CONTROLLERS/);
  }
});

test('Worker rejects wrong actor and replacement model payload; embedded easy/medium integrity is pinned', async () => {
  for (const profile of profiles) {
    assert.equal((await native.send('AI', settings(), profile, [], { player: 'WHITE' })).error, 'WRONG_PLAYER');
    assert.equal((await native.send('AI', settings(), profile, [], {}, { player: 'WHITE' })).error, 'WRONG_PLAYER');
    assert.equal((await native.send('AI', settings(), profile, [], { model: { id: profile } })).error, 'MODEL_INTEGRITY');
  }
  for (const [tamper, profile, count] of [['easy', profiles[0], 3], ['three-player-search-v4-round12', profiles[1], 3],
    ['hex-player-policy-v1', profiles[1], 4]]) {
    const corrupted = await worker({ tamper });
    assert.equal((await corrupted.send('AI', settings(count), profile)).error, 'MODEL_INTEGRITY');
  }
});

test('resource injection and native adapter return identical rankings with deterministic deadline decisions', async () => {
  const clock = { value: 0, now() { this.value += 50; return this.value; }, reset() { this.value = 0; } };
  const { sut: timed } = api(clock), workerClock = { ...clock }, timedWorker = await worker({ clock: workerClock });
  const loaders = {
    loadNativeHardRuntime: timed.createEmbeddedHardRuntime,
    loadAssetModel: async () => ({ spec: plain(timed.easyManifest.models[0]) }),
    loadThreePlayerRuntime: async id => ({ ai: timed.createEmbeddedThreePlayerAI(id), modelInfo: { id } }),
    loadHexPlayerModel: async () => (await timed.createEmbeddedHexPlayerAI()).model,
  };
  for (const config of [settings(3, 5), settings(4, 5), settings(3, 5, 'hexagon')]) for (const profile of profiles) {
    if (profile === profiles[1] && config.boardShape === 'hexagon' && config.playerCount === 3) continue;
    const engine = timed.restoreGame(config), runtime = await timed.resourceRuntime(profile, engine, loaders);
    clock.reset(); assert.equal(timed.canonicalTerminalWinningPass(engine, engine.currentPlayer), null);
    const expected = plain(runtime.ai.getTopMoves(engine, engine.currentPlayer, 3, { terminalWinningPassPrechecked: true }));
    const expectedStats = plain(runtime.ai.lastSearch);
    workerClock.reset(); const reply = await timedWorker.send('ANALYZE', config, profile);
    assert.equal(reply.ok, true, reply.error); assert.deepEqual(reply.result.moves, expected);
    // The unchanged v4 implementation reports Date.now() timing only; it does
    // not use that elapsed field to choose moves or decide its fixed rollout.
    const actualStats = { ...reply.result.search };
    delete actualStats.elapsedMs; delete expectedStats.elapsedMs;
    assert.deepEqual(actualStats, expectedStats);
    if (profile === profiles[2] && config.boardShape !== (config.playerCount === 3 ? 'triangle' : 'hexagon')) {
      assert.equal(reply.result.search.timedOut, true);
      if (config.playerCount === 4 || config.boardShape === 'triangle') {
        assert.equal(reply.result.search.publicationMode, 'complete-phase');
        assert.deepEqual(reply.result.search.completedPhases, []);
        assert.equal(reply.result.search.usedFallback, true);
        assert.equal(reply.result.search.partialPhasePublished, false);
      }
    }
  }
});

test('hard Date clock fallback keeps canonical state/caches; terminal positions return no action', async () => {
  for (const config of [settings(3), settings(4), settings(4, 5, 'triangle')]) {
    const engine = sut.restoreGame(config), before = stamp(engine);
    const runtime = await sut.createEmbeddedMultiplayerRuntime(profiles[2], engine);
    assertLegal(engine, runtime.ai.getTopMoves(engine, engine.currentPlayer, 1)); assertUnchanged(engine, before);
    assert.ok(runtime.ai.lastSearch.elapsedMs >= 0 && Number.isFinite(runtime.ai.lastSearch.elapsedMs));
    engine.gameOver = true;
    assert.deepEqual(plain(runtime.ai.getTopMoves(engine)), []);
  }
});
