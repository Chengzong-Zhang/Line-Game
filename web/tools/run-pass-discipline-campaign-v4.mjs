// One resumable campaign underneath one independent supervisor wall budget.
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePassMain, sourceInventory } from './evaluate-pass-discipline-v1.mjs';
import { passCompositeInput, assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
import { auditRuntimeEvaluationV4 } from './pass-runtime-evaluation-v4.mjs';
import { atomic, root, readJson, sealed, unseal, sha, lease } from './neural-posttraining-data-v2.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
export async function runPassCampaignV4(args, { evaluate = evaluatePassMain, compositeInput = passCompositeInput,
  auditPhase = auditRuntimeEvaluationV4, now = Date.now } = {}) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option('--campaign-root') && option('--protocol') && option('--baseline-root')
    && Boolean(option('--training-root')) !== Boolean(option('--composite-manifest')),
    'Use --campaign-root --protocol --baseline-root and exactly one of --training-root / --composite-manifest');
  const campaign = resolve(option('--campaign-root')), protocolPath = resolve(option('--protocol')),
    training = option('--training-root') ? resolve(option('--training-root')) : null,
    composite = option('--composite-manifest') ? await compositeInput(option('--composite-manifest')) : null,
    baseline = resolve(option('--baseline-root')), source = resolve(option('--candidate-root', root));
  check(option('--phase-protocol') && composite, 'Revision 3 requires an explicit composite and declared operational phase');
  const budget = await auditPhase(option('--phase-protocol'));
  check(resolve(budget.phaseRoot) === campaign, 'Operational phase root differs');
  check(budget.newRuntimeEvaluation === true && budget.previousGamesReused === false
    && budget.carryCompletedStages.length === 0, 'New runtime cannot inherit previous experiment stages');
  const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes);
  check(['lifeline-pass-discipline-acceptance-v1', 'lifeline-pass-discipline-acceptance-v2'].includes(protocol.schema)
    && protocol.total_campaign_wall_seconds === 1500, 'Invalid frozen campaign budget/protocol');
  if (composite) assertPassCompositeProtocol(protocolBytes);
  const stages = [], candidates = {};
  for (const parent of ['easy', 'three-v4', 'three-v1', 'hex-v1']) {
    const path = composite ? composite.paths[parent] : resolve(training, 'models', parent, 'candidate.json');
    candidates[path] = sha(await readFile(path));
    for (const mode of ['scenarios', 'games']) stages.push({ id: `${parent}/${mode}`, parent, mode, candidate: path, runRoot: resolve(campaign, parent, mode) });
  }
  stages.push({ id: 'shared', parent: 'easy', mode: 'shared-scenarios', runRoot: resolve(campaign, 'shared') });
  const sources = { ...await sourceInventory(baseline), ...await sourceInventory(source),
    ...(composite?.evidenceHashes ?? {}),
    ...budget.evidenceHashes,
    [fileURLToPath(import.meta.url)]: sha(await readFile(fileURLToPath(import.meta.url))),
    [resolve(root, 'web/tools/evaluate-pass-discipline-v1.mjs')]: sha(await readFile(resolve(root, 'web/tools/evaluate-pass-discipline-v1.mjs'))) };
  const trainingComposite = composite ? { identity: composite.identity, manifestSha256: composite.manifestSha256,
    perModelIdentities: Object.fromEntries(Object.entries(composite.models).map(([alias, model]) => [alias, model.training_identity])) } : null;
  const identity = sha(JSON.stringify({ protocol: sha(protocolBytes), candidates, sources, baseline, source, trainingComposite,
    budgetIdentity: budget.identity, budgetSha256: budget.sha256 }));
  await mkdir(campaign, { recursive: true }); const guard = await lease(campaign);
  let cp, validated = false;
  const save = async (status, stageUnits = 0, extra = {}) => {
    if (validated) await atomic(resolve(campaign, 'checkpoint.json'), sealed(cp));
    const previous = validated ? null : await readJson(resolve(campaign, 'progress.json'), true);
    await atomic(resolve(campaign, 'progress.json'), { identity: validated ? identity : previous?.identity ?? identity, status,
      progress_units: validated ? cp.completed.reduce((sum, row) => sum + row.units, 0) + stageUnits : previous?.progress_units ?? 0,
      completed_stages: cp?.completed.length ?? 0, total_stages: stages.length,
      active_stage: stages[cp?.completed.length ?? 0]?.id ?? null, ...extra });
  };
  try {
    const previous = await readJson(resolve(campaign, 'checkpoint.json'), true);
    const firstStart = now();
    cp = previous ? unseal(previous) : { schema: 'lifeline-pass-discipline-campaign-checkpoint-v4', identity,
      completed: structuredClone(budget.carryCompletedStages), startedEpochMs: firstStart, deadlineEpochMs: budget.phaseDeadlineEpochMs };
    check(cp.identity === identity && cp.schema === 'lifeline-pass-discipline-campaign-checkpoint-v4' && cp.completed.length <= stages.length, 'Campaign frozen source/model/protocol identity mismatch');
    check(Number.isSafeInteger(cp.startedEpochMs) && cp.startedEpochMs >= budget.phaseCreatedEpochMs
      && cp.deadlineEpochMs === budget.phaseDeadlineEpochMs, 'Operational phase immutable absolute deadline changed');
    for (const [i, record] of cp.completed.entries()) check(record.id === stages[i].id
      && sha(await readFile(resolve(stages[i].runRoot, 'report.json'))) === record.reportSha256, 'Previously completed campaign stage changed');
    validated = true;
    const started = performance.now();
    while (cp.completed.length < stages.length) {
      const stage = stages[cp.completed.length];
      check(now() < cp.deadlineEpochMs, 'Original single campaign wall budget exhausted; resume cannot extend it');
      for (const [marker, status] of [['STOP', 'STOPPED'], ['PAUSE', 'PAUSED']]) {
        try { await readFile(resolve(campaign, marker)); const progress = await readJson(resolve(stage.runRoot, 'progress.json'), true);
          await save(status, progress?.progress_units ?? 0); return 75;
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (performance.now() - started >= 45000) { await save('YIELDED'); return 75; }
      const remainingSeconds = Math.max(0.1, Math.min(40, (45000 - (performance.now() - started)) / 1000));
      const result = await evaluate(['--run-root', stage.runRoot, '--protocol', protocolPath, '--baseline-root', baseline,
        '--candidate-root', source, '--mode', stage.mode, '--parent', stage.parent, '--max-new-units', '10000', '--max-seconds', String(remainingSeconds),
        ...(composite ? ['--composite-manifest', composite.manifestPath] : []),
        ...(stage.candidate ? ['--candidate', stage.candidate] : [])]);
      const progress = await readJson(resolve(stage.runRoot, 'progress.json'));
      if (result !== 0) { await save(progress.status === 'PAUSED' || progress.status === 'STOPPED' ? progress.status : 'YIELDED', progress.progress_units); return result; }
      const bytes = await readFile(resolve(stage.runRoot, 'report.json')), report = unseal(JSON.parse(bytes));
      check(report.scenarioFailures === 0 && report.candidateCertifiedBadPasses === 0 && report.truncatedGames === 0,
        `Task opportunity/complete-game acceptance failed at ${stage.id}`);
      check(now() <= cp.deadlineEpochMs, 'Original single campaign wall budget exhausted before stage commit');
      cp.completed.push({ id: stage.id, units: progress.progress_units, reportSha256: sha(bytes), cases: report.completeCases });
      await save('RUNNING');
      if (args.includes('--fault-after-stage-checkpoint')) return 79;
    }
    await atomic(resolve(campaign, 'completion-receipt.json'), sealed({ schema: 'lifeline-pass-discipline-campaign-completion-v4', identity,
      status: 'COMPLETE_PENDING_INDEPENDENT_COMBINED_GATE', stages: cp.completed, protocolSha256: sha(protocolBytes), candidates, sources, trainingComposite,
      budget: { startedEpochMs: cp.startedEpochMs, deadlineEpochMs: cp.deadlineEpochMs,
        completedEpochMs: cp.completedEpochMs ?? (cp.completedEpochMs = now()), maximumWallSeconds: budget.maximumWallSeconds,
        oldBudgetStatus: budget.oldBudgetStatus, oldAbsoluteDeadlineEpochMs: budget.oldAbsoluteDeadlineEpochMs,
        phaseCreatedEpochMs: budget.phaseCreatedEpochMs, phaseIdentity: budget.identity, phaseSha256: budget.sha256,
        carriedNaturalGames: 0, carriedHexActions: 0, newRuntimeEvaluation: true, previousGamesReused: false } }));
    await save('COMPLETE'); return 0;
  } catch (error) {
    const stageProgress = validated && stages[cp.completed.length]
      ? await readJson(resolve(stages[cp.completed.length].runRoot, 'progress.json'), true) : null;
    await save('FATAL', stageProgress?.progress_units ?? 0, { error: error.message }); throw error;
  }
  finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runPassCampaignV4(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === 'EADDRINUSE' ? 76 : 78; }
}
