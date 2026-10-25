import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planTransfer, runTransfer } from '../transfer.mjs';
import { prepareCandidate } from '../../minigame/tools/prepare-candidate.mjs';
import { PACKAGE_FILES } from '../../minigame/tools/model-packaging.mjs';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'lifeline-ci-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('lifeline-ci-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const prepared = await prepareCandidate({ outputBase: path.join(root, 'candidates') });
  const candidateDirectory = prepared.directory;
  const privateKeyPath = path.join(root, 'mock-only.key');
  await fs.writeFile(privateKeyPath, 'FAKE_UPLOAD_KEY_FOR_MOCK_ONLY');
  return { root, candidateDirectory, privateKeyPath, version: prepared.receipt.version, outputBase: path.join(root, 'transfers') };
}

test('dry planning never loads the SDK or accesses a supplied key path', async t => {
  const f = await fixture(t);
  let loads = 0;
  const result = await runTransfer({ action: 'upload', candidateDirectory: f.candidateDirectory,
    privateKeyPath: path.join(f.root, 'does-not-exist.key') }, { loadSdk: () => { loads++; throw new Error('must not load'); } });
  assert.equal(loads, 0);
  assert.equal(result.status, 'PLAN_ONLY_NO_KEY_READ_NO_NETWORK');
  assert.equal(result.type, 'miniGame');
  assert.equal(result.files.length, PACKAGE_FILES.length + 1);
  assert.equal(JSON.stringify(result).includes('does-not-exist.key'), false);
});

test('modified candidate files stop before SDK construction or a remote request', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.candidateDirectory, 'project/dist/game.js'), '// changed');
  let loads = 0;
  await assert.rejects(runTransfer({ ...f, action: 'upload', execute: true },
    { outputBase: f.outputBase, loadSdk: () => { loads++; } }), /differ from the frozen receipt/);
  assert.equal(loads, 0);
});

test('an account mismatch in the downloaded key filename stops before key access or SDK loading', async t => {
  const f = await fixture(t);
  let loads = 0;
  // Deliberately nonexistent: the account mismatch must be rejected before stat.
  const privateKeyPath = path.join(f.root, 'private.wx0000000000000000.key');
  await assert.rejects(runTransfer({ ...f, privateKeyPath, action: 'preview', execute: true },
    { outputBase: f.outputBase, loadSdk: () => { loads++; throw new Error('must not load'); } }),
    { code: 'KEY_FILENAME_APPID_MISMATCH' });
  assert.equal(loads, 0);
  await assert.rejects(fs.stat(f.outputBase), { code: 'ENOENT' });
});

test('missing key and a key placed inside the candidate are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(runTransfer({ candidateDirectory: f.candidateDirectory, action: 'preview', execute: true }),
    { code: 'ABSOLUTE_KEY_PATH_REQUIRED' });
  const unsafeKey = path.join(f.candidateDirectory, 'mock-only.key');
  await fs.copyFile(f.privateKeyPath, unsafeKey);
  await assert.rejects(runTransfer({ ...f, privateKeyPath: unsafeKey, action: 'upload', execute: true }),
    { code: 'KEEP_KEY_OUTSIDE_REPOSITORY_AND_CANDIDATE' });
  await assert.rejects(planTransfer({ ...f, robot: 31 }), { code: 'INVALID_ROBOT' });
  await assert.rejects(planTransfer({ ...f, action: 'publish' }), { code: 'INVALID_ACTION' });
});

test('mock upload uses the frozen copy and records only code upload, never publication', async t => {
  const f = await fixture(t);
  let calls = 0;
  let projectArgs;
  const before = await fs.readFile(path.join(f.candidateDirectory, 'project/dist/game.js'));
  const sdk = {
    Project: class { constructor(args) { projectArgs = args; } },
    async upload(args) {
      calls++;
      assert.equal(args.version, f.version);
      assert.equal(args.setting.es6, false);
      assert.equal(args.setting.minify, false);
      assert.equal(projectArgs.type, 'miniGame');
      assert.equal(projectArgs.privateKeyPath, f.privateKeyPath);
      assert.notEqual(projectArgs.projectPath, path.join(f.candidateDirectory, 'project'));
      assert.deepEqual(await fs.readFile(path.join(projectArgs.projectPath, 'dist/game.js')), before);
      await fs.writeFile(path.join(projectArgs.projectPath, 'sdk-created-file.txt'), 'fixture compiler side effect');
      return { subPackageInfo: [{ name: '__APP__', size: 120000 }], privateKey: 'must-not-be-recorded' };
    },
  };
  const result = await runTransfer({ ...f, action: 'upload', execute: true }, { outputBase: f.outputBase, loadSdk: async () => sdk });
  assert.equal(calls, 1);
  assert.equal(result.status, 'CODE_UPLOADED_EXPERIENCE_NOT_CONFIGURED');
  assert.equal(result.experienceVersionConfigured, false);
  assert.equal(result.published, false);
  assert.deepEqual(result.packageInfo, [{ name: '__APP__', size: 120000 }]);
  const receipt = await fs.readFile(path.join(result.directory, 'receipt.json'), 'utf8');
  assert.equal(receipt.includes('must-not-be-recorded'), false);
  assert.equal(receipt.includes(f.privateKeyPath.replaceAll('\\', '\\\\')), false);
  assert.deepEqual(await fs.readFile(path.join(f.candidateDirectory, 'project/dist/game.js')), before);
  await assert.rejects(fs.stat(path.join(f.candidateDirectory, 'project/sdk-created-file.txt')), { code: 'ENOENT' });
});

test('mock preview saves a QR artifact and does not claim phone acceptance', async t => {
  const f = await fixture(t);
  const sdk = { Project: class {}, async preview(args) {
    assert.equal(args.qrcodeFormat, 'image');
    await fs.writeFile(args.qrcodeOutputDest, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64'));
    return { subPackageInfo: [{ name: '__FULL__', size: 120001 }] };
  } };
  const result = await runTransfer({ ...f, action: 'preview', execute: true }, { outputBase: f.outputBase, loadSdk: async () => sdk });
  assert.equal(result.status, 'PREVIEW_GENERATED_NOT_DEVICE_VERIFIED');
  assert.ok(result.qr.bytes > 8);
  assert.equal(result.qr.sha256.length, 64);
  assert.equal(result.published, false);
});

test('a resolved preview without a QR keeps the uncertain local result and never retries', async t => {
  const f = await fixture(t);
  let calls = 0;
  const sdk = { Project: class {}, async preview() { calls++; return {}; } };
  let error;
  try { await runTransfer({ ...f, action: 'preview', execute: true }, { outputBase: f.outputBase, loadSdk: async () => sdk }); }
  catch (e) { error = e; }
  assert.ok(error?.receiptDirectory);
  assert.equal(calls, 1);
  const receipt = await readJson(path.join(error.receiptDirectory, 'receipt.json'));
  assert.equal(receipt.status, 'SDK_COMPLETED_LOCAL_RESULT_INCOMPLETE');
  assert.equal(receipt.sdkResolved, true);
  assert.equal(receipt.published, false);
});

test('SDK rejection keeps a safe error code without persisting its request or key contents', async t => {
  const f = await fixture(t);
  let calls = 0;
  const sdk = { Project: class {}, async upload() {
    calls++;
    throw Object.assign(new Error('fixture-sensitive-request-body'), { errCode: -20008, request: { privateKey: 'fixture-sensitive-key' } });
  } };
  let error;
  try { await runTransfer({ ...f, action: 'upload', execute: true }, { outputBase: f.outputBase, loadSdk: async () => sdk }); }
  catch (e) { error = e; }
  assert.equal(calls, 1);
  assert.equal(error.code, -20008);
  const text = await fs.readFile(path.join(error.receiptDirectory, 'receipt.json'), 'utf8');
  assert.equal(text.includes('fixture-sensitive'), false);
  assert.equal(text.includes('FAKE_UPLOAD_KEY'), false);
  assert.equal(JSON.parse(text).status, 'TRANSFER_FAILED_OR_REMOTE_OUTCOME_UNCONFIRMED');
});
