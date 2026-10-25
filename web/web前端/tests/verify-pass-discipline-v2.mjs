import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { isolatedSearchEngine } from "../MultiplayerSearch.js";
import { applyPassDiscipline as applyV1, withPassDiscipline as wrapV1, nativeDiscreteAreas } from "../AIPassDiscipline.js";
import { applyPassDiscipline, withPassDiscipline, PASS_DISCIPLINE_CONTRACT, passDisciplineRuleState,
  passDisciplineStateHash, passDisciplineAsciiSha256, protectedRootInvariantHolds } from "../AIPassDisciplineV2.js";
import { engineFromTrainingState } from "../../tools/defensive-training-data-v1.mjs";
import { PASS_DISCIPLINE_CONTRACT as PRODUCT_PASS_CONTRACT } from "../AIPassDisciplineV3.js";
import { chooseRoomBotMove, installLocalModelAssetFetch } from "../../tools/online_bot_runtime.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/pass-discipline-v2-real-states.json", import.meta.url), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
const pass = { type: "pass", point: null, score: 100, prior: 1, visits: 1 };
const key = point => point.join(",");
const own = (engine, player) => ({ nodes: new Set(engine._getPlayerNodes(player).map(key)),
  coverage: new Set([...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)].map(key)) });
const restore = entry => {
  const game = fixture.games[entry.gameId], engine = engineFromTrainingState(game.openingState);
  for (const action of game.prefix.slice(0, entry.ply)) {
    assert.equal(engine.currentPlayer, action.actor);
    assert.equal((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success, true);
  }
  return engine;
};
const unchanged = (source, fn) => {
  const before = saveState(source), cache = source.cachedTerritories;
  try { return fn(); } finally { assert.deepEqual(saveState(source), before); assert.equal(source.cachedTerritories, cache); }
};
for (const value of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000)])
  assert.equal(passDisciplineAsciiSha256(value), `sha256:${sha(value)}`, "Independent Node SHA-256 standard/block-boundary vectors");
assert.throws(() => passDisciplineAsciiSha256("\u4e2d"), /Non-ASCII/);
const rows = [];
installLocalModelAssetFetch();
const messages = [];
globalThis.self = { postMessage: message => messages.push(message) };
await import("../AIWorker.js?pass-discipline-v2-real-regressions");
const compute = self.onmessage;
for (const entry of fixture.cases) {
  const engine = restore(entry), actor = engine.currentPlayer;
  assert.equal(actor, entry.actor);
  assert.equal(sha(JSON.stringify(serializeEngineState(engine))), entry.originalStateSha256, "Versioned compact fixture reproduces the original failed state");
  assert.equal(passDisciplineStateHash(engine), `sha256:${sha(JSON.stringify(passDisciplineRuleState(engine)))}`);
  const old = unchanged(engine, () => applyV1(engine, [pass], { timeMs: 1000, topN: 1 }));
  assert.equal(old.moves[0].point, null); assert.equal(old.receipt.witness, null);
  const result = unchanged(engine, () => applyPassDiscipline(engine, [pass], { timeMs: 1000, topN: 1 }));
  assert.deepEqual(result.moves[0].point, entry.expectedPoint);
  assert.equal(result.receipt.schema, PASS_DISCIPLINE_CONTRACT.schema);
  assert.equal(result.receipt.passWouldEnd, false);
  assert.equal(result.receipt.witness.completeOpponentRound, false);
  assert.equal(result.receipt.witness.replyActionsCompleted, undefined, "Structural proof must not fabricate enumerated replies");
  assert.equal(result.receipt.witness.proofType, "immutable-birth-root-protection-invariant");
  assert.equal(result.receipt.witness.minimumReplyAreaLowerBound, entry.minimumArea);
  assert.equal(result.receipt.sourceStateHash, passDisciplineStateHash(engine));
  const before = own(engine, actor), beforeArea = nativeDiscreteAreas(engine, [actor])[actor];
  const after = isolatedSearchEngine(engine); assert.equal(after.playMove(result.moves[0].point).success, true);
  assert.equal(result.receipt.witness.postRootStateHash, `sha256:${sha(JSON.stringify(passDisciplineRuleState(after)))}`);
  assert.equal(protectedRootInvariantHolds(after, actor, before, beforeArea), true);
  const held = own(after, actor);
  // Independent logical-edge BFS (no guard helper), then the canonical rule's
  // protection predicate for every enemy actor and every friendly line cell.
  const adjacency = new Map();
  for (const edge of after.edges[actor]) {
    const [a, b] = edge.split("|");
    for (const [from, to] of [[a,b],[b,a]]) { if (!adjacency.has(from)) adjacency.set(from, []); adjacency.get(from).push(to); }
  }
  const connected = new Set([key(after.initialPositions[actor])]), queue = [...connected];
  for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]) ?? [])
    if (!connected.has(next)) { connected.add(next); queue.push(next); }
  assert.ok([...held.nodes].every(node => connected.has(node)));
  for (const line of after._getPlayerLines(actor)) for (const enemy of after.activePlayers.filter(player => player !== actor))
    assert.equal(after._isInProtectionZone(line, enemy), true);
  assert.ok(held.coverage.size > beforeArea);
  // Counterexamples refute individual structural premises without modifying
  // frozen rules, changing a golden result, or weakening the original guard.
  assert.equal(protectedRootInvariantHolds(after, actor, before, held.coverage.size), false, "No strict occupied-area gain");
  const disconnected = isolatedSearchEngine(after), empty = disconnected.validPositions.find(point => disconnected._getState(point) === 0);
  if (empty) { disconnected._setState(empty, disconnected._getPlayerStates(actor).node);
    assert.equal(protectedRootInvariantHolds(disconnected, actor, before, beforeArea), false, "Disconnected node cannot be certified"); }
  const unprotected = isolatedSearchEngine(after), far = unprotected.validPositions.find(point => unprotected._getState(point) === 0
    && !unprotected.getAdjacentPositions(unprotected.initialPositions[actor]).some(p => key(p) === key(point)));
  if (far) { unprotected._setState(far, unprotected._getPlayerStates(actor).line);
    assert.equal(protectedRootInvariantHolds(unprotected, actor, before, beforeArea), false, "Attackable friendly line cannot be certified"); }
  const lost = { nodes: new Set([...before.nodes, "-1,-1"]), coverage: before.coverage };
  assert.equal(protectedRootInvariantHolds(after, actor, lost, beforeArea), false, "Every previous node must survive");
  assert.equal(protectedRootInvariantHolds(after, actor, { nodes: before.nodes, coverage: new Set([...before.coverage, "-1,-1"]) }, beforeArea), false,
    "Every previous coverage point must survive");
  const terminalPass = restore(entry); terminalPass.consecutiveSkips = terminalPass._getRemainingPlayers().length - 1;
  const terminalResult = unchanged(terminalPass, () => applyPassDiscipline(terminalPass, [pass], { timeMs: 1000 }));
  assert.notEqual(terminalResult.receipt.schema, PASS_DISCIPLINE_CONTRACT.schema, "Immediately ending PASS keeps v1 margin proof");
  assert.equal(terminalResult.receipt.passWouldEnd, true);
  if (terminalResult.receipt.witness) assert.equal(terminalResult.receipt.witness.completeOpponentRound, true);
  const room = await chooseRoomBotMove(engine, { strategy: "multiplayer", modelId: "multiplayer-easy-v1" });
  assert.ok(Array.isArray(room.point), "Room bot uses a certified placement instead of the old PASS");
  assert.equal(room.searchStats.passDiscipline.schema, PRODUCT_PASS_CONTRACT.schema);
  messages.length = 0;
  await compute({ data: { type: "COMPUTE", strategy: "multiplayer", modelId: "multiplayer-easy-v1",
    serializedState: serializeEngineState(engine), aiPlayer: actor, requestId: entry.ply, topN: 1 } });
  const answer = messages.find(message => message.type === "RESULT");
  assert.ok(answer, JSON.stringify(messages));
  assert.deepEqual(answer.moves[0].point, room.point, "Web Worker and room adapter preserve the same policy alternative order");
  assert.equal(answer.requestId, entry.ply); assert.equal(answer.positionRevision, engine.positionRevision);
  assert.equal(answer.searchStats.passDiscipline.schema, PRODUCT_PASS_CONTRACT.schema);
  assert.equal(passDisciplineStateHash(engine), result.receipt.sourceStateHash);
  rows.push({ gameId: entry.gameId, ply: entry.ply, point: entry.expectedPoint, sourceStateHash: result.receipt.sourceStateHash });
}
const sample = restore(fixture.cases[0]);
for (const budget of [{ timeMs: 0 }, { maxNodes: 0 }, { maxNodes: 1 }, { maxNodes: 2 }]) {
  const result = unchanged(sample, () => applyPassDiscipline(sample, [pass], budget));
  assert.equal(result.moves[0], pass); assert.equal(result.receipt.witness, null);
}
let ticks = 0;
const timed = unchanged(sample, () => applyPassDiscipline(sample, [pass], { timeMs: 1, now: () => ticks++ }));
assert.equal(timed.moves[0], pass); assert.equal(timed.receipt.witness, null);
const placement = { point: sample.getLegalMoves()[0].point, score: 1 };
assert.equal(applyPassDiscipline(sample, [placement], { timeMs: 0 }).moves[0], placement);
unchanged(sample, () => assert.throws(() => applyPassDiscipline(sample, [], { timeMs: 0 }), error => error.code === "AI_NO_RELIABLE_ACTION"));
let rawCalls = 0;
const raw = { getTopMoves: () => { rawCalls++; return [pass]; } }, nested = withPassDiscipline(wrapV1(raw));
assert.equal(withPassDiscipline(nested), nested);
assert.deepEqual(nested.getTopMoves(sample, sample.currentPlayer, 1)[0].point, fixture.cases[0].expectedPoint);
assert.equal(rawCalls, 1, "Nested adapters cannot run or bypass the decision guard twice");
assert.equal(nested.getTopMoves(sample, sample.currentPlayer, 1, { passDisciplinePrechecked: true })[0], pass);
const history = isolatedSearchEngine(sample); history.historyHashes.add("different-superko-history");
assert.notEqual(passDisciplineStateHash(history), passDisciplineStateHash(sample));
console.log(JSON.stringify({ status: "PASS_DISCIPLINE_V2_REAL_STATE_REGRESSIONS", actualStates: rows,
  legacyTerminalMarginPreserved: true, structuralPremiseCounterexamples: true, sharedBudgets: true,
  independentSha256: true, roomAndWebWorker: true, sourceUnchanged: true }));
