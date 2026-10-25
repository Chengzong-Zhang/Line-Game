import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineClient } from '../src/online.js';
import { SharedRoomClient } from '../../../web/web前端/SharedRoomClient.js';
import CrossPlatformNetwork from '../../../web/web前端/CrossPlatformNetwork.js';

const origin = 'https://fixture.invalid', oldUid = 'a'.repeat(32), newUid = 'b'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const session = (uid = oldUid) => ({ token: `fixture-token-${uid}`, protocol: 1, expiresIn: 7200,
  account: { uid, displayName: 'Fixture', provider: 'wechat', linkedWeb: false, linkedWechat: true } });
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => data });
const storage = () => {
  const entries = new Map();
  return { get: key => entries.get(key), set: (key, value) => entries.set(key, value),
    getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
};
function mini(platform) {
  return new OnlineClient({ storage: storage(), ...platform }, { onlineEnabled: true, apiBase: origin },
    { cancel() {}, request() { throw new Error('Unexpected game Worker request'); } });
}

test('Mini deletion invalidates both a delayed wx.login and an already pending exchange response', async () => {
  for (const delayed of ['login', 'exchange']) {
    const gate = deferred(), requests = [];
    let logins = 0, exchanges = 0;
    const client = mini({
      login: async () => ++logins === 1 && delayed === 'login' ? gate.promise : 'fresh-fixture-code',
      request: async request => {
        requests.push(request);
        if (request.url.endsWith('/account/delete')) return { protocol: 1, deleted: true };
        assert.ok(request.url.endsWith('/login'));
        if (++exchanges === 1 && delayed === 'exchange') return gate.promise;
        return session();
      },
    });
    const rejected = assert.rejects(client.authenticate(), /CANCELLED/);
    await tick();
    assert.equal(await client.deleteAccount(), true);
    gate.resolve(delayed === 'login' ? 'obsolete-code' : session(newUid));
    await rejected;
    assert.equal(client.token, null, delayed);
    assert.equal(client.account, null, delayed);
    assert.equal(client.authenticating, null, delayed);
    assert.equal(requests.filter(r => r.url.endsWith('/account/delete')).length, 1);
    assert.equal(requests.filter(r => r.url.endsWith('/login')).length, delayed === 'login' ? 1 : 2);
    client.detach();
  }
});

test('Mini account deletion blocks unrelated account and room requests until it finishes', async () => {
  const gate = deferred(), requests = [];
  const client = mini({ login: () => gate.promise, request: async request => {
    requests.push(request); return { protocol: 1, deleted: true };
  } });
  client.acceptIdentity(session());
  const deletion = client.deleteAccount();
  await tick();
  await assert.rejects(client.loadAccount(), /ACCOUNT_DELETION_PENDING/);
  await assert.rejects(client.linkWebAccount('A'.repeat(26)), /ACCOUNT_DELETION_PENDING/);
  await assert.rejects(client.enter('create', 5), /ACCOUNT_DELETION_PENDING/);
  gate.resolve('fresh-deletion-code');
  assert.equal(await deletion, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/account/delete'));
});

test('Mini leaving while identity exchange waits never creates the old requested room', async () => {
  const gate = deferred(), requests = [];
  const client = mini({ login: () => gate.promise, request: async request => {
    requests.push(request); return session();
  } });
  const entering = client.enter('create', 5);
  await tick(); client.detach();
  gate.resolve('fixture-code');
  assert.equal(await entering, false);
  assert.equal(requests.filter(r => r.url.endsWith('/rooms')).length, 0);
});

test('Mini pending actions load only for the same service and verified uid', async () => {
  for (const mismatch of ['uid', 'origin', 'legacy']) {
    const saved = storage();
    saved.set('lifeline-wx-command-v1', JSON.stringify({
      version: mismatch === 'legacy' ? 1 : 2, uid: mismatch === 'uid' ? newUid : oldUid,
      apiBase: mismatch === 'origin' ? 'https://another.invalid' : origin, code: 'ABCDEFGH',
      body: { matchId: 'c'.repeat(32), expectedSeq: 0, clientActionId: 'pending-command-000001', action: { type: 'skip' } },
    }));
    const client = mini({ storage: saved, login: async () => 'fixture-code', request: async request =>
      request.url.endsWith('/login') ? session() : { code: 'ABCDEFGH' } });
    client.receive = async room => { client.room = room; return true; };
    client.connect = async () => {};
    assert.equal(await client.enter('resume', 'ABCDEFGH'), true);
    assert.equal(client.pending, null, mismatch);
    client.detach();
  }
});

test('Web stop and switching accounts during login prevent the old create from being sent', async () => {
  const gate = deferred(), calls = [];
  const client = new SharedRoomClient({ storage: storage(), fetch: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/status')) return response({ enabled: true, webLogin: true, webAuthMode: 'legacy-jwt' });
    assert.ok(url.endsWith('/login/web'));
    return options.headers.Authorization === 'Bearer old-web-session' ? gate.promise : response(session(newUid));
  } });
  client.origin = origin; client.webToken = 'old-web-session';
  const rejected = assert.rejects(client.enter('create', 5), /CANCELLED|ACCOUNT_SESSION_CHANGED/);
  await tick();
  await client.open(origin, 'new-web-session');
  gate.resolve(response(session()));
  await rejected;
  assert.equal(client.account.uid, newUid);
  assert.equal(calls.filter(call => call.url.endsWith('/rooms')).length, 0);
  client.stop();
});

test('Web shared token refresh after binding clears old commands and never retries them under new uid', async () => {
  const calls = [], saved = storage();
  saved.setItem('lifeline-shared-command-v1', '{"old":"pending"}');
  const client = new SharedRoomClient({ storage: saved, fetch: async url => {
    calls.push(url);
    if (url.endsWith('/status')) return response({ enabled: true, webLogin: true, webAuthMode: 'legacy-jwt' });
    return url.endsWith('/login/web') ? response(session(newUid)) : response({ detail: 'ACCOUNT_SESSION_CHANGED' }, false);
  } });
  Object.assign(client, { origin, webToken: 'valid-web-session', token: 'old-shared-session', expires: Date.now() + 60000,
    account: session().account, pending: { code: 'ABCDEFGH' }, room: { code: 'ABCDEFGH' }, engine: {} });
  await assert.rejects(client.request('rooms/ABCDEFGH/actions', { action: { type: 'skip' } }), /ACCOUNT_SESSION_CHANGED/);
  assert.equal(client.account.uid, newUid);
  assert.equal(client.room, null);
  assert.equal(client.pending, null);
  assert.equal(client.engine, null);
  assert.equal(saved.getItem('lifeline-shared-command-v1'), undefined);
  assert.equal(calls.filter(url => url.includes('/actions')).length, 1);
  client.stop();
});

class FixtureSocket {
  static instances = [];
  constructor(url) { this.url = url; this.handlers = new Map(); this.readyState = 0; this.sent = []; FixtureSocket.instances.push(this); }
  addEventListener(name, callback) { this.handlers.set(name, [...(this.handlers.get(name) || []), callback]); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  emit(name, event = {}) { for (const callback of this.handlers.get(name) || []) callback(event); }
}

test('Web takeover/deletion socket closure followed by UI leave performs local cleanup without closing the other device room', async () => {
  for (const code of [4008, 4009, 4010]) {
    const requests = [];
    const network = new CrossPlatformNetwork({ WebSocket: FixtureSocket, storage: storage(),
      fetch: async url => { requests.push(url); throw new Error('Terminal closure must not perform HTTP'); } });
    Object.assign(network, { sharedActive: true, url: `${origin.replace('https:', 'wss:')}/ws`, authToken: 'web-session',
      roomId: 'ABCDEFGH', playerId: 'ABCDEFGH:BLACK', color: 'BLACK' });
    Object.assign(network.shared, { origin, webToken: 'web-session', token: 'shared-session', expires: Date.now() + 60000,
      account: session().account, room: { code: 'ABCDEFGH', status: 'playing', matchId: 'c'.repeat(32) } });
    let uiCleanup;
    network.on('CLOSE', () => { uiCleanup = network.leaveRoom(); });
    const disconnected = assert.rejects(network.shared.connect(), /NETWORK_ERROR/);
    await tick();
    FixtureSocket.instances.at(-1).emit('close', { code });
    await disconnected; await uiCleanup;
    assert.equal(network.shared.room, null, String(code));
    assert.equal(network.roomId, null, String(code));
    assert.equal(network.shared.connected, false, String(code));
    assert.equal(requests.length, 0, String(code));
    network.shared.stop();
  }
});
