import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { defensiveDataMain } from "../../tools/defensive-training-data-v1.mjs";
import { exportNeuralMain } from "../../tools/export-defensive-neural-v2.mjs";
import { root, sha, sealed, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

const fixtureRoot = await mkdtemp(resolve(tmpdir(), "lifeline-defensive-neural-v2-"));
function state(rulesVersion, extra = false) {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of [[2, 0], [3, 1], [0, 1], [0, 4], ...(extra ? [[2, 1]] : [])]) assert.equal(engine.playMove(point).success, true);
  return serializeEngineState(engine);
}
const source = resolve(fixtureRoot, "labels"), output = resolve(fixtureRoot, "export"), input = resolve(fixtureRoot, "input.json");
await writeFile(input, JSON.stringify([{ id: "train-v2", split: "train", state: state("territory-v2") },
  { id: "train-v3-next", split: "train", state: state("territory-v3", true) },
  { id: "validation-v3", split: "validation", state: state("territory-v3") }]));
assert.equal(await defensiveDataMain(["--input", input, "--run-root", source, "--max-new-units", "10", "--time-ms-per-label", "10000", "--max-nodes-per-label", "100000"]), 0);
const args = ["--data-root", source, "--output", output];
assert.equal(await exportNeuralMain([...args, "--fault-after-sample-write"]), 79);
const committed = await readFile(resolve(output, "samples/train-v2.json"));
assert.equal(await exportNeuralMain([...args, "--max-new-units", "1"]), 75);
assert.deepEqual(await readFile(resolve(output, "samples/train-v2.json")), committed);
assert.equal(await exportNeuralMain(args), 0);
assert.equal(await exportNeuralMain([...args, "--verify"]), 0);
const python = process.env.LIFELINE_TEST_PYTHON || "C:/Users/zcz/anaconda3/envs/rl310/python.exe";
const child = spawnSync(python, [resolve(root, "web/tools/tests/verify_defensive_neural_v2.py"), "--data-root", output],
  { cwd: root, encoding: "utf8", timeout: 240000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
assert.equal(child.status, 0, child.stdout + child.stderr);
console.log(child.stdout.trim());

// Rehashing malicious evidence cannot turn a shallow label into accepted data.
const sourceFile = resolve(source, "samples/train-v2.json"), raw = await readFile(sourceFile);
const originalManifest = await readFile(resolve(source, "manifest.json"));
const corrupt = unseal(JSON.parse(raw)); corrupt.label.search.completedDepth = 2;
const mutated = Buffer.from(JSON.stringify(sealed(corrupt)) + "\n"); await writeFile(sourceFile, mutated);
const manifest = JSON.parse(originalManifest); manifest.samples[0].sha256 = sha(mutated);
await writeFile(resolve(source, "manifest.json"), JSON.stringify(manifest));
await assert.rejects(exportNeuralMain([...args, "--verify"]), /complete defensive minimax/);
await writeFile(sourceFile, raw); await writeFile(resolve(source, "manifest.json"), originalManifest);
const exportedFile = resolve(output, "samples/train-v2.json");
await writeFile(exportedFile, "{}");
await assert.rejects(exportNeuralMain([...args, "--verify"]), /tampering/);
await writeFile(exportedFile, committed);
assert.equal(await exportNeuralMain([...args, "--verify"]), 0);
console.log(JSON.stringify({ status: "PASS_DEFENSIVE_NEURAL_BOUNDED_ONLY", fixtureRoot,
  checks: ["strict source-bound depth/two-round labels", "export interrupted-write adoption", "full legal PASS masks",
    "17 byte-exact deployed parents", "PASS updates", "Adam/RNG recovery equality", "pause/duplicate/corruption refusal"],
  productionTrainingRun: false, runtime_admitted: false }));
