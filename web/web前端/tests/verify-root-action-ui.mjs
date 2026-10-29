import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import GameController from "../GameController.js";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";

const noop = () => {};
function controllerFor(rootMode) {
  const settings = { gridSize: 9, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3, rootMode };
  const engine = new GameEngine(settings);
  return Object.assign(Object.create(GameController.prototype), {
    canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine,
    renderer: { invalidate: noop }, _engineEpoch: 0,
    _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, _syncSnapshot: noop,
    _emitStateChange: noop, _emitActionFeedback: noop, _setLastAction: GameController.prototype._setLastAction,
    multiplayerEnabled: false, localPlayer: null, roomReady: false, opponentConnected: false,
    lastAction: null, lastMoves: {},
  });
}

for (const rootMode of [RootMode.RELOCATE, RootMode.ADD]) {
  const controller = controllerFor(rootMode);
  assert.equal(controller._applyMove([1, 0], "BLACK").success, true);
  assert.equal(controller._applyMove([7, 0], "WHITE").success, true);
  const available = controller.getGameState().legalRootActions;
  assert.ok(available.some((action) => action.point.join() === "1,0"));
  const beforeInvalid = controller.engine._captureReplayState();
  assert.equal(controller.playRootAction(rootMode, [8, 0]).success, false);
  assert.deepEqual(controller.engine._captureReplayState(), beforeInvalid, "an illegal UI request must not partially mutate the match");
  const result = controller.playRootAction(rootMode, [1, 0]);
  assert.equal(result.success, true);
  assert.equal(result.state.currentPlayer, "WHITE");
  assert.equal(result.state.turnCount, 3, "the root operation consumes exactly one full turn");
  assert.equal(result.state.rootActionsRemaining.BLACK[rootMode], 0);
  assert.equal(controller.lastAction.type, `root_${rootMode}`);
  assert.deepEqual(result.state.roots.BLACK, rootMode === RootMode.ADD ? [[0, 0], [1, 0]] : [[1, 0]]);
}

const appSource = await readFile(new URL("../OnlineApp.js", import.meta.url), "utf8");
assert.match(appSource, /rootRelocate:\s*["']迁移起点["']/);
assert.match(appSource, /rootAdd:\s*["']增设起点["']/);
assert.match(appSource, /event\.type === ["']root_relocate["']/);
assert.match(appSource, /event\.type === ["']root_add["']/);
const styleSource = await readFile(new URL("../styles.css", import.meta.url), "utf8");
assert.match(appSource, /root-action-panel/);
assert.match(appSource, /uses the turn/);
assert.match(appSource, /illegal action does not consume the quota/);
assert.match(styleSource, /root-action-targets \.action-button \{ min-height: 44px/);

console.log("verify-root-action-ui: PASS (legal targets, atomic failure, full-turn quota and mobile-sized controls)");
