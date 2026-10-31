import assert from "node:assert/strict";
import GameController from "../GameController.js";
import GameEngine from "../GameEngine.js";
import { serializeRuleState } from "../ReplayCodec.js";

// Real rules and app orchestration with controlled Worker replies/timers.
// Browser checks separately cover Canvas, actual Workers and Vue scheduling.
const values = new Map();
const timers = new Map();
const workers = [];
const unmounts = [];
const watchers = [];
const noop = () => {};
let timerSequence = 0;
let uploads = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.location = new URL("http://localhost:8876/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.fetch = async () => { uploads++; return { ok: true, json: async () => ({}) }; };
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
const colors = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
const settings = { playerCount: 4, gridSize: 5, startPlayer: "BLACK", rulesVersion: "territory-v2", hintEnabled: false };
const controller = Object.assign(Object.create(GameController.prototype), {
  canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine: new GameEngine(settings),
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, multiplayerEnabled: false,
  localPlayer: null, roomReady: false, opponentConnected: false, networkManager: null,
  lastAction: null, _networkUnsubscribers: [], _authoritativeSnapshotValid: true,
  stateChangeListener: app.handleStateChange,
});
const ruleState = () => JSON.stringify(serializeRuleState(controller.engine));
const hasScheduledTurn = () => [...timers.values()].some(({ delay }) => delay <= 400);
async function configure(count, aiColors, startPlayer = colors[count - 1]) {
  app.selectedPlayerCount.value = count;
  app.selectedGridSize.value = 5;
  app.selectedStartPlayer.value = startPlayer;
  for (const color of colors.slice(0, count)) {
    app.updateLocalPlayer({ color, patch: { choice: aiColors.includes(color) ? "hex-player" : "human" } });
  }
  assert.equal(await app.startLocalMatch(), true);
}
function nextRequest() {
  const scheduled = [...timers].find(([, timer]) => timer.delay <= 400);
  assert.ok(scheduled, "a controlled AI turn must be scheduled");
  timers.delete(scheduled[0]);
  scheduled[1].callback();
  const worker = workers.at(-1);
  const message = worker.messages.at(-1);
  assert.equal(message.strategy, "hex-player");
  assert.equal(message.modelId, "hex-player-policy-v1");
  return { worker, message };
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
function quietError(run) {
  const original = console.error;
  console.error = noop;
  try { run(); } finally { console.error = original; }
}
try {
  app.handleControllerReady(controller);
  await app.skipTutorial();
  app.selectedHintEnabled.value = false;

  for (const count of [4, 5, 6]) {
    const active = colors.slice(0, count);
    for (const aiColor of active) {
      await configure(count, [aiColor], aiColor);
      assert.equal(app.selectedAiMode.value, "mixed");
      assert.equal(app.isLocalAiTurn(), true);
      assert.equal(app.skipDisabled.value, true);
      const oneAI = nextRequest();
      assert.equal(oneAI.message.aiPlayer, aiColor, "every seat may be AI and move first");
      reply(oneAI);
      assert.equal(app.isLocalAiTurn(), false, "a human turn follows the single AI");
      assert.equal(hasScheduledTurn(), false, "human turns wait for player input");
    }

    await configure(count, active.slice(1), "BLACK");
    assert.equal(hasScheduledTurn(), false);
    await app.handleSkip();
    for (const aiColor of active.slice(1)) {
      const request = nextRequest();
      assert.equal(request.message.aiPlayer, aiColor);
      reply(request);
    }
    assert.equal(controller.engine.currentPlayer, "BLACK");
    assert.equal(app.isLocalAiTurn(), false);
    assert.equal(app.hintEnabled.value, false);

    await configure(count, active);
    assert.equal(app.selectedAiMode.value, "ai_duel");
    const visited = new Set();
    for (let turn = 0; turn < count; turn++) {
      const request = nextRequest();
      visited.add(request.message.aiPlayer);
      reply(request);
    }
    assert.equal(visited.size, count, "all AI seats advance without human input");

    const pending = nextRequest();
    const beforePause = ruleState();
    app.toggleAiDuel();
    assert.equal(pending.worker.terminated, true);
    reply(pending);
    assert.equal(ruleState(), beforePause, "pause rejects stale inference");
    assert.equal(hasScheduledTurn(), false);
    const restored = App.setup();
    assert.equal(restored.aiDuelPaused.value, true);
    assert.equal(restored.localMatchStarted.value, true);
    for (const player of active) assert.equal(restored.activeLocalPlayers.value[player].choice, "hex-player", "refresh preserves all AI profiles");
    app.toggleAiDuel();
    const resumed = nextRequest();
    assert.notEqual(resumed.message.requestId, pending.message.requestId);

    await app.handleReset();
    const afterReset = ruleState();
    reply(resumed);
    resumed.worker.onerror({ message: "late replaced worker error" });
    assert.equal(ruleState(), afterReset, "reset rejects a previous engine response");
    const oldSelection = nextRequest();
    app.updateLocalPlayer({ color: active.at(-1), patch: { choice: "human" } });
    reply(oldSelection);
    assert.equal(ruleState(), afterReset, "changing a seat cancels previous work");
    assert.equal(app.localSetupPending.value, true);

    await configure(count, active);
    const failed = nextRequest();
    const beforeFailure = ruleState();
    quietError(() => failed.worker.onmessage({ data: {
      type: "ERROR", requestId: failed.message.requestId,
      positionRevision: failed.message.serializedState.positionRevision,
      rulesVersion: failed.message.serializedState.rulesVersion,
      currentPlayer: failed.message.aiPlayer, message: "synthetic model unavailable",
    } }));
    assert.equal(ruleState(), beforeFailure);
    assert.equal(app.aiDuelPaused.value, true);
    assert.equal(hasScheduledTurn(), false, "failures must not retry endlessly");
    assert.equal(app.activeLocalPlayers.value[failed.message.aiPlayer].choice, "hex-player", "hex AI must not fall back to two-player minimax");
    app.toggleAiDuel();
    const retried = nextRequest();
    const deadline = [...timers].find(([, timer]) => timer.delay === 15000);
    assert.ok(deadline, "hex inference must have a bounded timeout");
    timers.delete(deadline[0]);
    deadline[1].callback();
    reply(retried);
    assert.equal(ruleState(), beforeFailure, "late timed-out replies are rejected");
    assert.equal(app.aiDuelPaused.value, true);
    app.toggleAiDuel();
    reply(nextRequest());

    await configure(count, active);
    for (let turn = 0; turn < count; turn++) reply(nextRequest(), null);
    assert.equal(controller.engine.gameOver, true, "all-AI repeated passes terminate normally");
    assert.equal(hasScheduledTurn(), false, "terminal games stop autoplay");
    assert.equal(uploads, 0, "hex AI games remain outside the triangular training queue");
  }
  await configure(6, colors);
  const beforeConstructorFailure = ruleState();
  const WorkerBeforeFailure = globalThis.Worker;
  globalThis.Worker = class {
    constructor() { throw new Error("synthetic Worker construction denied"); }
  };
  try {
    const scheduled = [...timers].find(([, timer]) => timer.delay <= 400);
    assert.ok(scheduled);
    timers.delete(scheduled[0]);
    quietError(() => scheduled[1].callback());
  } finally {
    globalThis.Worker = WorkerBeforeFailure;
  }
  assert.equal(ruleState(), beforeConstructorFailure, "synchronous Worker failure preserves the game");
  assert.equal(app.aiDuelPaused.value, true);
  assert.equal(hasScheduledTurn(), false);
  assert.match(app.localGameResumeNotice.value, /继续 AI|Resume AI/, "construction failures must show the retry action");
  const restoredAfterConstructorFailure = App.setup();
  assert.equal(restoredAfterConstructorFailure.aiDuelPaused.value, true, "construction failure pause must survive refresh");
  assert.equal(restoredAfterConstructorFailure.activeLocalPlayers.value.CYAN.choice, "hex-player");
  app.toggleAiDuel();
  reply(nextRequest());
  app.toggleAiDuel();

  const settingsWatcher = watchers.find(({ source }) => Array.isArray(source)
    && source[0] === app.selectedPlayerCount && source[1] === app.selectedGridSize);
  assert.ok(settingsWatcher);
  app.selectedPlayerCount.value = 6;
  app.selectedRoomBotCount.value = 5;
  for (const [count, maximumBots] of [[4, 3], [3, 2], [2, 0]]) {
    const previous = settingsWatcher.source.map(({ value }) => value);
    app.selectedPlayerCount.value = count;
    settingsWatcher.callback(settingsWatcher.source.map(({ value }) => value), previous);
    assert.equal(app.selectedRoomBotCount.value, maximumBots, "reducing player count must clamp the existing room AI selection");
  }
  console.log("verify-hex-ai-session: PASS (4/5/6, every AI/starting seat, multiple/all AI, pause/refresh, stale/reset/settings, failures/retry/timeouts, Worker constructor recovery, terminal stop, no training upload, reduced-count bot clamp)");
} finally {
  for (const unmount of unmounts) unmount();
}
