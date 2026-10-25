import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { passDisciplineStateHash, passDisciplineRuleState } from "../AIPassDisciplineV2.js";
import { applyPassDiscipline, withPassDiscipline, PASS_DISCIPLINE_CONTRACT } from "../AIPassDisciplineV3.js";
import { engineFromTrainingState } from "../../tools/defensive-training-data-v1.mjs";
import { chooseRoomBotMove, installLocalModelAssetFetch } from "../../tools/online_bot_runtime.mjs";
const fixture = JSON.parse(await readFile(new URL("./fixtures/pass-discipline-v3-real-states.json", import.meta.url), "utf8"));
const pass = { type: "pass", point: null, score: 100, visits: 1 }, rows = [];
const restore = entry => {
  const engine = engineFromTrainingState(fixture.openingState);
  for (const action of fixture.prefix.slice(0, entry.ply)) {
    assert.equal(engine.currentPlayer, action.actor);
    assert.equal((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success, true);
  }
  return engine;
};
installLocalModelAssetFetch();
const messages = []; globalThis.self = { postMessage: message => messages.push(message) };
await import("../AIWorker.js?pass-discipline-v3-real-regressions"); const compute = self.onmessage;
for (const entry of fixture.cases) {
  const source = restore(entry), before = saveState(source);
  const result = applyPassDiscipline(source, [pass], { topN: 1 });
  assert.deepEqual(result.moves[0].point, entry.expectedPoint);
  const receipt = result.receipt;
  assert.equal(receipt.schema, PASS_DISCIPLINE_CONTRACT.schema);
  assert.equal(receipt.witness.proofOrder, "bounded-structural-precheck-before-V2");
  assert.equal(receipt.witness.minimumReplyAreaLowerBound, entry.minimumArea);
  assert.equal(receipt.witness.completeOpponentRound, false);
  assert.equal(receipt.legacyReceipt, undefined);
  assert.equal(receipt.witness.replyActionsCompleted, undefined);
  assert.ok(receipt.rootsExamined <= 12);
  assert.ok(receipt.quickElapsedMs <= receipt.quickBudgetMs && receipt.quickBudgetMs <= 8);
  assert.ok(receipt.quickBudgetMs <= 200 * 0.05);
  assert.ok(receipt.totalElapsedMs >= receipt.setupAndPassElapsedMs + receipt.quickElapsedMs);
  assert.ok(receipt.totalElapsedMs < 200);
  assert.equal(receipt.sourceStateHash, `sha256:${createHash('sha256').update(JSON.stringify(passDisciplineRuleState(source))).digest('hex')}`);
  assert.deepEqual(saveState(source), before);
  const room = await chooseRoomBotMove(source, { strategy: "hex-player", modelId: "hex-player-policy-v1" });
  assert.deepEqual(room.point, entry.expectedPoint); assert.equal(room.searchStats.passDiscipline.schema, receipt.schema);
  messages.length = 0;
  await compute({ data: { type: "COMPUTE", strategy: "hex-player", modelId: "hex-player-policy-v1",
    serializedState: serializeEngineState(source), aiPlayer: entry.actor, requestId: entry.ply, topN: 1 } });
  const answer = messages.find(message => message.type === "RESULT"); assert.ok(answer, JSON.stringify(messages));
  assert.deepEqual(answer.moves[0].point, entry.expectedPoint); assert.equal(answer.searchStats.passDiscipline.schema, receipt.schema);
  assert.equal(answer.requestId, entry.ply); assert.equal(answer.positionRevision, source.positionRevision);
  assert.deepEqual(saveState(source), before);
  rows.push({ ply: entry.ply, point: result.moves[0].point, setupAndPassElapsedMs: receipt.setupAndPassElapsedMs,
    quickElapsedMs: receipt.quickElapsedMs, totalElapsedMs: receipt.totalElapsedMs, sourceStateHash: receipt.sourceStateHash });
}
const sample = restore(fixture.cases[0]);
for (const budget of [{ timeMs: 0 }, { maxNodes: 0 }, { maxNodes: 1 }]) {
  const result = applyPassDiscipline(sample, [pass], budget);
  assert.equal(result.moves[0], pass); assert.equal(result.receipt.witness, null);
}
let clockCalls = 0;
const slowSetup = applyPassDiscipline(sample, [pass], { topN: 1, now: () => {
  clockCalls++; return clockCalls < 4 ? clockCalls * 4 : 16 + (clockCalls - 4) * 0.001;
} });
assert.equal(slowSetup.receipt.schema, PASS_DISCIPLINE_CONTRACT.schema);
assert.ok(slowSetup.receipt.setupAndPassElapsedMs >= 8, "Canonical PASS preflight does not starve the bounded root-search window");
assert.ok(slowSetup.receipt.quickElapsedMs < 8);
let ticks = 0;
const exhausted = applyPassDiscipline(sample, [pass], { timeMs: 1, now: () => ticks++ });
assert.equal(exhausted.moves[0], pass); assert.equal(exhausted.receipt.witness, null);
assert.throws(() => applyPassDiscipline(sample, [], { timeMs: 0 }), error => error.code === "AI_NO_RELIABLE_ACTION");
const placement = { point: sample.getLegalMoves()[0].point, score: 1 };
assert.equal(applyPassDiscipline(sample, [placement], { timeMs: 0 }).moves[0], placement);
const terminalPass = restore(fixture.cases[0]); terminalPass.consecutiveSkips = terminalPass._getRemainingPlayers().length - 1;
const terminal = applyPassDiscipline(terminalPass, [pass], { timeMs: 1000 });
assert.notEqual(terminal.receipt.schema, PASS_DISCIPLINE_CONTRACT.schema);
assert.equal(terminal.receipt.passWouldEnd, true);
if (terminal.receipt.witness) assert.equal(terminal.receipt.witness.completeOpponentRound, true);
const unsafe = new GameEngine({ gridSize: 5, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
for (const point of [[2,0],[2,2],[0,1],[2,1]]) assert.equal(unsafe.playMove(point).success, true);
const rejected = applyPassDiscipline(unsafe, [pass], { timeMs: 1000 });
assert.equal(rejected.moves[0], pass); assert.equal(rejected.receipt.witness, null);
assert.ok(rejected.receipt.productQuickProbe.rootsExamined <= 12);
let rawCalls = 0;
const wrapped = withPassDiscipline({ getTopMoves() { rawCalls++; return [pass]; } });
assert.equal(withPassDiscipline(wrapped), wrapped);
assert.deepEqual(wrapped.getTopMoves(sample, sample.currentPlayer, 1)[0].point, [4,7]); assert.equal(rawCalls, 1);
assert.equal(wrapped.getTopMoves(sample, sample.currentPlayer, 1, { passDisciplinePrechecked: true })[0], pass);
console.log(JSON.stringify({ status: "PASS_DISCIPLINE_V3_REAL_HEX_REGRESSIONS", rows,
  sharedBudgetAndSlowPreflight: true, terminalMarginUnchanged: true, unsafeAndMissingOutputPreserved: true,
  roomAndWebWorker: true, sourceUnchanged: true }));
