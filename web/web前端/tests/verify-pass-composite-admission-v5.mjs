// Synthetic, injected-audit fixtures only; never a training or strength run.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { passCompositeReferences, passCompositeInput, verifyCompositeOverlay, passParentAliases as aliases }
  from '../../tools/pass-discipline-composite-input-v5.mjs';
import { runPassCampaign } from '../../tools/run-pass-discipline-campaign-v1.mjs';
import { verifyPassCampaignCompletion } from '../../tools/finalize-pass-discipline-admission-v1.mjs';
import { evaluatePassMain } from '../../tools/evaluate-pass-discipline-v1.mjs';
import { atomic, sealed, unseal, sha, root } from '../../tools/neural-posttraining-data-v2.mjs';

const fixture = await mkdtemp(resolve(tmpdir(), 'lifeline-pass-composite-v5-')), cases = [];
const oldRoot = resolve(fixture, 'old'), extensionRoot = resolve(fixture, 'new'), references = {};
for (const alias of aliases) {
  const isHex = alias === 'hex-v1', runRoot = isHex ? extensionRoot : oldRoot;
  const candidatePath = isHex ? 'extension-candidate.json' : `models/${alias}/candidate.json`;
  const weights = [...Array(16).fill(0.25), -5];
  await atomic(resolve(runRoot, candidatePath), sealed({ schema: isHex ? 'lifeline-terminal-policy-extension-candidate-v5'
    : 'lifeline-terminal-policy-linear17-candidate-v4', ...(isHex ? {} : { parent_alias: alias }),
    identity: isHex ? 'synthetic-new-identity' : 'synthetic-old-identity', weights, passBias: -5,
    runtime_spec: { weights: weights.slice(0, 16), passBias: -5, temperature: 1 } }));
  references[alias] = { run_root: runRoot, candidate_path: candidatePath,
    candidate_sha256: sha(await readFile(resolve(runRoot, candidatePath))),
    training_identity: isHex ? 'synthetic-new-identity' : 'synthetic-old-identity',
    kind: isHex ? 'explicit-v5-state-continuation' : 'original-v4-candidate' };
}
for (const [directory, names] of [[oldRoot, ['checkpoint.json']], [extensionRoot,
  ['extension-receipt.json', 'checkpoint.json', 'extension-input.json', 'protocol.json', 'frozen-sources.json']]])
  for (const name of names) await atomic(resolve(directory, name), { synthetic_fixture: true });
const manifestPath = resolve(fixture, 'synthetic-composite.json');
const body = { schema: 'lifeline-terminal-policy-composite-v5', fixture: false, strength_verified: false, runtime_admitted: false,
  original_run: { run_root: oldRoot }, extension_run: { run_root: extensionRoot }, references,
  totals: { original_natural_games: 96, new_natural_games: 1, cumulative_hex_updates: 4 } };
const manifest = { ...body, identity: sha(JSON.stringify(body)) };
await atomic(manifestPath, sealed(manifest));
const proof = { status: 'PASS_EXPLICIT_COMPOSITE_TRAINING_EVIDENCE', identity: manifest.identity,
  manifest_sha256: sha(await readFile(manifestPath)), fixture: false, original_failure_preserved: true,
  totals: body.totals, models: references };
const input = await passCompositeInput(manifestPath, { audit: async () => proof });
assert.equal(input.models['hex-v1'].training_identity, 'synthetic-new-identity');
assert.equal(input.models.easy.training_identity, 'synthetic-old-identity');
for (const alias of aliases) assert.equal(input.models[alias].runtime_parameters_sha256,
  sha(JSON.stringify({ weights: Array(16).fill(0.25), passBias: -5, temperature: 1, rules_version: 'territory-v3' })));
const overlay = { composite_schema: manifest.schema, training_identity: input.identity,
  training_completion_sha256: input.manifestSha256,
  per_model_identities: Object.fromEntries(aliases.map(a => [a, references[a].training_identity])),
  models: Object.fromEntries(aliases.map(a => [a, { training_identity: references[a].training_identity,
    training_provenance: { composite_identity: input.identity, source_run_identity: references[a].training_identity, source_kind: references[a].kind } }])) };
verifyCompositeOverlay(overlay, input);
const unified = structuredClone(overlay); unified.per_model_identities['hex-v1'] = references.easy.training_identity;
assert.throws(() => verifyCompositeOverlay(unified, input), /per-model/);
const wrongSource = structuredClone(overlay); wrongSource.models['hex-v1'].training_provenance.source_run_identity = 'other';
assert.throws(() => verifyCompositeOverlay(wrongSource, input), /distinct training provenance/);
cases.push('distinct old/new training identities and independent actual runtime parameter hashes');

const fixtureBody = { ...body, fixture: true }, badManifestPath = resolve(fixture, 'recovery-fixture.json');
await atomic(badManifestPath, sealed({ ...fixtureBody, identity: sha(JSON.stringify(fixtureBody)) }));
await assert.rejects(passCompositeReferences(badManifestPath), /explicit formal/);
await assert.rejects(passCompositeInput(manifestPath, { audit: async () => ({ ...proof, status: 'FAIL' }) }), /independently audited/);
const hexPath = input.paths['hex-v1'], hexBytes = await readFile(hexPath), hex = unseal(JSON.parse(hexBytes));
hex.weights[0] += 0.5; await atomic(hexPath, sealed(hex));
await assert.rejects(passCompositeReferences(manifestPath), /runtime parameters differ/);
await writeFile(hexPath, hexBytes);
cases.push('recovery-fixture, failed audit and changed candidate bytes rejected');

const baseline = resolve(fixture, 'baseline'), candidate = resolve(fixture, 'candidate');
for (const directory of [baseline, candidate]) {
  await mkdir(resolve(directory, 'web/web前端/assets/research-ai'), { recursive: true });
  await writeFile(resolve(directory, 'web/web前端/fixture.js'), 'export const synthetic = true;\n');
}
const protocolPath = resolve(fixture, 'protocol.json');
await atomic(protocolPath, { schema: 'lifeline-pass-discipline-acceptance-v2', protocol_revision: 2,
  total_campaign_wall_seconds: 1500, max_game_plies: 2,
  contexts: [{ parent: 'hex-v1', player_count: 4, grid_size: 5, seeds: [7], scenario_sizes: [5] }],
  shared_worker_profiles: [], oracle: { maxNodes: 1, timeMs: 1, fullOpponentRound: true } });
const evaluatorArgs = ['--run-root', resolve(fixture, 'bare-extension'), '--protocol', protocolPath,
  '--baseline-root', baseline, '--candidate-root', candidate, '--candidate', hexPath, '--parent', 'hex-v1'];
await assert.rejects(evaluatePassMain(evaluatorArgs), /v5 continuation requires its explicit composite/);
const wrongPathArgs = [...evaluatorArgs, '--composite-manifest', manifestPath];
wrongPathArgs[wrongPathArgs.indexOf('--candidate') + 1] = input.paths.easy;
await assert.rejects(evaluatePassMain(wrongPathArgs), /Candidate path differs/);
cases.push('bare v5 candidate and alias/path substitution cannot enter formal evaluator');

let stageCalls = 0, epoch = 1000;
const lightweight = async args => {
  stageCalls++; const option = name => args[args.indexOf(name) + 1], mode = option('--mode'), alias = option('--parent');
  assert.equal(option('--composite-manifest'), manifestPath);
  if (mode !== 'shared-scenarios') assert.equal(option('--candidate'), input.paths[alias]);
  const directory = option('--run-root'); await mkdir(directory, { recursive: true });
  await atomic(resolve(directory, 'progress.json'), { status: 'COMPLETE', progress_units: 2 });
  await atomic(resolve(directory, 'report.json'), sealed({ scenarioFailures: 0, candidateCertifiedBadPasses: 0, truncatedGames: 0, completeCases: 1 }));
  return 0;
};
const campaignRoot = resolve(fixture, 'campaign'), campaignArgs = ['--campaign-root', campaignRoot, '--protocol', protocolPath,
  '--composite-manifest', manifestPath, '--baseline-root', baseline, '--candidate-root', candidate];
await writeFile(protocolPath, await readFile(resolve(root, 'web/tools/configs/pass-discipline-acceptance-v2-20261025.json')));
const v5EvaluationArgs = [...evaluatorArgs, '--composite-manifest', manifestPath];
v5EvaluationArgs[1] = resolve(fixture, 'positive-v5-evaluator');
assert.equal(await evaluatePassMain(v5EvaluationArgs, { decide: async () => ({ point: null, elapsedMs: 0.01,
  modelInfo: { passDisciplineTraining: { candidate_sha256: input.hashes['hex-v1'] } } }),
  oracle: () => ({ complete: false, witness: null }) }), 75);
// The default bounded segment checkpoints eight actions; continue without repeating them.
const finishArgs = [...v5EvaluationArgs, '--max-new-units', '10000', '--max-seconds', '55'];
assert.equal(await evaluatePassMain(finishArgs, { decide: async () => ({ point: null, elapsedMs: 0.01,
  modelInfo: { passDisciplineTraining: { candidate_sha256: input.hashes['hex-v1'] } } }),
  oracle: () => ({ complete: false, witness: null }) }), 0);
const v5Report = unseal(JSON.parse(await readFile(resolve(fixture, 'positive-v5-evaluator/report.json'))));
assert.equal(v5Report.trainingComposite.perModelIdentities['hex-v1'], 'synthetic-new-identity');
assert.equal(v5Report.candidateSha256, input.hashes['hex-v1']);
cases.push('v5 continuation candidate evaluates/resumes with actual per-model provenance binding');
const injected = { evaluate: lightweight, compositeInput: async () => input, now: () => epoch };
assert.equal(await runPassCampaign([...campaignArgs, '--fault-after-stage-checkpoint'], injected), 79);
assert.equal(stageCalls, 1); assert.equal(await runPassCampaign(campaignArgs, injected), 0); assert.equal(stageCalls, 9);
const read = async path => unseal(JSON.parse(await readFile(path))), completion = await read(resolve(campaignRoot, 'completion-receipt.json'));
assert.equal(completion.trainingComposite.perModelIdentities['hex-v1'], 'synthetic-new-identity');
epoch = 2000; assert.equal(await runPassCampaign(campaignArgs, injected), 0); assert.equal(stageCalls, 9);
assert.deepEqual((await read(resolve(campaignRoot, 'completion-receipt.json'))).budget, completion.budget);
cases.push('nine composite stages resume/idempotence preserve all per-model identities and first deadline');

const expiredArgs = [...campaignArgs], expired = resolve(fixture, 'expired'); expiredArgs[1] = expired;
epoch = 1000; assert.equal(await runPassCampaign([...expiredArgs, '--fault-after-stage-checkpoint'], injected), 79);
epoch = 1501001;
await assert.rejects(runPassCampaign(expiredArgs, injected), /resume cannot extend/);
assert.equal((await read(resolve(expired, 'checkpoint.json'))).deadlineEpochMs, 1501000);
cases.push('expired single wall budget cannot be extended by resume');

// Synthetic supervisor receipts exercise only the independent completion gate.
const runner = resolve(root, 'web/tools/run-pass-discipline-campaign-v1.mjs'), supervisorPath = resolve(root, 'web/tools/supervise-three-player-job.mjs');
const job = { schema: 'lifeline-supervised-job-v1', max_wall_seconds: 1500, run_root: campaignRoot, cwd: root,
  command: [process.execPath, runner, '--campaign-root', campaignRoot, '--protocol', protocolPath], identity_files: [runner, protocolPath] };
await atomic(resolve(campaignRoot, 'job.json'), job);
const identityFiles = {};
for (const path of [supervisorPath, runner, protocolPath]) identityFiles[path] = sha(await readFile(path));
await atomic(resolve(campaignRoot, 'supervisor-state.json'), sealed({ status: 'COMPLETE', worker_identity: completion.identity,
  identity: sha(JSON.stringify({ raw_job_sha256: sha(await readFile(resolve(campaignRoot, 'job.json'))), identity_files: identityFiles })) }));
await writeFile(resolve(campaignRoot, 'supervisor-events.jsonl'), JSON.stringify({ type: 'WORKER_START', time_epoch_ms: 900 }) + '\n');
const sources = { ...completion.sources }; delete sources[runner];
const gate = { campaignRoot, protocolHash: completion.protocolSha256,
  reportHashes: Object.fromEntries(completion.stages.map(row => [row.id, row.reportSha256])), candidateHashes: input.hashes,
  sources, trainingComposite: completion.trainingComposite };
assert.equal((await verifyPassCampaignCompletion(gate)).totalSupervisedWallMs, 100);
await writeFile(resolve(campaignRoot, 'supervisor-events.jsonl'), JSON.stringify({ type: 'WORKER_START', time_epoch_ms: -1500000 }) + '\n');
await assert.rejects(verifyPassCampaignCompletion(gate), /first supervised worker exceeded/);
await writeFile(resolve(campaignRoot, 'supervisor-events.jsonl'), JSON.stringify({ type: 'WORKER_START', time_epoch_ms: 900 }) + '\n');
await assert.rejects(verifyPassCampaignCompletion({ ...gate, trainingComposite: null }), /binding differs/);
cases.push('combined gate binds nine reports and original supervised 1500-second elapsed time');

console.log(JSON.stringify({ schema: 'lifeline-pass-composite-admission-tests-v5', status: 'PASS', cases, total: cases.length,
  fixtureRoot: fixture, scope: 'synthetic candidates/injected audit and decisions only; no training, formal evaluation, admission or publication' }, null, 2));
