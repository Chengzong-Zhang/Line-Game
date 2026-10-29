import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareService, verifyService } from '../tools/prepare-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = data => createHash('sha256').update(data).digest('hex');
test('isolated service has complete validator dependencies and rejects reuse, tampering, extra files and source drift', async () => {
  const scratch = path.join(root, 'working', 'tmp');
  await fs.mkdir(scratch, { recursive: true });
  const artifact = await fs.mkdtemp(path.join(scratch, 'wechat-service-package-test-'));
  const candidate = path.join(artifact, 'candidate');
  const manifest = await prepareService(candidate);
  assert.equal(manifest.databaseSchema, 6);
  assert.equal(manifest.ladderVersion, 'ladder-v3-conservative');
  assert.ok(manifest.files.some(f => f.path.endsWith('/StartingPoints.js')));
  assert.ok(manifest.files.some(f => f.path.endsWith('/LocalUndo.js')));
  assert.ok(manifest.files.some(f => f.path.endsWith('/@noble/hashes/LICENSE')));
  for (const name of ['web/web后端/board_validation.py', 'web/tools/online_bot_bridge.mjs',
    'web/tools/online_bot_runtime.mjs', 'web/tools/generate_online_roots.mjs',
    'web/web前端/assets/research-ai/manifest.json', 'web/web前端/assets/research-ai/model-free-manifest.json']) {
    assert.ok(manifest.files.some(file => file.path === name), `Missing runtime dependency: ${name}`);
  }
  assert.ok(manifest.files.some(file => file.path.endsWith('.f32')), 'Missing manifest-bound model bytes');
  assert.ok(manifest.files.every(f => !/\.(key|sqlite3|db|env)$/.test(f.path)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP'].includes(k.toUpperCase())));
  const result = spawnSync(process.execPath, [path.join(candidate, 'service', manifest.validator)], {
    cwd: candidate, env, input: JSON.stringify({ settings: { gridSize: 5, playerCount: 2,
      rulesVersion: 'territory-v2', startPlayer: 'BLACK' }, actions: [] }),
    timeout: 15000, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).stateHash, /^sha256:[0-9a-f]{64}$/);
  const roots = spawnSync(process.execPath, [path.join(candidate, 'service', 'web/tools/generate_online_roots.mjs')], {
    cwd: candidate, env, input: JSON.stringify({ gridSize: 7, playerCount: 2, rootMode: 'add', boardShape: 'triangle' }),
    timeout: 15000, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(roots.status, 0, roots.stderr);
  assert.deepEqual(Object.keys(JSON.parse(roots.stdout)).sort(), ['BLACK', 'WHITE']);
  const bridge = spawnSync(process.execPath, [path.join(candidate, 'service', 'web/tools/online_bot_bridge.mjs')], {
    cwd: candidate, env, input: JSON.stringify({ settings: { gridSize: 5, playerCount: 2,
      rulesVersion: 'territory-v3', boardShape: 'triangle', startPlayer: 'BLACK', botCount: 0 }, actions: [], botColors: [] }),
    timeout: 15000, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(JSON.parse(bridge.stdout).success, true);
  const originalManifest = await fs.readFile(path.join(candidate, 'manifest.json'));
  await assert.rejects(prepareService(candidate), /EEXIST/);
  assert.equal(hash(await fs.readFile(path.join(candidate, 'manifest.json'))), hash(originalManifest));
  const target = path.join(candidate, 'service', 'wechat/tools/check_service_config.py');
  const original = await fs.readFile(target);
  const changed = Buffer.concat([original, Buffer.from('\n# synthetic package tamper\n')]);
  await fs.writeFile(target, changed);
  await assert.rejects(verifyService(candidate));
  const row = manifest.files.find(f => f.path === 'wechat/tools/check_service_config.py');
  row.sha256 = hash(changed); row.bytes = changed.length;
  manifest.totalBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  await fs.writeFile(path.join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await verifyService(candidate);
  await assert.rejects(verifyService(candidate, { checkSources: true }), /Source changed/);
  await fs.writeFile(target, original);
  await fs.writeFile(path.join(candidate, 'manifest.json'), originalManifest);
  const dropped = 'web/web前端/StartingPoints.js';
  const omitted = JSON.parse(originalManifest);
  omitted.files = omitted.files.filter(f => f.path !== dropped);
  omitted.totalBytes = omitted.files.reduce((n, f) => n + f.bytes, 0);
  const dependency = path.join(candidate, 'service', dropped), dependencyBytes = await fs.readFile(dependency);
  await fs.unlink(dependency);
  await fs.writeFile(path.join(candidate, 'manifest.json'), JSON.stringify(omitted));
  await assert.rejects(verifyService(candidate, { checkSources: true }), /complete service dependency graph/);
  await fs.writeFile(dependency, dependencyBytes);
  await fs.writeFile(path.join(candidate, 'manifest.json'), originalManifest);
  const extra = path.join(candidate, 'service', '.env');
  await fs.writeFile(extra, 'synthetic-only-not-a-real-secret');
  await assert.rejects(verifyService(candidate), /Unexpected package input/);
  await fs.unlink(extra);
  await verifyService(candidate, { checkSources: true });
  const linked = path.join(artifact, 'linked-package');
  await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, 'manifest.json'), originalManifest);
  await fs.symlink(path.join(candidate, 'service'), path.join(linked, 'service'), 'junction');
  await assert.rejects(verifyService(linked), /Linked or non-directory ancestor/);
  const alias = path.join(artifact, 'linked-parent');
  await fs.symlink(candidate, alias, 'junction');
  await assert.rejects(prepareService(path.join(alias, 'escaped-output')), /Linked or non-directory ancestor/);
  await assert.rejects(fs.stat(path.join(candidate, 'escaped-output')), { code: 'ENOENT' });
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify({
    status: 'PASS_ISOLATED_SERVICE_PACKAGE', files: manifest.files.length, nativeNodeValidator: true,
    reusedOutputRejected: true, modifiedFileRejected: true, sourceDriftRejected: true,
    unexpectedEnvFileRejected: true, pairedDependencyAndManifestDeletionRejected: true,
    linkedServiceRootRejected: true, linkedOutputAncestorRejected: true, productionModified: false,
  }, null, 2));
  console.log(JSON.stringify({ localArtifacts: path.relative(root, artifact), status: 'PASS_ISOLATED_SERVICE_PACKAGE' }));
});
