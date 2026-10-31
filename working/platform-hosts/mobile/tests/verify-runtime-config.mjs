import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalRuntimeConfig, createMobileCsp, loadRuntimeConfig, parseRuntimeBuildArgs, validateRuntimeConfig } from '../tools/runtime-config.mjs';

const valid = { environment: 'staging', apiBaseUrl: 'https://staging.example.test', websocketUrl: 'wss://staging.example.test/ws', trainingContributionUrl: 'https://staging.example.test/api/training/contributions' };
assert.equal(validateRuntimeConfig(valid, 'staging'), valid);
const stagingCsp = createMobileCsp(valid, 'staging');
assert.match(stagingCsp, /connect-src 'self' https:\/\/staging\.example\.test wss:\/\/staging\.example\.test/);
assert.doesNotMatch(stagingCsp, /(?:https:|wss:)\s*;/, 'staging CSP does not admit a wildcard network scheme');
for (const [key, value] of Object.entries({
  apiBaseUrl: 'https://localhost', websocketUrl: 'wss://host.invalid/path/ws',
  trainingContributionUrl: 'https://host.invalid/api/training/contributions?x=1',
})) assert.throws(() => validateRuntimeConfig({ ...valid, [key]: value }, 'staging'));
for (const [key, value] of [
  ['apiBaseUrl', "https://staging.example.test; script-src 'unsafe-inline'"],
  ['apiBaseUrl', 'https://staging.example.test"; object-src *'],
  ['websocketUrl', "wss://staging.example.test/ws; connect-src *"],
  ['websocketUrl', 'wss://staging.example.test/ws"; script-src https:'],
  ['trainingContributionUrl', "https://staging.example.test/api/training/contributions; img-src *"],
  ['trainingContributionUrl', 'https://staging.example.test/api/training/contributions"; connect-src https:'],
]) assert.throws(() => createMobileCsp({ ...valid, [key]: value }, 'staging'), undefined,
  `staging runtime config cannot inject CSP delimiters through ${key}`);
for (const value of [
  'https://127.0.0.1', 'https://0.0.0.0', 'https://localhost.',
  'https://[::1]', 'https://[::]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:0.0.0.0]',
  'https://user:pass@host.test', 'https://host.test/?q=1', 'https://host.test/#f',
  'https://host.test/#', 'wss://host.test/ws?',
]) {
  assert.throws(() => validateRuntimeConfig({ ...valid, apiBaseUrl: value }, 'staging'));
}
assert.throws(() => validateRuntimeConfig({ ...valid, extra: true }, 'staging'));
assert.throws(() => validateRuntimeConfig({ ...valid, environment: 'release' }, 'staging'));
assert.deepEqual(parseRuntimeBuildArgs([]), { environment: 'release', runtimeConfig: null });
assert.deepEqual(parseRuntimeBuildArgs(['--environment', 'staging', '--runtime-config', 'config/runtime.staging.json']), { environment: 'staging', runtimeConfig: 'config/runtime.staging.json' });
for (const args of [
  ['--unknown', 'x'], ['--environment', 'release', '--environment', 'staging'],
  ['--environment', 'staging'], ['--runtime-config', '../outside.json'],
  ['--runtime-config', 'config/runtime.release.json'],
]) assert.throws(() => parseRuntimeBuildArgs(args));

const root = await mkdtemp(path.join(os.tmpdir(), 'lifeline-runtime-'));
try {
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config/runtime.staging.json'), JSON.stringify(valid));
  const loaded = await loadRuntimeConfig({ mobileRoot: root, args: ['--environment', 'staging', '--runtime-config', 'config/runtime.staging.json'] });
  assert.equal(loaded.configRelativePath, 'config/runtime.staging.json');
  const raw = await readFile(loaded.configPath);
  assert.equal(loaded.rawSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(loaded.canonicalSha256, createHash('sha256').update(canonicalRuntimeConfig(valid)).digest('hex'));
  await assert.rejects(loadRuntimeConfig({ mobileRoot: root, args: ['--environment', 'staging', '--runtime-config', '../outside.json'] }));
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Runtime config validation checks passed.');
