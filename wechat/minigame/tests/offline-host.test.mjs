import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startOfflineServer } from '../tools/offline-server.mjs';
import { MODEL_CATALOG } from '../src/model-catalog.js';
import { createHash } from 'node:crypto';

test('offline host only serves allowlisted game assets on loopback, rejects writes and cross-site access', async () => {
  const host = await startOfflineServer();
  const get = async (pathname, options = {}) => fetch(host.origin + pathname, options);
  try {
    const home = await get('/'); assert.equal(home.status, 200); assert.match(await home.text(), /免登录试玩/);
    assert.match(home.headers.get('content-security-policy'), /connect-src 'self';/);
    assert.equal((await get('/preview/offline-host.js')).status, 200);
    assert.equal((await get('/dist/game.js')).status, 200);
    const model = MODEL_CATALOG[0], asset = await get(`/dist/${model.assetPath}`);
    assert.equal(asset.headers.get('content-type'), 'application/octet-stream');
    const data = Buffer.from(await asset.arrayBuffer());
    assert.equal(data.length, model.bytes); assert.equal(createHash('sha256').update(data).digest('hex'), model.spec.asset_sha256);
    assert.equal((await get('/dist/models/research/not-in-catalog.bin')).status, 404);
    assert.equal((await get('/dist/game.json')).status, 200);
    for (const pathname of ['/src/app.js', '/config.local.json', '/project.config.json', '/api/wechat/login', '/.env', '/..%2f..%2fAGENTS.md'])
      assert.equal((await get(pathname)).status, 404, pathname);
    assert.equal((await get('/', { method: 'POST' })).status, 405);
    assert.equal((await get('/', { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await get('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      const req = request(host.origin, { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    assert.deepEqual(await (await get('/health')).json(), { kind: 'lifeline-offline-host', login: false, network: false });
  } finally { await host.close(); }
});
