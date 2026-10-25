import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { saveState } from "../AIEngine.js?v=20261025-room1";
import { isolatedSearchEngine } from "../MultiplayerSearch.js?v=20261025-room1";

const originalFetch = globalThis.fetch;
globalThis.fetch = async input => new Response(await readFile(fileURLToPath(input instanceof URL ? input : new URL(input))));
const { loadMultiplayerRuntime } = await import("../MultiplayerRuntime.js?v=20261025-room1");

function nativeAreas(engine) {
  GameEngine.prototype._updateTerritories.call(engine);
  return Object.fromEntries(engine.activePlayers.map(player => [player, engine.cachedTerritories[player].area]));
}

function bestAreaMove(engine, player) {
  let best = null;
  for (const move of engine.getLegalMoves(player)) {
    const trial = isolatedSearchEngine(engine);
    assert.equal(trial.playMove(move.point).success, true);
    const area = nativeAreas(trial)[player];
    if (!best || area > best.area || area === best.area && (move.point[1] < best.point[1]
      || move.point[1] === best.point[1] && move.point[0] < best.point[0])) best = { point: move.point, area };
  }
  assert.ok(best, "Winning fixture needs a legal move");
  return best.point;
}

function advanceOtherPlayers(engine, actor) {
  while (!engine.gameOver && engine.currentPlayer !== actor) assert.equal(engine.skipTurn().success, true);
}

function winningFixture(playerCount, rulesVersion) {
  const engine = new GameEngine({ playerCount, gridSize: 5, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  const actor = engine.currentPlayer;
  for (let round = 0; round < 4; round += 1) {
    assert.equal(engine.currentPlayer, actor);
    assert.equal(engine.playMove(bestAreaMove(engine, actor)).success, true);
    advanceOtherPlayers(engine, actor);
    assert.equal(engine.consecutiveSkips, playerCount - 1);
    const terminal = isolatedSearchEngine(engine);
    assert.equal(terminal.skipTurn().success, true);
    nativeAreas(terminal);
    if (terminal.getWinner() === actor) return engine;
  }
  assert.fail("Could not build a unique terminal winner");
}

function drawFixture(playerCount, rulesVersion) {
  const engine = new GameEngine({ playerCount, gridSize: 5, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (let index = 1; index < playerCount; index += 1) assert.equal(engine.skipTurn().success, true);
  assert.equal(engine.consecutiveSkips, playerCount - 1);
  return engine;
}

const cases = [];
try {
  for (const rulesVersion of ["territory-v2", "territory-v3"]) for (const playerCount of [3, 4, 5, 6]) {
    for (const modelId of ["multiplayer-easy-v1", "multiplayer-medium-v1"]) {
      const winning = winningFixture(playerCount, rulesVersion);
      const player = winning.currentPlayer;
      assert.ok(winning.getLegalMoves(player).length > 0, "PASS gate must be voluntary");
      const beforeWin = saveState(winning);
      const winningRuntime = await loadMultiplayerRuntime(modelId, winning);
      const winningMoves = winningRuntime.ai.getTopMoves(winning, player, 5);
      assert.deepEqual(winningMoves, [{ type: "pass", point: null, score: 1, prior: 1, visits: 1,
        evaluation: "canonical-terminal-unique-win" }]);
      assert.equal(winningRuntime.ai.lastSearch.algorithm, "canonical-terminal-unique-win");
      assert.deepEqual(saveState(winning), beforeWin, "Winning PASS analysis must preserve source state");

      const draw = drawFixture(playerCount, rulesVersion);
      assert.ok(draw.getLegalMoves(draw.currentPlayer).length > 0);
      const terminalDraw = isolatedSearchEngine(draw);
      assert.equal(terminalDraw.skipTurn().success, true);
      nativeAreas(terminalDraw);
      assert.equal(terminalDraw.getWinner(), "DRAW");
      const beforeDraw = saveState(draw);
      const drawRuntime = await loadMultiplayerRuntime(modelId, draw);
      const drawMoves = drawRuntime.ai.getTopMoves(draw, draw.currentPlayer, 1);
      assert.equal(drawMoves.length, 1);
      assert.ok(Array.isArray(drawMoves[0].point), "A draw must fall through to the original placement policy");
      assert.deepEqual(saveState(draw), beforeDraw, "Rejected PASS gate must preserve source state");
      cases.push({ rulesVersion, playerCount, modelId, uniqueWinningPass: true, drawFallsThrough: true });
    }
  }
  console.log(JSON.stringify({ status: "PASS_MULTIPLAYER_SAFE_PASS", cases: cases.length }));
} finally {
  globalThis.fetch = originalFetch;
}
