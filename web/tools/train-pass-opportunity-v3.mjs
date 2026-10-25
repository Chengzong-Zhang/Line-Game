// New objective experiment: inherit current product logits and fit only the
// complete native-area v3 labels. Never changes an admitted product asset.
import { readFile, mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { engineFromTrainingState, assertSourceBoundPassOpportunitySample } from "./pass-opportunity-data-v3.mjs";
import { assertPassOpportunityLabel, PASS_OPPORTUNITY_TRAINING_CONTRACT } from "../web前端/PassOpportunityTrainingTeacher.js";
import { fastPolicyCandidates } from "../web前端/MultiplayerSearch.js";
import { HEX_PLAYER_FEATURES } from "../web前端/HexPlayerAI.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const key = point => point === null ? "PASS" : point.join(",");
const ASSETS = "web/web前端/assets/research-ai/";
export const WARMSTART_PARENTS = Object.freeze({
  easy: { path: `${ASSETS}multiplayer-v1/manifest.json`, id: "multiplayer-easy-v1", counts: [2, 3, 4, 5, 6] },
  "three-v4": { path: `${ASSETS}three-player-search-v4-round12.json`, id: "three-player-search-v4-round12", counts: [3] },
  "three-v1": { path: `${ASSETS}three-player-policy-v1.json`, id: "three-player-policy-v1", counts: [3] },
  "hex-v1": { path: `${ASSETS}hex-player-policy-v1.json`, id: "hex-player-policy-v1", counts: [4, 5, 6] },
});
const SOURCES = ["web/web前端/AIPassDiscipline.js", "web/tools/train-pass-opportunity-v3.mjs",
  "web/tools/pass-opportunity-data-v3.mjs", "web/tools/neural-posttraining-data-v2.mjs",
  "web/web前端/PassOpportunityTrainingTeacher.js", "web/web前端/MultiplayerSearch.js",
  "web/web前端/HexPlayerAI.js"];

export async function loadPassOpportunityDataset(directory) {
  const manifestPath = resolve(directory, "manifest.json"), bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  check(manifest.schema === "lifeline-pass-opportunity-training-dataset-v3"
    && manifest.status === "COMPLETE_DATA_NOT_TRAINED" && manifest.contract?.schema === PASS_OPPORTUNITY_TRAINING_CONTRACT.schema,
  "Pass-opportunity fitting requires the new v3 native-area complete-depth labels; old objectives cannot be relabelled");
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
    assertSourceBoundPassOpportunitySample(value);
    check(value.label.moves.every(move => Array.isArray(move.features) && move.features.length === 17
      && move.features.every(Number.isFinite) && move.features[16] === Number(move.point === null)), "Incomplete defensive action features");
    samples.push(value);
  }
  const episodeSplits = new Map(), stateSplits = new Map();
  for (const sample of samples) {
    const episode = sample.metadata.episodeId;
    check(!episodeSplits.has(episode) || episodeSplits.get(episode) === sample.split, "A game crossed training/validation splits");
    check(!stateSplits.has(sample.sourceStateHash) || stateSplits.get(sample.sourceStateHash) === sample.split, "A full state crossed training/validation splits");
    episodeSplits.set(episode, sample.split); stateSplits.set(sample.sourceStateHash, sample.split);
  }
  check(samples.some(row => row.split === "train") && samples.some(row => row.split === "validation"), "Whole-position train/validation splits are required");
  return { manifest, manifestHash: sha(bytes), samples };
}

function parentAlias(name) {
  return Object.hasOwn(WARMSTART_PARENTS, name) ? name
    : Object.keys(WARMSTART_PARENTS).find(alias => WARMSTART_PARENTS[alias].id === name);
}
function autoParent(samples) {
  const routes = new Set(samples.map(row => {
    const state = row.sourceState;
    if (state.playerCount === 3 && state.boardShape === "triangle")
      return [5, 7, 9].includes(state.gridSize) ? "three-v4" : "three-v1";
    if ([4, 5, 6].includes(state.playerCount) && state.boardShape === "hexagon") return "hex-v1";
    return "easy";
  }));
  check(routes.size === 1, "Automatic parent selection requires one product route; specify --parent for a mixed dataset");
  return [...routes][0];
}
export function initialDefensiveWeights(weights, temperature) {
  check(weights?.length === 16 && weights.every(Number.isFinite)
    && Number.isFinite(temperature) && temperature > 0, "Invalid linear parent coefficient/temperature conversion");
  const converted = [...weights.map(value => value / temperature), 0];
  check(converted.every(Number.isFinite), "Nonfinite converted parent placement logits");
  return converted;
}
export async function loadPassOpportunityParent(name = "auto", samples = []) {
  const alias = name === "auto" ? autoParent(samples) : parentAlias(name);
  check(alias, `Unsupported warm-start parent: ${name}`);
  const definition = WARMSTART_PARENTS[alias], bytes = await readFile(resolve(root, definition.path));
  const payload = JSON.parse(bytes), spec = alias === "easy"
    ? payload.models?.find(model => model.id === definition.id) : payload;
  check(spec?.id === definition.id && spec.weights?.length === 16 && spec.weights.every(Number.isFinite)
    && Number.isFinite(spec.temperature) && spec.temperature > 0,
  "Invalid current product linear-16 warm-start parent");
  check(alias !== "easy" || payload.schema?.name === "lifeline-multiplayer-runtime" && payload.schema.version === 1,
    "Invalid easy parent manifest schema");
  check(alias === "easy" || JSON.stringify(spec.features) === JSON.stringify(HEX_PLAYER_FEATURES),
    "Warm-start parent feature order differs from the shared linear contract");
  // Runtime logits are dot(features, weights) / temperature. Absorb temperature
  // into the inherited sixteen coefficients; the candidate uses temperature 1.
  // PASS had no trained logit in these parents. Its new indicator starts at 0;
  // conditional placement probabilities are inherited, PASS mass is new.
  const initialWeights = initialDefensiveWeights(spec.weights, spec.temperature);
  return { alias, id: spec.id, path: definition.path, sha256: sha(bytes),
    weights: [...spec.weights], temperature: spec.temperature, initialWeights,
    default_player_counts: [...definition.counts],
    features: [...HEX_PLAYER_FEATURES, "voluntary_pass"],
    initialization: "weights-only; parent placement weights divided by parent temperature; new PASS coefficient = 0",
    pass_inherited: false, optimizer_reset: true,
    inherited_runtime_search: false,
    note: alias === "three-v4" ? "Inherits v4's trained v2 placement weights; its rollout search is not a trainable parameter." : null };
}

export function passOpportunityProbabilities(moves, weights) {
  const scores = moves.map(move => move.features.reduce((sum, value, i) => sum + value * weights[i], 0));
  check(scores.every(Number.isFinite), "Nonfinite defensive placement/PASS logits");
  const maximum = Math.max(...scores), terms = scores.map(score => Math.exp(score - maximum));
  const total = terms.reduce((a, b) => a + b, 0);
  return terms.map(value => value / total);
}
export function createPassOpportunityPolicy(candidate) {
  check(candidate?.schema === "lifeline-pass-opportunity-linear17-candidate-v3"
    && candidate.weights?.length === 17 && candidate.weights.every(Number.isFinite)
    && candidate.passBias === candidate.weights[16], "Invalid pass-opportunity candidate");
  const weights = [...candidate.weights];
  return { lastSearch: null, getTopMoves(source, player = source.currentPlayer, topN = 5) {
    check(player === source.currentPlayer, "Only the actual actor can use the candidate");
    if (source.gameOver) return [];
    const placements = fastPolicyCandidates(source, player);
    const actions = [...placements.map(move => ({ point: [...move.point], type: "move", features: [...move.features, 0] })),
      { point: null, type: "pass", features: [...Array(16).fill(0), 1] }];
    const probs = passOpportunityProbabilities(actions, weights);
    actions.forEach((move, i) => { move.score = move.features.reduce((sum, x, j) => sum + x * weights[j], 0); move.prior = probs[i]; move.visits = 1; });
    this.lastSearch = { algorithm: "trained-pass-opportunity-linear17-v3", legalActions: actions.length, passBias: weights[16] };
    return actions.sort((a, b) => b.score - a.score || (a.point === null ? b.point === null ? 0 : 1
      : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0])).slice(0, topN);
  } };
}
function loss(samples, weights) {
  return samples.reduce((sum, row) => {
    const probabilities = passOpportunityProbabilities(row.label.moves, weights);
    return sum - row.label.moves.reduce((value, move, i) => value + move.target * Math.log(Math.max(1e-30, probabilities[i])), 0);
  }, 0) / samples.length;
}
function assertFeaturesAndInitialLogits(samples, parent) {
  let maximumLogitError = 0, placements = 0;
  for (const row of samples) {
    // A valid seal and valid teacher vector do not prove the stored input
    // features. Recompute them using the exact state, edges and Superko mask.
    const engine = engineFromTrainingState(row.sourceState);
    const expected = new Map(fastPolicyCandidates(engine).map(move => [key(move.point), move.features]));
    for (const move of row.label.moves) {
      const features = [...(move.point === null ? Array(16).fill(0) : expected.get(key(move.point))), Number(move.point === null)];
      check(features.length === 17 && features.every((value, i) => value === move.features[i]),
        "Defensive warm-start sample features disagree with its complete source state");
      if (move.point === null) continue;
      const inherited = move.features.slice(0, 16).reduce((sum, value, i) => sum + value * parent.weights[i], 0) / parent.temperature;
      const initialized = move.features.reduce((sum, value, i) => sum + value * parent.initialWeights[i], 0);
      maximumLogitError = Math.max(maximumLogitError, Math.abs(inherited - initialized)); placements++;
      check(Math.abs(inherited - initialized) <= 1e-12 * Math.max(1, Math.abs(inherited)),
        "Warm-start conversion failed to preserve inherited placement logits");
    }
  }
  return { placements, maximum_absolute_logit_error: maximumLogitError,
    scope: "same source-bound placement features; conditional placement distribution only; PASS was not inherited" };
}

export async function passOpportunityTrainMain(args) {
  const option = (name, fallback) => {
    if (!args.includes(name)) return fallback;
    const value = args[args.indexOf(name) + 1];
    check(typeof value === "string" && !value.startsWith("--"), `Missing ${name} argument`); return value;
  };
  check(option("--data-root", null), "Use --data-root complete-defensive-dataset-directory");
  const dataRoot = resolve(option("--data-root"));
  const runRoot = resolve(option("--run-root", "local_artifacts/pass-opportunity-v3/model"));
  const totalUpdates = Number(option("--updates", "100")), learningRate = Number(option("--learning-rate", "0.03"));
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "30"));
  check(Number.isInteger(totalUpdates) && totalUpdates >= 1 && totalUpdates <= 1000
    && Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0
    && Number.isFinite(learningRate) && learningRate > 0 && learningRate <= 1, "Invalid bounded warm-start fitting configuration");
  const dataset = await loadPassOpportunityDataset(dataRoot);
  const parentName = option("--parent", "auto"), requestedCounts = option("--player-counts", null);
  let counts = requestedCounts === null ? null : requestedCounts.split(",").map(Number);
  if (counts) check(counts.length > 0 && new Set(counts).size === counts.length
    && counts.every(value => Number.isInteger(value) && value >= 2 && value <= 15), "Invalid --player-counts subset");
  const matching = counts ? dataset.samples.filter(row => counts.includes(row.sourceState.playerCount)) : dataset.samples;
  const parent = await loadPassOpportunityParent(parentName, matching);
  counts ??= parent.default_player_counts; counts = [...counts].sort((a, b) => a - b);
  const samples = dataset.samples.filter(row => counts.includes(row.sourceState.playerCount));
  const training = samples.filter(row => row.split === "train"), validation = samples.filter(row => row.split === "validation");
  check(training.length > 0 && validation.length > 0, "Warm-start subset requires whole-position train and validation samples");
  const initialPlacementLogitParity = assertFeaturesAndInitialLogits(samples, parent);
  const sourceHashes = { ...dataset.manifest.source_hashes,
    ...Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, sha(await readFile(resolve(root, path)))]))) };
  const identityBody = { schema: "lifeline-pass-opportunity-warmstart-identity-v3", source_hashes: sourceHashes,
    dataset_manifest_sha256: dataset.manifestHash, parent, selected_player_counts: counts,
    sample_ids: samples.map(row => row.id), totalUpdates, learningRate, optimizer: "full-batch-gradient-descent", optimizer_reset: true };
  const identity = sha(JSON.stringify(identityBody));
  const checkInputs = async () => {
    for (const [path, hash] of Object.entries(sourceHashes))
      check(sha(await readFile(resolve(root, path))) === hash, `Warm-start source drift: ${path}`);
    check(sha(await readFile(resolve(root, parent.path))) === parent.sha256, "Warm-start parent asset drift");
    check(sha(await readFile(resolve(dataRoot, "manifest.json"))) === dataset.manifestHash, "Warm-start dataset manifest drift");
    for (const record of dataset.manifest.samples)
      check(sha(await readFile(resolve(dataRoot, record.path))) === record.sha256, "Warm-start dataset sample drift");
  };
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    const cp = old ? unseal(old) : { schema: "lifeline-pass-opportunity-warmstart-checkpoint-v3", identity,
      step: 0, units: 0, parent_id: parent.id, parent_sha256: parent.sha256,
      initial_weights: [...parent.initialWeights], weights: [...parent.initialWeights] };
    check(cp.schema === "lifeline-pass-opportunity-warmstart-checkpoint-v3" && cp.identity === identity
      && cp.parent_id === parent.id && cp.parent_sha256 === parent.sha256
      && Number.isInteger(cp.step) && cp.step >= 0 && cp.step === cp.units && cp.step <= totalUpdates
      && cp.weights?.length === 17 && cp.weights.every(Number.isFinite)
      && JSON.stringify(cp.initial_weights) === JSON.stringify(parent.initialWeights),
    "Warm-start checkpoint identity, parent or optimizer state corruption");
    await atomic(resolve(runRoot, "identity.json"), sealed(identityBody));
    const save = async status => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.step,
        completed_updates: cp.step, total_updates: totalUpdates, parent_id: parent.id,
        training_samples: training.length, validation_samples: validation.length });
    };
    const started = Date.now(); let units = 0;
    await checkInputs();
    while (cp.step < totalUpdates) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (units >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      await checkInputs();
      const gradient = Array(17).fill(0);
      for (const sample of training) {
        assertPassOpportunityLabel(sample.label);
        const probabilities = passOpportunityProbabilities(sample.label.moves, cp.weights);
        sample.label.moves.forEach((move, action) => move.features.forEach((feature, i) => {
          gradient[i] += (probabilities[action] - move.target) * feature / training.length;
        }));
      }
      const updated = cp.weights.map((weight, i) => weight - learningRate * gradient[i]);
      check(updated.every(Number.isFinite), "Nonfinite warm-start candidate weights");
      cp.weights = updated; cp.step++; cp.units++; units++; await save("RUNNING");
      if (args.includes("--fault-after-checkpoint")) return 79;
    }
    await checkInputs();
    await atomic(resolve(runRoot, "candidate.json"), sealed({ schema: "lifeline-pass-opportunity-linear17-candidate-v3",
      identity, weights: cp.weights, temperature: 1, passFeature: 16, passBias: cp.weights[16], features: parent.features,
      runtime_spec: { schema: { name: "lifeline-pass-opportunity-policy", version: 3 }, id: `pass-opportunity-${parent.alias}-v3`,
        parent_id: parent.id, parent_sha256: parent.sha256, weights: cp.weights.slice(0, 16), passBias: cp.weights[16],
        features: parent.features.slice(0, 16), temperature: 1, rules_version: "territory-v3" },
      lineage: { type: "weights-only-warm-start", parent_id: parent.id, parent_path: parent.path,
        parent_sha256: parent.sha256, parent_temperature: parent.temperature, parent_weights: parent.weights,
        initial_weights: parent.initialWeights, optimizer_reset: true, pass_inherited: false,
        initialization: parent.initialization, inherited_runtime_search: false },
      training: { dataset_manifest_sha256: dataset.manifestHash, selected_player_counts: counts,
        sample_ids: samples.map(row => row.id), training_samples: training.length, validation_samples: validation.length,
        updates: cp.step, source_hashes: sourceHashes, minimumCompletedDepth: 3,
        contract: PASS_OPPORTUNITY_TRAINING_CONTRACT, optimizer: "full-batch-gradient-descent", learning_rate: learningRate },
      initialPlacementLogitParity, initialTrainingLoss: loss(training, parent.initialWeights),
      initialValidationLoss: loss(validation, parent.initialWeights), trainingLoss: loss(training, cp.weights),
      validationLoss: loss(validation, cp.weights), changed_weights: cp.weights.filter((value, i) => value !== parent.initialWeights[i]).length,
      status: "TRAINED_NOT_STRENGTH_VERIFIED", strength_verified: false, runtime_admitted: false,
      limitations: "Native-area finite teacher horizon and imitation loss do not establish strength; runtime PASS gate and full-game acceptance remain separate from raw policy fitting." }));
    await save("COMPLETE"); return 0;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await passOpportunityTrainMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
