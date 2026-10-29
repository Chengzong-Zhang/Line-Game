import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sourceUrl = process.argv[2]
  ? pathToFileURL(process.argv[2])
  : new URL("../GameEngine.js", import.meta.url);
const source = await fs.readFile(sourceUrl, "utf8");
const { GameEngine, Player, PointState, TerritoryRulesVersion } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const make = (rulesVersion, options = {}) => new GameEngine({
  gridSize: 7, playerCount: 2, rulesVersion, ...options,
});
const key = (point) => point.join(",");
const pointKeys = (points) => points.map(key).sort();
const assertExactPoints = (actual, expected, message) => {
  assert.equal(new Set(pointKeys(actual)).size, actual.length, `${message}: duplicate point`);
  assert.deepEqual(pointKeys(actual), pointKeys(expected), message);
};

const oldOpen = make(TerritoryRulesVersion.V2);
const newOpen = make(TerritoryRulesVersion.V3);
assert.equal(oldOpen.getScoreboard()[Player.BLACK].area, 0);
assert.equal(Object.hasOwn(oldOpen.getScoreboard()[Player.BLACK], "renderPoints"), false);
assert.equal(newOpen.getScoreboard()[Player.BLACK].area, 1);
assert.equal(newOpen.getScoreboard()[Player.WHITE].area, 1);
for (const game of [oldOpen, newOpen]) {
  assert.equal(game.playMove([2, 0]).success, true);
}
assert.equal(oldOpen.getScoreboard()[Player.BLACK].area, 0);
assert.equal(newOpen.getScoreboard()[Player.BLACK].area, 3);
assert.equal(newOpen.getScoreboard()[Player.BLACK].polygon, null);
assert.equal(newOpen.getSnapshot().territories[Player.BLACK].area, 3);
const openTerritory = newOpen.getScoreboard()[Player.BLACK];
const openOwned = [...newOpen._getPlayerNodes(Player.BLACK), ...newOpen._getPlayerLines(Player.BLACK)];
assert.equal(openTerritory.area, openTerritory.renderPoints.length);
assertExactPoints(openTerritory.renderPoints, openOwned, "open-chain render points equal its owned wall points");

// Public snapshots own their point arrays. UI/cache consumers cannot mutate the
// live scoring cache through either array level.
const detachedSnapshot = newOpen.getSnapshot();
const cachedBeforeSnapshotMutation = structuredClone(newOpen.cachedTerritories[Player.BLACK]);
detachedSnapshot.territories[Player.BLACK].renderPoints[0][0] += 100;
detachedSnapshot.territories[Player.BLACK].renderPoints.push([3, 3]);
assert.deepEqual(newOpen.cachedTerritories[Player.BLACK], cachedBeforeSnapshotMutation);

// The six neighbors form a wall around the center point. That inner pocket
// counts as a donut hole unless an enemy occupies it; neither case needs a
// single selected contour for official scoring.
const donut = make(TerritoryRulesVersion.V3);
const hole = [3, 2];
const ring = donut.getAdjacentPositions(hole);
assert.equal(ring.length, 6);
assert.equal(donut._computeOwnedWallArea(ring, []), 7);
assert.equal(donut._computeOwnedWallArea(ring, [hole]), 6);
const safeDonut = donut._computeOwnedWallTerritory(ring, []);
const occupiedDonut = donut._computeOwnedWallTerritory(ring, [hole]);
assert.equal(safeDonut.area, safeDonut.renderPoints.length);
assertExactPoints(safeDonut.renderPoints, [...ring, hole], "enemy-free donut hole is rendered");
assert.equal(occupiedDonut.area, occupiedDonut.renderPoints.length);
assertExactPoints(occupiedDonut.renderPoints, ring, "enemy-occupied donut hole is excluded from rendering");

// Two enclosed components are evaluated independently. An enemy in one pocket
// removes only that component and leaves the other visible and counted.
const multiple = new GameEngine({ gridSize: 9, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3 });
const pocketCenters = [[2, 2], [5, 2]];
const pocketWalls = [];
const pocketWallKeys = new Set();
for (const center of pocketCenters) {
  for (const point of multiple.getAdjacentPositions(center)) {
    if (pocketWallKeys.has(key(point))) continue;
    pocketWallKeys.add(key(point));
    pocketWalls.push(point);
  }
}
const bothPockets = multiple._computeOwnedWallTerritory(pocketWalls, []);
assert.equal(bothPockets.area, pocketWalls.length + 2);
assert.equal(bothPockets.area, bothPockets.renderPoints.length);
assertExactPoints(bothPockets.renderPoints, [...pocketWalls, ...pocketCenters], "both safe pockets render");
const oneOccupiedPocket = multiple._computeOwnedWallTerritory(pocketWalls, [pocketCenters[0]]);
assert.equal(oneOccupiedPocket.area, pocketWalls.length + 1);
assert.equal(oneOccupiedPocket.area, oneOccupiedPocket.renderPoints.length);
assertExactPoints(oneOccupiedPocket.renderPoints, [...pocketWalls, pocketCenters[1]], "only safe pocket renders");

// The public score counts all owned points plus enemy-free pockets even when
// the wall has no selected contour. The initialized BLACK base contributes
// one additional owned point beyond the six ring points.
for (const point of ring) donut._setState(point, PointState.BLACK_LINE);
donut._updateTerritories();
assert.equal(donut.getScoreboard()[Player.BLACK].polygon, null);
assert.equal(donut.getScoreboard()[Player.BLACK].area, 8);
assert.equal(donut.getScoreboard()[Player.BLACK].renderPoints.length, 8);
assert.ok(donut.getScoreboard()[Player.BLACK].renderPoints.some((point) => key(point) === key(hole)));
donut._setState(hole, PointState.WHITE_NODE);
donut._updateTerritories();
assert.equal(donut.getScoreboard()[Player.BLACK].area, 7);
assert.equal(donut.getScoreboard()[Player.BLACK].renderPoints.length, 7);
assert.equal(donut.getScoreboard()[Player.BLACK].renderPoints.some((point) => key(point) === key(hole)), false);

// Revision-checked Worker caches require exact v3 render data and clone it on
// admission, while v1/v2 retain their old polygon-only contract.
const cacheProbe = make(TerritoryRulesVersion.V3);
const validCache = cacheProbe.getScoreboard();
assert.equal(cacheProbe.applyTerritoryCache(validCache, cacheProbe.getTerritoryStateRevision()), true);
const admittedPoint = structuredClone(cacheProbe.cachedTerritories[Player.BLACK].renderPoints[0]);
validCache[Player.BLACK].renderPoints[0][0] += 100;
assert.deepEqual(cacheProbe.cachedTerritories[Player.BLACK].renderPoints[0], admittedPoint);
for (const corrupt of [
  (territories) => { delete territories[Player.BLACK].renderPoints; },
  (territories) => { territories[Player.BLACK].renderPoints.push([...territories[Player.BLACK].renderPoints[0]]); territories[Player.BLACK].area += 1; },
  (territories) => { territories[Player.BLACK].renderPoints = []; },
  (territories) => { territories[Player.BLACK].renderPoints[0][0] = String(territories[Player.BLACK].renderPoints[0][0]); },
]) {
  const candidate = cacheProbe.getScoreboard();
  corrupt(candidate);
  const before = structuredClone(cacheProbe.cachedTerritories);
  assert.equal(cacheProbe.applyTerritoryCache(candidate, cacheProbe.getTerritoryStateRevision()), false);
  assert.deepEqual(cacheProbe.cachedTerritories, before);
}

// This is a scoring fixture, not a legal move sequence. It reproduces a
// three-point open chain for Cyan without claiming a three-point-rule proof.
for (const version of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
  const game = new GameEngine({ gridSize: 5, playerCount: 6, rulesVersion: version });
  const cyan = game.initialPositions[Player.CYAN];
  const available = game.getAdjacentPositions(cyan).filter((point) =>
    game._getState(point) === PointState.EMPTY);
  const pair = available.flatMap((left) => available.filter((right) =>
    Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]),
      Math.abs(left[0] + left[1] - right[0] - right[1])) > 1).map((right) => [left, right]))[0];
  assert.ok(pair);
  game._setState(pair[0], PointState.CYAN_LINE);
  game._setState(pair[1], PointState.CYAN_NODE);
  game._updateTerritories();
  assert.equal(game.getScoreboard()[Player.CYAN].area, version === TerritoryRulesVersion.V3 ? 3 : 0);
}

const moves = [[1, 0], [5, 1], [4, 0], [2, 1], [0, 5],
  [2, 3], [1, 2], [1, 4], [0, 3], [0, 4]];
const closedOld = make(TerritoryRulesVersion.V2);
const closedNew = make(TerritoryRulesVersion.V3);
for (const [index, move] of moves.entries()) {
  assert.equal(closedOld.playMove(move).success, true);
  try {
    assert.equal(closedNew.playMove(move).success, true);
  } catch (error) {
    throw new Error(`v3 move ${index + 1}: ${error.message}`);
  }
}
for (const player of closedNew.activePlayers) {
  const territory = closedNew.getScoreboard()[player];
  const owned = [
    ...closedNew._getPlayerNodes(player),
    ...closedNew._getPlayerLines(player),
  ];
  const enemies = closedNew._getOpponents(player).flatMap((opponent) => [
    ...closedNew._getPlayerNodes(opponent),
    ...closedNew._getPlayerLines(opponent),
  ]);
  const expected = closedNew._computeOwnedWallArea(owned, enemies);
  assert.equal(territory.area, expected);
}
assert.equal(closedNew.skipTurn().success, true);
assert.equal(closedNew.skipTurn().success, true);
assert.equal(closedNew.getSnapshot().gameOver, true);
if (!process.argv[2]) {
  const { saveState } = await import("../AIEngine.js");
  const searchSnapshot = saveState(newOpen);
  const liveBeforeSearchSnapshotMutation = structuredClone(newOpen.cachedTerritories[Player.BLACK]);
  searchSnapshot.cachedTerritories[Player.BLACK].renderPoints[0][0] += 100;
  searchSnapshot.cachedTerritories[Player.BLACK].renderPoints.push([3, 3]);
  assert.deepEqual(newOpen.cachedTerritories[Player.BLACK], liveBeforeSearchSnapshotMutation,
    "AI search snapshots must own their render-point arrays");

  const { createReplayDocument, validateReplayDocument } = await import("../ReplayCodec.js");
  for (const version of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
    const settings = { gridSize: 7, playerCount: 2, startPlayer: Player.BLACK, rulesVersion: version };
    const document = await createReplayDocument(settings, [{ type: "skip" }, { type: "skip" }]);
    assert.equal(document.rulesVersion, version);
    const verified = await validateReplayDocument(document);
    assert.equal(verified.success, true);
    assert.equal(document.terminal.scores[Player.BLACK].area, version === TerritoryRulesVersion.V3 ? 1 : 0);
  }
}
console.log("territory-v3 open, closed, Cyan and terminal scoring: PASS");
