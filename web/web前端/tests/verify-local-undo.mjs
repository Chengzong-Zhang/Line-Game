import assert from "node:assert/strict";
import GameEngine, { StartProtectionRule } from "../GameEngine.js?v=20261021-boardshapes1";
import GameController from "../GameController.js?v=20261021-boardshapes1";
import { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } from "../AIStateProtocol.js?v=20261021-boardshapes1";
import { normalizeGameSettings } from "../OnlineAppState.js?v=20261021-undo1";
import { normalizeLocalPlayers } from "../LocalAIModes.js?v=20261021-boardshapes1";
import { LOCAL_GAME_SESSION_STORAGE_KEY, createLocalGameSession, persistLocalGameSession, loadLocalGameSession } from "../LocalGameSession.js?v=20261021-undo1";
import { localUndoTimeline, planLocalUndo, consumeLocalUndo, recordUndoAction } from "../LocalUndo.js?v=20261021-undo1";
import { CONCAVE_GAP_DEFINITION } from "./fixtures/board-topology-v1-fixtures.mjs";

// GameEngine deliberately has no static topology import so legacy data-URL
// regression loaders remain valid.  The production entry registers this
// factory before any local match begins; do the same in this direct utility
// regression.
await import("../TopologyGameEngine.js");

const noop = () => {};
const colors = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
const humanPlayers = Object.fromEntries(colors.map((color) => [color, { choice: "human" }]));
const controllerFor = (settings) => Object.assign(Object.create(GameController.prototype), {
  options: { engine: settings }, engine: new GameEngine(settings), _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop,
  canvas: { style: {}, setAttribute: noop }, _updateLargeBoardClass: noop,
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, multiplayerEnabled: false,
  lastAction: null, localPlayer: null,
});
const storageValues = new Map();
const storage = { getItem: (key) => storageValues.get(key), setItem: (key, value) => storageValues.set(key, value), removeItem: (key) => storageValues.delete(key) };
const normalize = (extra = {}) => normalizeGameSettings({ gridSize: 5, playerCount: 2, undoEnabled: true, ...extra });
const play = (engine, actions) => {
  const point = engine.getSnapshot().legalMoves[0]?.point;
  assert.ok(point);
  const player = engine.currentPlayer;
  assert.equal(engine.playMove(point).success, true);
  actions.push({ type: "player_move", point });
  return player;
};
assert.equal(normalizeGameSettings().undoEnabled, false);
assert.equal(normalizeGameSettings().undoMaxCount, 3);
assert.equal(normalize({ undoMaxCount: 999 }).undoMaxCount, 100);
assert.equal(normalize({ undoMaxCount: -1 }).undoMaxCount, 1);

let restoredCases = 0;
for (const rulesVersion of ["territory-v1", "territory-v2", "territory-v3"]) {
  for (const playerCount of [2, 3, 4, 5, 6]) {
    for (const boardShape of ["triangle", "hexagon"]) {
      const settings = normalize({ gridSize: 9, playerCount, boardShape, rulesVersion, startPlayer: colors[playerCount - 1] });
      const controller = controllerFor(settings);
      const actions = [];
      const before = serializeEngineState(controller.engine);
      const actors = [];
      for (let turn = 0; turn < playerCount; turn++) actors.push(play(controller.engine, actions));
      const timeline = localUndoTimeline(settings, actions);
      assert.deepEqual(timeline.map((action) => action.player), actors, "actors must follow the rule engine");
      const plan = planLocalUndo({ settings, actions, players: humanPlayers, currentPlayer: settings.startPlayer });
      assert.equal(plan.actionIndex, 0);
      const request = captureWorkerRequest(controller.engine, 1);
      const reply = { requestId: 1, positionRevision: request.positionRevision, rulesVersion,
        protectionRule: request.protectionRule, currentPlayer: request.currentPlayer };
      assert.equal(isWorkerResultForRequest(controller.engine, request, reply), true);
      const oldEngine = controller.engine;
      assert.equal(controller.restoreMatchState({ settings, actions: actions.slice(0, plan.actionIndex) }).success, true);
      assert.notEqual(controller.engine, oldEngine);
      assert.equal(isWorkerResultForRequest(controller.engine, request, reply), false);
      const after = serializeEngineState(controller.engine);
      assert.deepEqual(after, before, "undo must restore all rule state, history hashes, skips, scores and roots");
      const usage = consumeLocalUndo({}, plan);
      assert.equal(usage.usedCount, 1);
      assert.equal(planLocalUndo({ settings, actions: [], players: humanPlayers, currentPlayer: settings.startPlayer, usage }), null);
      restoredCases++;
    }
  }
}

// Repeated undo walks back through earlier own placements, including saved old locks.
const settings = normalize();
const engine = new GameEngine(settings);
const actions = [];
for (let i = 0; i < 4; i++) play(engine, actions);
const aiPlayers = { BLACK: { choice: "human" }, WHITE: { choice: "minimax" } };
let plan = planLocalUndo({ settings, actions, players: aiPlayers, currentPlayer: "BLACK" });
assert.equal(plan.actionIndex, 2);
const usage = consumeLocalUndo({}, plan);
assert.equal(planLocalUndo({ settings, actions: actions.slice(0, 2), players: aiPlayers, currentPlayer: "BLACK", usage }).actionIndex, 0);
assert.equal(planLocalUndo({ settings, actions, players: aiPlayers, currentPlayer: "BLACK", usage: { usedCount: 1, blockedPlayers: ["BLACK"] } }).actionIndex, 2, "old saves must not lock repeated undo");
assert.equal(planLocalUndo({ settings, actions: actions.slice(0, 3), players: aiPlayers, currentPlayer: "WHITE" }).actionIndex, 2, "can undo while AI is thinking");
assert.equal(planLocalUndo({ settings, actions, players: { BLACK: { choice: "minimax" }, WHITE: { choice: "minimax" } }, currentPlayer: "BLACK" }), null);
assert.equal(planLocalUndo({ settings, actions: [...actions, { type: "player_skip" }], players: aiPlayers, currentPlayer: "BLACK" }).actionIndex, 2, "a later PASS is included when taking back the latest placement");
assert.equal(localUndoTimeline(settings, [{ type: "player_move", point: [99, 99] }]), null);
assert.deepEqual(recordUndoAction(usage, "BLACK"), { usedCount: 1, blockedPlayers: [] });
const session = createLocalGameSession(settings, actions.slice(0, 2), { players: aiPlayers, started: true, paused: false, undo: usage });
assert.equal(persistLocalGameSession(session, storage), true);
assert.deepEqual(loadLocalGameSession(storage).match.undo, usage);

// The actual pre-field local-save envelope must remain symmetric through
// load, controller replay, undo, and another save, including a WHITE start.
const legacySettings = normalize({startPlayer:'WHITE', protectionRule:StartProtectionRule.SYMMETRIC});
const legacyGame = new GameEngine(legacySettings), legacyActions = [];
play(legacyGame, legacyActions); play(legacyGame, legacyActions);
const legacySession = createLocalGameSession(legacySettings,legacyActions,{players:humanPlayers,started:true,paused:false});
delete legacySession.settings.protectionRule;
const legacyValues = new Map([[LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(legacySession)]]);
const legacyStorage = {getItem:key=>legacyValues.get(key),setItem:(key,value)=>legacyValues.set(key,value)};
const legacyLoaded = loadLocalGameSession(legacyStorage);
assert.equal(legacyLoaded.settings.protectionRule, StartProtectionRule.SYMMETRIC);
const legacyController = controllerFor(legacyLoaded.settings);
assert.equal(legacyController.restoreMatchState(legacyLoaded).success,true);
assert.deepEqual(serializeEngineState(legacyController.engine),serializeEngineState(legacyGame));
assert.equal(legacyController.restoreMatchState({settings:legacyLoaded.settings,actions:legacyActions.slice(0,1)}).success,true);
assert.equal(legacyController.engine.protectionRule,StartProtectionRule.SYMMETRIC);
assert.equal(persistLocalGameSession(createLocalGameSession(legacyLoaded.settings,legacyActions.slice(0,1),
  {players:humanPlayers,started:true,paused:false}),legacyStorage),true);
assert.equal(loadLocalGameSession(legacyStorage).settings.protectionRule,StartProtectionRule.SYMMETRIC);

// Topology actions contain canonical vertex IDs instead of `[x, y]` tuples.
// The undo timeline must replay those exact actions, retain their real actor
// order and hand the same prefix to the isolated controller restore path.
const topologySettings = normalizeGameSettings({
  playerCount: 2,
  gridSize: 5,
  boardShape: "custom",
  rulesVersion: "surface-v1",
  topologyProtocolVersion: "board-topology-v1",
  boardDefinition: CONCAVE_GAP_DEFINITION,
  undoEnabled: true,
});
const topologyEngine = new GameEngine(topologySettings);
assert.equal(topologyEngine.isTopologyBoard, true);
const topologyActions = [];
const topologyActors = [];
for (let index = 0; index < 2; index += 1) {
  const vertexId = topologyEngine.getLegalMoves().at(0)?.vertexId;
  assert.equal(typeof vertexId, "string");
  topologyActors.push(topologyEngine.currentPlayer);
  assert.equal(topologyEngine.playMove(vertexId).success, true);
  topologyActions.push({ type: "player_move", vertexId, boardHash: topologyEngine.boardHash });
}
const topologyTimeline = localUndoTimeline(topologySettings, topologyActions);
assert.deepEqual(topologyTimeline?.map((action) => action.player), topologyActors,
  "topology undo must replay canonical moves with the engine's actor order");
const topologyPlan = planLocalUndo({
  settings: topologySettings,
  actions: topologyActions,
  players: humanPlayers,
  currentPlayer: topologyEngine.currentPlayer,
  timeline: topologyTimeline,
});
assert.equal(topologyPlan?.actionIndex, 0,
  "the current human can rewind its latest canonical placement");
const topologyController = controllerFor(topologySettings);
assert.equal(topologyController.restoreMatchState({
  settings: topologySettings,
  actions: topologyActions.slice(0, topologyPlan.actionIndex),
}).success, true, "the topology undo prefix restores in isolation");
assert.equal(topologyController.engine.isTopologyBoard, true);

// Exercise the actual application handlers with a minimal Vue lifecycle harness.
globalThis.localStorage = storage;
globalThis.location = { origin: "http://localhost:8765", href: "http://localhost:8765/", search: "", hostname: "localhost", protocol: "http:" };
globalThis.removeEventListener = noop;
globalThis.document = { body: { classList: { remove: noop } } };
const cleanups = [];
globalThis.Vue = {
  ref: (value) => ({ value }), shallowRef: (value) => ({ value }),
  computed: (get) => ({ get value() { return get(); } }),
  watch: noop, onMounted: noop, onBeforeUnmount: (fn) => cleanups.push(fn), nextTick: async () => {},
};
const { default: App } = await import("../OnlineApp.js?v=20261021-undo1");
const app = App.setup();
const controller = controllerFor(settings);
controller.stateChangeListener = app.handleStateChange;
app.handleControllerReady(controller);
assert.equal(await app.skipTutorial(), true);
app.selectedUndoEnabled.value = true;
app.selectedUndoMaxCount.value = 2;
app.selectedHintEnabled.value = true;
app.selectedGridSize.value = 9; // Keep this six-action undo fixture away from a small-board terminal.
app.selectedLocalPlayers.value = normalizeLocalPlayers(humanPlayers);
assert.equal(await app.startLocalMatch(), true);
const commitMove = () => {
  const point = controller.engine.getSnapshot().legalMoves[0]?.point;
  assert.equal(controller._applyMove(point).success, true);
};
assert.equal(app.undoDisabled.value, true);
commitMove(); commitMove(); commitMove(); commitMove(); commitMove(); commitMove();
assert.equal(app.undoDisabled.value, false, JSON.stringify({enabled:app.undoEnabled.value, remaining:app.undoRemainingCount.value, actions:app.localGameActions.value, pending:app.localSetupPending.value, gameOver:app.gameState.value.gameOver, currentPlayer:app.gameState.value.currentPlayer, setupPlayers:app.selectedLocalPlayers.value, activePlayers:app.activeLocalPlayers.value}));
app.hintRemainingCount.value = 1;
assert.equal(app.requestUndo(), true);
assert.equal(app.localGameActions.value.length, 4);
assert.equal(app.gameState.value.currentPlayer, "BLACK");
assert.equal(app.hintRemainingCount.value, 1, "undo cannot refund hints");
assert.equal(app.undoRemainingCount.value, 1);
assert.equal(app.requestUndo(), true, "can repeatedly rewind earlier own moves");
assert.equal(app.localGameActions.value.length, 2);
assert.equal(app.undoRemainingCount.value, 0);
commitMove(); commitMove();
assert.equal(app.requestUndo(), false, "quota must be enforced by handler");
assert.equal(loadLocalGameSession(storage).match.undo.usedCount, 2);
const resumed = App.setup();
const resumedController = controllerFor(settings);
resumedController.stateChangeListener = resumed.handleStateChange;
resumed.handleControllerReady(resumedController);
assert.equal(await resumed.skipTutorial(), true);
assert.equal(resumed.undoRemainingCount.value, 0, "refresh/lesson return cannot refill the undo quota");
assert.equal(resumed.requestUndo(), false);
app.replayMode.value = true;
assert.equal(app.requestUndo(), false);
app.replayMode.value = false;
assert.equal(await app.startLocalMatch(), true);
assert.equal(app.undoRemainingCount.value, 2, "new matches reset the quota");
commitMove(); commitMove();
const originalRestore = controller.restoreMatchState;
controller.restoreMatchState = () => ({ success: false, reason: "test failure" });
const preserved = serializeEngineState(controller.engine);
assert.equal(app.requestUndo(), false);
assert.equal(app.undoRemainingCount.value, 2);
assert.deepEqual(serializeEngineState(controller.engine), preserved);
controller.restoreMatchState = originalRestore;
const originalWrite = storage.setItem;
storage.setItem = () => { throw new Error("Storage full"); };
const actionCount = app.localGameActions.value.length;
commitMove(); commitMove();
assert.equal(app.localGameActions.value.length, actionCount + 2, "storage failure cannot lose the live undo history");
assert.equal(app.requestUndo(), true);
storage.setItem = originalWrite;
for (const cleanup of cleanups) cleanup();
console.log(`verify-local-undo: PASS (${restoredCases} rule/shape/player restore cases; repeated own-move undo, canonical topology undo, quotas, old saves, actual app handlers, failed restore)`);
