// Tiny real teacher fixtures: test inheritance and durable updates, not strength.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { defensiveDataMain } from "../../tools/defensive-training-data-v1.mjs";
import { loadDefensiveDataset } from "../../tools/train-defensive-policy-v1.mjs";
import { defensiveWarmstartMain, initialDefensiveWeights, loadWarmstartParent,
  warmstartProbabilities, WARMSTART_PARENTS } from "../../tools/train-defensive-warmstart-v2.mjs";
import { createDefensiveWarmstartPolicy, defensiveWarmstartVerifyMain } from "../../tools/verify-defensive-warmstart-v2.mjs";
import { engineFromTrainingState } from "../../tools/defensive-training-data-v1.mjs";
import { atomic, lease, readJson, sealed, sha, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

function state(rulesVersion) {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of [[2, 0], [3, 1], [0, 1], [0, 4]]) assert.equal(engine.playMove(point).success, true);
  return serializeEngineState(engine);
}
const testRoot = await mkdtemp(resolve(tmpdir(), "lifeline-defensive-warmstart-"));
const input = resolve(testRoot, "input.json"), data = resolve(testRoot, "data");
await writeFile(input, JSON.stringify([{ id: "train", split: "train", state: state("territory-v3") },
  { id: "validation", split: "validation", state: state("territory-v2") }]));
assert.equal(await defensiveDataMain(["--input", input, "--run-root", data, "--max-new-units", "10",
  "--max-nodes-per-label", "10000", "--time-ms-per-label", "5000"]), 0);
const loaded = await loadDefensiveDataset(data), exampleMoves = loaded.samples[0].label.moves;
const weights = Array.from({ length: 16 }, (_, i) => i * 0.1 - 0.5), temperature = 2.5;
const converted = initialDefensiveWeights(weights, temperature);
for (const move of exampleMoves.filter(move => move.point !== null)) {
  const old = move.features.slice(0, 16).reduce((sum, value, i) => sum + value * weights[i], 0) / temperature;
  const inherited = move.features.reduce((sum, value, i) => sum + value * converted[i], 0);
  assert.ok(Math.abs(old - inherited) < 1e-12, "Non-unit temperature conversion changed placement logits");
}
assert.equal(converted[16], 0);
assert.throws(() => initialDefensiveWeights(weights, 0), /conversion/);
const parents = [];
for (const alias of Object.keys(WARMSTART_PARENTS)) {
  const parent = await loadWarmstartParent(alias);
  assert.equal(parent.initialWeights.length, 17);
  assert.ok(parent.initialWeights.slice(0, 16).some(value => value !== 0), "Must inherit actual nonzero product weights");
  assert.equal(parent.initialWeights[16], 0);
  assert.match(parent.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await loadWarmstartParent(parent.id)).sha256, parent.sha256);
  const all = warmstartProbabilities(exampleMoves, parent.initialWeights);
  const placements = exampleMoves.map((move, i) => ({ move, probability: all[i] })).filter(row => row.move.point !== null);
  const mass = placements.reduce((sum, row) => sum + row.probability, 0);
  const oldLogits = placements.map(({ move }) => move.features.slice(0, 16)
    .reduce((sum, value, i) => sum + value * parent.weights[i], 0) / parent.temperature);
  const max = Math.max(...oldLogits), terms = oldLogits.map(value => Math.exp(value - max));
  const total = terms.reduce((a, b) => a + b, 0);
  placements.forEach((row, i) => assert.ok(Math.abs(row.probability / mass - terms[i] / total) < 1e-12,
    "Adding the new PASS head must preserve conditional placement probabilities"));
  parents.push({ alias, id: parent.id, sha256: parent.sha256 });
}
assert.equal((await loadWarmstartParent("auto", loaded.samples)).alias, "easy");
await assert.rejects(loadWarmstartParent("auto", [...loaded.samples, { sourceState: { playerCount: 3, boardShape: "triangle", gridSize: 5 } }]), /one product route/);
await assert.rejects(loadWarmstartParent("unknown"), /Unsupported warm-start parent/);
const common = ["--data-root", data, "--parent", "easy", "--updates", "3", "--learning-rate", ".03", "--max-new-units", "10"];
const interrupted = resolve(testRoot, "interrupted"), clean = resolve(testRoot, "clean");
await mkdir(interrupted);
await writeFile(resolve(interrupted, "checkpoint.json.12345.tmp"), "partial-uncommitted-state");
assert.equal(await defensiveWarmstartMain(["--max-new-units", "0", ...common, "--run-root", interrupted]), 75);
const quarantined = (await readdir(interrupted)).find(name => name.startsWith("checkpoint.json.12345.tmp.interrupted-"));
assert.ok(quarantined, "Interrupted trailing write must be isolated and preserved");
assert.equal(await readFile(resolve(interrupted, quarantined), "utf8"), "partial-uncommitted-state");
const initial = unseal(await readJson(resolve(interrupted, "checkpoint.json"))), parent = await loadWarmstartParent("easy");
assert.equal(initial.step, 0);
assert.deepEqual(initial.weights, parent.initialWeights, "Zero-update checkpoint must be the exact product parent");
assert.equal(await defensiveWarmstartMain([...common, "--run-root", interrupted, "--fault-after-checkpoint"]), 79);
const stepOne = unseal(await readJson(resolve(interrupted, "checkpoint.json")));
assert.equal(stepOne.step, 1);
assert.notDeepEqual(stepOne.weights, initial.weights, "A real exact-label gradient must change inherited weights");
const beforeWrongParent = await readFile(resolve(interrupted, "checkpoint.json"));
await assert.rejects(defensiveWarmstartMain(["--data-root", data, "--parent", "hex-v1", "--player-counts", "2",
  "--run-root", interrupted, "--updates", "3"]), /identity, parent or optimizer state corruption/);
assert.deepEqual(await readFile(resolve(interrupted, "checkpoint.json")), beforeWrongParent, "Wrong-parent resume modified durable progress");
assert.equal(await defensiveWarmstartMain([...common, "--run-root", interrupted]), 0);
assert.equal(await defensiveWarmstartMain([...common, "--run-root", clean]), 0);
const resumed = unseal(await readJson(resolve(interrupted, "candidate.json")));
const expected = unseal(await readJson(resolve(clean, "candidate.json")));
assert.deepEqual(resumed, expected, "Interrupted/resumed continuation must equal clean training without repeated updates");
assert.equal(resumed.training.updates, 3);
assert.ok(resumed.changed_weights > 0);
assert.equal(resumed.runtime_admitted, false);
assert.equal(resumed.strength_verified, false);
assert.equal(resumed.lineage.parent_sha256, parent.sha256);
assert.equal(resumed.lineage.optimizer_reset, true);
assert.equal(resumed.lineage.pass_inherited, false);
assert.equal(resumed.passBias, resumed.weights[16]);
assert.ok(resumed.initialPlacementLogitParity.maximum_absolute_logit_error < 1e-12);
assert.ok(resumed.trainingLoss < resumed.initialTrainingLoss, "Tiny fixture continuation should fit its exact defensive target better");
const completeCp = await readFile(resolve(interrupted, "checkpoint.json"));
assert.equal(await defensiveWarmstartMain([...common, "--run-root", interrupted]), 0);
assert.deepEqual(await readFile(resolve(interrupted, "checkpoint.json")), completeCp, "Completed updates were repeated");

for (const file of ["PAUSE", "STOP"]) {
  const controlled = resolve(testRoot, file.toLowerCase()); await mkdir(controlled);
  await writeFile(resolve(controlled, file), "fixture");
  assert.equal(await defensiveWarmstartMain([...common, "--run-root", controlled]), 75);
  assert.equal(unseal(await readJson(resolve(controlled, "checkpoint.json"))).step, 0);
  assert.equal((await readJson(resolve(controlled, "progress.json"))).status, file === "PAUSE" ? "PAUSED" : "STOPPED");
}
const guard = await lease(clean);
try { await assert.rejects(defensiveWarmstartMain([...common, "--run-root", clean]), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
await assert.rejects(defensiveWarmstartMain(["--data-root", data, "--parent", "hex-v1", "--run-root", resolve(testRoot, "no-hex")]), /requires whole-position/);
const cp = unseal(await readJson(resolve(clean, "checkpoint.json")));
await atomic(resolve(clean, "checkpoint.json"), { ...sealed(cp), integrity: "corrupt" });
await assert.rejects(defensiveWarmstartMain([...common, "--run-root", clean]), /Corrupt evidence integrity/);
// Re-sealing a feature-tampered dataset must still fail semantic validation.
const manifestBytes = await readFile(resolve(data, "manifest.json")), manifest = JSON.parse(manifestBytes);
const samplePath = resolve(data, manifest.samples[0].path), sampleBytes = await readFile(samplePath);
const bad = unseal(JSON.parse(sampleBytes)); bad.label.moves[0].features[0] += .125;
await atomic(samplePath, sealed(bad)); manifest.samples[0].sha256 = sha(await readFile(samplePath));
await writeFile(resolve(data, "manifest.json"), `${JSON.stringify(manifest)}\n`);
await assert.rejects(defensiveWarmstartMain([...common, "--run-root", resolve(testRoot, "bad-features")]), /features disagree/);
await writeFile(samplePath, sampleBytes); await writeFile(resolve(data, "manifest.json"), manifestBytes);
// The isolated adapter preserves the complete source state and retains the
// trained seventeenth coefficient: dropping it would change this legal PASS.
const source = engineFromTrainingState(loaded.samples[0].sourceState), before = serializeEngineState(source);
const policy = createDefensiveWarmstartPolicy(resumed), ranking = policy.getTopMoves(source, source.currentPlayer, Infinity);
assert.equal(ranking.length, source.getLegalMoves().length + 1);
assert.ok(Math.abs(ranking.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-12);
assert.deepEqual(serializeEngineState(source), before, "Candidate adapter changed source edges, actor or history");
const passWeights = [...resumed.weights]; passWeights[16] = 100;
const passPolicy = createDefensiveWarmstartPolicy({ ...resumed, weights: passWeights, passBias: 100 });
assert.equal(passPolicy.getTopMoves(source, source.currentPlayer, 1)[0].point, null, "Trained PASS coefficient was silently discarded");
assert.throws(() => createDefensiveWarmstartPolicy({ ...resumed, passBias: 0.1234567 }), /PASS coefficient/);
const verify = resolve(testRoot, "verify"), verifyClean = resolve(testRoot, "verify-clean");
const verifyArgs = ["--data-root", data, "--candidate", resolve(interrupted, "candidate.json"), "--max-new-units", "10"];
assert.equal(await defensiveWarmstartVerifyMain([...verifyArgs, "--run-root", verify, "--fault-after-position-write"]), 79);
const orphanBytes = await readFile(resolve(verify, "positions/validation.json"));
assert.equal(await defensiveWarmstartVerifyMain([...verifyArgs, "--run-root", verify]), 0);
assert.deepEqual(await readFile(resolve(verify, "positions/validation.json")), orphanBytes, "Complete orphan receipt was overwritten");
assert.equal(await defensiveWarmstartVerifyMain([...verifyArgs, "--run-root", verifyClean]), 0);
const report = unseal(await readJson(resolve(verify, "report.json")));
assert.deepEqual(report, unseal(await readJson(resolve(verifyClean, "report.json"))));
assert.equal(report.evaluated_positions, 1);
assert.equal(report.training_positions_used_for_evaluation, 0);
assert.equal(report.candidate.samples, 1);
assert.equal(report.by_player_count[2].candidate.samples, 1);
assert.equal(report.by_configuration["2/triangle/5"].candidate.samples, 1);
assert.equal(report.by_configuration["2/triangle/5"].grid_size, 5);
assert.equal(report.full_games_played, 0);
assert.equal(report.strength_verified, false);
assert.equal(report.runtime_admitted, false);
assert.equal(report.teacher_search_recomputed, false);
assert.ok(Number.isFinite(report.candidate.mean_cross_entropy));
const verifyCp = await readFile(resolve(verify, "checkpoint.json"));
assert.equal(await defensiveWarmstartVerifyMain([...verifyArgs, "--run-root", verify]), 0);
assert.deepEqual(await readFile(resolve(verify, "checkpoint.json")), verifyCp);
const verifiedCheckpoint = unseal(await readJson(resolve(verify, "checkpoint.json")));
await atomic(resolve(verify, "checkpoint.json"), { ...sealed(verifiedCheckpoint), integrity: "broken" });
await assert.rejects(defensiveWarmstartVerifyMain([...verifyArgs, "--run-root", verify]), /Corrupt evidence integrity/);
console.log(JSON.stringify({ status: "PASS_BOUNDED_WARMSTART_AND_RECOVERY_ONLY", parents,
  tests: ["four-product-parents", "nonunit-temperature-logit-parity", "conditional-placement-parity", "zero-step-inherits-parent",
    "nonzero-gradient-update", "wrong-parent-resume-rejected", "interrupted-clean-parity", "completed-idempotent",
    "pause-stop", "duplicate-worker", "subset-validation", "corruption-rejected", "trailing-write-preserved", "source-feature-recomputed",
    "full-action-adapter-state-preserved", "learned-pass-coefficient-retained", "heldout-only-metrics",
    "heldout-orphan-adoption", "heldout-completed-idempotent", "heldout-corruption-rejected"],
  fixtureRoot: testRoot, productionTraining: false, strengthVerified: false, runtimeAdmitted: false }));
