import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProject, prepareCandidate, verifyCandidate } from '../tools/prepare-candidate.mjs';
import { PACKAGE_FILES } from '../tools/model-packaging.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(root, '../..');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function temporaryDirectory(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'lifeline-candidate-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('lifeline-candidate-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  const directory = await temporaryDirectory(t);
  const fixtureRepo = path.join(directory, 'repo');
  const fixtureRoot = path.join(fixtureRepo, 'wechat/minigame');
  const manifest = await readJson(path.join(root, 'dist/build-manifest.json'));
  const inputs = new Set([...Object.keys(manifest.sourceHashes), ...[
    'game.json', 'project.config.json', 'config.example.json', 'package.json', 'package-lock.json',
    'tools/build.mjs', 'tools/client-config.mjs', 'tools/prepare-candidate.mjs', 'tools/model-packaging.mjs', 'tools/stage-models.mjs',
  ].map(name => `wechat/minigame/${name}`)]);
  for (const relative of inputs) {
    const destination = path.join(fixtureRepo, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repo, relative), destination);
  }
  await fs.cp(path.join(root, 'dist'), path.join(fixtureRoot, 'dist'), { recursive: true });
  return { root: fixtureRoot, repo: fixtureRepo };
}

test('preflight accepts the existing tested offline build and records its recipe', async t => {
  const copy = await fixture(t);
  const result = await inspectProject(copy.root, copy.repo);
  assert.equal(result.files.length, PACKAGE_FILES.length);
  assert.equal(result.manifest.subpackages.length, 6);
  assert.equal(result.manifest.config.onlineEnabled, false);
  assert.ok(result.inputHashes['wechat/minigame/package-lock.json']);
  assert.ok(result.inputHashes['wechat/minigame/tools/build.mjs']);
});

test('the old root key, tourist AppID and floating library cannot become candidates', async t => {
  const copy = await fixture(t);
  const file = path.join(copy.root, 'project.config.json');
  const original = await readJson(file);
  for (const [change, error] of [
    [{ miniprogramRoot: undefined, minigameRoot: 'dist/' }, /miniprogramRoot/],
    [{ appid: 'touristappid' }, /AppID/],
    [{ libVersion: 'latest' }, /base library/],
    [{ setting: { urlCheck: false } }, /domain checking/],
  ]) {
    await writeJson(file, { ...original, ...change });
    await assert.rejects(inspectProject(copy.root, copy.repo), error);
  }
});

test('source changes and tampered output are rejected even when a manifest still exists', async t => {
  const copy = await fixture(t);
  const source = path.join(copy.root, 'src/platform.js');
  const original = await fs.readFile(source);
  await fs.appendFile(source, '\n// stale build');
  await assert.rejects(inspectProject(copy.root, copy.repo), /Stale source/);
  await fs.writeFile(source, original);
  await fs.appendFile(path.join(copy.root, 'dist/game.js'), '\n// tampered');
  await assert.rejects(inspectProject(copy.root, copy.repo), /Stale or modified output/);
});

test('unexpected upload files and empty source directories are rejected', async t => {
  const copy = await fixture(t);
  const unwanted = path.join(copy.root, 'dist/config.local.json');
  await writeJson(unwanted, { fixture: true });
  await assert.rejects(inspectProject(copy.root, copy.repo), /Unexpected package file/);
  await fs.unlink(unwanted);
  await fs.mkdir(path.join(copy.root, 'dist/src'));
  await assert.rejects(inspectProject(copy.root, copy.repo), /Unexpected package directory/);
});

test('missing Worker and changed game configuration cannot pass the preflight', async t => {
  const copy = await fixture(t);
  const game = path.join(copy.root, 'game.json');
  const original = await fs.readFile(game);
  await writeJson(game, { workers: 'incorrect' });
  await assert.rejects(inspectProject(copy.root, copy.repo), /Stale copied input/);
  await fs.writeFile(game, original);
  await fs.unlink(path.join(copy.root, 'dist/workers/index.js'));
  await assert.rejects(inspectProject(copy.root, copy.repo), /Missing package file/);
});

test('local online configuration and manifest paths outside the repository are rejected', async t => {
  const copy = await fixture(t);
  const local = path.join(copy.root, 'config.local.json');
  await writeJson(local, { onlineEnabled: true, apiBase: 'https://example.com' });
  await assert.rejects(inspectProject(copy.root, copy.repo), /offline core/);
  await fs.unlink(local);
  const file = path.join(copy.root, 'dist/build-manifest.json');
  const manifest = await readJson(file);
  // Keep the self-inclusive byte count consistent to reach path validation.
  manifest.sourceHashes['../outside.js'] = '0'.repeat(64);
  const mainRuntime = manifest.outputs.filter(item => !item.path.startsWith('models/')).reduce((n, item) => n + item.bytes, 0);
  for (let i = 0; i < 5; i++) {
    const bytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
    manifest.totalBytes = manifest.runtimeBytes + bytes; manifest.mainPackageBytes = mainRuntime + bytes;
  }
  await writeJson(file, manifest);
  await assert.rejects(inspectProject(copy.root, copy.repo), /Unsafe file path/);
});

test('a fresh candidate reproduces tested bytes, stays isolated and detects later edits', async t => {
  const outputBase = await temporaryDirectory(t);
  const before = await inspectProject();
  const first = await prepareCandidate({ outputBase });
  const second = await prepareCandidate({ outputBase });
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(first.receipt.files, second.receipt.files);
  assert.deepEqual(await inspectProject(), before, 'preparation must not modify the original project or dist');
  assert.equal(first.receipt.files.length, PACKAGE_FILES.length + 1);
  assert.equal(first.receipt.status, 'PREPARED_LOCAL_NOT_UPLOADED');
  const config = await readJson(path.join(first.importDirectory, 'project.config.json'));
  assert.equal(config.appid, before.project.appid);
  assert.equal(config.miniprogramRoot, 'dist/');
  assert.equal(config.setting.urlCheck, true);
  assert.equal(Object.hasOwn(config, 'editorSetting'), false);
  assert.equal((await verifyCandidate(first.directory)).version, before.version);
  await fs.appendFile(path.join(first.importDirectory, 'dist/game.js'), '\n// changed after freeze');
  await assert.rejects(verifyCandidate(first.directory), /differ from the frozen receipt/);
});
