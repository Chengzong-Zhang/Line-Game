import assert from "node:assert/strict";
import GameEngine from "../GameEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";
import TerritoryWorkerPool from "../TerritoryWorkerPool.js?v=20261025-room1";

class FakeWorker {
  messages = [];
  terminated = 0;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated++; }
  reply(overrides = {}) {
    const m = this.messages.at(-1), s = m.serializedState;
    this.onmessage?.({ data: { type: "RESULT", requestId: m.requestId,
      positionRevision: s.positionRevision, rulesVersion: s.rulesVersion, currentPlayer: s.currentPlayer,
      territoryStateRevision: m.territoryStateRevision, gameOver: m.gameOver,
      territories: Object.fromEntries(m.players.map(p => [p, { polygon: null, area: 0, displayArea: 0 }])), ...overrides } });
  }
}
const game = () => new GameEngine({ gridSize: 5, playerCount: 6, rulesVersion: "territory-v2", deferTerritoryUpdates: true });
const workers = [], results = [], progress = [], errors = [];
const pool = new TerritoryWorkerPool(() => { const w = new FakeWorker(); workers.push(w); return w; }, { size: 3, timeoutMs: 0 });
let engine = game();
const start = () => pool.start({ engine, getCurrentEngine: () => engine,
  message: { type: "COMPUTE_TERRITORIES", serializedState: serializeEngineState(engine) },
  onResult: r => results.push(r), onProgress: r => progress.push(r), onError: e => errors.push(e) });
const id = start();
for (let i = 0; i < 30; i++) assert.equal(start(), id, "duplicate UI events reuse the in-flight request");
assert.equal(workers.length, 3);
assert.equal(workers.reduce((n, w) => n + w.messages.length, 0), 3);
workers[1].reply();
assert.deepEqual(Object.keys(progress[0].territories), ["WHITE"], "a fast seat paints before the slow first seat");
assert.equal(results.length, 0, "partial display cannot settle scores");
workers[0].reply(); workers[2].reply(); workers[1].reply(); workers[0].reply(); workers[2].reply();
assert.equal(results.length, 1);
assert.equal(Object.keys(results[0].territories).length, 6);
assert.equal(workers.some(w => w.terminated), false, "completed workers remain warm");
assert.equal(pool.activeRequestId, null);

// Queue dozens of moves while all slots are busy: retain exactly one newest
// request, never terminate/restart the computation and never publish old data.
engine.positionRevision++;
start();
const messagesBefore = workers.reduce((n, w) => n + w.messages.length, 0);
for (let i = 0; i < 40; i++) { engine.positionRevision++; engine._territoryStateRevision++; start(); }
assert.equal(workers.length, 3);
assert.equal(workers.reduce((n, w) => n + w.messages.length, 0), messagesBefore);
const progressBefore = progress.length;
workers[0].reply(); workers[1].reply(); workers[2].reply();
assert.equal(progress.length, progressBefore, "outdated results are not shown");
assert.ok(workers.every(w => w.messages.at(-1).serializedState.positionRevision === engine.positionRevision));
workers[0].reply(); workers[1].reply(); workers[2].reply(); workers[0].reply(); workers[1].reply(); workers[2].reply();
assert.equal(results.length, 2);

// Reset, corrupt message, synchronous post failure, worker exception and timeout.
engine = game(); start();
assert.ok(workers.slice(0, 3).every(w => w.terminated === 1));
workers.at(-1).reply({ positionRevision: -1 });
assert.equal(errors.length, 1);
assert.equal(pool.activeRequestId, null);
start(); workers.at(-1).onerror({ message: "test crash" });
assert.equal(errors.length, 2);
const broken = new TerritoryWorkerPool(() => ({ terminate() {}, postMessage() { throw new Error("post failed"); } }), { timeoutMs: 0 });
broken.start({ engine, message: { serializedState: serializeEngineState(engine) }, onError: e => errors.push(e) });
assert.equal(errors.length, 3);
const unavailable = new TerritoryWorkerPool(() => { throw new Error("worker unavailable"); });
unavailable.start({ engine, message: { serializedState: serializeEngineState(engine) }, onError: e => errors.push(e) });
assert.equal(errors.length, 4);
assert.equal(unavailable.activeRequestId, null);
let timeoutError;
const timed = new TerritoryWorkerPool(() => new FakeWorker(), { timeoutMs: 5 });
timed.start({ engine, message: { serializedState: serializeEngineState(engine) }, onError: e => { timeoutError = e; } });
await new Promise(resolve => setTimeout(resolve, 30));
assert.match(timeoutError?.message ?? "", /timed out/);
pool.cancel(); timed.cancel(); broken.cancel();

for (const mutate of [
  e => { e.positionRevision++; }, e => { e._territoryStateRevision++; },
  e => { e.currentPlayer = "WHITE"; },
  e => { e.gameOver = true; },
]) {
  const e = game(), ws = [];
  let published = 0;
  const p = new TerritoryWorkerPool(() => { const w = new FakeWorker(); ws.push(w); return w; }, { timeoutMs: 0 });
  p.start({ engine: e, message: { serializedState: serializeEngineState(e) }, onResult: () => published++, onProgress: () => published++ });
  mutate(e); ws[0].reply();
  assert.equal(published, 0, "changed identity fields reject partial and full results");
  assert.equal(p.activeRequestId, null, "stale request settles without waiting forever");
  p.cancel();
}

for (const mismatch of [{ rulesVersion: "territory-v1" }, { currentPlayer: "WHITE" },
  { gameOver: true }, { territoryStateRevision: -1 }, { territories: { BLACK: { area: -1 } } }]) {
  const e = game(), ws = [];
  let failed = 0, published = 0;
  const p = new TerritoryWorkerPool(() => { const w = new FakeWorker(); ws.push(w); return w; }, { timeoutMs: 0 });
  p.start({ engine: e, message: { serializedState: serializeEngineState(e) }, onError: () => failed++,
    onResult: () => published++, onProgress: () => published++ });
  ws[0].reply(mismatch);
  assert.equal(failed, 1); assert.equal(published, 0); assert.equal(p.activeRequestId, null);
  p.cancel();
}

// A duplicate old reply after slot reuse cannot kill the newer job.
{
  const e = game(), ws = [];
  const p = new TerritoryWorkerPool(() => { const w = new FakeWorker(); ws.push(w); return w; }, { size: 1, timeoutMs: 0 });
  let failed = false;
  p.start({ engine: e, message: { serializedState: serializeEngineState(e) }, onError: () => { failed = true; } });
  const old = ws[0].messages[0]; ws[0].reply();
  ws[0].onmessage({ data: { requestId: old.requestId, type: "RESULT" } });
  assert.equal(failed, false); assert.notEqual(p.activeRequestId, null);
  p.cancel();
}
console.log(JSON.stringify({ status: "PASS", duplicateSyncs: 30, queuedRevisions: 40,
  currentOnlyProgress: true, warmReuse: true, reset: true, errorRecovery: true, timeout: true,
  staleFields: true, duplicateLateReply: true }));

// The reusable worker must restore every new input, including after config
// changes. Exercise subset replies against full exact v1/v2 calculations.
const previousSelf = globalThis.self;
let reply, parityCases = 0;
globalThis.self = { postMessage: message => { reply = message; } };
try {
  await import(`../TerritoryWorker.js?pool-parity=${Date.now()}`);
  for (const rulesVersion of ["territory-v1", "territory-v2"]) {
    for (const [playerCount, boardShape] of [[2, "triangle"], [3, "triangle"], [6, "triangle"], [6, "hexagon"]]) {
      const e = new GameEngine({ gridSize: 5, playerCount, boardShape, rulesVersion, deferTerritoryUpdates: true });
      for (let step = 0; step < 12 && !e.gameOver; step++) {
        const move = e.getLegalMoves()[0];
        if (move) e.playMove(move.point); else e.skipTurn();
        if (step !== 5 && step !== 11) continue;
        const state = serializeEngineState(e);
        e._updateTerritories();
        for (const player of e.activePlayers) {
          self.onmessage({ data: { type: "COMPUTE_TERRITORIES", requestId: ++parityCases,
            serializedState: state, territoryStateRevision: e.getTerritoryStateRevision(), gameOver: e.gameOver, players: [player] } });
          assert.equal(reply.type, "RESULT", reply.message);
          assert.deepEqual(Object.keys(reply.territories), [player]);
          assert.deepEqual(reply.territories[player], e.cachedTerritories[player], "warm worker subset must equal full exact scorer");
        }
      }
    }
  }
} finally {
  if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
}
console.log(JSON.stringify({ status: "PASS", exactSubsetReplies: parityCases, rules: ["v1", "v2"], shapes: ["triangle", "hexagon"] }));
