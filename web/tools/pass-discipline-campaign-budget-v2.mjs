// Append-only budget accounting across the failed v2 runtime and its replacement.
import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, sealed, unseal, sha } from './neural-posttraining-data-v2.mjs';
import { assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';
const check = (ok, message) => { if (!ok) throw Error(message); };
const read = async path => unseal(JSON.parse(await readFile(path)));
async function priorAttempt(priorRoot, snapshotPath) {
  priorRoot = resolve(priorRoot); snapshotPath = resolve(snapshotPath);
  const paths = ['job.json', 'checkpoint.json', 'progress.json', 'supervisor-state.json', 'supervisor-events.jsonl',
    'protocol.json', 'easy/games/report.json'].map(name => resolve(priorRoot, name));
  const hashes = {};
  for (const path of [...paths, snapshotPath]) hashes[path] = sha(await readFile(path));
  const cp = await read(paths[1]), progress = JSON.parse(await readFile(paths[2])), supervisor = await read(paths[3]);
  assertPassCompositeProtocol(await readFile(paths[5]));
  check(progress.status === 'FATAL' && supervisor.status === 'FATAL' && progress.identity === cp.identity
    && supervisor.worker_identity === cp.identity, 'Prior failed formal attempt identity/status differs');
  const events = (await readFile(paths[4], 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const start = events.find(row => row.type === 'WORKER_START')?.time_epoch_ms;
  const fatal = events.findLast(row => row.type === 'FATAL')?.time_epoch_ms;
  check(Number.isSafeInteger(start) && Number.isSafeInteger(fatal) && fatal >= start && fatal - start < 1500000,
    'Prior actual formal wall time is unavailable');
  const report = await read(paths[6]), snapshot = JSON.parse(await readFile(snapshotPath));
  check(report.naturalGames === 8 && report.truncatedGames === 0 && report.candidateCertifiedBadPasses === 5
    && snapshot.schema === 'lifeline-failed-evaluation-source-snapshot-v1'
    && snapshot.status === 'EXACT_FAILED_SOURCE_PRESERVED' && Object.keys(snapshot.files ?? {}).length > 0,
  'Original failed eight-game evidence/source snapshot differs');
  const originalFrontend = resolve(snapshot.original_source_root, 'web/web前端');
  const relevant = Object.entries(report.sourceHashes).filter(([path]) => {
    const inside = relative(originalFrontend, path); return inside && !inside.startsWith('..') && !isAbsolute(inside);
  });
  check(relevant.length === Object.keys(snapshot.files).length, 'Failed source snapshot is incomplete');
  for (const [name, hash] of Object.entries(snapshot.files)) {
    const path = resolve(dirname(snapshotPath), name), inside = relative(dirname(snapshotPath), path);
    check(inside && !inside.startsWith('..') && !isAbsolute(inside)
      && report.sourceHashes[resolve(snapshot.original_source_root, name)] === hash
      && sha(await readFile(path)) === hash, 'Failed source snapshot byte/hash mismatch');
  }
  return { priorRunRoot: priorRoot, priorSnapshotPath: snapshotPath, priorSourceFiles: relevant.length,
    priorIdentity: cp.identity, firstFormalWorkerEpochMs: start, priorFatalEpochMs: fatal,
    priorRunWallMs: fatal - start, originalDeadlineEpochMs: start + 1500000, evidenceHashes: hashes };
}
export async function preparePassBudgetV2({ priorRoot, snapshotPath, output, now = Date.now }) {
  const prior = await priorAttempt(priorRoot, snapshotPath), preparedEpochMs = now();
  const maximumWallSeconds = Math.min(1460, Math.floor((prior.originalDeadlineEpochMs - preparedEpochMs) / 1000));
  check(maximumWallSeconds > 0, 'Original formal wall deadline already expired');
  const body = { schema: 'lifeline-pass-campaign-budget-v2', totalFormalWallSeconds: 1500,
    ...prior, preparedEpochMs, maximumWallSeconds,
    allDiagnosticAndRepairGapsIncluded: true, oldGamesCountedTowardNew34: false };
  const descriptor = { ...body, identity: sha(JSON.stringify(body)) };
  await atomic(resolve(output), sealed(descriptor)); return descriptor;
}
export async function auditPassBudgetV2(path) {
  path = resolve(path); const bytes = await readFile(path), descriptor = unseal(JSON.parse(bytes));
  const { identity, ...body } = descriptor;
  check(descriptor.schema === 'lifeline-pass-campaign-budget-v2' && identity === sha(JSON.stringify(body))
    && descriptor.totalFormalWallSeconds === 1500 && descriptor.allDiagnosticAndRepairGapsIncluded === true
    && descriptor.oldGamesCountedTowardNew34 === false && Number.isSafeInteger(descriptor.preparedEpochMs)
    && descriptor.maximumWallSeconds === Math.min(1460,
      Math.floor((descriptor.originalDeadlineEpochMs - descriptor.preparedEpochMs) / 1000))
    && descriptor.maximumWallSeconds > 0, 'Frozen carry-over budget identity/ceiling differs');
  const prior = await priorAttempt(descriptor.priorRunRoot, descriptor.priorSnapshotPath);
  for (const key of Object.keys(prior)) check(JSON.stringify(prior[key]) === JSON.stringify(descriptor[key]), `Prior budget evidence changed: ${key}`);
  return { ...descriptor, path, sha256: sha(bytes), evidenceHashes: { ...descriptor.evidenceHashes,
    [path]: sha(bytes), [fileURLToPath(import.meta.url)]: sha(await readFile(fileURLToPath(import.meta.url))) } };
}
