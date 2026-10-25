// Read-only prior-evidence audit and injected fresh-run fixtures; no real games.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomic, sealed, unseal, sha, root } from '../../tools/neural-posttraining-data-v2.mjs';
import { prepareRuntimeEvaluationV4, auditRuntimeEvaluationV4 } from '../../tools/pass-runtime-evaluation-v4.mjs';
import { runPassCampaignV4 } from '../../tools/run-pass-discipline-campaign-v4.mjs';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (!args.includes('--previous-campaign') || !args.includes('--previous-runtime-snapshot')) throw Error('Use explicit read-only prior evidence paths');
const temp = await mkdtemp(resolve(tmpdir(), 'pass-new-runtime-v4-')), cases = [], phaseRoot = resolve(temp, 'new-experiment');
const runtimeFile = resolve(temp, 'runtime.js'); await writeFile(runtimeFile, 'frozen new runtime');
const protocolPath = resolve(root, 'web/tools/configs/pass-discipline-acceptance-v2-20261025.json');
await prepareRuntimeEvaluationV4({ previousCampaign: option('--previous-campaign'), previousRuntimeSnapshot: option('--previous-runtime-snapshot'),
  phaseRoot, protocolPath, frozenSources: { [runtimeFile]: sha(await readFile(runtimeFile)) } });
const phasePath = resolve(phaseRoot, 'runtime-evaluation-v4.json'), phase = await auditRuntimeEvaluationV4(phasePath);
assert.equal(phase.previousGamesReused, false); assert.deepEqual(phase.carryCompletedStages, []);
assert.equal(phase.copiedCompletedNaturalGames, 0); assert.equal(phase.requiredNaturalGames, 34);
assert.ok(!(await readdir(phaseRoot)).some(name => ['easy', 'three-v4', 'three-v1', 'hex-v1'].includes(name)));
cases.push('new runtime starts with no old stage/game/action and requires all34 games');
const original = await readFile(phasePath);
const { identity, ...forgedBody } = phase; delete forgedBody.path; delete forgedBody.sha256; delete forgedBody.evidenceHashes;
forgedBody.previousGamesReused = true;
await atomic(phasePath, sealed({ ...forgedBody, identity: sha(JSON.stringify(forgedBody)) }));
await assert.rejects(auditRuntimeEvaluationV4(phasePath), /no-reuse contract/); await writeFile(phasePath, original);
await writeFile(runtimeFile, 'changed runtime'); await assert.rejects(auditRuntimeEvaluationV4(phasePath), /source changed/);
await writeFile(runtimeFile, 'frozen new runtime');
cases.push('resealed old-game reuse and runtime source drift are rejected');
const aliases = ['easy', 'three-v4', 'three-v1', 'hex-v1'], paths = {}, models = {};
for (const alias of aliases) { paths[alias] = resolve(temp, alias + '.json'); await atomic(paths[alias], { synthetic: true }); models[alias] = { training_identity: alias }; }
const baseline = resolve(temp, 'baseline'), candidate = resolve(temp, 'candidate');
for (const directory of [baseline, candidate]) await mkdir(resolve(directory, 'web/web前端/assets/research-ai'), { recursive: true });
let calls = 0;
const dependencies = { compositeInput: async () => ({ paths, models, identity: 'fixture', manifestSha256: 'fixture',
  manifestPath: resolve(temp, 'manifest.json'), evidenceHashes: {} }),
  evaluate: async argv => { calls++; const directory = argv[argv.indexOf('--run-root') + 1];
    await atomic(resolve(directory, 'progress.json'), { status: 'COMPLETE', progress_units: 1 });
    await atomic(resolve(directory, 'report.json'), sealed({ scenarioFailures: 0, candidateCertifiedBadPasses: 0,
      truncatedGames: 0, completeCases: 1 })); return 0; } };
const argv = ['--campaign-root', phaseRoot, '--protocol', protocolPath, '--baseline-root', baseline, '--candidate-root', candidate,
  '--composite-manifest', resolve(temp, 'manifest.json'), '--phase-protocol', phasePath];
assert.equal(await runPassCampaignV4([...argv, '--fault-after-stage-checkpoint'], dependencies), 79); assert.equal(calls, 1);
assert.equal(await runPassCampaignV4(argv, dependencies), 0); assert.equal(calls, 9);
assert.equal(await runPassCampaignV4(argv, dependencies), 0); assert.equal(calls, 9);
const completion = unseal(JSON.parse(await readFile(resolve(phaseRoot, 'completion-receipt.json'))));
assert.equal(completion.budget.carriedNaturalGames, 0); assert.equal(completion.budget.previousGamesReused, false);
assert.equal(completion.budget.oldBudgetStatus, 'BUDGET_EXHAUSTED_NOT_PASSED');
cases.push('all9 fresh stages run once, resume without replay and preserve old failed budget disclosure');
const expiredRoot = resolve(temp, 'expired'), expiredPhasePath = resolve(temp, 'expired-phase.json');
const expired = unseal(JSON.parse(original)); delete expired.identity;
expired.phaseRoot = expiredRoot; expired.phaseCreatedEpochMs = Date.now() - 1201000; expired.phaseDeadlineEpochMs = expired.phaseCreatedEpochMs + 1200000;
await atomic(expiredPhasePath, sealed({ ...expired, identity: sha(JSON.stringify(expired)) }));
const expiredArgv = [...argv]; expiredArgv[1] = expiredRoot; expiredArgv[expiredArgv.indexOf('--phase-protocol') + 1] = expiredPhasePath;
await assert.rejects(runPassCampaignV4(expiredArgv, dependencies), /wall budget exhausted/); assert.equal(calls, 9);
cases.push('new1200 deadline expires without launching another stage or resuming time');
console.log(JSON.stringify({ schema: 'lifeline-pass-runtime-evaluation-tests-v4', status: 'PASS', cases, total: cases.length,
  fixtureRoot: temp, scope: 'Prior failed evidence read-only; synthetic sources/candidates and injected decisions, no formal game or admission.' }, null, 2));
