// Local, allowlisted standalone service package. Never connects or loads env/DB.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { nativeWebCompatibility } from './web-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const slash = value => value.split(path.sep).join('/');
const hash = data => createHash('sha256').update(data).digest('hex');
const entry = 'wechat/minigame/tools/validate-action.mjs';
const fixed = ['web/package.json', 'web/web后端/wechat_online.py', 'web/web后端/requirements.txt',
  'wechat/tools/wechat_service_asgi_draft.py', 'wechat/tools/check_service_config.py',
  'wechat/tools/maintain_store.py', 'wechat/minigame/package.json',
  'wechat/minigame/THIRD_PARTY_NOTICES.txt', 'wechat/minigame/node_modules/@noble/hashes/package.json',
  'wechat/minigame/node_modules/@noble/hashes/LICENSE'];
const allowed = name => name.startsWith('web/web前端/') && /\.(js|json)$/.test(name)
  || name.startsWith('wechat/minigame/src/') && /\.js$/.test(name)
  || name.startsWith('wechat/minigame/node_modules/@noble/hashes/') && /\.(js|json)$/.test(name)
  || name === entry || fixed.includes(name);

async function ordinaryDirectory(directory) {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root;
  let cursor = volume;
  for (const part of path.relative(volume, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Linked or non-directory ancestor: ${cursor}`);
  }
}

async function safeRead(base, name) {
  assert.ok(typeof name === 'string' && name && !name.includes('\\') && !path.isAbsolute(name));
  const parts = name.split('/'); assert.ok(parts.every(p => p && p !== '.' && p !== '..'));
  let cursor = base;
  for (const [i, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const s = await fs.lstat(cursor);
    assert.ok(!s.isSymbolicLink() && (i === parts.length - 1 ? s.isFile() : s.isDirectory()), `Non-ordinary input: ${name}`);
  }
  return fs.readFile(cursor);
}

async function graph(base = root) {
  await ordinaryDirectory(base);
  const inputs = new Map();
  const compatibility = path.resolve(base) === root
    ? await nativeWebCompatibility(root, new Set()) : null;
  const effectiveRead = async name => {
    const native = compatibility && name.startsWith('web/web前端/') && name.endsWith('.js')
      ? await compatibility.load({ path: path.join(base, name) }) : null;
    return native ? native.contents : safeRead(base, name);
  };
  const built = await build({ absWorkingDir: base, entryPoints: [entry], bundle: true,
    format: 'esm', platform: 'node', target: 'node22', write: false, metafile: true,
    plugins: [{ name: 'capture-service-dependencies', setup(b) {
      b.onResolve({ filter: /\?v=/ }, item => ({ path: path.resolve(item.resolveDir, item.path.split('?')[0]) }));
      b.onLoad({ filter: /\.(mjs|js|json)$/ }, async item => {
        const name = slash(path.relative(base, item.path));
        assert.ok(allowed(name), `Unexpected service dependency: ${name}`);
        const data = await effectiveRead(name); inputs.set(name, data);
        return { contents: data, loader: name.endsWith('.json') ? 'json' : 'js' };
      });
    } }] });
  for (const file of Object.keys(built.metafile.inputs)) {
    const name = slash(path.relative(base, path.resolve(base, file)));
    assert.ok(inputs.has(name), `Uncaptured dependency: ${name}`);
  }
  // The graph is used only to find imports. Ship original source bytes, not the
  // discovery bundle, so ordinary Node import attributes/query strings remain.
  for (const name of fixed) inputs.set(name, await safeRead(base, name));
  for (const [name, data] of inputs) assert.equal(hash(await effectiveRead(name)), hash(data), `Input changed: ${name}`);
  inputs.nativeCompatibility = compatibility?.records || {};
  return inputs;
}

export async function verifyService(directory, { checkSources = false } = {}) {
  await ordinaryDirectory(directory);
  await ordinaryDirectory(path.join(directory, 'service'));
  const manifest = JSON.parse(await safeRead(directory, 'manifest.json'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'standalone-wechat-service');
  const expected = new Set(manifest.files.map(f => f.path));
  assert.equal(expected.size, manifest.files.length);
  for (const file of [...fixed, entry]) assert.ok(expected.has(file), `Missing required package input: ${file}`);
  const dependencies = await graph(checkSources ? root : path.join(directory, 'service'));
  assert.deepEqual([...expected].sort(), [...dependencies.keys()].sort(), 'Manifest does not cover the complete service dependency graph');
  const found = [];
  async function walk(base, prefix = '') {
    for (const f of await fs.readdir(base, { withFileTypes: true })) {
      const name = prefix + f.name;
      if (f.isDirectory()) await walk(path.join(base, f.name), name + '/');
      else { assert.ok(f.isFile() && expected.has(name), `Unexpected package input: ${name}`); found.push(name); }
    }
  }
  await walk(path.join(directory, 'service'));
  assert.equal(found.length, manifest.files.length);
  for (const f of manifest.files) {
    assert.ok(allowed(f.path));
    const data = await safeRead(path.join(directory, 'service'), f.path);
    assert.equal(data.length, f.bytes, f.path); assert.equal(hash(data), f.sha256, f.path);
    if (checkSources) assert.equal(hash(dependencies.get(f.path)), f.sha256, `Source changed: ${f.path}`);
  }
  assert.equal(manifest.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
  assert.match((await safeRead(path.join(directory, 'service'), 'web/web后端/requirements.txt')).toString(), /Pillow>=11,<13/);
  return manifest;
}

export async function prepareService(directory) {
  const local = path.join(root, 'local_artifacts');
  const relative = path.relative(local, directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Output must be a new local_artifacts directory');
  await ordinaryDirectory(local);
  await ordinaryDirectory(path.dirname(directory));
  // A fresh output is mandatory; no historical candidate can be replaced.
  const inputs = await graph();
  await fs.mkdir(directory, { recursive: false });
  await ordinaryDirectory(directory);
  const files = [];
  for (const [name, data] of [...inputs].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const destination = path.join(directory, 'service', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data, { flag: 'wx' });
    files.push({ path: name, bytes: data.length, sha256: hash(data) });
  }
  const manifest = { schemaVersion: 1, kind: 'standalone-wechat-service',
    version: JSON.parse(await safeRead(root, 'wechat/minigame/package.json')).version,
    status: 'PREPARED_LOCAL_NOT_DEPLOYED', createdAt: new Date().toISOString(),
    node: process.version, nodeRequirement: '>=22', files, totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    rulesVersion: 'territory-v3', onlinePlayerCount: 2, databaseSchema: 3,
    entry: 'wechat/tools/wechat_service_asgi_draft.py', validator: entry,
    requirements: 'web/web后端/requirements.txt',
    sourceLayout: 'Canonical browser files plus pinned native compatibility inputs; original runtime paths preserved',
    nativeCompatibility: inputs.nativeCompatibility,
    boundaries: ['No remote connection, environment file, credential or database read',
      'Package creation is not runtime, deployment or rollback acceptance',
      'Use one ASGI worker, existing separately configured secrets and dedicated database',
      'Old r4 code rejects schema3; require verified schema3-compatible rollback before activation'] };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await verifyService(directory, { checkSources: true });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, verify: { type: 'string' }, 'check-sources': { type: 'boolean' } } });
    assert.ok(Boolean(values.output) !== Boolean(values.verify), 'Select --output or --verify');
    const directory = path.resolve(values.output || values.verify);
    const manifest = values.verify ? await verifyService(directory, { checkSources: values['check-sources'] }) : await prepareService(directory);
    console.log(JSON.stringify({ status: values.verify ? 'PASS_SERVICE_PACKAGE_FILES' : manifest.status,
      directory, files: manifest.files.length, totalBytes: manifest.totalBytes }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
