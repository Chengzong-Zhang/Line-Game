import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GameEngine } from "../GameEngine.js";
import { terminalPolicyTrainMain, terminalRewards, terminalLearnerSeatIndex, validateTerminalProtocol, TERMINAL_REWARD } from "../../tools/train-terminal-policy-v4.mjs";
import { engineFromTrainingState } from "../../tools/pass-opportunity-data-v3.mjs";
import { assertPassOpportunityLabel } from "../PassOpportunityTrainingTeacher.js";
import { atomic, lease, readJson, root, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

const base = await mkdtemp(resolve(root, "local_artifacts/terminal-policy-v4-recovery-")), cases = [];
for (const [cellCount, playerCount] of [[3, 3], [4, 4], [4, 5], [4, 6]]) {
  for (let cell = 0; cell < cellCount; cell++) {
    const seats = Array.from({ length: Math.floor(24 / cellCount) }, (_, visit) => terminalLearnerSeatIndex(cell + visit * cellCount, cellCount, playerCount));
    assert.equal(new Set(seats).size, playerCount, "A cell must not lock its learner to one seat");
  }
}
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/terminal-policy-v4.draft.json"), "utf8"));
config.status = "RECOVERY_FIXTURE_NOT_FORMAL_TRAINING";
config.parents = [{ alias: "easy", cells: [{ players: 2, size: 5, shape: "triangle" }] }];
config.episodes_per_parent = 1; config.maximum_game_plies = 80; config.minimum_actual_updates_per_parent = 1;
config.analysis = { max_attempts_per_episode: 2, learner_turns: [0, 1], max_nodes: 30000, time_ms: 5000,
  action_mask: "lexicographic-defense-prefix-0-1-4" };
const configPath = resolve(base, "protocol.json"); await writeFile(configPath, JSON.stringify(config));
await mkdir(resolve(base, "clean"));
await writeFile(resolve(base, "clean", "supervisor-state.json.999999.tmp"), "concurrent-supervisor-sentinel");
await writeFile(resolve(base, "clean", "checkpoint.json.999999.tmp"), "interrupted-worker-sentinel");
const args = (name, path = configPath) => ["--config", path, "--run-root", resolve(base, name), "--max-new-units", "200", "--max-seconds", "30"];
const checkpoint = async name => unseal(await readJson(resolve(base, name, "checkpoint.json")));
const candidate = async name => unseal(await readJson(resolve(base, name, "models/easy/candidate.json")));
const episode = async name => unseal(await readJson(resolve(base, name, "episodes/easy-seed0/episode.json")));

assert.throws(() => terminalRewards(new GameEngine({ gridSize: 5, rulesVersion: "territory-v3" })), /before native game termination/);
const badGamma = structuredClone(config); badGamma.reward.gamma = 0.99; assert.throws(() => validateTerminalProtocol(badGamma), /reward/);
const badReward = structuredClone(config); badReward.reward.nonterminal_reward = 1; assert.throws(() => validateTerminalProtocol(badReward), /reward/);
assert.equal(await terminalPolicyTrainMain(args("clean")), 0);
assert.equal(await readFile(resolve(base, "clean", "supervisor-state.json.999999.tmp"), "utf8"), "concurrent-supervisor-sentinel");
const clean = await candidate("clean"), cleanEpisode = await episode("clean");
assert.equal(cleanEpisode.naturalTerminal, true); assert.equal(cleanEpisode.truncated, false);
assert.ok(clean.training.actual_parameter_updates >= 1); assert.ok(cleanEpisode.gradientNorm > 0); assert.ok(cleanEpisode.eligibleSamples.length > 0);
const expected = terminalRewards(engineFromTrainingState(cleanEpisode.finalState)).details[cleanEpisode.learner].reward;
assert.equal(cleanEpisode.terminalReward, expected); assert.equal(cleanEpisode.gamma, 1);
assert.ok(cleanEpisode.reward_sequence.slice(0, -1).every(x => x === 0)); assert.equal(cleanEpisode.reward_sequence.at(-1), expected);
for (const row of cleanEpisode.eligibleSamples) assert.equal(row.return, expected);
for (const record of cleanEpisode.steps) {
  const row = unseal(await readJson(resolve(base, "clean", record.path)));
  assert.equal(row.reward, row.naturalTerminalAfterAction ? expected : 0);
  if (row.eligibleForPolicyGradient) {
    assertPassOpportunityLabel(row.analysis.label);
    assert.ok(row.analysis.defenseMask.indices.length >= 2); assert.equal(row.analysis.defenseMask.dependsOnWeights, false);
    assert.equal(row.analysis.defenseMask.usesNativeAreaOrMargin, false);
    assert.ok(row.analysis.search.maxReachedPly >= row.analysis.search.requiredDepth);
    assert.ok(row.analysis.defenseMask.indices.includes(row.selectedIndex));
    assert.ok(row.probabilities.every((p, i) => row.analysis.defenseMask.indices.includes(i) || p === 0));
    assert.ok(Math.abs(row.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  }
}
cases.push({ case: "natural-terminal-only-gamma1-nonzero-real-PG", plies: cleanEpisode.steps.length,
  eligibleSamples: cleanEpisode.eligibleSamples.length, reward: expected, gradientNorm: cleanEpisode.gradientNorm, pass: true });
for (const [name, fault] of [["orphan-step", "--fault-after-step-write"], ["step-checkpoint", "--fault-after-step"],
  ["orphan-episode", "--fault-after-episode-write"], ["episode-checkpoint", "--fault-after-episode"]]) {
  assert.equal(await terminalPolicyTrainMain([...args(name), fault]), 79);
  assert.equal(await terminalPolicyTrainMain(args(name)), 0);
  assert.deepEqual((await candidate(name)).weights, clean.weights, `${name} changed final model`);
  const resumed = await episode(name);
  assert.equal(resumed.terminalReward, cleanEpisode.terminalReward); assert.equal(resumed.steps.length, cleanEpisode.steps.length);
  assert.deepEqual(resumed.eligibleSamples, cleanEpisode.eligibleSamples);
  assert.equal((await checkpoint(name)).models.easy.optimizerSteps, 1);
  cases.push({ case: `${name}-clean-model-and-counter-parity`, pass: true });
}
const before = await readFile(resolve(base, "clean/checkpoint.json")); assert.equal(await terminalPolicyTrainMain(args("clean")), 0);
assert.deepEqual(await readFile(resolve(base, "clean/checkpoint.json")), before);
cases.push({ case: "completed-run-does-not-repeat-episode-or-update", pass: true });
const paused = resolve(base, "paused"); await mkdir(paused); await writeFile(resolve(paused, "PAUSE"), "fixture");
assert.equal(await terminalPolicyTrainMain(args("paused")), 75); assert.equal((await readJson(resolve(paused, "progress.json"))).status, "PAUSED");
const guard = await lease(paused);
try { await assert.rejects(terminalPolicyTrainMain(args("paused")), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
cases.push({ case: "pause-and-duplicate-worker-exclusion", pass: true });
const corrupt = resolve(base, "corrupt"); await mkdir(corrupt); await atomic(resolve(corrupt, "checkpoint.json"), { integrity: "invalid" });
await atomic(resolve(corrupt, "progress.json"), { identity: "prior-identity", progress_units: 7, completed_episodes: 1 });
await assert.rejects(terminalPolicyTrainMain(args("corrupt")), /Integrity|integrity/);
assert.equal((await readJson(resolve(corrupt, "progress.json"))).status, "FATAL");
assert.equal((await readJson(resolve(corrupt, "progress.json"))).progress_units, 7);
assert.deepEqual(await readJson(resolve(corrupt, "checkpoint.json")), { integrity: "invalid" });
cases.push({ case: "corrupt-checkpoint-fail-closed", pass: true });
const shortConfig = structuredClone(config); shortConfig.maximum_game_plies = 8;
const shortPath = resolve(base, "short-protocol.json"); await writeFile(shortPath, JSON.stringify(shortConfig));
await assert.rejects(terminalPolicyTrainMain(args("truncated", shortPath)), /actual parameter updates/);
const truncated = await episode("truncated"), truncatedCp = await checkpoint("truncated");
assert.equal(truncated.naturalTerminal, false); assert.equal(truncated.truncated, true);
assert.equal(truncated.terminalReward, null); assert.equal(truncated.modelUpdated, false); assert.equal(truncated.optimizerStepApplied, false);
assert.ok(truncated.reward_sequence.every(x => x === 0)); assert.equal(truncatedCp.models.easy.actualUpdates, 0);
assert.deepEqual(truncatedCp.models.easy.weights, clean.lineage.initial_weights);
cases.push({ case: "truncated-game-no-imputed-return-no-update", pass: true });
const receipt = { schema: "lifeline-terminal-policy-recovery-v4", status: "PASS_TERMINAL_POLICY_V4_BOUNDED_RECOVERY",
  command: "node web/web前端/tests/verify-terminal-policy-v4.mjs", cases, reward: TERMINAL_REWARD, fixtureRoot: base,
  formal_training_started: false, runtime_admitted: false, scope: "Deterministic tiny true policy-gradient episodes only; not strength or product admission." };
await atomic(resolve(base, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
