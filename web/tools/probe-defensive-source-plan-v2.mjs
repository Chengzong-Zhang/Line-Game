// Independently supervised cost prefilter; accepted probes are never labels.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { probeWarmstartPositions, validateWarmstartProtocol } from './prepare-defensive-warmstart-v2.mjs';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
try {
  const input = option('--input'), configPath = option('--protocol'), runRoot = option('--run-root');
  if (!input || !configPath || !runRoot) throw Error('Expected --input, --protocol and --run-root');
  const config = validateWarmstartProtocol(JSON.parse(await readFile(resolve(configPath), 'utf8')));
  const plans = JSON.parse(await readFile(resolve(input), 'utf8'));
  if (!Array.isArray(plans) || !plans.length || new Set(plans.map(row => row.id)).size !== plans.length)
    throw Error('Empty or duplicate frozen source plan');
  const result = await probeWarmstartPositions(plans, config, { runRoot: resolve(runRoot),
    maxUnits: Number(option('--max-new-units', '16')), maxSeconds: Number(option('--max-seconds', '25')),
    maxNodes: Number(option('--max-nodes', '20000')), timeMs: Number(option('--time-ms', '1500')) });
  console.log(JSON.stringify({ status: result.status, completed: result.completed, total: result.total }));
  process.exitCode = result.code;
} catch (error) { console.error(error.stack); process.exitCode = error.code === 'EADDRINUSE' ? 76 : 78; }
