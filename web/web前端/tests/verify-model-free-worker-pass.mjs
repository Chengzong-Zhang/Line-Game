import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GameEngine } from "../GameEngine.js?v=20261025-unified1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-unified1";

const workerSource = await readFile(new URL("../AIWorker.js?v=20261025-unified1", import.meta.url), "utf8");
assert.match(workerSource, /import\("\.\/ModelFreeAI\.js\?v=20261025-unified1"\)/);
assert.doesNotMatch(workerSource, /ModelFreeAI\.js\?v=20261020-three1/);

const tensors = [
  ["layers.0.weight", 431104], ["layers.0.bias", 512],
  ["layers.2.weight", 262144], ["layers.2.bias", 512],
  ["layers.4.weight", 61952], ["layers.4.bias", 121],
];
const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v2" });
const passIndex = engine.validPositions.length;
const values = new Float32Array(756345);
values[756224 + passIndex] = 10;
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
  const serializedState = serializeEngineState(engine);
  await globalThis.self.onmessage({ data: { type: "COMPUTE", requestId: "model-free-pass-route",
    strategy: "model-free", modelId: spec.id, aiPlayer: engine.currentPlayer, topN: 1, serializedState } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "RESULT");
  assert.equal(messages[0].requestId, "model-free-pass-route");
  assert.deepEqual(messages[0].moves[0], {
    type: "pass", point: null, actionIndex: passIndex, prior: messages[0].moves[0].prior,
    score: messages[0].moves[0].prior, meanValue: messages[0].moves[0].prior, visits: 1,
  });
  assert.ok(messages[0].moves[0].prior > 0.99);
  console.log(JSON.stringify({ status: "PASS_MODEL_FREE_WORKER_ROUTE", passPrior: messages[0].moves[0].prior,
    cacheIdentity: "20261024-model-free-pass2" }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
}
