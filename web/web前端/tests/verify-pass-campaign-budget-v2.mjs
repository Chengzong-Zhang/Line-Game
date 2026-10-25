// Injected tiny fixtures only; no model training or product evaluation.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { preparePassBudgetV2, auditPassBudgetV2 } from '../../tools/pass-discipline-campaign-budget-v2.mjs';
import { runPassCampaignV2 } from '../../tools/run-pass-discipline-campaign-v2.mjs';
import { verifyPassCampaignCompletionV2 } from '../../tools/finalize-pass-discipline-admission-v2.mjs';
import { atomic, sealed, unseal, sha, root } from '../../tools/neural-posttraining-data-v2.mjs';
const fixture = await mkdtemp(resolve(tmpdir(), 'lifeline-pass-budget-v2-')), cases = [];
const read = async path => unseal(JSON.parse(await readFile(path)));
const prior = resolve(fixture, 'prior-failed'), snapshot = resolve(fixture, 'snapshot'), original = resolve(fixture, 'old-runtime');
const protocolBytes = await readFile(resolve(root, 'web/tools/configs/pass-discipline-acceptance-v2-20261025.json'));
const name = 'web/web前端/fixture.js';
await atomic(resolve(prior, 'job.json'), { schema: 'lifeline-supervised-job-v1' });
await atomic(resolve(prior, 'checkpoint.json'), sealed({ identity: 'old' }));
await atomic(resolve(prior, 'progress.json'), { identity: 'old', status: 'FATAL' });
await atomic(resolve(prior, 'supervisor-state.json'), sealed({ worker_identity: 'old', status: 'FATAL' }));
await writeFile(resolve(prior, 'supervisor-events.jsonl'), [
  { type: 'WORKER_START', time_epoch_ms: 1000 }, { type: 'FATAL', time_epoch_ms: 32000 }].map(JSON.stringify).join('\n') + '\n');
await writeFile(resolve(prior, 'protocol.json'), protocolBytes);
await mkdir(resolve(snapshot, 'web/web前端'), { recursive: true });
await writeFile(resolve(snapshot, name), 'synthetic old runtime');
const sourceHash = sha(await readFile(resolve(snapshot, name)));
await atomic(resolve(prior, 'easy/games/report.json'), sealed({ naturalGames: 8, truncatedGames: 0, candidateCertifiedBadPasses: 5,
  sourceHashes: { [resolve(original, name)]: sourceHash } }));
const snapshotPath = resolve(snapshot, 'snapshot.json');
await atomic(snapshotPath, { schema: 'lifeline-failed-evaluation-source-snapshot-v1', status: 'EXACT_FAILED_SOURCE_PRESERVED',
  original_source_root: original, files: { [name]: sourceHash } });
const budgetPath = resolve(fixture, 'budget.json');
const prepared = await preparePassBudgetV2({ priorRoot: prior, snapshotPath, output: budgetPath, now: () => 100000 });
assert.equal(prepared.priorRunWallMs, 31000); assert.equal(prepared.originalDeadlineEpochMs, 1501000);
assert.equal(prepared.maximumWallSeconds, 1401); // The 68-second diagnostic gap is not refunded.
const budget = await auditPassBudgetV2(budgetPath);
await assert.rejects(preparePassBudgetV2({ priorRoot: prior, snapshotPath, output: resolve(fixture, 'expired-budget.json'), now: () => 1501001 }), /already expired/);
cases.push('prior actual run, source snapshot and diagnostic gap bind the original absolute deadline');

const aliases = ['easy', 'three-v4', 'three-v1', 'hex-v1'], paths = {}, hashes = {}, models = {};
for (const alias of aliases) {
  paths[alias] = resolve(fixture, `${alias}.json`); await atomic(paths[alias], { synthetic: true, alias });
  hashes[alias] = sha(await readFile(paths[alias])); models[alias] = { training_identity: alias === 'hex-v1' ? 'new' : 'old' };
}
const manifestPath = resolve(fixture, 'manifest.json'); await atomic(manifestPath, { synthetic: true });
const input = { paths, hashes, models, identity: 'synthetic-composite', manifestSha256: sha(await readFile(manifestPath)), manifestPath, evidenceHashes: {} };
const baseline = resolve(fixture, 'baseline'), candidate = resolve(fixture, 'candidate');
for (const directory of [baseline, candidate]) {
  await mkdir(resolve(directory, 'web/web前端/assets/research-ai'), { recursive: true });
  await writeFile(resolve(directory, 'web/web前端/fixture.js'), 'export const fixture=true;\n');
}
const protocolPath = resolve(fixture, 'protocol.json'); await writeFile(protocolPath, protocolBytes);
const campaign = resolve(fixture, 'campaign'), args = ['--campaign-root', campaign, '--protocol', protocolPath,
  '--baseline-root', baseline, '--candidate-root', candidate, '--composite-manifest', manifestPath, '--budget-file', budgetPath];
let epoch = 100000, calls = 0;
const dependencies = { compositeInput: async () => input, auditBudget: auditPassBudgetV2, now: () => epoch,
  evaluate: async argv => { calls++; const directory = argv[argv.indexOf('--run-root') + 1];
    await atomic(resolve(directory, 'progress.json'), { status: 'COMPLETE', progress_units: 1 });
    await atomic(resolve(directory, 'report.json'), sealed({ scenarioFailures: 0, candidateCertifiedBadPasses: 0,
      truncatedGames: 0, completeCases: 1 })); return 0; } };
assert.equal(await runPassCampaignV2([...args, '--fault-after-stage-checkpoint'], dependencies), 79);
assert.equal(calls, 1); epoch = 200000; assert.equal(await runPassCampaignV2(args, dependencies), 0); assert.equal(calls, 9);
const cp = await read(resolve(campaign, 'checkpoint.json')), completion = await read(resolve(campaign, 'completion-receipt.json'));
assert.equal(cp.deadlineEpochMs, 1501000); assert.equal(cp.startedEpochMs, 100000);
assert.equal(completion.budget.originalFirstWorkerEpochMs, 1000);
assert.equal(completion.budget.maximumWallSeconds, 1401);
assert.equal(await runPassCampaignV2(args, dependencies), 0); assert.equal(calls, 9);
cases.push('nine fresh replacement stages resume without carrying old eight games or extending deadline');

const expiredArgs = [...args]; expiredArgs[1] = resolve(fixture, 'expired-campaign');
epoch = 100000; assert.equal(await runPassCampaignV2([...expiredArgs, '--fault-after-stage-checkpoint'], dependencies), 79);
epoch = 1501001; await assert.rejects(runPassCampaignV2(expiredArgs, dependencies), /wall budget exhausted/);
assert.equal((await read(resolve(expiredArgs[1], 'checkpoint.json'))).deadlineEpochMs, 1501000);
cases.push('worker refuses the shared absolute deadline after repair gap or resume');

const runner = resolve(root, 'web/tools/run-pass-discipline-campaign-v2.mjs'), supervisorFile = resolve(root, 'web/tools/supervise-three-player-job.mjs');
const job = { schema: 'lifeline-supervised-job-v1', max_wall_seconds: 1401, run_root: campaign, cwd: root,
  command: [process.execPath, runner, '--campaign-root', campaign, '--protocol', protocolPath, '--budget-file', budgetPath],
  identity_files: [runner, protocolPath, budgetPath] };
await atomic(resolve(campaign, 'job.json'), job);
const files = {}; for (const file of [supervisorFile, ...job.identity_files]) files[file] = sha(await readFile(file));
await atomic(resolve(campaign, 'supervisor-state.json'), sealed({ status: 'COMPLETE', worker_identity: completion.identity,
  identity: sha(JSON.stringify({ raw_job_sha256: sha(await readFile(resolve(campaign, 'job.json'))), identity_files: files })) }));
await writeFile(resolve(campaign, 'supervisor-events.jsonl'), JSON.stringify({ type: 'WORKER_START', time_epoch_ms: 99000 }) + '\n');
const sources = { ...completion.sources }; delete sources[runner];
for (const path of Object.keys(budget.evidenceHashes)) delete sources[path];
const gate = { campaignRoot: campaign, protocolHash: completion.protocolSha256,
  reportHashes: Object.fromEntries(completion.stages.map(row => [row.id, row.reportSha256])), candidateHashes: hashes,
  sources, trainingComposite: completion.trainingComposite };
const audit = await verifyPassCampaignCompletionV2(gate);
assert.equal(audit.totalWallIncludingDiagnosticAndRepairGapsMs, 199000);
assert.equal(audit.bothAttemptRunWallMs, 132000); assert.equal(audit.diagnosticAndRepairGapMs, 67000);
const lateCp = structuredClone(cp), lateCompletion = structuredClone(completion);
lateCp.completedEpochMs = 1501001; lateCompletion.budget.completedEpochMs = 1501001;
await atomic(resolve(campaign, 'checkpoint.json'), sealed(lateCp));
await atomic(resolve(campaign, 'completion-receipt.json'), sealed(lateCompletion));
await assert.rejects(verifyPassCampaignCompletionV2(gate), /original single 1500-second budget/);
await atomic(resolve(campaign, 'checkpoint.json'), sealed(cp)); await atomic(resolve(campaign, 'completion-receipt.json'), sealed(completion));
cases.push('finalizer counts both actual attempts and all diagnostic/repair wall time; late resealed completion rejected');

const originalSnapshot = await readFile(resolve(snapshot, name)); await writeFile(resolve(snapshot, name), 'changed');
await assert.rejects(auditPassBudgetV2(budgetPath), /snapshot byte\/hash mismatch/);
await writeFile(resolve(snapshot, name), originalSnapshot);
const priorProgress = await readFile(resolve(prior, 'progress.json'));
await atomic(resolve(prior, 'progress.json'), { identity: 'old', status: 'COMPLETE' });
await assert.rejects(auditPassBudgetV2(budgetPath), /failed formal attempt/);
await writeFile(resolve(prior, 'progress.json'), priorProgress);
cases.push('old failed evidence and exact prior runtime snapshot remain immutable');
console.log(JSON.stringify({ schema: 'lifeline-pass-campaign-budget-tests-v2', status: 'PASS', cases, total: cases.length,
  fixtureRoot: fixture, scope: 'Synthetic prior failure, injected evaluator/supervisor receipts; no formal games, training or admission.' }, null, 2));
