import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { saveState } from "../AIEngine.js?v=20261025-room1";

const tensors = [
  ["layers.0.weight", 431104], ["layers.0.bias", 512],
  ["layers.2.weight", 262144], ["layers.2.bias", 512],
  ["layers.4.weight", 61952], ["layers.4.bias", 121],
];

function syntheticModel(id, passBias, passIndex) {
  const values = new Float32Array(756345);
  values[756224 + passIndex] = passBias;
  const bytes = new Uint8Array(values.buffer);
  let offset = 0;
  const spec = {
    id, label: id, model_family: "dqn", asset: `${id}.f32`,
    asset_sha256: createHash("sha256").update(bytes).digest("hex"),
    float_count: values.length, state_dimension: 842, action_count: 121,
    tensors: tensors.map(([name, length]) => {
      const shape = name === "layers.0.weight" ? [512,842] : name === "layers.2.weight" ? [512,512] : name === "layers.4.weight" ? [121,512] : name === "layers.4.bias" ? [121] : [512]; const tensor = { name, offset, length, shape };
      offset += length;
      return tensor;
    }),
  };
  return { spec, bytes };
}

const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v2" });
assert.ok(engine.getLegalMoves().length > 0, "Fixture must retain legal placements");
const passIndex = engine.validPositions.length;
const models = [syntheticModel("synthetic-pass-high", 10, passIndex), syntheticModel("synthetic-pass-low", -10, passIndex)];
const manifest = { schema: { name: "lifeline-web-model-free", version: 1 }, models: models.map(row => row.spec) };
const assets = new Map(models.map(row => [row.spec.asset, row.bytes]));
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.pathname.endsWith("/model-free-manifest.json")) return new Response(JSON.stringify(manifest));
  const bytes = assets.get(url.pathname.split("/").at(-1));
  return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
};

try {
  const { loadModelFreeModel, ModelFreeAI } = await import("../ModelFreeAI.js?v=20261025-room1");
  const before = saveState(engine);
  const high = new ModelFreeAI(await loadModelFreeModel("synthetic-pass-high"));
  const highMoves = high.getTopMoves(engine, engine.currentPlayer, Infinity);
  assert.deepEqual(highMoves[0], {
    type: "pass", point: null, actionIndex: passIndex, prior: highMoves[0].prior,
    score: highMoves[0].prior, meanValue: highMoves[0].prior, visits: 1,
  });
  assert.ok(highMoves[0].prior > 0.99, "High PASS logit must make PASS the first choice");
  assert.equal(highMoves.length, engine.getLegalMoves().length + 1);
  assert.ok(highMoves.every(move => Number.isFinite(move.prior) && move.prior >= 0 && move.prior <= 1));
  assert.ok(Math.abs(highMoves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-6);
  assert.deepEqual(saveState(engine), before, "Model-free evaluation must not mutate the game");

  const low = new ModelFreeAI(await loadModelFreeModel("synthetic-pass-low"));
  const lowMoves = low.getTopMoves(engine, engine.currentPlayer, Infinity);
  assert.equal(lowMoves[0].type, "move");
  assert.ok(Array.isArray(lowMoves[0].point));
  assert.equal(lowMoves.at(-1).type, "pass");
  assert.ok(Math.abs(lowMoves.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-6);
  assert.deepEqual(saveState(engine), before, "Both model-free decisions must preserve the source state");
  console.log(JSON.stringify({ status: "PASS_MODEL_FREE_VOLUNTARY_PASS", legalPlacements: engine.getLegalMoves().length,
    highPassPrior: highMoves[0].prior, lowPassPrior: lowMoves.at(-1).prior }));
} finally {
  globalThis.fetch = originalFetch;
}
