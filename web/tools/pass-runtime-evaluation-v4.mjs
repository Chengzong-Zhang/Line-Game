// A new runtime requires all 34 new games; previous failed games are evidence only.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, sealed, unseal, sha } from './neural-posttraining-data-v2.mjs';
import { assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
const check = (ok, message) => { if (!ok) throw Error(message); };
const read = async path => unseal(JSON.parse(await readFile(path)));
async function verifyPrevious(phase) {
  for (const [path, hash] of Object.entries(phase.previousEvidence))
    check(sha(await readFile(path)) === hash, 'Previous rejected experiment evidence changed');
  const report = await read(resolve(phase.previousCampaign, 'hex-v1/games/report.json'));
  const previousCp = await read(resolve(phase.previousCampaign, 'checkpoint.json')),
    previousSupervisor = await read(resolve(phase.previousCampaign, 'supervisor-state.json'));
  check(previousSupervisor.status === 'FATAL' && previousSupervisor.worker_identity === previousCp.identity,
    'Previous failed supervisor/campaign identity differs');
  check(report.naturalGames === 10 && report.truncatedGames === 0 && report.candidateCertifiedBadPasses === 3,
    'Previous runtime rejection differs');
  const snapshot = JSON.parse(await readFile(phase.previousRuntimeSnapshot));
  const previousPhase = await read(resolve(phase.previousCampaign, 'operational-phase-v3.json'));
  const oldFrontend = resolve(snapshot.original_source_root, 'web/web前端');
  const previousFrontend = Object.keys(previousPhase.frozenSources).filter(path => {
    const inside = relative(oldFrontend, path); return inside && !inside.startsWith('..') && !isAbsolute(inside);
  });
  check(snapshot.status === 'EXACT_FAILED_SOURCE_PRESERVED' && Object.keys(snapshot.files).length === 110,
    'Previous failed runtime source snapshot incomplete');
  check(previousFrontend.length === Object.keys(snapshot.files).length, 'Previous runtime snapshot omitted sources');
  for (const [name, hash] of Object.entries(snapshot.files)) {
    check(name.startsWith('web/web前端/') && !name.split('/').includes('..')
      && previousPhase.frozenSources[resolve(snapshot.original_source_root, name)] === hash,
    'Previous runtime snapshot source binding differs');
    check(sha(await readFile(resolve(dirname(phase.previousRuntimeSnapshot), name))) === hash, 'Previous rejected runtime byte snapshot changed');
  }
}
export async function prepareRuntimeEvaluationV4({ previousCampaign, previousRuntimeSnapshot, phaseRoot, protocolPath, frozenSources }) {
  previousCampaign = resolve(previousCampaign); previousRuntimeSnapshot = resolve(previousRuntimeSnapshot); phaseRoot = resolve(phaseRoot);
  let existing = []; try { existing = await readdir(phaseRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  check(existing.length === 0, 'New runtime requires an empty new experiment root');
  const protocolBytes = await readFile(protocolPath); assertPassCompositeProtocol(protocolBytes);
  const previousEvidence = {};
  for (const path of [previousRuntimeSnapshot, ...['operational-phase-v3.json', 'checkpoint.json', 'progress.json', 'supervisor-state.json',
    'supervisor-events.jsonl', 'job.json', 'hex-v1/games/report.json'].map(name => resolve(previousCampaign, name))])
    previousEvidence[path] = sha(await readFile(path));
  const previousPhase = await read(resolve(previousCampaign, 'operational-phase-v3.json'));
  const created = Date.now();
  const body = { schema: 'lifeline-pass-new-runtime-evaluation-v4', status: 'PREPARED_NOT_STARTED', phaseRoot,
    newRuntimeEvaluation: true, previousGamesReused: false, carryCompletedStages: [],
    copiedCompletedNaturalGames: 0, copiedActiveHexActions: 0,
    previousCampaign, previousRuntimeSnapshot, previousEvidence, frozenSources,
    previousRuntimeNaturalGames: 34, previousRuntimeCandidateCertifiedBadPasses: 3,
    oldBudgetStatus: 'BUDGET_EXHAUSTED_NOT_PASSED', oldAbsoluteDeadlineEpochMs: previousPhase.oldAbsoluteDeadlineEpochMs,
    oldFirstFormalWorkerEpochMs: previousPhase.oldFirstFormalWorkerEpochMs,
    phaseCreatedEpochMs: created, phaseDeadlineEpochMs: created + 1200000, maximumWallSeconds: 1200,
    requiredNaturalGames: 34, requiredLayoutBlocks: 8, originalFailedEightGamesCounted: false,
    acceptanceProtocolSha256: sha(protocolBytes),
    scope: 'New proof-order product runtime, unchanged trained candidates and acceptance criteria. Every one of 34 games starts fresh; no prior game or action is counted as evidence for this runtime. Prior failed experiments and old budget failure are preserved.' };
  await verifyPrevious(body);
  for (const [path, hash] of Object.entries(frozenSources)) check(sha(await readFile(path)) === hash, 'New runtime source changed before freeze');
  const descriptor = { ...body, identity: sha(JSON.stringify(body)) };
  await mkdir(phaseRoot, { recursive: true });
  await atomic(resolve(phaseRoot, 'runtime-evaluation-v4.json'), sealed(descriptor));
  await writeFile(resolve(phaseRoot, 'protocol.json'), protocolBytes, { flag: 'wx' }); return descriptor;
}
export async function auditRuntimeEvaluationV4(path) {
  path = resolve(path); const bytes = await readFile(path), phase = unseal(JSON.parse(bytes)), { identity, ...body } = phase;
  check(phase.schema === 'lifeline-pass-new-runtime-evaluation-v4' && identity === sha(JSON.stringify(body))
    && phase.newRuntimeEvaluation === true && phase.previousGamesReused === false && phase.carryCompletedStages.length === 0
    && phase.copiedCompletedNaturalGames === 0 && phase.copiedActiveHexActions === 0
    && phase.oldBudgetStatus === 'BUDGET_EXHAUSTED_NOT_PASSED' && phase.maximumWallSeconds === 1200
    && phase.phaseDeadlineEpochMs - phase.phaseCreatedEpochMs === 1200000
    && phase.requiredNaturalGames === 34 && phase.requiredLayoutBlocks === 8 && phase.originalFailedEightGamesCounted === false,
  'New runtime experiment identity/budget/no-reuse contract differs');
  await verifyPrevious(phase);
  for (const [source, hash] of Object.entries(phase.frozenSources)) check(sha(await readFile(source)) === hash, `Frozen new runtime/model/evaluator source changed: ${source}`);
  return { ...phase, path, sha256: sha(bytes), evidenceHashes: { ...phase.previousEvidence,
    [path]: sha(bytes), [fileURLToPath(import.meta.url)]: sha(await readFile(fileURLToPath(import.meta.url))) } };
}
