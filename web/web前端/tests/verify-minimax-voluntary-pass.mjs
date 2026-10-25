import assert from "node:assert/strict";
import { GameEngine, TerritoryRulesVersion } from "../GameEngine.js?v=20261025-room1";
import { MinimaxAI, saveState } from "../AIEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";

const SETTLEMENT_PREFIX = [
  [1, 0], [3, 1], [1, 2], [2, 0], [1, 3],
  [1, 1], [0, 2], [0, 4], [2, 2],
];
const AUTO_SKIP_PREFIX = [[0, 4], [1, 3], [0, 3], [1, 2], [1, 0]];
const WORKER_WIN_PREFIX = [[2, 0], [3, 1], [0, 2]];

function buildEngine(rulesVersion, prefix) {
  const engine = new GameEngine({
    gridSize: 5,
    playerCount: 2,
    rulesVersion,
    deferTerritoryUpdates: true,
  });
  engine._isReplayingBatch = true;
  try {
    for (const [index, point] of prefix.entries()) {
      const result = engine.playMove(point);
      assert.equal(result.success, true,
        `${rulesVersion}: prefix ${index + 1} ${point.join(",")}: ${result.reason}`);
    }
  } finally {
    engine._isReplayingBatch = false;
  }
  return engine;
}

function copyEngine(source) {
  const copy = new GameEngine({
    gridSize: source.gridSize,
    playerCount: source.playerCount,
    rulesVersion: source.rulesVersion,
    deferTerritoryUpdates: true,
  });
  copy._restoreReplayState(source._captureReplayState());
  copy._isReplayingBatch = true;
  return copy;
}

function capture(engine) {
  const publicSnapshot = engine.getSnapshot();
  return {
    publicSnapshot,
    ruleState: saveState(engine),
    replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch,
    skipTurn: engine.skipTurn,
    autoSkip: engine._checkAndAutoSkip,
  };
}

const workerMessages = [];
const workerScope = {
  postMessage(message) {
    workerMessages.push(structuredClone(message));
  },
};
globalThis.self = workerScope;
await import("../AIWorker.js?verify-minimax-voluntary-pass=1");

async function computeWithActualWorker(engine, rulesVersion) {
  const serializedState = serializeEngineState(engine);
  const serializedBefore = structuredClone(serializedState);
  workerMessages.length = 0;
  await workerScope.onmessage({
    data: {
      type: "COMPUTE",
      requestId: `minimax-pass-${rulesVersion}`,
      serializedState,
      aiPlayer: engine.currentPlayer,
      strategy: "minimax",
      depth: 2,
      topN: 5,
    },
  });
  assert.deepEqual(serializedState, serializedBefore,
    `${rulesVersion}: actual AIWorker mutated its serialized input`);
  assert.equal(workerMessages.length, 1,
    `${rulesVersion}: actual AIWorker must emit exactly one terminal response`);
  const response = workerMessages[0];
  assert.equal(response.type, "RESULT",
    `${rulesVersion}: actual AIWorker failed: ${response.message ?? "unknown error"}`);
  return response;
}

const results = [];
for (const rulesVersion of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
  // Control: with no preceding pass, WHITE has one profitable legal cut.
  // PASS is searched but must not replace that native placement.
  const control = buildEngine(rulesVersion, SETTLEMENT_PREFIX);
  assert.equal(control.currentPlayer, "WHITE");
  assert.equal(control.consecutiveSkips, 0);
  assert.deepEqual(control.getLegalMoves().map(({ point }) => point), [[1, 2]]);
  const controlBefore = capture(control);
  const controlChoices = new MinimaxAI(2).getTopMoves(control, control.currentPlayer, 5);
  assert.deepEqual(controlChoices[0]?.point, [1, 2],
    `${rulesVersion}: a useful legal cut must beat voluntary PASS`);
  assert.notEqual(controlChoices[0]?.type, "pass");
  const controlActor = control.currentPlayer;
  const controlOpponent = control._getOpponents(controlActor)[0];
  const controlAfter = copyEngine(control);
  const ownNodesBefore = control._getPlayerNodes(controlActor).length;
  const opponentNodesBefore = control._getPlayerNodes(controlOpponent).length;
  assert.equal(controlAfter.playMove(controlChoices[0].point).success, true);
  assert.equal(controlAfter._getPlayerNodes(controlActor).length, ownNodesBefore + 1);
  assert.equal(controlAfter._getPlayerNodes(controlOpponent).length, opponentNodesBefore - 1,
    `${rulesVersion}: the non-PASS control must be a real profitable cut`);
  assert.deepEqual(capture(control), controlBefore,
    `${rulesVersion}: control search changed the source game`);

  // The same native board after WHITE has passed once. BLACK still has four
  // legal placements, but matching the pass now closes the game as a draw.
  const settlement = copyEngine(control);
  settlement._isReplayingBatch = false;
  const firstPassHistory = new Set(settlement.historyHashes);
  assert.equal(settlement.skipTurn().success, true);
  assert.equal(settlement.currentPlayer, "BLACK");
  assert.equal(settlement.consecutiveSkips, 1);
  assert.equal(settlement.getLegalMoves().length, 4,
    `${rulesVersion}: voluntary PASS witness must retain legal placements`);
  assert.deepEqual(settlement.historyHashes, firstPassHistory,
    `${rulesVersion}: PASS must not fabricate a Superko placement hash`);

  const settlementBefore = capture(settlement);
  const initialTurnCount = settlement.turnCount;
  const nativeSettlementSkip = settlement.skipTurn;
  let rootPassProbes = 0;
  let recursivePassProbes = 0;
  settlement.skipTurn = function observedSettlementSkip(...args) {
    if (this.turnCount === initialTurnCount) rootPassProbes += 1;
    else recursivePassProbes += 1;
    return nativeSettlementSkip.apply(this, args);
  };
  let choices;
  try {
    choices = new MinimaxAI(2).getTopMoves(
      settlement, settlement.currentPlayer, 5,
    );
  } finally {
    settlement.skipTurn = nativeSettlementSkip;
  }
  assert.ok(rootPassProbes > 0, `${rulesVersion}: root PASS was not searched`);
  assert.ok(recursivePassProbes > 0, `${rulesVersion}: recursive PASS was not searched`);
  assert.equal(choices[0]?.type, "pass",
    `${rulesVersion}: Minimax must be able to choose voluntary PASS`);
  assert.equal(choices[0]?.point, null);
  assert.ok(Number.isFinite(choices[0]?.score));
  assert.equal(choices[0]?.score, 0,
    `${rulesVersion}: a terminal draw reached by PASS must use exact terminal utility`);
  assert.deepEqual(capture(settlement), settlementBefore,
    `${rulesVersion}: PASS search changed the source game`);

  const terminal = copyEngine(settlement);
  const terminalHistory = new Set(terminal.historyHashes);
  assert.equal(terminal.skipTurn().success, true);
  assert.equal(terminal.gameOver, true);
  assert.equal(terminal.consecutiveSkips, 2,
    `${rulesVersion}: the second consecutive PASS must end a two-player game`);
  assert.equal(terminal.getWinner(), "DRAW");
  assert.deepEqual(terminal.historyHashes, terminalHistory,
    `${rulesVersion}: terminal PASS must preserve Superko history`);

  // A PASS must also retain GameEngine's automatic no-move normalization.
  // Here BLACK has no placement. WHITE's searched PASS canonically triggers
  // BLACK's automatic pass and the same two-skip terminal boundary, while a
  // useful WHITE placement remains the selected action.
  const autoSkip = buildEngine(rulesVersion, AUTO_SKIP_PREFIX);
  assert.equal(autoSkip.currentPlayer, "WHITE");
  assert.ok(autoSkip.getLegalMoves("WHITE").length > 0);
  assert.equal(autoSkip.getLegalMoves("BLACK").length, 0);
  const autoSkipBefore = capture(autoSkip);
  const nativeSkipTurn = autoSkip.skipTurn;
  let observedCanonicalAutoTerminal = false;
  autoSkip.skipTurn = function observedSkip(...args) {
    const result = nativeSkipTurn.apply(this, args);
    if (result.success && this.gameOver && this.consecutiveSkips === 2) {
      observedCanonicalAutoTerminal = true;
    }
    return result;
  };
  try {
    const autoChoices = new MinimaxAI(2).getTopMoves(
      autoSkip, autoSkip.currentPlayer, 5,
    );
    assert.notEqual(autoChoices[0]?.type, "pass",
      `${rulesVersion}: winning placement must not be replaced by PASS`);
    assert.ok(observedCanonicalAutoTerminal,
      `${rulesVersion}: root PASS must run canonical automatic-skip handling`);
  } finally {
    autoSkip.skipTurn = nativeSkipTurn;
  }
  assert.deepEqual(capture(autoSkip), autoSkipBefore,
    `${rulesVersion}: automatic-skip PASS probe changed the source game`);

  // Exercise the real worker reconstruction path. A compact worker state does
  // not carry display territory caches, so the terminal PASS must refresh the
  // exact native area before assigning its win utility.
  const workerWin = buildEngine(rulesVersion, WORKER_WIN_PREFIX);
  assert.equal(workerWin.currentPlayer, "WHITE");
  assert.equal(workerWin.skipTurn().success, true);
  assert.equal(workerWin.currentPlayer, "BLACK");
  assert.equal(workerWin.consecutiveSkips, 1);
  assert.equal(workerWin.getLegalMoves().length, 5,
    `${rulesVersion}: actual-worker witness must retain five legal placements`);
  const workerSourceBefore = capture(workerWin);
  const workerResponse = await computeWithActualWorker(workerWin, rulesVersion);
  assert.ok(Array.isArray(workerResponse.moves[0].point),
    `${rulesVersion}: actual AIWorker must retain witnessed safe growth despite the raw winning PASS`);
  assert.equal(workerResponse.searchStats.passDiscipline.status, "safe-profitable-expansion");
  assert.equal(workerResponse.searchStats.passDiscipline.witness.completeOpponentRound, true);
  assert.equal(workerResponse.searchStats.passDiscipline.witness.passWouldEnd, true);
  assert.ok(workerResponse.searchStats.passDiscipline.witness.minimumReplyMargin > 0);
  assert.deepEqual(capture(workerWin), workerSourceBefore,
    `${rulesVersion}: actual AIWorker changed the source game`);

  const workerTerminal = copyEngine(workerWin);
  assert.equal(workerTerminal.skipTurn().success, true);
  assert.equal(workerTerminal.gameOver, true);
  assert.equal(workerTerminal.getWinner(), "BLACK");
  const terminalEvaluator = new MinimaxAI(2);
  assert.equal(terminalEvaluator.evaluate(workerTerminal, "BLACK"), 1_000_000,
    `${rulesVersion}: exact terminal winner utility drifted`);
  assert.equal(terminalEvaluator.evaluate(workerTerminal, "WHITE"), -1_000_000,
    `${rulesVersion}: exact terminal loser utility drifted`);
  const expectedAreas = rulesVersion === TerritoryRulesVersion.V2
    ? { BLACK: 6, WHITE: 0 }
    : { BLACK: 6, WHITE: 2 };
  assert.deepEqual(Object.fromEntries(workerTerminal.activePlayers.map(
    (player) => [player, workerTerminal.cachedTerritories[player].area],
  )), expectedAreas, `${rulesVersion}: actual-worker terminal area witness drifted`);

  results.push({
    rulesVersion,
    controlMove: controlChoices[0].point,
    voluntaryPassLegalPlacements: settlement.getLegalMoves().length,
    voluntaryPassScore: choices[0].score,
    rootPassProbes,
    recursivePassProbes,
    terminalWinner: terminal.getWinner(),
    canonicalAutoSkipObserved: observedCanonicalAutoTerminal,
    actualWorker: {
      legalPlacements: workerWin.getLegalMoves().length,
      selected: workerResponse.moves[0],
      terminalWinner: workerTerminal.getWinner(),
      terminalAreas: expectedAreas,
      sourceStatePreserved: true,
    },
  });
}

console.log(JSON.stringify({
  status: "PASS_VOLUNTARY_MINIMAX_PASS",
  scope: "native and actual-AIWorker two-player PASS choice, exact terminal area, rejection, Superko/state restoration and terminal skip boundaries",
  results,
}, null, 2));
