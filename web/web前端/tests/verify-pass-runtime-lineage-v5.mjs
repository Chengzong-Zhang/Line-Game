// Prior V4 is read-only. Synthetic campaign fixtures never play or admit games.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomic, sealed, unseal, sha, root } from '../../tools/neural-posttraining-data-v2.mjs';
import { prepareRuntimeEvaluationV4 } from '../../tools/pass-runtime-evaluation-v4.mjs';
import { runPassCampaignV4 } from '../../tools/run-pass-discipline-campaign-v4.mjs';
import { inspectPriorRuntimeV4, auditPriorRuntimeV5Lineage, auditWrappedRuntimeEvaluationV5 } from '../../tools/prepare-pass-runtime-evaluation-v5.mjs';
import { finalizePassDisciplineV5 } from '../../tools/finalize-pass-discipline-admission-v5.mjs';

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
for (const name of ['--previous-campaign', '--previous-runtime-snapshot']) if (!args.includes(name)) throw Error('Missing ' + name);
const cases = [], temp = await mkdtemp(resolve(tmpdir(), 'pass-runtime-v5-'));
const prior = await inspectPriorRuntimeV4(option('--previous-campaign'), option('--previous-runtime-snapshot'));
assert.equal(prior.previousRuntimeNaturalGames, 34); assert.equal(prior.previousRuntimeSharedCases, 112);
assert.equal(prior.previousRuntimeSharedFailures, 3); assert.equal(prior.previousSourceSnapshotFiles, 111);
assert.equal(prior.failedCases.length, 3);
cases.push('complete rejected V4 receipts, three failed cases and111 source byte snapshots audited read-only');
const lineagePath = resolve(temp, 'prior-lineage.json');
await atomic(lineagePath, sealed({ ...prior, identity: sha(JSON.stringify(prior)) }));
const lineageBytes = await readFile(lineagePath);
await auditPriorRuntimeV5Lineage(lineagePath);
for (const [name, alter] of [
  ['omitted failed case', value => { value.failedCases.pop(); }],
  ['omitted prior source snapshot', value => {
    const path = Object.keys(value.evidenceHashes).find(path => path.includes('fatal-source-snapshot') && path.replaceAll('\\', '/').endsWith('/web/web前端/AIPassDisciplineV3.js'));
    assert.ok(path); delete value.evidenceHashes[path];
  }],
  ['changed prior rejection facts', value => { value.previousRuntimeSharedFailures = 0; }],
]) {
  const value = structuredClone(prior); alter(value);
  await atomic(lineagePath, sealed({ ...value, identity: sha(JSON.stringify(value)) }));
  await assert.rejects(auditPriorRuntimeV5Lineage(lineagePath), /sidecar facts or complete evidence inventory/);
  cases.push('resealed ' + name + ' rejected');
}
await writeFile(lineagePath, lineageBytes);
const v4 = unseal(JSON.parse(await readFile(prior.previousPhasePath))), phaseRoot = resolve(temp, 'fresh');
const criticalCopy = resolve(temp, 'copied-critical-failure.json'), criticalBytes = await readFile(prior.failedCases[0].path);
await writeFile(criticalCopy, criticalBytes);
const wrapperPaths = ['pass-runtime-evaluation-v4.mjs', 'prepare-pass-runtime-evaluation-v4.mjs',
  'run-pass-discipline-campaign-v4.mjs', 'finalize-pass-discipline-admission-v4.mjs',
  'prepare-pass-runtime-evaluation-v5.mjs', 'finalize-pass-discipline-admission-v5.mjs']
  .map(name => resolve(root, 'web/tools', name));
const frozenSources = { ...prior.evidenceHashes, [lineagePath]: sha(lineageBytes), [criticalCopy]: sha(criticalBytes) };
for (const path of wrapperPaths) frozenSources[path] = sha(await readFile(path));
const protocolPath = resolve(root, 'web/tools/configs/pass-discipline-acceptance-v2-20261025.json');
await prepareRuntimeEvaluationV4({ previousCampaign: v4.previousCampaign, previousRuntimeSnapshot: v4.previousRuntimeSnapshot,
  phaseRoot, protocolPath, frozenSources });
const phasePath = resolve(phaseRoot, 'runtime-evaluation-v4.json'), original = unseal(JSON.parse(await readFile(phasePath)));
delete original.identity;
const body = { ...original, wrappedRuntimeRevision: 5, previousRuntimeV4LineagePath: lineagePath,
  previousRuntimeV4LineageSha256: sha(lineageBytes) };
await atomic(phasePath, sealed({ ...body, identity: sha(JSON.stringify(body)) }));
const phaseBytes = await readFile(phasePath); await auditWrappedRuntimeEvaluationV5(phasePath);
for (const [name, alter, error] of [
  ['wrong wrapped revision', value => { value.wrappedRuntimeRevision = 4; }, /wrapped runtime revision/],
  ['omitted frozen failure receipt', value => { delete value.frozenSources[prior.failedCases[0].path]; }, /full prior receipts/],
  ['omitted base finalizer source', value => { delete value.frozenSources[resolve(root, 'web/tools/finalize-pass-discipline-admission-v4.mjs')]; }, /full prior receipts/],
  ['old-game reuse', value => { value.previousGamesReused = true; }, /no-reuse contract/],
]) {
  const value = structuredClone(body); alter(value);
  await atomic(phasePath, sealed({ ...value, identity: sha(JSON.stringify(value)) }));
  await assert.rejects(auditWrappedRuntimeEvaluationV5(phasePath), error);
  cases.push('resealed ' + name + ' rejected');
}
await writeFile(phasePath, phaseBytes);
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
await writeFile(criticalCopy, 'corrupt copied prior failure; original remains untouched');
await assert.rejects(runPassCampaignV4(argv, dependencies), /Frozen new runtime\/model\/evaluator source changed/);
assert.equal(calls, 1); await writeFile(criticalCopy, criticalBytes);
assert.equal(await runPassCampaignV4(argv, dependencies), 0); assert.equal(calls, 9);
assert.equal(await runPassCampaignV4(argv, dependencies), 0); assert.equal(calls, 9);
cases.push('unchanged V4 runner rechecks frozen prior bytes at resume and executes9 fresh stages only once');
const completion = unseal(JSON.parse(await readFile(resolve(phaseRoot, 'completion-receipt.json'))));
assert.equal(completion.budget.carriedNaturalGames, 0); assert.equal(completion.budget.previousGamesReused, false);
const wrong = { ...body, wrappedRuntimeRevision: 4 }; await atomic(phasePath, sealed({ ...wrong, identity: sha(JSON.stringify(wrong)) }));
await atomic(resolve(phaseRoot, 'job.json'), { command: ['node', 'frozen-runner', '--phase-protocol', phasePath] });
await assert.rejects(finalizePassDisciplineV5({ campaignRoot: phaseRoot }), /wrapped runtime revision/);
await writeFile(phasePath, phaseBytes);
cases.push('V5 finalizer refuses a plain/resealed V4 campaign before any admission output');
console.log(JSON.stringify({ schema: 'lifeline-pass-runtime-lineage-tests-v5', status: 'PASS', total: cases.length, cases,
  fixtureRoot: temp, preservedPriorFiles: Object.keys(prior.evidenceHashes).length,
  scope: 'Prior rejected V4 read-only; all campaign decisions synthetic, no formal game/freeze/launch/admission.' }, null, 2));
