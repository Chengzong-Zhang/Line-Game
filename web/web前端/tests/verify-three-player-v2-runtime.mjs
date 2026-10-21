import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import {
  createSupportedThreePlayerModel, loadThreePlayerModel, ThreePlayerAI,
  THREE_PLAYER_MODEL_HASHES,
} from "../ThreePlayerModels.js";

const bytes = await readFile(new URL("../assets/research-ai/three-player-policy-v2.json", import.meta.url));
const payload = JSON.parse(bytes);
const baseline = JSON.parse(await readFile(new URL("../assets/research-ai/three-player-policy-v1.json", import.meta.url)));
const digest = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(digest(bytes), THREE_PLAYER_MODEL_HASHES[payload.id]);
assert.ok(payload.weights.some((value, i) => value !== baseline.weights[i]), "Posttraining must change the parent weights");
const model = createSupportedThreePlayerModel(payload);
assert.equal(model.spec.id, "three-player-policy-v2");
const ai = new ThreePlayerAI(model);
const timings = [];
for (const size of [5, 9, 15]) for (const player of ["BLACK", "WHITE", "PURPLE"]) {
  const engine = new GameEngine({ gridSize: size, playerCount: 3, rulesVersion: "territory-v2", startPlayer: player });
  const before = JSON.stringify(serializeEngineState(engine));
  const started = performance.now();
  const moves = ai.getTopMoves(engine, player, 999);
  timings.push({ size, player, milliseconds: Math.round(performance.now() - started) });
  assert.equal(JSON.stringify(serializeEngineState(engine)), before);
  assert.ok(moves.length > 0 && moves.every((move) => Number.isFinite(move.score)));
  assert.ok(Math.abs(moves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-10);
  assert.equal(engine.playMove(moves[0].point).success, true);
}
assert.throws(() => createSupportedThreePlayerModel({ ...payload, lineage: { ...payload.lineage, parent_sha256: "0".repeat(64) } }), /无效/);
assert.throws(() => createSupportedThreePlayerModel({ ...payload, weights: Array(16).fill(NaN) }), /无效/);
assert.throws(() => createSupportedThreePlayerModel({ ...payload, id: "unknown" }), /无效/);

// A failed integrity check must clear the promise, so a user retry can recover.
const previousFetch = globalThis.fetch, previousSelf = globalThis.self;
let requests = 0, corrupt = true;
globalThis.fetch = async (url) => {
  requests++;
  assert.match(String(url), /three-player-policy-v2\.json/);
  const body = corrupt ? Buffer.from("{}") : bytes;
  return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
};
const replies = [];
globalThis.self = { postMessage: (message) => replies.push(message) };
try {
  await assert.rejects(loadThreePlayerModel(payload.id), /校验失败/);
  corrupt = false;
  assert.equal((await loadThreePlayerModel(payload.id)).spec.id, payload.id);
  await loadThreePlayerModel(payload.id);
  assert.equal(requests, 2, "Successful load must cache; failed load must permit retry");
  await import("../AIWorker.js");
  const engine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2", startPlayer: "WHITE" });
  const before = JSON.stringify(serializeEngineState(engine));
  const serializedState = serializeEngineState(engine);
  await self.onmessage({ data: {
    type: "COMPUTE", strategy: "three-player", modelId: payload.id,
    requestId: "posttraining-v2-worker", serializedState, aiPlayer: "WHITE", topN: 1,
  } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, "RESULT", replies[0].message);
  assert.equal(replies[0].modelInfo.id, payload.id);
  assert.equal(replies[0].requestId, "posttraining-v2-worker");
  assert.equal(replies[0].currentPlayer, "WHITE");
  assert.equal(replies[0].positionRevision, serializedState.positionRevision);
  assert.equal(replies[0].rulesVersion, "territory-v2");
  assert.equal(JSON.stringify(serializeEngineState(engine)), before);
  assert.equal(engine.playMove(replies[0].moves[0].point).success, true);
} finally {
  globalThis.fetch = previousFetch;
  globalThis.self = previousSelf;
}
console.log(JSON.stringify({
  status: "PASS", modelId: payload.id, modelSha256: digest(bytes),
  scope: "v2 runtime, preserved position, legal moves, integrity failure/retry, actual Worker protocol",
  timings,
}));
