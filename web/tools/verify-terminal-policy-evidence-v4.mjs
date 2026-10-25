// Independent receipt/transition/reward/gradient audit. It does not train,
// import the trainer's reward function, promote a model, or claim global strength.
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../web前端/GameEngine.js';
import { serializeEngineState } from '../web前端/AIStateProtocol.js';
import { fastPolicyCandidates } from '../web前端/MultiplayerSearch.js';
import { assertPassOpportunityLabel } from '../web前端/PassOpportunityTrainingTeacher.js';
import { engineFromTrainingState } from './defensive-training-data-v1.mjs';
import { atomic, root, sealed, unseal, sha } from './neural-posttraining-data-v2.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const key = point => point === null ? 'PASS' : point.join(',');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-11 * Math.max(1, Math.abs(a), Math.abs(b));
const vector = (actual, expected, description) => check(actual?.length === expected.length
  && actual.every((value, i) => close(value, expected[i])), description);
const rewardContract = { type: 'terminal-outcome-native-margin-area-v1', gamma: 1, outcome: 1,
  margin: 0.1, own_area: 0.01, nonterminal_reward: 0,
  formula: 'sign(A_i-maxOpponentArea)+0.1*(A_i-maxOpponentArea)/N+0.01*A_i/N' };

function independentReward(engine, learner) {
  check(engine.gameOver && engine.rulesVersion === 'territory-v3', 'Reward requires a natural v3 terminal');
  const areas = Object.fromEntries(engine.activePlayers.map(player => [player,
    GameEngine.prototype._computeOwnedWallArea.call(engine,
      [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)],
      engine._getOpponents(player).flatMap(enemy => [...engine._getPlayerNodes(enemy), ...engine._getPlayerLines(enemy)]))]));
  const other = engine.activePlayers.filter(player => player !== learner && !engine.resignedPlayers.has(player));
  const maximum = Math.max(0, ...other.map(player => areas[player])), margin = areas[learner] - maximum;
  return { areas, N: engine.validPositions.length, value: (engine.resignedPlayers.has(learner) ? -1 : Math.sign(margin))
    + 0.1 * margin / engine.validPositions.length + 0.01 * areas[learner] / engine.validPositions.length };
}
function localPath(directory, path) {
  const result = resolve(directory, path), rel = relative(resolve(directory), result);
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Evidence path escapes run root'); return result;
}
async function record(directory, reference) {
  const bytes = await readFile(localPath(directory, reference.path));
  check(sha(bytes) === reference.sha256, 'Persisted evidence hash mismatch');
  return unseal(JSON.parse(bytes));
}
function probabilities(actions, weights, mask) {
  const logits = mask.map(i => actions[i].features.reduce((sum, x, j) => sum + x * weights[j], 0));
  const maximum = Math.max(...logits), exp = logits.map(value => Math.exp(value - maximum));
  const total = exp.reduce((sum, value) => sum + value, 0), result = Array(actions.length).fill(0);
  mask.forEach((index, i) => { result[index] = exp[i] / total; }); return result;
}
function defensiveMask(label, actions) {
  const prefix = move => [move.value[0], move.value[1], move.value[4]];
  const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const best = label.moves.reduce((current, move) => compare(prefix(move), current) > 0 ? prefix(move) : current, prefix(label.moves[0]));
  const allowed = new Set(label.moves.filter(move => compare(prefix(move), best) === 0).map(move => key(move.point)));
  return actions.map((move, i) => allowed.has(key(move.point)) ? i : -1).filter(i => i >= 0);
}

export async function auditTerminalPolicyEvidence(runDirectory, { sourceRoot = root, configPath = null, checkCurrentSource = true } = {}) {
  const directory = resolve(runDirectory), completeBytes = await readFile(resolve(directory, 'completion-receipt.json'));
  const completion = unseal(JSON.parse(completeBytes)), checkpoint = unseal(JSON.parse(await readFile(resolve(directory, 'checkpoint.json'))));
  check(completion.schema === 'lifeline-terminal-policy-completion-v4'
    && completion.status === 'TERMINAL_TRAINING_COMPLETE_NOT_ADMITTED' && completion.gamma === 1
    && same(completion.reward, rewardContract) && checkpoint.schema === 'lifeline-terminal-policy-checkpoint-v4'
    && checkpoint.identity === completion.identity && checkpoint.active === null, 'Training completion/checkpoint reward contract mismatch');
  const output = {}, inputHashes = { 'completion-receipt.json': sha(completeBytes) };
  let totalActions = 0, totalEpisodes = 0;
  for (const [alias, admitted] of Object.entries(completion.models)) {
    const candidatePath = `models/${alias}/candidate.json`, candidateBytes = await readFile(resolve(directory, candidatePath));
    check(sha(candidateBytes) === admitted.candidate_sha256, 'Trained candidate hash mismatch');
    const candidate = unseal(JSON.parse(candidateBytes)), model = checkpoint.models[alias], recipe = candidate.training?.recipe;
    check(candidate.schema === 'lifeline-terminal-policy-linear17-candidate-v4' && candidate.parent_alias === alias
      && candidate.identity === completion.identity && model && recipe?.schema === 'lifeline-terminal-policy-protocol-v4'
      && same(recipe.reward, rewardContract) && same(candidate.training.reward, rewardContract)
      && candidate.training.gamma === 1 && same(candidate.training.source_hashes, completion.source_hashes)
      && candidate.training.config_sha256 === completion.config_sha256, 'Candidate training identity/terminal recipe mismatch');
    const actualConfig = configPath ?? resolve(directory, 'protocol.json');
    const configBytes = await readFile(actualConfig);
    check(sha(configBytes) === completion.config_sha256 && same(JSON.parse(configBytes), recipe), 'Frozen training configuration mismatch');
    const parentBytes = await readFile(resolve(sourceRoot, candidate.lineage.parent_path));
    check(sha(parentBytes) === candidate.lineage.parent_sha256, 'Original parent identity mismatch');
    const parentPayload = JSON.parse(parentBytes), parent = alias === 'easy'
      ? parentPayload.models.find(row => row.id === candidate.lineage.parent_id) : parentPayload;
    check(parent.id === candidate.lineage.parent_id && parent.weights.length === 16 && parent.temperature > 0, 'Original parent contract mismatch');
    let weights = [...parent.weights.map(value => value / parent.temperature), 0], baseline = 0, baselineCount = 0,
      actualUpdates = 0, optimizerSteps = 0, eligibleSamples = 0, natural = 0, truncated = 0, minimumDepth = Infinity, maximumReturnError = 0;
    const coverageCells = {}, coveragePhases = { opening: 0, middle: 0, late: 0 }, coverageSamples = [];
    vector(candidate.lineage.initial_weights, weights, 'Parent temperature/logit inheritance mismatch');
    check(model.completed.length === recipe.episodes_per_parent && candidate.training.episodes === model.completed.length,
      'Missing completed training episodes');
    const cells = recipe.parents.find(row => row.alias === alias)?.cells; check(cells?.length, 'Missing parent training cells');
    for (const [episodeIndex, reference] of model.completed.entries()) {
      const episode = await record(directory, reference); inputHashes[reference.path] = reference.sha256;
      check(episode.schema === 'lifeline-terminal-policy-episode-v4' && episode.identity === completion.identity && episode.alias === alias
        && episode.id === reference.id && episode.gamma === 1 && episode.nonterminalRewardSum === 0
        && episode.noIntermediateAreaReward === true && episode.noDurationReward === true
        && episode.id === `${alias}-seed${episodeIndex}` && same(episode.cell, cells[episodeIndex % cells.length]), 'Episode identity/reward/cell contract mismatch');
      vector(episode.previousWeights, weights, 'Training episode does not continue the prior parameter state');
      const engine = engineFromTrainingState(episode.initialState), steps = [], eligible = [];
      check(engine.turnCount === 0 && !engine.gameOver && engine.rulesVersion === 'territory-v3', 'Training episode must begin from a fresh native game');
      const seatIndex = recipe.coverage_policy?.includes('cell-visit seat rotation') ? Math.floor(episodeIndex / cells.length) : episodeIndex;
      check(episode.learner === engine.activePlayers[seatIndex % engine.activePlayers.length], 'Learner seat differs from the frozen cell/seat schedule');
      for (const [ply, stepReference] of episode.steps.entries()) {
        const step = await record(directory, stepReference); inputHashes[stepReference.path] = stepReference.sha256;
        const state = serializeEngineState(engine), actor = engine.currentPlayer;
        check(!engine.gameOver && step.schema === 'lifeline-terminal-policy-step-v4'
          && step.identity === completion.identity && step.episodeId === episode.id && step.ply === ply
          && step.actor === actor && step.learner === episode.learner && step.beforeStateHash === sha(JSON.stringify(state))
          && step.nonterminalReward === 0, 'Training step canonical identity/history/reward mismatch');
        if (actor === episode.learner) {
          const actions = [...fastPolicyCandidates(engine).map(move => ({ point: [...move.point], features: [...move.features, 0] })),
            { point: null, features: [...Array(16).fill(0), 1] }];
          check(same(step.actions, actions) && Number.isInteger(step.selectedIndex)
            && key(step.point) === key(actions[step.selectedIndex]?.point), 'Training action domain/features/selected index mismatch');
          let mask = actions.map((_, i) => i), exact = false;
          if (step.analysis?.label) {
            const label = assertPassOpportunityLabel(step.analysis.label);
            check(same(step.analysis.sourceState, state) && step.analysis.sourceStateHash === step.beforeStateHash
              && same(label.search, step.analysis.search) && label.actor === actor
              && same([...label.legalActionKeys].sort(), actions.map(move => key(move.point)).sort()),
            'Completed Minimax sample is not bound to the exact full legal-root state');
            mask = defensiveMask(label, actions); exact = true;
            check(same(step.analysis.defenseMask.indices, mask) && step.analysis.defenseMask.usesNativeAreaOrMargin === false
              && step.analysis.defenseMask.allLegalRootValuesRetained === true, 'Defensive eligibility action mask mismatch');
          }
          vector(step.probabilities, probabilities(actions, weights, mask), 'Masked policy probabilities mismatch');
          check(step.probabilities[step.selectedIndex] > 0 && step.eligibleForPolicyGradient === (exact && mask.length >= 2), 'Illegal/singleton/incomplete state entered policy gradient');
          if (step.eligibleForPolicyGradient) { eligible.push({ ply, step }); minimumDepth = Math.min(minimumDepth, step.analysis.search.completedDepth); }
        } else check(step.eligibleForPolicyGradient === false && step.actions === null && step.probabilities === null, 'Opponent context entered policy gradient');
        check((step.point === null ? engine.skipTurn() : engine.playMove(step.point)).success
          && step.afterStateHash === sha(JSON.stringify(serializeEngineState(engine)))
          && step.naturalTerminalAfterAction === engine.gameOver, 'Training transition/terminal witness mismatch');
        steps.push(step); totalActions++;
      }
      check(same(serializeEngineState(engine), episode.finalState) && episode.naturalTerminal === engine.gameOver
        && episode.truncated === !engine.gameOver && episode.steps.length > 0, 'Episode terminal/canonical final state mismatch');
      const reward = engine.gameOver ? independentReward(engine, episode.learner) : null;
      const cellKey = `${episode.cell.players}p-${episode.cell.shape}-${episode.cell.size}`;
      const coverage = coverageCells[cellKey] ??= { episodes: 0, natural_episodes: 0, truncated_episodes: 0,
        actual_updates: 0, analysis_attempts: 0, complete_analyses: 0, eligible_samples: 0,
        singleton_masks: 0, incomplete_analyses: 0, learners: {}, phases: { opening: 0, middle: 0, late: 0 } };
      coverage.episodes++; coverage.natural_episodes += Number(engine.gameOver); coverage.truncated_episodes += Number(!engine.gameOver);
      coverage.learners[episode.learner] = (coverage.learners[episode.learner] ?? 0) + 1;
      for (const row of steps) if (row.analysis) {
        coverage.analysis_attempts++; coverage.complete_analyses += Number(Boolean(row.analysis.label));
        coverage.incomplete_analyses += Number(!row.analysis.label); coverage.singleton_masks += Number(row.analysis.defenseMask?.indices.length === 1);
        if (reward && row.eligibleForPolicyGradient) {
          const fraction = row.ply / Math.max(1, steps.length - 1), phase = fraction < 1 / 3 ? 'opening' : fraction < 2 / 3 ? 'middle' : 'late';
          coverage.eligible_samples++; coverage.phases[phase]++; coveragePhases[phase]++;
          coverageSamples.push({ episode: episode.id, cell: cellKey, ply: row.ply, learner_turn: row.executionAfter.learnerTurns - 1,
            phase, completed_depth: row.analysis.search.completedDepth, actual_max_depth: row.analysis.search.maxReachedPly,
            mask_size: row.analysis.defenseMask.indices.length });
        }
      }
      check(reward ? close(episode.terminalReward, reward.value) && same(episode.terminal.areas, reward.areas)
        : episode.terminalReward === null && episode.terminal === null, 'Terminal reward differs from native final area/outcome');
      const expectedRewards = steps.map((_, i) => reward && i === steps.length - 1 ? reward.value : 0);
      vector(episode.reward_sequence, expectedRewards, 'Intermediate/duration reward or nonterminal reward detected');
      steps.forEach((step, i) => check(close(step.reward, expectedRewards[i]), 'Per-step reward differs from the terminal-only sequence'));
      check(episode.eligibleSamples.length === (reward ? eligible.length : 0), 'Truncated/context sample counted as a gradient return');
      const gradient = Array(17).fill(0);
      if (reward) for (const [index, { ply, step }] of eligible.entries()) {
        const sample = episode.eligibleSamples[index];
        check(sample.ply === ply && sample.gamma === 1 && close(sample.return, reward.value)
          && sample.analysisCompletedDepth === step.analysis.search.completedDepth
          && sample.analysisActualMaxDepth === step.analysis.search.maxReachedPly, 'Eligible time index has a discounted/nonterminal/unproved return');
        maximumReturnError = Math.max(maximumReturnError, Math.abs(sample.return - expectedRewards.slice(ply).reduce((sum, value) => sum + value, 0)));
        const expected = Array(17).fill(0);
        step.actions.forEach((action, i) => action.features.forEach((x, j) => { expected[j] += step.probabilities[i] * x; }));
        step.actions[step.selectedIndex].features.forEach((x, j) => { gradient[j] += (reward.value - baseline) * (x - expected[j]) / eligible.length; });
      }
      const norm = Math.hypot(...gradient), scale = Math.min(1, recipe.gradient_clip / Math.max(1e-30, norm));
      const updated = reward && eligible.length ? weights.map((w, i) => w + recipe.learning_rate * gradient[i] * scale) : [...weights];
      const changed = updated.some((value, i) => value !== weights[i]);
      check(close(episode.gradientNorm, norm) && close(episode.baselineBefore, baseline)
        && episode.modelUpdated === changed && episode.optimizerStepApplied === Boolean(reward && eligible.length), 'Actual REINFORCE update/gradient/baseline mismatch');
      vector(episode.updatedWeights, updated, 'Recorded trained weights differ from independently reconstructed terminal policy gradient');
      weights = updated; actualUpdates += Number(changed);
      coverage.actual_updates += Number(changed);
      if (reward) { natural++; if (eligible.length) { optimizerSteps++; eligibleSamples += eligible.length; baseline += (reward.value - baseline) / (++baselineCount); } }
      else { truncated++; check(!changed && norm === 0 && !episode.optimizerStepApplied, 'Truncated episode changed model/optimizer'); }
      totalEpisodes++;
    }
    vector(model.weights, weights, 'Checkpoint weights mismatch'); vector(candidate.weights, weights, 'Exported candidate weights mismatch');
    vector(candidate.runtime_spec.weights, weights.slice(0, 16), 'Runtime placement parameters mismatch');
    check(candidate.runtime_spec.passBias === weights[16] && candidate.runtime_spec.temperature === 1
      && model.actualUpdates === actualUpdates && admitted.actual_parameter_updates === actualUpdates
      && candidate.training.actual_parameter_updates === actualUpdates && actualUpdates >= recipe.minimum_actual_updates_per_parent
      && model.optimizerSteps === optimizerSteps && model.eligibleSamples === eligibleSamples
      && admitted.eligible_minimax_samples === eligibleSamples && candidate.training.eligible_minimax_samples === eligibleSamples
      && candidate.training.naturally_completed_episodes === natural && candidate.training.truncated_episodes === truncated,
    'Candidate update, terminal, eligibility or optimizer counts mismatch');
    check(close(model.baseline, baseline) && model.baselineCount === baselineCount, 'Final running terminal baseline mismatch');
    if (recipe.coverage_policy?.includes('Any truncated game prevents completion')) check(truncated === 0, 'Truncated training game invalidates this frozen completion protocol');
    for (const coverage of [candidate.training.coverage, admitted.coverage].filter(Boolean)) check(same(coverage.cells, coverageCells)
      && same(coverage.eligible_phase_counts, coveragePhases) && same(coverage.eligible_samples, coverageSamples), 'Reported training cell/phase coverage mismatch');
    output[alias] = { candidate_sha256: admitted.candidate_sha256, episodes: model.completed.length, natural_episodes: natural,
      truncated_episodes: truncated, actual_parameter_updates: actualUpdates, optimizer_steps: optimizerSteps,
      eligible_minimax_samples: eligibleSamples, minimum_completed_depth: minimumDepth, maximum_undiscounted_return_error: maximumReturnError,
      parent_sha256: candidate.lineage.parent_sha256, parent_id: candidate.lineage.parent_id,
      runtime_parameters_sha256: sha(JSON.stringify({ weights: weights.slice(0, 16), passBias: weights[16], temperature: 1, rules_version: 'territory-v3' })),
      coverage: { cells: coverageCells, eligible_phase_counts: coveragePhases,
        phase_definition: 'Realized game-ply thirds, not an assertion of strategic opening/middle/endgame coverage.' } };
    inputHashes[candidatePath] = sha(candidateBytes);
  }
  check(checkpoint.units === totalActions + totalEpisodes, 'Training progress units do not match durable episode actions');
  if (checkCurrentSource) for (const [path, hash] of Object.entries(completion.source_hashes))
    check(sha(await readFile(resolve(sourceRoot, path))) === hash, `Training source drift: ${path}`);
  return { schema: 'lifeline-terminal-policy-independent-audit-v4', status: 'PASS', identity: completion.identity,
    gamma: 1, reward: rewardContract, models: output, total_episodes: totalEpisodes, total_actions: totalActions,
    checks: ['canonical full-history transition replay', 'complete exact-depth/full-root/PASS eligibility receipts bound to legal states',
      'natural terminal native discrete reward independently derived', 'zero intermediate reward and identical undiscounted eligible returns',
      'masked policy probabilities and terminal REINFORCE SGD independently reconstructed', 'truncation excludes reward and all updates',
      'parent/config/candidate/source/checkpoint/episode/step hash binding'],
    source_hashes: completion.source_hashes, source_currently_verified: checkCurrentSource, config_sha256: completion.config_sha256,
    evidence_hashes: inputHashes, verifier_sha256: sha(await readFile(fileURLToPath(import.meta.url))), strength_verified: false, runtime_admitted: false,
    limitations: 'Receipt/source/transition/numeric audit; full teacher searches are not all independently rerun. No strength, browser/device or promotion claim.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
    check(option('--training-root') && option('--output'), 'Use --training-root --output [--config --source-root]');
    const report = await auditTerminalPolicyEvidence(option('--training-root'), { configPath: option('--config'), sourceRoot: option('--source-root', root),
      checkCurrentSource: !args.includes('--historical-source') });
    await atomic(resolve(option('--output')), sealed(report));
    console.log(JSON.stringify({ status: report.status, models: report.models, total_episodes: report.total_episodes, total_actions: report.total_actions }));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
