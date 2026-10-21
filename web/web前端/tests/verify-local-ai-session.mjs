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
async function configure(blue, red, startPlayer = "BLACK") {
  app.selectedPlayerCount.value = 2;
  app.updateLocalPlayer({ color: "BLACK", patch: blue });
  app.updateLocalPlayer({ color: "WHITE", patch: red });
  app.selectedGridSize.value = 5;
  app.selectedPlayerCount.value = 2;
  app.selectedStartPlayer.value = startPlayer;
  assert.equal(await app.startLocalMatch(), true);
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
  assert.equal(app.localMatchStarted.value, false);
  assert.equal(app.skipDisabled.value, true, "new games wait for Start");
  const initial = ruleState();
  app.updateLocalPlayer({ color: "BLACK", patch: { choice: "minimax", depth: 2 } });
  app.updateLocalPlayer({ color: "WHITE", patch: { choice: "topology-gnn", version: "2026092203" } });
  assert.equal(ruleState(), initial, "choosing players must preserve the board");
  assert.equal([...timers.values()].some((timer) => timer.delay <= 400), false, "choosing AI must not start it");
  await configure({ choice: "minimax", depth: 2 }, { choice: "topology-gnn", version: "2026092203" }, "WHITE");
  assert.equal(app.isLocalAiTurn(), true);
  assert.equal(app.skipDisabled.value, true);
  const players = new Set();
  for (let turn = 0; turn < 3; turn++) {
    const request = nextRequest(); players.add(request.message.aiPlayer);
    if (request.message.aiPlayer === "WHITE") {
      assert.equal(request.message.modelId, "topology-gnn-transfer-v1-seed2026092203");
      assert.equal(request.message.seed, 2026092203);
    } else {
      assert.equal(request.message.strategy, "minimax");
      assert.equal(request.message.depth, 2);
    }
    reply(request);
  }
  assert.equal(players.size, 2, "both sides must receive AI requests");

  const beforePause = ruleState();
  const pending = nextRequest();
  app.toggleAiDuel();
  const restoredApp = App.setup();
  assert.equal(restoredApp.aiDuelPaused.value, true, "refresh preserves pause");
  assert.equal(restoredApp.localMatchStarted.value, true);
  assert.equal(restoredApp.activeLocalPlayers.value.BLACK.depth, 2);
  assert.equal(restoredApp.activeLocalPlayers.value.WHITE.version, "2026092203");
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
  beforeReset.worker.onerror({ message: "late error from replaced worker" });
  assert.equal(ruleState(), resetState, "reset must reject results from the old engine");
  const beforeSwitch = nextRequest();
  app.updateLocalPlayer({ color: "BLACK", patch: { choice: "human" } });
  app.updateLocalPlayer({ color: "WHITE", patch: { choice: "human" } });
  reply(beforeSwitch, [1, 0]);
  assert.equal(ruleState(), resetState, "switching to humans cancels outstanding AI results");
  assert.equal(app.localSetupPending.value, true);
  await app.startLocalMatch();
  assert.equal(app.isLocalAiTurn(), false);
  assert.equal(app.skipDisabled.value, false);

  await configure({ choice: "minimax", depth: 2 }, { choice: "minimax", depth: 4 });
  let sameModelRequest = nextRequest();
  assert.equal(sameModelRequest.message.depth, 2);
  reply(sameModelRequest);
  sameModelRequest = nextRequest();
  assert.equal(sameModelRequest.message.depth, 4, "the same AI can have different difficulties");
  const beforeSwap = ruleState();
  app.swapLocalPlayers();
  reply(sameModelRequest);
  assert.equal(ruleState(), beforeSwap, "swap cancels pending results and preserves board");
  assert.equal(app.selectedLocalPlayers.value.BLACK.depth, 4);
  assert.equal(app.selectedLocalPlayers.value.WHITE.depth, 2);
  assert.equal(app.selectedStartPlayer.value, "BLACK", "swap keeps the selected starting color");

  await configure({ choice: "human" }, { choice: "minimax", depth: 2 }, "WHITE");
  let singleAI = nextRequest();
  assert.equal(singleAI.message.aiPlayer, "WHITE", "AI can move first as red");
  reply(singleAI);
  assert.equal(app.isLocalAiTurn(), false);
  assert.equal(app.skipDisabled.value, false);
  await configure({ choice: "minimax", depth: 2 }, { choice: "human" });
  singleAI = nextRequest();
  assert.equal(singleAI.message.aiPlayer, "BLACK", "AI can move first as blue");
  reply(singleAI);
  assert.equal(app.isLocalAiTurn(), false);
  await configure({ choice: "human" }, { choice: "minimax", depth: 2 });
  assert.equal([...timers.values()].some((timer) => timer.delay <= 400), false, "human first must wait for human input");
  await app.handleSkip();
  singleAI = nextRequest();
  assert.equal(singleAI.message.aiPlayer, "WHITE", "human action schedules the AI opponent");

  await configure({ choice: "dqn" }, { choice: "ppo" }, "WHITE");
  const failed = nextRequest();
  const beforeFailure = ruleState();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    failed.worker.onmessage({ data: { type: "ERROR", requestId: failed.message.requestId,
      positionRevision: failed.message.serializedState.positionRevision, rulesVersion: failed.message.serializedState.rulesVersion,
      currentPlayer: failed.message.aiPlayer, message: "synthetic unavailable model" } });
  } finally { console.error = originalConsoleError; }
  assert.equal(ruleState(), beforeFailure, "model loading failure preserves the position");
  assert.equal(app.activeLocalPlayers.value.BLACK.choice, "dqn", "fallback must affect only the failed side");
  assert.equal(app.activeLocalPlayers.value.WHITE.choice, "minimax");
  assert.equal(nextRequest().message.strategy, "minimax");

  await configure({ choice: "minimax", depth: 2 }, { choice: "human" });
  const illegal = nextRequest();
  const beforeIllegal = ruleState();
  console.error = () => {};
  try { reply(illegal, [99, 99]); } finally { console.error = originalConsoleError; }
  assert.equal(ruleState(), beforeIllegal, "illegal AI results must not change the board");
  assert.equal(app.aiDuelPaused.value, true, "invalid results stop automatic retries");
  assert.equal([...timers.values()].some((timer) => timer.delay <= 400), false);

  app.selectedPlayerCount.value = 3;
  app.updateLocalPlayer({ color: "BLACK", patch: { choice: "human" } });
  app.updateLocalPlayer({ color: "WHITE", patch: { choice: "three-player" } });
  app.updateLocalPlayer({ color: "PURPLE", patch: { choice: "three-player" } });
  app.selectedStartPlayer.value = "WHITE";
  await app.startLocalMatch();
  assert.equal(app.selectedAiMode.value, "mixed");
  const firstThree = nextRequest();
  assert.equal(firstThree.message.strategy, "three-player");
  assert.equal(firstThree.message.aiPlayer, "WHITE");
  reply(firstThree);
  const secondThree = nextRequest();
  assert.equal(secondThree.message.aiPlayer, "PURPLE", "a second AI must act without human intervention");
  reply(secondThree);
  assert.equal(controller.engine.currentPlayer, "BLACK");
  assert.equal(app.isLocalAiTurn(), false);
  assert.equal(app.skipDisabled.value, false);
  app.toggleAiDuel();
  const restoredThree = App.setup();
  assert.equal(restoredThree.activeLocalPlayers.value.PURPLE.choice, "three-player");
  assert.equal(restoredThree.aiDuelPaused.value, true);
  app.toggleAiDuel();
  await app.handleSkip();
  const timedOut = nextRequest();
  const deadline = [...timers].find(([, timer]) => timer.delay === 15000);
  assert.ok(deadline, "three-player inference must have a bounded timeout");
  timers.delete(deadline[0]); deadline[1].callback();
  const beforeTimeoutReply = ruleState();
  reply(timedOut);
  assert.equal(ruleState(), beforeTimeoutReply, "late result after timeout is ignored");
  assert.equal(app.aiDuelPaused.value, true);
  app.toggleAiDuel();
  assert.equal(nextRequest().message.strategy, "three-player", "retry preserves the selected three-player model");
  for (const color of ["BLACK", "WHITE", "PURPLE"]) app.updateLocalPlayer({ color, patch: { choice: "human" } });
  await app.startLocalMatch();
  assert.equal(app.selectedAiMode.value, "none");
  assert.equal(app.skipDisabled.value, false, "three-player human matches remain playable");

  await configure({ choice: "dqn" }, { choice: "ppo" }, "WHITE");
  for (let turn = 0; turn < 200 && !controller.engine.gameOver; turn++) {
    const request = nextRequest();
    assert.equal(request.message.modelId, request.message.aiPlayer === "BLACK" ? "dqn-all-sizes-e2000" : "ppo-all-sizes-e2000");
    reply(request);
  }
  assert.equal(controller.engine.gameOver, true);
  const uploadDeadline = performance.now() + 5000;
  while (uploads.length === 0 && performance.now() < uploadDeadline) await new Promise((done) => setImmediate(done));
  assert.equal(uploads.length, 1, `one complete AI match must reach the contribution queue: ${JSON.stringify(app.contributionState.value)}`);
  assert.ok(uploads[0].replay.terminal);
  assert.deepEqual(uploads[0].context.actors, {
    BLACK: { kind: "ai", strategy: "model-free", modelId: "dqn-all-sizes-e2000" },
    WHITE: { kind: "ai", strategy: "model-free", modelId: "ppo-all-sizes-e2000" },
  });
  assert.equal(uploads[0].context.mixedProfiles, false);
  assert.equal(uploads[0].context.hintsEnabled, false);
  console.log("verify-local-ai-session: PASS (explicit start, red first, independent models/depths/seeds, saved roles/pause, swap cancellation, replay restoration, reset, complete-game upload and distinct AI labels)");
} finally {
  for (const unmount of unmounts) unmount();
}
