import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const frontend = process.env.LIFELINE_WEB_TEST_ROOT
  ? pathToFileURL(path.resolve(process.env.LIFELINE_WEB_TEST_ROOT) + path.sep)
  : new URL('../../../web/web前端/', import.meta.url);
const { SharedRoomClient } = await import(new URL('SharedRoomClient.js', frontend));
const { default: CrossPlatformNetwork } = await import(new URL('CrossPlatformNetwork.js', frontend));
const { default: GameEngine } = await import(new URL('GameEngine.js', frontend));
const { canonicalize, serializeRuleState } = await import(new URL('ReplayCodec.js', frontend));

// Real loopback HTTP plus the real Web event handlers. Vue scheduling, DOM and
// socket delivery are fixtures; this does not claim browser or production QA.
const tick = () => new Promise(resolve => setImmediate(resolve));
const values = new Map(), watchers = [], unmounts = [], requests = [];
let mode = 'password', delayPath = null, releaseResponse = null;
const settings = { gridSize: 7, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2' };
const engine = new GameEngine(settings), snapshot = engine.getSnapshot();
const room = {
  protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
  actions: [], actionIds: [], player: 'BLACK', currentPlayer: 'BLACK', status: 'waiting', settings,
  ready: { BLACK: false, WHITE: false }, members: { BLACK: true, WHITE: false },
  rematchVotes: { BLACK: false, WHITE: false }, gameOver: false, winner: snapshot.winner,
  scores: { BLACK: snapshot.territories.BLACK.area, WHITE: snapshot.territories.WHITE.area },
  stateHash: `sha256:${createHash('sha256').update(canonicalize(serializeRuleState(engine))).digest('hex')}`,
};
const session = { token: 'fixture-shared-session', protocol: 1, expiresIn: 7200,
  account: { uid: 'b'.repeat(32), displayName: 'fixture-user', provider: 'web' } };
const server = createServer(async (request, response) => {
  let raw = ''; for await (const part of request) raw += part;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ path: request.url, authorization: request.headers.authorization, body });
  const send = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); };
  if (request.url === delayPath) await new Promise(resolve => { releaseResponse = resolve; });
  if (request.url.endsWith('/status')) return send(200, { enabled: true, webLogin: true,
    webAuthMode: mode, passwordLogin: mode === 'password', accountLinking: true });
  if (request.url.endsWith('/login/web')) return mode === 'legacy-jwt'
    ? send(200, session) : send(503, { detail: 'WEB_LOGIN_NOT_CONFIGURED' });
  if (request.url.endsWith('/login/password-session')) return body?.username === 'fixture-user' && body?.password === 'fixture-password'
    ? send(200, session) : send(401, { detail: 'UNAUTHORIZED' });
  if (request.url.endsWith('/account/link-code')) {
    const expected = mode === 'password' ? session.token : 'fixture-web-session';
    return request.headers.authorization === `Bearer ${expected}`
      ? send(200, { code: 'FIXTURE-LINK', expiresIn: 300 }) : send(401, { detail: 'UNAUTHORIZED' });
  }
  if (request.url.includes('/rooms')) return send(200, room);
  send(404, { detail: 'NOT_FOUND' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });
globalThis.location = new URL(origin);
globalThis.localStorage = { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
const noop = () => {};
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = globalThis.removeEventListener = noop;
globalThis.Vue = {
  ref: value => ({ value }), shallowRef: value => ({ value }),
  computed: read => ({ get value() { return read(); } }),
  watch: (source, callback) => watchers.push({ source, callback }), nextTick: async () => {},
  onMounted: noop, onBeforeUnmount: callback => unmounts.push(callback),
};
class FixtureSocket {
  static OPEN = 1; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 0; this.handlers = new Map(); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
  addEventListener(type, callback) { this.handlers.set(type, [...(this.handlers.get(type) || []), callback]); }
  emit(type, event) { for (const callback of this.handlers.get(type) || []) callback(event); }
  send(raw) { const payload = JSON.parse(raw); if (payload.protocol === 1) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'room', room }) })); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FixtureSocket;
const { default: App } = await import(new URL('OnlineApp.js', frontend));
function mount() {
  values.clear(); watchers.length = 0; unmounts.length = 0; requests.length = 0;
  mode = 'password'; delayPath = null; releaseResponse = null;
  values.set('triaxis-auth', JSON.stringify({ token: 'fixture-web-session', username: 'fixture-user' }));
  const app = App.setup(); app.tutorialActive.value = false; app.serverUrl.value = origin.replace('http:', 'ws:') + '/ws';
  return app;
}
function cleanup() { releaseResponse?.(); for (const dispose of unmounts.splice(0)) dispose(); }
async function waitFor(check) {
  const deadline = Date.now() + 2500;
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function noPasswordStored() {
  assert.ok([...values.values()].every(value => !value.includes('fixture-password')));
}

test('password sessions use original credentials without the legacy JWT and prompt again on expiry', async () => {
  mode = 'password'; requests.length = 0; let prompts = 0;
  const client = new SharedRoomClient({ storage: globalThis.localStorage,
    requestPasswordSession: async ({ login }) => { prompts++; return login({ username: 'fixture-user', password: 'fixture-password' }); } });
  try {
    await client.open(origin, 'public-default-jwt');
    assert.equal(prompts, 1); assert.equal(client.token, session.token);
    await client.authenticate(); assert.equal(prompts, 1);
    client.expires = 0; await client.authenticate(); assert.equal(prompts, 2);
    assert.equal(requests.filter(item => item.path.endsWith('/login/web')).length, 0);
    assert.ok(requests.filter(item => /status|password-session/.test(item.path)).every(item => item.authorization === undefined));
    assert.equal('password' in client, false); noPasswordStored();
  } finally { client.stop(); }
});

test('strong JWT mode still exchanges automatically and sends the legacy token for a link code', async () => {
  mode = 'legacy-jwt'; requests.length = 0;
  const network = new CrossPlatformNetwork({ requestPasswordSession: () => { throw new Error('must not prompt'); } });
  network.url = origin.replace('http:', 'ws:') + '/ws'; network.setAuthToken('fixture-web-session');
  try {
    const code = await network.issueLinkCode(); assert.equal(code.code, 'FIXTURE-LINK');
    assert.equal(requests.find(item => item.path.endsWith('/login/web')).authorization, 'Bearer fixture-web-session');
    assert.equal(requests.at(-1).authorization, 'Bearer fixture-web-session');
  } finally { network.disconnect(); }
});

test('real create handler allows failed-password retry then resumes shared play without storing the password', async () => {
  const app = mount();
  try {
    const entering = app.handleCreateSharedRoom(); await waitFor(() => app.sharedPasswordOpen.value);
    assert.equal(app.sharedPasswordUsername.value, 'fixture-user');
    app.sharedPassword.value = 'wrong'; await app.handleSharedPasswordSubmit();
    assert.equal(app.sharedPassword.value, ''); assert.equal(app.sharedPasswordOpen.value, true);
    assert.match(app.sharedPasswordError.value, /密码不正确|Incorrect/);
    assert.equal(requests.some(item => item.path.endsWith('/rooms')), false);
    app.sharedPassword.value = 'fixture-password'; await app.handleSharedPasswordSubmit(); await entering;
    assert.equal(app.sharedPasswordOpen.value, false); assert.equal(app.session.value.roomId, room.code);
    assert.equal(app.session.value.shared, true); noPasswordStored();
  } finally { cleanup(); }
});

test('closing while password verification is in flight drops its result and never creates a room', async () => {
  const app = mount(); delayPath = '/api/wechat/login/password-session';
  try {
    const entering = app.handleCreateSharedRoom(); await waitFor(() => app.sharedPasswordOpen.value);
    app.sharedPassword.value = 'fixture-password'; const submitting = app.handleSharedPasswordSubmit();
    await waitFor(() => releaseResponse); app.handleCloseUtilityDeck();
    assert.equal(app.sharedPassword.value, ''); assert.equal(app.sharedPasswordOpen.value, false);
    releaseResponse(); await submitting; await entering;
    assert.equal(app.session.value.roomId, null); assert.equal(app.auth.value.token, 'fixture-web-session');
    assert.equal(requests.some(item => item.path.endsWith('/rooms')), false); noPasswordStored();
  } finally { cleanup(); }
});

test('closing during status lookup prevents a late password prompt', async () => {
  const app = mount(); delayPath = '/api/wechat/status';
  try {
    const entering = app.handleCreateSharedRoom(); await waitFor(() => releaseResponse);
    app.handleCloseUtilityDeck(); releaseResponse(); await entering;
    assert.equal(app.sharedPasswordOpen.value, false); assert.equal(app.activeUtilityDeck.value, '');
    assert.equal(requests.some(item => item.path.includes('/login/')), false);
  } finally { cleanup(); }
});

test('cancelling verification preserves an existing legacy socket', async () => {
  mode = 'password'; delayPath = null; let closed = 0;
  const network = new CrossPlatformNetwork({ requestPasswordSession: async () => { throw new Error('CANCELLED'); } });
  network.url = origin.replace('http:', 'ws:') + '/ws'; network.setAuthToken('fixture-web-session');
  const legacySocket = { close: () => closed++ }; network.socket = legacySocket;
  try {
    await assert.rejects(network.createSharedRoom(settings), /CANCELLED/);
    assert.equal(network.socket, legacySocket); assert.equal(closed, 0); assert.equal(network.sharedActive, false);
  } finally { network.socket = null; network.disconnect(); }
});

test('link-code handler uses verified shared identity in password mode', async () => {
  const app = mount();
  try {
    const linking = app.handleLinkWechat(); await waitFor(() => app.sharedPasswordOpen.value);
    app.sharedPassword.value = 'fixture-password'; await app.handleSharedPasswordSubmit(); await linking;
    assert.equal(app.accountLinkCode.value, 'FIXTURE-LINK');
    assert.equal(requests.find(item => item.path.endsWith('/account/link-code')).authorization, 'Bearer fixture-shared-session');
    assert.equal(requests.some(item => item.path.endsWith('/login/web')), false); noPasswordStored();
  } finally { cleanup(); }
});

test('logout cancels a pending form and clears entered secrets without creating a room', async () => {
  const app = mount();
  try {
    const entering = app.handleCreateSharedRoom(); await waitFor(() => app.sharedPasswordOpen.value);
    app.sharedPassword.value = 'fixture-password'; await app.handleLogout(); await entering;
    assert.equal(app.sharedPassword.value, ''); assert.equal(app.sharedPasswordOpen.value, false);
    assert.equal(app.auth.value.token, null); assert.equal(requests.some(item => item.path.includes('/login/')), false);
  } finally { cleanup(); }
});

test('changing the destination cancels the pending form rather than forwarding its password', async () => {
  const app = mount();
  try {
    const entering = app.handleCreateSharedRoom(); await waitFor(() => app.sharedPasswordOpen.value);
    app.sharedPassword.value = 'fixture-password'; app.serverUrl.value = 'wss://other.invalid/ws';
    watchers.find(watcher => watcher.source === app.serverUrl).callback(app.serverUrl.value);
    await entering; await tick();
    assert.equal(app.sharedPassword.value, ''); assert.equal(app.sharedPasswordOpen.value, false);
    assert.equal(requests.some(item => item.path.includes('/login/')), false);
  } finally { cleanup(); }
});

test('a link-code response cannot reappear after closing the cabin or changing server', async () => {
  for (const action of ['close', 'server']) {
    const app = mount(); delayPath = '/api/wechat/account/link-code';
    try {
      const linking = app.handleLinkWechat(); await waitFor(() => app.sharedPasswordOpen.value);
      app.sharedPassword.value = 'fixture-password'; await app.handleSharedPasswordSubmit();
      await waitFor(() => releaseResponse);
      if (action === 'close') app.handleCloseUtilityDeck();
      else {
        app.serverUrl.value = 'wss://other.invalid/ws';
        watchers.find(watcher => watcher.source === app.serverUrl).callback(app.serverUrl.value);
      }
      releaseResponse(); await linking;
      assert.equal(app.accountLinkCode.value, '', action); assert.equal(app.accountLinkError.value, '', action);
      assert.equal(app.accountLinkBusy.value, false, action); noPasswordStored();
    } finally { cleanup(); }
  }
});

test('logout best-effort leave never renews a revoked shared session or asks for a password', async () => {
  let prompts = 0;
  const network = new CrossPlatformNetwork({ requestPasswordSession: async () => { prompts++; throw new Error('must not prompt'); },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'UNAUTHORIZED' }) }) });
  network.sharedActive = true; network.roomId = room.code;
  Object.assign(network.shared, { origin, room, token: 'revoked-fixture-token', expires: 0, webToken: 'old-web-token', webAuthMode: 'password' });
  try {
    await assert.rejects(network.leaveRoom({ bestEffort: true }), /UNAUTHORIZED/);
    assert.equal(prompts, 0);
  } finally { network.shared.stop(); }
});
