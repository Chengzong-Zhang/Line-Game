// V5 adds immutable V4 rejection lineage; the frozen V4 campaign engine is reused.
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeEvaluationV4, auditRuntimeEvaluationV4 } from './pass-runtime-evaluation-v4.mjs';
import { passCompositeInput, assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
import { sourceInventory } from './evaluate-pass-discipline-v1.mjs';
import { atomic, sealed, unseal, root, sha } from './neural-posttraining-data-v2.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const aliases = ['easy', 'three-v4', 'three-v1', 'hex-v1'];
const failedIds = ['shared-16-s5-terminal-expansion', 'shared-19-s5-terminal-expansion', 'shared-22-s5-terminal-expansion'];
const ordered = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
const read = async path => unseal(JSON.parse(await readFile(path)));
const file = name => resolve(root, 'web/tools', name);
const frozenGateNames = ['pass-runtime-evaluation-v4.mjs', 'prepare-pass-runtime-evaluation-v4.mjs',
  'run-pass-discipline-campaign-v4.mjs', 'finalize-pass-discipline-admission-v4.mjs',
  'prepare-pass-runtime-evaluation-v5.mjs', 'finalize-pass-discipline-admission-v5.mjs'];

// Read the complete prior receipts, not merely their aggregate report. This runs
// before preparing and finalizing. Every returned byte hash is also frozen into
// the V4 descriptor, so its unchanged auditor rechecks them on every resume.
export async function inspectPriorRuntimeV4(previousCampaign, previousRuntimeSnapshot) {
  previousCampaign = resolve(previousCampaign); previousRuntimeSnapshot = resolve(previousRuntimeSnapshot);
  const evidenceHashes = {};
  const bytes = async path => { path = resolve(path); const value = await readFile(path); evidenceHashes[path] = sha(value); return value; };
  const json = async (path, requireSeal = true) => {
    const value = JSON.parse(await bytes(path)); return requireSeal ? unseal(value) : value;
  };
  const priorPhasePath = resolve(previousCampaign, 'runtime-evaluation-v4.json');
  const phase = await json(priorPhasePath), { identity, ...phaseBody } = phase;
  check(phase.schema === 'lifeline-pass-new-runtime-evaluation-v4' && identity === sha(JSON.stringify(phaseBody))
    && phase.newRuntimeEvaluation === true && phase.previousGamesReused === false
    && phase.carryCompletedStages.length === 0 && phase.copiedCompletedNaturalGames === 0
    && phase.requiredNaturalGames === 34 && phase.requiredLayoutBlocks === 8
    && phase.maximumWallSeconds === 1200 && phase.phaseDeadlineEpochMs - phase.phaseCreatedEpochMs === 1200000,
  'Preserved V4 runtime descriptor differs');
  const cp = await json(resolve(previousCampaign, 'checkpoint.json')),
    progress = await json(resolve(previousCampaign, 'progress.json'), false),
    supervisor = await json(resolve(previousCampaign, 'supervisor-state.json')),
    job = await json(resolve(previousCampaign, 'job.json'), false);
  const expectedStages = aliases.flatMap(alias => [`${alias}/scenarios`, `${alias}/games`]);
  check(cp.schema === 'lifeline-pass-discipline-campaign-checkpoint-v4'
    && progress.identity === cp.identity && supervisor.worker_identity === cp.identity
    && progress.status === 'FATAL' && supervisor.status === 'FATAL'
    && progress.active_stage === 'shared' && same(cp.completed.map(row => row.id), expectedStages)
    && cp.deadlineEpochMs === phase.phaseDeadlineEpochMs && supervisor.deadline_epoch_ms === phase.phaseDeadlineEpochMs
    && job.absolute_deadline_epoch_ms === phase.phaseDeadlineEpochMs && job.worker_wall_seconds === 120,
  'Prior V4 FATAL/stage/deadline evidence differs');
  check(!(await readdir(previousCampaign)).includes('completion-receipt.json'), 'Rejected V4 unexpectedly has a completion receipt');
  const oldIdentityFiles = {};
  for (const path of [file('supervise-pass-operational-job-v3.mjs'), ...job.identity_files.map(path => resolve(job.cwd, path))])
    oldIdentityFiles[path] = sha(await bytes(path));
  check(supervisor.identity === sha(JSON.stringify({ raw_job_sha256: evidenceHashes[resolve(previousCampaign, 'job.json')], identity_files: oldIdentityFiles })),
    'Preserved V4 job or frozen evaluator tool bytes changed');
  const events = (await bytes(resolve(previousCampaign, 'supervisor-events.jsonl'))).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  check(events.some(row => row.type === 'WORKER_START') && events.at(-1)?.type === 'FATAL', 'V4 supervisor terminal event differs');
  const protocolBytes = await bytes(resolve(previousCampaign, 'protocol.json')); assertPassCompositeProtocol(protocolBytes);
  check(phase.acceptanceProtocolSha256 === sha(protocolBytes), 'V4 acceptance protocol changed');
  let naturalGames = 0, candidateBadPasses = 0, totalUnits = 0;
  const reportHashes = {}, failedCases = [], sourceSets = [];
  for (const stage of [...expectedStages, 'shared']) {
    const directory = resolve(previousCampaign, stage), reportPath = resolve(directory, 'report.json');
    const report = await json(reportPath), checkpoint = await json(resolve(directory, 'checkpoint.json')),
      stageProgress = await json(resolve(directory, 'progress.json'), false);
    check(report.schema === 'lifeline-pass-discipline-evaluation-report-v1' && report.identity === checkpoint.identity
      && stageProgress.identity === report.identity && stageProgress.status === 'COMPLETE' && checkpoint.active === null
      && report.protocolSha256 === sha(protocolBytes) && report.completeCases === checkpoint.completed.length,
    'Prior V4 stage receipt identity differs');
    reportHashes[stage] = evidenceHashes[reportPath]; sourceSets.push(report.sourceHashes);
    if (stage !== 'shared') check(cp.completed.find(row => row.id === stage)?.reportSha256 === reportHashes[stage], 'V4 committed stage hash differs');
    let plies = 0; const ids = new Set();
    for (const reference of checkpoint.completed) {
      check(!ids.has(reference.id) && reference.path === `units/${reference.id}.json`, 'V4 prior unit duplicated or outside its directory'); ids.add(reference.id);
      const unitPath = resolve(directory, reference.path), raw = await bytes(unitPath), unit = unseal(JSON.parse(raw));
      check(sha(raw) === reference.sha256 && unit.id === reference.id && unit.identity === report.identity, 'V4 completed unit hash/identity differs');
      plies += unit.actions?.length ?? 0;
      if (stage === 'shared' && unit.passed !== true) {
        check(failedIds.includes(unit.id) && unit.candidate?.point === null
          && unit.independentCertificate?.complete === true
          && same(unit.independentCertificate.witness?.point, [4, 1])
          && unit.independentCertificate.witness.beforeArea === 3,
        'V4 preserved shared failure changed');
        failedCases.push({ id: unit.id, path: unitPath, sha256: sha(raw), scenarioStateHash: unit.scenarioStateHash });
      } else if (!stage.endsWith('/games')) check(unit.passed === true, 'Unexpected prior V4 scenario failure');
    }
    check(checkpoint.committedPlies === plies && checkpoint.units === plies + checkpoint.completed.length
      && report.completedUnits === checkpoint.units, 'V4 durable unit/action counters differ');
    totalUnits += checkpoint.units;
    if (stage.endsWith('/games')) {
      const required = stage.startsWith('hex-v1/') ? 10 : 8;
      check(report.naturalGames === required && report.truncatedGames === 0 && report.candidateCertifiedBadPasses === 0,
        'V4 preserved natural-game rejection facts changed');
      naturalGames += report.naturalGames; candidateBadPasses += report.candidateCertifiedBadPasses;
    } else if (stage === 'shared') check(report.completeCases === 112 && report.scenarioFailures === 3,
      'V4 preserved 112-case/three-failure shared gate changed');
    else check(report.scenarioFailures === 0, 'Prior trained-parent scenarios changed');
  }
  check(naturalGames === 34 && candidateBadPasses === 0 && same(failedCases.map(row => row.id).sort(), failedIds)
    && progress.progress_units === totalUnits && sourceSets.every(sources => same(ordered(sources), ordered(phase.frozenSources))),
  'V4 complete evidence/source inventory differs');
  const snapshot = JSON.parse(await bytes(previousRuntimeSnapshot));
  const option = name => job.command[job.command.indexOf(name) + 1];
  const oldSource = resolve(option('--candidate-root')), oldFrontend = resolve(oldSource, 'web/web前端');
  const expectedSources = Object.keys(phase.frozenSources).filter(path => {
    const inside = relative(oldFrontend, path); return inside && !inside.startsWith('..') && !isAbsolute(inside);
  });
  check(snapshot.schema === 'lifeline-failed-evaluation-source-snapshot-v1' && snapshot.status === 'EXACT_FAILED_SOURCE_PRESERVED'
    && snapshot.run === 'pass-discipline-new-runtime-v4-20261026' && resolve(snapshot.original_source_root) === oldSource
    && Object.keys(snapshot.files).length === 111 && expectedSources.length === 111
    && same(Object.keys(snapshot.files).sort(), expectedSources.map(path => relative(oldSource, path).replaceAll('\\', '/')).sort()),
  'Preserved V4 source snapshot is incomplete');
  for (const [name, hash] of Object.entries(snapshot.files)) {
    check(name.startsWith('web/web前端/') && !name.split('/').includes('..')
      && phase.frozenSources[resolve(oldSource, name)] === hash,
    'Preserved V4 source snapshot binding differs');
    check(sha(await bytes(resolve(dirname(previousRuntimeSnapshot), name))) === hash, 'Preserved V4 source snapshot byte changed');
  }
  return { schema: 'lifeline-pass-runtime-v5-prior-rejection-lineage', wrappedRuntimeRevision: 5,
    status: 'PRESERVED_V4_FATAL_NOT_ADMITTED', previousCampaign, previousRuntimeSnapshot, previousPhasePath: priorPhasePath,
    previousPhaseIdentity: phase.identity, previousWorkerIdentity: cp.identity,
    previousRuntimeNaturalGames: 34, previousRuntimeCandidateCertifiedBadPasses: 0,
    previousRuntimeSharedCases: 112, previousRuntimeSharedFailures: 3,
    previousGamesReused: false, previousSourceSnapshotFiles: 111,
    reportHashes, failedCases, evidenceHashes,
    oracleLimitation: 'Frozen area-only oracle witness [4,1] does not prove terminal winning-margin preservation. Separate canonical diagnostics found [4,4] preserves a strict win through the complete actual opponent round. The oracle and V4 rejection remain unchanged; product terminal proofs must preserve their stronger native-margin contract.' };
}

export async function auditPriorRuntimeV5Lineage(path) {
  path = resolve(path); const bytes = await readFile(path), value = unseal(JSON.parse(bytes)), { identity, ...body } = value;
  check(value.schema === 'lifeline-pass-runtime-v5-prior-rejection-lineage' && value.wrappedRuntimeRevision === 5
    && identity === sha(JSON.stringify(body)), 'V5 prior rejection sidecar identity differs');
  const current = await inspectPriorRuntimeV4(value.previousCampaign, value.previousRuntimeSnapshot);
  check(same(body, current), 'V5 prior rejection sidecar facts or complete evidence inventory differ');
  return { ...value, path, sha256: sha(bytes) };
}

export async function auditWrappedRuntimeEvaluationV5(phasePath) {
  const phase = await auditRuntimeEvaluationV4(phasePath);
  check(phase.wrappedRuntimeRevision === 5 && phase.previousRuntimeV4LineagePath
    && phase.previousRuntimeV4LineageSha256 === phase.frozenSources[phase.previousRuntimeV4LineagePath],
  'V5 wrapped runtime revision/lineage binding differs');
  const lineage = await auditPriorRuntimeV5Lineage(phase.previousRuntimeV4LineagePath);
  check(lineage.sha256 === phase.previousRuntimeV4LineageSha256
    && Object.entries(lineage.evidenceHashes).every(([path, hash]) => phase.frozenSources[path] === hash)
    && frozenGateNames.map(file).every(path => phase.frozenSources[path]),
  'V5 full prior receipts/source snapshot/wrapper freeze is incomplete');
  return { ...phase, priorRuntimeV4Lineage: lineage };
}

export async function preparePassRuntimeEvaluationV5({ previousCampaign, previousRuntimeSnapshot, phaseRoot, protocolPath }) {
  phaseRoot = resolve(phaseRoot);
  let existing = []; try { existing = await readdir(phaseRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  check(existing.length === 0, 'V5 requires a new empty experiment directory');
  const lineageBody = await inspectPriorRuntimeV4(previousCampaign, previousRuntimeSnapshot);
  const previous = await read(lineageBody.previousPhasePath), oldJob = JSON.parse(await readFile(resolve(previousCampaign, 'job.json')));
  const option = name => oldJob.command[oldJob.command.indexOf(name) + 1];
  const composite = await passCompositeInput(option('--composite-manifest'));
  const lineagePath = phaseRoot + '.prior-v4-lineage.json';
  try { await readFile(lineagePath); throw Error('V5 lineage sidecar already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lineage = { ...lineageBody, identity: sha(JSON.stringify(lineageBody)) }; await atomic(lineagePath, sealed(lineage));
  const frozenSources = { ...await sourceInventory(option('--baseline-root')), ...await sourceInventory(option('--candidate-root')),
    ...composite.evidenceHashes, ...lineage.evidenceHashes, [lineagePath]: sha(await readFile(lineagePath)) };
  for (const name of ['evaluate-pass-discipline-v1.mjs', ...frozenGateNames])
    frozenSources[file(name)] = sha(await readFile(file(name)));
  await prepareRuntimeEvaluationV4({ previousCampaign: previous.previousCampaign,
    previousRuntimeSnapshot: previous.previousRuntimeSnapshot, phaseRoot, protocolPath, frozenSources });
  const phasePath = resolve(phaseRoot, 'runtime-evaluation-v4.json'), original = await read(phasePath);
  delete original.identity;
  const body = { ...original, wrappedRuntimeRevision: 5, previousRuntimeV4LineagePath: lineagePath,
    previousRuntimeV4LineageSha256: frozenSources[lineagePath] };
  await atomic(phasePath, sealed({ ...body, identity: sha(JSON.stringify(body)) }));
  const phase = await auditWrappedRuntimeEvaluationV5(phasePath);
  const job = { ...oldJob, run_root: phaseRoot,
    command: [process.execPath, file('run-pass-discipline-campaign-v4.mjs'), '--campaign-root', phaseRoot,
      '--protocol', resolve(phaseRoot, 'protocol.json'), '--baseline-root', option('--baseline-root'),
      '--candidate-root', option('--candidate-root'), '--composite-manifest', composite.manifestPath, '--phase-protocol', phasePath],
    identity_files: [...new Set([...Object.keys(composite.evidenceHashes), ...Object.keys(phase.evidenceHashes),
      ...Object.keys(lineage.evidenceHashes), lineagePath,
      ...['evaluate-pass-discipline-v1.mjs', 'run-pass-discipline-campaign-v4.mjs', 'pass-runtime-evaluation-v4.mjs',
        'prepare-pass-runtime-evaluation-v4.mjs', 'finalize-pass-discipline-admission-v4.mjs',
        'prepare-pass-runtime-evaluation-v5.mjs', 'finalize-pass-discipline-admission-v5.mjs',
        'launch-pass-operational-phase-v3.ps1', 'recover-pass-operational-phase-at-login-v3.ps1'].map(file)])],
    absolute_deadline_epoch_ms: phase.phaseDeadlineEpochMs,
    max_wall_seconds: Math.max(1, Math.floor((phase.phaseDeadlineEpochMs - Date.now()) / 1000)), worker_wall_seconds: 120 };
  await atomic(resolve(phaseRoot, 'job.json'), job);
  return { status: 'PREPARED_NOT_STARTED', wrappedRuntimeRevision: 5, phaseRoot, identity: phase.identity,
    maxWallSeconds: job.max_wall_seconds, absoluteDeadlineEpochMs: phase.phaseDeadlineEpochMs,
    allPreviousGamesExcluded: true, newRequiredNaturalGames: 34, requiredSharedCases: 112, priorRuntimeV4FailurePreserved: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  try {
    for (const name of ['--previous-campaign', '--previous-runtime-snapshot', '--phase-root', '--protocol'])
      if (!args.includes(name)) throw Error('Missing ' + name);
    console.log(JSON.stringify(await preparePassRuntimeEvaluationV5({ previousCampaign: option('--previous-campaign'),
      previousRuntimeSnapshot: option('--previous-runtime-snapshot'), phaseRoot: option('--phase-root'), protocolPath: option('--protocol') })));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
