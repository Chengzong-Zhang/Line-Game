// Operational recovery only; the unchanged runner owns all game checkpoints.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPassCampaignV2 } from './run-pass-discipline-campaign-v2.mjs';
import { atomic } from './neural-posttraining-data-v2.mjs';
export async function mirrorCampaignStatus(campaignRoot, mirrorRoot) {
  for (const name of ['checkpoint.json', 'progress.json', 'completion-receipt.json']) {
    try { await atomic(resolve(mirrorRoot, name), JSON.parse(await readFile(resolve(campaignRoot, name)))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function recoverPassCampaignWorkerV3(args, { run = runPassCampaignV2 } = {}) {
  const index = args.indexOf('--mirror-root');
  if (index < 0 || !args.includes('--campaign-root')) throw Error('Use --mirror-root and the original campaign arguments');
  const mirror = resolve(args[index + 1]), runnerArgs = args.filter((_, i) => i !== index && i !== index + 1);
  const campaign = resolve(runnerArgs[runnerArgs.indexOf('--campaign-root') + 1]);
  if (campaign === mirror) throw Error('Recovery supervision must retain the original supervisor evidence separately');
  let pending = false, failure;
  const update = async () => { if (pending) return; pending = true;
    try { await mirrorCampaignStatus(campaign, mirror); } catch (error) { failure = error; } finally { pending = false; } };
  await update();
  const timer = setInterval(update, 200);
  try { const code = await run(runnerArgs); if (failure) throw failure; return code; }
  finally { clearInterval(timer); while (pending) await new Promise(done => setTimeout(done, 10)); await mirrorCampaignStatus(campaign, mirror); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await recoverPassCampaignWorkerV3(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === 'EADDRINUSE' ? 76 : 78; }
}
