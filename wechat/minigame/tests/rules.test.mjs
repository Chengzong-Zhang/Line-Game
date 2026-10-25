import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { sut, web, root, plain } from './helpers.mjs';

const bundle = await fs.readFile(path.join(root, 'dist/workers/index.js'), 'utf8');
let receive, answer;
const sandbox = vm.createContext({ worker: { onMessage: fn => { receive = fn; }, postMessage: result => { answer = plain(result); } } });
vm.runInContext(bundle, sandbox, { timeout: 10000 });
function task(kind, settings, actions, extra = {}) {
  receive({ id: 31, kind, payload: { settings, actions, ...extra }, context: { epoch: 5 } });
  assert.equal(answer.id, 31); assert.deepEqual(answer.context, { epoch: 5 });
  assert.equal(answer.ok, true, answer.error); return answer.result;
}

test('compiled Worker runs without DOM, wx, TextEncoder, crypto or require', () => {
  for (const key of ['window', 'document', 'wx', 'TextEncoder', 'crypto', 'require']) assert.equal(vm.runInContext(`typeof ${key}`, sandbox), 'undefined');
  assert.equal(task('STATE', sut.settingsFor(7), []).snapshot.rulesVersion, 'territory-v3');
});

test('all sizes: bundled replay agrees with live Web after every move, pass and resignation', () => {
  for (let size = 5; size <= 15; size++) {
    const settings = sut.settingsFor(size), original = new web.GameEngine(settings), actions = [];
    for (let i = 0; i < 10 && !original.gameOver; i++) {
      const legal = original.getLegalMoves(), action = { type: 'move', player: original.currentPlayer, point: legal[(i * 17 + size) % legal.length].point };
      assert.equal(original.playMove(action.point).success, true); actions.push(action);
      const r = task('STATE', settings, actions);
      assert.deepEqual(r.ruleState, plain(sut.serializeRuleState(original)), `size ${size}, step ${i}`);
      assert.deepEqual(r.snapshot, plain(original.getSnapshot()));
    }
    if (!original.gameOver) { const p = original.currentPlayer; original.resignPlayer(p); actions.push({ type: 'resign', player: p }); }
    assert.deepEqual(task('STATE', settings, actions).snapshot, plain(original.getSnapshot()));
    const passed = task('STATE', settings, [{ type: 'skip' }, { type: 'skip' }]);
    assert.equal(passed.snapshot.gameOver, true); assert.equal(passed.snapshot.winner, 'DRAW');
  }
});

test('five teaching positions retain cuts, the three-point restriction, auto-skip and exact scores', () => {
  for (const level of sut.TUTORIAL_LEVELS) {
    const settings = sut.settingsFor(level.gridSize);
    if (level.restriction) {
      receive({ kind: 'APPLY', payload: { settings, actions: level.prefix, action: { type: 'move', point: level.restriction.point } } });
      assert.equal(answer.ok, false); assert.equal(answer.error, 'INVALID_MOVE');
    }
    const before = task('STATE', settings, level.prefix);
    const after = task('APPLY', settings, level.prefix, { action: level.objective });
    if (level.id === 'L3-cut-and-clear') {
      assert.ok(before.snapshot.edges.WHITE.length > after.snapshot.edges.WHITE.length);
      assert.equal(after.snapshot.boardMatrix[3][2], 0); assert.equal(after.snapshot.boardMatrix[4][1], 0);
    }
    if (level.id === 'L5-settle-score') {
      assert.equal(before.snapshot.currentPlayer, 'BLACK'); assert.equal(before.snapshot.consecutiveSkips, 1);
      assert.equal(after.snapshot.gameOver, true); assert.equal(after.snapshot.winner, 'BLACK');
    }
    const original = new web.GameEngine(settings);
    for (const a of [...level.prefix, level.objective]) assert.equal(sut.applyAction(original, a).success, true);
    assert.deepEqual(after.snapshot, plain(original.getSnapshot()));
  }
});

test('Superko history is part of the checksum and affects legality', () => {
  const original = new web.GameEngine(sut.settingsFor()), before = sut.ruleView(original);
  const probe = new web.GameEngine(sut.settingsFor()); probe.playMove([1, 0]);
  const repeated = probe._computeStateHash(probe.currentPlayer);
  original.historyHashes.add(repeated);
  assert.notEqual(sut.ruleView(original).stateHash, before.stateHash);
  assert.equal(original.playMove([1, 0]).reason, 'SUPERKO_VIOLATION');
  assert.deepEqual(sut.restoreGame(sut.settingsFor(), [{ type: 'move', point: [1, 0] }]).historyHashes, probe.historyHashes);
});

test('hashes agree with Node SHA-256 including Unicode', () => {
  for (const input of [{ text: '生命线 🐱 \ud800' }, { z: [1, 2], a: null }]) {
    assert.equal(sut.checksum(input), `sha256:${createHash('sha256').update(sut.canonicalize(input)).digest('hex')}`);
  }
});

test('invalid settings, unknown action and wrong actor cannot change a live engine', () => {
  assert.throws(() => sut.restoreGame({ ...sut.settingsFor(), rulesVersion: 'territory-v1' }), /INVALID_SETTINGS/);
  assert.throws(() => sut.restoreGame(sut.settingsFor(), [{ type: 'move', point: [99, 99] }]), /INVALID_POINT/);
  const engine = sut.restoreGame(sut.settingsFor()), before = sut.ruleView(engine).stateHash;
  assert.throws(() => sut.applyAction(engine, { type: 'move', player: 'WHITE', point: [1, 0] }), /WRONG_PLAYER/);
  assert.throws(() => sut.applyAction(engine, { type: 'unknown' }), /INVALID_ACTION/);
  assert.equal(sut.ruleView(engine).stateHash, before);
});

test('real thread runs both AI difficulties with legal results and unchanged full rule state', async () => {
  const worker = new Worker(new URL('./worker-thread.mjs', import.meta.url));
  try {
    const settings = sut.settingsFor(7), actions = [{ type: 'move', point: [1, 0] }];
    const before = task('STATE', settings, actions);
    for (const difficulty of ['easy', 'normal']) {
      const pending = once(worker, 'message');
      worker.postMessage({ id: 8, kind: 'AI', payload: { settings, actions, difficulty }, context: {} });
      const [response] = await pending;
      assert.equal(response.ok, true, response.error); assert.equal(response.result.stateHash, before.stateHash);
      assert.ok(before.snapshot.legalMoves.some(m => String(m.point) === String(response.result.moves[0].point)));
    }
  } finally { await worker.terminate(); }
});
