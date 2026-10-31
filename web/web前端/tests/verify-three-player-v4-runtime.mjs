import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";
import { localMatchActors, localPlayerProfile } from "../LocalAIModes.js";
import { loadThreePlayerRuntime, loadThreePlayerSearchModel } from "../ThreePlayerRuntime.js?v=20261021-three4";
import { THREE_PLAYER_SEARCH_MODEL_ID as modelId, THREE_PLAYER_SEARCH_MODEL_SHA256 as modelHash } from "../ThreePlayerSearchOptions.js";

const colors = ["BLACK", "WHITE", "PURPLE"], assets = new Map();
const fixtureRoot = fileURLToPath(new URL(`../../../local_artifacts/three-player-v4-runtime-${Date.now()}/`, import.meta.url));
for (const id of [modelId, "three-player-policy-v1", "three-player-policy-v2"]) {
  assets.set(id, await readFile(new URL(`../assets/research-ai/${id}.json`, import.meta.url)));
}
assert.equal(createHash("sha256").update(assets.get(modelId)).digest("hex"), modelHash);
const selected = await readFile(new URL("../../../docs/verification/three-player-ai-v4/selected-candidate.json", import.meta.url));
assert.equal(Buffer.compare(selected, assets.get(modelId)), 0, "Runtime must use the exact selected bytes");
for (const size of [5, 7, 9, 6, 8, 10, 11, 12, 13, 14, 15, undefined]) {
  const expected = [5, 7, 9].includes(size) ? modelId : "three-player-policy-v1";
  assert.equal(localPlayerProfile({ choice: "three-player" }, 3, size).modelId, expected);
  assert.equal(localMatchActors({ PURPLE: { choice: "three-player" } }, 3, size).PURPLE.modelId, expected);
}

const originalFetch = globalThis.fetch, originalSelf = globalThis.self;
let corrupt = true, requests = 0;
const replies = [], moves = [], matches = [];
globalThis.fetch = async (url) => {
  requests++;
  const match = /\/assets\/research-ai\/([^/]+)\.json(?:\?[^/]*)?$/.exec(String(url));
  assert.ok(match && assets.has(match[1]), "Only relative registered assets may be fetched; never lineage Windows paths");
  const bytes = match[1] === modelId && corrupt ? Buffer.from("{}") : assets.get(match[1]);
  return { ok: true, json: async () => JSON.parse(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
globalThis.self = { postMessage: (message) => replies.push(message) };
const state = (engine) => JSON.stringify({ wire: serializeEngineState(engine), snapshot: saveState(engine), flag: engine._isReplayingBatch });
let sequence = 0;
async function compute(engine, id = modelId) {
  const before = state(engine), serializedState = serializeEngineState(engine);
  const requestId = `v4-runtime-${++sequence}`;
  replies.length = 0;
  await self.onmessage({ data: { type: "COMPUTE", strategy: "three-player", modelId: id,
    requestId, serializedState, aiPlayer: engine.currentPlayer, topN: 1 } });
  assert.equal(replies.length, 1); assert.equal(state(engine), before);
  const reply = replies[0];
  assert.equal(reply.requestId, requestId); assert.equal(reply.positionRevision, serializedState.positionRevision);
  assert.equal(reply.currentPlayer, engine.currentPlayer); assert.equal(reply.rulesVersion, engine.rulesVersion);
  if (reply.type === "RESULT") assert.equal(reply.modelInfo.id, id);
  return reply;
}
try {
  await assert.rejects(loadThreePlayerSearchModel(), /校验失败/);
  corrupt = false;
  assert.equal((await loadThreePlayerSearchModel()).id, modelId);
  const afterLoad = requests;
  const copy = await loadThreePlayerSearchModel(); copy.id = "mutated-copy";
  assert.equal((await loadThreePlayerSearchModel()).id, modelId);
  assert.equal(requests, afterLoad, "Successful load caches and failed load permits retry");
  await assert.rejects(loadThreePlayerSearchModel("unknown"), /未找到/);
  await assert.rejects(loadThreePlayerRuntime(modelId, new GameEngine({ gridSize: 11, playerCount: 3, rulesVersion: "territory-v2" })), /仅支持/);
  await import("../AIWorker.js");
  for (const size of [5, 7, 9]) for (const player of colors) {
    const engine = new GameEngine({ gridSize: size, playerCount: 3, startPlayer: player, rulesVersion: "territory-v2" });
    const reply = await compute(engine);
    assert.equal(reply.type, "RESULT", reply.message);
    assert.equal(reply.modelInfo.candidateSha256, modelHash);
    assert.equal(engine.playMove(reply.moves[0].point).success, true);
    moves.push({ size, player, point: reply.moves[0].point });
  }
  for (const legacyId of ["three-player-policy-v1", "three-player-policy-v2"]) {
    const reply = await compute(new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" }), legacyId);
    assert.equal(reply.type, "RESULT", reply.message);
  }
  for (const config of [{ gridSize: 11, playerCount: 3, rulesVersion: "territory-v2" },
    { gridSize: 5, playerCount: 2, rulesVersion: "territory-v2" },
    { gridSize: 5, playerCount: 3, rulesVersion: "territory-v1" }]) {
    const reply = await compute(new GameEngine(config));
    assert.equal(reply.type, "ERROR", "Unsupported v4 request must fail without fallback");
  }
  const unknown = await compute(new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" }), "unknown");
  assert.equal(unknown.type, "ERROR");

  await mkdir(fixtureRoot, { recursive: true });
  for (const aiCount of [1, 2]) for (const focal of colors) {
    const aiSeats = aiCount === 1 ? [focal] : colors.filter((p) => p !== focal);
    const players = Object.fromEntries(colors.map((player) => [player, { choice: aiSeats.includes(player) ? "three-player" : "human" }]));
    const config = { gridSize: 5, playerCount: 3, rulesVersion: "territory-v2", startPlayer: "BLACK", hintEnabled: false };
    const engine = new GameEngine(config), actions = [], actualIds = {};
    for (let turn = 0; turn < 150 && !engine.gameOver; turn++) {
      const player = engine.currentPlayer;
      let point;
      if (aiSeats.includes(player)) {
        const profile = localPlayerProfile(players[player], 3, 5), reply = await compute(engine, profile.modelId);
        assert.equal(reply.type, "RESULT", reply.message); point = reply.moves[0]?.point;
        actualIds[player] = reply.modelInfo.id;
      } else point = engine.getLegalMoves(player)[0]?.point;
      assert.equal((point ? engine.playMove(point) : engine.skipTurn()).success, true);
      actions.push({ type: point ? "move" : "skip", player, ...(point ? { point } : {}) });
    }
    assert.equal(engine.gameOver, true);
    const actors = localMatchActors(players, 3, 5);
    for (const player of aiSeats) assert.equal(actors[player].modelId, actualIds[player]);
    const replay = await createReplayDocument(config, actions), verified = await validateReplayDocument(replay);
    assert.equal(verified.success, true, verified.reason);
    const fixturePath = resolve(fixtureRoot, `ai${aiCount}-${focal.toLowerCase()}.json`);
    await writeFile(fixturePath, `${JSON.stringify({ format: "lifeline-training-contribution", version: 1, consent: true,
      consent_policy: "anonymous-replay-training-v1", replay,
      context: { source: "local", actors, mixedProfiles: false, hintsEnabled: false } }, null, 2)}\n`, { flag: "wx" });
    matches.push({ aiSeats, actions: actions.length, winner: engine.getWinner(), actors, replayValidated: true, fixturePath });
  }
} finally { globalThis.fetch = originalFetch; globalThis.self = originalSelf; }
console.log(JSON.stringify({ status: "PASS_V4_RUNTIME_WORKER_SEATS_REPLAY", modelId, modelHash, moves, matches, fixtureRoot,
  fixtureScope: "Synthetic engineering games with scripted human seats and actual v4 Worker requests; no human data or uploads.",
  checks: ["hash-failure-retry", "cached-model-copy-isolation", "relative-asset-only", "5-7-9-three-seats",
    "legacy-v1-v2-explicit-requests", "unsupported-request-error-without-fallback", "all-six-single-double-seat-games",
    "worker-request-revision-rules-identity", "complete-input-state-preserved", "actual-model-actor-labels", "complete-rule-replays"] }, null, 2));
