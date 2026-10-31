// Read-only numerical comparison through actual browser model implementations.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { GameEngine } from "../web前端/GameEngine.js";
import { createResearchModel, encodeResearchPosition } from "../web前端/ResearchAI.js";

globalThis.crypto ??= webcrypto;
const probes = JSON.parse(await readFile(process.argv[2], "utf8"));
const mlp = [...new Map(probes.filter((probe) => probe.spec.model_family).map((probe) => [probe.spec.id, probe])).values()];
globalThis.fetch = async (url) => {
  const name = String(url).split("/").at(-1).split("?")[0];
  if (name === "model-free-manifest.json") return { ok: true, json: async () => ({
    schema: { name: "lifeline-web-model-free", version: 1 }, models: mlp.map((probe) => probe.spec),
  }) };
  const probe = mlp.find((item) => item.spec.asset === name);
  assert.ok(probe, `Unexpected asset fetch: ${url}`);
  const raw = await readFile(probe.asset_path);
  assert.equal(createHash("sha256").update(raw).digest("hex"), probe.spec.asset_sha256);
  return { ok: true, arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) };
};
const { loadModelFreeModel } = await import("../web前端/ModelFreeAI.js");
let maxError = 0, actionCount = 0, probabilityCount = 0;
for (const probe of probes) {
  const engine = new GameEngine({ gridSize: probe.size, playerCount: 2, startPlayer: probe.start, rulesVersion: "territory-v2" });
  for (const action of probe.actions) {
    assert.equal(engine.currentPlayer, action.player);
    assert.equal(engine.gameOver, false);
    if (action.point === null) {
      assert.equal(engine.getLegalMoves(engine.currentPlayer).length, 0);
      assert.equal(engine.skipTurn().success, true);
    } else assert.equal(engine.playMove(action.point).success, true);
    actionCount++;
  }
  assert.equal(engine.currentPlayer, probe.player);
  assert.deepEqual(encodeResearchPosition(engine).legal, probe.legal);
  let probabilities;
  if (probe.spec.model_kind) {
    const raw = await readFile(probe.asset_path);
    assert.equal(createHash("sha256").update(raw).digest("hex"), probe.spec.asset_sha256);
    const model = createResearchModel(probe.spec, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const logits = model.evaluate(engine).pointScores;
    const legalLogits = probe.legal.map((index) => logits[index]), maximum = Math.max(...legalLogits);
    const exps = legalLogits.map((value) => Math.exp(value - maximum)), sum = exps.reduce((a, b) => a + b, 0);
    probabilities = exps.map((value) => value / sum);
  } else {
    // evaluate() exercises the browser's own state encoder as well as its MLP.
    const model = await loadModelFreeModel(probe.spec.id), priors = model.evaluate(engine).priors;
    const totalPointMass = priors.reduce((sum, prior) => sum + prior.prior, 0);
    assert.ok(totalPointMass > 0 && Number.isFinite(totalPointMass));
    const byPoint = new Map(priors.map((prior) => [prior.point.join(","), prior.prior / totalPointMass]));
    probabilities = probe.legal.map((index) => byPoint.get(engine.validPositions[index].join(",")));
  }
  assert.equal(probabilities.length, probe.probabilities.length);
  probabilities.forEach((p, index) => {
    const error = Math.abs(p - probe.probabilities[index]);
    assert.ok(Number.isFinite(error) && error < 3e-5, `${probe.spec.id} n${probe.size}: probability error ${error}`);
    maxError = Math.max(maxError, error);
    probabilityCount++;
  });
}
console.log(JSON.stringify({
  status: "PASS_ACTUAL_WEB_ENCODER_AND_F32_PROBABILITY_PARITY", probes: probes.length,
  board_sizes: [...new Set(probes.map((probe) => probe.size))], model_ids: new Set(probes.map((probe) => probe.spec.id)).size,
  replayed_prefix_actions: actionCount, checked_probabilities: probabilityCount, max_probability_error: maxError,
  tolerance: 3e-5,
}));
