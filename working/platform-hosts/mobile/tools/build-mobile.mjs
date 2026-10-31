import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimeBuildArgs } from './runtime-config.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selection = parseRuntimeBuildArgs(process.argv.slice(2));
const configArgs = ['--environment', selection.environment];
if (selection.runtimeConfig) configArgs.push('--runtime-config', selection.runtimeConfig);
const steps = [
  ['tools/build-web.mjs', configArgs],
  ['node_modules/vite/bin/vite.js', ['build', '--config', 'vite.config.mjs']],
  ['node_modules/vite/bin/vite.js', ['build', '--config', 'vite-back-bootstrap.config.mjs']],
  ['tools/sync-harmony-web.mjs', []],
  ['tools/finalize-build-receipt.mjs', []],
];
for (const [script, args] of steps) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: mobileRoot, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
