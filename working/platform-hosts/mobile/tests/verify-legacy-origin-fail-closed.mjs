import assert from 'node:assert/strict';
import { SharedLadderSession } from '../../web/web前端/SharedLadderSession.js';

const requests = [];
const session = new SharedLadderSession({
  pageOrigin: 'https://lifelinegame.cn',
  fetchImpl: async (url, options) => {
    requests.push({ url, authorization: options?.headers?.Authorization });
    return { ok: true, json: async () => ({ enabled: true, protocol: 1, ladder: 'v1', webLogin: true, webAuthMode: 'legacy-jwt' }) };
  },
});
session.setIdentity({ token: 'synthetic-legacy-token', username: 'fixture' });
assert.deepEqual(await session.ensure(), { status: 'origin-mismatch' });
assert.ok(requests.every(request => !request.authorization), 'a legacy token without bound origin is never exchanged');
assert.equal(requests.length, 1, 'only the unauthenticated capability probe occurs');
session.dispose();
console.log('verify-legacy-origin-fail-closed: PASS (legacy credential requires a trusted origin binding)');
