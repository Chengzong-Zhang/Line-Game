import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";

const workerSource = await readFile(new URL("../AIWorker.js", import.meta.url), "utf8");
assert.match(workerSource, /import\("\.\/ModelFreeAI\.js\?v=[^"]+"\)/);
assert.doesNotMatch(workerSource, /ModelFreeAI\.js\?v=20261020-three1/);

const tensors = [
  ["layers.0.weight", 431104], ["layers.0.bias", 512],
  ["layers.2.weight", 262144], ["layers.2.bias", 512],
  ["layers.4.weight", 61952], ["layers.4.bias", 121],
];
const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v3" });
const passIndex = engine.validPositions.length;
const values = new Float32Array(756345);
values[756224 + passIndex] = 100;
const bytes = new Uint8Array(values.buffer);
let offset = 0;
const spec = {
  id: "synthetic-worker-pass-high", label: "synthetic-worker-pass-high", model_family: "dqn",
  asset: "synthetic-worker-pass-high.f32", asset_sha256: createHash("sha256").update(bytes).digest("hex"),
  float_count: values.length, state_dimension: 842, action_count: 121,
  tensors: tensors.map(([name, length]) => { const shape = name === "layers.0.weight" ? [512,842] : name === "layers.2.weight" ? [512,512] : name === "layers.4.weight" ? [121,512] : name === "layers.4.bias" ? [121] : [512]; const row = { name, offset, length, shape }; offset += length; return row; }),
};
const manifest = { schema: { name: "lifeline-web-model-free", version: 1 }, models: [spec] };
const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
const messages = [];
globalThis.fetch = async input => {
  const url = input instanceof URL ? input : new URL(input);
  return url.pathname.endsWith("/model-free-manifest.json")
    ? new Response(JSON.stringify(manifest))
    : url.pathname.endsWith(`/${spec.asset}`) ? new Response(bytes) : new Response("missing", { status: 404 });
};
globalThis.self = { postMessage: message => messages.push(message) };

try {
  await import(`../AIWorker.js?worker-pass-route=${Date.now()}`);
  assert.equal(typeof globalThis.self.onmessage, "function");
  const { createModelFreeModel, ModelFreeAI } = await import("../ModelFreeAI.js");
  const raw = new ModelFreeAI(createModelFreeModel(spec, values.buffer));
  const rows = [];
  for (const label of ["opening", "winning-with-safe-growth"]) {
    if (label !== "opening") {
      assert.equal(engine.playMove([1, 0]).success, true);
      assert.equal(engine.skipTurn().success, true);
    }
    assert.equal(raw.getTopMoves(engine, engine.currentPlayer, 1)[0].point, null,
      "Synthetic raw model must actually prefer PASS before the runtime contract");
    const serializedState = serializeEngineState(engine), before = structuredClone(serializedState);
    messages.length = 0;
    const requestId = `model-free-pass-${label}`;
    await globalThis.self.onmessage({ data: { type: "COMPUTE", requestId,
      strategy: "model-free", modelId: spec.id, aiPlayer: engine.currentPlayer, topN: 1, serializedState } });
    assert.equal(messages.length, 1);
    const result = messages[0];
    assert.equal(result.type, "RESULT"); assert.equal(result.requestId, requestId);
    assert.equal(result.positionRevision, serializedState.positionRevision);
    assert.equal(result.rulesVersion, serializedState.rulesVersion);
    assert.equal(result.currentPlayer, serializedState.currentPlayer);
    assert.ok(Array.isArray(result.moves[0].point), "Shared Worker gate must replace raw PASS only with a completed witness");
    assert.equal(result.searchStats.passDiscipline.status, "safe-profitable-expansion");
    assert.equal(result.searchStats.passDiscipline.witness.completeOpponentRound, true);
    assert.equal(result.searchStats.passDiscipline.witness.passWouldEnd, label !== "opening");
    assert.deepEqual(serializedState, before);
    assert.deepEqual(serializeEngineState(engine), before);
    rows.push({ label, rawPolicy: "PASS", final: result.moves[0].point,
      replyActions: result.searchStats.passDiscipline.witness.replyActionsCompleted });
  }
  console.log(JSON.stringify({ status: "PASS_MODEL_FREE_WORKER_ROUTE", rows, sourceStatePreserved: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
}
