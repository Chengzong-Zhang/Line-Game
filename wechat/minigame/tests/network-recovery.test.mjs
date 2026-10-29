import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineClient } from '../src/online.js';
import { createWxPlatform } from '../src/platform.js';
import { uiHarness } from './ui-harness.mjs';
import { sut, until } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const room = (code = 'ABCDEFGH') => ({ code, matchId: 'a'.repeat(32), status: 'playing', player: 'BLACK' });
class Socket {
  constructor() { this.handlers = {}; this.sent = []; this.closed = false; }
  onOpen(fn) { this.handlers.open = fn; }
  onMessage(fn) { this.handlers.message = fn; }
  onError(fn) { this.handlers.error = fn; }
  onClose(fn) { this.handlers.close = fn; }
  send(options) { this.sent.push(JSON.parse(options.data)); options.success?.(); }
  close() { this.closed = true; }
  async emit(type, event = {}) { await this.handlers[type]?.(event); }
  async ready(value = room()) {
    await this.emit('open');
    await this.emit('message', { data: JSON.stringify({ type: 'room', room: value }) });
  }
}
function fixture() {
  const sockets = [], calls = { login: 0, request: 0 }, data = new Map();
  const platform = {
    storage: { get: key => data.get(key), set: (key, value) => data.set(key, value) },
    connectSocket() { const socket = new Socket(); sockets.push(socket); return socket; },
    async login() { calls.login++; throw Error('Unexpected login'); },
    async request() { calls.request++; throw Error('Unexpected request'); },
  };
  const client = new OnlineClient(platform, { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, { cancel() {} });
  Object.assign(client, { active: true, room: room(), token: 'synthetic-token', expires: Date.now() + 60000 });
  // This suite isolates transport lifecycle. Existing room/rule suites verify payloads.
  client.receive = async value => { client.room = value; client.error = null; return true; };
  return { client, sockets, calls };
}

test('restored network bypasses long backoff once and obsolete timer/socket events cannot reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { client, sockets, calls } = fixture();
  try {
    await client.connect(); await sockets[0].ready();
    client.retries = 5; await sockets[0].emit('error');
    assert.ok(client.reconnectTimer); assert.equal(client.retries, 6);
    await client.networkChanged({ isConnected: true });
    assert.equal(sockets.length, 2, 'network restoration must not wait for the 30-second timer');
    assert.equal(client.reconnectTimer, null); assert.equal(client.retries, 0);
    await sockets[1].ready();
    await client.networkChanged({ isConnected: true });
    await sockets[0].emit('error'); await sockets[0].emit('close', { code: 1006 });
    t.mock.timers.tick(30000); await tick();
    assert.equal(sockets.length, 2); assert.equal(client.connected, true);
    assert.equal(client.room.code, 'ABCDEFGH'); assert.deepEqual(calls, { login: 0, request: 0 });
  } finally { client.detach(); }
});

test('offline invalidates the old socket; repeated online notifications share one pending authentication', async () => {
  const { client, sockets } = fixture();
  try {
    await client.connect(); await sockets[0].ready();
    await client.networkChanged({ isConnected: false });
    assert.equal(sockets[0].closed, true); assert.equal(client.connected, false);
    assert.equal(client.room.code, 'ABCDEFGH');
    let release, authentications = 0;
    client.authenticate = () => { authentications++; return new Promise(resolve => { release = resolve; }); };
    const recovery = client.networkChanged({ isConnected: true });
    await client.networkChanged({ isConnected: true });
    assert.equal(authentications, 1); assert.equal(sockets.length, 1);
    await sockets[0].emit('message', { data: JSON.stringify({ type: 'room', room: room('BCDEFGHJ') }) });
    assert.equal(client.room.code, 'ABCDEFGH');
    release(); await recovery; await sockets[1].ready();
    assert.equal(sockets.length, 2); assert.equal(client.connected, true);
  } finally { client.detach(); }
});

test('background or a newer room invalidates pending recovery and obsolete authentication errors', async () => {
  for (const boundary of ['background', 'new-room', 'older-error']) {
    const { client, sockets } = fixture(); const pending = [];
    client.authenticate = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    try {
      const recovery = client.networkChanged({ isConnected: true });
      assert.equal(pending.length, 1);
      client.background();
      if (boundary !== 'background') {
        client.room = room('BCDEFGHJ'); client.active = true; client.game.hidden = false;
        const newer = client.connect(); assert.equal(pending.length, 2);
        pending[1].resolve(); await newer; await sockets[0].ready(room('BCDEFGHJ'));
      }
      if (boundary === 'older-error') pending[0].reject(Error('LOGIN_FAILED'));
      else pending[0].resolve();
      await recovery;
      assert.equal(sockets.length, boundary === 'background' ? 0 : 1);
      if (sockets[0]) {
        assert.equal(client.room.code, 'BCDEFGHJ'); assert.equal(client.error, null);
        assert.equal(sockets[0].sent[0].code, 'BCDEFGHJ');
      }
    } finally { client.detach(); }
  }
});

test('network events never enter a saved room, run in background, or override terminal/integrity errors', async () => {
  for (const boundary of ['inactive', 'hidden', 'no-room', 'closed', 'deleting', 'OTHER_DEVICE', 'STATE_MISMATCH', 'INVALID_ROOM', 'ACCOUNT_DELETED']) {
    const { client, sockets, calls } = fixture();
    client.token = null;
    client.platform.storage.set('lifeline-wx-room-v1', 'ABCDEFGH');
    if (boundary === 'inactive') client.active = false;
    else if (boundary === 'hidden') client.game.hidden = true;
    else if (boundary === 'no-room') client.room = null;
    else if (boundary === 'closed') client.room.status = 'closed';
    else if (boundary === 'deleting') client.deleting = true;
    else client.error = boundary;
    try {
      const originalError = client.error;
      await client.networkChanged(null); await client.networkChanged({ isConnected: 'true' });
      await client.networkChanged({ isConnected: false }); await client.networkChanged({ isConnected: true });
      assert.equal(sockets.length, 0, boundary); assert.deepEqual(calls, { login: 0, request: 0 }, boundary);
      assert.equal(client.error, originalError, boundary);
      assert.equal(client.savedCode, 'ABCDEFGH');
    } finally { client.detach(); }
  }
});

test('concurrent recovery and explicit reconnect create one socket, and a closed room cancels pending setup', async () => {
  for (const closeRoom of [false, true]) {
    const { client, sockets } = fixture(); const pending = [];
    client.authenticate = () => new Promise(resolve => pending.push(resolve));
    try {
      const recovery = client.networkChanged({ isConnected: true });
      const explicit = client.connect();
      if (closeRoom) client.room.status = 'closed';
      pending[0](); await recovery; assert.equal(sockets.length, 0);
      pending[1](); await explicit; assert.equal(sockets.length, closeRoom ? 0 : 1);
      assert.equal(client.connecting, false);
    } finally { client.detach(); }
  }
});

test('closed room metadata does not suppress terminal socket cleanup for room removal or account deletion', async () => {
  for (const code of [4010, 4008]) {
    const { client, sockets } = fixture();
    client.platform.storage.set('lifeline-wx-room-v1', 'ABCDEFGH');
    try {
      await client.connect(); await sockets[0].ready();
      await sockets[0].emit('message', { data: JSON.stringify({ type: 'room', room: { ...room(), status: 'closed' } }) });
      client.pending = { code: 'ABCDEFGH' };
      await sockets[0].emit('close', { code });
      assert.equal(client.active, false); assert.equal(client.connected, false);
      assert.equal(client.error, code === 4008 ? 'ACCOUNT_DELETED' : 'ROOM_REMOVED');
      assert.equal(client.savedCode, null); assert.equal(client.pending, null);
      assert.equal(client.socket, null); assert.equal(client.heartbeat, null); assert.equal(client.reconnectTimer, null);
      if (code === 4008) assert.equal(client.token, null);
      await client.networkChanged({ isConnected: false }); await client.networkChanged({ isConnected: true });
      assert.equal(sockets.length, 1);
    } finally { client.detach(); }
  }
});

test('late foreground refresh success or failure cannot replace a recovered socket or its healthy status', async () => {
  for (const fail of [false, true]) {
    const { client, sockets } = fixture();
    let resolveRefresh, rejectRefresh;
    client.platform.request = () => new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; });
    try {
      client.background();
      const returning = client.foreground(); await tick();
      assert.equal(typeof resolveRefresh, 'function');
      await client.networkChanged({ isConnected: true }); await sockets[0].ready();
      const recoveredSocket = client.socket;
      if (fail) rejectRefresh(Error('NETWORK_ERROR')); else resolveRefresh(room());
      await returning; await tick();
      assert.equal(client.socket, recoveredSocket); assert.equal(sockets.length, 1);
      assert.equal(client.connected, true); assert.equal(client.error, null);
      assert.equal(recoveredSocket.closed, false);
    } finally { client.detach(); }
  }
});

test('automatic retry remains bounded and a new offline-online edge can recover exhausted retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { client, sockets } = fixture();
  try {
    await client.connect();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
      const count = sockets.length;
      await sockets.at(-1).emit('error');
      t.mock.timers.tick(delay); await tick();
      assert.equal(sockets.length, count + 1);
    }
    await sockets.at(-1).emit('error');
    assert.equal(client.reconnectTimer, null); assert.equal(client.error, 'NETWORK_ERROR');
    t.mock.timers.tick(60000); await tick(); assert.equal(sockets.length, 7);
    await client.networkChanged({ isConnected: false }); await client.networkChanged({ isConnected: true });
    assert.equal(sockets.length, 8); assert.equal(client.retries, 0);
  } finally { client.detach(); }
});

test('platform network listener removes the same callback once and has a safe capability fallback', () => {
  const listeners = new Set(), removed = [], seen = [];
  const api = { createCanvas: () => ({}), onNetworkStatusChange: fn => listeners.add(fn),
    offNetworkStatusChange: fn => { removed.push(fn); listeners.delete(fn); } };
  const platform = createWxPlatform(api), stop = platform.onNetworkStatusChange(status => seen.push(status));
  assert.equal(listeners.size, 1);
  const callback = [...listeners][0]; callback({ isConnected: true });
  stop(); stop(); callback({ isConnected: false });
  assert.deepEqual(seen, [{ isConnected: true }]); assert.equal(listeners.size, 0); assert.deepEqual(removed, [callback]);
  const missing = createWxPlatform({ createCanvas: () => ({}), onNetworkStatusChange() { throw Error('No removable listener'); } });
  assert.doesNotThrow(() => missing.onNetworkStatusChange(() => {})());
});

test('app forwards network status only to a foreground online session and disposes its subscription', async () => {
  let listener, removed = 0; const received = [];
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, platformOverrides: {
    onNetworkStatusChange(fn) { listener = fn; return () => { removed++; }; },
  } });
  h.app.online.networkChanged = async status => { received.push(status); };
  h.app.online.enter = async () => {
    await h.app.online.game.load(sut.settingsFor(7), [], { mode: 'human', paused: true, save: false });
    h.app.online.active = true; h.app.online.room = room(); return true;
  };
  h.app.online.foreground = async () => { h.app.online.active = true; h.app.online.game.hidden = false; };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    assert.equal(typeof listener, 'function');
    listener({ isConnected: true }); assert.equal(received.length, 0, 'local game must remain offline');
    await h.tap('friends'); await h.tap('room-submit'); await until(() => h.app.online.room);
    listener({ isConnected: false }); assert.deepEqual(received, [{ isConnected: false }]);
    h.p.callbacks.hide(); listener({ isConnected: true }); assert.equal(received.length, 1);
    h.p.callbacks.show(); listener({ isConnected: true }); assert.equal(received.length, 2);
    h.app.dispose(); listener({ isConnected: false }); assert.equal(received.length, 2); assert.equal(removed, 1);
  } finally { h.app.dispose(); }
});
