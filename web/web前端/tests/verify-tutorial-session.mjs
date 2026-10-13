import assert from "node:assert/strict";
import GameController from "../GameController.js";
import GameEngine from "../GameEngine.js";
import { createLocalGameSession, LOCAL_GAME_SESSION_STORAGE_KEY } from "../LocalGameSession.js";
import { TUTORIAL_LEVELS } from "../TutorialRunner.js";

// Exercise the real app handlers, controller and rules without rendering a canvas.
// Vue watcher scheduling and responsive layout are checked in the browser separately.
const values = new Map();
const unmounts = [];
const openedTabs = [];
const noop = () => {};
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.location = new URL("http://localhost:8765/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.open = (...args) => openedTabs.push(args);
globalThis.Vue = {
  ref: (value) => ({ value }),
  shallowRef: (value) => ({ value }),
  computed: (read) => ({ get value() { return read(); } }),
  watch: noop,
  nextTick: async () => {},
  onMounted: noop,
  onBeforeUnmount: (callback) => unmounts.push(callback),
};
const { default: App } = await import("../OnlineApp.js");

const settings = {
  playerCount: 2,
  gridSize: 9,
  startPlayer: "BLACK",
  rulesVersion: "territory-v2",
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  hintEnabled: true,
  hintMaxCount: 3,
};
const saved = createLocalGameSession(settings, [
  { type: "player_move", point: [1, 0] },
  { type: "player_skip" },
]);
const savedJson = JSON.stringify(saved);

function mountApp() {
  const app = App.setup();
  const controller = Object.assign(Object.create(GameController.prototype), {
    canvas: { style: {}, setAttribute: noop },
    options: { engine: { ...settings } },
    engine: new GameEngine(settings),
    renderer: { invalidate: noop, render: noop, clearHintPoint: noop },
    _engineEpoch: 0,
    _cancelTerritoryRefresh: noop,
    _scheduleTerritoryRefresh: noop,
    multiplayerEnabled: false,
    localPlayer: null,
    roomReady: false,
    opponentConnected: false,
    networkManager: null,
    lastAction: null,
    _networkUnsubscribers: [],
    _authoritativeSnapshotValid: true,
    stateChangeListener: app.handleStateChange,
  });
  app.handleControllerReady(controller);
  return { app, controller };
}

function assertFirstLesson(app, controller) {
  assert.equal(app.tutorialActive.value, true);
  assert.equal(app.currentTutorialLevel.value.id, TUTORIAL_LEVELS[0].id);
  assert.equal(app.tutorialSuccess.value, false);
  assert.equal(controller.engine.gridSize, TUTORIAL_LEVELS[0].gridSize);
  assert.equal(controller.readOnlyMode, false);
  assert.equal(app.settingsLocked.value, true);
}

function assertSavedUntouched() {
  assert.equal(values.get(LOCAL_GAME_SESSION_STORAGE_KEY), savedJson);
}

function assertRestored(app, controller) {
  assert.equal(app.tutorialActive.value, false);
  assert.equal(controller.engine.gridSize, 9);
  assert.equal(app.selectedGridSize.value, 9);
  const expected = new GameEngine(settings);
  assert.equal(expected.playMove([1, 0]).success, true);
  assert.equal(expected.skipTurn().success, true);
  assert.deepEqual(controller.engine.getSnapshot().boardMatrix, expected.getSnapshot().boardMatrix);
  assert.deepEqual([...controller.engine.historyHashes], [...expected.historyHashes]);
  assert.equal(controller.engine.getCurrentPlayer(), expected.getCurrentPlayer());
  assert.deepEqual(app.localGameActions.value, saved.actions);
  assertSavedUntouched();
}

function act(controller, action) {
  const result = action.type === "skip" ? controller.skipTurn() : controller._applyMove(action.point);
  assert.equal(result.success, action.success ?? true);
}

try {
  for (const completed of [false, true]) {
    for (const hasSave of [false, true]) {
      values.clear();
      if (completed) values.set("lifeline-tutorial-completed-v1", "1");
      if (hasSave) values.set(LOCAL_GAME_SESSION_STORAGE_KEY, savedJson);
      const { app, controller } = mountApp();
      assertFirstLesson(app, controller);
      if (hasSave) assertSavedUntouched();
      assert.equal(await app.skipTutorial(), true);
      if (hasSave) assertRestored(app, controller);
      app.startTutorial();
      assertFirstLesson(app, controller);
      app.startTutorial();
      assertFirstLesson(app, controller);
      assert.equal(await app.skipTutorial(), true);
      if (hasSave) assertRestored(app, controller);
    }
  }

  values.clear();
  values.set(LOCAL_GAME_SESSION_STORAGE_KEY, savedJson);
  const { app, controller } = mountApp();
  for (const level of TUTORIAL_LEVELS) {
    assert.equal(app.currentTutorialLevel.value.id, level.id);
    if (level.restriction) act(controller, { type: "move", point: level.restriction.point, success: false });
    act(controller, level.objective);
    assert.equal(app.tutorialSuccess.value, true, level.id);
    assertSavedUntouched();
    await app.advanceTutorial();
  }
  assertRestored(app, controller);

  app.hintRemainingCount.value = 1;
  app.startTutorial();
  act(controller, TUTORIAL_LEVELS[0].objective);
  assert.equal(app.tutorialSuccess.value, true);
  app.startTutorial();
  assertFirstLesson(app, controller);
  assertSavedUntouched();
  const reloaded = mountApp();
  assertFirstLesson(reloaded.app, reloaded.controller);
  await reloaded.app.skipTutorial();
  assertRestored(reloaded.app, reloaded.controller);

  await app.skipTutorial();
  assert.equal(app.hintRemainingCount.value, 1, "reopening lessons must not grant extra hints");
  app.replayDocument.value = { config: settings, actions: [] };
  await app.handleStartReplay();
  assert.equal(app.replayMode.value, true);
  app.startTutorial();
  assert.equal(app.replayMode.value, false);
  assertFirstLesson(app, controller);
  await app.skipTutorial();
  assertRestored(app, controller);

  app.roomStatus.value = "inProgress";
  const onlineBoard = controller.engine.getSnapshot();
  app.startTutorial();
  assert.equal(openedTabs.length, 1);
  assert.equal(new URL(openedTabs[0][0]).searchParams.get("tutorial"), "1");
  assert.deepEqual(openedTabs[0].slice(1), ["_blank", "noopener"]);
  assert.equal(app.tutorialActive.value, false);
  assert.deepEqual(controller.engine.getSnapshot(), onlineBoard);
  assertSavedUntouched();

  const brokenSave = JSON.stringify(createLocalGameSession(settings, [{ type: "player_move", point: [99, 99] }]));
  values.set(LOCAL_GAME_SESSION_STORAGE_KEY, brokenSave);
  const broken = mountApp();
  assertFirstLesson(broken.app, broken.controller);
  assert.equal(await broken.app.skipTutorial(), true, "an invalid saved match must not trap the player in lessons");
  assert.equal(broken.app.tutorialActive.value, false);
  assert.equal(values.get(LOCAL_GAME_SESSION_STORAGE_KEY), brokenSave, "retain an invalid save until a new match is played");

  console.log("verify-tutorial-session: PASS (all startup histories, repeated entry, five lessons, saved board/settings/Superko, hints, reload, replay, online isolation, invalid-save fallback)");
} finally {
  for (const unmount of unmounts) unmount();
}
