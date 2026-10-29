import assert from 'node:assert/strict';
import { GameEngine } from '../GameEngine.js';
import { MinimaxAI, saveState } from '../AIEngine.js';
const settings = { gridSize: 5, playerCount: 2, boardShape: 'triangle', rulesVersion: 'territory-v3' };
function position() {
  const engine = new GameEngine(settings);
  for (const point of [[0, 2], [1, 3], [0, 3], [3, 1]]) assert.equal(engine.playMove(point).success, true);
  return engine;
}
const reference = position(), expected = new Map();
for (const depth of [4, 6]) {
  const ai = new MinimaxAI(depth), before = saveState(reference);
  expected.set(depth, ai.getTopMoves(reference, reference.currentPlayer, 5));
  assert.equal(ai.lastSearch.depth, depth);
  assert.equal(ai.lastSearch.completedDepth, depth);
  assert.deepEqual(saveState(reference), before);
}
const complete = position(), before = saveState(complete);
const ai = new MinimaxAI(4, { iterativeDeepening: true, now: () => 0 });
assert.deepEqual(ai.getTopMoves(complete, complete.currentPlayer, 5), expected.get(6));
assert.equal(ai.depth, 4); assert.equal(ai.lastSearch.baseDepth, 4);
assert.equal(ai.lastSearch.completedDepth, 6);
assert.deepEqual(ai.lastSearch.deeperIterations.map(x => [x.depth, x.complete]), [[5, true], [6, true]]);
assert.deepEqual(saveState(complete), before);
for (const expireAt of [2, 8, 40]) {
  const engine = position(), initial = saveState(engine); let ticks = 0;
  const interrupted = new MinimaxAI(4, { iterativeDeepening: true, now: () => ++ticks >= expireAt ? 1000 : 0 });
  assert.deepEqual(interrupted.getTopMoves(engine, engine.currentPlayer, 5), expected.get(4));
  assert.equal(interrupted.depth, 4); assert.equal(interrupted.lastSearch.completedDepth, 4);
  assert.equal(interrupted.lastSearch.extensionInterrupted, true);
  assert.equal(interrupted.lastSearch.deeperIterations.at(-1).complete, false);
  assert.deepEqual(saveState(engine), initial);
}
const expiring = position(), original = saveState(expiring);
const bounded = new MinimaxAI(4, { iterativeDeepening: true });
bounded.getTopMoves(expiring, expiring.currentPlayer, 5, { deadline: performance.now() - 1 });
assert.equal(bounded.lastSearch.partial, true); assert.equal(bounded.lastSearch.completedDepth, 0);
assert.equal(bounded.lastSearch.deeperIterations, undefined); assert.deepEqual(saveState(expiring), original);
console.log('verify-classic-minimax-complete-iterations: PASS (complete 4/5/6, interrupted iteration discarded, explicit deadline and state restoration)');
