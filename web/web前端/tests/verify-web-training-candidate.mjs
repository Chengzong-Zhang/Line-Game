import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createResearchModel, NeuralPUCTAI } from "../ResearchAI.js";
import GameEngine from "../GameEngine.js";
import { serializeRuleState } from "../ReplayCodec.js";

const directory = resolve(process.argv[2]); const manifest = JSON.parse(await readFile(resolve(directory, "candidate-manifest.json"), "utf8"));
const spec = manifest.models[0]; const buffer = await readFile(resolve(directory, spec.asset));
assert.equal(createHash("sha256").update(buffer).digest("hex"), spec.asset_sha256);
assert.equal(spec.formal_ready, false); assert.equal(spec.web_training.strength_evaluated, false);
const raw = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); const model = createResearchModel(spec, raw);
for (const size of [5, 6, 15]) {
  const engine = new GameEngine({ gridSize: size, playerCount: 2, rulesVersion: "territory-v2" });
  const before = JSON.stringify(serializeRuleState(engine));
  const evaluated = model.evaluate(engine); assert.ok(Number.isFinite(evaluated.value));
  const ai = new NeuralPUCTAI(model, { simulations: 2, cPuct: 1.5 }); const moves = ai.getTopMoves(engine, engine.currentPlayer, 3);
  assert.ok(moves.length); assert.ok(moves.every((m) => engine.getLegalMoves(engine.currentPlayer).some((legal) => legal.point.join() === m.point.join())));
  assert.equal(JSON.stringify(serializeRuleState(engine)), before);
}
process.stdout.write(JSON.stringify({ status: "PASS", sizes: [5, 6, 15], forward: true, puct: true, state_preserved: true, strength_evaluated: false }) + "\n");
