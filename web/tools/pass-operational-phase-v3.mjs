// A separately declared operational continuation; never passes the failed old cap.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, sealed, unseal, sha, root } from './neural-posttraining-data-v2.mjs';
import { assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
import { auditPassBudgetV2 } from './pass-discipline-campaign-budget-v2.mjs';
const check = (ok, message) => { if (!ok) throw Error(message); };
const read = async path => unseal(JSON.parse(await readFile(path)));
const stages = ['easy/scenarios', 'easy/games', 'three-v4/scenarios', 'three-v4/games',
  'three-v1/scenarios', 'three-v1/games', 'hex-v1/scenarios'];
const names = ['easy', 'three-v4', 'three-v1', 'hex-v1', 'shared'];
export async function prepareOperationalPhaseV3({ sourceCampaign, phaseRoot, auditPriorBudget = auditPassBudgetV2 }) {
  sourceCampaign = resolve(sourceCampaign); phaseRoot = resolve(phaseRoot);
  let existing = []; try { existing = await readdir(phaseRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  check(existing.length === 0, 'Operational phase requires a new empty root');
  const cp = await read(resolve(sourceCampaign, 'checkpoint.json')),
    supervisor = await read(resolve(sourceCampaign, 'supervisor-state.json')),
    exit = JSON.parse(await readFile(resolve(sourceCampaign, 'worker-1.exit.json')));
  check(supervisor.status === 'FATAL' && supervisor.worker_identity === cp.identity
    && exit.cancelled === 'WORKER_TIMEOUT' && exit.signal === 'SIGKILL' && exit.exit_code === null,
  'Only the preserved timeout/SIGKILL operational failure can carry forward');
  check(JSON.stringify(cp.completed.map(row => row.id)) === JSON.stringify(stages), 'Expected seven completed source stages differ');
  const protocolBytes = await readFile(resolve(sourceCampaign, 'protocol.json')); assertPassCompositeProtocol(protocolBytes);
  const oldBudget = await auditPriorBudget(resolve(sourceCampaign, 'campaign-budget-v2.json'));
  check(Date.now() >= oldBudget.originalDeadlineEpochMs, 'The old absolute budget must first be explicitly exhausted');
  const frozenSources = {}, sourceEvidence = {}, carriedFiles = {};
  for (const name of ['checkpoint.json', 'progress.json', 'supervisor-state.json', 'supervisor-events.jsonl', 'worker-1.exit.json',
    'job.json', 'campaign-budget-v2.json', 'protocol.json']) {
    const source = resolve(sourceCampaign, name), bytes = await readFile(source), target = resolve(phaseRoot, 'carry-evidence', name);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    sourceEvidence[source] = sha(bytes);
  }
  for (const record of cp.completed) {
    const path = resolve(sourceCampaign, record.id, 'report.json'), bytes = await readFile(path), report = unseal(JSON.parse(bytes));
    check(sha(bytes) === record.reportSha256 && report.scenarioFailures === 0 && report.candidateCertifiedBadPasses === 0
      && report.truncatedGames === 0, 'Completed source stage did not qualify');
    for (const [source, hash] of Object.entries(report.sourceHashes)) {
      check(!frozenSources[source] || frozenSources[source] === hash, 'Different sources entered completed stages');
      frozenSources[source] = hash;
    }
  }
  for (const [path, hash] of Object.entries(frozenSources)) check(sha(await readFile(path)) === hash, `Source changed before operational carry: ${path}`);
  const copy = async directory => {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const item of entries) {
      check(!item.isSymbolicLink(), 'Symlink rejected from operational carry');
      const source = resolve(directory, item.name);
      if (item.isDirectory()) await copy(source);
      else {
        const name = relative(sourceCampaign, source), bytes = await readFile(source);
        check(name && !name.startsWith('..') && !isAbsolute(name), 'Carry source outside campaign');
        carriedFiles[name] = sha(bytes);
        for (const target of [resolve(phaseRoot, name), resolve(phaseRoot, 'carry-snapshot', name)]) {
          await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
        }
      }
    }
  };
  for (const name of names) await copy(resolve(sourceCampaign, name));
  const hexCp = await read(resolve(phaseRoot, 'hex-v1/games/checkpoint.json'));
  check(hexCp.completed.length === 1 && hexCp.active?.id === 'seed-74051-seat-BLACK'
    && hexCp.active.actions.length >= 31, 'Expected durable active hex prefix is missing');
  const createdEpochMs = Date.now();
  const body = { schema: 'lifeline-pass-operational-continuation-v3', status: 'PREPARED_NOT_STARTED',
    sourceCampaign, phaseRoot, sourceCampaignIdentity: cp.identity, carryCompletedStages: cp.completed,
    oldBudgetStatus: 'BUDGET_EXHAUSTED_NOT_PASSED', oldAbsoluteDeadlineEpochMs: oldBudget.originalDeadlineEpochMs,
    oldFirstFormalWorkerEpochMs: oldBudget.firstFormalWorkerEpochMs,
    phaseCreatedEpochMs: createdEpochMs, phaseDeadlineEpochMs: createdEpochMs + 1200000, maximumWallSeconds: 1200,
    requiredNaturalGames: 34, requiredLayoutBlocks: 8, originalFailedEightGamesCounted: false,
    copiedCompletedNaturalGames: 25, copiedNaturalGamesFromCompletedStages: 24,
    copiedNaturalGamesInActiveStage: hexCp.completed.length, copiedActiveHexActions: hexCp.active.actions.length,
    acceptanceProtocolSha256: sha(protocolBytes), frozenSources, sourceEvidence, carriedFiles,
    priorFailedBudgetEvidenceHashes: oldBudget.evidenceHashes,
    scope: 'Same 34-game acceptance/runtime/candidate experiment, continued from byte-verified durable progress in a new operational phase. Old 1500-second cap explicitly failed; no policy gate relaxed.' };
  const descriptor = { ...body, identity: sha(JSON.stringify(body)) };
  await atomic(resolve(phaseRoot, 'operational-phase-v3.json'), sealed(descriptor));
  await writeFile(resolve(phaseRoot, 'protocol.json'), protocolBytes, { flag: 'wx' });
  return descriptor;
}
export async function auditOperationalPhaseV3(path, { requireComplete = false, auditPriorBudget = auditPassBudgetV2 } = {}) {
  path = resolve(path); const bytes = await readFile(path), phase = unseal(JSON.parse(bytes)), { identity, ...body } = phase;
  check(phase.schema === 'lifeline-pass-operational-continuation-v3' && identity === sha(JSON.stringify(body))
    && phase.oldBudgetStatus === 'BUDGET_EXHAUSTED_NOT_PASSED' && phase.maximumWallSeconds === 1200
    && phase.phaseDeadlineEpochMs - phase.phaseCreatedEpochMs === 1200000
    && phase.phaseCreatedEpochMs >= phase.oldAbsoluteDeadlineEpochMs
    && phase.requiredNaturalGames === 34 && phase.requiredLayoutBlocks === 8 && !phase.originalFailedEightGamesCounted,
  'Explicit operational phase identity/budget/acceptance differs');
  const evidenceHashes = { [path]: sha(bytes), [fileURLToPath(import.meta.url)]: sha(await readFile(fileURLToPath(import.meta.url))) };
  const priorBudget = await auditPriorBudget(resolve(phase.sourceCampaign, 'campaign-budget-v2.json'));
  check(JSON.stringify(priorBudget.evidenceHashes) === JSON.stringify(phase.priorFailedBudgetEvidenceHashes),
    'Prior failed budget/source-snapshot transitive evidence changed');
  Object.assign(evidenceHashes, priorBudget.evidenceHashes);
  for (const [source, hash] of Object.entries(phase.sourceEvidence)) {
    check(sha(await readFile(source)) === hash, 'Original operational failure evidence changed');
    const snapshot = resolve(phase.phaseRoot, 'carry-evidence', relative(phase.sourceCampaign, source));
    check(sha(await readFile(snapshot)) === hash, 'Operational source evidence snapshot changed'); evidenceHashes[snapshot] = hash;
  }
  for (const [source, hash] of Object.entries(phase.frozenSources)) check(sha(await readFile(source)) === hash, `Frozen runtime/model/evaluator source changed: ${source}`);
  for (const [name, hash] of Object.entries(phase.carriedFiles)) {
    check(sha(await readFile(resolve(phase.sourceCampaign, name))) === hash, 'Original durable evaluation file changed');
    const snapshot = resolve(phase.phaseRoot, 'carry-snapshot', name);
    check(sha(await readFile(snapshot)) === hash, 'Frozen carried evaluation byte changed'); evidenceHashes[snapshot] = hash;
    if (stages.some(stage => name.replaceAll('\\', '/').startsWith(stage + '/')) || name.replaceAll('\\', '/').includes('/units/'))
      check(sha(await readFile(resolve(phase.phaseRoot, name))) === hash, 'Completed carried unit/stage was modified or replayed');
  }
  const initialHex = await read(resolve(phase.phaseRoot, 'carry-snapshot/hex-v1/games/checkpoint.json'));
  const currentHex = await read(resolve(phase.phaseRoot, 'hex-v1/games/checkpoint.json'));
  const initialActive = initialHex.active;
  let actualActions = currentHex.active?.id === initialActive.id ? currentHex.active.actions : null;
  if (!actualActions) {
    const record = currentHex.completed.find(row => row.id === initialActive.id);
    if (record) actualActions = (await read(resolve(phase.phaseRoot, 'hex-v1/games', record.path))).actions;
  }
  check(actualActions && JSON.stringify(actualActions.slice(0, initialActive.actions.length)) === JSON.stringify(initialActive.actions)
    && currentHex.committedPlies >= initialHex.committedPlies, 'Durable in-flight hex action prefix was lost or replayed');
  if (requireComplete) check(currentHex.active === null && currentHex.completed.length === 10, 'Hex continuation is incomplete');
  return { ...phase, identity, path, sha256: sha(bytes), evidenceHashes };
}
