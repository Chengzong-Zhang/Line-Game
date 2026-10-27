import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateClientConfig } from '../tools/client-config.mjs';
import { prepareCandidate, verifyCandidate } from '../tools/prepare-candidate.mjs';
import { planTransfer, runTransfer } from '../../ci/transfer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaults = { apiBase: '', onlineEnabled: false, workerTimeoutMs: 15000 };
const digest = data => createHash('sha256').update(data).digest('hex');
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const maybeRead = async file => { try { return await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };

test('service origin validation normalizes HTTPS and rejects unusable or sensitive client settings', () => {
  assert.deepEqual(validateClientConfig(defaults), defaults);
  assert.equal(validateClientConfig({ ...defaults, onlineEnabled: true, apiBase: 'https://PLAY.example.com:443/' }).apiBase,
    'https://play.example.com');
  for (const apiBase of [
    '', 'http://play.example.com', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]',
    'https://localhost', 'https://game.local', 'https://game.invalid', 'https://game.test',
    'https://game.example', 'https://-bad.example.com', `https://${'x'.repeat(64)}.example.com`,
    'https://play.example.com/api/wechat', 'https://play.example.com:8443',
    'https://play.example.com?key=sensitive', 'https://user:sensitive@play.example.com',
    'https://play.example.com#sensitive', ' https://play.example.com', 'https://play.example.com\\path',
  ]) {
    assert.throws(() => validateClientConfig({ ...defaults, onlineEnabled: true, apiBase }),
      error => !error.message.includes('sensitive'));
  }
  assert.throws(() => validateClientConfig({ ...defaults, AppSecret: 'sensitive' }),
    error => !error.message.includes('sensitive'));
  assert.throws(() => validateClientConfig({ ...defaults, onlineEnabled: 'false' }));
  assert.throws(() => validateClientConfig({ ...defaults, workerTimeoutMs: 0 }));
  assert.throws(() => validateClientConfig({ ...defaults, apiBase: {} }));
});

test('online preparation requires an explicit origin and opt-in before writing a build', async () => {
  await assert.rejects(prepareCandidate({ apiBase: 'https://play.example.com' }), /explicit online/);
  await assert.rejects(prepareCandidate({ online: true }), /Invalid client config/);
});

test('online recipe is isolated, config-bound and transfer opt-in does not imply deployment', async t => {
  const parent = path.resolve(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(parent, 'lifeline-online-candidate-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), parent);
    assert.ok(path.basename(temporary).startsWith('lifeline-online-candidate-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const originalGame = await fs.readFile(path.join(root, 'dist/game.js'));
  const originalManifest = await fs.readFile(path.join(root, 'dist/build-manifest.json'));
  const originalLocal = await maybeRead(path.join(root, 'config.local.json'));
  // Documentation-only origin. Building and planning never contact it.
  const prepared = await prepareCandidate({
    outputBase: temporary, online: true, apiBase: 'https://play.example.com:443/',
  });
  const receiptFile = path.join(prepared.directory, 'candidate.json');
  const bundledManifest = path.join(prepared.importDirectory, 'dist/build-manifest.json');
  const receipt = prepared.receipt;
  assert.equal(receipt.schemaVersion, 4);
  assert.equal(receipt.profile, 'online');
  assert.equal(receipt.config.onlineEnabled, true);
  assert.equal(receipt.config.apiBase, 'https://play.example.com');
  assert.equal(receipt.acceptance.serviceConnectivity, 'NOT_VERIFIED');
  assert.deepEqual((await verifyCandidate(prepared.directory)).config, receipt.config);
  assert.deepEqual(await fs.readFile(path.join(root, 'dist/game.js')), originalGame);
  assert.deepEqual(await fs.readFile(path.join(root, 'dist/build-manifest.json')), originalManifest);
  assert.deepEqual(await maybeRead(path.join(root, 'config.local.json')), originalLocal);
  assert.notDeepEqual(await fs.readFile(path.join(prepared.importDirectory, 'dist/game.js')), originalGame);
  assert.ok(receipt.sourceHashes['wechat/minigame/tools/client-config.mjs']);

  let sdkLoads = 0;
  const loadSdk = () => { sdkLoads++; throw new Error('No SDK or network in this test'); };
  await assert.rejects(runTransfer({
    candidateDirectory: prepared.directory, action: 'preview', execute: true,
    privateKeyPath: path.join(temporary, 'nonexistent.key'),
  }, { loadSdk }), { code: 'ONLINE_TRANSFER_REQUIRES_EXPLICIT_FLAG' });
  const plan = await runTransfer({
    candidateDirectory: prepared.directory, action: 'preview', online: true,
    privateKeyPath: path.join(temporary, 'nonexistent.key'),
  }, { loadSdk });
  assert.equal(plan.profile, 'online');
  assert.equal(plan.apiBase, receipt.config.apiBase);
  assert.equal(plan.status, 'PLAN_ONLY_NO_KEY_READ_NO_NETWORK');
  assert.equal(plan.serviceConnectivity, 'NOT_VERIFIED');
  assert.equal(sdkLoads, 0);

  await writeJson(receiptFile, { ...receipt, config: defaults });
  await assert.rejects(verifyCandidate(prepared.directory), /configuration differs/);
  await writeJson(receiptFile, { ...receipt, profile: 'offline' });
  await assert.rejects(verifyCandidate(prepared.directory), /offline core/);
  for (const schemaVersion of [2, 3]) {
    await writeJson(receiptFile, { ...receipt, schemaVersion });
    await assert.rejects(verifyCandidate(prepared.directory), /offline|Unexpected package/);
  }
  await writeJson(receiptFile, receipt);

  const originalBundledManifest = await fs.readFile(bundledManifest);
  const manifest = JSON.parse(originalBundledManifest);
  async function rehashManifest(value) {
    await writeJson(bundledManifest, value);
    const data = await fs.readFile(bundledManifest);
    await writeJson(receiptFile, { ...receipt, files: receipt.files.map(file =>
      file.path === 'dist/build-manifest.json' ? { ...file, bytes: data.length, sha256: digest(data) } : file) });
  }
  await rehashManifest({ ...manifest, config: defaults });
  await assert.rejects(verifyCandidate(prepared.directory), /configuration differs/);
  await rehashManifest({ ...manifest, outputs: manifest.outputs.slice(1) });
  await assert.rejects(verifyCandidate(prepared.directory), /runtime manifest mismatch/);
  await fs.writeFile(bundledManifest, originalBundledManifest);
  await writeJson(receiptFile, { ...receipt, mainPackageBytes: receipt.mainPackageBytes + 1 });
  await assert.rejects(verifyCandidate(prepared.directory), /package sizes mismatch/);
  await writeJson(receiptFile, receipt);
  assert.equal((await planTransfer({ candidateDirectory: prepared.directory, online: true })).profile, 'online');
});
