import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { OnlineClient, ONLINE_EMOTES } from '../src/online.js';
import { SharedRoomClient, SHARED_EMOTES } from '../../../web/web前端/SharedRoomClient.js';
import CrossPlatformNetwork from '../../../web/web前端/CrossPlatformNetwork.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const fixtureRoom = () => ({ code: 'ABCDEFGH', matchId: 'a'.repeat(32), status: 'playing', player: 'BLACK',
  currentPlayer: 'WHITE', actions: [], actionIds: [], stateHash: 'sha256:' + 'f'.repeat(64) });
const emote = extra => ({ id: '0123456789abcdef', emoji: '👏', player: 'WHITE', matchId: 'a'.repeat(32), ...extra });
class Socket {
  constructor() { this.handlers = new Map(); this.readyState = 0; this.sent = []; }
  addEventListener(name, callback) { this.handlers.set(name, [...(this.handlers.get(name) || []), callback]); }
  onOpen(callback) { this.addEventListener('open', callback); }
  onMessage(callback) { this.addEventListener('message', callback); }
  onError(callback) { this.addEventListener('error', callback); }
  onClose(callback) { this.addEventListener('close', callback); }
  async emit(name, event = {}) { for (const callback of this.handlers.get(name) || []) await callback(event); }
  async message(data) { await this.emit('message', { data: JSON.stringify(data) }); }
  send(value) {
    this.sent.push(JSON.parse(typeof value === 'string' ? value : value.data));
    value.success?.();
  }
  close() { this.readyState = 3; }
}
async function setup(kind, capable = true) {
  let socket;
  const writes = [], received = [], errors = [];
  const storage = { get() {}, set(...args) { writes.push(args); }, getItem() {}, setItem(...args) { writes.push(args); }, removeItem() {} };
  const scheduler = { cancel() {}, request() { throw new Error('Emotes must not request game Worker work'); } };
  const client = kind === 'Mini'
    ? new OnlineClient({ storage, connectSocket() { return socket = new Socket(); } },
      { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, scheduler)
    : new SharedRoomClient({ storage, WebSocket: class extends Socket { constructor() { super(); socket = this; } },
      onEmote: message => received.push(message), onError: error => errors.push(error.message), onEmoteError: error => errors.push(error.message) });
  Object.assign(client, { active: true, room: fixtureRoom(), token: 'synthetic-token', expires: Date.now() + 60000,
    origin: 'https://fixture.invalid', webToken: 'synthetic-web-token' });
  if (kind === 'Mini') client.onEmote = message => received.push(message);
  // Full room/rule verification is covered by existing suites. This fixture
  // isolates the actual connect/message handlers and observes no Worker/storage calls.
  client.receive = async room => { client.room = room; return true; };
  const connection = client.connect(); await tick();
  socket.readyState = 1; await socket.emit('open');
  assert.deepEqual(socket.sent[0].capabilities, ['emote-v1']);
  await socket.message({ type: 'room', room: fixtureRoom(), ...(capable ? { capabilities: ['emote-v1'] } : {}) });
  await connection;
  return { client, socket, writes, received, errors, close: () => kind === 'Mini' ? client.detach() : client.stop() };
}

test('fixed Mini/Web emotes match the mature Web toolbar and server allowlist', async () => {
  assert.deepEqual(ONLINE_EMOTES, SHARED_EMOTES);
  assert.equal(new Set(ONLINE_EMOTES).size, 10);
  const app = await fs.readFile(new URL('../../../web/web前端/OnlineApp.js', import.meta.url), 'utf8');
  const options = app.match(/const CHAT_EMOJI_OPTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
  const toolbar = [...options.matchAll(/content: "([^"\n]+)"/g)].map(match =>
    match[1].replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, wide, short) => String.fromCodePoint(parseInt(wide || short, 16))));
  assert.deepEqual(ONLINE_EMOTES, toolbar);
  const server = await fs.readFile(new URL('../../../web/web后端/wechat_online.py', import.meta.url), 'utf8');
  const declaration = server.match(/FIXED_EMOTES = frozenset\(\(([^\n]+)\)\)/)[1];
  assert.deepEqual(ONLINE_EMOTES, [...declaration.matchAll(/"([^"]+)"/g)].map(match => match[1]));
});

for (const kind of ['Mini', 'Web']) {
  test(`${kind}: older server without capability ack remains playable and sends no emote`, async () => {
    const fixture = await setup(kind, false);
    try {
      assert.equal(fixture.client.connected, true);
      assert.equal(fixture.client.canEmote(), false);
      await assert.rejects(fixture.client.sendEmote('👏'), /EMOTES_UNAVAILABLE/);
      assert.equal(fixture.socket.sent.length, 1);
      await fixture.socket.message({ type: 'pong' });
      assert.equal(fixture.client.connected, true);
      assert.deepEqual(fixture.writes, []);
    } finally { fixture.close(); }
  });

  test(`${kind}: fixed emote uses dedicated frame and no game/storage state`, async () => {
    const fixture = await setup(kind);
    try {
      const before = JSON.stringify(fixture.client.room);
      assert.equal(fixture.client.canEmote(), true);
      assert.equal(await fixture.client.sendEmote('👏'), true);
      assert.deepEqual(fixture.socket.sent[1], { type: 'emote', emoji: '👏', matchId: 'a'.repeat(32) });
      await assert.rejects(fixture.client.sendEmote('🤝'), /EMOTE_RATE_LIMIT/);
      await assert.rejects(fixture.client.sendEmote('free text'), /INVALID_EMOTE/);
      await fixture.socket.message({ type: 'emote', emote: emote() });
      assert.deepEqual(fixture.received, [emote()]);
      assert.deepEqual(fixture.client.lastEmote, emote());
      assert.equal(JSON.stringify(fixture.client.room), before);
      assert.equal(fixture.client.pending, null);
      assert.deepEqual(fixture.writes, []);
      assert.equal(fixture.client.connected, true);
      assert.equal(fixture.socket.sent.length, 2);
    } finally { fixture.close(); }
  });

  test(`${kind}: malformed/stale/duplicate events are ignored and rate feedback does not break play`, async () => {
    const fixture = await setup(kind);
    try {
      for (const invalid of [emote({ matchId: 'b'.repeat(32) }), emote({ emoji: 'free text' }),
        emote({ id: 'untrusted-user-text' }), emote({ player: 'PURPLE' })]) {
        await fixture.socket.message({ type: 'emote', emote: invalid });
      }
      assert.deepEqual(fixture.received, []);
      await fixture.socket.message({ type: 'emote', emote: emote() });
      await fixture.socket.message({ type: 'emote', emote: emote() });
      assert.equal(fixture.received.length, 1);
      await fixture.socket.message({ type: 'emote_error', code: 'EMOTE_RATE_LIMIT' });
      assert.equal(fixture.client.emoteError, 'EMOTE_RATE_LIMIT');
      assert.equal(fixture.client.connected, true);
      if (kind === 'Mini') assert.equal(fixture.client.error, null);
      await fixture.socket.message({ type: 'room', room: fixtureRoom() });
      assert.equal(fixture.client.emotesSupported, true);
      fixture.client.closeSocket();
      assert.equal(fixture.client.emotesSupported, false);
      assert.equal(fixture.client.lastEmote, null);
    } finally { fixture.close(); }
  });
}

test('CrossPlatformNetwork maps shared emotes to established Web CHAT_EMOJI without arbitrary metadata', async () => {
  const network = new CrossPlatformNetwork();
  const received = [];
  network.sharedActive = true; network.roomId = 'ABCDEFGH';
  network.on('chat_emoji', message => received.push(message));
  network.shared.emotesSupported = true; network.shared.room = fixtureRoom();
  network.shared.receiveEmote(emote());
  assert.deepEqual(received, [{ type: 'chat_emoji', sender: 'ABCDEFGH:WHITE', color: 'WHITE', content: '👏',
    metadata: { seed: '0123456789abcdef', animation: 'bounce', duration: 1200 } }]);
  let sent;
  network.shared.sendEmote = async value => { sent = value; return true; };
  assert.equal(await network.sendChatEmoji('🤝', { arbitrary: 'never forwarded' }), true);
  assert.equal(sent, '🤝');
  network.shared.stop();
});
