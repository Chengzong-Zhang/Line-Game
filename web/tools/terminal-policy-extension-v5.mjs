// Explicit, separately identified continuation. Frozen v4 inputs are read only.
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { assertPassOpportunityLabel } from "../web前端/PassOpportunityTrainingTeacher.js";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { terminalPolicyTrainMain, TERMINAL_V4_SOURCES, TERMINAL_REWARD } from "./train-terminal-policy-v4.mjs";
import { prepareTerminalMain } from "./prepare-terminal-policy-v4.mjs";
import { loadPassOpportunityParent } from "./train-pass-opportunity-v3.mjs";
import { reviewTerminalCanonicalV5, canonicalTerminalActions } from "./review-terminal-canonical-features-v5.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const key = p => p === null ? "PASS" : p.join(",");
const carryKeys = ["weights", "baseline", "baselineCount", "actualUpdates", "optimizerSteps", "eligibleSamples"];
const selectedState = model => Object.fromEntries(carryKeys.map(k => [k, model[k]]));
export const EXTENSION_V5_SOURCES = [...new Set([...TERMINAL_V4_SOURCES,
  "web/tools/terminal-policy-extension-v5.mjs", "web/tools/prepare-terminal-policy-v4.mjs",
  "web/tools/review-terminal-policy-evidence-v4.mjs", "web/tools/supervise-three-player-job.mjs",
  "web/tools/review-terminal-canonical-features-v5.mjs",
  "web/web前端/MultiplayerClock.js", "web/web前端/ResearchAI.js", "web/tools/training-policy-v1.mjs"])];

async function inputs(runRoot) {
  const input = unseal(await readJson(resolve(runRoot, "extension-input.json")));
  check(input.schema === "lifeline-terminal-policy-extension-input-v5", "Missing explicit v5 continuation identity");
  for (const [path, hash] of Object.entries(input.frozen_files)) check(sha(await readFile(resolve(root, path))) === hash, `Extension input/source drift: ${path}`);
  const parentBytes = await readFile(resolve(input.base_root, "checkpoint.json"));
  check(sha(parentBytes) === input.parent_checkpoint_sha256, "Extension direct parent checkpoint changed");
  const parent = unseal(JSON.parse(parentBytes));
  check(parent.identity === input.parent_identity && same(selectedState(parent.models["hex-v1"]), input.carry), "Extension parent model/SGD state differs");
  const config = await readJson(resolve(runRoot, "protocol.json"));
  check(config.extension_v5?.stage_id === input.stage_id && config.extension_v5.parent_checkpoint_sha256 === input.parent_checkpoint_sha256
    && config.extension_v5.carry_state_sha256 === sha(JSON.stringify(input.carry))
    && config.seed_namespace === input.seed_namespace && input.fixture === config.extension_v5.fixture
    && input.stage_id === (input.fixture ? "terminal-hex-v5-recovery-fixture-r2" : "terminal-hex-v5-targeted-extension-20261025-r2")
    && same(input.prior_candidates, config.extension_v5.prior_candidates), "Extension config/carry/fixture/stage provenance mismatch");
  const parents = { "hex-v1": await loadPassOpportunityParent("hex-v1") };
  const sourceHashes = Object.fromEntries(await Promise.all(TERMINAL_V4_SOURCES.map(async p => [p, sha(await readFile(resolve(root, p)))])));
  check(input.identity === sha(JSON.stringify({ config: sha(await readFile(resolve(runRoot, "protocol.json"))),
    sources: sourceHashes, parents, reward: TERMINAL_REWARD })), "Extension config/source-derived identity mismatch");
  for (const [alias, prior] of Object.entries(input.prior_candidates)) {
    check(prior.path === resolve(input.base_root, `models/${alias}/candidate.json`)
      && input.frozen_files[prior.path] === prior.sha256
      && sha(await readFile(prior.path)) === prior.sha256, `Extension original candidate bytes changed: ${alias}`);
  }
  return { input, parent, config };
}

export async function prepareTerminalExtensionV5({ baseRoot, runRoot, fixture = false }) {
  baseRoot = resolve(baseRoot); runRoot = resolve(runRoot);
  const baseReview = await reviewTerminalCanonicalV5(baseRoot, { allowIncomplete: true });
  const parentBytes = await readFile(resolve(baseRoot, "checkpoint.json")), parent = unseal(JSON.parse(parentBytes));
  const hex = parent.models["hex-v1"]; check(hex && !parent.active && hex.completed.length > 0, "Direct parent must have committed hex games and no active game");
  if (!fixture) check(Object.values(baseReview.models).every(m => m.natural === 24 && m.truncated === 0)
    && Object.keys(baseReview.models).length === 4 && hex.actualUpdates === 3 && hex.eligibleSamples === 4
    && hex.optimizerSteps === 4 && hex.baselineCount === 4, "Formal extension requires the audited 96-game v4/min4 failure");
  const priorCandidates = {};
  for (const alias of Object.keys(parent.models).filter(alias => alias !== "hex-v1")) {
    const path = resolve(baseRoot, `models/${alias}/candidate.json`), raw = await readFile(path), candidate = unseal(JSON.parse(raw));
    check(candidate.identity === parent.identity && same(candidate.weights, parent.models[alias].weights), `Original candidate/CP mismatch: ${alias}`);
    priorCandidates[alias] = { path, sha256: sha(raw), identity: candidate.identity };
  }
  const carry = selectedState(hex), stageId = fixture ? "terminal-hex-v5-recovery-fixture-r2" : "terminal-hex-v5-targeted-extension-20261025-r2";
  const config = await readJson(resolve(baseRoot, "protocol.json"));
  config.status = fixture ? "RECOVERY_FIXTURE_V5_NOT_FORMAL" : "PREPARED_V5_EXTENSION_NOT_STARTED";
  config.seed_namespace = `${config.seed_namespace}/${stageId}`;
  config.parents = [{ alias: "hex-v1", cells: [{ players: 4, shape: "triangle", size: 5 }] }];
  config.episodes_per_parent = 1; config.maximum_game_plies = 100;
  config.minimum_actual_updates_per_parent = carry.actualUpdates + 1;
  config.analysis = { max_attempts_per_episode: 6, learner_turns: [0, 1, 2, 3, 4, 5], max_nodes: 100000,
    time_ms: 5000, action_mask: "lexicographic-defense-prefix-0-1-4" };
  config.supervision = { max_wall_seconds: 300, worker_wall_seconds: 90, worker_units: 8,
    max_restarts: 3, max_no_progress_exits: 3, poll_ms: 100, stop_grace_seconds: 1 };
  config.extension_v5 = { schema: "lifeline-terminal-policy-full-state-extension-v5", stage_id: stageId,
    parent_root: baseRoot, parent_identity: parent.identity, parent_checkpoint_sha256: sha(parentBytes),
    carry_state_sha256: sha(JSON.stringify(carry)), carried_actual_updates: carry.actualUpdates,
    required_new_actual_updates: 1, cumulative_required_actual_updates: carry.actualUpdates + 1,
    new_planned_episodes: 1, selection: "One transparently targeted 4p triangle5 BLACK episode after the original minimum-update failure.",
    episode_identity: "Global identity is stage_id + training identity + local episode id; old local IDs are not deduplication keys.",
    preserve_original_failure: true, native_hex_prior_games: fixture ? null : 18, native_hex_prior_gradient_samples: fixture ? null : 0,
    prior_candidates: priorCandidates, fixture };
  config.scope = "Explicit post-v4 full-model-state continuation: same terminal reward/gamma and full Minimax eligibility; carry SGD/baseline exactly. One NEW natural game and nonzero update required. No old game rerun or original threshold change. Triangle-trained transfer only.";
  // Use the unmodified v4 preparation/training ABI in a new namespace.
  await mkdir(resolve(runRoot, ".."), { recursive: true });
  const draft = resolve(runRoot, "..", `${runRoot.split(/[\\/]/).at(-1)}.config-v5.json`);
  await atomic(draft, config);
  await prepareTerminalMain(["--run-root", runRoot, "--config", draft]);
  const configBytes = await readFile(resolve(runRoot, "protocol.json"));
  const parents = { "hex-v1": await loadPassOpportunityParent("hex-v1") };
  const sourceHashes = Object.fromEntries(await Promise.all(TERMINAL_V4_SOURCES.map(async p => [p, sha(await readFile(resolve(root, p)))])));
  const identity = sha(JSON.stringify({ config: sha(configBytes), sources: sourceHashes, parents, reward: TERMINAL_REWARD }));
  await atomic(resolve(runRoot, "checkpoint.json"), sealed({ schema: "lifeline-terminal-policy-checkpoint-v4", identity,
    units: 0, active: null, extension_v5: config.extension_v5,
    models: { "hex-v1": { ...structuredClone(carry), completed: [] } } }));
  const frozenFiles = Object.fromEntries(await Promise.all([...EXTENSION_V5_SOURCES, parents["hex-v1"].path, ...Object.values(priorCandidates).map(p => p.path),
    resolve(runRoot, "protocol.json")].map(async p => [p, sha(await readFile(resolve(root, p)))])));
  await atomic(resolve(runRoot, "extension-input.json"), sealed({ schema: "lifeline-terminal-policy-extension-input-v5",
    stage_id: stageId, identity, seed_namespace: config.seed_namespace, base_root: baseRoot,
    parent_identity: parent.identity, parent_checkpoint_sha256: sha(parentBytes), carry,
    frozen_files: frozenFiles, base_review: { identity: baseReview.identity, models: baseReview.models },
    original_parent: parents["hex-v1"], prior_candidates: priorCandidates, fixture, formal_training_started: false }));
  await atomic(resolve(runRoot, "progress.json"), { identity, status: "YIELDED", progress_units: 0,
    completed_episodes: 0, planned_episodes: 1, model_updates: { "hex-v1": carry.actualUpdates },
    extension_v5: { carried_updates: carry.actualUpdates, new_updates: 0, finalized: false } });
  const job = await readJson(resolve(runRoot, "job.json"));
  job.command = [process.execPath, resolve(root, "web/tools/terminal-policy-extension-v5.mjs"), "worker", "--run-root", runRoot,
    "--config", resolve(runRoot, "protocol.json"), "--max-new-units", "8", "--max-seconds", "70"];
  job.identity_files = [...new Set([...job.identity_files, ...EXTENSION_V5_SOURCES, resolve(runRoot, "extension-input.json"),
    resolve(baseRoot, "checkpoint.json")])];
  await atomic(resolve(runRoot, "job.json"), job);
  return { status: "PREPARED_V5_EXTENSION_NOT_STARTED", run_root: runRoot, job: resolve(runRoot, "job.json"),
    identity, stage_id: stageId, carry_actual_updates: carry.actualUpdates, required_new_actual_updates: 1, fixture };
}

export async function auditTerminalExtensionV5(runRoot, { requireFinalized = true } = {}) {
  runRoot = resolve(runRoot); const { input, parent, config } = await inputs(runRoot);
  const baseReview = await reviewTerminalCanonicalV5(input.base_root, { allowIncomplete: true });
  const cp = unseal(await readJson(resolve(runRoot, "checkpoint.json"))), model = cp.models["hex-v1"];
  check(cp.identity === input.identity && !cp.active && model.completed.length === 1, "Extension new-stage game incomplete");
  const record = model.completed[0], episodeBytes = await readFile(resolve(runRoot, record.path));
  check(sha(episodeBytes) === record.sha256, "Extension episode changed");
  const ep = unseal(JSON.parse(episodeBytes));
  check(ep.identity === input.identity && same(ep.previousWeights, input.carry.weights) && ep.naturalTerminal && !ep.truncated
    && ep.gamma === 1 && ep.nonterminalRewardSum === 0, "Extension state/reward/weights provenance mismatch");
  const cell = { players: 4, shape: "triangle", size: 5 };
  const initial = new GameEngine({ playerCount: 4, gridSize: 5, boardShape: "triangle", rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  initial._isReplayingBatch = true;
  check(same(config.parents, [{ alias: "hex-v1", cells: [cell] }]) && config.episodes_per_parent === 1
    && same(ep.cell, cell) && ep.id === "hex-v1-seed0" && ep.learner === "BLACK"
    && same(ep.initialState, serializeEngineState(initial)), "Extension frozen unique cell/initial state/BLACK configuration mismatch");
  const engine = engineFromTrainingState(ep.initialState), rows = [], eligible = [];
  let learnerTurns = 0, analysisAttempts = 0;
  for (const [ply, step] of ep.steps.entries()) {
    const raw = await readFile(resolve(runRoot, step.path)); check(sha(raw) === step.sha256, "Extension step changed");
    const row = unseal(JSON.parse(raw)); rows.push(row);
    check(row.identity === input.identity && row.episodeId === ep.id && row.ply === ply && row.actor === engine.currentPlayer
      && row.beforeStateHash === sha(JSON.stringify(serializeEngineState(engine))), "Extension canonical state/history/actor mismatch");
    const shouldAnalyze = row.actor === ep.learner && analysisAttempts < config.analysis.max_attempts_per_episode
      && config.analysis.learner_turns.includes(learnerTurns);
    check(!!row.analysis === shouldAnalyze, "Extension predetermined state selection differs");
    if (row.analysis) {
      analysisAttempts++;
      check(row.analysis.sourceStateHash === row.beforeStateHash && sha(JSON.stringify(row.analysis.sourceState)) === row.beforeStateHash,
        "Extension complete analysis source state differs");
    }
    if (row.actor === ep.learner) {
      check(same(row.actions, canonicalTerminalActions(engine)), "Extension noncanonical 16 placement features/PASS/order");
      const legal = [...engine.getLegalMoves().map(m => key(m.point)), "PASS"].sort();
      check(same(row.actions.map(a => key(a.point)).sort(), legal)
        && row.actions.every(a => a.features.length === 17 && a.features.every(Number.isFinite) && a.features[16] === Number(a.point === null))
        && key(row.actions[row.selectedIndex]?.point) === key(row.point), "Extension behavior legal/features/action domain differs");
      let indices = row.actions.map((_, i) => i);
      const label = row.analysis?.label;
      if (label) {
        assertPassOpportunityLabel(label);
        check(same(legal, [...label.legalActionKeys].sort()) && label.actor === row.actor
          && same(label.search, row.analysis.search), "Extension label full legal/search domain mismatch");
        const prefix = m => [m.value[0], m.value[1], m.value[4]];
        const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
        const best = label.moves.map(prefix).sort((a, b) => -compare(a, b))[0];
        const allowed = new Set(label.moves.filter(m => compare(prefix(m), best) === 0).map(m => key(m.point)));
        indices = row.actions.map((a, i) => allowed.has(key(a.point)) ? i : -1).filter(i => i >= 0);
        check(indices.length > 0 && same(indices, row.analysis.defenseMask.indices)
          && row.analysis.defenseMask.dependsOnWeights === false && row.analysis.defenseMask.usesNativeAreaOrMargin === false,
        "Extension defensive mask mismatch");
      }
      check(row.eligibleForPolicyGradient === (!!label && indices.length >= 2) && indices.includes(row.selectedIndex), "Extension eligibility/masked action mismatch");
      const logits = indices.map(i => row.actions[i].features.reduce((s, x, j) => s + x * input.carry.weights[j], 0));
      const top = Math.max(...logits), terms = logits.map(x => Math.exp(x - top)), total = terms.reduce((a, b) => a + b, 0);
      const probabilities = Array(row.actions.length).fill(0); indices.forEach((index, i) => probabilities[index] = terms[i] / total);
      check(probabilities.every((p, i) => close(p, row.probabilities[i])), "Extension masked probabilities differ");
      if (row.eligibleForPolicyGradient) eligible.push(row);
      learnerTurns++;
    } else check(!row.eligibleForPolicyGradient, "Extension opponent action supplied a gradient");
    check(row.executionAfter.learnerTurns === learnerTurns && row.executionAfter.analysisAttempts === analysisAttempts, "Extension learner/analysis counters differ");
    check((row.point === null ? engine.skipTurn() : engine.playMove(row.point)).success
      && row.afterStateHash === sha(JSON.stringify(serializeEngineState(engine)))
      && row.naturalTerminalAfterAction === engine.gameOver, "Extension canonical transition mismatch");
  }
  check(engine.gameOver && same(serializeEngineState(engine), ep.finalState), "Extension lacks natural final state");
  const areas = Object.fromEntries(engine.activePlayers.map(p => [p, engine._computeTerritory(p).area])), Ai = areas[ep.learner];
  const M = Ai - Math.max(0, ...engine.activePlayers.filter(p => p !== ep.learner && !engine.resignedPlayers.has(p)).map(p => areas[p]));
  const R = Math.sign(M) + 0.1 * M / engine.validPositions.length + 0.01 * Ai / engine.validPositions.length;
  check(close(R, ep.terminalReward) && eligible.length > 0 && eligible.length === ep.eligibleSamples.length, "Extension terminal reward or new eligibility missing");
  check(rows.every((row, i) => row.nonterminalReward === 0 && row.reward === (i === rows.length - 1 ? R : 0)
    && ep.reward_sequence[i] === row.reward), "Extension intermediate reward or wrong terminal reward");
  const gradient = Array(17).fill(0);
  for (const [i, row] of eligible.entries()) {
    check(ep.eligibleSamples[i].ply === row.ply && ep.eligibleSamples[i].gamma === 1 && ep.eligibleSamples[i].return === R, "Extension discount/return mismatch");
    const expected = Array(17).fill(0); row.actions.forEach((a, j) => a.features.forEach((x, k) => expected[k] += row.probabilities[j] * x));
    row.actions[row.selectedIndex].features.forEach((x, j) => gradient[j] += (R - input.carry.baseline) * (x - expected[j]) / eligible.length);
  }
  const norm = Math.hypot(...gradient), scale = Math.min(1, config.gradient_clip / Math.max(1e-30, norm));
  const weights = input.carry.weights.map((w, i) => w + config.learning_rate * gradient[i] * scale);
  check(norm > 0 && ep.modelUpdated && ep.optimizerStepApplied && close(ep.baselineBefore, input.carry.baseline)
    && weights.some((w, i) => w !== input.carry.weights[i]) && weights.every((w, i) => close(w, model.weights[i]))
    && same(ep.updatedWeights, model.weights), "Extension new nonzero SGD update missing or differs");
  check(model.actualUpdates === input.carry.actualUpdates + 1 && model.optimizerSteps === input.carry.optimizerSteps + 1
    && model.eligibleSamples === input.carry.eligibleSamples + eligible.length && model.baselineCount === input.carry.baselineCount + 1
    && close(model.baseline, input.carry.baseline + (R - input.carry.baseline) / model.baselineCount), "Extension cumulative optimizer/baseline counters differ");
  const qualifiedId = `${input.stage_id}/${input.identity}/${ep.id}`;
  const report = { schema: "lifeline-terminal-policy-extension-audit-v5", status: "PASS_EXPLICIT_STATE_CONTINUATION_V5", identity: input.identity,
    stage_id: input.stage_id, fixture: input.fixture, base_root: input.base_root, base_identity: parent.identity, parent_checkpoint_sha256: input.parent_checkpoint_sha256,
    new_qualified_episode_ids: [qualifiedId], carry: { actual_updates: input.carry.actualUpdates, optimizer_steps: input.carry.optimizerSteps,
      eligible_samples: input.carry.eligibleSamples, baseline: input.carry.baseline, baseline_count: input.carry.baselineCount },
    new_stage: { natural_episodes: 1, actual_updates: 1, optimizer_steps: 1, eligible_samples: eligible.length, plies: rows.length, reward: R, gamma: 1, gradient_norm: norm,
      cell: ep.cell, learner: ep.learner },
    cumulative_hex: { natural_episodes: parent.models["hex-v1"].completed.length + 1, actual_updates: model.actualUpdates,
      optimizer_steps: model.optimizerSteps, eligible_samples: model.eligibleSamples, baseline: model.baseline, baseline_count: model.baselineCount },
    original_run_review: baseReview, native_hex_prior_gradient_samples: config.extension_v5.native_hex_prior_gradient_samples,
    limitation: "Explicit post-failure targeted continuation; triangle-only gradient transfer. Original native-hex zero-gradient evidence remains. No strength/admission/release claim." };
  if (requireFinalized) {
    const receipt = unseal(await readJson(resolve(runRoot, "extension-receipt.json")));
    const candidate = unseal(await readJson(resolve(runRoot, "extension-candidate.json"))), spec = candidate.runtime_spec;
    check(receipt.identity === input.identity && same(receipt.audit, report)
      && receipt.candidate_sha256 === sha(await readFile(resolve(runRoot, "extension-candidate.json"))), "Extension finalized receipt differs");
    check(candidate.schema === "lifeline-terminal-policy-extension-candidate-v5" && candidate.identity === input.identity
      && same(candidate.weights, model.weights) && candidate.passBias === model.weights[16] && candidate.temperature === 1
      && same(spec.weights, model.weights.slice(0, 16)) && spec.passBias === model.weights[16] && spec.temperature === 1
      && spec.parent_id === input.original_parent.id && spec.parent_sha256 === input.original_parent.sha256
      && same(spec.features, input.original_parent.features.slice(0, 16)) && spec.rules_version === "territory-v3",
    "Extension candidate/runtime weights differ from the independently audited SGD checkpoint");
    check(candidate.lineage.direct_parent_identity === input.parent_identity
      && candidate.lineage.direct_parent_checkpoint_sha256 === input.parent_checkpoint_sha256
      && same(candidate.lineage.direct_parent_weights, input.carry.weights)
      && candidate.lineage.original_parent.parent_id === input.original_parent.id
      && candidate.lineage.original_parent.parent_sha256 === input.original_parent.sha256
      && same(candidate.lineage.original_parent.initial_weights, input.original_parent.initialWeights)
      && same(candidate.training.recipe, config) && same(candidate.training.reward, TERMINAL_REWARD)
      && same(candidate.training.carry, report.carry) && same(candidate.training.new_stage, report.new_stage)
      && same(candidate.training.cumulative, report.cumulative_hex), "Extension candidate provenance/carry/new/cumulative metadata differs");
  }
  return report;
}

export async function terminalExtensionWorkerV5(args) {
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  check(option("--run-root") && option("--config"), "Extension worker requires --run-root and --config");
  const runRoot = resolve(option("--run-root")), guard = await lease(resolve(runRoot, "extension-v5-worker"));
  try {
    const { input } = await inputs(runRoot);
    const code = await terminalPolicyTrainMain(args); if (code !== 0) return code;
    if (args.includes("--fault-before-extension-finalize")) return 79;
    const audit = await auditTerminalExtensionV5(runRoot, { requireFinalized: false });
    const raw = unseal(await readJson(resolve(runRoot, "models/hex-v1/candidate.json")));
    const candidate = { schema: "lifeline-terminal-policy-extension-candidate-v5", identity: input.identity,
      weights: raw.weights, passBias: raw.passBias, temperature: 1, runtime_spec: raw.runtime_spec,
      lineage: { type: "full-model-SGD-baseline-state-continuation", direct_parent_identity: input.parent_identity,
        direct_parent_checkpoint_sha256: input.parent_checkpoint_sha256, direct_parent_weights: input.carry.weights,
        original_parent: raw.lineage }, training: { recipe: raw.training.recipe, carry: audit.carry,
        new_stage: audit.new_stage, cumulative: audit.cumulative_hex, reward: TERMINAL_REWARD,
        original_run_failure_preserved: true, native_hex_prior_gradient_samples: audit.native_hex_prior_gradient_samples },
      status: "CONTINUED_NOT_ADMITTED", strength_verified: false, runtime_admitted: false };
    await atomic(resolve(runRoot, "extension-candidate.json"), sealed(candidate));
    if (args.includes("--fault-after-extension-candidate")) return 79;
    await atomic(resolve(runRoot, "extension-receipt.json"), sealed({ schema: "lifeline-terminal-policy-extension-completion-v5",
      identity: input.identity, candidate_sha256: sha(await readFile(resolve(runRoot, "extension-candidate.json"))), audit,
      original_run_failure_preserved: true, strength_verified: false, runtime_admitted: false }));
    const progress = await readJson(resolve(runRoot, "progress.json"));
    await atomic(resolve(runRoot, "progress.json"), { ...progress, extension_v5: { finalized: true, carried_updates: audit.carry.actual_updates,
      new_updates: 1, cumulative_updates: audit.cumulative_hex.actual_updates } });
    return 0;
  } catch (error) {
    const prior = await readJson(resolve(runRoot, "progress.json"), true);
    if (prior) await atomic(resolve(runRoot, "progress.json"), { ...prior, status: "FATAL", error: error.message });
    throw error;
  } finally { await new Promise(done => guard.close(done)); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(3), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  try {
    if (process.argv[2] === "prepare") console.log(JSON.stringify(await prepareTerminalExtensionV5({ baseRoot: option("--base-root"),
      runRoot: option("--run-root"), fixture: args.includes("--fixture") })));
    else if (process.argv[2] === "worker") process.exitCode = await terminalExtensionWorkerV5(args);
    else if (process.argv[2] === "audit") console.log(JSON.stringify(await auditTerminalExtensionV5(option("--run-root"))));
    else throw Error("Use prepare, worker or audit. Preparation never launches a formal job.");
  } catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
