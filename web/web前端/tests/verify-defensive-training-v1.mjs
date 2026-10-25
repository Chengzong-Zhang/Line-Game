import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { saveState } from "../AIEngine.js";
import { assertCompletedTrainingLabel, compareDefensiveValues, defensiveTrainingLabel,
  requiredTrainingDepth, rootConnectedAttackChain } from "../DefensiveTrainingTeacher.js";
import { defensiveDataMain, engineFromTrainingState } from "../../tools/defensive-training-data-v1.mjs";
import { defensiveTrainMain, loadDefensiveDataset } from "../../tools/train-defensive-policy-v1.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "../../tools/neural-posttraining-data-v2.mjs";
import { dataMain as retiredDataMain } from "../../tools/neural-posttraining-data.mjs";
import { dataMain as retiredDataMainV2 } from "../../tools/neural-posttraining-data-v2.mjs";

const PREFIX = [[2, 0], [3, 1], [0, 1], [0, 4]];
function position(rulesVersion = "territory-v3", prefix = PREFIX) {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of prefix) assert.equal(engine.playMove(point).success, true);
  return engine;
}
const receipts = [];
for (const rulesVersion of ["territory-v2", "territory-v3"]) {
  const engine = position(rulesVersion), before = saveState(engine);
  assert.equal(requiredTrainingDepth(engine), 4, "Two opposing actual turns need four plies, beyond the mandatory floor of three");
  for (const depth of [0, 1, 2, 3]) assert.throws(() => defensiveTrainingLabel(engine, { depth }), /completed depth >= 4/);
  const result = defensiveTrainingLabel(engine, { maxNodes: 10000, timeMs: 5000 });
  assert.equal(result.status, "COMPLETE_LABEL");
  assert.equal(result.search.completedDepth, 4);
  assert.equal(result.search.maxReachedPly, 4);
  assert.equal(result.search.rootActionsCompleted, engine.getLegalMoves().length + 1);
  assert.equal(result.search.candidateCap, null);
  assert.deepEqual(result.label.moves[0].point, [2, 1], "The complete teacher must choose the real rooted cut-chain setup");
  assert.equal(result.label.moves[0].target, 1);
  assert.ok(result.label.moves[0].value[5] > 0, "The winning continuation must retain its attacking node on a root-connected edge path");
  assert.deepEqual(saveState(engine), before, "Teacher changed source board, edges, history or cached score");
  const exhaustive = defensiveTrainingLabel(engine, { maxNodes: 10000, timeMs: 5000, pruning: false });
  assert.deepEqual(exhaustive.label.moves, result.label.moves, "Alpha-beta must preserve every exact root action vector");
  const incomplete = defensiveTrainingLabel(engine, { maxNodes: 4, timeMs: 5000 });
  assert.equal(incomplete.status, "NO_LABEL_INCOMPLETE_SEARCH");
  assert.equal(incomplete.label, null);
  assert.equal(incomplete.search.completedDepth, 0);
  assert.deepEqual(saveState(engine), before);
  for (const changes of [{ completedDepth: 1 }, { completedDepth: 2 }, { completedDepth: 3 },
    { complete: false }, { timedOut: true }, { candidateCap: 20 }, { allRootScoresExact: false }]) {
    const corrupt = structuredClone(result.label); Object.assign(corrupt.search, changes);
    assert.throws(() => assertCompletedTrainingLabel(corrupt), /Training label rejected/);
  }
  for (const mutation of [label => { label.moves[0].target = NaN; },
    label => { label.moves[0].target = Infinity; },
    label => { label.moves[0].point = label.moves[1].point; },
    label => { label.moves[0].point = [99, 99]; },
    label => { label.moves.forEach(move => { move.target = 0; }); label.moves.at(-1).target = 1; },
    label => { label.actor = "MISSING"; },
    label => { label.activePlayers = ["BLACK", "BLACK"]; }]) {
    const corrupt = structuredClone(result.label); mutation(corrupt);
    assert.throws(() => assertCompletedTrainingLabel(corrupt), /Training label rejected/);
  }
  receipts.push({ rulesVersion, completedDepth: result.search.completedDepth,
    rootActions: result.search.rootActionsCompleted, nodes: result.search.nodes, exactAlphaBetaParity: true });
}
// Defense dominates speculative attack under the documented lexicographic
// value. No amount of distant coverage/capture can buy an additional own loss.
assert.ok(compareDefensiveValues([0,0,0,0,0,0,0,3,4], [0,-1,0,0,0,15,15,50,50]) > 0);
assert.ok(compareDefensiveValues([0,0,0,0,0,0,0,3,4], [0,0,-1,0,0,15,15,50,50]) > 0);
const connected = position();
assert.equal(connected.playMove([2, 1]).success, true);
const attackPath = [[2, 1]];
assert.deepEqual(rootConnectedAttackChain(connected, "BLACK", attackPath), { connectedCuts: 1, uninterrupted: true });
connected.edges.BLACK.clear();
assert.deepEqual(rootConnectedAttackChain(connected, "BLACK", attackPath), { connectedCuts: 0, uninterrupted: false },
  "Physically nearby nodes without real edges must not earn unbroken-chain credit");
const three = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
assert.equal(requiredTrainingDepth(three), 6);
assert.throws(() => defensiveTrainingLabel(three, { depth: 3 }), /completed depth >= 6/);
const inputState = serializeEngineState(position());
assert.deepEqual(serializeEngineState(engineFromTrainingState(inputState)), inputState);
assert.throws(() => engineFromTrainingState({ ...inputState, historyHashes: [] }), /full grid/);

await assert.rejects(retiredDataMain([]), /preserved historical training/);
await assert.rejects(retiredDataMainV2([]), /preserved historical training/);
for (const name of ["train-three-player-ai.mjs", "train-hex-player-ai.mjs", "run-hex-distillation-v3.mjs"]) {
  const child = spawnSync(process.execPath, [resolve(root, "web/tools", name)], { cwd: root, encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /RETIRED_SHALLOW_TRAINING_PROTOCOL|preserved historical training/);
}

// All fault fixtures are tiny and local. Finished samples are adopted by hash
// after an interruption, and finished optimizer updates are not repeated.
const testRoot = await mkdtemp(resolve(tmpdir(), "lifeline-defensive-training-"));
const input = resolve(testRoot, "input.json"), data = resolve(testRoot, "data"), model = resolve(testRoot, "model"), cleanModel = resolve(testRoot, "clean-model");
await writeFile(input, JSON.stringify([{ id: "train", split: "train", state: inputState },
  { id: "validation", split: "validation", state: serializeEngineState(position("territory-v2")) }]));
const dataArgs = ["--input", input, "--run-root", data, "--max-new-units", "10", "--time-ms-per-label", "5000", "--max-nodes-per-label", "10000"];
assert.equal(await defensiveDataMain([...dataArgs, "--fault-after-sample-write"]), 79);
const committedSample = await readFile(resolve(data, "samples/train.json"));
assert.equal(await defensiveDataMain(dataArgs), 0);
assert.deepEqual(await readFile(resolve(data, "samples/train.json")), committedSample, "Resume must adopt the complete unindexed label without recomputation");
const manifest = await readFile(resolve(data, "manifest.json"));
assert.equal(await defensiveDataMain(dataArgs), 0);
assert.deepEqual(await readFile(resolve(data, "manifest.json")), manifest);
const loaded = await loadDefensiveDataset(data);
assert.equal(loaded.samples.length, 2);
for (const row of loaded.samples) assertCompletedTrainingLabel(row.label);
// The consumer must reject a newly sealed/hash-matched label whose probability
// mass has been moved to a worse action. Integrity alone is insufficient.
const badSample = unseal(JSON.parse(committedSample));
badSample.label.moves.forEach(move => { move.target = 0; }); badSample.label.moves.at(-1).target = 1;
await atomic(resolve(data, "samples/train.json"), sealed(badSample));
const badManifest = JSON.parse(manifest);
badManifest.samples[0].sha256 = sha(await readFile(resolve(data, "samples/train.json")));
await writeFile(resolve(data, "manifest.json"), `${JSON.stringify(badManifest)}\n`);
await assert.rejects(loadDefensiveDataset(data), /equal mass only to exact best defensive vectors/);
await writeFile(resolve(data, "samples/train.json"), committedSample);
await writeFile(resolve(data, "manifest.json"), manifest);
const trainArgs = ["--data-root", data, "--run-root", model, "--updates", "3", "--max-new-units", "10"];
assert.equal(await defensiveTrainMain([...trainArgs, "--fault-after-checkpoint"]), 79);
assert.equal(unseal(await readJson(resolve(model, "checkpoint.json"))).step, 1);
assert.equal(await defensiveTrainMain(trainArgs), 0);
assert.equal(await defensiveTrainMain(["--data-root", data, "--run-root", cleanModel, "--updates", "3", "--max-new-units", "10"]), 0);
assert.deepEqual(unseal(await readJson(resolve(model, "checkpoint.json"))).weights,
  unseal(await readJson(resolve(cleanModel, "checkpoint.json"))).weights, "Interrupted/resumed fitting must equal a clean run");
assert.equal((await readJson(resolve(model, "candidate.json"))).runtime_admitted, false);
await writeFile(resolve(model, "PAUSE"), "test pause");
assert.equal(await defensiveTrainMain(trainArgs), 0, "A completed run must remain completed without repeating an update");
const paused = resolve(testRoot, "paused"); await mkdir(paused);
await writeFile(resolve(paused, "PAUSE"), "test pause");
assert.equal(await defensiveTrainMain(["--data-root", data, "--run-root", paused]), 75);
assert.equal(unseal(await readJson(resolve(paused, "checkpoint.json"))).step, 0);
const guard = await lease(paused);
try { await assert.rejects(defensiveTrainMain(["--data-root", data, "--run-root", paused]), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
const cp = unseal(await readJson(resolve(model, "checkpoint.json"))); cp.weights[0]++;
await atomic(resolve(model, "checkpoint.json"), { ...sealed(cp), integrity: "corrupt" });
await assert.rejects(defensiveTrainMain(trainArgs), /Corrupt evidence integrity/);
const legacy = resolve(testRoot, "legacy"); await mkdir(legacy);
await writeFile(resolve(legacy, "manifest.json"), JSON.stringify({ schema: "lifeline-web-distillation-dataset-v1" }));
await assert.rejects(loadDefensiveDataset(legacy), /rejects old shallow/);
console.log(JSON.stringify({ status: "PASS_BOUNDED_TEACHER_AND_RECOVERY_ONLY", receipts,
  tests: ["completed-depth-floor", "actual-second-reply-horizon", "full-root-PASS", "exact-alpha-beta-parity",
    "source-unchanged", "incomplete-no-label", "root-edge-continuity", "defense-first", "retired-entry-gates", "best-vector-target-mass",
    "incremental-sample-adoption", "resume-clean-parity", "pause", "duplicate-worker", "corruption-rejected", "legacy-dataset-rejected"],
  fixtureRoot: testRoot, trainedProductionModels: 0, strengthVerified: false }));
