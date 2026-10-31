import assert from "node:assert/strict";

// This exercises OnlineApp's actual tutorial-return orchestration.  The
// controller and topology engine are real; Vue, Canvas and browser storage are
// deliberately minimal so this remains a deterministic Node regression.
await import("../TopologyGameEngine.js");

const values = new Map();
const noop = () => {};
const unmountCallbacks = [];
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.location = new URL("http://localhost:8876/");
globalThis.document = { body: { classList: { add: noop, remove: noop, toggle: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.Vue = {
  ref: (value) => ({ value }),
  shallowRef: (value) => ({ value }),
  computed: (read) => ({ get value() { return read(); } }),
  watch: noop,
  nextTick: async () => {},
  onMounted: noop,
  onBeforeUnmount: (callback) => unmountCallbacks.push(callback),
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};

const [
  { default: App },
  { default: GameController },
  { default: GameEngine },
  {
    TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY,
    createTopologyLocalGameSession,
    loadTopologyLocalGameSession,
    persistTopologyLocalGameSession,
  },
  { persistLocalMatchPreferences },
  fixtures,
] = await Promise.all([
  import("../OnlineApp.js"),
  import("../GameController.js"),
  import("../GameEngine.js"),
  import("../LocalGameSession.js"),
  import("../LocalAIModes.js"),
  import("./fixtures/board-topology-v1-fixtures.mjs"),
]);

const { CONCAVE_GAP_DEFINITION } = fixtures;

function makeController() {
  const errors = [];
  const controller = Object.assign(Object.create(GameController.prototype), {
    canvas: { style: {}, setAttribute: noop },
    options: { engine: { gridSize: 5, playerCount: 2, rulesVersion: "territory-v3" } },
    engine: new GameEngine({ gridSize: 5, playerCount: 2 }),
    _validGridPoints: [],
    _engineEpoch: 1,
    _authoritativeSnapshotValid: true,
    multiplayerEnabled: false,
    localPlayer: null,
    roomReady: false,
    opponentConnected: false,
    readOnlyMode: false,
    lastAction: null,
    lastMoves: {},
    inspectionOverlay: null,
    _networkUnsubscribers: [],
    _cancelTerritoryRefresh: noop,
    _scheduleTerritoryRefresh: noop,
    _updateLargeBoardClass: noop,
    _syncCanvasInteractivity: noop,
    _syncSnapshot: noop,
    _reportNetworkError(error) { errors.push(error); },
    renderer: { invalidate: noop, render: noop, clearHintPoint: noop },
  });
  return { controller, errors };
}

function makeSavedTopologySession() {
  const engine = new GameEngine({
    boardDefinition: CONCAVE_GAP_DEFINITION,
    playerCount: 2,
    startPlayer: "WHITE",
    rulesVersion: "surface-v1",
  });
  const first = engine.getLegalMoves().at(0)?.vertexId;
  assert.equal(typeof first, "string");
  assert.equal(engine.playMove(first).success, true);
  const second = engine.getLegalMoves().at(0)?.vertexId;
  assert.equal(typeof second, "string");
  assert.equal(engine.playMove(second).success, true);
  const actions = [
    { type: "player_move", vertexId: first },
    { type: "player_move", vertexId: second },
  ];
  const session = createTopologyLocalGameSession(engine.encodeTopologyState(), actions, {
    startPlayer: "WHITE",
    settings: {
      turnTimerEnabled: true,
      turnTimeLimitSeconds: 45,
      hintEnabled: true,
      hintMaxCount: 2,
      undoEnabled: true,
      undoMaxCount: 3,
    },
    match: {
      players: {
        BLACK: { choice: "human" },
        WHITE: { choice: "topology-generic" },
      },
      started: true,
      paused: false,
      undo: { usedCount: 1 },
    },
  });
  return { engine, session };
}

function seedStorage(session) {
  values.clear();
  assert.equal(persistTopologyLocalGameSession(session), true);
  return values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY);
}

function assertSameTopologyState(actual, expected, message) {
  assert.equal(actual.isTopologyBoard, true, message);
  assert.equal(actual.boardHash, expected.boardHash, message);
  assert.equal(actual.startPlayer, expected.startPlayer, message);
  assert.equal(actual.currentPlayer, expected.currentPlayer, message);
  assert.equal(actual.positionRevision, expected.positionRevision, message);
  assert.deepEqual([...actual.historyHashes].sort(), [...expected.historyHashes].sort(), message);
  assert.deepEqual(actual.getSnapshot().boardStates, expected.getSnapshot().boardStates, message);
  assert.deepEqual(actual.getSnapshot().topologyPaths, expected.getSnapshot().topologyPaths, message);
}

// A topology session present at page load must leave the tutorial by a direct
// full-state restore, not by interpreting canonical IDs as coordinate replay.
const { engine: savedEngine, session: savedSession } = makeSavedTopologySession();
const rawBeforeRestore = seedStorage(savedSession);
const app = App.setup();
const { controller } = makeController();
assert.equal(app.tutorialAutoRestoring.value, true, "a valid save suppresses the first-run tutorial during restore");
let legacyRestoreAfterTutorial = 0;
const realLegacyRestore = controller.restoreMatchState.bind(controller);
controller.restoreMatchState = (...args) => {
  legacyRestoreAfterTutorial += 1;
  return realLegacyRestore(...args);
};
let directTopologyRestore = 0;
const realTopologyRestore = controller.restoreTopologyState.bind(controller);
controller.restoreTopologyState = (...args) => {
  directTopologyRestore += 1;
  return realTopologyRestore(...args);
};

assert.equal(await app.handleControllerReady(controller), true, "a valid topology save restores on startup");
assert.deepEqual(controller.lastMoves, { WHITE: savedSession.actions[0].vertexId, BLACK: savedSession.actions[1].vertexId }, "startup reconstructs all player markers from validated actions");
assert.equal(app.tutorialActive.value, false);
assert.equal(app.tutorialAutoRestoring.value, false);
assert.equal(directTopologyRestore, 1, "startup must directly restore the encoded topology state");
assert.equal(legacyRestoreAfterTutorial, 0, "topology startup never uses coordinate replay");
assertSameTopologyState(controller.engine, savedEngine, "stored topology state must survive tutorial exit exactly");
assert.deepEqual(app.localGameActions.value, savedSession.actions, "canonical action history must be restored unchanged");
assert.equal(app.selectedBoardShape.value, "custom");
assert.equal(app.selectedStartPlayer.value, "WHITE", "opening player comes from session metadata, not currentPlayer");
assert.equal(app.localMatchStarted.value, true);
assert.equal(app.selectedUndoEnabled.value, true, "topology session restores its enabled undo control");
assert.equal(app.selectedUndoMaxCount.value, 3, "topology session restores its undo allowance");
assert.equal(app.undoRemainingCount.value, 2, "topology session restores undo usage without refilling quota");
assert.equal(values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY), rawBeforeRestore,
  "returning from a tutorial must not overwrite the original topology save");

// A separate restored session exercises the actual UI undo handler without
// disturbing the main fixture. The action prefix determines the markers.
const undoApp = App.setup(); const { controller: undoController } = makeController();
assert.equal(await undoApp.handleControllerReady(undoController), true);
assert.equal(undoApp.requestUndo(), true, "restored topology undo accepts a valid prior human move");
assert.deepEqual(undoController.lastMoves, { WHITE: savedSession.actions[0].vertexId }, "actual undo rebuilds markers for the retained prefix");
values.set(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY, rawBeforeRestore);

// Starting a tutorial from a live topology board uses the same isolated state
// channel and must round-trip its canonical state without a legacy detour.
const stateBeforeRestartedTutorial = controller.engine.encodeTopologyState();
const actionsBeforeRestartedTutorial = structuredClone(app.localGameActions.value);
app.startTutorial();
assert.equal(app.tutorialActive.value, true);
assert.equal(Boolean(controller.engine.isTopologyBoard), false);
const legacyBeforeSecondExit = legacyRestoreAfterTutorial;
assert.equal(await app.skipTutorial(), true);
assert.equal(legacyRestoreAfterTutorial, legacyBeforeSecondExit,
  "a live topology tutorial return must not use legacy replay");
assertSameTopologyState(controller.engine, savedEngine, "live topology state must survive an explicit tutorial round-trip");
assert.deepEqual(controller.engine.encodeTopologyState(), stateBeforeRestartedTutorial);
assert.deepEqual(app.localGameActions.value, actionsBeforeRestartedTutorial);

// Changing a next-match draft must not stop a live human turn or reset its UI.
app.activeLocalPlayers.value = { ...app.activeLocalPlayers.value, WHITE: { choice: "human" } };
app.aiThinking.value = false;
const liveSnapshotBeforeDraft = controller.engine.encodeTopologyState();
assert.equal(app.localMatchStarted.value, true);
assert.equal(app.localSetupPending.value, false);
assert.equal(app.skipDisabled.value, false);
app.selectTopologyPreset("tetrahedron");
app.handleGridSizeChange(15);
assert.equal(app.selectedTopologyDefinition.value.topology.preset, "tetrahedron");
assert.equal(app.localSettingsChanged.value, true);
assert.equal(app.localSetupPending.value, false);
assert.equal(app.localMatchStarted.value, true);
assert.equal(app.skipDisabled.value, false);
assert.ok(!["开始对局", "Start match"].includes(app.resetLabel.value));
assert.deepEqual(controller.engine.encodeTopologyState(), liveSnapshotBeforeDraft);

// If the direct topology restore rejects a tampered state, leaveTutorial must
// keep the tutorial board and the original persisted session.  It must not
// silently construct a triangular fallback or call the legacy restore path.
const rawBeforeRejectedRestore = seedStorage(savedSession);
const rejectedApp = App.setup();
const { controller: rejectedController, errors } = makeController();
let forbiddenLegacyFallbacks = 0;
const realRejectedLegacyRestore = rejectedController.restoreMatchState.bind(rejectedController);
rejectedController.restoreMatchState = (...args) => {
  forbiddenLegacyFallbacks += 1;
  return realRejectedLegacyRestore(...args);
};
const realRejectedTopologyRestore = rejectedController.restoreTopologyState.bind(rejectedController);
rejectedController.restoreTopologyState = (state, options) => {
  const tampered = structuredClone(state);
  tampered.boardHash = "0".repeat(64);
  return realRejectedTopologyRestore(tampered, options);
};

assert.equal(await rejectedApp.handleControllerReady(rejectedController), false);
const tutorialEngineBeforeRejectedRestore = rejectedController.engine;
assert.equal(forbiddenLegacyFallbacks, 1, "only the fallback tutorial loads after rejection, never the saved game as a legacy replay");
assert.equal(rejectedController.engine, tutorialEngineBeforeRejectedRestore,
  "a rejected topology state must leave the live tutorial engine in place");
assert.equal(rejectedApp.tutorialActive.value, true, "a failed restore keeps the tutorial active for a safe retry");
assert.equal(values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY), rawBeforeRejectedRestore,
  "a failed restore must preserve the raw topology session");
assert.equal(errors.length, 1, "the rejected state must surface an error through the controller channel");

// A topology definition selected before the first match is stored as a draft
// preference, not a coordinate replay.  Reloading with that preference must
// neither crash during app setup nor route it through the legacy local-session
// codec when the tutorial closes.
values.clear();
persistLocalMatchPreferences({
  BLACK: { choice: "human" },
  WHITE: { choice: "topology-generic" },
}, {
  playerCount: 2,
  boardShape: "custom",
  gridSize: 9,
  startPlayer: "BLACK",
  rulesVersion: "surface-v1",
  topologyProtocolVersion: "board-topology-v1",
  boardDefinition: structuredClone(CONCAVE_GAP_DEFINITION),
});
const draftApp = App.setup();
const { controller: draftController } = makeController();
draftApp.handleControllerReady(draftController);
assert.equal(await draftApp.skipTutorial(), true,
  "a saved topology draft must leave the tutorial without a legacy-session failure");
assert.equal(draftController.engine.isTopologyBoard, true);
assert.equal(draftController.engine.boardHash, new GameEngine({
  boardDefinition: CONCAVE_GAP_DEFINITION,
  rulesVersion: "surface-v1",
}).boardHash);
assert.equal(draftApp.selectedBoardShape.value, "custom");
assert.equal(draftApp.localMatchStarted.value, false,
  "a saved setup draft must still require the player to start the new match");

// Editing shape and size is a next-match draft, never a live-engine mutation.
const draftLiveEngine = draftController.engine;
const draftLiveState = draftLiveEngine.encodeTopologyState();
draftApp.handleBoardShapeChange("triangle");
draftApp.handleGridSizeChange(5);
draftApp.handleBoardShapeChange("custom");
assert.equal(draftController.engine, draftLiveEngine);
assert.deepEqual(draftLiveEngine.encodeTopologyState(), draftLiveState);

// A rejected next-match configuration must preserve the active engine, seat
// roles, and the on-disk topology save. Only a successful construction commits.
seedStorage(savedSession);
const preservedRawSave = values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY);
const beforeFailedStart = controller.engine.encodeTopologyState();
const beforeFailedPlayers = structuredClone(app.activeLocalPlayers.value);
const realSetGameConfig = controller.setGameConfig.bind(controller);
controller.setGameConfig = () => { throw new Error("simulated rejected setup"); };
assert.equal(await app.startLocalMatch(), false);
controller.setGameConfig = realSetGameConfig;
assert.equal(values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY), preservedRawSave);
assert.deepEqual(controller.engine.encodeTopologyState(), beforeFailedStart);
assert.deepEqual(app.activeLocalPlayers.value, beforeFailedPlayers);
assert.equal(app.localMatchStarted.value, true);

// Exercise the same local-session path used by real multi-root actions, through
// a played move and terminal passes, then restore its complete encoded state.
app.handleGridSizeChange(9);
app.selectTopologyPreset("tetrahedron");
app.updateTopologyStarts({ mode: "random", countPerPlayer: 2, random: () => 0.43 });
app.updateLocalPlayer({ color: "BLACK", patch: { choice: "human" } });
app.updateLocalPlayer({ color: "WHITE", patch: { choice: "human" } });
assert.equal(await app.startLocalMatch(), true);
assert.equal(controller.engine.initialRoots.BLACK.length, 2);
assert.equal(controller.engine.initialRoots.WHITE.length, 2);
const chosen = controller.engine.getLegalMoves()[0];
assert.ok(chosen);
const played = controller._applyMove(chosen.point, controller.engine.currentPlayer);
assert.equal(played.success, true);
app.handleStateChange(played.state);
// The current, nonterminal multi-root game must survive a trip to replay
// position zero and back through the real GameController restore method.
const liveEncodedBeforeReview = controller.engine.encodeTopologyState();
const liveActionsBeforeReview = structuredClone(app.localGameActions.value);
const liveLastAction = structuredClone(controller.lastAction);
const liveLastMoves = structuredClone(controller.lastMoves);
await app.handleStartReplay();
assert.equal(app.replayMode.value, true);
app.handleSeekReplay(0);
assert.equal(app.replayCursor.value, 0);
app.handleExitReplay();
assert.equal(app.replayMode.value, false, "exit review restores the active topology match");
assert.deepEqual(controller.engine.encodeTopologyState(), liveEncodedBeforeReview, "roots, current player, paths, hash and full history survive review");
assert.deepEqual(app.localGameActions.value, liveActionsBeforeReview);
assert.deepEqual(controller.lastAction, liveLastAction);
assert.deepEqual(controller.lastMoves, liveLastMoves, "leaving review restores player markers");
for (let i = 0; i < 2; i++) {
  const passed = controller.skipTurn();
  assert.equal(passed.success, true);
  app.handleStateChange(passed.state);
}
assert.equal(controller.engine.gameOver, true);
const currentSession = loadTopologyLocalGameSession();
assert.ok(currentSession, "multi-root moves and terminal passes persist a valid session");
assert.equal(currentSession.actions.length, 3);
const terminalState = controller.engine.encodeTopologyState();
const roundTrip = makeController().controller.restoreTopologyState(currentSession.topologyState);
assert.equal(roundTrip.success, true);
assert.deepEqual(roundTrip.state.snapshot.initialRoots, controller.engine.getSnapshot().initialRoots);
assert.deepEqual(roundTrip.state.snapshot.boardStates, controller.engine.getSnapshot().boardStates);
assert.equal(roundTrip.state.snapshot.gameOver, true);
assert.equal(currentSession.boardHash, terminalState.boardHash);

// A finished match must appear directly after reload, without a first-run
// tutorial obscuring it. The explicit tutorial entry remains available.
const savedTerminalRaw = values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY);
const reloadedTerminal = App.setup();
const terminalController = makeController().controller;
assert.equal(reloadedTerminal.tutorialAutoRestoring.value, true);
assert.equal(await reloadedTerminal.handleControllerReady(terminalController), true);
assert.equal(reloadedTerminal.tutorialActive.value, false);
assert.equal(terminalController.engine.gameOver, true);
assert.deepEqual(terminalController.engine.encodeTopologyState(), terminalState);
assert.deepEqual(reloadedTerminal.localGameActions.value, currentSession.actions);
assert.equal(values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY), savedTerminalRaw);
reloadedTerminal.startTutorial();
assert.equal(reloadedTerminal.tutorialActive.value, true, "manual tutorial remains available after reload");
assert.equal(await reloadedTerminal.skipTutorial(), true);
assert.deepEqual(terminalController.engine.encodeTopologyState(), terminalState);
globalThis.location = new URL('http://localhost:8876/?tutorial=1');
const standalone = App.setup();
const standaloneController = makeController().controller;
await standalone.handleControllerReady(standaloneController);
assert.equal(standalone.tutorialAutoRestoring.value, false);
assert.equal(standalone.tutorialActive.value, true, "explicit tutorial tab is not bypassed by a save");
globalThis.location = new URL('http://localhost:8876/');

// Render the actual topology replay event in both timeline and inspector.
await app.handleStartReplay();
assert.equal(app.replayMode.value, true);
app.handleSeekReplay(1);
const replayEvent = app.currentReplayEvent.value;
assert.equal(replayEvent.type, "move");
assert.equal(typeof replayEvent.vertexId, "string");
const controlProps = { language: "zh", uiStyle: "casual", event: replayEvent, replayDocument: app.replayDocument.value };
const timeline = App.components.ReplayControls.setup(controlProps);
assert.ok(timeline.summary.value.includes(replayEvent.vertexId));
assert.ok(!timeline.summary.value.includes("undefined"));
const inspector = App.components.ReplayInspectorPanel.setup({ language: "zh", event: replayEvent, gameState: app.gameState.value }, { emit: noop });
assert.ok(inspector.eventSummary.value.includes(replayEvent.vertexId));
const ordinary = App.components.ReplayControls.setup({ ...controlProps, event: { type: "move", actor: "BLACK", point: [2, 3] } });
assert.ok(ordinary.summary.value.includes("(2, 3)"), "ordinary replay coordinates remain unchanged");
app.handleSeekReplay(0);
app.handleExitReplay();
assert.equal(app.replayMode.value, false, "terminal topology game also exits review");
assert.deepEqual(controller.engine.encodeTopologyState(), terminalState);

// The actual Start handler upgrades only a new match; restoring, reviewing and
// exiting a pre-v3 save must retain its original path IDs and definition.
const oldSessionCase = makeSavedTopologySession();
assert.equal(oldSessionCase.engine.boardDefinition.topology.movementStrategy,'simple-rays-v1');
const oldEncoded = oldSessionCase.engine.encodeTopologyState();
const oldPathIds = oldSessionCase.engine.getTopologyRuleState().logicPaths.map(path=>path.pathId);
assert.ok(oldPathIds.length);
seedStorage(oldSessionCase.session);
const oldApp = App.setup(), oldController = makeController().controller;
assert.equal(await oldApp.handleControllerReady(oldController),true);
assert.deepEqual(oldController.engine.encodeTopologyState(),oldEncoded);
await oldApp.handleStartReplay();
assert.equal(oldApp.replayMode.value,true);
oldApp.handleSeekReplay(0);
oldApp.handleExitReplay();
assert.deepEqual(oldController.engine.encodeTopologyState(),oldEncoded);
assert.deepEqual(oldController.engine.getTopologyRuleState().logicPaths.map(path=>path.pathId),oldPathIds);
const rootsBeforeNew = structuredClone(oldController.engine.initialRoots);
oldApp.updateLocalPlayer({color:'BLACK',patch:{choice:'human'}});
oldApp.updateLocalPlayer({color:'WHITE',patch:{choice:'human'}});
assert.equal(await oldApp.startLocalMatch(),true);
assert.equal(oldController.engine.boardDefinition.topology.movementStrategy,'simple-rays-v3');
assert.notEqual(oldController.engine.boardHash,oldEncoded.boardHash);
assert.deepEqual(oldController.engine.initialRoots,rootsBeforeNew);
assert.equal(oldApp.selectedTopologyHash.value,oldController.engine.boardHash);
assert.equal(oldApp.selectedTopologyDefinition.value.topology.movementStrategy,'simple-rays-v3');
assert.equal(loadTopologyLocalGameSession().boardHash,oldController.engine.boardHash);

// Real app save/reload path: a 5-point torus retains its setup identity,
// two played actions, exact canonical board and both human/AI seat profiles.
values.clear();
const presetApp = App.setup(), presetController = makeController().controller;
await presetApp.handleControllerReady(presetController);
assert.equal(await presetApp.skipTutorial(), true);
presetApp.handleGridSizeChange(5);
assert.ok(presetApp.selectTopologyPreset("torus"));
presetApp.updateLocalPlayer({ color: "BLACK", patch: { choice: "human" } });
presetApp.updateLocalPlayer({ color: "WHITE", patch: { choice: "topology-generic" } });
assert.equal(await presetApp.startLocalMatch(), true);
for (let i = 0; i < 2; i++) {
  const move = presetController.engine.getLegalMoves()[0];
  const result = presetController._applyMove(move.point, presetController.engine.currentPlayer);
  assert.equal(result.success, true);
  presetApp.handleStateChange(result.state);
}
const presetState = presetController.engine.encodeTopologyState();
assert.equal(presetController.engine.getValidPositions().length, 16);
const presetSession = loadTopologyLocalGameSession();
assert.equal(presetSession.settings.gridSize, 5);
assert.equal(presetSession.actions.length, 2);
const reloadPreset = async () => {
  const reload = App.setup(), target = makeController().controller;
  assert.equal(await reload.handleControllerReady(target), true);
  assert.equal(reload.selectedGridSize.value, 5);
  assert.equal(reload.selectedTopologySource.value, "torus");
  assert.equal(reload.activeLocalPlayers.value.BLACK.choice, "human");
  assert.equal(reload.activeLocalPlayers.value.WHITE.choice, "topology-generic");
  assert.deepEqual(target.engine.encodeTopologyState(), presetState);
  assert.deepEqual(reload.localGameActions.value, presetSession.actions);
};
await reloadPreset();
// Existing v1 saves have no size field. Unique geometry is inferred without
// rewriting the state, drawing roots, or silently losing the two actions.
const legacyPreset = JSON.parse(values.get(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY));
delete legacyPreset.settings.gridSize;
values.set(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(legacyPreset));
await reloadPreset();
legacyPreset.settings.gridSize = 9; // inconsistent metadata cannot override known geometry
values.set(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(legacyPreset));
await reloadPreset();

for (const unmount of unmountCallbacks.reverse()) unmount();

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "persisted topology local session automatically restores through direct full-state restore",
    "startPlayer, board hash, canonical state, history, action IDs and local undo controls round-trip",
    "starting tutorial from a live topology game preserves the same state",
    "tampered direct restore keeps the tutorial board and raw save without legacy fallback",
    "saved topology draft preference reloads as a pending custom board",
    "5-point torus restores settings, exact board, two actions and players; old or inconsistent metadata cannot rebuild it",
  ],
  scope: "Node/mock-Vue integration only; it does not replace browser Canvas, real localStorage, or two-client WebSocket acceptance.",
}));
