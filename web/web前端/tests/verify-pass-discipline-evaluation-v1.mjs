import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GameEngine, PLAYER_ORDER } from '../GameEngine.js';
import { serializeEngineState } from '../AIStateProtocol.js';
import { saveState } from '../AIEngine.js';
import { certifyIndependentExpansion, evaluatePassMain, freshEvaluationOpening,
  terminalExpansionFixture, terminalOnlyRewardAudit, rawProductDecision, rawCandidateDecision } from '../../tools/evaluate-pass-discipline-v1.mjs';
import { engineFromTrainingState } from '../../tools/defensive-training-data-v1.mjs';
import { sealed, unseal, sha } from '../../tools/neural-posttraining-data-v2.mjs';
import { runPassCampaign } from '../../tools/run-pass-discipline-campaign-v1.mjs';

const temp = await mkdtemp(resolve(tmpdir(), 'lifeline-pass-evaluation-'));
const cases = [];
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const baselineRoot = resolve(temp, 'baseline'), candidateRoot = resolve(temp, 'candidate');
for (const sourceRoot of [baselineRoot, candidateRoot]) {
  await mkdir(resolve(sourceRoot, 'web/web前端/assets/research-ai'), { recursive: true });
  await writeFile(resolve(sourceRoot, 'web/web前端/fixture.js'), 'export const fixture = true;\n');
  await writeFile(resolve(sourceRoot, 'web/web前端/bundle.manifest.json'), '{"frozen":true}\n');
  await writeFile(resolve(sourceRoot, 'web/web前端/assets/research-ai/fixture.json'), '{}\n');
}
const protocol = { schema: 'lifeline-pass-discipline-acceptance-v1', max_game_plies: 80,
  contexts: [{ parent: 'easy', player_count: 3, grid_size: 5, seeds: [7], scenario_sizes: [5] }],
  shared_worker_profiles: [{ player_count: 2, sizes: [5], profile: { strategy: 'greedy' } }],
  oracle: { maxRoots: 12, maxNodes: 30000, timeMs: 1000, fullOpponentRound: true } };
const protocolPath = resolve(temp, 'protocol.json'); await writeFile(protocolPath, JSON.stringify(protocol));
const weights = [...Array(16).fill(0), -10];
const candidatePath = resolve(temp, 'candidate.json');
await writeFile(candidatePath, JSON.stringify(sealed({ schema: 'lifeline-terminal-policy-linear17-candidate-v4',
  parent_alias: 'easy', weights, runtime_spec: { weights: weights.slice(0, 16), passBias: -10, temperature: 1 } })));
const candidateHash = sha(await readFile(candidatePath));
const binding = { passDisciplineTraining: { candidate_sha256: candidateHash } };
let calls = 0;
const deterministic = async engine => {
  calls++;
  const move = engine.turnCount < engine.activePlayers.length ? engine.getLegalMoves()[0]?.point ?? null : null;
  return { point: move, elapsedMs: calls / 1000, modelInfo: binding };
};
const args = (name, mode = 'games', extra = []) => ['--run-root', resolve(temp, name), '--protocol', protocolPath,
  '--baseline-root', baselineRoot, '--candidate-root', candidateRoot, '--candidate', candidatePath,
  '--parent', 'easy', '--mode', mode, '--max-new-units', '10000', '--max-seconds', '55', ...extra];

// The independent oracle must see the later actual opponent, and preserve the source.
const trap = new GameEngine({ gridSize: 7, playerCount: 3, rulesVersion: 'territory-v3',
  initialPositions: { BLACK: [0, 0], WHITE: [6, 0], PURPLE: [3, 3] } });
const untouched = saveState(trap);
assert.ok(certifyIndependentExpansion(trap, { points: [[0, 4]], fullOpponentRound: false }).witness);
const rejected = certifyIndependentExpansion(trap, { points: [[0, 4]] });
assert.equal(rejected.status, 'refuted-expansion');
assert.equal(rejected.counterexample.actions.at(-1).actor, 'PURPLE');
assert.deepEqual(rejected.counterexample.actions.at(-1).point, [0, 3]);
assert.equal(rejected.counterexample.area, 1); assert.deepEqual(saveState(trap), untouched);
assert.equal(certifyIndependentExpansion(trap, { maxNodes: 0 }).status, 'incomplete');
const fallbackTrap = new GameEngine({ gridSize: 6, playerCount: 3, rulesVersion: 'territory-v3',
  initialPositions: { BLACK: [0, 0], WHITE: [5, 0], PURPLE: [2, 3] } });
assert.ok(certifyIndependentExpansion(fallbackTrap, { points: [[0, 4]], fullOpponentRound: false }).witness);
assert.equal(certifyIndependentExpansion(fallbackTrap, { points: [[0, 4]] }).status, 'refuted-expansion');
cases.push('independent full-round third-seat cut refutation and budget/state isolation');

for (const players of [2, 3]) {
  const e = terminalExpansionFixture({ gridSize: 5, playerCount: players, rulesVersion: 'territory-v3' });
  const structural = certifyIndependentExpansion(e);
  const exhaustive = certifyIndependentExpansion(e, { allowStructuralProof: false });
  assert.ok(structural.witness?.structuralProtectedRootProof);
  assert.ok(exhaustive.witness && exhaustive.witness.replyActionsCompleted > 0 && exhaustive.witness.includesPass);
  assert.equal(structural.witness.minimumReplyArea, exhaustive.witness.minimumReplyArea);
  const selected = engineFromTrainingState(serializeEngineState(e));
  assert.equal(selected.skipTurn().success, true); assert.equal(selected.gameOver, true);
  const audit = terminalOnlyRewardAudit(selected, [{}, {}, {}]);
  assert.equal(audit.gamma, 1); assert.ok(audit.rewards.slice(0, -1).every(row => Object.values(row).every(value => value === 0)));
  assert.ok(audit.undiscountedReturns.every(row => JSON.stringify(row) === JSON.stringify(audit.terminalReturns)));
  const incomplete = terminalOnlyRewardAudit(e, [{}, {}]);
  assert.equal(incomplete.trainingEligible, false); assert.equal(incomplete.terminalReturns, null);
  assert.ok(incomplete.rewards.every(row => Object.values(row).every(value => value === 0)));
}
cases.push('structural proof checked against exhaustive legal/PASS round; gamma 1 terminal-only and truncation');

for (const players of [3, 4, 7, 15]) {
  const context = { parent: 'layout-test', player_count: players, grid_size: players > 6 ? 9 : 5 };
  const state = freshEvaluationOpening(context, 111), engine = engineFromTrainingState(state);
  assert.deepEqual(state, freshEvaluationOpening(context, 111));
  assert.equal(engine.turnCount, 0); assert.equal(engine.activePlayers.length, players);
  assert.ok(engine.activePlayers.every(player => engine.getLegalMoves(player).length >= 2));
  assert.equal(new Set(Object.values(engine.initialPositions).map(p => p.join(','))).size, players);
}
const points = new GameEngine({ gridSize: 5 }).validPositions;
const forced = new GameEngine({ gridSize: 5, playerCount: 15, boardShape: 'triangle', rulesVersion: 'territory-v3',
  initialPositions: Object.fromEntries(PLAYER_ORDER.map((player, i) => [player, points[i]])) });
assert.equal(certifyIndependentExpansion(forced).status, 'forced-pass');
cases.push('deterministic nondegenerate ply0 3/4/7/15 layouts and genuine forced 15-player PASS');

calls = 0; assert.equal(await evaluatePassMain(args('clean'), { decide: deterministic }), 0);
const cleanReport = unseal(await read(resolve(temp, 'clean/report.json')));
assert.equal(cleanReport.games, 4); assert.equal(cleanReport.naturalGames, 4); assert.equal(cleanReport.truncatedGames, 0);
assert.equal(cleanReport.rewardAudit.naturallyCompleteAuditedEpisodes, 4);
assert.equal(cleanReport.sourceHashes[resolve(candidateRoot, 'web/web前端/bundle.manifest.json')],
  sha(await readFile(resolve(candidateRoot, 'web/web前端/bundle.manifest.json'))));
const completedCalls = calls;
assert.equal(await evaluatePassMain(args('clean'), { decide: deterministic }), 0);
assert.equal(calls, completedCalls, 'Completed games must never be replayed by resume');
cases.push('paired full natural games and completion idempotence');

calls = 0; assert.equal(await evaluatePassMain(args('ply-fault', 'games', ['--fault-after-ply-checkpoint']), { decide: deterministic }), 79);
const actionCheckpoint = unseal(await read(resolve(temp, 'ply-fault/checkpoint.json')));
assert.equal(actionCheckpoint.committedPlies, 1); assert.equal(actionCheckpoint.active.actions.length, 1);
assert.equal(await evaluatePassMain(args('ply-fault'), { decide: deterministic }), 0);
assert.equal(calls, completedCalls, 'Durable first action must not be recomputed on recovery');
cases.push('after-action recovery replays complete canonical history without duplicate decisions');

calls = 0; assert.equal(await evaluatePassMain(args('unit-fault', 'games', ['--fault-after-unit-write']), { decide: deterministic }), 79);
const beforeAdoption = calls;
assert.equal(await evaluatePassMain(args('unit-fault'), { decide: deterministic }), 0);
assert.equal(calls, completedCalls); assert.ok(beforeAdoption > 0);
cases.push('adopt complete game written before checkpoint index');

const scenarioDecide = async engine => { calls++; return { point: engine.getLegalMoves()[0]?.point ?? null, elapsedMs: calls / 1000, modelInfo: binding }; };
calls = 0; assert.equal(await evaluatePassMain(args('scenario-fault', 'scenarios', ['--fault-after-unit-write']), { decide: scenarioDecide }), 79);
assert.equal(calls, 2);
assert.equal(await evaluatePassMain(args('scenario-fault', 'scenarios'), { decide: scenarioDecide }), 0);
assert.equal(calls, 6, 'Adopt first volatile-timing scenario instead of recomputing it');
assert.equal(unseal(await read(resolve(temp, 'scenario-fault/report.json'))).scenarioFailures, 0);
cases.push('adopt complete pre-index scenario with volatile timing and candidate hash binding');

for (const marker of ['PAUSE', 'STOP']) {
  const name = `control-${marker}`; await mkdir(resolve(temp, name));
  await writeFile(resolve(temp, name, marker), 'operator request');
  await writeFile(resolve(temp, name, 'checkpoint.json.999999.tmp'), '{unfinished');
  await writeFile(resolve(temp, name, 'supervisor-state.json.999999.tmp'), 'supervisor-owned'); calls = 0;
  assert.equal(await evaluatePassMain(args(name), { decide: deterministic }), 75); assert.equal(calls, 0);
  assert.equal((await read(resolve(temp, name, 'progress.json'))).status, marker === 'PAUSE' ? 'PAUSED' : 'STOPPED');
  assert.ok((await readdir(resolve(temp, name))).some(file => file.startsWith('checkpoint.json.999999.tmp.interrupted-')));
  assert.equal(await readFile(resolve(temp, name, 'supervisor-state.json.999999.tmp'), 'utf8'), 'supervisor-owned');
  await unlink(resolve(temp, name, marker)); assert.equal(await evaluatePassMain(args(name), { decide: deterministic }), 0);
}
cases.push('explicit PAUSE/STOP and preserved interrupted write');

let release, entered;
const pending = new Promise(done => { release = done; }), ready = new Promise(done => { entered = done; });
let first = true;
const held = evaluatePassMain(args('duplicate'), { decide: async engine => { if (first) { first = false; entered(); await pending; } return deterministic(engine); } });
await ready;
await assert.rejects(evaluatePassMain(args('duplicate'), { decide: deterministic }), error => error.code === 'EADDRINUSE');
release(); assert.equal(await held, 0);
cases.push('simultaneous worker exclusion');

await evaluatePassMain(args('corrupt', 'games', ['--fault-after-ply-checkpoint']), { decide: deterministic });
const corrupt = await read(resolve(temp, 'corrupt/checkpoint.json')); corrupt.committedPlies++;
await writeFile(resolve(temp, 'corrupt/checkpoint.json'), JSON.stringify(corrupt));
await assert.rejects(evaluatePassMain(args('corrupt'), { decide: deterministic }), /integrity/);
const indexed = unseal(await read(resolve(temp, 'clean/checkpoint.json'))).completed[0];
await writeFile(resolve(temp, 'clean', indexed.path), '{}');
await assert.rejects(evaluatePassMain(args('clean'), { decide: deterministic }), /receipt changed/);
await assert.rejects(evaluatePassMain(args('bad-binding'), { decide: async engine => ({ ...await deterministic(engine), modelInfo: {} }) }), /bound to this trained model hash/);
cases.push('refuse corrupt checkpoint, changed completed game and missing actual model binding');

const shortPath = resolve(temp, 'short-protocol.json'); await writeFile(shortPath, JSON.stringify({ ...protocol, max_game_plies: 1 }));
const shortArgs = args('truncated'); shortArgs[shortArgs.indexOf('--protocol') + 1] = shortPath;
assert.equal(await evaluatePassMain(shortArgs, { decide: deterministic }), 0);
const short = unseal(await read(resolve(temp, 'truncated/report.json')));
assert.equal(short.naturalGames, 0); assert.equal(short.truncatedGames, 4);
assert.equal(short.rewardAudit.naturallyCompleteAuditedEpisodes, 0);
const sharedDecide = async engine => ({ point: engine.getLegalMoves()[0]?.point ?? null, elapsedMs: 0.001, modelInfo: {} });
assert.equal(await evaluatePassMain(args('shared', 'shared-scenarios'), { decide: sharedDecide }), 0);
assert.equal(unseal(await read(resolve(temp, 'shared/report.json'))).scenarioFailures, 0);
cases.push('truncation never masquerades as natural completion; shared forced-PASS snapshots');

const training = resolve(temp, 'training-fixture');
for (const alias of ['easy', 'three-v4', 'three-v1', 'hex-v1']) {
  await mkdir(resolve(training, 'models', alias), { recursive: true });
  await writeFile(resolve(training, 'models', alias, 'candidate.json'), JSON.stringify({ alias }));
}
const campaignProtocol = resolve(temp, 'campaign-protocol.json');
await writeFile(campaignProtocol, JSON.stringify({ ...protocol, total_campaign_wall_seconds: 1500 }));
let stageCalls = 0;
const lightweightStage = async argv => {
  stageCalls++; const stageRoot = argv[argv.indexOf('--run-root') + 1]; await mkdir(stageRoot, { recursive: true });
  await writeFile(resolve(stageRoot, 'progress.json'), JSON.stringify({ status: 'COMPLETE', progress_units: 2 }));
  await writeFile(resolve(stageRoot, 'report.json'), JSON.stringify(sealed({ scenarioFailures: 0, candidateCertifiedBadPasses: 0, truncatedGames: 0, completeCases: 1 })));
  return 0;
};
const campaignArgs = ['--campaign-root', resolve(temp, 'campaign'), '--protocol', campaignProtocol,
  '--training-root', training, '--baseline-root', baselineRoot, '--candidate-root', candidateRoot];
assert.equal(await runPassCampaign([...campaignArgs, '--fault-after-stage-checkpoint'], { evaluate: lightweightStage }), 79);
assert.equal(stageCalls, 1);
assert.equal(await runPassCampaign(campaignArgs, { evaluate: lightweightStage }), 0);
assert.equal(stageCalls, 9, 'Completed stage must never be evaluated again after campaign resume');
assert.equal((await read(resolve(temp, 'campaign/progress.json'))).progress_units, 18);
assert.equal(await runPassCampaign(campaignArgs, { evaluate: lightweightStage }), 0); assert.equal(stageCalls, 9);
await writeFile(resolve(temp, 'campaign/PAUSE'), 'operator');
const secondCampaign = [...campaignArgs]; secondCampaign[secondCampaign.indexOf('--campaign-root') + 1] = resolve(temp, 'paused-campaign');
await mkdir(resolve(temp, 'paused-campaign')); await writeFile(resolve(temp, 'paused-campaign/STOP'), 'operator');
assert.equal(await runPassCampaign(secondCampaign, { evaluate: lightweightStage }), 75); assert.equal(stageCalls, 9);
cases.push('single-budget nine-stage campaign checkpoints/resumes without repeating completed stages and honors STOP');

const parentBytes = await readFile(new URL('../assets/research-ai/three-player-search-v4-round12.json', import.meta.url));
const parent = JSON.parse(parentBytes), parentPath = 'web/web前端/assets/research-ai/raw-v4-parent.json';
await writeFile(resolve(candidateRoot, parentPath), parentBytes);
const testWeights = [...parent.weights.map(value => value / parent.temperature), 100];
const rawV4 = { schema: 'lifeline-terminal-policy-linear17-candidate-v4', parent_alias: 'three-v4', weights: testWeights,
  runtime_spec: { weights: testWeights.slice(0, 16), passBias: 100, temperature: 1 },
  lineage: { parent_path: parentPath, parent_id: parent.id, parent_sha256: sha(parentBytes) } };
const rawEngine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: 'territory-v3' });
assert.equal(rawCandidateDecision(rawV4, rawEngine).point, null);
const actualProductRaw = await rawProductDecision(rawV4, rawEngine, candidateRoot);
assert.ok(Array.isArray(actualProductRaw.point)); assert.equal(actualProductRaw.auxiliaryRaw17Point, null);
assert.equal(actualProductRaw.learnedPassUsed, false); assert.equal(actualProductRaw.policy, 'unguarded-v4-search-trained-placement');
assert.equal(actualProductRaw.preservedSearchSha256, sha(JSON.stringify(parent.search)));
assert.equal(actualProductRaw.runtimeParametersSha256, sha(JSON.stringify({ weights: testWeights.slice(0, 16), passBias: 100, temperature: 1, rules_version: 'territory-v3' })));
await assert.rejects(rawProductDecision({ ...rawV4, lineage: { ...rawV4.lineage, parent_sha256: '0'.repeat(64) } }, rawEngine, candidateRoot), /parent hash mismatch/);
cases.push('revision 2 unguarded v4 product search binds exact placement coefficients, preserves search, retains unused raw17 PASS failure');

console.log(JSON.stringify({ schema: 'lifeline-pass-discipline-evaluation-tests-v1', status: 'PASS', cases, total: cases.length,
  fixtureRoot: temp, scope: 'bounded independent oracle/reward/recovery/runner tests; injected decisions are not trained-model or browser acceptance' }, null, 2));
