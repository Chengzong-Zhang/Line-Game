import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameEngine } from '../web前端/GameEngine.js';
import { serializeEngineState } from '../web前端/AIStateProtocol.js';
import { engineFromTrainingState } from './defensive-training-data-v1.mjs';
import { terminalOnlyRewardAudit, freshEvaluationOpening } from './evaluate-pass-discipline-v1.mjs';
import { auditTerminalPolicyEvidence } from './verify-terminal-policy-evidence-v4.mjs';
import { passCompositeInput, verifyCompositeOverlay, assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
import { auditOperationalPhaseV3 } from './pass-operational-phase-v3.mjs';
import { root, atomic, sealed, unseal, sha } from './neural-posttraining-data-v2.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const aliases = ['easy', 'three-v4', 'three-v1', 'hex-v1'];
const read = async path => unseal(JSON.parse(await readFile(path)));
const sourcesKey = sources => JSON.stringify(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
async function evaluationRun(directory, expected) {
  const reportBytes = await readFile(resolve(directory, 'report.json')), report = unseal(JSON.parse(reportBytes));
  const progress = JSON.parse(await readFile(resolve(directory, 'progress.json'))), checkpoint = await read(resolve(directory, 'checkpoint.json'));
  check(report.schema === 'lifeline-pass-discipline-evaluation-report-v1' && report.identity === checkpoint.identity
    && progress.identity === report.identity && progress.status === 'COMPLETE' && checkpoint.active === null
    && report.mode === expected.mode && report.parent === expected.alias && report.protocolSha256 === expected.protocolHash
    && report.candidateSha256 === expected.candidateHash && report.completeCases === checkpoint.completed.length
    && same(report.trainingComposite ?? null, expected.trainingComposite ?? null),
  'Completed evaluation report identity/mode/protocol/candidate mismatch');
  const records = [], ids = new Set();
  for (const reference of checkpoint.completed) {
    check(!ids.has(reference.id) && reference.path === `units/${reference.id}.json`, 'Repeated/outside evaluation unit'); ids.add(reference.id);
    const raw = await readFile(resolve(directory, reference.path)); check(sha(raw) === reference.sha256, 'Completed evaluation unit hash mismatch');
    const value = unseal(JSON.parse(raw)); check(value.identity === report.identity && value.id === reference.id, 'Evaluation unit source identity mismatch');
    records.push(value);
  }
  const plies = records.reduce((sum, row) => sum + (row.actions?.length ?? 0), 0);
  check(checkpoint.committedPlies === plies && checkpoint.units === plies + records.length && report.completedUnits === checkpoint.units,
    'Evaluation counters differ from durable unit/action receipts');
  return { report, records, reportHash: sha(reportBytes) };
}

export async function verifyPassCampaignCompletionV3({ campaignRoot, protocolHash, reportHashes, candidateHashes, sources, trainingComposite }) {
  const completion = await read(resolve(campaignRoot, 'completion-receipt.json')),
    cp = await read(resolve(campaignRoot, 'checkpoint.json')),
    supervisor = await read(resolve(campaignRoot, 'supervisor-state.json'));
  const progress = JSON.parse(await readFile(resolve(campaignRoot, 'progress.json')));
  const jobPath = resolve(campaignRoot, 'job.json'), jobBytes = await readFile(jobPath), job = JSON.parse(jobBytes);
  const option = name => job.command?.includes(name) ? job.command[job.command.indexOf(name) + 1] : null;
  check(option('--phase-protocol'), 'Continuation requires the separately declared operational protocol');
  const priorBudget = await auditOperationalPhaseV3(option('--phase-protocol'), { requireComplete: true });
  const expectedIds = aliases.flatMap(alias => [`${alias}/scenarios`, `${alias}/games`]).concat('shared');
  check(completion.schema === 'lifeline-pass-discipline-campaign-completion-v3'
    && completion.status === 'COMPLETE_PENDING_INDEPENDENT_COMBINED_GATE' && completion.identity === cp.identity
    && progress.identity === cp.identity && progress.status === 'COMPLETE'
    && completion.protocolSha256 === protocolHash && same(completion.trainingComposite ?? null, trainingComposite ?? null)
    && same(completion.stages, cp.completed) && same(cp.completed.map(row => row.id), expectedIds)
    && cp.completed.every(row => row.reportSha256 === reportHashes[row.id])
    && same(Object.values(completion.candidates).sort(), Object.values(candidateHashes).sort()),
  'Nine-stage campaign completion/protocol/model/report binding differs');
  const runner = resolve(root, 'web/tools/run-pass-discipline-campaign-v3.mjs');
  check(Object.entries(sources).every(([path, hash]) => completion.sources[path] === hash)
    && Object.entries(priorBudget.evidenceHashes).every(([path, hash]) => completion.sources[path] === hash)
    && Object.keys(completion.sources).every(path => path in sources || path === runner || path in priorBudget.evidenceHashes)
    && completion.sources[runner] === sha(await readFile(runner)), 'Campaign source freeze differs from stage evidence');
  const budget = completion.budget;
  check(budget?.maximumWallSeconds === priorBudget.maximumWallSeconds && budget.startedEpochMs === cp.startedEpochMs
    && budget.deadlineEpochMs === cp.deadlineEpochMs && budget.completedEpochMs === cp.completedEpochMs
    && Number.isSafeInteger(budget.startedEpochMs) && budget.deadlineEpochMs === priorBudget.phaseDeadlineEpochMs
    && budget.phaseCreatedEpochMs === priorBudget.phaseCreatedEpochMs
    && budget.phaseIdentity === priorBudget.identity && budget.phaseSha256 === priorBudget.sha256
    && budget.oldBudgetStatus === 'BUDGET_EXHAUSTED_NOT_PASSED'
    && budget.oldAbsoluteDeadlineEpochMs === priorBudget.oldAbsoluteDeadlineEpochMs
    && budget.carriedNaturalGames === priorBudget.copiedCompletedNaturalGames
    && budget.carriedHexActions === priorBudget.copiedActiveHexActions
    && budget.completedEpochMs >= budget.startedEpochMs && budget.completedEpochMs <= budget.deadlineEpochMs,
  'Operational completion exceeded or replaced its new immutable 1200-second phase; old cap was not passed');
  check(job.schema === 'lifeline-supervised-job-v1' && job.max_wall_seconds > 0
    && job.max_wall_seconds <= priorBudget.maximumWallSeconds && job.worker_wall_seconds === 120
    && job.absolute_deadline_epoch_ms === priorBudget.phaseDeadlineEpochMs
    && resolve(job.run_root) === resolve(campaignRoot) && resolve(job.command?.[1] ?? '') === runner
    && resolve(option('--campaign-root') ?? '') === resolve(campaignRoot)
    && sha(await readFile(resolve(option('--protocol') ?? ''))) === protocolHash,
  'Continuation must use its separately supervised bounded operational job');
  const identityFiles = {};
  for (const path of [resolve(root, 'web/tools/supervise-pass-operational-job-v3.mjs'), ...job.identity_files.map(path => resolve(job.cwd, path))])
    identityFiles[path] = sha(await readFile(path));
  check(supervisor.identity === sha(JSON.stringify({ raw_job_sha256: sha(jobBytes), identity_files: identityFiles }))
    && supervisor.status === 'COMPLETE' && supervisor.worker_identity === completion.identity
    && supervisor.deadline_epoch_ms <= priorBudget.phaseDeadlineEpochMs,
  'Independent supervisor completion/source identity differs');
  const events = (await readFile(resolve(campaignRoot, 'supervisor-events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const firstStart = events.find(row => row.type === 'WORKER_START')?.time_epoch_ms;
  check(Number.isSafeInteger(firstStart) && firstStart <= budget.startedEpochMs
    && firstStart >= priorBudget.phaseCreatedEpochMs
    && budget.completedEpochMs - firstStart <= job.max_wall_seconds * 1000
    && budget.completedEpochMs - priorBudget.phaseCreatedEpochMs <= 1200000,
  'New operational phase exceeded its immutable 1200-second bound');
  return { ...budget, firstSupervisedWorkerEpochMs: firstStart,
    totalSupervisedWallMs: budget.completedEpochMs - firstStart,
    phaseWallIncludingPreparationMs: budget.completedEpochMs - priorBudget.phaseCreatedEpochMs,
    totalWallSinceOriginalFirstWorkerMs: budget.completedEpochMs - priorBudget.oldFirstFormalWorkerEpochMs,
    old1500SecondBudgetPassed: false, oldBudgetStatus: 'BUDGET_EXHAUSTED_NOT_PASSED',
    newOperationalPhaseBudgetPassed: true, copiedCompletedNaturalGames: priorBudget.copiedCompletedNaturalGames,
    copiedActiveHexActionsVerified: priorBudget.copiedActiveHexActions,
    operationalProtocolSha256: priorBudget.sha256,
    supervisor_identity: supervisor.identity, completion_sha256: sha(await readFile(resolve(campaignRoot, 'completion-receipt.json'))) };
}

export async function finalizePassDisciplineV3({ campaignRoot, protocolPath, trainingRoot = null, trainingConfig = null,
  compositeManifest = null, sourceRoot = root }) {
  const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes), protocolHash = sha(protocolBytes);
  check(compositeManifest && !trainingRoot, 'Revision 2 requires the explicit v5 composite');
  check(protocol.schema === 'lifeline-pass-discipline-acceptance-v2' && protocol.protocol_revision === 2
    && protocol.raw_product_contracts?.['three-v4'] === 'unguarded-v4-search-trained-placement'
    && protocol.admission?.required_fresh_games === 34
    && protocol.admission.required_natural_games === 34 && protocol.admission.required_layout_blocks === 8
    && protocol.total_campaign_wall_seconds === 1500
    && protocol.oracle.fullOpponentRound === true && protocol.reward.gamma === 1 && protocol.reward.nonterminal_reward === 0,
  'Frozen scoped admission requirements changed');
  check(Boolean(trainingRoot) !== Boolean(compositeManifest), 'Choose exactly one single training run or explicit v5 composite');
  if (compositeManifest) assertPassCompositeProtocol(protocolBytes);
  const composite = compositeManifest ? await passCompositeInput(compositeManifest) : null;
  const training = composite ? composite.proof
    : await auditTerminalPolicyEvidence(trainingRoot, { configPath: trainingConfig, sourceRoot, checkCurrentSource: true });
  check(same(Object.keys(training.models).sort(), [...aliases].sort())
    && training.status === (composite ? 'PASS_EXPLICIT_COMPOSITE_TRAINING_EVIDENCE' : 'PASS'), 'All four actually trained parents must pass independent audit');
  const trainingComposite = composite ? { identity: composite.identity, manifestSha256: composite.manifestSha256,
    perModelIdentities: Object.fromEntries(aliases.map(alias => [alias, training.models[alias].training_identity])) } : null;
  const candidateHashes = Object.fromEntries(aliases.map(alias => [alias, training.models[alias].candidate_sha256]));
  const overlayPath = resolve(sourceRoot, 'web/web前端/PassTrainedPolicyData.js'), overlayBytes = await readFile(overlayPath);
  const overlay = (await import(`${pathToFileURL(overlayPath).href}?independent-admission=${sha(overlayBytes)}`)).PASS_TRAINED_POLICY_DATA;
  check(overlay?.schema === 'lifeline-terminal-trained-policies-v4'
    && ['EVALUATION_ONLY', 'PASS_DISCIPLINE_SCOPED'].includes(overlay.activation)
    && same(Object.keys(overlay.models ?? {}).sort(), [...aliases].sort()), 'Evaluation overlay does not contain exactly four trained parents');
  if (composite) verifyCompositeOverlay(overlay, composite);
  for (const alias of aliases) {
    const model = overlay.models[alias];
    check(model.weights?.length === 17 && model.passBias === model.weights[16]
      && model.candidate_sha256 === candidateHashes[alias]
      && sha(JSON.stringify({ weights: model.weights.slice(0, 16), passBias: model.weights[16], temperature: 1, rules_version: 'territory-v3' }))
        === training.models[alias].runtime_parameters_sha256, 'Actual evaluation overlay parameters differ from independently reconstructed training');
  }
  const reportHashes = {}, cells = [], sourceSets = [], allGames = [];
  let scenarios = 0, certifiedBadPasses = 0, unknownPasses = 0, expansions = 0, maximumDecisionMs = 0;
  const auxiliaryRaw17Failures = [];
  for (const alias of aliases) {
    const context = protocol.contexts.find(row => row.parent === alias); check(context && context.seeds.length === 2, 'Missing paired context seeds');
    const fixed = await evaluationRun(resolve(campaignRoot, alias, 'scenarios'),
      { mode: 'scenarios', alias, protocolHash, candidateHash: candidateHashes[alias], trainingComposite });
    check(fixed.records.length === context.scenario_sizes.length * 2 + Number(context.player_count === 3)
      && fixed.report.scenarioFailures === 0 && fixed.records.every(row => row.passed === true
        && row.candidateSha256 === candidateHashes[alias] && Array.isArray(row.rawPoint) && Array.isArray(row.candidate.point)
        && row.independentCertificate?.witness && row.independentCertificate.complete === true), 'Raw/runtime PASS opportunity scenarios did not all pass');
    for (const row of fixed.records) {
      check(row.rawProductPolicy === protocol.raw_product_contracts[alias]
        && row.rawProductParametersSha256 === training.models[alias].runtime_parameters_sha256
        && same(row.rawProductReceipt?.point, row.rawPoint)
        && row.rawProductReceipt?.runtimeParametersSha256 === row.rawProductParametersSha256,
      'Raw product object/actual continued parameters differ from the frozen deployment contract');
      if (alias === 'three-v4') check(row.rawProductReceipt.learnedPassUsed === false
        && same(row.rawProductReceipt.auxiliaryRaw17Point, row.auxiliaryRaw17Point), 'Unused v4 PASS-head diagnostics were omitted or mixed into product search');
      if (alias === 'three-v4' && row.auxiliaryRaw17Point === null) auxiliaryRaw17Failures.push({ alias, scenario_id: row.id,
        auxiliary_raw17_point: null, unguarded_product_search_point: row.rawPoint, deployed_learned_pass: false });
      check((row.candidate.modelInfo?.passDisciplineTraining ?? row.candidate.searchStats?.passDisciplineTraining)?.candidate_sha256 === candidateHashes[alias],
        'Scenario runtime lost the trained model identity');
      if (row.kind === 'third-seat-cut-trap') check(row.thirdSeatTrapProof?.status === 'refuted-expansion', 'Later actual opponent cut not refuted');
    }
    const expectedIds = context.scenario_sizes.flatMap(size => [`${alias}-s${size}-opening`, `${alias}-s${size}-winning-terminal-pass-with-expansion`]);
    if (context.player_count === 3) expectedIds.push(`${alias}-third-seat-cut-trap`);
    check(same(fixed.records.map(row => row.id).sort(), expectedIds.sort()), 'Expected board-size/native-route scenarios missing');
    scenarios += fixed.records.length; sourceSets.push(fixed.report.sourceHashes); reportHashes[`${alias}/scenarios`] = fixed.reportHash;
    const games = await evaluationRun(resolve(campaignRoot, alias, 'games'), { mode: 'games', alias, protocolHash, candidateHash: candidateHashes[alias], trainingComposite });
    check(games.records.length === context.seeds.length * (context.player_count + 1) && games.report.truncatedGames === 0,
      'Required complete fresh games are missing/truncated');
    const byId = new Map(games.records.map(row => [row.id, row]));
    for (const seed of context.seeds) {
      const start = freshEvaluationOpening(context, seed), seats = start.activePlayers;
      for (const focal of [null, ...seats]) {
        const id = focal === null ? `seed-${seed}-baseline` : `seed-${seed}-seat-${focal}`, game = byId.get(id);
        check(game && game.focal === focal && game.seed === seed && same(game.openingState, start), 'Game layout/seat differs from the frozen ply0 paired start');
        const engine = engineFromTrainingState(start); check(engine.turnCount === 0, 'Game starts after opening actions');
        let bad = 0, unknown = 0, growth = 0;
        for (const action of game.actions) {
          check(!engine.gameOver && action.actor === engine.currentPlayer && action.candidateTurn === (focal === engine.currentPlayer),
            'Actual game actor/candidate seat mismatch');
          if (action.candidateTurn) {
            check((action.modelInfo?.passDisciplineTraining ?? action.searchStats?.passDisciplineTraining)?.candidate_sha256 === candidateHashes[alias], 'Game runtime was not actually bound to this trained candidate');
            if (action.point === null && engine.getLegalMoves().length) check(action.independentPassCertificate,
              'Voluntary candidate PASS skipped independent opportunity analysis');
            if (action.independentPassCertificate?.witness) bad++;
            if (action.point === null && action.independentPassCertificate && !action.independentPassCertificate.complete) unknown++;
            if (action.point !== null && action.afterArea > action.beforeArea) growth++;
          }
          check((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success, 'Game transition violates native canonical rules');
          check(Number.isFinite(action.elapsedMs) && action.elapsedMs >= 0, 'Missing actual decision latency');
          maximumDecisionMs = Math.max(maximumDecisionMs, action.elapsedMs);
        }
        check(engine.gameOver && game.outcome.terminal && game.finalStateHash === sha(JSON.stringify(serializeEngineState(engine))), 'Game lacks a natural canonical terminal');
        const reward = terminalOnlyRewardAudit(engine, game.actions);
        const scores = Object.fromEntries(engine.activePlayers.map(player => [player, GameEngine.prototype._computeOwnedWallArea.call(engine,
          [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)], engine._getOpponents(player)
            .flatMap(enemy => [...engine._getPlayerNodes(enemy), ...engine._getPlayerLines(enemy)]))]));
        const maximum = Math.max(...Object.values(scores)), winners = engine.activePlayers.filter(player => scores[player] === maximum);
        const shares = Object.fromEntries(engine.activePlayers.map(player => [player, winners.includes(player) ? 1 / winners.length : 0]));
        check(same(game.outcome, { terminal: true, scores, shares }), 'Recorded evaluation scores/winners differ from final native area');
        check(same(reward, game.rewardAudit) && reward.gamma === 1 && reward.trainingEligible
          && reward.allIntermediateRewardsZero && game.scoreChangesAreDiagnosticsNotRewards === true, 'Evaluation terminal reward/return audit mismatch');
        certifiedBadPasses += bad; unknownPasses += unknown; expansions += growth;
        allGames.push(game);
      }
    }
    sourceSets.push(games.report.sourceHashes); reportHashes[`${alias}/games`] = games.reportHash;
    cells.push({ parent: alias, player_count: context.player_count, grid_size: context.grid_size, board_shape: context.player_count <= 3 ? 'triangle' : 'hexagon',
      layout_blocks: context.seeds.length, fresh_natural_games: games.records.length,
      paired_games: games.report.pairedNaturalGames, paired_mean_win_share_delta_diagnostic: games.report.pairedMeanWinShareDelta,
      candidate_certified_bad_passes: games.report.candidateCertifiedBadPasses });
  }
  const shared = await evaluationRun(resolve(campaignRoot, 'shared'), { mode: 'shared-scenarios', alias: 'easy', protocolHash, candidateHash: null, trainingComposite });
  const expectedShared = protocol.shared_worker_profiles.reduce((sum, item) => sum + item.sizes.length * (item.player_count <= 6 ? 2 : 1), 0) + 1;
  check(shared.records.length === expectedShared && shared.report.scenarioFailures === 0 && shared.records.every(row => row.passed === true), 'Shared strategies/player-count/forced-PASS snapshots did not all pass');
  const sharedIds = protocol.shared_worker_profiles.flatMap((item, index) => item.sizes.flatMap(size => [`shared-${index}-s${size}-opening`,
    ...(item.player_count <= 6 ? [`shared-${index}-s${size}-terminal-expansion`] : [])]));
  sharedIds.push('shared-forced-pass-15-full-triangle');
  check(same(shared.records.map(row => row.id).sort(), sharedIds.sort()), 'Missing shared strategy/player-count boundary cases');
  sourceSets.push(shared.report.sourceHashes); reportHashes.shared = shared.reportHash; scenarios += shared.records.length;
  check(sourceSets.every(sources => sourcesKey(sources) === sourcesKey(sourceSets[0])), 'Different runtime/model sources entered the acceptance campaign');
  for (const [path, hash] of Object.entries(sourceSets[0])) check(sha(await readFile(path)) === hash, `Runtime/source changed after evaluation freeze: ${path}`);
  check(allGames.length === 34 && cells.reduce((sum, cell) => sum + cell.layout_blocks, 0) === 8
    && certifiedBadPasses === 0 && expansions > 0, 'Fresh-game/safe-PASS task admission did not pass');
  check([5, 7, 9].every(size => auxiliaryRaw17Failures.some(row => row.scenario_id === `three-v4-s${size}-opening`)),
    'The frozen revision-2 correction requires permanent disclosure of all three unused raw17 opening PASS failures');
  const campaignBudget = await verifyPassCampaignCompletionV3({ campaignRoot, protocolHash, reportHashes,
    candidateHashes, sources: sourceSets[0], trainingComposite });
  const trainingHash = sha(JSON.stringify(sealed(training)) + '\n');
  return { schema: 'lifeline-pass-discipline-combined-admission-v1', status: 'PASS_DISCIPLINE_SCOPED', task_admission: 'PASS_DISCIPLINE_SCOPED',
    verifier_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    candidate_hashes: candidateHashes, protocol_sha256: protocolHash, training_audit_sha256: trainingHash, evaluation_report_hashes: reportHashes,
    training_evidence_kind: composite ? 'explicit-v5-composite' : 'single-v4-training-run',
    training_composite: trainingComposite, campaign_budget: campaignBudget,
    evaluation_operational_revision: 3, old_1500_second_budget_passed: false,
    old_budget_status: 'BUDGET_EXHAUSTED_NOT_PASSED', new_operational_phase_budget_passed: true,
    operational_scope: 'Explicit new <=1200-second operational continuation from exact durable progress. Original 1500-second budget failed; candidate/runtime/34-natural-game/8-layout/zero-certified-bad-PASS and scenario gates are unchanged.',
    original_training_failure_preserved: composite?.proof.original_failure_preserved ?? false,
    native_hex_prior_gradient_samples: composite?.proof.native_hex_prior_gradient_samples ?? null,
    protocol_revision: 2, previous_protocol: protocol.previous_protocol, raw_product_contracts: protocol.raw_product_contracts,
    object_correction: protocol.object_correction, auxiliary_raw17_failures: auxiliaryRaw17Failures,
    fresh_natural_games: allGames.length, independent_layout_blocks: 8, game_cells: cells, scenario_cases: scenarios,
    candidate_certified_bad_passes: certifiedBadPasses, candidate_incomplete_pass_opportunity_checks: unknownPasses,
    candidate_expansion_actions: expansions, maximum_decision_ms: maximumDecisionMs, reward_gamma: 1, intermediate_area_rewards: false,
    training_models: training.models, source_hashes: sourceSets[0], source_hashes_verified_before_promotion: true,
    strength_verified: false, runtime_scoped_admitted: true, global_runtime_admission: false,
    scope: 'Four terminal-trained native linear parents in the stated four complete-game cells; shared PASS scenarios across explicit strategies/2–15 players. Size 9 is snapshot-only. Existing neural weights unchanged.',
    limitations: '34 dependent paired-seat games in eight layouts; no population win rate/global strength/universal safety, browser/WeChat/device/public-release claim. Three-v4 unused raw17 head still selects opening PASS; its deployed raw object is the unchanged search with newly trained placement coefficients and learned_pass=false. The old raw17 gate was not passed. Hex continuation is triangle-trained transfer: the original 18 native hex games supplied zero eligible gradient samples. Original v4 failure and distinct model source identities are preserved. Incomplete oracle windows remain unproved. Metadata-only activation requires final-source hash/decision probes.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
    check(option('--campaign-root') && option('--protocol') && option('--output')
      && Boolean(option('--training-root')) !== Boolean(option('--composite-manifest')),
    'Use --campaign-root --protocol --output and exactly one of --training-root / --composite-manifest');
    const report = await finalizePassDisciplineV3({ campaignRoot: resolve(option('--campaign-root')), protocolPath: resolve(option('--protocol')),
      trainingRoot: option('--training-root') ? resolve(option('--training-root')) : null, compositeManifest: option('--composite-manifest'),
      trainingConfig: option('--training-config'), sourceRoot: option('--source-root', root) });
    await atomic(resolve(option('--output')), sealed(report));
    console.log(JSON.stringify({ status: report.status, games: report.fresh_natural_games, scenarios: report.scenario_cases, candidate_hashes: report.candidate_hashes }));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
