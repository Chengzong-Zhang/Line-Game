import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build, readNativeWebSource } from '../tools/native-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..'), frontend = path.join(repo, 'web/web前端');
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/hex-player-r4-v1.json', import.meta.url), 'utf8'));
const modelPath = 'assets/research-ai/hex-player-policy-v1.json';
const modelBytes = await fs.readFile(path.join(frontend, modelPath)), payload = JSON.parse(modelBytes);
const plain = value => JSON.parse(JSON.stringify(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const queries = { name: 'cache-query', setup(ctx) {
  ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
const source = await build({ stdin: { contents: [
  ...['core', 'state', 'integrity', 'controllers', 'hex-player-ai'].map(name => `export * from './src/${name}.js';`),
  "export * from '../../web/web前端/HexPlayerAI.js';",
  "export { saveState, restoreState } from '../../web/web前端/AIEngine.js';",
].join('\n'), resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [queries], logLevel: 'silent' });
const sut = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
async function nativeWorker({ tamper = false } = {}) {
  const corruption = { name: 'corrupt-in-memory-only', setup(ctx) {
    ctx.onLoad({ filter: /hex-player-policy-v1\.json$/ }, () => {
      const changed = plain(payload); changed.weights[2] += 0.01;
      return { contents: JSON.stringify(changed), loader: 'json' };
    });
  } };
  const built = await build({ entryPoints: [path.join(root, 'src/workers/index.js')], bundle: true, write: false,
    platform: 'browser', target: 'es2018', format: 'iife', plugins: [queries, ...(tamper ? [corruption] : [])],
    define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });
  let receive, nextId = 0; const pending = new Map();
  const context = vm.createContext({ worker: { onMessage: fn => { receive = fn; },
    postMessage: answer => { pending.get(answer.id)?.(plain(answer)); pending.delete(answer.id); } } });
  vm.runInContext(built.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send(kind, settings, actions = [], extra = {}, actor) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      try { receive({ id, kind, payload: { settings, actions, profile: sut.HEX_PLAYER_PROFILE, ...extra },
        context: actor === undefined ? { epoch: 9 } : { epoch: 9, player: actor } }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  } };
}
const worker = await nativeWorker();
function completeState(engine) {
  const snapshot = engine.getSnapshot();
  return JSON.stringify({ captured: engine._captureReplayState(), batch: engine._isReplayingBatch,
    rule: sut.serializeRuleState(engine), snapshot }, (_, value) => {
    const type = Object.prototype.toString.call(value);
    return type === '[object Map]' ? { map: [...value] } : type === '[object Set]' ? { set: [...value] } : value;
  });
}
test('portable frozen r4 fixture and v1 model are pinned; only explicit compatibility substitutions change policy source', async () => {
  assert.equal(fixture.schema, 'lifeline-hex-player-r4-reference'); assert.equal(fixture.version, 1);
  assert.equal(fixture.provenance.sourceSha256['HexPlayerAI.js'], '62340c349b53a13e20d47171187228a2359c5d8dcbf12344a4bf6a0017b9f673');
  assert.equal(sha(modelBytes), '74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b');
  assert.equal(sha(modelBytes), fixture.provenance.sourceSha256[modelPath]);
  assert.equal(sut.HEX_PLAYER_MODEL_CHECKSUM, fixture.provenance.modelCanonicalSha256);
  assert.equal(sut.checksum(payload), sut.HEX_PLAYER_MODEL_CHECKSUM);
  const body = { ...payload }; delete body.integrity;
  assert.equal(sha(JSON.stringify(body)), fixture.provenance.modelInnerPayloadSha256);
  assert.equal(sha(JSON.stringify(body)), payload.integrity.payload_sha256);
  assert.notEqual(sut.checksum(body).slice(7), payload.integrity.payload_sha256, 'Internal integrity is insertion-order JSON, not canonical JSON');
  const migrated = (await readNativeWebSource('HexPlayerAI.js')).replace(/\r\n/g, '\n').split('\n').slice(3).join('\n');
  const v3CompatibilityGate = '!["territory-v2", "territory-v3"].includes(engine.rulesVersion)';
  assert.equal(migrated.split(v3CompatibilityGate).length - 1, 1, 'the only hash-normalized source difference is the declared v3 compatibility gate');
  const frozenPolicySource = migrated.replace(v3CompatibilityGate, 'engine.rulesVersion !== "territory-v2"');
  const restored = frozenPolicySource
    .replace('const MODEL_PATH = "./assets/research-ai/hex-player-policy-v1.json?v=20261021-hexai1";', 'const MODEL_URL = new URL("./assets/research-ai/hex-player-policy-v1.json?v=20261021-hexai1", import.meta.url);')
    .replace('export async function createHexPlayerModel(payload, hashText) {', 'export async function createHexPlayerModel(payload) {')
    .replace('  let hash;\n  if (hashText) hash = await hashText(JSON.stringify(body));\n  else {\n    if (!globalThis.crypto?.subtle) throw new Error("无法校验六边形 AI 模型完整性。");\n    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));\n    hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");\n  }',
      '  if (!globalThis.crypto?.subtle) throw new Error("无法校验六边形 AI 模型完整性。");\n  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));\n  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");')
    .replace('const spec = JSON.parse(JSON.stringify(payload));', 'const spec = structuredClone(payload);')
    .replace('const response = await fetch(new URL(MODEL_PATH, import.meta.url));', 'const response = await fetch(MODEL_URL);');
  assert.equal(sha(restored), fixture.provenance.algorithmNormalizedLfSha256);
  const migratedEngine = (await readNativeWebSource('AIEngine.js'))
    .replace('./GameEngine.js?v=20261013-full-features1', './GameEngine.js?v=20261020-three1');
  // The 45 frozen v2 rankings below still bind historical policy behavior.
  // The whole shared engine now includes the admitted 2026-10-24 scoring/performance changes.
  assert.equal(sha(migratedEngine), 'fd43cd3053a0b92569a4d26524a036f45a2920271cc06a49ef0200aec07ffabf', 'Admitted latest 77c6c05 plus owner-authorized AI source must remain frozen');
  assert.equal(fixture.positions.length, 45);
  const expectedIds = [4, 5, 6].flatMap(count => [5, 7, 15].flatMap(size => sut.playerIds(count).map(player => `${count}/${size}/${player}`)));
  assert.deepEqual(fixture.positions.map(p => `${p.settings.playerCount}/${p.settings.gridSize}/${p.player}`).sort(), expectedIds.sort());
});

test('all 45 frozen seat/size rankings are legal and identical, preserving full six-seat state and caches', async () => {
  const ai = await sut.createEmbeddedHexPlayerAI();
  for (const position of fixture.positions) {
    const { settings, actions, player, expected, id } = position;
    assert.ok(actions.length >= settings.playerCount, id);
    const engine = sut.restoreGame(settings, actions), before = completeState(engine);
    assert.equal(engine.currentPlayer, player, id);
    assert.deepEqual(Object.fromEntries(engine.activePlayers.map(p => [p, engine.edges[p].size])), position.edgeCounts, id);
    const actual = plain(ai.getTopMoves(engine, player, 10000));
    assert.deepEqual(actual, expected, id);
    const legal = new Set(engine.getLegalMoves().map(move => move.point.join(',')));
    assert.equal(actual.length, legal.size, id); assert.ok(actual.length > 0, id);
    assert.equal(new Set(actual.map(move => move.point.join(','))).size, actual.length, id);
    assert.ok(actual.every(move => legal.has(move.point.join(',')) && Number.isFinite(move.score) && move.prior > 0 && move.visits === 1), id);
    assert.ok(Math.abs(actual.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-12, id);
    assert.equal(completeState(engine), before, `${id}: complete state/cache/history rollback`);
  }
});

test('territory-v3 compatibility returns legal hex moves without mutating game state; strength is not asserted', async () => {
  const settings = sut.settingsFor(5, 4);
  const engine = sut.restoreGame(settings);
  const before = completeState(engine);
  const moves = plain((await sut.createEmbeddedHexPlayerAI()).getTopMoves(engine, engine.currentPlayer, 10000));
  const legal = new Set(engine.getLegalMoves().map(move => move.point.join(',')));
  assert.ok(moves.length > 0);
  assert.ok(moves.every(move => legal.has(move.point.join(','))));
  assert.equal(completeState(engine), before);
});

test('real compiled native Worker infers every hex seat and all three maximum-size variants without browser globals', async () => {
  for (const key of ['URL', 'fetch', 'structuredClone', 'TextEncoder', 'crypto', 'window', 'document', 'wx', 'require']) {
    assert.equal(vm.runInContext(`typeof ${key}`, worker.context), 'undefined', key);
  }
  const positions = fixture.positions.filter(p => p.settings.gridSize === 5
    || p.settings.gridSize === 15 && p.player === sut.playerIds(p.settings.playerCount).at(-1));
  assert.equal(positions.length, 18);
  for (const { settings, actions, player, expected, id } of positions) for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    const answer = await worker.send(kind, settings, actions, {}, player);
    assert.equal(answer.ok, true, `${id}/${kind}: ${answer.error}`);
    assert.equal(answer.result.player, player, id);
    assert.equal(answer.result.stateHash, sut.ruleView(sut.restoreGame(settings, actions)).stateHash, id);
    assert.deepEqual(answer.result.moves, expected.slice(0, kind === 'ANALYZE' ? 3 : 1), `${id}/${kind}`);
    if (kind === 'ANALYZE') assert.deepEqual({ profile: answer.result.profile, metric: answer.result.metric },
      { profile: sut.HEX_PLAYER_PROFILE, metric: 'policy-score' });
  }
});

test('six-seat snapshots preserve GREEN/ORANGE/CYAN edges, resignations, Superko and exception rollback', async () => {
  const ai = await sut.createEmbeddedHexPlayerAI();
  const position = fixture.positions.find(p => p.id === 'players-6-size-5-black');
  for (const ownAutoSkip of [false, true]) for (const batch of [false, true]) {
    const engine = sut.restoreGame(position.settings, position.actions);
    for (const p of ['GREEN', 'ORANGE', 'CYAN']) assert.ok(engine.edges[p].size > 0, `${p} must have a real edge witness`);
    assert.equal(engine.resignPlayer('WHITE').success, true);
    const rejectedPoint = engine.getLegalMoves()[0].point;
    const probe = sut.restoreGame(position.settings, [...position.actions, { type: 'resign', player: 'WHITE' }]);
    assert.equal(probe.playMove(rejectedPoint).success, true);
    engine.historyHashes.add(probe._computeStateHash(probe.currentPlayer));
    engine._isReplayingBatch = batch;
    if (ownAutoSkip) engine._checkAndAutoSkip = engine._checkAndAutoSkip.bind(engine);
    const method = engine._checkAndAutoSkip, before = completeState(engine);
    const moves = ai.getTopMoves(engine, engine.currentPlayer, 10000);
    assert.equal(moves.some(move => String(move.point) === String(rejectedPoint)), false);
    assert.equal(completeState(engine), before);
    assert.equal(engine._checkAndAutoSkip, method);
    assert.equal(Object.hasOwn(engine, '_checkAndAutoSkip'), ownAutoSkip);
    const state = sut.saveState(engine);
    assert.deepEqual(Object.keys(state.edges), sut.playerIds(6));
    for (const player of engine.activePlayers) engine.edges[player].clear();
    engine.grid.clear(); engine.historyHashes.clear(); engine.resignedPlayers.clear();
    sut.restoreState(engine, state); assert.equal(completeState(engine), before);
    const originalPlay = engine.playMove;
    engine.playMove = function(point) { originalPlay.call(this, point); throw new Error('injected candidate failure'); };
    assert.throws(() => ai.getTopMoves(engine, engine.currentPlayer), /injected candidate failure/);
    delete engine.playMove;
    assert.equal(completeState(engine), before);
    assert.equal(engine._checkAndAutoSkip, method);
    assert.equal(Object.hasOwn(engine, '_checkAndAutoSkip'), ownAutoSkip);
    assert.throws(() => ai.getTopMoves(engine, 'WHITE'), /当前行动方/);
  }
});

test('Worker strictly isolates two-player, three-player and hex profiles, actors and embedded weights', async () => {
  for (const count of [4, 5, 6]) for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    const settings = sut.settingsFor(5, count);
    for (const profile of [undefined, 'human', 'greedy', 'minimax-2', sut.THREE_PLAYER_PROFILE, 'hex-player-policy-v2', 'model:unknown']) {
      assert.equal((await worker.send(kind, settings, [], { profile })).error, 'INVALID_CONTROLLERS');
    }
    for (const actor of ['WHITE', 'CYAN', 'unknown', 1]) {
      assert.equal((await worker.send(kind, settings, [], { player: actor })).error, 'WRONG_PLAYER');
      assert.equal((await worker.send(kind, settings, [], {}, actor)).error, 'WRONG_PLAYER');
    }
    assert.equal((await worker.send(kind, settings, [], { model: {} })).error, 'MODEL_INTEGRITY');
    const resigned = sut.playerIds(count).slice(1).map(player => ({ type: 'resign', player }));
    assert.equal((await worker.send(kind, settings, resigned)).error, 'GAME_OVER');
    for (const otherCount of [2, 3]) assert.equal((await worker.send(kind, sut.settingsFor(5, otherCount))).error, 'INVALID_CONTROLLERS');
  }
});

test('insertion-order integrity and the additional complete-payload pin reject changes independently', async () => {
  const original = await sut.createHexPlayerModel(payload, sha);
  assert.equal(original.spec.integrity.payload_sha256, payload.integrity.payload_sha256);
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(sut.checksum(reordered), sut.checksum(payload));
  await assert.rejects(sut.createHexPlayerModel(reordered, sha), /完整性校验失败/);
  const changed = plain(payload); changed.weights[0] += 0.001;
  await assert.rejects(sut.createHexPlayerModel(changed, sha), /完整性校验失败/);
  const modified = await nativeWorker({ tamper: true });
  for (const kind of ['AI', 'HINT', 'ANALYZE']) assert.equal((await modified.send(kind, sut.settingsFor(5, 6))).error, 'MODEL_INTEGRITY');
});
