import assert from "node:assert/strict";
import { GameEngine, TerritoryRulesVersion } from "../GameEngine.js?v=20261025-room1";
import {
  MinimaxAI,
  boundedRootCutChainAttack,
  boundedRootCutChainRisk,
  saveState,
} from "../AIEngine.js?v=20261025-room1";

const PREFIX = [[2, 0], [3, 1], [0, 1], [0, 4]];
const ORDINARY_CUT = [2, 2];
const FORCED_CHAIN_SETUP = [2, 1];
const key = (point) => point.join(",");

function buildEngine(rulesVersion) {
  const engine = new GameEngine({
    gridSize: 5,
    playerCount: 2,
    rulesVersion,
    deferTerritoryUpdates: true,
  });
  engine._isReplayingBatch = true;
  try {
    for (const [index, point] of PREFIX.entries()) {
      const result = engine.playMove(point);
      assert.equal(result.success, true,
        `${rulesVersion}: prefix ${index + 1} ${key(point)}: ${result.reason}`);
    }
  } finally {
    engine._isReplayingBatch = false;
  }
  assert.equal(engine.currentPlayer, "BLACK");
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
    playMove: engine.playMove,
    getLegalMoves: engine.getLegalMoves,
  };
}

function material(engine, player) {
  const nodes = engine._getPlayerNodes(player).length;
  return { nodes, coverage: nodes + engine._getPlayerLines(player).length };
}

function lossFrom(reference, engine, player) {
  const remaining = material(engine, player);
  return {
    nodes: Math.max(0, reference.nodes - remaining.nodes),
    coverage: Math.max(0, reference.coverage - remaining.coverage),
  };
}

function compareLoss(left, right) {
  return left.nodes - right.nodes || left.coverage - right.coverage;
}

function canonicalForcedAttack(source, rootPoint, attacker) {
  // Independent rule oracle: every transition is replayed on a fresh native
  // engine. It does not call the production bounded-chain helper.
  const defender = source._getOpponents(attacker)[0];
  const reference = material(source, defender);
  const afterRoot = copyEngine(source);
  assert.equal(afterRoot.playMove(rootPoint).success, true,
    `root ${key(rootPoint)} must be legal`);
  const immediate = lossFrom(reference, afterRoot, defender);
  const responses = afterRoot.getLegalMoves(defender)
    .map(({ point }) => [...point]);
  responses.push(null);

  let forced = null;
  const branches = [];
  for (const response of responses) {
    const afterResponse = copyEngine(afterRoot);
    const accepted = response === null
      ? afterResponse.skipTurn().success
      : afterResponse.playMove(response).success;
    assert.equal(accepted, true,
      `response ${response === null ? "PASS" : key(response)} must be legal`);

    let best = lossFrom(reference, afterResponse, defender);
    let bestMove = null;
    if (!afterResponse.gameOver && afterResponse.currentPlayer === attacker) {
      const defenderLine = afterResponse._getPlayerStates(defender).line;
      for (const { point } of afterResponse.getLegalMoves(attacker)) {
        if (afterResponse._getState(point) !== defenderLine) continue;
        const afterSecond = copyEngine(afterResponse);
        assert.equal(afterSecond.playMove(point).success, true,
          `second cut ${key(point)} must be legal`);
        const candidate = lossFrom(reference, afterSecond, defender);
        if (compareLoss(candidate, best) > 0) {
          best = candidate;
          bestMove = [...point];
        }
      }
    }
    if (forced === null || compareLoss(best, forced) < 0) forced = best;
    branches.push({ response, bestMove, best });
  }
  return { immediate, forced, branches };
}

const results = [];
for (const rulesVersion of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
  const engine = buildEngine(rulesVersion);
  const baseline = capture(engine);
  const attacker = engine.currentPlayer;
  const defender = engine._getOpponents(attacker)[0];
  const defenderReference = material(engine, defender);

  const ordinary = canonicalForcedAttack(engine, ORDINARY_CUT, attacker);
  assert.deepEqual(ordinary.immediate, { nodes: 1, coverage: 3 },
    `${rulesVersion}: ordinary cut must take one node immediately`);
  assert.deepEqual(ordinary.forced, { nodes: 0, coverage: 2 },
    `${rulesVersion}: defender must be able to replace that node and stop the chain`);
  assert.ok(ordinary.branches.some(({ response, bestMove }) =>
    key(response) === key(FORCED_CHAIN_SETUP) && bestMove === null),
  `${rulesVersion}: occupying the setup point must stop the ordinary cut`);

  const chain = canonicalForcedAttack(engine, FORCED_CHAIN_SETUP, attacker);
  assert.deepEqual(chain.immediate, { nodes: 0, coverage: 0 },
    `${rulesVersion}: setup move must not receive credit for an immediate capture`);
  assert.deepEqual(chain.forced, { nodes: 1, coverage: 3 },
    `${rulesVersion}: every defense must still lose one net node to the second cut`);
  assert.equal(chain.branches.length, 4,
    `${rulesVersion}: all three legal defenses plus PASS must be covered`);
  for (const branch of chain.branches) {
    assert.deepEqual(branch.bestMove, ORDINARY_CUT,
      `${rulesVersion}: response ${branch.response ?? "PASS"} must retain the real second cut`);
    assert.deepEqual(branch.best, { nodes: 1, coverage: 3 });
  }

  const afterSetup = copyEngine(engine);
  assert.equal(afterSetup.playMove(FORCED_CHAIN_SETUP).success, true);
  const afterSetupBaseline = capture(afterSetup);
  const boundedAttack = boundedRootCutChainAttack(
    afterSetup, attacker, defenderReference,
  );
  assert.ok(boundedAttack, `${rulesVersion}: bounded attack must complete`);
  assert.deepEqual(
    { nodes: boundedAttack.nodes, coverage: boundedAttack.coverage },
    chain.forced,
    `${rulesVersion}: bounded attack must match the independent native oracle`,
  );
  assert.equal(boundedAttack.responses, 4);
  assert.ok(boundedAttack.secondCuts >= 4);
  assert.deepEqual(capture(afterSetup), afterSetupBaseline,
    `${rulesVersion}: bounded attack changed its caller state`);

  const ordinaryAfter = copyEngine(engine);
  assert.equal(ordinaryAfter.playMove(ORDINARY_CUT).success, true);
  const ordinaryRisk = boundedRootCutChainRisk(ordinaryAfter, attacker);
  const setupRisk = boundedRootCutChainRisk(afterSetup, attacker);
  assert.ok(ordinaryRisk && setupRisk);
  assert.deepEqual(
    { nodes: setupRisk.nodes, coverage: setupRisk.coverage },
    { nodes: ordinaryRisk.nodes, coverage: ordinaryRisk.coverage },
    `${rulesVersion}: offensive preference must not buy the chain with more own loss`,
  );

  const choices = new MinimaxAI(2).getTopMoves(engine, attacker, 5);
  assert.deepEqual(choices[0]?.point, FORCED_CHAIN_SETUP,
    `${rulesVersion}: Minimax must choose the unavoidable continuation setup`);
  const ordinaryChoice = choices.find(({ point }) => key(point) === key(ORDINARY_CUT));
  assert.ok(ordinaryChoice, `${rulesVersion}: ordinary cut must remain in the root window`);
  assert.ok(ordinaryChoice.score > choices[0].score,
    `${rulesVersion}: dominance selection must preserve the original search scores`);
  assert.deepEqual(capture(engine), baseline,
    `${rulesVersion}: offensive root search changed the source game`);

  const failureEngine = copyEngine(afterSetup);
  const failureBaseline = capture(failureEngine);
  const nativePlayMove = failureEngine.playMove;
  let reachedMutation = false;
  failureEngine.playMove = function throwAfterAcceptedMove(...args) {
    const result = nativePlayMove.apply(this, args);
    if (!reachedMutation && result.success) {
      reachedMutation = true;
      throw new Error("intentional offensive-chain transition failure");
    }
    return result;
  };
  try {
    assert.throws(
      () => boundedRootCutChainAttack(failureEngine, attacker, defenderReference),
      /intentional offensive-chain transition failure/,
    );
    assert.ok(reachedMutation);
  } finally {
    failureEngine.playMove = nativePlayMove;
  }
  assert.deepEqual(capture(failureEngine), failureBaseline,
    `${rulesVersion}: offensive-chain exception leaked state`);

  const limitedEngine = copyEngine(afterSetup);
  const limitedBaseline = capture(limitedEngine);
  const nativeGetLegalMoves = limitedEngine.getLegalMoves;
  let reachedLimit = false;
  limitedEngine.getLegalMoves = function inflateResponses(...args) {
    const moves = nativeGetLegalMoves.apply(this, args);
    if (!reachedLimit && this.currentPlayer === defender) {
      assert.ok(moves.length > 0);
      reachedLimit = true;
      return Array.from({ length: 24 }, (_, index) => moves[index % moves.length]);
    }
    return moves;
  };
  let limitedResult;
  try {
    limitedResult = boundedRootCutChainAttack(
      limitedEngine, attacker, defenderReference,
    );
  } finally {
    limitedEngine.getLegalMoves = nativeGetLegalMoves;
  }
  assert.ok(reachedLimit);
  assert.equal(limitedResult, null,
    `${rulesVersion}: response overflow must fail closed`);
  assert.deepEqual(capture(limitedEngine), limitedBaseline,
    `${rulesVersion}: response overflow changed caller state`);

  results.push({
    rulesVersion,
    selected: choices[0].point,
    selectedOriginalScore: choices[0].score,
    rejectedOrdinaryCut: ORDINARY_CUT,
    rejectedOrdinaryScore: ordinaryChoice.score,
    forcedResponses: chain.branches.length,
    forcedLoss: chain.forced,
    ownPersistentRisk: { nodes: setupRisk.nodes, coverage: setupRisk.coverage },
    exceptionRestored: true,
    responseLimitFailsClosed: true,
  });
}

const threePlayer = new GameEngine({
  gridSize: 5,
  playerCount: 3,
  rulesVersion: TerritoryRulesVersion.V3,
  deferTerritoryUpdates: true,
});
const nativeThreePlayerGetNodes = threePlayer._getPlayerNodes;
threePlayer._getPlayerNodes = () => assert.fail(
  "two-player offensive guard must precede material access",
);
try {
  assert.equal(
    boundedRootCutChainAttack(threePlayer, threePlayer.currentPlayer,
      { nodes: 0, coverage: 0 }),
    null,
  );
} finally {
  threePlayer._getPlayerNodes = nativeThreePlayerGetNodes;
}

console.log(JSON.stringify({
  status: "PASS_MINIMAX_FORCED_CUT_CHAIN",
  scope: "native two-player unavoidable second-cut choice, PASS defense, bounds and state restoration",
  results,
}, null, 2));
