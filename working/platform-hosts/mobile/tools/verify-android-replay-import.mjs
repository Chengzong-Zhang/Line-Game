import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(toolsDirectory, 'verify-android-host.mjs');
const repositoryRoot = path.resolve(toolsDirectory, '..', '..');
const result = spawnSync(process.execPath, [runner, '--only', 'replay-import'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
  timeout: 255_000,
  windowsHide: true,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(`verify-android-replay-import: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
