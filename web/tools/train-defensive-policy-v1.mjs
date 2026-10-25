// Bounded offline candidate fitting. Output is deliberately not a runtime
// manifest: training, strength testing and product admission stay separate.
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompletedTrainingLabel, DEFENSIVE_TRAINING_CONTRACT } from "../web前端/DefensiveTrainingTeacher.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";
import { assertSourceBoundDefensiveSample } from "./defensive-training-data-v1.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
export async function loadDefensiveDataset(directory) {
  const manifestPath = resolve(directory, "manifest.json"), bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  check(manifest.schema === "lifeline-defensive-training-dataset-v1"
    && manifest.status === "COMPLETE_DATA_NOT_TRAINED" && manifest.contract?.schema === DEFENSIVE_TRAINING_CONTRACT.schema,
  "New training rejects old shallow/rollout-only datasets; compile defensive depth>=3 labels first");
  for (const [path, hash] of Object.entries(manifest.source_hashes))
    check(sha(await readFile(resolve(root, path))) === hash, `Defensive dataset source drift: ${path}`);
  const samples = [], seen = new Set();
  for (const record of manifest.samples) {
    const path = resolve(directory, record.path);
    check(path.startsWith(`${resolve(directory)}/`) || path.startsWith(`${resolve(directory)}\\`), "Dataset path escapes run root");
    check(!seen.has(record.id), "Duplicate defensive sample ID"); seen.add(record.id);
    const raw = await readFile(path); check(sha(raw) === record.sha256, "Defensive sample hash mismatch");
    const value = unseal(JSON.parse(raw));
    check(value.identity === manifest.identity && value.id === record.id && value.split === record.split
      && ["train", "validation"].includes(value.split), "Defensive sample identity/split mismatch");
    assertSourceBoundDefensiveSample(value);
    check(value.label.moves.every(move => Array.isArray(move.features) && move.features.length === 17
      && move.features.every(Number.isFinite) && move.features[16] === Number(move.point === null)), "Incomplete defensive action features");
    samples.push(value);
  }
  check(samples.some(row => row.split === "train") && samples.some(row => row.split === "validation"), "Whole-position train/validation splits are required");
  return { manifest, manifestHash: sha(bytes), samples };
}
function probabilities(moves, weights) {
  const scores = moves.map(move => move.features.reduce((sum, x, i) => sum + x * weights[i], 0));
  const max = Math.max(...scores), values = scores.map(score => Math.exp(score - max)), total = values.reduce((a, b) => a + b, 0);
  return values.map(value => value / total);
}
function loss(samples, weights) {
  return samples.reduce((sum, row) => {
    const probs = probabilities(row.label.moves, weights);
    return sum - row.label.moves.reduce((value, move, i) => value + move.target * Math.log(Math.max(1e-30, probs[i])), 0);
  }, 0) / samples.length;
}
export async function defensiveTrainMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--data-root", null), "Use --data-root complete-defensive-dataset-directory");
  const dataRoot = resolve(option("--data-root")), runRoot = resolve(option("--run-root", "local_artifacts/defensive-training-v1/model"));
  const totalUpdates = Number(option("--updates", "100")), learningRate = Number(option("--learning-rate", "0.03"));
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "30"));
  check(Number.isInteger(totalUpdates) && totalUpdates >= 1 && totalUpdates <= 1000
    && Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0
    && Number.isFinite(learningRate) && learningRate > 0 && learningRate <= 1, "Invalid bounded fitting configuration");
  const dataset = await loadDefensiveDataset(dataRoot);
  const sourcePaths = ["web/tools/train-defensive-policy-v1.mjs", "web/web前端/DefensiveTrainingTeacher.js"];
  const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(resolve(root, path)))])));
  const identity = sha(JSON.stringify({ sources, dataset: dataset.manifestHash, totalUpdates, learningRate }));
  const training = dataset.samples.filter(row => row.split === "train"), validation = dataset.samples.filter(row => row.split === "validation");
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  try {
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    const cp = old ? unseal(old) : { identity, step: 0, weights: Array(17).fill(0), units: 0 };
    check(cp.identity === identity && cp.step === cp.units && cp.step <= totalUpdates
      && cp.weights.length === 17 && cp.weights.every(Number.isFinite), "Defensive training checkpoint identity or state corruption");
    const save = async status => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.step,
        completed_updates: cp.step, total_updates: totalUpdates });
    };
    const started = Date.now(); let units = 0;
    while (cp.step < totalUpdates) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (units >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      const gradient = Array(17).fill(0);
      for (const sample of training) {
        assertCompletedTrainingLabel(sample.label); // No bypass through a legacy loader.
        const probs = probabilities(sample.label.moves, cp.weights);
        sample.label.moves.forEach((move, action) => move.features.forEach((feature, i) => {
          gradient[i] += (probs[action] - move.target) * feature / training.length;
        }));
      }
      cp.weights = cp.weights.map((weight, i) => weight - learningRate * gradient[i]);
      check(cp.weights.every(Number.isFinite), "Nonfinite defensive candidate weights");
      cp.step++; cp.units++; units++; await save("RUNNING");
      if (args.includes("--fault-after-checkpoint")) return 79;
    }
    for (const [path, hash] of Object.entries(sources))
      check(sha(await readFile(resolve(root, path))) === hash, "Defensive training source drift");
    check(sha(await readFile(resolve(dataRoot, "manifest.json"))) === dataset.manifestHash, "Defensive training dataset drift");
    await atomic(resolve(runRoot, "candidate.json"), sealed({ schema: "lifeline-defensive-linear17-candidate-v1",
      identity, weights: cp.weights, passFeature: 16, training: { dataset: dataset.manifestHash, updates: cp.step,
        minimumCompletedDepth: 3, contract: DEFENSIVE_TRAINING_CONTRACT },
      trainingLoss: loss(training, cp.weights), validationLoss: loss(validation, cp.weights),
      status: "TRAINED_NOT_STRENGTH_VERIFIED", strength_verified: false, runtime_admitted: false }));
    await save("COMPLETE"); return 0;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await defensiveTrainMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
