// Scoped checks for the aligned diagnostic candidate. Release preflight and
// the frozen r16 verification chain remain separate commands.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentWebSyncClosure } from './current-web-sync-closure.mjs';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async name => JSON.parse(await readFile(path.join(mobile, 'config', name), 'utf8'));
await auditCurrentWebSyncClosure({ sourceWebRoot: path.resolve(mobile, '../web/web前端'),
  syncManifest: await readJson('aligned-sync-manifest.json'),
  runtimeManifest: await readJson('aligned-runtime-manifest.json'), mode: 'package' });
console.log('PASS aligned source closure');
const tests = [
  'tests/verify-replay-import-client.mjs', 'tests/verify-tutorial-host.mjs',
  'tests/verify-mobile-tutorial-app-integration.mjs',
  'tests/verify-move-haptics.mjs', 'tests/verify-mobile-app-haptics-integration.mjs',
  'tests/verify-native-platform-flush.mjs', 'tests/verify-harmony-native-bridge.mjs',
  'tests/verify-credential-authority.mjs', 'tests/verify-mobile-credential-app.mjs',
  'tests/verify-dual-session-authority.mjs', 'tests/verify-session-integration.mjs',
  'tests/verify-mobile-shared-action-migration.mjs',
  '../web/web前端/tests/verify-replay-codec.mjs',
  '../web/web前端/tests/verify-topology-round5-replay-ui.mjs',
];
for (const test of tests) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', test], { cwd: mobile, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Alignment check failed: ${test}`);
}
console.log('PASS scoped alignment checks; native devices, release signing and real services NOT RUN');
