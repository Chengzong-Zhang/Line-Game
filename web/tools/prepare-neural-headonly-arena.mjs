// Prepare immutable supervised jobs without starting them. One wall budget
// covers DEV, checkpoint selection, FINAL and their independent verification.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArenaModels } from './neural-posttraining-arena-v2.mjs';
import { sha } from './neural-posttraining-data.mjs';
import { PARENTS, STAGES } from './select-neural-headonly-stage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = resolve(root, 'local_artifacts/neural-terminal-headonly-r3-20261021');
const protocol = resolve(root, 'docs/verification/ai-improvement-round2-20261021/NEURAL_HEADONLY_R3_PROTOCOL.md');
const command = process.argv[2];
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const put = (p, value) => writeFile(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
try {
  assert.ok(['dev', 'final', 'verify-final'].includes(command));
  const arena = resolve(base, command === 'dev' ? 'dev' : 'final');
  const run = command === 'verify-final' ? resolve(base, 'final-verification') : arena;
  await mkdir(run, { recursive: true });
  const campaignPath = resolve(base, 'arena-budget.json');
  let campaign;
  try { campaign = await json(campaignPath); }
  catch (error) {
    if (error.code !== 'ENOENT' || command !== 'dev') throw error;
    campaign = { startedEpochMs: Date.now(), maximumSeconds: 1800, deadlineEpochMs: Date.now() + 1800000 };
    await put(campaignPath, campaign);
  }
  const remaining = Math.floor((campaign.deadlineEpochMs - Date.now()) / 1000);
  assert.ok(remaining > 0, 'Frozen total arena wall budget exhausted');
  const sourceManifest = resolve(base, 'training/candidate-manifest.json');
  const sourceBytes = await readFile(sourceManifest), source = JSON.parse(sourceBytes);
  assert.deepEqual(source.models.map(m => m.id).sort(), PARENTS.flatMap(p => STAGES.map(s => `${p}-terminal-head-r3-s${s}`)).sort());
  const candidates = resolve(arena, 'candidate-manifest.json');
  if (command === 'dev') {
    const models = PARENTS.flatMap(parent => STAGES.map(stage => {
      const spec = structuredClone(source.models.find(m => m.id === `${parent}-terminal-head-r3-s${stage}`));
      assert.equal(spec.parent_model_id, parent);
      spec.asset = resolve(dirname(sourceManifest), spec.asset);
      return spec;
    }));
    await put(candidates, { schema: 'lifeline-web-neural-distillation-candidates-v1', rulesVersion: 'territory-v2',
      source_manifest: sourceManifest, source_manifest_sha256: sha(sourceBytes), models });
  } else {
    const selection = await json(resolve(arena, 'selection-receipt.json'));
    assert.equal(selection.status, 'PASS_FIXED_DEV_STAGE_SELECTION');
    assert.equal(selection.sourceManifestSha256, sha(sourceBytes));
    assert.equal(selection.selectedManifestSha256, sha(await readFile(candidates)));
  }
  const config = resolve(root, `web/tools/configs/neural-headonly-r3-${command === 'dev' ? 'dev' : 'final'}.json`);
  const loaded = await loadArenaModels(candidates);
  const files = [protocol, campaignPath, sourceManifest, config,
    'web/tools/neural-posttraining-arena-v2.mjs', 'web/tools/neural-posttraining-data.mjs',
    'web/tools/verify-neural-posttraining-v2.mjs', 'web/tools/run-neural-arena-verification.mjs',
    'web/tools/select-neural-headonly-stage.mjs', 'web/tools/prepare-neural-headonly-arena.mjs',
    'web/web前端/GameEngine.js', 'web/web前端/AIEngine.js', 'web/web前端/ResearchAI.js', 'web/web前端/ModelFreeAI.js',
    ...Object.keys(loaded.source_hashes)];
  if (command !== 'dev') files.push(resolve(arena, 'selection-receipt.json'), 'web/tools/assess-neural-headonly-r3.mjs');
  if (command === 'verify-final') files.push(resolve(arena, 'identity.json'), resolve(arena, 'checkpoint.json'), resolve(arena, 'summary.json'));
  const worker = command === 'verify-final' ? 'web/tools/run-neural-arena-verification.mjs' : 'web/tools/neural-posttraining-arena-v2.mjs';
  const args = command === 'verify-final' ? ['--run-root', run, '--arena-root', arena, '--candidates', candidates]
    : ['--run-root', run, '--config', config, '--candidates', candidates, '--max-seconds', '300'];
  const job = { schema: 'lifeline-supervised-job-v1', run_root: run, cwd: root,
    command: [process.execPath, '--unhandled-rejections=strict', resolve(root, worker), ...args],
    identity_files: [...new Set(files.map(p => resolve(root, p)))], max_wall_seconds: remaining,
    worker_wall_seconds: command === 'verify-final' ? Math.min(540, remaining) : Math.min(330, remaining),
    max_restarts: 3, max_no_progress_exits: 3 };
  await put(resolve(run, 'job.json'), job);
  console.log(JSON.stringify({ status: 'PREPARED_NOT_STARTED', command, run, remainingSeconds: remaining,
    plannedGames: loaded.candidates.length * JSON.parse(await readFile(config)).prefixesPerSize * 6 }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
