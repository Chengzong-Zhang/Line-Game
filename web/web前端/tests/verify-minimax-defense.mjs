import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { GameEngine, TerritoryRulesVersion } from "../GameEngine.js";
import { MinimaxAI, saveState } from "../AIEngine.js";

const fixtureData = JSON.parse(await fs.readFile(
  new URL("./fixtures/minimax-defense.json", import.meta.url), "utf8",
));
const key = (point) => point.join(",");

function makeEngine(fixture, rulesVersion) {
  const engine = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: 2,
    rulesVersion,
    deferTerritoryUpdates: true,
  });
  engine._isReplayingBatch = true;
  for (const [index, point] of fixture.moves.entries()) {
    const result = engine.playMove(point);
    assert.equal(result.success, true,
      `${fixture.id}/${rulesVersion}: prefix ${index + 1} ${key(point)}: ${result.reason}`);
  }
  engine._isReplayingBatch = false;
  assert.equal(engine.currentPlayer, fixture.player, `${fixture.id}: expected actor`);
  return engine;
}

function copyEngine(engine) {
  const copy = new GameEngine({
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    rulesVersion: engine.rulesVersion,
    deferTerritoryUpdates: true,
  });
  copy._restoreReplayState(engine._captureReplayState());
  copy._isReplayingBatch = true;
  return copy;
}

function captureEngine(engine) {
  // getSnapshot can populate the lazy territory cache. Capture it first so
  // every following snapshot represents the same fully materialized state.
  const publicSnapshot = engine.getSnapshot();
  return {
    publicSnapshot,
    ruleState: saveState(engine),
    replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch,
    autoSkip: engine._checkAndAutoSkip,
    addNode: engine._addNode,
    moveProbeUndo: engine._moveProbeUndo,
  };
}

function counts(engine, player) {
  const nodes = engine._getPlayerNodes(player).length;
  return { nodes, coverage: nodes + engine._getPlayerLines(player).length };
}

function canonicalNextAttackLoss(engine, point, player) {
  // Independent oracle: replay the root move and every legal attacking reply
  // through playMove on fresh engines. Do not call the heuristic's threat
  // estimator or reproduce its graph/weight calculations.
  const after = copyEngine(engine);
  const opponent = engine._getOpponents(player)[0];
  const opponentNodesBefore = counts(engine, opponent).nodes;
  assert.equal(after.playMove(point).success, true, `root move ${key(point)} must be legal`);
  const before = counts(after, player);
  const result = {
    enemyCaptured: opponentNodesBefore - counts(after, opponent).nodes,
    maxNodeLoss: 0,
    maxCoverageLoss: 0,
    worstNodeDifference: before.nodes - counts(after, opponent).nodes,
    attacks: [],
  };
  if (after.gameOver || after.currentPlayer === player) return result;
  const ownLine = after._getPlayerStates(player).line;
  for (const reply of after.getLegalMoves()) {
    if (after._getState(reply.point) !== ownLine) continue;
    const replyEngine = copyEngine(after);
    assert.equal(replyEngine.playMove(reply.point).success, true,
      `reply ${key(reply.point)} must stay legal on the replay copy`);
    const remaining = counts(replyEngine, player);
    const nodeLoss = before.nodes - remaining.nodes;
    const coverageLoss = before.coverage - remaining.coverage;
    result.maxNodeLoss = Math.max(result.maxNodeLoss, nodeLoss);
    result.maxCoverageLoss = Math.max(result.maxCoverageLoss, coverageLoss);
    result.worstNodeDifference = Math.min(result.worstNodeDifference,
      remaining.nodes - counts(replyEngine, opponent).nodes);
    result.attacks.push({ point: reply.point, nodeLoss, coverageLoss });
  }
  return result;
}

function compareLoss(left, right) {
  return left.maxNodeLoss - right.maxNodeLoss
    || left.maxCoverageLoss - right.maxCoverageLoss;
}

function lossFrom(reference, engine, player) {
  const remaining = counts(engine, player);
  return {
    maxNodeLoss: Math.max(0, reference.nodes - remaining.nodes),
    maxCoverageLoss: Math.max(0, reference.coverage - remaining.coverage),
  };
}

function canonicalDirectCuts(engine, defender, reference) {
  if (engine.gameOver || engine.currentPlayer === defender) return [];
  const ownLine = engine._getPlayerStates(defender).line;
  const cuts = [];
  for (const { point } of engine.getLegalMoves()) {
    if (engine._getState(point) !== ownLine) continue;
    const after = copyEngine(engine);
    assert.equal(after.playMove(point).success, true,
      `direct cut ${key(point)} must stay legal on the replay copy`);
    const loss = lossFrom(reference, after, defender);
    if (loss.maxNodeLoss > 0 || loss.maxCoverageLoss > 0) {
      cuts.push({ point, after, loss });
    }
  }
  return cuts;
}

function canonicalTwoCutRisk(engine, point, player) {
  // Exact bounded oracle for this fixture: root move, every damaging reply,
  // every defender move plus PASS, then every damaging second cut. It uses
  // only isolated GameEngine playMove/skipTurn transitions and does not call
  // the production cut-pressure estimator.
  const afterRoot = copyEngine(engine);
  const opponent = engine._getOpponents(player)[0];
  const opponentBefore = counts(engine, opponent);
  assert.equal(afterRoot.playMove(point).success, true,
    `root move ${key(point)} must be legal for the two-cut oracle`);
  const reference = counts(afterRoot, player);
  const opponentAfter = counts(afterRoot, opponent);
  const firstCuts = canonicalDirectCuts(afterRoot, player, reference);
  let worstFirst = { maxNodeLoss: 0, maxCoverageLoss: 0 };
  let responseBranches = 0;
  let secondCuts = 0;

  for (const first of firstCuts) {
    let responses;
    if (first.after.gameOver || first.after.currentPlayer !== player) {
      responses = [{ point: null, after: copyEngine(first.after) }];
    } else {
      responses = first.after.getLegalMoves(player).map(({ point: response }) => {
        const after = copyEngine(first.after);
        assert.equal(after.playMove(response).success, true,
          `defensive response ${key(response)} must stay legal`);
        return { point: response, after };
      });
      const afterPass = copyEngine(first.after);
      assert.equal(afterPass.skipTurn().success, true, "defensive PASS must stay legal");
      responses.push({ point: null, after: afterPass });
    }
    responseBranches += responses.length;

    let bestResponse = null;
    for (const response of responses) {
      let worstSecond = lossFrom(reference, response.after, player);
      const replies = canonicalDirectCuts(response.after, player, reference);
      secondCuts += replies.length;
      for (const reply of replies) {
        if (compareLoss(reply.loss, worstSecond) > 0) worstSecond = reply.loss;
      }
      if (bestResponse === null || compareLoss(worstSecond, bestResponse) < 0) {
        bestResponse = worstSecond;
      }
    }
    if (bestResponse !== null && compareLoss(bestResponse, worstFirst) > 0) {
      worstFirst = bestResponse;
    }
  }

  return {
    ...worstFirst,
    enemyCapturedNodes: opponentBefore.nodes - opponentAfter.nodes,
    firstCuts: firstCuts.length,
    responseBranches,
    secondCuts,
  };
}

const results = [];
const failures = [];
for (const rulesVersion of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
  assert.ok(rulesVersion, "both territory-v2 and territory-v3 must be explicitly supported");
  for (const fixture of fixtureData.fixtures) {
    const label = `${fixture.id}/${rulesVersion}`;
    const engine = makeEngine(fixture, rulesVersion);
    const baselineState = captureEngine(engine);
    const legal = new Set(engine.getLegalMoves().map((move) => key(move.point)));
    const legacy = canonicalNextAttackLoss(engine, fixture.legacyMove, fixture.player);
    const witness = canonicalNextAttackLoss(engine, fixture.defensiveWitness, fixture.player);
    assert.equal(legacy.maxNodeLoss, fixture.legacyWorstNodeLoss, `${label}: legacy node-loss witness drifted`);
    assert.equal(legacy.maxCoverageLoss, fixture.legacyWorstCoverageLoss, `${label}: legacy coverage-loss witness drifted`);
    assert.equal(witness.maxNodeLoss, fixture.witnessWorstNodeLoss, `${label}: defensive node-loss witness drifted`);
    assert.equal(witness.maxCoverageLoss, fixture.witnessWorstCoverageLoss, `${label}: defensive coverage-loss witness drifted`);

    const choices = new MinimaxAI(fixture.depth).getTopMoves(engine, fixture.player, 5);
    assert.ok(choices.length > 0, `${label}: expected a choice`);
    for (const choice of choices) {
      assert.ok(legal.has(key(choice.point)), `${label}: returned an illegal move`);
      assert.ok(Number.isFinite(choice.score), `${label}: returned a non-finite score`);
    }
    assert.deepEqual(captureEngine(engine), baselineState, `${label}: search changed caller state`);
    const selected = canonicalNextAttackLoss(engine, choices[0].point, fixture.player);
    let continuousCut = null;
    let netGainControl = null;
    if (fixture.id === "reinforce-before-second-node-loss") {
      const legacyChain = canonicalTwoCutRisk(engine, fixture.legacyMove, fixture.player);
      const selectedChain = canonicalTwoCutRisk(engine, choices[0].point, fixture.player);
      const legacyChoice = choices.find(({ point }) => key(point) === key(fixture.legacyMove));
      assert.ok(legacyChoice, `${label}: the original top move must remain in the comparison window`);
      assert.deepEqual(choices[0].point, [4, 3],
        `${label}: dominance comparison must select the stable response`);
      assert.equal(legacyChain.maxNodeLoss, 1,
        `${label}: legacy two-cut line must retain one node loss after the best defense`);
      assert.equal(selectedChain.maxNodeLoss, 0,
        `${label}: selected ${key(choices[0].point)} must remove node loss through the bounded two-cut line; ${JSON.stringify(selectedChain)}`);
      const legacyNetNodeGain = legacyChain.enemyCapturedNodes - legacyChain.maxNodeLoss;
      const selectedNetNodeGain = selectedChain.enemyCapturedNodes - selectedChain.maxNodeLoss;
      assert.ok(selectedNetNodeGain >= legacyNetNodeGain,
      `${label}: stable defense must preserve the legacy line's net captured-node gain`);
      assert.ok(legacyChoice.score > choices[0].score,
        `${label}: the dominance reorder must preserve original search scores instead of subtracting the persistent loss twice`);
      continuousCut = {
        legacy: { ...legacyChain, score: legacyChoice.score, netNodeGain: legacyNetNodeGain },
        selected: { ...selectedChain, score: choices[0].score, netNodeGain: selectedNetNodeGain },
      };
    }
    if (fixture.id === "occupy-vulnerable-supply-point") {
      const attackChain = canonicalTwoCutRisk(engine, fixture.legacyMove, fixture.player);
      const saferChain = canonicalTwoCutRisk(engine, fixture.defensiveWitness, fixture.player);
      const attackNetNodeGain = attackChain.enemyCapturedNodes - attackChain.maxNodeLoss;
      const saferNetNodeGain = saferChain.enemyCapturedNodes - saferChain.maxNodeLoss;
      assert.ok(compareLoss(saferChain, attackChain) < 0,
        `${label}: control requires a defense with less persistent loss`);
      assert.ok(saferNetNodeGain < attackNetNodeGain,
        `${label}: control requires that safer defense to give up net node gain`);
      assert.deepEqual(choices[0].point, fixture.legacyMove,
        `${label}: lower-risk move must not replace a root action with greater net node gain`);
      netGainControl = {
        selected: { ...attackChain, netNodeGain: attackNetNodeGain },
        rejectedSaferMove: { point: fixture.defensiveWitness, ...saferChain, netNodeGain: saferNetNodeGain },
      };
    }
    // A reduced own loss is not automatically a better move: a profitable
    // capture can justify a counter-cut. Only the uncompensated fixtures
    // require lower exposure; exchange fixtures compare the resulting node
    // balance with their available conservative move instead.
    if (fixture.regression === "uncompensated-defense"
      && selected.maxNodeLoss >= legacy.maxNodeLoss) {
      failures.push(`${label}: chosen ${key(choices[0].point)} still loses ${selected.maxNodeLoss} nodes to one legal reply; legacy loses ${legacy.maxNodeLoss}`);
    }
    if (fixture.regression === "uncompensated-defense"
      && (selected.enemyCaptured < legacy.enemyCaptured
        || selected.worstNodeDifference <= legacy.worstNodeDifference)) {
      failures.push(`${label}: lower exposure came at an uncompensated material cost`);
    }
    if (fixture.regression === "trade-preservation"
      && selected.worstNodeDifference < witness.worstNodeDifference) {
      failures.push(`${label}: selected exchange has a worse node balance than the defensive witness`);
    }
    results.push({
      fixture: fixture.id, regression: fixture.regression,
      depth: fixture.depth, rulesVersion, point: choices[0].point,
      legacyPoint: fixture.legacyMove,
      legacyMaxNodeLoss: legacy.maxNodeLoss,
      selectedMaxNodeLoss: selected.maxNodeLoss,
      selectedMaxCoverageLoss: selected.maxCoverageLoss,
      selectedEnemyCaptured: selected.enemyCaptured,
      selectedWorstNodeDifference: selected.worstNodeDifference,
      defensiveWitnessWorstNodeDifference: witness.worstNodeDifference,
      ...(continuousCut ? { continuousCut } : {}),
      ...(netGainControl ? { netGainControl } : {}),
    });
  }
}

console.log(JSON.stringify({ status: failures.length ? "FAIL" : "PASS", scope: "TACTICAL-REGRESSION-ONLY", positions: results.length, results, failures }, null, 2));
assert.equal(failures.length, 0, failures.join("\n"));
