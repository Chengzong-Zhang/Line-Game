import assert from "node:assert/strict";

import { MinimaxAI, saveState } from "../AIEngine.js";
import { GameEngine, Player } from "../GameEngine.js";

const settings = {
  gridSize: 15,
  playerCount: 2,
  boardShape: "diamond",
  rulesVersion: "territory-v3",
};
const expectedDepthTwo = new MinimaxAI(2).getTopMoves(new GameEngine(settings), Player.BLACK, 5);
const expectedDepthThree = new MinimaxAI(3).getTopMoves(new GameEngine(settings), Player.BLACK, 5);

// A very slow device still publishes a complete depth-2 ranking rather than
// being killed while trying to establish an unbounded depth-3 baseline.
const slowEngine = new GameEngine(settings);
const slowBefore = JSON.stringify(saveState(slowEngine));
let slowClockStarted = false;
const slow = new MinimaxAI(4, {
  iterativeDeepening: true,
  now: () => slowClockStarted ? 12_000 : (slowClockStarted = true, 0),
});
const slowActual = slow.getTopMoves(slowEngine, Player.BLACK, 5);
assert.deepEqual(slowActual, expectedDepthTwo, "an incomplete depth-3 iteration must preserve complete depth 2");
assert.equal(JSON.stringify(saveState(slowEngine)), slowBefore, "bounded search must not mutate the live position");
assert.equal(slow.lastSearch.completedDepth, 2);
assert.equal(slow.lastSearch.baseDepth, 2);
assert.deepEqual(slow.lastSearch.deeperIterations.map(({ depth, complete }) => ({ depth, complete })),
  [{ depth: 3, complete: false }]);

// On a normal device depth 3 completes, then an expired depth-4 iteration is
// discarded in full.  Drive the clock from the active iteration so this test
// remains deterministic on every CI machine.
const guardedEngine = new GameEngine(settings);
const before = JSON.stringify(saveState(guardedEngine));
let guarded, firstClockRead = true;
guarded = new MinimaxAI(4, {
  iterativeDeepening: true,
  now: () => firstClockRead ? (firstClockRead = false, 0) : guarded.depth === 4 ? 12_000 : 100,
});
const actual = guarded.getTopMoves(guardedEngine, Player.BLACK, 5);

assert.deepEqual(actual, expectedDepthThree, "an incomplete depth-4 iteration must preserve complete depth 3");
assert.equal(JSON.stringify(saveState(guardedEngine)), before, "bounded search must not mutate the live position");
assert.equal(guarded.lastSearch.requestedDepth, 4);
assert.equal(guarded.lastSearch.completedDepth, 3);
assert.equal(guarded.lastSearch.depth, 3);
assert.equal(guarded.lastSearch.baseDepth, 2);
assert.equal(guarded.lastSearch.largeDiamondGuard, true);
assert.equal(guarded.lastSearch.totalBudgetMs, 11_000);
assert.equal(guarded.lastSearch.extensionInterrupted, true);
assert.deepEqual(guarded.lastSearch.deeperIterations.map(({ depth, complete }) => ({ depth, complete })), [
  { depth: 3, complete: true },
  { depth: 4, complete: false },
]);

// Small diamonds retain the existing exact depth-4 semantics.
const small = new MinimaxAI(4, { iterativeDeepening: true });
small.getTopMoves(new GameEngine({ ...settings, gridSize: 5 }), Player.BLACK, 1);
assert.equal(small.lastSearch.depth, 4);
assert.equal(small.lastSearch.largeDiamondGuard, undefined);

console.log(JSON.stringify({
  status: "PASS",
  boardShape: "diamond",
  guardedFromSize: 9,
  requestedDepth: guarded.lastSearch.requestedDepth,
  completedDepth: guarded.lastSearch.completedDepth,
  slowDeviceCompletedDepth: slow.lastSearch.completedDepth,
  partialIterationPublished: false,
  smallDiamondExactDepthFour: true,
}));
