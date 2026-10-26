// Independent scalar-winner parity. No training, long games or timing claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GameEngine, PLAYER_ORDER, getBoardPositions, PointState } from "../GameEngine.js";
const sha = value => createHash("sha256").update(value).digest("hex");
const initialAIHash = sha(await readFile(new URL("../AIEngine.js", import.meta.url)));
const { MinimaxAI, saveState, restoreState } = await import(`../AIEngine.js?scalar-area-audit=${initialAIHash}`);

const { GameEngine: QueryEngine } = await import("../GameEngine.js?independent-terminal-area-v1");
assert.notEqual(QueryEngine.prototype.getWinner, GameEngine.prototype.getWinner);
assert.equal(Function.prototype.toString.call(QueryEngine.prototype.getWinner),
  Function.prototype.toString.call(GameEngine.prototype.getWinner));
const versions = ["territory-v1", "territory-v2", "territory-v3"];
const ai = new MinimaxAI(1), rows = [];

function settings(seats, shape, rulesVersion, gridSize = seats === 15 ? 7 : 5) {
  const value = { gridSize, playerCount: seats, boardShape: shape, rulesVersion, deferTerritoryUpdates: true };
  if (seats > 6) {
    const points = getBoardPositions(gridSize, seats, shape);
    value.initialPositions = Object.fromEntries(PLAYER_ORDER.slice(0, seats).map((player, index) =>
      [player, points[Math.floor(index * points.length / seats)]]));
    value.startingPointMode = "custom";
  }
  return value;
}
function isolate(engine) {
  const copy = new engine.constructor({ gridSize: engine.gridSize, playerCount: engine.playerCount,
    boardShape: engine.boardShape, rulesVersion: engine.rulesVersion, initialPositions: engine.initialPositions,
    startPlayer: engine.startPlayer, deferTerritoryUpdates: true });
  copy._restoreReplayState(engine._captureReplayState()); copy._isReplayingBatch = true;
  return copy;
}
function finish(engine) {
  let passes = 0;
  while (!engine.gameOver) {
    assert.ok(++passes <= engine.playerCount + 1, "Canonical consecutive PASS must terminate");
    assert.equal(engine.skipTurn().success, true);
  }
}
function state(engine) {
  // Do not call getSnapshot(): it would refresh the cache under test.
  return { rule: saveState(engine), replay: engine._captureReplayState(),
    initialPositions: structuredClone(engine.initialPositions), activePlayers: [...engine.activePlayers],
    pending: engine.hasPendingTerritoryUpdate(), replayFlag: engine._isReplayingBatch,
    winnerMethod: engine.getWinner, updater: engine._updateTerritories };
}
function parity(engine, id, { synthetic = false, custom = false } = {}) {
  assert.equal(engine.gameOver, true);
  // Match the real compact Worker case: native board/history are present but
  // display cache revision is unknown, so it must remain stale after v3 scalar evaluation.
  engine._territoryCacheRevision = -1;
  const oracle = isolate(engine), expectedWinner = oracle.getWinner();
  const expectedAreas = Object.fromEntries(oracle.activePlayers.map(player => [player, oracle.cachedTerritories[player].area]));
  const originalUpdater = engine._updateTerritories; let updateCalls = 0;
  if (engine.rulesVersion === "territory-v3" && !custom) {
    engine._updateTerritories = () => { throw Error("Scalar native v3 winner attempted display refresh"); };
  } else engine._updateTerritories = function (...args) { updateCalls++; return originalUpdater.apply(this, args); };
  try {
    for (const player of engine.activePlayers) {
      const before = state(engine), saved = saveState(engine);
      const cacheObject = engine.cachedTerritories, territoryObjects = engine.activePlayers.map(actor => engine.cachedTerritories[actor]);
      const actual = ai.evaluate(engine, player);
      assert.equal(actual, expectedWinner === "DRAW" ? 0 : expectedWinner === player ? 1_000_000 : -1_000_000,
        `${id}/${player}: scalar winner disagrees with isolated canonical getWinner`);
      if (engine.rulesVersion === "territory-v3" && !custom) {
        assert.deepEqual(state(engine), before, `${id}: native v3 must not change any rule/cache/replay state`);
        assert.equal(engine.cachedTerritories, cacheObject, "V3 scalar winner must preserve the cache object identity");
        for (const [index, actor] of engine.activePlayers.entries()) assert.equal(engine.cachedTerritories[actor], territoryObjects[index]);
      } else {
        restoreState(engine, saved);
        assert.deepEqual(state(engine), before, `${id}: bracketing legacy/custom winner must restore complete state`);
      }
    }
  } finally { engine._updateTerritories = originalUpdater; }
  rows.push({ id, rulesVersion: engine.rulesVersion, seats: engine.playerCount, shape: engine.boardShape,
    winner: expectedWinner, areas: expectedAreas, staleCachePreserved: engine.rulesVersion === "territory-v3" && !custom,
    legacyOrCustomUpdaterCalls: updateCalls, syntheticScoringState: synthetic, resignedPlayers: [...engine.resignedPlayers] });
}

for (const [moduleName, Engine] of [["no-query", GameEngine], ["query", QueryEngine]]) {
  for (const rulesVersion of versions) for (const shape of ["triangle", "hexagon"]) for (const seats of [2, 3, 6, 15]) {
    const engine = new Engine(settings(seats, shape, rulesVersion)); engine._isReplayingBatch = true;
    let legalPrefix = 0;
    for (let count = 0; count < 2 && !engine.gameOver; count++) {
      const move = engine.getLegalMoves()[0];
      if (!move) break;
      assert.equal(engine.playMove(move.point).success, true); legalPrefix++;
    }
    finish(engine); engine._isReplayingBatch = false;
    parity(engine, `${moduleName}/${rulesVersion}/${shape}/${seats}/natural-prefix-${legalPrefix}`);
  }
  for (const rulesVersion of versions) {
    const tie = new Engine(settings(2, "triangle", rulesVersion)); tie._isReplayingBatch = true; finish(tie);
    assert.equal(isolate(tie).getWinner(), "DRAW"); parity(tie, `${moduleName}/${rulesVersion}/natural-tie`);
    const resigned = new Engine(settings(3, "triangle", rulesVersion)); resigned._isReplayingBatch = true;
    assert.equal(resigned.resignPlayer("BLACK").success, true); finish(resigned);
    parity(resigned, `${moduleName}/${rulesVersion}/resignation`);
  }
  const closed = new Engine(settings(2, "triangle", "territory-v3", 7)); closed._isReplayingBatch = true;
  for (const point of [[1, 0], [5, 1], [4, 0], [2, 1], [0, 5], [2, 3], [1, 2], [1, 4], [0, 3], [0, 4]])
    assert.equal(closed.playMove(point).success, true, "Canonical closed-area prefix");
  finish(closed); parity(closed, `${moduleName}/v3/canonical-closed-area`);
  for (const enemyInPocket of [false, true]) {
    const ring = new Engine(settings(2, "triangle", "territory-v3", 7));
    const center = [3, 2];
    for (const point of ring.getAdjacentPositions(center)) ring._setState(point, PointState.BLACK_LINE);
    if (enemyInPocket) ring._setState(center, PointState.WHITE_NODE);
    ring.gameOver = true;
    parity(ring, `${moduleName}/v3/synthetic-ring-enemy-${enemyInPocket}`, { synthetic: true });
  }
  const custom = new Engine(settings(2, "triangle", "territory-v3")); custom.gameOver = true;
  let calls = 0;
  custom.getWinner = function ownCustomWinner() { calls++; return "WHITE"; };
  const before = saveState(custom);
  assert.equal(ai.evaluate(custom, "BLACK"), -1_000_000); assert.equal(ai.evaluate(custom, "WHITE"), 1_000_000);
  assert.equal(calls, 2, "Custom own getWinner must remain authoritative"); assert.deepEqual(saveState(custom), before);
  rows.push({ id: `${moduleName}/v3/custom-own-getWinner`, expectedCalls: 2, calls, customWinnerPreserved: true });
}

// When the native cache is already current, preserve its exact object/cache
// contract too; the optimized stale-cache branch must not rewrite that cache.
const clean = new GameEngine(settings(2, "triangle", "territory-v3")); clean.gameOver = true;
clean.getWinner(); const cleanBefore = state(clean);
assert.equal(ai.evaluate(clean, "BLACK"), 0); assert.deepEqual(state(clean), cleanBefore);
const hashes = Object.fromEntries(await Promise.all(["../AIEngine.js", "../GameEngine.js"].map(async name =>
  [name, sha(await readFile(new URL(name, import.meta.url)))])));
assert.equal(hashes["../AIEngine.js"], initialAIHash, "AI source changed during scalar parity checks");
console.log(JSON.stringify({ status: "PASS_MINIMAX_TERMINAL_AREA_PARITY", cases: rows.length + 1,
  queryMethodIdentityDistinct: true, nativeQueryFunctionSourceIdentical: true, rows, cleanCacheUnchanged: true,
  sourceHashes: hashes, scope: "Native getWinner parity on isolated full-state engines; v1/v2/v3, 2/3/6/15 seats, triangle/hexagon, canonical prefixes/PASS/ties/resignation, explicitly synthetic ring scoring probes, stale display cache and custom winner dispatch. No one-second guarantee, training or playing-strength claim." }));
