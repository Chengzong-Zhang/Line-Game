// Real supervisor timeout/resume fixtures; injected game decisions, no training.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomic, sealed, unseal, sha, root } from '../../tools/neural-posttraining-data-v2.mjs';
import { prepareOperationalPhaseV3, auditOperationalPhaseV3 } from '../../tools/pass-operational-phase-v3.mjs';
import { runPassCampaignV3 } from '../../tools/run-pass-discipline-campaign-v3.mjs';
const temp = await mkdtemp(resolve(tmpdir(), 'pass-operational-v3-')), cases = [];
const read = async path => unseal(JSON.parse(await readFile(path)));
const supervisor = resolve(root, 'web/tools/supervise-pass-operational-job-v3.mjs'), worker = resolve(temp, 'worker.mjs');
await writeFile(worker, `import fs from 'node:fs/promises';import path from 'node:path';
const directory=process.argv[2];const file=path.join(directory,'checkpoint.json');
let cp;try{cp=JSON.parse(await fs.readFile(file));}catch{cp={units:0};}
await fs.mkdir(directory,{recursive:true});
const persist=async(status,units)=>{await fs.writeFile(file,JSON.stringify({units}));await fs.writeFile(path.join(directory,'progress.json'),JSON.stringify({identity:'fixture',status,progress_units:units}));};
if(cp.units===0){await persist('RUNNING',1);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else await persist('COMPLETE',2);
`);
const execute = async args => await new Promise((done, fail) => {
  const child = spawn(process.execPath, [supervisor, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  child.once('error', fail); child.once('exit', code => done({ code, output }));
});
const makeJob = async (name, seconds) => {
  const area = resolve(temp, name); await mkdir(area);
  const job = { schema: 'lifeline-supervised-job-v1', run_root: area, cwd: root,
    command: [process.execPath, worker, area], identity_files: [worker, supervisor],
    max_wall_seconds: seconds, absolute_deadline_epoch_ms: Date.now() + seconds * 1000,
    worker_wall_seconds: 0.35, max_restarts: 3, max_no_progress_exits: 3, poll_ms: 20, stop_grace_seconds: 0.05 };
  const path = resolve(area, 'job.json'); await atomic(path, job); return { area, path, job };
};
const killed = await makeJob('killed-worker', 10), recovered = await execute(['--job', killed.path]);
assert.equal(recovered.code, 0, recovered.output);
const firstExit = JSON.parse(await readFile(resolve(killed.area, 'worker-1.exit.json'))), state = await read(resolve(killed.area, 'supervisor-state.json'));
assert.equal(firstExit.exit_code, null); assert.equal(firstExit.signal, 'SIGKILL'); assert.equal(firstExit.cancelled, 'WORKER_TIMEOUT');
assert.equal(state.status, 'COMPLETE'); assert.equal(state.attempts, 2); assert.ok(state.deadline_epoch_ms <= killed.job.absolute_deadline_epoch_ms);
cases.push('real null-exit SIGKILL worker timeout automatically recovers instead of fake zero completion');
const paused = await makeJob('paused-worker', 10); await writeFile(resolve(paused.area, 'PAUSE'), 'operator');
assert.equal((await execute(['--job', paused.path])).code, 75);
const pausedState = await read(resolve(paused.area, 'supervisor-state.json'));
assert.equal((await execute(['--job', paused.path, '--resume'])).code, 0);
assert.equal((await read(resolve(paused.area, 'supervisor-state.json'))).deadline_epoch_ms, pausedState.deadline_epoch_ms);
cases.push('explicit pause/resume retains the exact first operational deadline');
const expired = await makeJob('expired-worker', 0.2);
assert.equal((await execute(['--job', expired.path])).code, 75);
const expiredState = await read(resolve(expired.area, 'supervisor-state.json'));
assert.equal(expiredState.status, 'BUDGET_EXHAUSTED');
assert.equal((await execute(['--job', expired.path, '--resume'])).code, 75);
const expiredAgain = await read(resolve(expired.area, 'supervisor-state.json'));
assert.equal(expiredAgain.deadline_epoch_ms, expiredState.deadline_epoch_ms); assert.equal(expiredAgain.attempts, expiredState.attempts);
cases.push('expired operational deadline cannot launch new workers or be reset by resume');

const old = resolve(temp, 'old'), phaseRoot = resolve(temp, 'phase'), sourceFile = resolve(temp, 'runtime.js');
await writeFile(sourceFile, 'frozen runtime'); const sourceHash = sha(await readFile(sourceFile));
const stageIds = ['easy/scenarios', 'easy/games', 'three-v4/scenarios', 'three-v4/games', 'three-v1/scenarios', 'three-v1/games', 'hex-v1/scenarios'];
const completed = [];
for (const id of stageIds) {
  const directory = resolve(old, id); await atomic(resolve(directory, 'report.json'), sealed({ scenarioFailures: 0,
    candidateCertifiedBadPasses: 0, truncatedGames: 0, sourceHashes: { [sourceFile]: sourceHash }, completeCases: 1 }));
  completed.push({ id, units: 1, cases: 1, reportSha256: sha(await readFile(resolve(directory, 'report.json'))) });
}
await atomic(resolve(old, 'checkpoint.json'), sealed({ identity: 'old-campaign', completed }));
await atomic(resolve(old, 'supervisor-state.json'), sealed({ status: 'FATAL', worker_identity: 'old-campaign' }));
await atomic(resolve(old, 'worker-1.exit.json'), { cancelled: 'WORKER_TIMEOUT', signal: 'SIGKILL', exit_code: null });
await atomic(resolve(old, 'progress.json'), { status: 'RUNNING' });
await atomic(resolve(old, 'job.json'), { synthetic: true }); await writeFile(resolve(old, 'supervisor-events.jsonl'), '{}\n');
await atomic(resolve(old, 'campaign-budget-v2.json'), sealed({ originalDeadlineEpochMs: Date.now() - 1000, firstFormalWorkerEpochMs: Date.now() - 1501000 }));
const auditPriorBudget = async path => ({ ...await read(path), evidenceHashes: { [path]: sha(await readFile(path)) } });
const auditPhase = (path, options = {}) => auditOperationalPhaseV3(path, { ...options, auditPriorBudget });
const protocolBytes = await readFile(resolve(root, 'web/tools/configs/pass-discipline-acceptance-v2-20261025.json'));
await writeFile(resolve(old, 'protocol.json'), protocolBytes);
const prefix = Array.from({ length: 31 }, (_, n) => ({ n }));
await atomic(resolve(old, 'hex-v1/games/checkpoint.json'), sealed({ completed: [{ id: 'baseline' }],
  active: { id: 'seed-74051-seat-BLACK', actions: prefix }, committedPlies: 80 }));
await prepareOperationalPhaseV3({ sourceCampaign: old, phaseRoot, auditPriorBudget });
const phasePath = resolve(phaseRoot, 'operational-phase-v3.json'), phase = await auditPhase(phasePath);
assert.equal(phase.oldBudgetStatus, 'BUDGET_EXHAUSTED_NOT_PASSED'); assert.equal(phase.copiedCompletedNaturalGames, 25);
assert.equal(phase.copiedActiveHexActions, 31); assert.equal(phase.maximumWallSeconds, 1200);
cases.push('separate phase preserves old failed budget, exact seven stages and 31-action prefix');
const stageBytes = await readFile(resolve(phaseRoot, 'easy/games/report.json'));
await atomic(resolve(phaseRoot, 'easy/games/report.json'), { forged: true });
await assert.rejects(auditPhase(phasePath), /modified or replayed/);
await writeFile(resolve(phaseRoot, 'easy/games/report.json'), stageBytes);
const activePath = resolve(phaseRoot, 'hex-v1/games/checkpoint.json'), activeBytes = await readFile(activePath), active = await read(activePath);
active.active.actions[0].n = -1; await atomic(activePath, sealed(active));
await assert.rejects(auditPhase(phasePath), /prefix was lost/); await writeFile(activePath, activeBytes);
cases.push('modified completed receipt or active action prefix refuses recovery');
const aliases = ['easy', 'three-v4', 'three-v1', 'hex-v1'], paths = {}, models = {};
for (const alias of aliases) { paths[alias] = resolve(temp, alias + '.json'); await atomic(paths[alias], { synthetic: true }); models[alias] = { training_identity: alias }; }
const baseline = resolve(temp, 'baseline'), candidate = resolve(temp, 'candidate');
for (const directory of [baseline, candidate]) await mkdir(resolve(directory, 'web/web前端/assets/research-ai'), { recursive: true });
let calls = 0;
assert.equal(await runPassCampaignV3(['--campaign-root', phaseRoot, '--protocol', resolve(phaseRoot, 'protocol.json'),
  '--baseline-root', baseline, '--candidate-root', candidate, '--composite-manifest', resolve(temp, 'manifest.json'), '--phase-protocol', phasePath], {
  compositeInput: async () => ({ paths, models, identity: 'fixture', manifestSha256: 'fixture', manifestPath: resolve(temp, 'manifest.json'), evidenceHashes: {} }),
  auditPhase,
  evaluate: async argv => { calls++; const directory = argv[argv.indexOf('--run-root') + 1];
    await atomic(resolve(directory, 'progress.json'), { status: 'COMPLETE', progress_units: 1 });
    await atomic(resolve(directory, 'report.json'), sealed({ scenarioFailures: 0, candidateCertifiedBadPasses: 0,
      truncatedGames: 0, completeCases: 1 })); return 0; } }), 0);
assert.equal(calls, 2); // Seven complete stages are never recomputed.
const completion = await read(resolve(phaseRoot, 'completion-receipt.json'));
assert.equal(completion.budget.oldBudgetStatus, 'BUDGET_EXHAUSTED_NOT_PASSED'); assert.equal(completion.stages.length, 9);
cases.push('new runner carries seven stages and evaluates only remaining stages under a new identity');
console.log(JSON.stringify({ schema: 'lifeline-pass-operational-phase-tests-v3', status: 'PASS', cases, total: cases.length,
  fixtureRoot: temp, scope: 'Real supervisor kill/resume and synthetic carry/decisions only; no formal game or admission.' }, null, 2));
