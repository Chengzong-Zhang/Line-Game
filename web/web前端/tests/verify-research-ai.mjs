import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import GameEngine from "../GameEngine.js?v=20260910d";
import { createResearchModel, NeuralPUCTAI, supportsResearchInference } from "../ResearchAI.js?v=20260921f";
import { serializeEngineState } from "../AIStateProtocol.js?v=20260830a";

const manifest = JSON.parse(await readFile(new URL("../assets/research-ai/manifest.json", import.meta.url), "utf8"));
assert.equal(manifest?.schema?.name, "lifeline-web-research-ai");
assert.equal(manifest?.schema?.version, 1);
assert.deepEqual(manifest.models.map((model) => model.model_kind), ["padded_cnn", "grid_gnn", "topology_gnn"]);

const expectedValues = new Map([
  ["padded_cnn", -0.0693065673],
  ["grid_gnn", 0.0842975527],
  ["topology_gnn", 0.1067731827],
]);
const engine = new GameEngine({ gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: "territory-v2" });
const before = JSON.stringify(serializeEngineState(engine));
const legal = new Set(engine.getLegalMoves(engine.currentPlayer).map((move) => move.point.join(",")));

for (const spec of manifest.models) {
  const payload = await readFile(new URL(`../assets/research-ai/${spec.asset}`, import.meta.url));
  const raw = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  const model = createResearchModel(spec, raw);
  const policy = model.evaluate(engine);
  assert.ok(Math.abs(policy.value - expectedValues.get(spec.model_kind)) < 1e-5, `${spec.model_kind} value parity`);
  assert.ok(policy.priors.length > 0, `${spec.model_kind} must produce legal priors`);
  assert.ok(Math.abs(policy.priors.reduce((sum, item) => sum + item.prior, 0) - 1) < 1e-6, `${spec.model_kind} priors must normalize`);
  for (const item of policy.priors) assert.ok(legal.has(item.point.join(",")), `${spec.model_kind} emitted an illegal prior`);

  const moves = new NeuralPUCTAI(model, { simulations: 4, cPuct: 1.5 }).getTopMoves(engine, engine.currentPlayer, 3);
  assert.ok(moves.length > 0, `${spec.model_kind} must produce PUCT candidates`);
  for (const move of moves) assert.ok(legal.has(move.point.join(",")), `${spec.model_kind} PUCT emitted an illegal candidate`);
  assert.equal(JSON.stringify(serializeEngineState(engine)), before, `${spec.model_kind} PUCT must not mutate the source position`);

  for (let gridSize = 5; gridSize <= 15; gridSize += 1) {
    const sizedEngine = new GameEngine({ gridSize, playerCount: 2, startPlayer: "BLACK", rulesVersion: "territory-v2" });
    assert.equal(supportsResearchInference(spec, sizedEngine), true, `${spec.model_kind} must support size ${gridSize}`);
    const sizedPolicy = model.evaluate(sizedEngine);
    const sizedLegal = new Set(sizedEngine.getLegalMoves(sizedEngine.currentPlayer).map((move) => move.point.join(",")));
    assert.equal(sizedPolicy.priors.length, sizedLegal.size, `${spec.model_kind} must score every legal point at size ${gridSize}`);
    assert.ok(Math.abs(sizedPolicy.priors.reduce((sum, item) => sum + item.prior, 0) - 1) < 1e-6, `${spec.model_kind} priors must normalize at size ${gridSize}`);
    for (const item of sizedPolicy.priors) assert.ok(sizedLegal.has(item.point.join(",")), `${spec.model_kind} emitted an illegal size-${gridSize} prior`);
  }

  const largestEngine = new GameEngine({ gridSize: 15, playerCount: 2, startPlayer: "BLACK", rulesVersion: "territory-v2" });
  const largestBefore = JSON.stringify(serializeEngineState(largestEngine));
  const largestLegal = new Set(largestEngine.getLegalMoves(largestEngine.currentPlayer).map((move) => move.point.join(",")));
  const largestMoves = new NeuralPUCTAI(model, { simulations: 2, cPuct: 1.5 }).getTopMoves(largestEngine, largestEngine.currentPlayer, 3);
  assert.ok(largestMoves.length > 0, `${spec.model_kind} must produce PUCT candidates at size 15`);
  for (const move of largestMoves) assert.ok(largestLegal.has(move.point.join(",")), `${spec.model_kind} PUCT emitted an illegal size-15 candidate`);
  assert.equal(JSON.stringify(serializeEngineState(largestEngine)), largestBefore, `${spec.model_kind} PUCT must not mutate size 15`);
}

console.log("verify-research-ai: PASS");
await import("./verify-size-transfer-ai.mjs");
