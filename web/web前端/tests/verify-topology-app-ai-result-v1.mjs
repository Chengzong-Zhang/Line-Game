import assert from "node:assert/strict";
import "../TopologyGameEngine.js";
import GameController from "../GameController.js";
import GameEngine from "../GameEngine.js";
import { TOPOLOGY_AI_ROUTE } from "../TopologyAIAdapter.js";

// Exercise the production App worker callback with the real topology engine,
// real controller, and controlled Worker/timer/UI boundaries.
const storage = new Map(), timers = new Map(), workers = [], unmounts = [];
let timerId = 0;
const noop = () => {};
globalThis.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, val) => storage.set(key, String(val)), removeItem: key => storage.delete(key) };
globalThis.location = new URL("http://localhost:8876/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.Vue = { ref: value => ({ value }), shallowRef: value => ({ value }), computed: read => ({ get value() { return read(); } }),
  watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: fn => unmounts.push(fn) };
globalThis.Worker = class { constructor() { workers.push(this); this.messages = []; } postMessage(value) { this.messages.push(value); } terminate() { this.terminated = true; } };
const { default: App } = await import("../OnlineApp.js");
const app = App.setup();
const settings = { playerCount: 2, gridSize: 5, startPlayer: "BLACK", rulesVersion: "territory-v2", hintEnabled: false };
const controller = Object.assign(Object.create(GameController.prototype), {
  canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine: new GameEngine(settings),
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, multiplayerEnabled: false,
  localPlayer: null, roomReady: false, opponentConnected: false, networkManager: null,
  lastAction: null, _networkUnsubscribers: [], _authoritativeSnapshotValid: true, stateChangeListener: app.handleStateChange,
});
const state = () => JSON.stringify(controller.engine.encodeTopologyState());
async function start() {
  timers.clear();
  app.selectedPlayerCount.value = 2;
  assert.ok(app.selectTopologyPreset("cylinder"));
  app.updateLocalPlayer({ color: "BLACK", patch: { choice: "topology-generic" } });
  app.updateLocalPlayer({ color: "WHITE", patch: { choice: "human" } });
  app.selectedStartPlayer.value = "BLACK";
  assert.equal(await app.startLocalMatch(), true);
  assert.equal(controller.engine.isTopologyBoard, true);
  const scheduled = [...timers].find(([, t]) => t.delay <= 400);
  assert.ok(scheduled, "AI turn must be scheduled");
  timers.delete(scheduled[0]); scheduled[1].fn();
  const worker = workers.at(-1), request = worker.messages.at(-1);
  assert.equal(request.strategy, "topology-generic");
  return { worker, request };
}
function reply(pending, changes = {}) {
  const request = pending.request, s = request.serializedState;
  pending.worker.onmessage({ data: { type: "RESULT", requestId: request.requestId,
    strategy: "topology-generic", modelInfo: { route: TOPOLOGY_AI_ROUTE }, boardHash: s.boardHash,
    positionRevision: s.positionRevision, rulesVersion: s.rulesVersion, currentPlayer: s.currentPlayer,
    moves: [{ point: controller.engine.getLegalMoves()[0].point }], ...changes } });
}
async function failedResult(label, change, inject) {
  const pending = await start(), before = state();
  const undo = inject?.();
  const originalError = console.error; console.error = noop;
  try { reply(pending, change); } finally { console.error = originalError; undo?.(); }
  assert.equal(state(), before, `${label}: position must stay unchanged`);
  assert.equal(app.aiDuelPaused.value, true, `${label}: invalid result must pause`);
  assert.equal(pending.worker.terminated, true, `${label}: worker must stop`);
  assert.equal([...timers.values()].some(t => t.delay <= 400), false, `${label}: no automatic retry`);
}
try {
  app.handleControllerReady(controller);
  assert.equal(await app.skipTutorial(), true);
  app.selectedHintEnabled.value = false;
  assert.ok(app.generateTopologyBoard());
  const previousBoard = JSON.stringify(app.selectedTopologyDefinition.value), previousHash = app.selectedTopologyHash.value;
  assert.equal(app.addTopologyDraftVertex([0, 0]), true);
  assert.equal(JSON.stringify(app.selectedTopologyDefinition.value), previousBoard, "drawing must retain the previous valid board");
  assert.equal(app.selectedTopologyHash.value, previousHash);
  assert.equal(app.closeTopologyDraft(), false, "an incomplete boundary must not replace the previous board");
  assert.equal(JSON.stringify(app.selectedTopologyDefinition.value), previousBoard);
  assert.equal(app.undoTopologyDraftVertex(), true);
  assert.equal(app.resetTopologyDraft(), true);
  assert.equal(JSON.stringify(app.selectedTopologyDefinition.value), previousBoard, "undo and reset must retain the last valid board");
  for (const vertex of [[0,0],[1,0],[2,0],[3,0],[3,1],[3,2],[3,3],[2,3],[1,3],[0,3],[0,2],[0,1]]) assert.equal(app.addTopologyDraftVertex(vertex), true);
  assert.equal(app.closeTopologyDraft(), true);
  assert.notEqual(app.selectedTopologyHash.value, previousHash, "only a valid closed candidate replaces the selected board");
  await failedResult("wrong route", { modelInfo: { route: "topology-generic" } });
  await failedResult("empty moves", { moves: [] });
  await failedResult("missing moves", { moves: undefined });
  await failedResult("illegal vertex", { moves: [{ point: "cv:not-a-vertex" }] });
  await failedResult("rejected controller move", {}, () => {
    const original = controller._applyMove;
    controller._applyMove = () => ({ success: false, reason: "INJECTED_REJECTION" });
    return () => { controller._applyMove = original; };
  });
  let pending = await start();
  const before = state(), point = controller.engine.getLegalMoves()[0].point;
  assert.equal(typeof point, "string");
  reply(pending, { moves: [{ point }] });
  assert.notEqual(state(), before, "a legal canonical string must apply through the controller");
  assert.equal(app.aiDuelPaused.value, false);
  pending = await start();
  const beforePass = state();
  reply(pending, { moves: [{ type: "pass", point: null }] });
  assert.notEqual(state(), beforePass, "an explicit topology PASS must use the controller skip path");
  assert.equal(controller.engine.consecutiveSkips, 1);
  assert.equal(app.aiDuelPaused.value, false);
  pending = await start();
  const beforeStale = state();
  reply(pending, { positionRevision: pending.request.serializedState.positionRevision + 1 });
  assert.equal(state(), beforeStale, "stale result must not change the position");
  pending = await start();
  const beforeWrongBoard = state();
  reply(pending, { boardHash: "not-the-current-board" });
  assert.equal(state(), beforeWrongBoard, "a result from a different board must not change the position");
  console.log("verify-topology-app-ai-result-v1: PASS (route mismatch, empty result, illegal vertex, rejected move, canonical move, stale result)");
} finally { for (const fn of unmounts) fn(); }
