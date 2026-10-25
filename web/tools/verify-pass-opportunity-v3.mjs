// Independent, position-incremental held-out teacher comparison. This tool
// does not turn imitation metrics into a playing-strength/product-admission gate.
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPassOpportunityDataset } from "./train-pass-opportunity-v3.mjs";
import { loadPassOpportunityParent } from "./train-pass-opportunity-v3.mjs";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { fastPolicyCandidates } from "../web前端/MultiplayerSearch.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const key = point => point === null ? "PASS" : point.join(",");
const compare = (a, b) => b.score - a.score || (a.point === null ? b.point === null ? 0 : 1
  : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0]);
const SOURCES = ["web/tools/verify-pass-opportunity-v3.mjs", "web/tools/train-pass-opportunity-v3.mjs",
  "web/tools/train-pass-opportunity-v3.mjs", "web/tools/pass-opportunity-data-v3.mjs",
  "web/web前端/MultiplayerSearch.js", "web/web前端/PassOpportunityTrainingTeacher.js",
  "web/tools/neural-posttraining-data-v2.mjs"];
const VECTOR_NAMES = ["negative_root_node_loss", "negative_repeated_damaging_replies_beyond_first",
  "native_discrete_area_gain", "native_discrete_score_margin", "negative_root_coverage_loss",
  "negative_disconnected_root_nodes", "persistent_root_connected_cuts", "retained_enemy_node_losses", "own_nodes", "own_coverage"];

function assertCandidate(candidate) {
  check(candidate?.schema === "lifeline-pass-opportunity-linear17-candidate-v3"
    && candidate.weights?.length === 17 && candidate.weights.every(Number.isFinite)
    && candidate.temperature === 1 && candidate.passFeature === 16 && candidate.passBias === candidate.weights[16]
    && candidate.strength_verified === false && candidate.runtime_admitted === false
    && candidate.lineage?.type === "weights-only-warm-start" && candidate.lineage.optimizer_reset === true
    && candidate.lineage.pass_inherited === false && candidate.lineage.initial_weights?.length === 17,
  "Invalid isolated defensive linear17 candidate, lineage, PASS coefficient or admission flags");
  return candidate;
}
export function createPassOpportunityVerificationPolicy(candidate) {
  assertCandidate(candidate);
  const weights = [...candidate.weights];
  return { getTopMoves(source, player = source.currentPlayer, topN = 5) {
    check(player === source.currentPlayer, "Defensive candidate requires the actual current actor");
    if (source.gameOver) return [];
    // fastPolicyCandidates isolates the full history/edge state. Its optimized
    // placement enumeration must still equal the canonical legal action set.
    const placements = fastPolicyCandidates(source, player);
    const legal = source.getLegalMoves(player).map(move => key(move.point)).sort();
    check(JSON.stringify(placements.map(move => key(move.point)).sort()) === JSON.stringify(legal),
      "Candidate legal-action enumeration disagrees with canonical complete-history legality");
    const actions = [...placements.map(move => ({ type: "move", point: [...move.point], features: [...move.features, 0] })),
      { type: "pass", point: null, features: [...Array(16).fill(0), 1] }];
    for (const action of actions) action.score = action.features.reduce((sum, value, i) => sum + value * weights[i], 0);
    check(actions.every(action => Number.isFinite(action.score)), "Candidate produced nonfinite placement/PASS logits");
    const maximum = Math.max(...actions.map(action => action.score));
    const terms = actions.map(action => Math.exp(action.score - maximum)), total = terms.reduce((a, b) => a + b, 0);
    actions.forEach((action, i) => { action.prior = terms[i] / total; action.visits = 1; });
    check(actions.every(action => Number.isFinite(action.prior) && action.prior >= 0)
      && Math.abs(actions.reduce((sum, action) => sum + action.prior, 0) - 1) < 1e-12,
    "Candidate full legal placement/PASS distribution is not finite and normalized");
    return actions.sort(compare).slice(0, Math.max(0, Math.floor(topN)));
  } };
}
function compareToTeacher(row, policy) {
  check(row.split === "validation", "Training positions cannot be used as held-out evaluation units");
  const engine = engineFromTrainingState(row.sourceState), ranking = policy.getTopMoves(engine, engine.currentPlayer, Infinity);
  const expected = new Map(row.label.moves.map(move => [key(move.point), move]));
  check(ranking.length === expected.size && ranking.every(move => expected.has(key(move.point))),
    "Candidate and exact teacher use different full legal action domains");
  for (const move of ranking) check(JSON.stringify(move.features) === JSON.stringify(expected.get(key(move.point)).features),
    "Evaluation features differ from the source-bound teacher dataset");
  const selected = ranking[0], target = expected.get(key(selected.point));
  const crossEntropy = -ranking.reduce((sum, move) => sum + expected.get(key(move.point)).target
    * Math.log(Math.max(1e-30, move.prior)), 0);
  check(Number.isFinite(crossEntropy), "Nonfinite held-out cross entropy");
  const value = target.value;
  return { selected_point: selected.point, selected_pass: selected.point === null, legal_actions: ranking.length,
    cross_entropy: crossEntropy, teacher_top1_agreement: Number(target.target > 0),
    teacher_worst_reply_vector: [...value],
    teacher_worst_reply_metrics: { root_node_loss: -value[0], repeated_damaging_replies_beyond_first: -value[1],
      native_discrete_area_gain: value[2], native_discrete_score_margin: value[3], root_coverage_loss: -value[4],
      disconnected_root_nodes: -value[5], persistent_root_connected_cuts: value[6],
      retained_enemy_node_losses: value[7], own_nodes: value[8], own_coverage: value[9] } };
}
function summary(rows, name) {
  const selected = rows.map(row => row[name]), samples = selected.length;
  const mean = field => selected.reduce((sum, row) => sum + row[field], 0) / samples;
  const metrics = Object.fromEntries(Object.keys(selected[0].teacher_worst_reply_metrics).map(field => [field,
    selected.reduce((sum, row) => sum + row.teacher_worst_reply_metrics[field], 0) / samples]));
  return { samples, mean_cross_entropy: mean("cross_entropy"), teacher_top1_agreement: mean("teacher_top1_agreement"),
    pass_selections: selected.filter(row => row.selected_pass).length, mean_teacher_worst_reply_metrics: metrics };
}

export async function passOpportunityVerifyMain(args) {
  const option = (name, fallback) => {
    if (!args.includes(name)) return fallback;
    const value = args[args.indexOf(name) + 1];
    check(typeof value === "string" && !value.startsWith("--"), `Missing ${name} argument`); return value;
  };
  check(option("--data-root", null) && option("--candidate", null), "Use --data-root and --candidate isolated-candidate.json");
  const dataRoot = resolve(option("--data-root")), candidatePath = resolve(option("--candidate"));
  const runRoot = resolve(option("--run-root", "local_artifacts/pass-opportunity-v3/verification"));
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "30"));
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0,
    "Invalid bounded candidate verification budget");
  const dataset = await loadPassOpportunityDataset(dataRoot), candidateBytes = await readFile(candidatePath);
  const candidate = assertCandidate(unseal(JSON.parse(candidateBytes)));
  const parent = await loadPassOpportunityParent(candidate.lineage.parent_id);
  check(parent.sha256 === candidate.lineage.parent_sha256 && parent.path === candidate.lineage.parent_path
    && parent.temperature === candidate.lineage.parent_temperature
    && JSON.stringify(parent.weights) === JSON.stringify(candidate.lineage.parent_weights)
    && JSON.stringify(parent.initialWeights) === JSON.stringify(candidate.lineage.initial_weights),
  "Candidate parent lineage differs from current frozen product coefficients");
  check(candidate.training?.dataset_manifest_sha256 === dataset.manifestHash
    && Number.isInteger(candidate.training.updates) && candidate.training.updates >= 1,
  "Candidate dataset provenance or update count mismatch");
  const counts = candidate.training.selected_player_counts;
  check(Array.isArray(counts) && counts.length > 0 && counts.every(Number.isInteger), "Invalid candidate player-count subset");
  const subset = dataset.samples.filter(row => counts.includes(row.sourceState.playerCount));
  check(JSON.stringify(subset.map(row => row.id)) === JSON.stringify(candidate.training.sample_ids),
    "Candidate source-position subset does not match its training provenance");
  const training = subset.filter(row => row.split === "train"), validation = subset.filter(row => row.split === "validation");
  check(training.length === candidate.training.training_samples && validation.length === candidate.training.validation_samples
    && training.length > 0 && validation.length > 0, "Candidate whole-position split counts differ");
  const trainingHashes = new Set(training.map(row => row.sourceStateHash));
  check(validation.every(row => !trainingHashes.has(row.sourceStateHash)), "A training source state leaked into held-out evaluation");
  for (const [path, hash] of Object.entries(candidate.training.source_hashes))
    check(sha(await readFile(resolve(root, path))) === hash, `Candidate training source drift: ${path}`);
  const sourceHashes = { ...dataset.manifest.source_hashes, ...candidate.training.source_hashes,
    ...Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, sha(await readFile(resolve(root, path)))]))) };
  const identityBody = { schema: "lifeline-pass-opportunity-verification-identity-v3", candidate_sha256: sha(candidateBytes),
    dataset_manifest_sha256: dataset.manifestHash, parent_sha256: parent.sha256, source_hashes: sourceHashes,
    validation_ids: validation.map(row => row.id), evaluation: "full-heldout-exact-teacher-action-comparison-no-arena" };
  const identity = sha(JSON.stringify(identityBody)), candidatePolicy = createPassOpportunityVerificationPolicy(candidate);
  const parentPolicy = createPassOpportunityVerificationPolicy({ ...candidate, weights: parent.initialWeights, passBias: 0 });
  const checkInputs = async () => {
    check(sha(await readFile(candidatePath)) === identityBody.candidate_sha256, "Candidate changed during verification");
    check(sha(await readFile(resolve(root, parent.path))) === parent.sha256, "Parent changed during verification");
    check(sha(await readFile(resolve(dataRoot, "manifest.json"))) === dataset.manifestHash, "Dataset changed during verification");
    for (const [path, hash] of Object.entries(sourceHashes))
      check(sha(await readFile(resolve(root, path))) === hash, `Evaluation source drift: ${path}`);
    for (const record of dataset.manifest.samples)
      check(sha(await readFile(resolve(dataRoot, record.path))) === record.sha256, "Dataset sample changed during verification");
  };
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    const cp = old ? unseal(old) : { schema: "lifeline-pass-opportunity-verification-checkpoint-v3", identity, completed: [], units: 0 };
    check(cp.schema === "lifeline-pass-opportunity-verification-checkpoint-v3" && cp.identity === identity
      && cp.units === cp.completed.length && cp.units <= validation.length, "Evaluation checkpoint identity or progress corruption");
    const receipts = [];
    for (const [i, record] of cp.completed.entries()) {
      check(record.id === validation[i].id && record.path === `positions/${record.id}.json`, "Evaluation receipt order corruption");
      const bytes = await readFile(resolve(runRoot, record.path));
      check(sha(bytes) === record.sha256, "Completed evaluation receipt changed");
      const row = unseal(JSON.parse(bytes));
      check(row.identity === identity && row.id === record.id && row.source_state_sha256 === validation[i].sourceStateHash
        && row.split === "validation", "Completed evaluation unit identity corruption");
      receipts.push(row);
    }
    await atomic(resolve(runRoot, "identity.json"), sealed(identityBody));
    const save = async status => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.units,
        completed_positions: cp.units, total_positions: validation.length, parent_id: parent.id,
        strength_verified: false, runtime_admitted: false });
    };
    await checkInputs();
    const started = Date.now(); let units = 0;
    while (cp.units < validation.length) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (units >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      await checkInputs();
      const source = validation[cp.units], path = `positions/${source.id}.json`;
      const receipt = { schema: "lifeline-pass-opportunity-heldout-position-v3", identity, id: source.id,
        split: "validation", player_count: source.sourceState.playerCount, rules_version: source.sourceState.rulesVersion,
        board_shape: source.sourceState.boardShape, grid_size: source.sourceState.gridSize,
        source_state_sha256: source.sourceStateHash, completed_teacher_depth: source.label.search.completedDepth,
        candidate: compareToTeacher(source, candidatePolicy), parent_neutral_pass: compareToTeacher(source, parentPolicy) };
      const orphan = await readJson(resolve(runRoot, path), true);
      if (orphan) check(JSON.stringify(unseal(orphan)) === JSON.stringify(receipt), "Unindexed held-out receipt corruption");
      else await atomic(resolve(runRoot, path), sealed(receipt));
      if (args.includes("--fault-after-position-write")) return 79;
      const bytes = await readFile(resolve(runRoot, path));
      cp.completed.push({ id: source.id, path, sha256: sha(bytes) }); cp.units++; units++; receipts.push(receipt);
      await save("RUNNING");
      if (args.includes("--fault-after-checkpoint")) return 79;
    }
    await checkInputs();
    const byPlayers = Object.fromEntries([...new Set(receipts.map(row => row.player_count))].sort((a, b) => a - b).map(count => {
      const rows = receipts.filter(row => row.player_count === count);
      return [count, { candidate: summary(rows, "candidate"), parent_neutral_pass: summary(rows, "parent_neutral_pass") }];
    }));
    const configurationKey = row => `${row.player_count}/${row.board_shape}/${row.grid_size}`;
    const byConfiguration = Object.fromEntries([...new Set(receipts.map(configurationKey))].sort().map(configuration => {
      const rows = receipts.filter(row => configurationKey(row) === configuration), first = rows[0];
      return [configuration, { player_count: first.player_count, board_shape: first.board_shape, grid_size: first.grid_size,
        rules_versions: [...new Set(rows.map(row => row.rules_version))].sort(),
        candidate: summary(rows, "candidate"), parent_neutral_pass: summary(rows, "parent_neutral_pass") }];
    }));
    await atomic(resolve(runRoot, "report.json"), sealed({ schema: "lifeline-pass-opportunity-heldout-report-v3",
      status: "COMPLETE_HELDOUT_TEACHER_COMPARISON_NOT_STRENGTH_VERIFIED", identity,
      candidate_sha256: identityBody.candidate_sha256, parent_id: parent.id, parent_sha256: parent.sha256,
      dataset_manifest_sha256: dataset.manifestHash, source_hashes: sourceHashes,
      evaluated_positions: receipts.length, training_positions_used_for_evaluation: 0,
      candidate: summary(receipts, "candidate"), parent_neutral_pass: summary(receipts, "parent_neutral_pass"),
      by_player_count: byPlayers, by_configuration: byConfiguration, teacher_value_order: VECTOR_NAMES,
      legal_action_contract: "all canonical legal placements plus voluntary PASS; complete history, edges and actual actor",
      parent_comparison: "Parent placement coefficients divided by original temperature, extended with neutral PASS=0. Excludes original rollout search, safe-PASS branch and defensive runtime gate.",
      metric_interpretation: "Exact dataset teacher minimax worst-reply vectors at its finite horizon; teacher agreement and imitation loss, not observed complete-game losses or win rate.",
      teacher_search_recomputed: false, full_games_played: 0, strength_verified: false, runtime_admitted: false,
      limitations: "No independent replay of teacher search, held-out arena, statistical strength test, device acceptance, automatic model promotion or publication." }));
    await save("COMPLETE"); return 0;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await passOpportunityVerifyMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
