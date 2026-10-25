import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { prepareTerminalMain } from "../../tools/prepare-terminal-policy-v4.mjs";
import { terminalPolicyTrainMain } from "../../tools/train-terminal-policy-v4.mjs";
import { prepareTerminalExtensionV5, terminalExtensionWorkerV5, auditTerminalExtensionV5 } from "../../tools/terminal-policy-extension-v5.mjs";
import { composeTerminalV5, auditCompositeTerminalV5, exportCompositeTerminalV5 } from "../../tools/compose-terminal-policy-v5.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

// All games below are tiny recovery fixtures. No formal source or run is edited.
const base = await mkdtemp(resolve(root, "local_artifacts/terminal-extension-v5-recovery-"));
const cases = [];
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/terminal-policy-v4-20261025.json"), "utf8"));
config.status = "V5_PARENT_STATE_RECOVERY_FIXTURE_NOT_FORMAL";
config.parents = [
  { alias: "easy", cells: [{ players: 2, shape: "triangle", size: 5 }] },
  { alias: "hex-v1", cells: [{ players: 4, shape: "triangle", size: 5 }] }
];
config.episodes_per_parent = 2;
config.minimum_actual_updates_per_parent = 1;
config.maximum_game_plies = 80;
config.analysis = { max_attempts_per_episode: 6, learner_turns: [0, 1, 2, 3, 4, 5], max_nodes: 100000,
  time_ms: 5000, action_mask: "lexicographic-defense-prefix-0-1-4" };
config.supervision = { max_wall_seconds: 60, worker_wall_seconds: 20, worker_units: 8,
  max_restarts: 3, max_no_progress_exits: 3, poll_ms: 50, stop_grace_seconds: 0.2 };
const configPath = resolve(base, "parent-protocol.json"), parentRoot = resolve(base, "parent");
await atomic(configPath, config);
await prepareTerminalMain(["--run-root", parentRoot, "--config", configPath]);
assert.equal(await terminalPolicyTrainMain(["--run-root", parentRoot, "--config", resolve(parentRoot, "protocol.json"),
  "--max-new-units", "200", "--max-seconds", "45"]), 0);

const readCheckpoint = async runRoot => unseal(await readJson(resolve(runRoot, "checkpoint.json")));
const readEpisode = async (runRoot, record) => unseal(await readJson(resolve(runRoot, record.path)));
const parentCp = await readCheckpoint(parentRoot), carried = parentCp.models["hex-v1"];
const parentEpisodes = await Promise.all(carried.completed.map(record => readEpisode(parentRoot, record)));
assert.equal(carried.completed.length, 2);
assert.deepEqual(parentEpisodes.map(ep => ep.learner), ["BLACK", "WHITE"]);
assert.deepEqual(parentEpisodes.map(ep => ep.terminal.details[ep.learner].outcome), [1, -1]);
assert.ok(parentEpisodes.every(ep => ep.naturalTerminal && !ep.truncated));
assert.equal(carried.baselineCount, 2);
assert.notEqual(parentEpisodes[0].terminalReward, parentEpisodes[1].terminalReward);
assert.ok(carried.actualUpdates >= 1);
const treeHashes = async directory => {
  const hashes = {};
  const visit = async path => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else hashes[relative(directory, absolute)] = sha(await readFile(absolute));
    }
  };
  await visit(directory); return hashes;
};
const parentHashes = await treeHashes(parentRoot);
const carryKeys = ["weights", "baseline", "baselineCount", "actualUpdates", "optimizerSteps", "eligibleSamples"];
const args = runRoot => ["--run-root", runRoot, "--config", resolve(runRoot, "protocol.json"),
  "--max-new-units", "200", "--max-seconds", "35"];
const setup = async (name, baseRoot = parentRoot) => {
  const runRoot = resolve(base, name);
  const prepared = await prepareTerminalExtensionV5({ baseRoot, runRoot, fixture: true });
  const seeded = await readCheckpoint(runRoot), model = seeded.models["hex-v1"];
  assert.equal(seeded.units, 0); assert.equal(seeded.active, null); assert.deepEqual(model.completed, []);
  for (const key of carryKeys) assert.deepEqual(model[key], carried[key], `${name}: carried ${key} differs`);
  const protocol = await readJson(resolve(runRoot, "protocol.json"));
  assert.notEqual(protocol.seed_namespace, config.seed_namespace);
  assert.equal(protocol.minimum_actual_updates_per_parent, carried.actualUpdates + 1);
  assert.equal(protocol.extension_v5.parent_checkpoint_sha256, sha(await readFile(resolve(baseRoot, "checkpoint.json"))));
  return { ...prepared, runRoot, job: resolve(runRoot, "job.json") };
};
const finalized = async job => {
  const report = await auditTerminalExtensionV5(job.runRoot);
  const checkpoint = await readCheckpoint(job.runRoot), model = checkpoint.models["hex-v1"];
  const candidate = unseal(await readJson(resolve(job.runRoot, "extension-candidate.json")));
  const receipt = unseal(await readJson(resolve(job.runRoot, "extension-receipt.json")));
  assert.equal(report.new_stage.natural_episodes, 1); assert.equal(report.new_stage.actual_updates, 1);
  assert.ok(report.new_stage.gradient_norm > 0); assert.ok(report.new_stage.eligible_samples > 0);
  assert.equal(model.completed.length, 1);
  assert.equal(model.actualUpdates, carried.actualUpdates + 1);
  assert.equal(model.optimizerSteps, carried.optimizerSteps + 1);
  assert.equal(model.baselineCount, carried.baselineCount + 1);
  assert.equal(model.eligibleSamples, carried.eligibleSamples + report.new_stage.eligible_samples);
  assert.deepEqual(candidate.lineage.direct_parent_weights, carried.weights);
  assert.deepEqual(candidate.weights, model.weights);
  assert.equal(candidate.lineage.type, "full-model-SGD-baseline-state-continuation");
  assert.equal(candidate.lineage.direct_parent_checkpoint_sha256, sha(await readFile(resolve(parentRoot, "checkpoint.json"))));
  assert.equal(candidate.training.original_run_failure_preserved, true);
  assert.equal(candidate.strength_verified, false); assert.equal(candidate.runtime_admitted, false);
  assert.equal(receipt.candidate_sha256, sha(await readFile(resolve(job.runRoot, "extension-candidate.json"))));
  assert.ok(report.new_qualified_episode_ids.every(id => id.startsWith(`${report.stage_id}/${report.identity}/`)));
  assert.ok(report.new_qualified_episode_ids.every(id => !carried.completed.some(old => old.id === id)));
  return { checkpoint, candidate, receipt, report };
};

const cleanJob = await setup("clean");
assert.equal(await terminalExtensionWorkerV5(args(cleanJob.runRoot)), 0);
const clean = await finalized(cleanJob);
const cleanFiles = await Promise.all(["checkpoint.json", "extension-candidate.json", "extension-receipt.json"]
  .map(name => readFile(resolve(cleanJob.runRoot, name))));
cases.push({ case: "full-SGD-baseline-state-carry-and-one-new-nonzero-update", pass: true,
  carried_updates: carried.actualUpdates, new_updates: 1, cumulative_updates: clean.report.cumulative_hex.actual_updates });

for (const [name, fault] of [["orphan-step", "--fault-after-step-write"], ["committed-step", "--fault-after-step"],
  ["orphan-episode", "--fault-after-episode-write"], ["committed-episode", "--fault-after-episode"],
  ["before-finalize", "--fault-before-extension-finalize"], ["after-candidate", "--fault-after-extension-candidate"]]) {
  const job = await setup(name);
  assert.equal(await terminalExtensionWorkerV5([...args(job.runRoot), fault]), 79);
  const beforeResume = await readCheckpoint(job.runRoot);
  const committedFiles = Object.fromEntries(await Promise.all([
    ...beforeResume.models["hex-v1"].completed.map(record => record.path),
    ...(beforeResume.active?.steps ?? []).map(record => record.path)
  ].map(async path => [path, await readFile(resolve(job.runRoot, path))])));
  assert.equal(await terminalExtensionWorkerV5(args(job.runRoot)), 0);
  const actual = await finalized(job);
  for (const key of carryKeys) assert.deepEqual(actual.checkpoint.models["hex-v1"][key], clean.checkpoint.models["hex-v1"][key], `${name}: ${key} parity`);
  const semantics = model => model.completed.map(({ sha256, ...record }) => record);
  assert.deepEqual(semantics(actual.checkpoint.models["hex-v1"]), semantics(clean.checkpoint.models["hex-v1"]), `${name}: completed unit parity`);
  assert.equal(actual.checkpoint.units, clean.checkpoint.units, `${name}: progress parity`);
  assert.deepEqual(actual.candidate, clean.candidate, `${name}: extension candidate parity`);
  assert.deepEqual(actual.receipt, clean.receipt, `${name}: extension receipt parity`);
  assert.ok(actual.checkpoint.units >= beforeResume.units);
  for (const [path, bytes] of Object.entries(committedFiles)) assert.deepEqual(await readFile(resolve(job.runRoot, path)), bytes, `${name}: repeated committed unit`);
  cases.push({ case: `${name}-resume-same-weights-counters-and-finalization`, pass: true });
}
assert.equal(await terminalExtensionWorkerV5(args(cleanJob.runRoot)), 0);
for (const [index, name] of ["checkpoint.json", "extension-candidate.json", "extension-receipt.json"].entries())
  assert.deepEqual(await readFile(resolve(cleanJob.runRoot, name)), cleanFiles[index]);
cases.push({ case: "completed-wrapper-is-idempotent-no-repeated-update", pass: true });

const paused = await setup("pause-duplicate"), duplicateBefore = await readFile(resolve(paused.runRoot, "checkpoint.json"));
const guard = await lease(resolve(paused.runRoot, "extension-v5-worker"));
try { await assert.rejects(terminalExtensionWorkerV5(args(paused.runRoot)), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
assert.deepEqual(await readFile(resolve(paused.runRoot, "checkpoint.json")), duplicateBefore);
await writeFile(resolve(paused.runRoot, "PAUSE"), "bounded fixture");
assert.equal(await terminalExtensionWorkerV5(args(paused.runRoot)), 75);
assert.equal((await readJson(resolve(paused.runRoot, "progress.json"))).status, "PAUSED");
assert.deepEqual((await readCheckpoint(paused.runRoot)).models["hex-v1"].completed, []);
await rm(resolve(paused.runRoot, "PAUSE"));
assert.equal(await terminalExtensionWorkerV5(args(paused.runRoot)), 0);
assert.deepEqual((await finalized(paused)).candidate, clean.candidate);
cases.push({ case: "wrapper-exclusive-lease-and-pause-resume", pass: true });

const copiedParent = resolve(base, "copied-parent"); await cp(parentRoot, copiedParent, { recursive: true });
const corrupt = await setup("corrupt-parent", copiedParent);
const childBefore = await readFile(resolve(corrupt.runRoot, "checkpoint.json"));
const corruptBytes = Buffer.from(`${await readFile(resolve(copiedParent, "checkpoint.json"), "utf8")}\n`);
await writeFile(resolve(copiedParent, "checkpoint.json"), corruptBytes);
await assert.rejects(terminalExtensionWorkerV5(args(corrupt.runRoot)), /parent checkpoint changed/i);
await assert.rejects(auditTerminalExtensionV5(corrupt.runRoot, { requireFinalized: false }), /parent checkpoint changed/i);
assert.deepEqual(await readFile(resolve(corrupt.runRoot, "checkpoint.json")), childBefore);
assert.deepEqual(await readFile(resolve(copiedParent, "checkpoint.json")), corruptBytes);
assert.equal((await readJson(resolve(corrupt.runRoot, "progress.json"))).status, "FATAL");
assert.equal((await readJson(resolve(corrupt.runRoot, "progress.json"))).progress_units, 0);
assert.equal(await readJson(resolve(corrupt.runRoot, "extension-candidate.json"), true), null);
cases.push({ case: "copied-direct-parent-byte-hash-corruption-fails-closed", pass: true });

// The old v4 suite covers the inner trainer. These two cases exercise the new
// wrapper as the real supervised command, including death before finalization.
const sleep = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
const waitFor = async (read, predicate) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(15);
  }
  throw Error("V5 supervision fixture wait timeout");
};
const start = job => {
  const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", job.job],
    { cwd: root, windowsHide: true });
  let output = ""; child.stdout.on("data", value => output += value); child.stderr.on("data", value => output += value);
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  const completion = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => { clearTimeout(timer); done({ code, signal, output }); });
  });
  return { child, completion };
};
const state = job => readJson(resolve(job.runRoot, "supervisor-state.json"));
const killedWorker = await setup("real-worker-kill");
let running = start(killedWorker);
let snapshot = await waitFor(() => state(killedWorker), value => value.worker_pid && alive(value.worker_pid));
process.kill(snapshot.worker_pid, "SIGKILL");
let result = await running.completion; assert.equal(result.code, 0, result.output);
assert.ok((await state(killedWorker)).abnormal_exits >= 1);
assert.deepEqual((await finalized(killedWorker)).candidate, clean.candidate);
cases.push({ case: "real-extension-worker-kill-independent-supervisor-recovers", pass: true });

const killedSupervisor = await setup("real-supervisor-kill");
running = start(killedSupervisor);
snapshot = await waitFor(() => state(killedSupervisor), value => value.worker_pid && alive(value.worker_pid));
const duplicate = await start(killedSupervisor).completion; assert.equal(duplicate.code, 76, duplicate.output);
running.child.kill("SIGKILL"); await running.completion;
await waitFor(async () => alive(snapshot.worker_pid), value => !value);
result = await start(killedSupervisor).completion; assert.equal(result.code, 0, result.output);
assert.equal((await state(killedSupervisor)).deadline_epoch_ms, snapshot.deadline_epoch_ms);
assert.deepEqual((await finalized(killedSupervisor)).candidate, clean.candidate);
cases.push({ case: "real-supervisor-kill-duplicate-rejection-and-original-deadline", pass: true });

const extensionHashes = await treeHashes(cleanJob.runRoot), manifestPath = resolve(base, "fixture-composite.json");
const composed = await composeTerminalV5({ extensionRoot: cleanJob.runRoot, output: manifestPath, fixture: true });
const composite = unseal(await readJson(manifestPath)), compositeAudit = await auditCompositeTerminalV5(manifestPath, { allowFixture: true });
assert.equal(composed.fixture, true); assert.equal(compositeAudit.fixture, true);
assert.deepEqual(Object.keys(composite.references), ["hex-v1"]);
assert.equal(composite.references["hex-v1"].training_identity, clean.checkpoint.identity);
assert.equal(composite.references["hex-v1"].candidate_sha256, sha(await readFile(resolve(cleanJob.runRoot, "extension-candidate.json"))));
assert.equal(composite.original_run.training_identity, parentCp.identity);
assert.equal(composite.original_run.checkpoint_sha256, sha(await readFile(resolve(parentRoot, "checkpoint.json"))));
assert.equal(compositeAudit.totals.original_natural_games, 4);
assert.equal(compositeAudit.totals.new_natural_games, 1);
assert.equal(compositeAudit.totals.cumulative_hex_natural_games, 3);
assert.equal(compositeAudit.totals.cumulative_hex_updates, carried.actualUpdates + 1);
assert.equal(compositeAudit.totals.new_hex_updates, 1);
assert.equal(compositeAudit.models["hex-v1"].actual_updates, carried.actualUpdates + 1);
assert.equal(compositeAudit.original_failure_preserved, true);
cases.push({ case: "composite-audited-four-global-parent-games-and-hex-two-plus-one", pass: true });
const manifestBytes = await readFile(manifestPath);
await composeTerminalV5({ extensionRoot: cleanJob.runRoot, output: manifestPath, fixture: true });
assert.deepEqual(await readFile(manifestPath), manifestBytes);
cases.push({ case: "repeat-composition-same-process-identical-manifest", pass: true });
await assert.rejects(auditCompositeTerminalV5(manifestPath), /fixture cannot qualify/i);
cases.push({ case: "formal-composite-audit-rejects-recovery-fixture", pass: true });
const unusedExport = resolve(base, "fixture-must-not-export", "policies.js"), sentinelExport = resolve(base, "export-sentinel.js");
await writeFile(sentinelExport, "preserve-existing-product-export\n");
await assert.rejects(exportCompositeTerminalV5({ manifestPath, output: unusedExport }), /fixture cannot qualify/i);
await assert.rejects(readFile(unusedExport), { code: "ENOENT" });
await assert.rejects(exportCompositeTerminalV5({ manifestPath, output: sentinelExport }), /fixture cannot qualify/i);
assert.equal(await readFile(sentinelExport, "utf8"), "preserve-existing-product-export\n");
cases.push({ case: "fixture-export-rejected-before-creating-or-touching-output", pass: true });
for (const [name, mutate, expected] of [
  ["reference", manifest => { manifest.references["hex-v1"].candidate_sha256 = "0".repeat(64); }, /referenced candidate changed/i],
  ["parent-identity", manifest => { manifest.original_run.training_identity = "0".repeat(64); }, /stage identities\/hashes differ/i]
]) {
  const tampered = structuredClone(composite); mutate(tampered);
  const { identity, ...body } = tampered;
  tampered.identity = sha(JSON.stringify(body));
  const path = resolve(base, `resealed-composite-${name}.json`); await atomic(path, sealed(tampered));
  await assert.rejects(auditCompositeTerminalV5(path, { allowFixture: true }), expected);
  cases.push({ case: `resealed-composite-${name}-tampering-rejected`, pass: true });
}
const forgedRoot = resolve(base, "forged-extension"); await cp(cleanJob.runRoot, forgedRoot, { recursive: true });
const forgedCandidatePath = resolve(forgedRoot, "extension-candidate.json");
const forgedCandidate = unseal(await readJson(forgedCandidatePath));
forgedCandidate.weights[0] += 0.125;
forgedCandidate.runtime_spec.weights[0] = forgedCandidate.weights[0];
await atomic(forgedCandidatePath, sealed(forgedCandidate));
const forgedReceiptPath = resolve(forgedRoot, "extension-receipt.json");
const forgedReceipt = unseal(await readJson(forgedReceiptPath));
forgedReceipt.candidate_sha256 = sha(await readFile(forgedCandidatePath));
await atomic(forgedReceiptPath, sealed(forgedReceipt));
const forgedManifest = structuredClone(composite);
forgedManifest.extension_run.run_root = forgedRoot;
forgedManifest.extension_run.receipt_sha256 = sha(await readFile(forgedReceiptPath));
forgedManifest.references["hex-v1"].run_root = forgedRoot;
forgedManifest.references["hex-v1"].candidate_sha256 = sha(await readFile(forgedCandidatePath));
const { identity: forgedIdentity, ...forgedBody } = forgedManifest;
forgedManifest.identity = sha(JSON.stringify(forgedBody));
const forgedManifestPath = resolve(base, "resealed-composite-forged-weights.json");
await atomic(forgedManifestPath, sealed(forgedManifest));
await assert.rejects(auditTerminalExtensionV5(forgedRoot), /candidate|weight|checkpoint|SGD/i);
await assert.rejects(auditCompositeTerminalV5(forgedManifestPath, { allowFixture: true }), /candidate|weight|checkpoint|SGD/i);
cases.push({ case: "resealed-candidate-receipt-and-manifest-weight-forgery-rejected-by-training-binding", pass: true });

const promoteFixture = structuredClone(composite); promoteFixture.fixture = false;
const { identity: promotedIdentity, ...promotedBody } = promoteFixture;
promoteFixture.identity = sha(JSON.stringify(promotedBody));
const promotedPath = resolve(base, "resealed-fixture-flag-false.json"); await atomic(promotedPath, sealed(promoteFixture));
await assert.rejects(auditCompositeTerminalV5(promotedPath), /fixture flag\/stage differs from frozen extension input\/config/i);
cases.push({ case: "resealed-fixture-false-rejected-by-input-config-stage-before-model-set", pass: true });

const candidateParent = resolve(base, "candidate-parent"); await cp(parentRoot, candidateParent, { recursive: true });
const oldCandidateJob = await setup("changed-prior-candidate", candidateParent);
const priorPath = resolve(candidateParent, "models/easy/candidate.json");
const priorBytes = await readFile(priorPath), prior = unseal(JSON.parse(priorBytes));
const frozenInput = unseal(await readJson(resolve(oldCandidateJob.runRoot, "extension-input.json")));
assert.equal(frozenInput.prior_candidates.easy.sha256, sha(priorBytes));
assert.equal(frozenInput.frozen_files[priorPath], sha(priorBytes));
prior.status = "RESEALED_METADATA_CHANGED_AFTER_EXTENSION_PREPARE"; await atomic(priorPath, sealed(prior));
assert.deepEqual(unseal(await readJson(priorPath)).weights, parentCp.models.easy.weights);
assert.notEqual(sha(await readFile(priorPath)), sha(priorBytes));
const priorChildBytes = await readFile(resolve(oldCandidateJob.runRoot, "checkpoint.json"));
await assert.rejects(terminalExtensionWorkerV5(args(oldCandidateJob.runRoot)), /Extension input\/source drift:.*models[\\/]easy[\\/]candidate\.json/i);
await assert.rejects(auditTerminalExtensionV5(oldCandidateJob.runRoot, { requireFinalized: false }), /Extension input\/source drift:.*models[\\/]easy[\\/]candidate\.json/i);
assert.deepEqual(await readFile(resolve(oldCandidateJob.runRoot, "checkpoint.json")), priorChildBytes);
assert.equal((await readJson(resolve(oldCandidateJob.runRoot, "progress.json"))).status, "FATAL");
cases.push({ case: "resealed-old-easy-candidate-metadata-rejected-by-frozen-byte-guard", pass: true });

const nativeForgeryRoot = resolve(base, "forged-native-cell"); await cp(cleanJob.runRoot, nativeForgeryRoot, { recursive: true });
const nativeCp = await readCheckpoint(nativeForgeryRoot), nativeRecord = nativeCp.models["hex-v1"].completed[0];
const nativeEp = await readEpisode(nativeForgeryRoot, nativeRecord);
assert.equal(nativeEp.cell.shape, "triangle"); nativeEp.cell.shape = "hexagon";
await atomic(resolve(nativeForgeryRoot, nativeRecord.path), sealed(nativeEp));
nativeRecord.sha256 = sha(await readFile(resolve(nativeForgeryRoot, nativeRecord.path)));
await atomic(resolve(nativeForgeryRoot, "checkpoint.json"), sealed(nativeCp));
assert.equal(unseal(await readJson(resolve(nativeForgeryRoot, nativeRecord.path))).cell.shape, "hexagon");
await assert.rejects(auditTerminalExtensionV5(nativeForgeryRoot, { requireFinalized: false }), /frozen unique cell\/initial state\/BLACK configuration mismatch/i);
cases.push({ case: "resealed-episode-and-checkpoint-native-cell-relabel-rejected-by-frozen-configuration", pass: true });

// Forge a coherent gradient/model chain while retaining the behavior logit.
// The rejection must come from canonical engine features, before gradient/hash gates.
const featureForgeryRoot = resolve(base, "forged-orthogonal-feature"); await cp(cleanJob.runRoot, featureForgeryRoot, { recursive: true });
const featureCp = await readCheckpoint(featureForgeryRoot), featureModel = featureCp.models["hex-v1"], featureRecord = featureModel.completed[0];
const featureEp = await readEpisode(featureForgeryRoot, featureRecord), featureRows = [];
for (const record of featureEp.steps) featureRows.push(unseal(await readJson(resolve(featureForgeryRoot, record.path))));
const featureRow = featureRows.find(row => row.eligibleForPolicyGradient
  && row.analysis.defenseMask.indices.some(index => row.actions[index].point !== null && row.probabilities[index] > 0 && row.probabilities[index] < 1));
assert.ok(featureRow, "Orthogonal forgery fixture needs one placement in a nontrivial eligible mask");
const featureIndex = featureRow.analysis.defenseMask.indices.find(index => featureRow.actions[index].point !== null
  && featureRow.probabilities[index] > 0 && featureRow.probabilities[index] < 1);
const originalFeatures = [...featureRow.actions[featureIndex].features], policyWeights = carried.weights;
const projection = features => features.reduce((sum, value, index) => sum + value * policyWeights[index], 0);
const originalLogit = projection(originalFeatures), placementWeights = policyWeights.slice(0, 16);
const firstAxis = placementWeights.findIndex(weight => Math.abs(weight) > 1e-8);
assert.ok(firstAxis >= 0); const secondAxis = (firstAxis + 1) % 16;
const orthogonal = Array(17).fill(0); orthogonal[firstAxis] = 0.125 * placementWeights[secondAxis];
orthogonal[secondAxis] = -0.125 * placementWeights[firstAxis];
assert.ok(Math.abs(projection(orthogonal)) < 1e-12);
featureRow.actions[featureIndex].features = originalFeatures.map((value, index) => value + orthogonal[index]);
const forgedLogit = projection(featureRow.actions[featureIndex].features);
assert.ok(Math.abs(forgedLogit - originalLogit) < 1e-12);
assert.notDeepEqual(featureRow.actions[featureIndex].features, originalFeatures);
await atomic(resolve(featureForgeryRoot, featureEp.steps[featureRow.ply].path), sealed(featureRow));
featureEp.steps[featureRow.ply].sha256 = sha(await readFile(resolve(featureForgeryRoot, featureEp.steps[featureRow.ply].path)));
const eligibleRows = featureRows.filter(row => row.eligibleForPolicyGradient), forgedGradient = Array(17).fill(0);
for (const row of eligibleRows) {
  const expected = Array(17).fill(0);
  row.actions.forEach((action, index) => action.features.forEach((value, feature) => expected[feature] += row.probabilities[index] * value));
  row.actions[row.selectedIndex].features.forEach((value, feature) => {
    forgedGradient[feature] += (featureEp.terminalReward - carried.baseline) * (value - expected[feature]) / eligibleRows.length;
  });
}
const forgedNorm = Math.hypot(...forgedGradient), forgedScale = Math.min(1, featureEp.optimizer.gradientClip / Math.max(1e-30, forgedNorm));
const forgedWeights = carried.weights.map((weight, index) => weight + featureEp.optimizer.learningRate * forgedGradient[index] * forgedScale);
assert.notDeepEqual(forgedWeights, featureModel.weights);
featureEp.gradientNorm = forgedNorm; featureEp.updatedWeights = [...forgedWeights]; featureModel.weights = [...forgedWeights];
await atomic(resolve(featureForgeryRoot, featureRecord.path), sealed(featureEp));
featureRecord.sha256 = sha(await readFile(resolve(featureForgeryRoot, featureRecord.path)));
await atomic(resolve(featureForgeryRoot, "checkpoint.json"), sealed(featureCp));
const bindForgedWeights = candidate => {
  candidate.weights = [...forgedWeights]; candidate.passBias = forgedWeights[16];
  candidate.runtime_spec.weights = forgedWeights.slice(0, 16); candidate.runtime_spec.passBias = forgedWeights[16];
};
const rawFeatureCandidatePath = resolve(featureForgeryRoot, "models/hex-v1/candidate.json");
const rawFeatureCandidate = unseal(await readJson(rawFeatureCandidatePath)); bindForgedWeights(rawFeatureCandidate);
await atomic(rawFeatureCandidatePath, sealed(rawFeatureCandidate));
const featureCompletionPath = resolve(featureForgeryRoot, "completion-receipt.json");
const featureCompletion = unseal(await readJson(featureCompletionPath));
featureCompletion.models["hex-v1"].candidate_sha256 = sha(await readFile(rawFeatureCandidatePath));
await atomic(featureCompletionPath, sealed(featureCompletion));
const featureCandidatePath = resolve(featureForgeryRoot, "extension-candidate.json");
const featureCandidate = unseal(await readJson(featureCandidatePath)); bindForgedWeights(featureCandidate);
featureCandidate.training.new_stage.gradient_norm = forgedNorm;
await atomic(featureCandidatePath, sealed(featureCandidate));
const featureReceiptPath = resolve(featureForgeryRoot, "extension-receipt.json");
const featureReceipt = unseal(await readJson(featureReceiptPath));
featureReceipt.candidate_sha256 = sha(await readFile(featureCandidatePath)); featureReceipt.audit.new_stage.gradient_norm = forgedNorm;
await atomic(featureReceiptPath, sealed(featureReceipt));
const featureManifest = structuredClone(composite);
featureManifest.extension_run.run_root = featureForgeryRoot;
featureManifest.extension_run.receipt_sha256 = sha(await readFile(featureReceiptPath));
featureManifest.references["hex-v1"].run_root = featureForgeryRoot;
featureManifest.references["hex-v1"].candidate_sha256 = sha(await readFile(featureCandidatePath));
const { identity: oldFeatureIdentity, ...featureBody } = featureManifest;
featureManifest.identity = sha(JSON.stringify(featureBody));
const featureManifestPath = resolve(base, "resealed-orthogonal-feature-composite.json"); await atomic(featureManifestPath, sealed(featureManifest));
assert.deepEqual(unseal(await readJson(featureCandidatePath)).weights, (await readCheckpoint(featureForgeryRoot)).models["hex-v1"].weights);
assert.equal(unseal(await readJson(featureReceiptPath)).candidate_sha256, sha(await readFile(featureCandidatePath)));
await assert.rejects(auditTerminalExtensionV5(featureForgeryRoot, { requireFinalized: false }), /noncanonical 16 placement features\/PASS\/order/i);
await assert.rejects(auditCompositeTerminalV5(featureManifestPath, { allowFixture: true }), /noncanonical 16 placement features\/PASS\/order/i);
cases.push({ case: "orthogonal-feature-logit-preserved-resealed-SGD-checkpoint-runtime-receipt-manifest-rejected-canonically",
  pass: true, original_logit: originalLogit, forged_logit: forgedLogit, resealed_full_parameter_chain: true });
assert.deepEqual(await treeHashes(cleanJob.runRoot), extensionHashes, "Composition changed extension training artifacts");
assert.deepEqual(await treeHashes(parentRoot), parentHashes, "Recovery fixtures changed the read-only original parent tree");
cases.push({ case: "original-parent-evidence-byte-for-byte-unchanged", pass: true });
const receipt = { schema: "lifeline-terminal-policy-extension-recovery-v5", status: "PASS_BOUNDED_V5_STATE_CONTINUATION_RECOVERY",
  fixtureRoot: base, command: "node web/web前端/tests/verify-terminal-policy-extension-v5.mjs", cases,
  fixture_parent_rewards: parentEpisodes.map(ep => ep.terminalReward), carried_updates: carried.actualUpdates,
  new_actual_updates_per_recovered_stage: 1, formal_training_started: false, runtime_admitted: false,
  scope: "Portable tiny-game full-state extension, fault/resume and supervision fixtures only. No formal extension launch or strength claim." };
await atomic(resolve(base, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
