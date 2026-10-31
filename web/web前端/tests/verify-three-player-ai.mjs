import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { restoreState, saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { createThreePlayerModel, ThreePlayerAI, threePlayerCandidates } from "../ThreePlayerAI.js";

const modelBytes = await readFile(new URL("../assets/research-ai/three-player-policy-v1.json", import.meta.url));
const payload = JSON.parse(modelBytes);
const receipt = JSON.parse(await readFile(new URL("../assets/research-ai/three-player-policy-v1.training-receipt.json", import.meta.url)));
assert.equal(receipt.status, "TRAINING-COMPLETE");
assert.equal(createHash("sha256").update(modelBytes).digest("hex"), receipt.model_sha256);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const [path, hash] of Object.entries(payload.training.source_hashes)) {
  assert.equal(createHash("sha256").update(await readFile(resolve(root, path))).digest("hex"), hash,
    `training source must match the shipped implementation: ${path}`);
}
assert.ok(payload.training.two_player_samples >= 50);
assert.ok(payload.training.three_player_samples >= 100);
assert.ok(payload.training.final_heldout_cross_entropy < payload.training.initial_heldout_cross_entropy,
  "held-out imitation loss should improve over the untrained uniform policy; this is not a strength claim");
const model = createThreePlayerModel(payload);
const ai = new ThreePlayerAI(model);
const state = (engine) => JSON.stringify({ rules: serializeEngineState(engine), snapshot: saveState(engine), replay: engine._isReplayingBatch });
const timings = [];

for (const gridSize of [5, 9, 15]) {
  for (const player of ["BLACK", "WHITE", "PURPLE"]) {
    const engine = new GameEngine({ gridSize, playerCount: 3, rulesVersion: "territory-v2", startPlayer: player });
    const before = state(engine);
    const legal = new Set(engine.getLegalMoves(player).map((move) => move.point.join(",")));
    const started = performance.now();
    const moves = ai.getTopMoves(engine, player, 999);
    timings.push({ gridSize, player, milliseconds: Math.round(performance.now() - started) });
    assert.equal(moves.length, legal.size);
    assert.ok(moves.every((move) => legal.has(move.point.join(",")) && Number.isFinite(move.score)));
    assert.ok(Math.abs(moves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-10);
    assert.equal(state(engine), before, `${gridSize}/${player}: search must preserve the complete state`);
  }
}

// Consecutive AI turns and later positions, including canonical skips and end.
const games = [];
for (const aiCount of [1, 2]) for (const humanPlayer of ["BLACK", "WHITE", "PURPLE"]) {
  const engine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" });
  const aiSeats = new Set(aiCount === 1 ? [humanPlayer] : ["BLACK", "WHITE", "PURPLE"].filter((player) => player !== humanPlayer));
  let aiTurns = 0, humanTurns = 0;
  for (let turn = 0; turn < 150 && !engine.gameOver; turn++) {
    const before = state(engine), player = engine.currentPlayer;
    const moves = aiSeats.has(player) ? ai.getTopMoves(engine, player, 1) : engine.getLegalMoves(player);
    assert.equal(state(engine), before);
    if (!moves.length) engine.skipTurn();
    else assert.equal(engine.playMove(moves[0].point).success, true);
    if (aiSeats.has(player)) aiTurns++; else humanTurns++;
  }
  assert.equal(engine.gameOver, true, "small-board match must finish within the bounded fixture");
  assert.ok(aiTurns >= 1 && humanTurns >= 1);
  assert.ok(["BLACK", "WHITE", "PURPLE", "DRAW"].includes(engine.getWinner()));
  games.push({ aiSeats: [...aiSeats], aiTurns, humanTurns, winner: engine.getWinner() });
}

const historyEngine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" });
const prior = saveState(historyEngine);
const forbidden = historyEngine.getLegalMoves(historyEngine.currentPlayer)[0].point;
assert.equal(historyEngine.playMove(forbidden).success, true);
const newHashes = [...historyEngine.historyHashes].filter((hash) => !prior.historyHashes.has(hash));
restoreState(historyEngine, prior);
for (const hash of newHashes) historyEngine.historyHashes.add(hash);
assert.equal(historyEngine.getLegalMoves(historyEngine.currentPlayer).some((move) => move.point.join(",") === forbidden.join(",")), false);
assert.equal(ai.getTopMoves(historyEngine, historyEngine.currentPlayer, 999).some((move) => move.point.join(",") === forbidden.join(",")), false);

const failureEngine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" });
const beforeFailure = state(failureEngine), originalMove = failureEngine.playMove;
failureEngine.playMove = () => { failureEngine.turnCount += 99; throw new Error("injected failure"); };
assert.throws(() => threePlayerCandidates(failureEngine), /injected failure/);
failureEngine.playMove = originalMove;
assert.equal(state(failureEngine), beforeFailure, "failed speculation must restore state");
assert.throws(() => ai.getTopMoves(failureEngine, "WHITE"), /当前行动方/);
failureEngine.gameOver = true;
assert.deepEqual(ai.getTopMoves(failureEngine, failureEngine.currentPlayer), []);
assert.throws(() => createThreePlayerModel({ ...payload, weights: [Infinity] }), /无效/);
assert.throws(() => createThreePlayerModel({ ...payload, training: {} }), /无效/);
assert.throws(() => ai.getTopMoves(new GameEngine({ playerCount: 2 }), "BLACK"), /三人对局/);

// Exercise the same async Worker protocol used by the page, including seat,
// revision and request identity in the reply.
const previousFetch = globalThis.fetch, previousSelf = globalThis.self;
const replies = [];
globalThis.fetch = async (url) => {
  assert.match(String(url), /three-player-policy-v1\.json/);
  return { ok: true, json: async () => payload };
};
globalThis.self = { postMessage: (message) => replies.push(message) };
try {
  await import("../AIWorker.js");
  const workerEngine = new GameEngine({ gridSize: 5, playerCount: 3, startPlayer: "PURPLE", rulesVersion: "territory-v2" });
  const serializedState = serializeEngineState(workerEngine);
  await self.onmessage({ data: { type: "COMPUTE", strategy: "three-player", requestId: "three-player-fixture",
    aiPlayer: "PURPLE", serializedState, topN: 1, modelId: payload.id } });
  assert.equal(replies[0].type, "RESULT");
  assert.equal(replies[0].requestId, "three-player-fixture");
  assert.equal(replies[0].positionRevision, serializedState.positionRevision);
  assert.equal(replies[0].currentPlayer, "PURPLE");
  assert.equal(replies[0].rulesVersion, "territory-v2");
  assert.equal(replies[0].modelInfo.id, payload.id);
  assert.equal(workerEngine.playMove(replies[0].moves[0].point).success, true);
} finally { globalThis.fetch = previousFetch; globalThis.self = previousSelf; }

console.log(JSON.stringify({ status: "PASS", scope: "three-player-policy/legal-history/state-restoration/three-seats/two-consecutive-AIs", timings, games }, null, 2));
