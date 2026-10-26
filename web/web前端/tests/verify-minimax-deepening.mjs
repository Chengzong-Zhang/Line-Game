import assert from 'node:assert/strict';
import { GameEngine, TerritoryRulesVersion } from '../GameEngine.js';
import { MinimaxAI, saveState } from '../AIEngine.js';

// A legal v3 position from the bounded, seeded 2026-10-26 tactical probe.
// These are actual chronological moves, not a synthetic occupancy-only board.
const PREFIX = [[0, 2], [1, 3], [0, 3], [3, 1]];
const key = point => point === null ? 'PASS' : point.join(',');

function buildEngine() {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2,
    boardShape: 'triangle', rulesVersion: TerritoryRulesVersion.V3,
    deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  try {
    for (const point of PREFIX) assert.equal(engine.playMove(point).success, true);
  } finally { engine._isReplayingBatch = false; }
  assert.equal(engine.currentPlayer, 'BLACK');
  return engine;
}

function capture(engine) {
  // Refresh the public cache first, then compare its exact saved contents and
  // revisions too. Search may not leave a speculative terminal cache behind.
  const snapshot = engine.getSnapshot();
  return { snapshot, ruleState: saveState(engine), replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch, playMove: engine.playMove,
    skipTurn: engine.skipTurn, autoSkip: engine._checkAndAutoSkip };
}

function exactNaturalTerminalRoots(source) {
  // Independent oracle: canonical native transitions and winner only. There
  // is no heuristic leaf, candidate cap, learned policy or production Minimax.
  const engine = new GameEngine({ gridSize: source.gridSize,
    playerCount: source.playerCount, boardShape: source.boardShape,
    rulesVersion: source.rulesVersion, deferTerritoryUpdates: true });
  engine._restoreReplayState(source._captureReplayState());
  engine._isReplayingBatch = true;
  const root = engine._captureReplayState(), actor = engine.currentPlayer;
  let nodes = 0, naturalTerminals = 0;
  const visit = (ply, alpha, beta) => {
    assert.ok(++nodes <= 5000 && ply <= 24, 'bounded natural-terminal oracle failed to complete');
    if (engine.gameOver) {
      naturalTerminals++;
      const winner = engine.getWinner();
      return winner === 'DRAW' ? 0 : winner === actor ? 1 : -1;
    }
    const maximizing = engine.currentPlayer === actor;
    let best = maximizing ? -Infinity : Infinity;
    const actions = [...engine.getLegalMoves().map(move => move.point), null];
    for (const action of actions) {
      const saved = engine._captureReplayState();
      try {
        const accepted = action === null ? engine.skipTurn() : engine.playMove(action);
        assert.equal(accepted.success, true, 'oracle action must be canonically legal');
        const value = visit(ply + 1, alpha, beta);
        best = maximizing ? Math.max(best, value) : Math.min(best, value);
        if (maximizing) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
      } finally { engine._restoreReplayState(saved); }
      if (alpha >= beta) break;
    }
    return best;
  };
  const values = [];
  for (const point of [...engine.getLegalMoves().map(move => move.point), null]) {
    engine._restoreReplayState(root);
    assert.equal((point === null ? engine.skipTurn() : engine.playMove(point)).success, true);
    values.push({ point, value: visit(1, -Infinity, Infinity) });
  }
  return { complete: true, nodes, naturalTerminals, values };
}

const engine = buildEngine(), before = capture(engine);
const oracle = exactNaturalTerminalRoots(engine);
assert.deepEqual(Object.fromEntries(oracle.values.map(row => [key(row.point), row.value])), {
  '1,0': -1, '2,0': 1, '2,1': -1, '2,2': -1, PASS: -1,
}, 'full legal roots plus PASS must prove the unique winning move');
assert.deepEqual(capture(engine), before, 'independent oracle changed its source');

const fixedFour = new MinimaxAI(4).getTopMoves(engine, engine.currentPlayer, 5);
const fixedSix = new MinimaxAI(6).getTopMoves(engine, engine.currentPlayer, 5);
assert.deepEqual(fixedFour[0].point, [2, 2], 'four-ply fixture must retain its horizon error');
assert.deepEqual(fixedSix[0].point, [2, 0], 'six plies must find the forced native win');
const oracleValue = point => oracle.values.find(row => key(row.point) === key(point)).value;
assert.equal(oracleValue(fixedFour[0].point), -1);
assert.equal(oracleValue(fixedSix[0].point), 1);
assert.deepEqual(capture(engine), before, 'fixed-depth searches changed complete source state');

const deeper = new MinimaxAI(4, { iterativeDeepening: true,
  maxExtraDepth: 2, extensionTimeMs: 100, now: () => 0 });
const deepMoves = deeper.getTopMoves(engine, engine.currentPlayer, 5);
assert.deepEqual(deepMoves, fixedSix, 'only a complete deeper ranking may replace the base ranking');
assert.equal(deeper.depth, 4, 'public configured depth must be restored');
assert.equal(deeper.lastSearch.baseDepth, 4);
assert.equal(deeper.lastSearch.completedDepth, 6);
assert.equal(deeper.lastSearch.deeperIterations.length, 2);
assert.ok(deeper.lastSearch.deeperIterations.every(iteration => iteration.complete));
assert.deepEqual(capture(engine), before, 'completed deepening changed full source/cache state');

const timeouts = [];
for (const expireAt of [2, 8, 40]) {
  let clockCalls = 0;
  const limited = new MinimaxAI(4, { iterativeDeepening: true,
    maxExtraDepth: 2, extensionTimeMs: 100,
    now: () => ++clockCalls >= expireAt ? 1000 : 0 });
  const moves = limited.getTopMoves(engine, engine.currentPlayer, 5);
  assert.deepEqual(moves, fixedFour,
    `expiry at check ${expireAt} must publish the complete four-ply ranking`);
  assert.equal(limited.depth, 4, 'expiry must restore configured depth');
  assert.equal(limited.lastSearch.baseDepth, 4);
  assert.equal(limited.lastSearch.completedDepth, 4);
  assert.ok(clockCalls >= expireAt, 'the extra-iteration budget check did not execute');
  if (expireAt === 40) {
    assert.ok(limited.lastSearch.deeperIterations.some(iteration =>
      !iteration.complete && iteration.exactRoots > 0),
    'the partial-ranking case must finish at least one deeper root before expiry');
  }
  assert.deepEqual(capture(engine), before,
    `expiry at check ${expireAt} leaked grid/edges/history/actor/PASS/cache state`);
  timeouts.push({ expireAt, clockCalls, completedDepth: limited.lastSearch.completedDepth,
    deeperIterations: limited.lastSearch.deeperIterations });
}

assert.throws(() => new MinimaxAI(4, { extensionTimeMs: Infinity }),
  /Invalid Minimax deeper-search settings/, 'an infinite extra budget must be rejected');
const invalidClocks = [];
for (const finiteChecks of [0, 8]) {
  let clockCalls = 0;
  const invalid = new MinimaxAI(4, { iterativeDeepening: true,
    maxExtraDepth: 2, extensionTimeMs: 100,
    now: () => ++clockCalls <= finiteChecks ? 0 : NaN });
  const deadlineBefore = invalid._searchDeadline;
  assert.throws(() => invalid.getTopMoves(engine, engine.currentPlayer, 5),
    /Invalid Minimax search clock/,
    `invalid clock after ${finiteChecks} finite checks must be a visible error`);
  assert.equal(invalid.depth, 4, 'clock failure must restore the configured depth');
  assert.equal(invalid._searchDeadline, deadlineBefore,
    'clock failure must restore the temporary extra-search deadline');
  assert.deepEqual(capture(engine), before,
    `invalid clock after ${finiteChecks} checks leaked full source/cache state`);
  invalidClocks.push({ finiteChecks, clockCalls, configuredDepthRestored: true,
    temporaryDeadlineRestored: true, sourceStateRestored: true });
}

process.stdout.write(JSON.stringify({ status: 'PASS_BOUNDED_DEEPENING_AND_NATIVE_TACTICAL_WITNESS',
  rulesVersion: TerritoryRulesVersion.V3, gridSize: 5, players: 2, prefix: PREFIX,
  fourPly: { point: fixedFour[0].point, naturalTerminalValue: -1 },
  sixPly: { point: fixedSix[0].point, naturalTerminalValue: 1 },
  oracle, completedDepth: deeper.lastSearch.completedDepth, timeouts,
  invalidClocks, infiniteExtensionBudgetRejected: true,
  sourceStateRestored: true,
  scope: 'One independently solved tactical position and deterministic deadline recovery. No overall win-rate or phone latency claim; the extra budget is a cooperative soft deadline.',
  command: 'node web/web前端/tests/verify-minimax-deepening.mjs' }) + '\n');
