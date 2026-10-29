import assert from "node:assert/strict";
import GameController from "../GameController.js";
import GameEngine, { PLAYER_ORDER, resolveInitialPositions } from "../GameEngine.js";
import { randomInitialPositions } from "../StartingPoints.js";
import { serializeRuleState } from "../ReplayCodec.js";
import { loadLocalGameSession } from "../LocalGameSession.js";

const values = new Map(), timers = new Map(), workers = [], watchers = [], unmounts = [];
const noop = () => {};
let timerId = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
globalThis.location = new URL("http://localhost:18021/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop; globalThis.removeEventListener = noop;
globalThis.Vue = {
  ref: (value) => ({ value }), shallowRef: (value) => ({ value }),
  computed: (read) => ({ get value() { return read(); } }),
  watch: (source, callback) => watchers.push({ source, callback }),
  nextTick: async () => {}, onMounted: noop, onBeforeUnmount: (callback) => unmounts.push(callback),
};
globalThis.Worker = class {
  constructor() { workers.push(this); this.messages = []; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
};
const { default: App } = await import("../OnlineApp.js");
async function mount() {
  const app = App.setup();
  const settings = { playerCount: 2, gridSize: 5, startPlayer: "BLACK", rulesVersion: "territory-v2" };
  const controller = Object.assign(Object.create(GameController.prototype), {
    canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine: new GameEngine(settings),
    renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, _engineEpoch: 0,
    _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, multiplayerEnabled: false,
    localPlayer: null, roomReady: false, opponentConnected: false, networkManager: null,
    lastAction: null, _networkUnsubscribers: [], _authoritativeSnapshotValid: true,
    stateChangeListener: app.handleStateChange,
  });
  app.handleControllerReady(controller);
  assert.equal(await app.skipTutorial(), true);
  app.toggleContributions(false);
  return { app, controller };
}
try {
  const { app, controller } = await mount();
  for (const boardShape of ["triangle", "hexagon"]) for (const count of [2, 3, 4, 5, 6]) {
    app.selectedBoardShape.value = boardShape;
    app.selectedPlayerCount.value = count;
    app.selectedGridSize.value = 5;
    for (const color of PLAYER_ORDER.slice(0, count)) app.updateLocalPlayer({ color, patch: { choice: "human" } });
    const points = randomInitialPositions(5, count, () => .43, boardShape);
    const before = serializeRuleState(controller.engine);
    const wasStarted = app.localMatchStarted.value;
    app.updateStartingPoints({ startingPointMode: "random", initialPositions: points });
    assert.deepEqual(serializeRuleState(controller.engine), before, "editing a preview preserves the live board");
    assert.equal(app.localSetupPending.value, !wasStarted, "editing a preview keeps a started match playable");
    assert.equal(app.localSettingsChanged.value, true, "the new opening remains an unapplied draft");
    assert.equal(await app.startLocalMatch(), true);
    assert.equal(controller.engine.boardShape, boardShape);
    assert.deepEqual(controller.engine.initialPositions, points, "Start uses the displayed random preview");
    assert.equal(app.localSetupPending.value, false);
    const move = controller.engine.getLegalMoves()[0];
    if (move) assert.equal(controller._applyMove(move.point, controller.engine.currentPlayer).success, true);
    else await app.handleSkip();
    const savedState = serializeRuleState(controller.engine);
    const saved = loadLocalGameSession();
    assert.equal(saved.settings.boardShape, boardShape);
    assert.deepEqual(saved.settings.initialPositions, points);
    await app.handleStartReplay();
    assert.equal(app.replayMode.value, true);
    app.handleSeekReplay(0);
    assert.deepEqual(controller.engine.initialPositions, points);
    assert.equal(controller.engine.turnCount, 0);
    app.handleExitReplay();
    assert.deepEqual(serializeRuleState(controller.engine), savedState, "leaving replay restores the live roots and state");
    const restored = await mount();
    assert.deepEqual(serializeRuleState(restored.controller.engine), savedState);
    assert.equal(restored.app.selectedBoardShape.value, boardShape);
    assert.deepEqual(restored.app.selectedStartingPoints.value.initialPositions, points);
    assert.equal(restored.app.localSetupPending.value, false, "refresh restores active settings without a pending draft");
    app.updateStartingPoints({ startingPointMode: "random", initialPositions: structuredClone(points) });
    await app.startLocalMatch();
    assert.deepEqual(controller.engine.initialPositions, points, "even a repeated random draw uses the explicitly selected preview");
    const random = Math.random;
    Math.random = () => .83;
    try { assert.equal(await app.startLocalMatch(), true); }
    finally { Math.random = random; }
    assert.notDeepEqual(controller.engine.initialPositions, points, "restarting random mode rerolls");
    const custom = randomInitialPositions(5, count, () => .32, boardShape);
    app.updateStartingPoints({ startingPointMode: "custom", initialPositions: custom });
    await app.startLocalMatch();
    await app.startLocalMatch();
    assert.deepEqual(controller.engine.initialPositions, custom, "custom starts remain fixed on restart");
    app.updateStartingPoints({});
    await app.startLocalMatch();
    assert.deepEqual(controller.engine.initialPositions, resolveInitialPositions(5, count, null, boardShape));
    assert.equal(controller.engine.hasCustomInitialPositions, false);
  }
  // Changing the opening cancels a running AI request even before Start.
  app.selectedPlayerCount.value = 2;
  app.selectedBoardShape.value = "triangle";
  app.updateLocalPlayer({ color: "BLACK", patch: { choice: "minimax", depth: 2 } });
  app.updateLocalPlayer({ color: "WHITE", patch: { choice: "human" } });
  await app.startLocalMatch();
  const scheduled = [...timers].find(([, timer]) => timer.delay <= 400);
  assert.ok(scheduled);
  timers.delete(scheduled[0]); scheduled[1].callback();
  const worker = workers.at(-1), message = worker.messages.at(-1), lateReply = worker.onmessage;
  const oldPoint = controller.engine.getLegalMoves()[0].point;
  const before = serializeRuleState(controller.engine);
  const custom = { BLACK: [1, 1], WHITE: [3, 0] };
  app.updateStartingPoints({ startingPointMode: "custom", initialPositions: custom });
  assert.equal(worker.terminated, true);
  lateReply({ data: { type: "RESULT", requestId: message.requestId,
    positionRevision: message.serializedState.positionRevision, rulesVersion: message.serializedState.rulesVersion,
    currentPlayer: message.serializedState.currentPlayer, moves: [{ point: oldPoint }] } });
  assert.deepEqual(serializeRuleState(controller.engine), before, "old AI results cannot enter the new opening");
  await app.startLocalMatch();
  assert.deepEqual(controller.engine.initialPositions, custom);
  const settingsWatcher = watchers.find(({ source }) => Array.isArray(source) && source[0] === app.selectedPlayerCount);
  const previous = settingsWatcher.source.map(({ value }) => value);
  app.selectedPlayerCount.value = 6;
  settingsWatcher.callback(settingsWatcher.source.map(({ value }) => value), previous);
  assert.equal(app.selectedStartingPoints.value.startingPointMode, "custom");
  assert.deepEqual(Object.keys(app.selectedStartingPoints.value.initialPositions), PLAYER_ORDER.slice(0, 6));
  const liveBeforeShapeChange = serializeRuleState(controller.engine);
  const beforeShapeSettings = settingsWatcher.source.map(({ value }) => value);
  app.selectedBoardShape.value = "hexagon";
  settingsWatcher.callback(settingsWatcher.source.map(({ value }) => value), beforeShapeSettings);
  assert.deepEqual(serializeRuleState(controller.engine), liveBeforeShapeChange, "shape preview preserves the live match");
  assert.equal(app.localSetupPending.value, false, "shape edits do not lock an active match");
  assert.equal(app.localSettingsChanged.value, true, "the new shape is pending until Start");
  assert.deepEqual(app.selectedStartingPoints.value.initialPositions, resolveInitialPositions(5, 6, null, "hexagon"));
  await app.startLocalMatch();
  assert.equal(controller.engine.boardShape, "hexagon");
  const beforeCountSettings = settingsWatcher.source.map(({ value }) => value);
  app.selectedPlayerCount.value = 3;
  settingsWatcher.callback(settingsWatcher.source.map(({ value }) => value), beforeCountSettings);
  assert.equal(app.selectedBoardShape.value, "hexagon", "changing count preserves the chosen shape");
  console.log("verify-starting-point-session: PASS (2–6 × both shapes, preview/start/restart/refresh/default, durable roots, geometry changes, stale AI rejection)");
} finally { for (const cleanup of unmounts) cleanup(); }
