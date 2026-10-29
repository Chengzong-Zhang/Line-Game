import assert from "node:assert/strict";
import { GameEngine, Player, PointState, RootMode, TerritoryRulesVersion } from "../GameEngine.js";

const options = (rootMode) => ({
  gridSize: 5,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V3,
  rootMode,
});

function connectFirstNode(engine, point = [1, 0]) {
  const result = engine.playMove(point);
  assert.equal(result.success, true, `setup move failed: ${result.reason}`);
  assert.equal(engine.skipTurn().success, true);
}

const relocate = new GameEngine(options(RootMode.RELOCATE));
connectFirstNode(relocate);
const oldRoot = relocate.getRoots(Player.BLACK)[0];
assert.equal(relocate.playRootAction("relocate", [1, 0]).success, true);
assert.deepEqual(relocate.getRoots(Player.BLACK), [[1, 0]]);
assert.equal(relocate.getStateAt(oldRoot), PointState.BLACK_NODE, "old root must remain an ordinary live node");
assert.equal(relocate.rootActionsRemaining.BLACK.relocate, 0);

const disconnected = new GameEngine(options(RootMode.RELOCATE));
disconnected.grid.set("2,2", PointState.BLACK_NODE);
const disconnectedBefore = disconnected._captureReplayState();
assert.equal(disconnected.playRootAction("relocate", [2, 2]).reason, "ROOT_TARGET_DISCONNECTED");
assert.deepEqual(disconnected._captureReplayState(), disconnectedBefore, "invalid relocation must be atomic");

const add = new GameEngine(options(RootMode.ADD));
connectFirstNode(add);
assert.equal(add.playRootAction("add", [1, 0]).success, true);
assert.deepEqual(add.getRoots(Player.BLACK), [[0, 0], [1, 0]]);
assert.equal(add.rootActionsRemaining.BLACK.add, 0);
assert.equal(add.skipTurn().success, true);
assert.equal(add.playRootAction("add", [1, 0]).reason, "ROOT_ACTION_EXHAUSTED");

const superko = new GameEngine(options(RootMode.ADD));
connectFirstNode(superko);
const beforeSuperko = superko._captureReplayState();
superko.roots.BLACK = [...superko.roots.BLACK.map((point) => [...point]), [1, 0]];
superko.rootActionsRemaining.BLACK.add -= 1;
const repeated = superko._computeStateHash(Player.WHITE);
superko._restoreReplayState(beforeSuperko);
superko.historyHashes.add(repeated);
const beforeAttempt = superko._captureReplayState();
assert.equal(superko.playRootAction("add", [1, 0]).reason, "SUPERKO_VIOLATION");
assert.deepEqual(superko._captureReplayState(), beforeAttempt, "Superko rejection must restore roots and quota");

const rootOnly = new GameEngine(options(RootMode.ADD));
rootOnly.grid.set("1,0", PointState.BLACK_NODE);
rootOnly.edges.BLACK.add(rootOnly._edgeKey([0, 0], [1, 0]));
rootOnly._hasValidMoves = () => false;
rootOnly._checkAndAutoSkip();
assert.equal(rootOnly.currentPlayer, Player.BLACK, "a legal root action must prevent automatic PASS");
assert.equal(rootOnly.consecutiveSkips, 0);
assert.deepEqual(rootOnly.getLegalRootActions(), [{ type: "root_add", point: [1, 0] }]);

console.log("verify-root-actions: PASS (relocate, add, disconnected target, Superko rollback and action-only turn)");
