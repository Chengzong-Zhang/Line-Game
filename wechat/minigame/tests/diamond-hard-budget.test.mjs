import test from 'node:test';
import assert from 'node:assert/strict';

import { sut, plain } from './helpers.mjs';

test('large diamond Hard publishes only the deepest complete iteration within its Worker budget', () => {
  const settings = { gridSize: 9, playerCount: 2, boardShape: 'diamond', rulesVersion: 'territory-v3' };
  const expectedDepthTwo = new sut.MinimaxAI(2).getTopMoves(new sut.GameEngine(settings), 'BLACK', 5);
  const expectedDepthThree = new sut.MinimaxAI(3).getTopMoves(new sut.GameEngine(settings), 'BLACK', 5);

  const slowEngine = new sut.GameEngine(settings), slowBefore = plain(sut.ruleView(slowEngine));
  let slowClockStarted = false;
  const slow = new sut.MinimaxAI(4, { iterativeDeepening: true,
    now: () => slowClockStarted ? 12_000 : (slowClockStarted = true, 0) });
  assert.deepEqual(plain(slow.getTopMoves(slowEngine, 'BLACK', 5)), plain(expectedDepthTwo));
  assert.deepEqual(plain(sut.ruleView(slowEngine)), slowBefore);
  assert.equal(slow.lastSearch.completedDepth, 2);
  assert.deepEqual(plain(slow.lastSearch.deeperIterations.map(({ depth, complete }) => ({ depth, complete }))),
    [{ depth: 3, complete: false }]);

  const engine = new sut.GameEngine(settings), before = plain(sut.ruleView(engine));
  const beforeRevision = engine.positionRevision, beforeHistory = [...engine.historyHashes];
  let ai, firstClockRead = true;
  ai = new sut.MinimaxAI(4, { iterativeDeepening: true,
    now: () => firstClockRead ? (firstClockRead = false, 0) : ai.depth === 4 ? 12_000 : 100 });
  const actual = ai.getTopMoves(engine, 'BLACK', 5);

  assert.deepEqual(plain(actual), plain(expectedDepthThree));
  assert.deepEqual(plain(sut.ruleView(engine)), before);
  assert.equal(engine.positionRevision, beforeRevision);
  assert.deepEqual([...engine.historyHashes], beforeHistory);
  assert.equal(ai.lastSearch.requestedDepth, 4);
  assert.equal(ai.lastSearch.completedDepth, 3);
  assert.equal(ai.lastSearch.depth, 3);
  assert.equal(ai.lastSearch.baseDepth, 2);
  assert.equal(ai.lastSearch.largeDiamondGuard, true);
  assert.equal(ai.lastSearch.totalBudgetMs, 11_000);
  assert.equal(ai.lastSearch.extensionInterrupted, true);
  assert.deepEqual(plain(ai.lastSearch.deeperIterations.map(({ depth, complete }) => ({ depth, complete }))), [
    { depth: 3, complete: true },
    { depth: 4, complete: false },
  ]);
});
