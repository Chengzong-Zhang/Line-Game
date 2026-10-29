import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { GameEngine, TerritoryRulesVersion } from "../GameEngine.js";
import {
  MinimaxAI,
  boundedRootCutChainRisk,
  evaluateMinimax,
  saveState,
} from "../AIEngine.js";

const fixtures = JSON.parse(await fs.readFile(
  new URL("./fixtures/minimax-defense.json", import.meta.url), "utf8",
)).fixtures;
const fixture = fixtures.find(({ id }) => id === "reinforce-before-second-node-loss");
assert.ok(fixture, "the legal defensive prefix is required");
const pointKey = (point) => point.join(",");

function makeEngine(rulesVersion, sourceFixture = fixture) {
  const engine = new GameEngine({
    gridSize: sourceFixture.gridSize,
    playerCount: 2,
    rulesVersion,
    deferTerritoryUpdates: true,
  });
  engine._isReplayingBatch = true;
  try {
    for (const [index, point] of sourceFixture.moves.entries()) {
      const result = engine.playMove(point);
      assert.equal(result.success, true,
        `${rulesVersion}: prefix ${index + 1} ${pointKey(point)}: ${result.reason}`);
    }
  } finally {
    engine._isReplayingBatch = false;
  }
  assert.equal(engine.currentPlayer, sourceFixture.player);
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

function capture(engine) {
  // Materialize lazy territory before comparing all views of the same state.
  const publicSnapshot = engine.getSnapshot();
  return {
    publicSnapshot,
    ruleState: saveState(engine),
    replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch,
    autoSkip: engine._checkAndAutoSkip,
    moveProbeUndo: engine._moveProbeUndo,
  };
}

function material(engine, player) {
  const nodes = engine._getPlayerNodes(player).length;
  return { nodes, coverage: nodes + engine._getPlayerLines(player).length };
}

function canonicalDamagingCuts(engine, defender) {
  // Obtain real resulting Superko hashes from playMove on independent engines.
  // This oracle neither calls the threat estimator nor repeats its weights.
  const before = material(engine, defender);
  const ownLine = engine._getPlayerStates(defender).line;
  const cuts = [];
  for (const attacker of engine.activePlayers.filter((player) => player !== defender)) {
    for (const { point } of engine.getLegalMoves(attacker)) {
      if (engine._getState(point) !== ownLine) continue;
      const after = copyEngine(engine);
      after.currentPlayer = attacker;
      assert.equal(after.playMove(point).success, true, "oracle cut must be legal");
      const remaining = material(after, defender);
      if (remaining.nodes >= before.nodes && remaining.coverage >= before.coverage) continue;
      const newHashes = [...after.historyHashes].filter((hash) => !engine.historyHashes.has(hash));
      assert.equal(newHashes.length, 1, "one accepted move must add one new Superko hash");
      cuts.push({ attacker, point, hash: newHashes[0] });
    }
  }
  return cuts;
}

function attackKeys(engine, player) {
  return engine.getLegalMoves(player).filter(({ isAttack }) => isAttack)
    .map(({ point }) => pointKey(point)).sort();
}

function makeAutoSkipEngine(rulesVersion) {
  // Existing legal CONTROL-SKIP witness: every next WHITE move causes BLACK
  // to auto-skip. No turn or gameOver fields are forced by this test.
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion,
    deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of [[0, 4], [1, 3], [0, 3], [1, 2], [1, 0]]) {
    assert.equal(engine.playMove(point).success, true);
  }
  engine._isReplayingBatch = false;
  return engine;
}

function findCanonicalTerminalTransition(source) {
  // Complete this tiny, already blocked position with canonical legal moves.
  // Retain only the last real transition; no fabricated terminal state.
  let current = copyEngine(source);
  for (let step = 0; step < 24; step += 1) {
    assert.equal(current.gameOver, false);
    const point = current.getLegalMoves()[0]?.point;
    assert.ok(point, "the auto-skip witness must have a canonical continuation");
    const next = copyEngine(current);
    assert.equal(next.playMove(point).success, true);
    if (next.gameOver) return { before: current, point };
    current = next;
  }
  assert.fail("the tiny auto-skip witness must terminate within the bounded continuation");
}

function assertNoRootRiskAfterGuardedTransition(engine, point, expectedTerminal) {
  const player = engine.currentPlayer;
  const oracle = copyEngine(engine);
  assert.equal(oracle.playMove(point).success, true);
  assert.equal(oracle.gameOver, expectedTerminal, "canonical terminal expectation");
  if (!expectedTerminal) {
    assert.equal(oracle.currentPlayer, player, "canonical auto-skip must retain AI control");
    assert.equal(oracle.consecutiveSkips, 1);
  }
  const baseline = capture(engine);
  const originalPlayMove = engine.playMove;
  const originalGetNodes = engine._getPlayerNodes;
  let insideCanonicalTransition = false;
  const ai = new MinimaxAI(2);
  ai.orderMoves = (_engine, moves) => {
    assert.ok(moves.some((candidate) => pointKey(candidate) === pointKey(point)));
    return [point];
  };
  // Isolate the root contract from later search values. A guarded transition
  // must pass through its continuation value unchanged and must not probe a
  // counter-cut by a player who cannot take the next turn.
  ai.minimax = () => 123;
  engine.playMove = function canonicalTransition(...args) {
    insideCanonicalTransition = true;
    try { return originalPlayMove.apply(this, args); }
    finally { insideCanonicalTransition = false; }
  };
  engine._getPlayerNodes = function disallowPostTransitionRiskProbe(...args) {
    if (!insideCanonicalTransition && this.turnCount > baseline.ruleState.turnCount) {
      throw new Error("guarded root must not inspect counter-cut material");
    }
    return originalGetNodes.apply(this, args);
  };
  try {
    assert.deepEqual(ai.getTopMoves(engine, player, 1), [{ point, score: 123 }]);
  } finally {
    engine.playMove = originalPlayMove;
    engine._getPlayerNodes = originalGetNodes;
  }
  assert.deepEqual(capture(engine), baseline, "guarded root transition changed caller state");
}

const results = [];
for (const rulesVersion of [TerritoryRulesVersion.V2, TerritoryRulesVersion.V3]) {
  assert.ok(rulesVersion, "both territory rule versions must be available");
  const engine = makeEngine(rulesVersion);
  const baseline = capture(engine);
  const score = evaluateMinimax(engine, fixture.player);
  assert.ok(Number.isFinite(score), `${rulesVersion}: evaluation must be finite`);
  assert.deepEqual(capture(engine), baseline, `${rulesVersion}: normal evaluation changed state`);

  // Throw after the real mutation, both within canonical legality validation
  // and within the subsequent material-only probe.
  for (const inCanonicalProbe of [true, false]) {
    const originalAddNode = engine._addNode;
    let reached = false;
    engine._addNode = function failingAddNode(...args) {
      const success = originalAddNode.apply(this, args);
      if (success && Boolean(this._moveProbeUndo) === inCanonicalProbe) {
        reached = true;
        throw new Error("intentional cut-probe failure");
      }
      return success;
    };
    try {
      assert.throws(() => evaluateMinimax(engine, fixture.player), /intentional cut-probe failure/);
      assert.ok(reached, `${rulesVersion}: requested probe was not exercised`);
      assert.deepEqual(capture(engine), baseline,
        `${rulesVersion}: ${inCanonicalProbe ? "canonical" : "material"} probe failure leaked state`);
    } finally {
      engine._addNode = originalAddNode;
    }
  }

  const ai = new MinimaxAI(1);
  let reachedLeaf = false;
  ai.evaluate = (searchEngine) => {
    assert.ok(searchEngine.turnCount > baseline.ruleState.turnCount,
      "the leaf failure must occur after applying a real speculative move");
    reachedLeaf = true;
    throw new Error("intentional leaf-evaluation failure");
  };
  assert.throws(() => ai.getTopMoves(engine, fixture.player, 1), /intentional leaf-evaluation failure/);
  assert.ok(reachedLeaf, `${rulesVersion}: leaf failure was not exercised`);
  assert.deepEqual(capture(engine), baseline, `${rulesVersion}: leaf failure leaked state`);

  const depthOneFixture = fixtures.find(({ regression }) => regression === "uncompensated-defense");
  assert.ok(depthOneFixture, "the no-double-penalty check needs an uncompensated exposure");
  const depthOneEngine = makeEngine(rulesVersion, depthOneFixture);
  const depthOneBaseline = capture(depthOneEngine);
  const depthOneChoices = new MinimaxAI(1).getTopMoves(depthOneEngine, depthOneFixture.player, 100);
  assert.ok(depthOneChoices.some(({ point }) => pointKey(point) === pointKey(depthOneFixture.legacyMove)));
  for (const choice of depthOneChoices) {
    const after = copyEngine(depthOneEngine);
    assert.equal(after.playMove(choice.point).success, true);
    assert.equal(choice.score, evaluateMinimax(after, depthOneFixture.player),
      `${rulesVersion}: depth-1 root must equal the canonical leaf value without extra risk`);
  }
  const exposedLeaf = copyEngine(depthOneEngine);
  assert.equal(exposedLeaf.playMove(depthOneFixture.legacyMove).success, true);
  for (const opponent of depthOneEngine.activePlayers.filter((player) => player !== depthOneFixture.player)) {
    assert.deepEqual(material(exposedLeaf, opponent), material(depthOneEngine, opponent),
      "the exposed depth-1 choice must not receive immediate capture compensation");
  }
  assert.ok(canonicalDamagingCuts(exposedLeaf, depthOneFixture.player).length > 0,
    "depth-1 no-double-penalty witness must contain real counter-cut exposure");
  assert.deepEqual(capture(depthOneEngine), depthOneBaseline, `${rulesVersion}: depth-1 root checks changed state`);

  const chainEngine = copyEngine(engine);
  assert.equal(chainEngine.playMove(fixture.legacyMove).success, true,
    `${rulesVersion}: continuous-cut root witness must be legal`);
  const chainBaseline = capture(chainEngine);
  const chainRisk = boundedRootCutChainRisk(chainEngine, fixture.player);
  assert.ok(chainRisk, `${rulesVersion}: continuous-cut witness must stay within its bounds`);
  assert.equal(chainRisk.nodes, 1, `${rulesVersion}: one node must remain lost after the best response`);
  assert.equal(chainRisk.coverage, 0, `${rulesVersion}: no extra line coverage must remain lost`);
  assert.equal(chainRisk.firstCuts, 1, `${rulesVersion}: witness must have one damaging first cut`);
  assert.deepEqual(capture(chainEngine), chainBaseline,
    `${rulesVersion}: direct continuous-cut analysis changed state`);

  const originalChainPlayMove = chainEngine.playMove;
  let reachedChainMutation = false;
  chainEngine.playMove = function throwAfterChainMutation(...args) {
    const result = originalChainPlayMove.apply(this, args);
    if (!reachedChainMutation && result.success) {
      reachedChainMutation = true;
      throw new Error("intentional continuous-cut transition failure");
    }
    return result;
  };
  try {
    assert.throws(() => boundedRootCutChainRisk(chainEngine, fixture.player),
      /intentional continuous-cut transition failure/);
    assert.ok(reachedChainMutation, `${rulesVersion}: direct chain failure did not follow a real move`);
  } finally {
    chainEngine.playMove = originalChainPlayMove;
  }
  assert.deepEqual(capture(chainEngine), chainBaseline,
    `${rulesVersion}: direct continuous-cut exception leaked state`);

  const originalChainGetLegalMoves = chainEngine.getLegalMoves;
  let inflatedResponses = false;
  chainEngine.getLegalMoves = function forceResponseLimit(...args) {
    const moves = originalChainGetLegalMoves.apply(this, args);
    if (!inflatedResponses && this.currentPlayer === fixture.player
      && this.turnCount > chainBaseline.ruleState.turnCount) {
      assert.ok(moves.length > 0, "response-limit witness needs a real legal response");
      inflatedResponses = true;
      return Array.from({ length: 24 }, (_, index) => moves[index % moves.length]);
    }
    return moves;
  };
  let limitedRisk;
  try {
    limitedRisk = boundedRootCutChainRisk(chainEngine, fixture.player);
  } finally {
    chainEngine.getLegalMoves = originalChainGetLegalMoves;
  }
  assert.ok(inflatedResponses, `${rulesVersion}: response limit was not exercised`);
  assert.equal(limitedRisk, null, `${rulesVersion}: over-limit analysis must fail closed`);
  assert.deepEqual(capture(chainEngine), chainBaseline,
    `${rulesVersion}: response-limit fallback leaked state`);

  const chainCuts = canonicalDamagingCuts(chainEngine, fixture.player);
  assert.equal(chainCuts.length, 1,
    `${rulesVersion}: Superko chain witness must expose exactly one damaging first cut`);
  const blockedChain = copyEngine(chainEngine);
  blockedChain.historyHashes.add(chainCuts[0].hash);
  const blockedChainBaseline = capture(blockedChain);
  const blockedChainRisk = boundedRootCutChainRisk(blockedChain, fixture.player);
  assert.ok(blockedChainRisk, `${rulesVersion}: Superko-filtered chain must stay within bounds`);
  assert.equal(blockedChainRisk.firstCuts, 0,
    `${rulesVersion}: the history-blocked first cut must not enter the chain`);
  assert.equal(blockedChainRisk.nodes, 0);
  assert.equal(blockedChainRisk.coverage, 0);
  assert.deepEqual(capture(blockedChain), blockedChainBaseline,
    `${rulesVersion}: Superko-filtered chain analysis changed state`);

  const threePlayer = new GameEngine({
    gridSize: 5,
    playerCount: 3,
    rulesVersion,
    deferTerritoryUpdates: true,
  });
  const originalThreePlayerGetNodes = threePlayer._getPlayerNodes;
  threePlayer._getPlayerNodes = () => assert.fail("three-player guard must precede material access");
  try {
    assert.equal(boundedRootCutChainRisk(threePlayer, threePlayer.currentPlayer), null,
      `${rulesVersion}: two-player continuation must reject three surviving players`);
  } finally {
    threePlayer._getPlayerNodes = originalThreePlayerGetNodes;
  }

  // Inject failure specifically after a root move has really been applied,
  // outside playMove's own legality and auto-skip probes. This exercises the
  // new root-risk path separately from both move ordering and leaf evaluation.
  for (const inCanonicalProbe of [true, false]) {
    const rootAI = new MinimaxAI(2);
    rootAI.orderMoves = (_engine, moves) => {
      assert.ok(moves.some((point) => pointKey(point) === pointKey(fixture.legacyMove)));
      return [fixture.legacyMove];
    };
    rootAI.minimax = () => assert.fail("root risk failure must precede recursive search");
    const originalPlayMove = engine.playMove;
    const originalAddNode = engine._addNode;
    let insideCanonicalTransition = false;
    let reachedRootProbe = false;
    engine.playMove = function rootTransition(...args) {
      insideCanonicalTransition = true;
      try { return originalPlayMove.apply(this, args); }
      finally { insideCanonicalTransition = false; }
    };
    engine._addNode = function failingRootProbe(...args) {
      const success = originalAddNode.apply(this, args);
      if (success && !insideCanonicalTransition
        && this.turnCount > baseline.ruleState.turnCount
        && Boolean(this._moveProbeUndo) === inCanonicalProbe) {
        reachedRootProbe = true;
        throw new Error("intentional root-risk probe failure");
      }
      return success;
    };
    try {
      assert.throws(() => rootAI.getTopMoves(engine, fixture.player, 1), /intentional root-risk probe failure/);
      assert.ok(reachedRootProbe, `${rulesVersion}: root risk probe was not exercised`);
    } finally {
      engine.playMove = originalPlayMove;
      engine._addNode = originalAddNode;
    }
    assert.deepEqual(capture(engine), baseline,
      `${rulesVersion}: ${inCanonicalProbe ? "canonical" : "material"} root risk probe leaked state`);
  }

  const autoSkipEngine = makeAutoSkipEngine(rulesVersion);
  const autoSkipPoint = autoSkipEngine.getLegalMoves()[0].point;
  assertNoRootRiskAfterGuardedTransition(autoSkipEngine, autoSkipPoint, false);
  const terminalTransition = findCanonicalTerminalTransition(autoSkipEngine);
  assertNoRootRiskAfterGuardedTransition(terminalTransition.before, terminalTransition.point, true);

  const cuts = canonicalDamagingCuts(engine, fixture.player);
  assert.ok(cuts.length > 0, `${rulesVersion}: fixture must have a real damaging cut`);
  const blocked = copyEngine(engine);
  for (const { hash } of cuts) blocked.historyHashes.add(hash);
  assert.deepEqual(blocked.grid, engine.grid, "changing history must preserve the board");
  assert.deepEqual(blocked.edges, engine.edges, "changing history must preserve all edges");
  assert.deepEqual(attackKeys(blocked, fixture.player), attackKeys(engine, fixture.player),
    "the defender's attack opportunities must remain unchanged");
  for (const { attacker, point } of cuts) {
    const rejected = copyEngine(blocked);
    rejected.currentPlayer = attacker;
    const before = capture(rejected);
    const result = rejected.playMove(point);
    assert.equal(result.success, false, "a previously seen cut position must be rejected");
    assert.equal(result.reason, "SUPERKO_VIOLATION", "the cut must be blocked by real Superko");
    assert.deepEqual(capture(rejected), before, "rejected canonical move changed state");
  }
  assert.equal(canonicalDamagingCuts(blocked, fixture.player).length, 0,
    "no damaging cut may remain legal in the augmented history");
  const blockedBaseline = capture(blocked);
  const blockedScore = evaluateMinimax(blocked, fixture.player);
  assert.ok(Number.isFinite(blockedScore));
  assert.ok(blockedScore > score,
    "removing all legal cutting threats must improve an otherwise identical position's score");
  assert.deepEqual(capture(blocked), blockedBaseline, "Superko-aware evaluation changed state");
  assert.deepEqual(capture(engine), baseline, "independent oracle changed its input");

  results.push({
    rulesVersion,
    normalEvaluationRestored: true,
    canonicalProbeFailureRestored: true,
    materialProbeFailureRestored: true,
    leafFailureRestored: true,
    depthOneHasNoExtraRootRisk: true,
    directChainRestored: true,
    directChainFailureRestored: true,
    responseLimitFailsClosed: true,
    chainSuperkoFiltered: true,
    twoSurvivorGuarded: true,
    canonicalRootProbeFailureRestored: true,
    materialRootProbeFailureRestored: true,
    autoSkipRootRiskSkipped: true,
    terminalRootRiskSkipped: true,
    superkoBlockedCuts: cuts.length,
    superkoRiskFiltered: true,
  });
}

console.log(JSON.stringify({ status: "PASS", scope: "DEFENSE-STATE-AND-SUPERKO-INVARIANTS", results }, null, 2));
