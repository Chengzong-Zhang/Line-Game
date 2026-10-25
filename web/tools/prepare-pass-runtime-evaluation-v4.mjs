import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeEvaluationV4, auditRuntimeEvaluationV4 } from './pass-runtime-evaluation-v4.mjs';
import { passCompositeInput } from './pass-discipline-composite-input-v5.mjs';
import { sourceInventory } from './evaluate-pass-discipline-v1.mjs';
import { atomic, root, sha } from './neural-posttraining-data-v2.mjs';
export async function preparePassRuntimeEvaluationV4({ previousCampaign, previousRuntimeSnapshot, phaseRoot, protocolPath }) {
  previousCampaign = resolve(previousCampaign); phaseRoot = resolve(phaseRoot);
  const oldJob = JSON.parse(await readFile(resolve(previousCampaign, 'job.json')));
  const option = name => oldJob.command[oldJob.command.indexOf(name) + 1];
  const composite = await passCompositeInput(option('--composite-manifest'));
  const frozenSources = { ...await sourceInventory(option('--baseline-root')), ...await sourceInventory(option('--candidate-root')),
    ...composite.evidenceHashes };
  const file = name => resolve(root, 'web/tools', name);
  frozenSources[file('evaluate-pass-discipline-v1.mjs')] = sha(await readFile(file('evaluate-pass-discipline-v1.mjs')));
  await prepareRuntimeEvaluationV4({ previousCampaign, previousRuntimeSnapshot, phaseRoot, protocolPath, frozenSources });
  const phasePath = resolve(phaseRoot, 'runtime-evaluation-v4.json'), phase = await auditRuntimeEvaluationV4(phasePath);
  const job = { ...oldJob, run_root: phaseRoot,
    command: [process.execPath, file('run-pass-discipline-campaign-v4.mjs'), '--campaign-root', phaseRoot,
      '--protocol', resolve(phaseRoot, 'protocol.json'), '--baseline-root', option('--baseline-root'),
      '--candidate-root', option('--candidate-root'), '--composite-manifest', composite.manifestPath, '--phase-protocol', phasePath],
    identity_files: [...new Set([...Object.keys(composite.evidenceHashes), ...Object.keys(phase.evidenceHashes),
      ...['evaluate-pass-discipline-v1.mjs', 'run-pass-discipline-campaign-v4.mjs', 'pass-runtime-evaluation-v4.mjs',
        'prepare-pass-runtime-evaluation-v4.mjs', 'launch-pass-operational-phase-v3.ps1', 'recover-pass-operational-phase-at-login-v3.ps1'].map(file)])],
    absolute_deadline_epoch_ms: phase.phaseDeadlineEpochMs,
    max_wall_seconds: Math.max(1, Math.floor((phase.phaseDeadlineEpochMs - Date.now()) / 1000)), worker_wall_seconds: 120 };
  await atomic(resolve(phaseRoot, 'job.json'), job);
  return { status: 'PREPARED_NOT_STARTED', phaseRoot, identity: phase.identity, maxWallSeconds: job.max_wall_seconds,
    absoluteDeadlineEpochMs: phase.phaseDeadlineEpochMs, allPreviousGamesExcluded: true, newRequiredNaturalGames: 34 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  try {
    for (const name of ['--previous-campaign', '--previous-runtime-snapshot', '--phase-root', '--protocol']) if (!args.includes(name)) throw Error('Missing ' + name);
    console.log(JSON.stringify(await preparePassRuntimeEvaluationV4({ previousCampaign: option('--previous-campaign'),
      previousRuntimeSnapshot: option('--previous-runtime-snapshot'), phaseRoot: option('--phase-root'), protocolPath: option('--protocol') })));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
