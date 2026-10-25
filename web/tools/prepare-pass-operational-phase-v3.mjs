import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOperationalPhaseV3, auditOperationalPhaseV3 } from './pass-operational-phase-v3.mjs';
import { passCompositeInput } from './pass-discipline-composite-input-v5.mjs';
import { atomic, root } from './neural-posttraining-data-v2.mjs';
export async function preparePassOperationalPhaseV3({ sourceCampaign, phaseRoot }) {
  sourceCampaign = resolve(sourceCampaign); phaseRoot = resolve(phaseRoot);
  const originalJob = JSON.parse(await readFile(resolve(sourceCampaign, 'job.json')));
  const option = name => originalJob.command[originalJob.command.indexOf(name) + 1];
  const composite = await passCompositeInput(option('--composite-manifest'));
  await prepareOperationalPhaseV3({ sourceCampaign, phaseRoot });
  const phasePath = resolve(phaseRoot, 'operational-phase-v3.json'), phase = await auditOperationalPhaseV3(phasePath);
  const file = name => resolve(root, 'web/tools', name);
  const job = { ...originalJob, run_root: phaseRoot,
    command: [process.execPath, file('run-pass-discipline-campaign-v3.mjs'), '--campaign-root', phaseRoot,
      '--protocol', resolve(phaseRoot, 'protocol.json'), '--baseline-root', option('--baseline-root'),
      '--candidate-root', option('--candidate-root'), '--composite-manifest', composite.manifestPath, '--phase-protocol', phasePath],
    identity_files: [...new Set([...originalJob.identity_files, ...Object.keys(phase.evidenceHashes),
      ...['run-pass-discipline-campaign-v3.mjs', 'pass-operational-phase-v3.mjs', 'prepare-pass-operational-phase-v3.mjs',
        'launch-pass-operational-phase-v3.ps1', 'recover-pass-operational-phase-at-login-v3.ps1'].map(file)])],
    absolute_deadline_epoch_ms: phase.phaseDeadlineEpochMs,
    max_wall_seconds: Math.max(1, Math.floor((phase.phaseDeadlineEpochMs - Date.now()) / 1000)), worker_wall_seconds: 120 };
  await atomic(resolve(phaseRoot, 'job.json'), job);
  return { status: 'PREPARED_NOT_STARTED', phaseRoot, phaseIdentity: phase.identity,
    oldBudgetStatus: phase.oldBudgetStatus, phaseDeadlineEpochMs: phase.phaseDeadlineEpochMs,
    maxWallSeconds: job.max_wall_seconds, workerWallSeconds: 120,
    carriedNaturalGames: phase.copiedCompletedNaturalGames, carriedHexActions: phase.copiedActiveHexActions };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
  try {
    if (!args.includes('--source-campaign') || !args.includes('--phase-root')) throw Error('Use --source-campaign --phase-root');
    console.log(JSON.stringify(await preparePassOperationalPhaseV3({ sourceCampaign: option('--source-campaign'), phaseRoot: option('--phase-root') })));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
