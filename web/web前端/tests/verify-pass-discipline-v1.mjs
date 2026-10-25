import assert from "node:assert/strict";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { isolatedSearchEngine } from "../MultiplayerSearch.js";
import { randomInitialPositions } from "../StartingPoints.js";
import { PASS_DISCIPLINE_CONTRACT, nativeDiscreteAreas, assessPassAlternatives,
  applyPassDiscipline, withPassDiscipline } from "../AIPassDiscipline.js";
import { FastMultiplayerPolicy, prepareStandardDefenseRanking } from "../MultiplayerRuntime.js";

const pass = { type: "pass", point: null, score: 100, prior: 0.99, visits: 1 };
const cases = [];
const engine = (rulesVersion = "territory-v3", playerCount = 2) =>
  new GameEngine({ gridSize: 5, playerCount, rulesVersion, deferTerritoryUpdates: true });
const own = (source, actor) => new Set([...source._getPlayerNodes(actor), ...source._getPlayerLines(actor)].map(p => p.join(",")));

function unchanged(source, operation) {
  const before = saveState(source), cache = source.cachedTerritories;
  try { return operation(); }
  finally {
    assert.deepEqual(saveState(source), before, "Guard must preserve complete source state/history/edges/cache");
    assert.equal(source.cachedTerritories, cache, "Guard must not replace the source cache");
  }
}

// Independently enumerate the canonical full round from a produced witness.
// This is bounded fixture verification, not a substitute for deep Minimax.
function replayWitness(source, receipt) {
  assert.equal(receipt.status, "safe-profitable-expansion");
  const { witness } = receipt, actor = source.currentPlayer;
  assert.equal(witness.completeOpponentRound, true);
  assert.equal(witness.replyWindow, "one-complete-actual-opponent-round");
  assert.equal(witness.replyActionsCompleted, witness.replyActionsTotal);
  const trial = isolatedSearchEngine(source);
  assert.equal(trial.playMove(witness.point).success, true);
  const retained = own(trial, actor), nodes = new Set(trial._getPlayerNodes(actor).map(p => p.join(",")));
  let actions = 0, leaves = 0, maximumDepth = 0;
  function inspect(state, depth, seen) {
    maximumDepth = Math.max(maximumDepth, depth);
    const pieces = own(state, actor), connected = state._getOpponentConnectedPieces(actor);
    assert.ok([...retained].every(p => pieces.has(p)), "Later opponent cut invalidates witness");
    assert.ok([...nodes].every(p => connected.has(p)), "Witness must remain connected to its initial node");
    const area = nativeDiscreteAreas(state, [actor])[actor];
    assert.ok(witness.profitKind === "strict-native-area-gain" ? area > witness.beforeArea : area >= witness.beforeArea);
    if (state.gameOver || state.currentPlayer === actor) { leaves++; return; }
    assert.ok(!seen.has(state.currentPlayer), "A certificate cannot stop after auto-skipping the original actor");
    const visited = new Set(seen); visited.add(state.currentPlayer);
    for (const point of [...state.getLegalMoves().map(m => m.point), null]) {
      const next = isolatedSearchEngine(state);
      assert.equal((point === null ? next.skipTurn() : next.playMove(point)).success, true);
      actions++; inspect(next, depth + 1, visited);
    }
  }
  inspect(trial, 0, new Set());
  assert.equal(witness.replyActionsCompleted, actions);
  assert.equal(witness.replyLeavesCompleted, leaves);
  assert.equal(witness.maxReplyPlies, maximumDepth);
}

for (const rulesVersion of ["territory-v2", "territory-v3"]) for (const playerCount of [2, 3]) {
  const source = engine(rulesVersion, playerCount);
  const result = unchanged(source, () => applyPassDiscipline(source, [pass], { timeMs: 1000, topN: 1 }));
  assert.ok(Array.isArray(result.moves[0].point), "Opening must use a fully witnessed development opportunity");
  assert.equal(result.moves[0].passDiscipline.schema, PASS_DISCIPLINE_CONTRACT.schema);
  replayWitness(source, result.receipt);
  cases.push({ rulesVersion, playerCount, opening: true, replyPlies: result.receipt.witness.replyPlies });
}

for (const playerCount of [2, 3]) {
  const source = engine("territory-v3", playerCount), actor = source.currentPlayer;
  assert.equal(source.playMove([1, 0]).success, true);
  while (!source.gameOver && source.currentPlayer !== actor) assert.equal(source.skipTurn().success, true);
  const terminal = isolatedSearchEngine(source);
  assert.equal(terminal.skipTurn().success, true); assert.equal(terminal.gameOver, true);
  assert.equal(terminal.getWinner(), actor);
  const result = unchanged(source, () => applyPassDiscipline(source, [pass], { timeMs: 1000, topN: 1 }));
  assert.equal(result.receipt.passWouldEnd, true);
  assert.ok(Array.isArray(result.moves[0].point), "Winning PASS cannot bypass a witnessed safe profitable expansion");
  assert.ok(result.receipt.witness.minimumReplyMargin > 0);
  replayWitness(source, result.receipt);
  cases.push({ playerCount, winningSafeGrowth: true });
}

// Fully legal later-seat counterexample to a next-opponent-only guard.
{
  const source = new GameEngine({ playerCount: 3, gridSize: 7, boardShape: "triangle", rulesVersion: "territory-v3",
    initialPositions: { BLACK: [0, 0], WHITE: [6, 0], PURPLE: [3, 3] }, deferTerritoryUpdates: true });
  const cut = isolatedSearchEngine(source);
  assert.equal(cut.playMove([0, 4]).success, true);
  assert.equal(nativeDiscreteAreas(cut).BLACK, 5);
  assert.equal(cut.skipTurn().success, true); assert.equal(cut.currentPlayer, "PURPLE");
  assert.equal(cut.playMove([0, 3]).success, true); assert.equal(nativeDiscreteAreas(cut).BLACK, 1);
  const result = unchanged(source, () => applyPassDiscipline(source, [pass, { point: [0, 4], score: 50 }], { timeMs: 1000, topN: 1 }));
  assert.notDeepEqual(result.moves[0].point, [0, 4], "WHITE-only evidence must not force a PURPLE-vulnerable root");
  assert.equal(result.receipt.examinedRoots, 2);
  assert.deepEqual(result.receipt.witness.actualReplyActors, ["WHITE", "PURPLE"]);
  replayWitness(source, result.receipt);
  cases.push({ thirdSeatCutRejected: true });
}

{
  const source = engine();
  for (const point of [[2, 0], [2, 2], [0, 1], [2, 1]]) assert.equal(source.playMove(point).success, true);
  assert.ok(source.getLegalMoves().length > 0);
  const result = unchanged(source, () => applyPassDiscipline(source, [pass], { timeMs: 1000 }));
  assert.equal(result.receipt.status, "no-certified-expansion");
  assert.equal(result.moves[0], pass, "Real policy PASS survives when every placement fails the safety contract");
  unchanged(source, () => assert.throws(() => applyPassDiscipline(source, [], { timeMs: 1000 }), error =>
    error.code === "AI_NO_RELIABLE_ACTION" && error.passDiscipline.status === "no-certified-expansion"));
  cases.push({ tacticalPassPreserved: true, missingActionIsError: true });
}

{
  const source = engine();
  for (const budget of [{ timeMs: 0 }, { maxNodes: 0 }, { maxNodes: 1 }]) {
    const result = unchanged(source, () => applyPassDiscipline(source, [pass], budget));
    assert.equal(result.receipt.status, "incomplete"); assert.equal(result.receipt.witness, null);
    assert.equal(result.moves[0], pass, "Incomplete proof must not invent safe growth");
    unchanged(source, () => assert.throws(() => applyPassDiscipline(source, [], budget), error => error.code === "AI_NO_RELIABLE_ACTION"));
  }
  let calls = 0;
  unchanged(source, () => assert.throws(() => assessPassAlternatives(source, source.currentPlayer,
    { now: () => { if (++calls === 5) throw new Error("injected-clock-failure"); return 0; } }), /injected-clock-failure/));
  const placement = { point: source.getLegalMoves()[0].point, score: 1 };
  assert.equal(applyPassDiscipline(source, [placement], { timeMs: 0 }).moves[0], placement);
  assert.deepEqual(applyPassDiscipline(source, [pass], { topN: 0 }).moves, []);
  const wrapped = withPassDiscipline({ getTopMoves: () => [pass] });
  assert.equal(withPassDiscipline(wrapped), wrapped);
  assert.equal(wrapped.getTopMoves(source, source.currentPlayer, 1, { passDisciplinePrechecked: true })[0], pass);
  cases.push({ deadlineAndNodeBudgetFailClosed: true, exceptionStatePreserved: true });
}

{
  const source = engine(), legal = source.getLegalMoves();
  for (const { point } of legal) {
    const trial = isolatedSearchEngine(source), previous = new Set(source.historyHashes);
    assert.equal(trial.playMove(point).success, true);
    for (const hash of trial.historyHashes) if (!previous.has(hash)) source.historyHashes.add(hash);
  }
  assert.equal(source.getLegalMoves().length, 0);
  const forced = unchanged(source, () => applyPassDiscipline(source, []));
  assert.equal(forced.receipt.status, "forced-pass"); assert.equal(forced.moves[0].point, null);
  const crowded = new GameEngine({ gridSize: 5, playerCount: 15, boardShape: "triangle", rulesVersion: "territory-v3",
    initialPositions: randomInitialPositions(5, 15, () => 0, "triangle") });
  assert.equal(unchanged(crowded, () => applyPassDiscipline(crowded, [])).receipt.status, "forced-pass");
  const terminal = isolatedSearchEngine(source);
  while (!terminal.gameOver) assert.equal(terminal.skipTurn().success, true);
  assert.deepEqual(applyPassDiscipline(terminal, [pass]).moves, []);
  cases.push({ superkoForcedPass: true, fifteenSeatForcedPass: true, terminalStops: true });
}

{
  const source = engine("territory-v3", 3), spec = { weights: Array(16).fill(0), passBias: 10, temperature: 2 };
  const policy = new FastMultiplayerPolicy(spec), ranking = policy.getFullRanking(source, source.currentPlayer, { includeFeatures: true });
  const before = structuredClone(ranking);
  const raw = unchanged(source, () => policy.getTopMoves(source, source.currentPlayer, 100));
  assert.equal(raw[0].point, null); assert.equal(raw[0].score, 5);
  assert.ok(Math.abs(raw.reduce((sum, m) => sum + m.prior, 0) - 1) < 1e-12);
  assert.equal(ranking.length, source.getLegalMoves().length); assert.ok(ranking.every(m => Array.isArray(m.point)));
  assert.deepEqual(ranking, before);
  const prepared = prepareStandardDefenseRanking(policy, source, source.currentPlayer, 5);
  assert.equal(prepared.original[0].point, null); assert.ok(prepared.completeRanking.every(m => Array.isArray(m.point)));
  assert.ok(prepared.completeRanking.every(m => m.features?.length === 16));
  assert.ok(new FastMultiplayerPolicy(spec, { includePass: false }).getTopMoves(source, source.currentPlayer, 100).every(m => m.point !== null));
  assert.ok(new FastMultiplayerPolicy({ weights: spec.weights, temperature: 1 }).getTopMoves(source, source.currentPlayer, 100).every(m => m.point !== null));
  cases.push({ finitePassBiasOptIn: true, placementFullRankingPreserved: true });
}

console.log(JSON.stringify({ status: "PASS_AI_PASS_DISCIPLINE_V1", cases, scope: PASS_DISCIPLINE_CONTRACT.safetyScope,
  limitation: "Bounded one-round runtime guard; incomplete proofs preserve real policy PASS and do not certify safety beyond that round." }));
