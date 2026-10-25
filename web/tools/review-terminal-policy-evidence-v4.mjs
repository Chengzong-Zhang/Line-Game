// Read-only post-run review. It never invokes a teacher, trains, or edits a run.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { atomic, readJson, root, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw Error(message); };
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const key = p => p === null ? "PASS" : p.join(",");
const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

export async function reviewTerminalEvidence(runRoot, { allowIncomplete = false } = {}) {
  const checkpoint = unseal(await readJson(resolve(runRoot, "checkpoint.json")));
  const completion = await readJson(resolve(runRoot, "completion-receipt.json"), true);
  const config = await readJson(resolve(runRoot, "protocol.json"), true);
  const frozen = await readJson(resolve(runRoot, "frozen-sources.json"), true);
  const supplemental = await readJson(resolve(root, "docs/verification/pass-discipline-20261025/terminal-policy-v4-supplemental-dependencies.json"), true);
  const supplementalFiles = supplemental && resolve(root, supplemental.run_root) === resolve(runRoot) ? supplemental.files : {};
  const sourceHashes = { ...frozen?.sources, ...supplementalFiles };
  const verifySources = async () => {
    for (const [path, hash] of Object.entries(sourceHashes)) check(sha(await readFile(resolve(root, path))) === hash, `Changed source dependency: ${path}`);
  };
  await verifySources();
  check(completion || allowIncomplete, "Formal completion receipt is absent");
  const closure = completion ? unseal(completion) : null;
  check(!closure || closure.identity === checkpoint.identity, "Completion identity mismatch");
  if (closure && config) check(closure.config_sha256 === sha(await readFile(resolve(runRoot, "protocol.json"))), "Completion config hash mismatch");
  if (config) check(config.reward.gamma === 1 && config.reward.nonterminal_reward === 0, "Reward protocol differs from gamma1/nonterminal0");
  const models = {};
  for (const [alias, model] of Object.entries(checkpoint.models)) {
    let eligible = 0, updates = 0, optimizerSteps = 0, baseline = 0, baselineCount = 0, priorWeights, initialWeights;
    const cells = {}, phases = { opening: 0, middle: 0, late: 0 }, natural = [];
    for (const record of model.completed) {
      const bytes = await readFile(resolve(runRoot, record.path));
      check(sha(bytes) === record.sha256, `${record.id}: changed episode receipt`);
      const episode = unseal(JSON.parse(bytes));
      check(episode.identity === checkpoint.identity && episode.alias === alias && episode.gamma === 1, `${record.id}: episode identity/gamma mismatch`);
      if (priorWeights) check(same(episode.previousWeights, priorWeights), `${record.id}: broken parameter chain`);
      else { priorWeights = [...episode.previousWeights]; initialWeights = [...priorWeights]; }
      const engine = engineFromTrainingState(episode.initialState), rows = [], gradientRows = [];
      let learnerTurns = 0, analysisAttempts = 0;
      const cellKey = `${episode.cell.players}p-${episode.cell.shape}-${episode.cell.size}`;
      const cell = cells[cellKey] ??= { episodes: 0, natural: 0, truncated: 0, actual_updates: 0, eligible_samples: 0,
        learners: {}, complete_analyses: 0, failed_analyses: 0, singleton_masks: 0, phases: { opening: 0, middle: 0, late: 0 } };
      cell.episodes++; cell.learners[episode.learner] = (cell.learners[episode.learner] ?? 0) + 1;
      for (const [ply, step] of episode.steps.entries()) {
        const raw = await readFile(resolve(runRoot, step.path)); check(sha(raw) === step.sha256, `${record.id}/${ply}: changed step`);
        const row = unseal(JSON.parse(raw)); rows.push(row);
        check(row.identity === checkpoint.identity && row.episodeId === episode.id && row.ply === ply
          && row.actor === engine.currentPlayer && !engine.gameOver
          && row.beforeStateHash === sha(JSON.stringify(serializeEngineState(engine))), `${record.id}/${ply}: state/history/actor mismatch`);
        if (config) {
          const schedule = config.analysis.learner_turns_by_cell?.[cellKey] ?? config.analysis.learner_turns;
          const selectedForAnalysis = row.actor === episode.learner && analysisAttempts < config.analysis.max_attempts_per_episode
            && schedule.includes(learnerTurns);
          check(!!row.analysis === selectedForAnalysis, `${record.id}/${ply}: analysis differs from predetermined state-selection schedule`);
        }
        if (row.analysis) {
          analysisAttempts++;
          check(row.analysis.sourceStateHash === row.beforeStateHash
            && sha(JSON.stringify(row.analysis.sourceState)) === row.beforeStateHash, `${record.id}/${ply}: analysis full-state provenance differs`);
          const label = row.analysis.label;
          if (!label) { cell.failed_analyses++; check(!row.eligibleForPolicyGradient, "Incomplete analysis supplied a gradient"); }
          else {
            cell.complete_analyses++;
            const search = row.analysis.search, required = Math.max(3, 2 * engine.activePlayers.filter(p => !engine.resignedPlayers.has(p)).length);
            const legal = [...engine.getLegalMoves().map(m => key(m.point)), "PASS"].sort();
            check(same(label.search, search) && label.actor === engine.currentPlayer && label.rulesVersion === engine.rulesVersion
              && label.moves.every(m => m.value.length === 10 && m.value.every(Number.isFinite)), `${record.id}/${ply}: teacher search/actor/value contract differs`);
            check(search.complete && !search.timedOut && search.allRootScoresExact && search.includesPass
              && search.requiredDepth === required && search.completedDepth >= required && search.maxReachedPly >= required
              && search.rootActionsCompleted === legal.length && search.candidateCap === null, `${record.id}/${ply}: incomplete depth/full roots`);
            check(same([...label.legalActionKeys].sort(), legal) && same(label.moves.map(m => key(m.point)).sort(), legal)
              && same(row.actions.map(a => key(a.point)).sort(), legal), `${record.id}/${ply}: legal action domain changed`);
            const prefix = move => [move.value[0], move.value[1], move.value[4]];
            const best = label.moves.map(prefix).sort((a, b) => -compare(a, b))[0];
            const allowed = new Set(label.moves.filter(m => compare(prefix(m), best) === 0).map(m => key(m.point)));
            const indices = row.actions.map((a, i) => allowed.has(key(a.point)) ? i : -1).filter(i => i >= 0);
            check(same(indices, row.analysis.defenseMask.indices) && row.analysis.defenseMask.dependsOnWeights === false
              && row.analysis.defenseMask.usesNativeAreaOrMargin === false, `${record.id}/${ply}: mask differs from fixed defensive prefix`);
            cell.singleton_masks += Number(indices.length === 1);
            check(row.eligibleForPolicyGradient === (indices.length >= 2), `${record.id}/${ply}: mask eligibility mismatch`);
            const scores = indices.map(i => row.actions[i].features.reduce((s, x, j) => s + x * priorWeights[j], 0));
            const maximum = Math.max(...scores), terms = scores.map(s => Math.exp(s - maximum)), Z = terms.reduce((a, b) => a + b, 0);
            const expected = Array(row.actions.length).fill(0); indices.forEach((index, i) => expected[index] = terms[i] / Z);
            check(expected.every((p, i) => close(p, row.probabilities[i])) && indices.includes(row.selectedIndex), `${record.id}/${ply}: masked behavior probabilities differ from frozen episode weights`);
          }
        } else check(!row.eligibleForPolicyGradient, "Unselected state supplied a gradient");
        learnerTurns += Number(row.actor === episode.learner);
        check(row.executionAfter.learnerTurns === learnerTurns && row.executionAfter.analysisAttempts === analysisAttempts,
          `${record.id}/${ply}: actual learner/analysis counters differ`);
        if (row.eligibleForPolicyGradient) gradientRows.push(row);
        check((row.point === null ? engine.skipTurn() : engine.playMove(row.point)).success, `${record.id}/${ply}: illegal canonical action`);
        check(row.afterStateHash === sha(JSON.stringify(serializeEngineState(engine)))
          && row.naturalTerminalAfterAction === engine.gameOver, `${record.id}/${ply}: transition differs`);
      }
      check(same(serializeEngineState(engine), episode.finalState) && engine.gameOver === episode.naturalTerminal
        && episode.truncated === !engine.gameOver, `${record.id}: final state/natural termination differs`);
      let R = null;
      if (engine.gameOver) {
        // Use the official engine territory API independently of the training helper.
        const areas = Object.fromEntries(engine.activePlayers.map(p => [p, engine._computeTerritory(p).area]));
        const Ai = areas[episode.learner], opponents = engine.activePlayers.filter(p => p !== episode.learner && !engine.resignedPlayers.has(p));
        const margin = Ai - Math.max(0, ...opponents.map(p => areas[p]));
        R = Math.sign(margin) + 0.1 * margin / engine.validPositions.length + 0.01 * Ai / engine.validPositions.length;
        check(close(R, episode.terminalReward) && same(areas, episode.terminal.areas), `${record.id}: natural native-area reward differs`);
        natural.push(episode.id); cell.natural++;
      } else { cell.truncated++; check(episode.terminalReward === null && !episode.optimizerStepApplied && !episode.modelUpdated, `${record.id}: truncated return/update`); }
      check(episode.nonterminalRewardSum === 0 && episode.reward_sequence.length === rows.length, `${record.id}: nonterminal reward metadata`);
      rows.forEach((row, i) => check(row.nonterminalReward === 0 && row.reward === (engine.gameOver && i === rows.length - 1 ? R : 0)
        && episode.reward_sequence[i] === row.reward, `${record.id}/${i}: intermediate or wrong terminal reward`));
      check(episode.eligibleSamples.length === (engine.gameOver ? gradientRows.length : 0), `${record.id}: gradient sample count differs`);
      const gradient = Array(17).fill(0);
      if (engine.gameOver) for (const [i, row] of gradientRows.entries()) {
        const receipt = episode.eligibleSamples[i]; check(receipt.ply === row.ply && receipt.gamma === 1 && close(receipt.return, R), `${record.id}: discount/return differs`);
        const expectedFeatures = Array(17).fill(0);
        row.actions.forEach((a, j) => a.features.forEach((x, k) => expectedFeatures[k] += row.probabilities[j] * x));
        row.actions[row.selectedIndex].features.forEach((x, j) => gradient[j] += (R - baseline) * (x - expectedFeatures[j]) / gradientRows.length);
        const fraction = row.ply / Math.max(1, rows.length - 1), phase = fraction < 1 / 3 ? "opening" : fraction < 2 / 3 ? "middle" : "late";
        phases[phase]++; cell.phases[phase]++; eligible++; cell.eligible_samples++;
      }
      check(close(Math.hypot(...gradient), episode.gradientNorm) && close(episode.baselineBefore, baseline), `${record.id}: gradient norm/baseline differs`);
      const apply = engine.gameOver && gradientRows.length > 0;
      const scale = Math.min(1, episode.optimizer.gradientClip / Math.max(1e-30, Math.hypot(...gradient)));
      const updated = apply ? priorWeights.map((w, j) => w + episode.optimizer.learningRate * gradient[j] * scale) : priorWeights;
      const changed = updated.some((w, j) => w !== priorWeights[j]);
      check(updated.every((w, j) => close(w, episode.updatedWeights[j])) && episode.modelUpdated === changed
        && episode.optimizerStepApplied === apply, `${record.id}: actual parameter update differs`);
      if (apply) { optimizerSteps++; baseline += (R - baseline) / (++baselineCount); }
      updates += Number(changed); cell.actual_updates += Number(changed); priorWeights = [...episode.updatedWeights];
    }
    check(updates === model.actualUpdates && optimizerSteps === model.optimizerSteps && eligible === model.eligibleSamples, `${alias}: checkpoint training counters differ`);
    if (priorWeights) check(same(priorWeights, model.weights), `${alias}: final checkpoint weights differ`);
    if (closure) {
      const raw = await readFile(resolve(runRoot, "models", alias, "candidate.json")), candidate = unseal(JSON.parse(raw));
      check(sha(raw) === closure.models[alias].candidate_sha256 && same(candidate.weights, model.weights)
        && same(candidate.lineage.initial_weights, initialWeights)
        && candidate.training.actual_parameter_updates === updates && candidate.training.eligible_minimax_samples === eligible,
      `${alias}: final candidate/completion differs`);
      check(!config || model.completed.length === config.episodes_per_parent && natural.length === model.completed.length
        && updates >= config.minimum_actual_updates_per_parent, `${alias}: planned natural games/minimum updates not met`);
    }
    models[alias] = { episodes: model.completed.length, natural: natural.length, truncated: model.completed.length - natural.length,
      actual_updates: updates, optimizer_steps: optimizerSteps, eligible_samples: eligible, phases, cells,
      planned_episodes: config?.episodes_per_parent ?? null, minimum_required_updates: config?.minimum_actual_updates_per_parent ?? null,
      natural_episode_target_met: config ? natural.length === config.episodes_per_parent && natural.length === model.completed.length : null,
      minimum_updates_met: config ? updates >= config.minimum_actual_updates_per_parent : null };
  }
  await verifySources();
  return { schema: "lifeline-terminal-policy-evidence-review-v4", status: closure ? "PASS_COMPLETED_TERMINAL_TRAINING_EVIDENCE" : "PASS_PARTIAL_COMMITTED_EVIDENCE_ONLY",
    run_root: runRoot, identity: checkpoint.identity, closure_present: !!completion,
    completion_sha256: completion ? sha(await readFile(resolve(runRoot, "completion-receipt.json"))) : null,
    reviewer_source_sha256: sha(await readFile(fileURLToPath(import.meta.url))), source_dependencies_checked: sourceHashes,
    models, checks: ["frozen-and-supplemental-source-hashes", "canonical-full-state-replay", "natural-native-area-reward", "all-nonterminal-rewards-zero", "gamma1-identical-terminal-returns",
      "receipt-completed-depth-and-all-roots", "fixed-defensive-mask-and-masked-probabilities", "recomputed-SGD-gradient-and-parameter-chain", "actual-update-and-configuration-coverage"],
    scope: "Read-only accounting and reconstruction of committed evidence; no teacher search rerun, unbiased-gradient theorem, strength, runtime admission or release claim." };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
  try {
    check(option("--run-root"), "Use --run-root RUN [--allow-incomplete] [--output REPORT]");
    const report = await reviewTerminalEvidence(resolve(option("--run-root")), { allowIncomplete: process.argv.includes("--allow-incomplete") });
    report.command = "node web/tools/review-terminal-policy-evidence-v4.mjs --run-root " + option("--run-root")
      + (process.argv.includes("--allow-incomplete") ? " --allow-incomplete" : "");
    if (option("--output")) await atomic(resolve(option("--output")), report);
    console.log(JSON.stringify(report));
  } catch (e) { console.error(e.stack); process.exitCode = 78; }
}
