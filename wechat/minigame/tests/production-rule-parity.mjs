import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const { values: args } = parseArgs({ options: {
  frontend: { type: 'string' }, worker: { type: 'string' }, output: { type: 'string' },
} });
for (const key of ['frontend', 'worker', 'output']) assert.ok(path.isAbsolute(args[key] || ''), `absolute --${key} required`);
const base = pathToFileURL(path.resolve(args.frontend) + path.sep);
const { default: Engine } = await import(new URL('GameEngine.js', base));
const { canonicalize, serializeRuleState } = await import(new URL('ReplayCodec.js', base));
const hash = value => createHash('sha256').update(value).digest('hex');
const workerBytes = await fs.readFile(args.worker);
let receive, reply, checks = 0;
const plain = value => JSON.parse(JSON.stringify(value));
const context = vm.createContext({ worker: { onMessage: handler => { receive = handler; }, postMessage: value => { reply = plain(value); } } });
vm.runInContext(workerBytes.toString('utf8'), context, { timeout: 10000 });
for (const name of ['window', 'document', 'wx', 'TextEncoder', 'crypto', 'require', 'process']) {
  assert.equal(vm.runInContext(`typeof ${name}`, context), 'undefined');
}
function compare(engine, settings, actions) {
  reply = null;
  receive({ id: 13, kind: 'STATE', payload: { settings, actions }, context: { epoch: 2 } });
  assert.equal(reply?.ok, true, reply?.error);
  assert.equal(reply.id, 13); assert.deepEqual(reply.context, { epoch: 2 });
  const snapshot = engine.getSnapshot(), state = serializeRuleState(engine);
  assert.deepEqual(reply.result.ruleState, plain(state));
  assert.equal(reply.result.stateHash, 'sha256:' + hash(canonicalize(state)));
  for (const field of ['currentPlayer', 'gameOver', 'winner', 'consecutiveSkips', 'turnCount']) {
    assert.deepEqual(reply.result.snapshot[field], snapshot[field], field);
  }
  for (const player of ['BLACK', 'WHITE']) assert.equal(reply.result.snapshot.territories[player].area, snapshot.territories[player].area);
  assert.deepEqual(reply.result.snapshot.legalMoves.map(move => move.point), plain(snapshot.legalMoves.map(move => move.point)));
  checks++;
}
for (let size = 5; size <= 15; size++) {
  const settings = { gridSize: size, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2' };
  const engine = new Engine(settings), actions = [];
  compare(engine, settings, actions);
  for (let step = 0; step < 10 && !engine.gameOver; step++) {
    const moves = engine.getLegalMoves();
    const action = { type: 'move', player: engine.currentPlayer, point: moves[(size * 7 + step * 17) % moves.length].point };
    assert.equal(engine.playMove(action.point).success, true); actions.push(action); compare(engine, settings, actions);
  }
  if (!engine.gameOver) {
    const action = { type: 'resign', player: engine.currentPlayer };
    assert.equal(engine.resignPlayer(action.player).success, true); actions.push(action); compare(engine, settings, actions);
  }
  const passed = new Engine(settings), passes = [];
  for (let i = 0; i < 2; i++) {
    const action = { type: 'skip', player: passed.currentPlayer };
    assert.equal(passed.skipTurn().success, true); passes.push(action); compare(passed, settings, passes);
  }
}
const report = { status: 'PASS_PRODUCTION_WEB_FROZEN_MINI_WORKER_RULE_PARITY', sizes: [5,6,7,8,9,10,11,12,13,14,15],
  positionsChecked: checks, workerSha256: hash(workerBytes),
  engineSha256: hash(await fs.readFile(new URL('GameEngine.js', base))),
  codecSha256: hash(await fs.readFile(new URL('ReplayCodec.js', base))),
  scope: 'two-player territory-v2 deterministic state/score/legal-move/hash checks; no browser or physical device' };
await fs.writeFile(args.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
