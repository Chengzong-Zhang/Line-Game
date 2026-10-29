import assert from "node:assert/strict";
import GameEngine, {
  Player, PointState, RootMode, RootRulesVersion, TerritoryRulesVersion, resolveInitialRoots,
} from "../GameEngine.js";

const pointKey = (point) => point.join(",");

function putEdge(engine, player, a, b) {
  const states = engine._getPlayerStates(player);
  for (const point of engine.getLinePoints(a, b)) {
    engine._setState(point, pointKey(point) === pointKey(a) || pointKey(point) === pointKey(b) ? states.node : states.line);
  }
  engine.edges[player].add(engine._edgeKey(a, b));
}

for (const boardShape of ["triangle", "hexagon"]) {
  for (const gridSize of [5, 9, 15]) {
    const roots = resolveInitialRoots(gridSize, 2, null, boardShape, RootMode.FIXED_DOUBLE);
    const engine = new GameEngine({ gridSize, playerCount: 2, boardShape, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.FIXED_DOUBLE });
    assert.deepEqual(engine.initialRoots, roots);
    assert.equal(engine.rootRulesVersion, RootRulesVersion.V2);
    assert.equal(engine.getScoreboard().BLACK.area, 2);
    assert.equal(engine.getScoreboard().WHITE.area, 2);
    assert.ok(engine.getLegalMoves(Player.BLACK).length > 0, `${boardShape}/${gridSize} BLACK needs an opening`);
  }
}

const explicitRoots = {
  BLACK: [[0, 0], [2, 2]],
  WHITE: [[8, 0], [5, 2]],
};
const split = new GameEngine({
  gridSize: 9, playerCount: 2, boardShape: "triangle", rulesVersion: TerritoryRulesVersion.V3,
  rootMode: RootMode.FIXED_DOUBLE, initialRoots: explicitRoots,
});
putEdge(split, Player.BLACK, [0, 0], [0, 2]);
putEdge(split, Player.BLACK, [2, 2], [4, 2]);
split._setState([1, 5], PointState.BLACK_NODE);
split._setState([1, 0], PointState.BLACK_NODE); // visual neighbour, no logical edge
let alive = split._getOpponentConnectedPieces(Player.BLACK);
for (const point of [[0, 0], [0, 1], [0, 2], [2, 2], [3, 2], [4, 2]]) assert.ok(alive.has(pointKey(point)));
for (const point of [[1, 5], [1, 0]]) assert.ok(!alive.has(pointKey(point)));
split._setState([0, 1], PointState.EMPTY);
alive = split._getOpponentConnectedPieces(Player.BLACK);
assert.ok(!split.edges.BLACK.has(split._edgeKey([0, 0], [0, 2])));
assert.ok(!alive.has("0,2"));
assert.ok(alive.has("0,0") && alive.has("2,2") && alive.has("4,2"));

const relocate = new GameEngine({ gridSize: 9, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.RELOCATE });
putEdge(relocate, Player.BLACK, relocate.getRoots(Player.BLACK)[0], [2, 0]);
const beforeRelocate = relocate._computeStateHash(Player.WHITE);
assert.equal(relocate.playRootAction("relocate", [2, 0]).success, true);
assert.deepEqual(relocate.getRoots(Player.BLACK), [[2, 0]]);
assert.equal(relocate.rootActionsRemaining.BLACK.relocate, 0);
assert.notEqual(relocate._computeStateHash(relocate.currentPlayer), beforeRelocate);
assert.equal(relocate.getStateAt([0, 0]), PointState.BLACK_NODE);

const add = new GameEngine({ gridSize: 9, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.ADD });
putEdge(add, Player.BLACK, add.getRoots(Player.BLACK)[0], [2, 0]);
add._updateTerritories();
const areaBeforeAdd = add.getScoreboard().BLACK.area;
assert.equal(add.playRootAction("add", [2, 0]).success, true);
assert.deepEqual(add.getRoots(Player.BLACK), [[0, 0], [2, 0]]);
assert.equal(add.getScoreboard().BLACK.area, areaBeforeAdd, "root identity alone must not add a point");

const rootOnly = new GameEngine({ gridSize: 9, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.ADD });
putEdge(rootOnly, Player.BLACK, rootOnly.getRoots(Player.BLACK)[0], [2, 0]);
rootOnly._hasValidMoves = () => false;
assert.equal(rootOnly._hasAnyNonPassAction(Player.BLACK), true);
const identityBefore = JSON.stringify(rootOnly._captureReplayState(), (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value);
const invalid = rootOnly.playRootAction("add", [8, 0]);
assert.equal(invalid.success, false);
const identityAfter = JSON.stringify(rootOnly._captureReplayState(), (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value);
assert.equal(identityAfter, identityBefore, "illegal action must be atomic");

const classic = new GameEngine({ gridSize: 9, rulesVersion: TerritoryRulesVersion.V3 });
assert.equal(classic.rootRulesVersion, RootRulesVersion.V1);
assert.equal(classic.rootMode, RootMode.CLASSIC);
assert.deepEqual(classic.getRoots(Player.BLACK), [[0, 0]]);

console.log("verify-multi-start-rules: PASS (layouts, split roots, logical edges, protection, actions, identity, legacy)");
