import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { saveState, restoreState } from "../AIEngine.js";
import { MultiplayerMinimaxAI } from "../MultiplayerSearch.js";
import { loadMultiplayerRuntime } from "../MultiplayerRuntime.js";

const oldFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(input);
  assert.equal(url.protocol, "file:");
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
};
function terminalThreat(game) {
  for (let i = 1; i < game.playerCount; i++) {
    assert.equal(game.skipTurn().success, true);
    assert.equal(game.gameOver, false);
  }
}
function clone(source) {
  const game = new GameEngine({ gridSize: source.gridSize, playerCount: source.playerCount,
    boardShape: source.boardShape, initialPositions: source.initialPositions, startPlayer: source.startPlayer,
    rulesVersion: source.rulesVersion, deferTerritoryUpdates: true });
  restoreState(game, saveState(source)); game._isReplayingBatch = true; return game;
}
try {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/multiplayer-terminal-deadline.json", import.meta.url)));
  const game = new GameEngine({ ...fixture.settings, deferTerritoryUpdates: true }); game._isReplayingBatch = true;
  for (const action of fixture.actions) assert.equal((action === null ? game.skipTurn() : game.playMove(action)).success, true);
  assert.equal(fixture.actions.length, 128);
  terminalThreat(game);
  const before = saveState(game), runtime = await loadMultiplayerRuntime("multiplayer-hard-v1", game);
  const started = performance.now();
  const moves = runtime.ai.getTopMoves(game, game.currentPlayer, 5, { deadline: started + 3000 });
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 3300, `sample exceeded decision bound: ${elapsedMs}`);
  assert.ok(moves.length);
  for (const move of moves) {
    const trial = clone(game);
    assert.equal((move.point === null ? trial.skipTurn() : trial.playMove(move.point)).success, true);
  }
  assert.deepEqual(saveState(game), before);

  const small = new GameEngine({ gridSize: 5, playerCount: 4, rulesVersion: "territory-v2", deferTerritoryUpdates: true });
  small._isReplayingBatch = true;
  for (let i = 0; i < 10; i++) {
    const legal = small.getLegalMoves(); assert.ok(legal.length);
    assert.equal(small.playMove(legal[(i * 7 + 3) % legal.length].point).success, true);
  }
  terminalThreat(small);
  const final = clone(small); assert.equal(final.skipTurn().success, true); assert.equal(final.gameOver, true);
  final._updateTerritories();
  const areas = Object.fromEntries(final.activePlayers.map(player => [player, final.cachedTerritories[player].area]));
  const baseline = saveState(small), search = new MultiplayerMinimaxAI({ depth: 1, timeMs: 10000, exactScores: true });
  const ranked = search.getTopMoves(small, small.currentPlayer, 1000);
  const pass = ranked.find(move => move.point === null);
  assert.equal(search.lastSearch.completedDepth, 1); assert.ok(pass && pass.scoreBound === "exact");
  const max = Math.max(...Object.values(areas)), winners = final.activePlayers.filter(player => areas[player] === max);
  assert.equal(pass.score, winners.includes(small.currentPlayer) ? 100000 / winners.length : -100000);
  assert.deepEqual(saveState(small), baseline);
  console.log(JSON.stringify({ status: "PASS", complex: { moves: fixture.actions.length, elapsedMs,
    returned: moves.length, algorithm: runtime.ai.lastSearch.algorithm, timedOut: runtime.ai.lastSearch.timedOut },
    exactTerminal: { areas, passScore: pass.score, completedDepth: search.lastSearch.completedDepth },
    scope: "128-move current Hard runtime plus separate exact Minimax terminal parity; local file-backed assets" }));
} finally { globalThis.fetch = oldFetch; }
