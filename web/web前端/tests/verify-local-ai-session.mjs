import assert from "node:assert/strict";
import GameController from "../GameController.js";
import GameEngine from "../GameEngine.js";
import { serializeRuleState } from "../ReplayCodec.js";
import { validateContribution } from "../../tools/validate_contribution.mjs";

// Exercise app orchestration with the real controller/rules. Browser verification
// separately covers Vue scheduling, actual Workers, Canvas and responsive layout.
const values = new Map();
const timers = new Map();
const watchers = [];
const unmounts = [];
const workers = [];
const uploads = [];
const noop = () => {};
let timerSequence = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
globalThis.location = new URL("http://localhost:8876/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  const verified = await validateContribution(payload);
  uploads.push(payload);
  return { ok: true, json: async () => ({ status: "awaiting_review", game_id: verified.game_id }) };
};
globalThis.Vue = {
  ref: (value) => ({ value }), shallowRef: (value) => ({ value }),
  computed: (read) => ({ get value() { return read(); } }),
  watch: (source, callback) => watchers.push({ source, callback }),
  nextTick: async () => {}, onMounted: noop,
  onBeforeUnmount: (callback) => unmounts.push(callback),
};
globalThis.Worker = class {
  constructor() { workers.push(this); this.messages = []; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
};
const { default: App } = await import("../OnlineApp.js");
const app = App.setup();
const settings = { playerCount: 2, gridSize: 5, startPlayer: "BLACK", rulesVersion: "territory-v2", hintEnabled: false };
const controller = Object.assign(Object.create(GameController.prototype), {
  canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine: new GameEngine(settings),
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, multiplayerEnabled: false,
  localPlayer: null, roomReady: false, opponentConnected: false, networkManager: null,
  lastAction: null, _networkUnsubscribers: [], _authoritativeSnapshotValid: true,
  stateChangeListener: app.handleStateChange,
});
const ruleState = () => JSON.stringify(serializeRuleState(controller.engine));
function changeMode(mode) {
  const previous = app.selectedAiMode.value;
  app.selectedAiMode.value = mode;
  for (const { source, callback } of watchers) {
    if (Array.isArray(source) && source.includes(app.selectedAiMode)) callback(source.map((ref) => ref.value));
    else if (source === app.selectedAiMode) callback(mode, previous);
  }
}
function nextRequest() {
  const scheduled = [...timers].find(([, timer]) => timer.delay <= 400);
  assert.ok(scheduled, "a controlled AI turn must be scheduled");
  timers.delete(scheduled[0]); scheduled[1].callback();
  const worker = workers.at(-1);
  return { worker, message: worker.messages.at(-1) };
}
function reply({ worker, message }, point = controller.engine.getLegalMoves(message.aiPlayer)[0]?.point) {
  worker.onmessage({ data: {
    type: "RESULT", requestId: message.requestId,
    positionRevision: message.serializedState.positionRevision,
    rulesVersion: message.serializedState.rulesVersion,
    currentPlayer: message.serializedState.currentPlayer,
    moves: point ? [{ point }] : [{ type: "pass", point: null }],
  } });
}
try {
  app.handleControllerReady(controller);
  assert.equal(await app.skipTutorial(), true);
  app.selectedHintEnabled.value = false;
  changeMode("ai_duel");
  assert.equal(app.isLocalAiTurn(), true);
  assert.equal(app.skipDisabled.value, true);
  const players = new Set();
  for (let turn = 0; turn < 3; turn++) {
    const request = nextRequest(); players.add(request.message.aiPlayer); reply(request);
  }
  assert.equal(players.size, 2, "both sides must receive AI requests");

  const beforePause = ruleState();
  const pending = nextRequest();
  app.toggleAiDuel();
  reply(pending, [1, 0]);
  assert.equal(ruleState(), beforePause, "late results after pause must be rejected");
  assert.equal(app.skipDisabled.value, true, "paused AI matches do not accept human skip actions");
  assert.equal([...timers.values()].some((timer) => timer.delay <= 400), false);
  app.toggleAiDuel();
  const resumed = nextRequest();
  assert.notEqual(resumed.message.requestId, pending.message.requestId);
  reply(resumed);

  app.toggleAiDuel();
  const liveState = ruleState();
  const liveActions = JSON.stringify(app.localGameActions.value);
  await app.handleStartReplay();
  assert.equal(app.replayMode.value, true);
  app.handleSeekReplay(0);
  assert.notEqual(ruleState(), liveState);
  app.handleExitReplay();
  assert.equal(app.replayMode.value, false);
  assert.equal(ruleState(), liveState, "exit review must restore the live match and Superko history");
  assert.equal(JSON.stringify(app.localGameActions.value), liveActions);
  assert.equal(app.aiDuelPaused.value, true, "review must preserve a paused AI match");

  app.toggleAiDuel();
  const beforeReset = nextRequest();
  await app.handleReset();
  const resetState = ruleState();
  reply(beforeReset, [1, 0]);
  assert.equal(ruleState(), resetState, "reset must reject results from the old engine");
  const beforeSwitch = nextRequest();
  changeMode("none");
  reply(beforeSwitch, [1, 0]);
  assert.equal(ruleState(), resetState, "switching to humans cancels outstanding AI results");
  assert.equal(app.isLocalAiTurn(), false);

  changeMode("ai_duel");
  for (let turn = 0; turn < 200 && !controller.engine.gameOver; turn++) reply(nextRequest());
  assert.equal(controller.engine.gameOver, true);
  const uploadDeadline = performance.now() + 5000;
  while (uploads.length === 0 && performance.now() < uploadDeadline) await new Promise((done) => setImmediate(done));
  assert.equal(uploads.length, 1, `one complete AI match must reach the contribution queue: ${JSON.stringify(app.contributionState.value)}`);
  assert.ok(uploads[0].replay.terminal);
  assert.deepEqual(uploads[0].context.actors, {
    BLACK: { kind: "ai", strategy: "minimax", depth: 3 },
    WHITE: { kind: "ai", strategy: "minimax", depth: 3 },
  });
  assert.equal(uploads[0].context.mixedProfiles, false);
  assert.equal(uploads[0].context.hintsEnabled, false);
  console.log("verify-local-ai-session: PASS (both turns, pause/resume, late results, replay restoration, reset/mode cancellation, complete-game upload and AI labels)");
} finally {
  for (const unmount of unmounts) unmount();
}
