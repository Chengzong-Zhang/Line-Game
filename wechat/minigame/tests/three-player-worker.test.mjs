import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build, readNativeWebSource } from '../tools/native-build.mjs';
import { sut, root, plain } from './helpers.mjs';
import { createEmbeddedThreePlayerAI, THREE_PLAYER_MODEL_CHECKSUM } from '../src/three-player-ai.js';
import { THREE_PLAYER_PROFILE } from '../src/controllers.js';
import { threePlayerCandidates } from '../../../web/web前端/ThreePlayerAI.js';
import { PASS_TRAINED_POLICY_DATA } from '../../../web/web前端/PassTrainedPolicyData.js';

const repo = path.resolve(root, '../..');
const copied = path.join(repo, 'web/web前端');
const modelPath = 'assets/research-ai/three-player-policy-v1.json';
const modelBytes = await fs.readFile(path.join(copied, modelPath));
const modelPayload = JSON.parse(modelBytes);
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/three-player-r4-v1.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const queryPlugin = { name: 'strip-cache-query', setup(ctx) {
  ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
} };
async function nativeWorker({ tamper = false } = {}) {
  const corruption = { name: 'tamper-only-in-memory', setup(ctx) {
    ctx.onLoad({ filter: /three-player-policy-v1\.json$/ }, async () => {
      const changed = plain(modelPayload); changed.weights[1] += 0.001;
      return { contents: JSON.stringify(changed), loader: 'json' };
    });
  } };
  const result = await build({ entryPoints: [path.join(root, 'src/workers/index.js')],
    bundle: true, write: false, platform: 'browser', target: 'es2018', format: 'iife',
    plugins: [queryPlugin, ...(tamper ? [corruption] : [])], loader: { '.md': 'text' },
    define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });
  let receive, answer;
  const context = vm.createContext({ worker: { onMessage: fn => { receive = fn; }, postMessage: value => { answer = plain(value); } } });
  vm.runInContext(result.outputFiles[0].text, context, { timeout: 10000 });
  return { context, send(kind, settings, actions = [], extra = {}, player) {
    answer = null;
    receive({ id: 47, kind, payload: { settings, actions, profile: THREE_PLAYER_PROFILE, ...extra },
      context: player === undefined ? { epoch: 8 } : { epoch: 8, player } });
    assert.ok(answer, 'pure Worker inference must respond synchronously');
    assert.equal(answer.id, 47); return answer;
  } };
}
const worker = await nativeWorker();
const completeState = engine => JSON.stringify({ state: engine._captureReplayState(), batch: engine._isReplayingBatch,
  rules: sut.serializeRuleState(engine), snapshot: engine.getSnapshot() }, (_, value) => {
  const type = Object.prototype.toString.call(value);
  return type === '[object Map]' ? { map: [...value] } : type === '[object Set]' ? { set: [...value] } : value;
});
test('frozen r4 algorithm/model provenance and canonical integrity are pinned without changing policy math', async () => {
  assert.equal(fixture.schema, 'lifeline-three-player-r4-reference'); assert.equal(fixture.version, 1);
  assert.equal(fixture.provenance.sourceSha256['ThreePlayerAI.js'], 'edfa92c657fa28a617f18586191a09686336af15843a8423a07b863743e0381b');
  assert.equal(sha256(modelBytes), '8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794');
  assert.equal(sha256(modelBytes), fixture.provenance.sourceSha256[modelPath]);
  assert.equal(THREE_PLAYER_MODEL_CHECKSUM, `sha256:${sha256(sut.canonicalize(modelPayload))}`);
  assert.equal(THREE_PLAYER_MODEL_CHECKSUM, fixture.provenance.modelCanonicalSha256);
  assert.equal(THREE_PLAYER_PROFILE, modelPayload.id);
  const migrated = (await readNativeWebSource('ThreePlayerAI.js')).replace(/\r\n/g, '\n').split('\n').slice(3).join('\n');
  const v3CompatibilityGate = '!["territory-v2", "territory-v3"].includes(engine.rulesVersion)';
  assert.equal(migrated.split(v3CompatibilityGate).length - 1, 1, 'the only hash-normalized source difference is the declared v3 compatibility gate');
  const frozenPolicySource = migrated.replace(v3CompatibilityGate, 'engine.rulesVersion !== "territory-v2"');
  const restoredOriginal = frozenPolicySource
    .replace('const MODEL_PATH = "./assets/research-ai/three-player-policy-v1.json?v=20261020-three1";',
      'const MODEL_URL = new URL("./assets/research-ai/three-player-policy-v1.json?v=20261020-three1", import.meta.url);')
    .replace('const spec = JSON.parse(JSON.stringify(payload));', 'const spec = structuredClone(payload);')
    .replace('const response = await fetch(new URL(MODEL_PATH, import.meta.url));', 'const response = await fetch(MODEL_URL);');
  assert.equal(sha256(restoredOriginal), fixture.provenance.algorithmNormalizedLfSha256,
    'only the declared compatibility substitutions may differ from deployed policy source');
  assert.equal(fixture.positions.length, 9);
  assert.deepEqual(fixture.positions.map(position => `${position.settings.gridSize}/${position.player}`).sort(),
    [5, 7, 15].flatMap(size => ['BLACK', 'WHITE', 'PURPLE'].map(player => `${size}/${player}`)).sort());
});

test('three seats at sizes 5/7/15 retain legal complete rankings and exactly match frozen Web policy/model', () => {
  for (const { id: label, settings, actions, player, expected } of fixture.positions) {
    assert.equal(settings.rulesVersion, 'territory-v2', `${label}: frozen parent fixture`);
    const actualAI = createEmbeddedThreePlayerAI(THREE_PLAYER_PROFILE, settings.rulesVersion);
    assert.equal(actualAI.model.spec.passDisciplineTraining, undefined, `${label}: v2 keeps frozen parent weights`);
    assert.ok(actions.length > 0, `${label}: use a non-opening position`);
    const engine = sut.restoreGame(settings, actions);
    const before = completeState(engine), actor = engine.currentPlayer;
    assert.equal(actor, player, label);
    const moves = plain(actualAI.getTopMoves(engine, actor, 1000));
    assert.deepEqual(moves, expected, label);
    const legal = new Set(engine.getLegalMoves().map(move => move.point.join(',')));
    assert.equal(moves.length, legal.size, label); assert.ok(moves.length > 0);
    assert.equal(new Set(moves.map(move => move.point.join(','))).size, moves.length);
    assert.ok(moves.every(move => legal.has(move.point.join(',')) && Number.isFinite(move.score) && move.prior > 0 && move.visits === 1));
    assert.ok(Math.abs(moves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-12);
    assert.equal(completeState(engine), before, `${label}: full current state/history`);
    for (const kind of ['AI', 'HINT', 'ANALYZE']) {
      const answer = worker.send(kind, settings, actions, {}, actor);
      assert.equal(answer.ok, true, answer.error);
      assert.equal(answer.result.player, actor);
      assert.equal(answer.result.stateHash, sut.ruleView(engine).stateHash);
      assert.deepEqual(answer.result.moves, moves.slice(0, kind === 'ANALYZE' ? 3 : 1), `${label}/${kind}`);
      if (kind === 'ANALYZE') assert.deepEqual({ profile: answer.result.profile, metric: answer.result.metric },
        { profile: THREE_PLAYER_PROFILE, metric: 'policy-score' });
    }
  }
});

// Independent 17-coefficient evaluation: the reference uses current exported
// weights and real rule features, without the overlay loader or PASS wrapper.
function raw17Ranking(candidates, weights) {
  assert.equal(weights.length, 17);
  const moves = candidates.map(({ point, features }) => ({ point,
    score: features.reduce((sum, feature, index) => sum + feature * weights[index], 0), visits: 1 }));
  moves.push({ type: 'pass', point: null, score: weights[16], visits: 1 });
  moves.sort((a, b) => b.score - a.score || (a.point === null ? 1 : b.point === null ? -1
    : a.point[1] - b.point[1] || a.point[0] - b.point[0]));
  const maximum = moves[0].score, total = moves.reduce((sum, move) => sum + Math.exp(move.score - maximum), 0);
  return moves.map(move => ({ ...move, prior: Math.exp(move.score - maximum) / total }));
}

test('territory-v3 current candidate matches independent raw17 rankings with legal PASS and complete rollback; strength is not asserted', () => {
  const entry = PASS_TRAINED_POLICY_DATA.models['three-v1'];
  assert.match(entry.candidate_sha256, /^[a-f0-9]{64}$/);
  const ai = createEmbeddedThreePlayerAI(THREE_PLAYER_PROFILE, 'territory-v3');
  assert.deepEqual(plain(ai.model.spec.weights), entry.weights.slice(0, 16));
  assert.equal(ai.model.spec.temperature, 1);
  assert.equal(ai.model.spec.passBias, entry.weights[16]);
  assert.equal(ai.model.spec.passDisciplineTraining.candidate_sha256, entry.candidate_sha256);
  for (const position of fixture.positions) {
    const settings = { ...position.settings, rulesVersion: 'territory-v3' };
    const engine = sut.restoreGame(settings, position.actions), before = completeState(engine);
    const candidates = threePlayerCandidates(engine, engine.currentPlayer);
    const moves = plain(ai.getTopMoves(engine, engine.currentPlayer, 1000));
    assert.deepEqual(moves, raw17Ranking(candidates, entry.weights), `${position.id}: exact raw17 ranking`);
    const legal = new Set(engine.getLegalMoves().map(move => move.point.join(',')));
    assert.equal(moves.length, legal.size + 1, position.id);
    assert.equal(new Set(moves.map(move => move.point === null ? 'PASS' : move.point.join(','))).size, moves.length);
    assert.equal(moves.filter(move => move.type === 'pass' && move.point === null).length, 1);
    assert.ok(moves.every(move => move.point === null ? move.type === 'pass'
      : legal.has(move.point.join(','))), position.id);
    assert.ok(Math.abs(moves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-12);
    const passProbe = sut.restoreGame(settings, position.actions);
    assert.equal(passProbe.skipTurn().success, true, `${position.id}: PASS must be legal`);
    assert.equal(completeState(engine), before, `${position.id}: full state/history preserved`);
  }
});

test('three-player speculation retains Superko history, resignation and replay-batch flags', () => {
  for (const batch of [false, true]) {
    const settings = sut.settingsFor(5, 3), engine = sut.restoreGame(settings);
    assert.equal(engine.resignPlayer('WHITE').success, true);
    const blocked = engine.getLegalMoves()[0].point, probe = sut.restoreGame(settings, [{ type: 'resign', player: 'WHITE' }]);
    assert.equal(probe.playMove(blocked).success, true);
    engine.historyHashes.add(probe._computeStateHash(probe.currentPlayer));
    engine._isReplayingBatch = batch;
    const before = completeState(engine);
    const moves = createEmbeddedThreePlayerAI().getTopMoves(engine, engine.currentPlayer, 1000);
    assert.equal(moves.some(move => move.point?.join(',') === blocked.join(',')), false);
    assert.equal(completeState(engine), before);
    assert.throws(() => createEmbeddedThreePlayerAI().getTopMoves(engine, 'WHITE'), /当前行动方/);
    assert.equal(completeState(engine), before);
  }
});

test('Worker rejects wrong three-player profiles/actors, replacement models and the profile in two-player games', () => {
  const settings = sut.settingsFor(5, 3);
  for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    for (const profile of [undefined, 'human', 'greedy', 'minimax-2', 'model:unknown', 'three-player-policy-v3']) {
      assert.equal(worker.send(kind, settings, [], { profile }).error, 'INVALID_CONTROLLERS');
    }
    for (const player of ['WHITE', 'PURPLE', 'unknown', 1]) {
      assert.equal(worker.send(kind, settings, [], { player }).error, 'WRONG_PLAYER');
      assert.equal(worker.send(kind, settings, [], {}, player).error, 'WRONG_PLAYER');
    }
    assert.equal(worker.send(kind, settings, [], { model: { id: THREE_PLAYER_PROFILE } }).error, 'MODEL_INTEGRITY');
    assert.equal(worker.send(kind, sut.settingsFor(5)).error, 'INVALID_CONTROLLERS');
    assert.equal(worker.send(kind, settings, [{ type: 'resign', player: 'WHITE' }, { type: 'resign', player: 'PURPLE' }]).error, 'GAME_OVER');
  }
});

test('compiled Worker requires no URL/fetch/structuredClone and unchanged two-player defaults still infer locally', () => {
  for (const key of ['URL', 'fetch', 'structuredClone', 'TextEncoder', 'window', 'document', 'wx', 'require']) {
    assert.equal(vm.runInContext(`typeof ${key}`, worker.context), 'undefined', key);
  }
  const settings = sut.settingsFor(5);
  for (const [difficulty, Algorithm, args] of [['easy', sut.GreedyAI, []], ['normal', sut.MinimaxAI, [2]]]) {
    const engine = sut.restoreGame(settings);
    const expected = plain(new Algorithm(...args).getTopMoves(engine, engine.currentPlayer, 1));
    const answer = worker.send('AI', settings, [], { profile: undefined, difficulty });
    assert.equal(answer.ok, true, answer.error); assert.deepEqual(answer.result.moves, expected);
  }
});

test('runtime canonical checksum rejects altered embedded weights even when the model schema stays valid', async () => {
  const modified = await nativeWorker({ tamper: true });
  for (const kind of ['AI', 'HINT', 'ANALYZE']) {
    assert.equal(modified.send(kind, sut.settingsFor(5, 3)).error, 'MODEL_INTEGRITY');
  }
});
