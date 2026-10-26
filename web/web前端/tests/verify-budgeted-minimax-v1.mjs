// Bounded orchestration/native parity checks, not a strength or phone benchmark.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GameEngine } from '../GameEngine.js';
import { MinimaxAI, saveState } from '../AIEngine.js';
import { BudgetedMinimaxAI } from '../BudgetedMinimaxAI.js';

const groups = [], rows = [], key = point => point === null ? 'PASS' : point.join(',');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(await readFile(new URL('../AIEngine.js', import.meta.url)));
const test = (name, work) => { work(); groups.push(name); };
function position(options = {}, prefix = []) {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, boardShape: 'triangle',
    rulesVersion: 'territory-v3', deferTerritoryUpdates: true, ...options });
  engine._isReplayingBatch = true;
  for (const point of prefix) assert.equal((point === null ? engine.skipTurn() : engine.playMove(point)).success, true);
  engine._isReplayingBatch = false;
  return engine;
}
const tactical = () => position({}, [[0, 2], [1, 3], [0, 3], [3, 1]]);
function capture(engine) {
  const snapshot = engine.getSnapshot();
  return { snapshot, rules: saveState(engine), replay: engine._captureReplayState(),
    custom: engine.hasCustomInitialPositions, replayFlag: engine._isReplayingBatch,
    playMove: engine.playMove, skipTurn: engine.skipTurn, autoSkip: engine._checkAndAutoSkip,
    lastMove: engine.lastMove, lastMoves: engine.lastMoves, lastAction: engine.lastAction };
}
function legal(source, moves) {
  assert.ok(moves.length);
  const keys = new Set(source.getLegalMoves().map(({ point }) => key(point)));
  assert.ok(moves.every(row => row.point === null || keys.has(key(row.point))), 'returned an illegal placement');
}

test('completed-four-and-six-rankings-exactly-match-inherited-native-search', () => {
  for (const [rulesVersion, depth] of [['territory-v2', 4], ['territory-v3', 4], ['territory-v3', 6]]) {
    const source = rulesVersion === 'territory-v3' ? tactical() : position({ rulesVersion }, [[0, 2], [1, 3]]);
    const before = capture(source), expected = new MinimaxAI(depth).getTopMoves(source, source.currentPlayer, 5);
    const ai = new BudgetedMinimaxAI({ maxDepth: depth, now: () => 0 });
    const actual = ai.getTopMoves(source, source.currentPlayer, 5);
    assert.deepEqual(actual, expected);
    assert.equal(ai.lastSearch.completedDepth, depth);
    assert.equal(ai.lastSearch.rootPlacementCap, 20);
    assert.equal(ai.lastSearch.fullLegalTeacher, false);
    assert.equal(ai.lastSearch.shallowQualityTradeoff, false);
    assert.ok(ai.lastSearch.iterations.every(row => row.complete));
    assert.deepEqual(capture(source), before);
    rows.push({ rulesVersion, depth, point: actual[0].point, maxReachedPly: ai.lastSearch.maxReachedPly });
  }
});
test('clone-preserves-custom-roots-flags-history-actor-and-optional-latest-markers', () => {
  const source = position({ initialPositions: { BLACK: [1, 0], WHITE: [0, 3] }, startPlayer: 'WHITE' });
  source.lastMoves = { BLACK: [1, 0], WHITE: null };
  source.lastMove = [1, 0]; source.lastAction = { type: 'pass', player: 'WHITE' };
  const before = capture(source);
  class Inspect extends BudgetedMinimaxAI {
    searchAtDepth(engine, actor, n) {
      assert.equal(engine.rulesVersion, source.rulesVersion);
      assert.equal(engine.startPlayer, source.startPlayer);
      assert.equal(engine.hasCustomInitialPositions, true);
      assert.deepEqual(engine.initialPositions, source.initialPositions);
      assert.deepEqual(engine.historyHashes, source.historyHashes);
      assert.deepEqual(engine.lastMoves, source.lastMoves);
      assert.deepEqual(engine.lastMove, source.lastMove);
      assert.deepEqual(engine.lastAction, source.lastAction);
      assert.notEqual(engine.lastMoves, source.lastMoves);
      return super.searchAtDepth(engine, actor, n);
    }
  }
  const ai = new Inspect({ maxDepth: 2, now: () => 0 });
  assert.deepEqual(ai.getTopMoves(source, source.currentPlayer), new MinimaxAI(2).getTopMoves(source, source.currentPlayer));
  assert.deepEqual(capture(source), before);
});
test('deadline-discards-partial-iteration-and-keeps-complete-one-ply-ranking', () => {
  const source = tactical(), before = capture(source);
  const expected = new MinimaxAI(1).getTopMoves(source, source.currentPlayer, 5);
  let clock = 0;
  class Partial extends BudgetedMinimaxAI {
    searchAtDepth(engine, actor, n) {
      if (this.depth === 1) return super.searchAtDepth(engine, actor, n);
      this.lastSearch = { depth: this.depth, nodes: 1, leaves: 0, rootActions: 1 };
      clock = 1000; this.checkSearchBudget();
      return [{ point: null, type: 'pass', score: 99999999 }];
    }
  }
  const ai = new Partial({ timeMs: 1000, reserveMs: 200, now: () => clock });
  assert.deepEqual(ai.getTopMoves(source, source.currentPlayer), expected);
  assert.equal(ai.lastSearch.completedDepth, 1);
  assert.equal(ai.lastSearch.partialDiscarded, true);
  assert.equal(ai.lastSearch.shallowQualityTradeoff, true);
  assert.equal(ai.depth, 8); assert.equal(ai._searchDeadline, undefined);
  assert.deepEqual(capture(source), before);
});
test('inherited-four-action-overlay-obeys-the-same-expiration-sentinel', () => {
  const source = tactical(), before = capture(source), expected = new MinimaxAI(1).getTopMoves(source, source.currentPlayer);
  let clock = 0, overlayChecks = 0;
  class OverlayDeadline extends BudgetedMinimaxAI {
    checkSearchBudget() {
      if (this.depth === 2 && new Error().stack.includes('applyRootCutChainPreference')) {
        overlayChecks++; clock = 1000;
      }
      return super.checkSearchBudget();
    }
  }
  const ai = new OverlayDeadline({ timeMs: 1000, reserveMs: 0, now: () => clock });
  assert.deepEqual(ai.getTopMoves(source, source.currentPlayer), expected);
  assert.ok(overlayChecks > 0, 'overlay callback did not poll the shared deadline');
  assert.equal(ai.lastSearch.completedDepth, 1); assert.equal(ai.lastSearch.partialDiscarded, true);
  assert.deepEqual(capture(source), before);
});
test('preparation-and-caller-input-time-consume-the-total-budget-and-reserve', () => {
  const source = tactical(), before = capture(source), times = [100, 115, 120, 125];
  const ai = new BudgetedMinimaxAI({ timeMs: 30, reserveMs: 5, now: () => times.shift() ?? 125 });
  const moves = ai.getTopMoves(source, source.currentPlayer, 5, { startedAt: 90, deadline: 120 });
  legal(source, moves);
  assert.equal(ai.lastSearch.completedDepth, 0); assert.equal(ai.lastSearch.fallback, 'legal-placement');
  assert.equal(ai.lastSearch.preparationMs, 25); assert.equal(ai.lastSearch.elapsedMs, 35);
  assert.equal(ai.lastSearch.searchDeadline, 115); assert.equal(ai.lastSearch.totalDeadline, 120);
  assert.equal(ai.lastSearch.remainingMs, 0); assert.equal(ai.lastSearch.softOverrunMs, 10);
  assert.equal(ai.lastSearch.totalOverrunMs, 5); assert.equal(ai.lastSearch.shallowQualityTradeoff, true);
  assert.deepEqual(capture(source), before);
});
test('clock-errors-are-visible-and-restore-state-and-temporary-ai-fields', () => {
  for (const times of [[NaN], [-1], [Infinity], [10, 10, 9], [0, 0, 0, NaN]]) {
    const source = tactical(), before = capture(source), values = [...times];
    const ai = new BudgetedMinimaxAI({ now: () => values.length ? values.shift() : times.at(-1) });
    ai._searchDeadline = 12345;
    assert.throws(() => ai.getTopMoves(source, source.currentPlayer), /clock/);
    assert.equal(ai.depth, 8); assert.equal(ai._searchDeadline, 12345); assert.equal(ai._budgetContext, undefined);
    assert.deepEqual(capture(source), before);
  }
});
test('configuration-future-clock-and-overflow-are-rejected', () => {
  for (const options of [{ timeMs: Infinity }, { timeMs: -1 }, { reserveMs: -1 }, { reserveMs: 3000 },
    { maxDepth: 0 }, { maxDepth: 9 }, { now: null }]) assert.throws(() => new BudgetedMinimaxAI(options), /settings/);
  const source = tactical();
  assert.throws(() => new BudgetedMinimaxAI({ now: () => 1 }).getTopMoves(source, source.currentPlayer, 5, { startedAt: 2 }), /future/);
  assert.throws(() => new BudgetedMinimaxAI({ timeMs: 1e308, now: () => 1e308 }).getTopMoves(source, source.currentPlayer), /overflow/);
  assert.throws(() => new BudgetedMinimaxAI().getTopMoves(source, source.currentPlayer, 5, { deadline: NaN }), /deadline/);
});
test('natural-terminal-tree-stops-early-and-explicit-pass-counts-as-one-ply', () => {
  const source = position();
  // Explicit synthetic no-placement boundary; no gameplay reachability claim.
  for (const point of source.validPositions) source._setState(point, source._getPlayerStates(source.currentPlayer).node);
  source.consecutiveSkips = 1; source.gameOver = false;
  const before = capture(source), ai = new BudgetedMinimaxAI({ maxDepth: 8, now: () => 0 });
  const moves = ai.getTopMoves(source, source.currentPlayer);
  assert.equal(moves[0].point, null); assert.equal(ai.lastSearch.terminalTreeSolved, true);
  assert.equal(ai.lastSearch.completedDepth, 1); assert.equal(ai.lastSearch.maxReachedPly, 1);
  assert.equal(ai.lastSearch.maxMinimaxPly, 1); assert.equal(ai.lastSearch.iterations.length, 1);
  assert.deepEqual(capture(source), before);
});
test('superko-is-preserved-in-legal-fallback-and-source-remains-unchanged', () => {
  const source = position(), point = source.getLegalMoves()[0].point;
  const future = position(); future._isReplayingBatch = true; assert.equal(future.playMove(point).success, true);
  source.historyHashes.add([...future.historyHashes].at(-1));
  assert.equal(source.getLegalMoves().some(row => key(row.point) === key(point)), false);
  const before = capture(source); let clock = 0;
  const ai = new BudgetedMinimaxAI({ timeMs: 2, reserveMs: 0, now: () => clock++ });
  const moves = ai.getTopMoves(source, source.currentPlayer);
  legal(source, moves); assert.notEqual(key(moves[0].point), key(point));
  assert.deepEqual(capture(source), before);
});
test('unexpected-search-errors-propagate-without-mutating-source', () => {
  const source = tactical(), before = capture(source);
  class Broken extends BudgetedMinimaxAI { evaluate() { throw new Error('explicit fixture failure'); } }
  const ai = new Broken({ now: () => 0 });
  assert.throws(() => ai.getTopMoves(source, source.currentPlayer), /explicit fixture failure/);
  assert.equal(ai.depth, 8); assert.equal(ai._searchDeadline, undefined);
  assert.deepEqual(capture(source), before);
});
test('default-clock-works-without-performance-global', () => {
  const url = new URL('../BudgetedMinimaxAI.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `globalThis.performance=undefined;const {BudgetedMinimaxAI}=await import(${JSON.stringify(url)});const ai=new BudgetedMinimaxAI();if(!Number.isFinite(ai.searchTime()))process.exit(1);`],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

assert.equal(hash(await readFile(new URL('../AIEngine.js', import.meta.url))), originalHash, 'frozen AIEngine changed');
console.log(JSON.stringify({ status: 'PASS_BOUNDED_MINIMAX_CANDIDATE_V1', groups: groups.length, tests: groups,
  completedNativeParity: rows, frozenAIEngineSha256: originalHash,
  sourceSha256: hash(await readFile(new URL('../BudgetedMinimaxAI.js', import.meta.url))),
  scope: 'Native fixed-depth rank parity, deterministic deadline/overlay/clock/state/fallback checks. No production guard integration, speed distribution, strength or release admission claim.' }));
