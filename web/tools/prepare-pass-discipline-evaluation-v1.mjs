import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, atomic } from './neural-posttraining-data-v2.mjs';
import { passCompositeInput, assertPassCompositeProtocol } from './pass-discipline-composite-input-v5.mjs';

export async function preparePassEvaluation(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  if (!option('--run-root') || !option('--protocol') || !option('--baseline-root')) throw Error('Use --run-root --protocol --baseline-root');
  const runRoot = resolve(option('--run-root')), protocol = resolve(option('--protocol')),
    baseline = resolve(option('--baseline-root')), candidateRoot = resolve(option('--candidate-root', root));
  const mode = option('--mode', 'games'), alias = option('--parent', 'easy'), candidate = option('--candidate');
  if (!['games', 'cost-pilot', 'scenarios', 'shared-scenarios', 'campaign'].includes(mode)
    || !['easy', 'three-v4', 'three-v1', 'hex-v1'].includes(alias)) throw Error('Unknown evaluation mode/parent');
  const manifestPath = option('--composite-manifest');
  if (manifestPath && option('--training-root')) throw Error('Choose exactly one explicit composite or single training run');
  if (!['cost-pilot', 'shared-scenarios', 'campaign'].includes(mode) && !candidate && !manifestPath) throw Error('A trained candidate is required');
  if (mode === 'campaign' && !option('--training-root') && !manifestPath) throw Error('Campaign preparation requires --training-root or --composite-manifest');
  let names = []; try { names = await readdir(runRoot); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (names.length) throw Error('Evaluation preparation never overwrites an existing run');
  const protocolBytes = await readFile(protocol), definition = JSON.parse(protocolBytes);
  if (!['lifeline-pass-discipline-acceptance-v1', 'lifeline-pass-discipline-acceptance-v2'].includes(definition.schema)) throw Error('Invalid acceptance protocol');
  const wall = Number(option('--wall-seconds', mode === 'cost-pilot' ? '60' : '1500'));
  if (!Number.isFinite(wall) || wall <= 0 || wall > definition.total_campaign_wall_seconds) throw Error('Invalid evaluation wall budget');
  const composite = manifestPath ? await passCompositeInput(manifestPath) : null;
  if (composite) assertPassCompositeProtocol(protocolBytes);
  if (composite && mode === 'campaign' && wall !== 1500) throw Error('The formal composite campaign has one frozen 1500-second budget');
  await mkdir(runRoot, { recursive: true });
  const protocolCopy = resolve(runRoot, 'protocol.json'); await writeFile(protocolCopy, protocolBytes);
  const runner = resolve(root, mode === 'campaign' ? 'web/tools/run-pass-discipline-campaign-v1.mjs' : 'web/tools/evaluate-pass-discipline-v1.mjs');
  const command = mode === 'campaign' ? [process.execPath, runner, '--campaign-root', runRoot, '--protocol', protocolCopy,
    ...(composite ? ['--composite-manifest', composite.manifestPath] : ['--training-root', resolve(option('--training-root'))]),
    '--baseline-root', baseline, '--candidate-root', candidateRoot]
    : [process.execPath, runner, '--run-root', runRoot, '--protocol', protocolCopy,
    '--baseline-root', baseline, '--candidate-root', candidateRoot, '--mode', mode, '--parent', alias,
    '--max-new-units', '10000', '--max-seconds', '55', ...(candidate ? ['--candidate', resolve(candidate)] : []),
    ...(composite ? ['--composite-manifest', composite.manifestPath] : [])];
  const job = { schema: 'lifeline-supervised-job-v1', run_root: runRoot, cwd: root, command,
    identity_files: [runner, fileURLToPath(import.meta.url), protocolCopy, ...(candidate ? [resolve(candidate)] : []),
      ...Object.keys(composite?.evidenceHashes ?? {}),
      ...(mode === 'campaign' ? [resolve(root, 'web/tools/evaluate-pass-discipline-v1.mjs'),
        ...(!composite ? ['easy', 'three-v4', 'three-v1', 'hex-v1'].map(parent => resolve(option('--training-root'), 'models', parent, 'candidate.json')) : [])] : [])],
    max_wall_seconds: wall, worker_wall_seconds: 60, max_restarts: 3, max_no_progress_exits: 3,
    poll_ms: 200, stop_grace_seconds: 3 };
  await atomic(resolve(runRoot, 'job.json'), job);
  return { status: 'PREPARED_NOT_STARTED', mode, alias, runRoot, wallSeconds: wall,
    command: [process.execPath, resolve(root, 'web/tools/supervise-three-player-job.mjs'), '--job', resolve(runRoot, 'job.json')],
    pause: resolve(runRoot, 'PAUSE'), stop: resolve(runRoot, 'STOP'),
    resume: 'Remove the operator marker when authorized; rerun the printed command with --resume. Checkpoint/source/config hashes remain authoritative.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preparePassEvaluation(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 78; }
}
