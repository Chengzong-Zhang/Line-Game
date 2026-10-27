// Actual bundled app, session, room validation and message handlers. Platform
// HTTP/socket responses are synthetic; no WeChat login or remote service is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'https://fixture.invalid';
const bubble = text => /^(蓝方|红方|Blue|Red) [👏😭😎🤝❓🤔💀👎😓😤]/u.test(text);

function harness({ language = 'zh', capable = true, status = 'playing' } = {}) {
  const storage = memoryStorage();
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'human' },
    playOptions: { hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60 } }));
  const wire = { room: null, requests: [], sockets: [], holdSend: false, held: [], status };
  class Socket {
    constructor() { this.sent = []; this.closed = false; setTimeout(() => { if (!this.closed) this.open?.(); }, 0); }
    onOpen(fn) { this.open = fn; }
    onMessage(fn) { this.receive = fn; }
    onError(fn) { this.error = fn; }
    onClose(fn) { this.closeEvent = fn; }
    send(options) {
      const data = JSON.parse(options.data); this.sent.push(data);
      if (data.protocol === 1) setTimeout(() => {
        if (!this.closed) void this.message({ type: 'room', room: plain(wire.room), ...(capable ? { capabilities: ['emote-v1'] } : {}) });
      }, 0);
      if (data.type === 'emote' && wire.holdSend) wire.held.push(options);
      else options.success?.();
    }
    message(data) { return this.receive({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const h = uiHarness({ language, storage, config: { onlineEnabled: true, apiBase: origin }, platformOverrides: {
    login: async () => 'synthetic-login-code',
    request: async options => {
      wire.requests.push(plain(options));
      if (options.url === `${origin}/api/wechat/login`) return { protocol: 1, token: 'synthetic-token', expiresIn: 3600,
        account: { uid: 'synthetic-user', linked: false } };
      if ([`${origin}/api/wechat/rooms`, `${origin}/api/wechat/rooms/ABCDEFGH`].includes(options.url)) return plain(wire.room);
      throw new Error('Unexpected fixture HTTP request');
    },
    connectSocket: () => { const socket = new Socket(); wire.sockets.push(socket); return socket; },
  } });
  return Object.assign(h, { wire });
}

async function ready(h) { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); }
async function enter(h) {
  await ready(h);
  const local = h.app.session;
  h.wire.room = { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
    status: h.wire.status, player: 'BLACK', currentPlayer: 'BLACK', actions: [], actionIds: [],
    stateHash: local.stateHash, settings: plain(local.settings),
    ready: { BLACK: false, WHITE: true }, members: { BLACK: true, WHITE: true }, rematchVotes: { BLACK: false, WHITE: false } };
  await h.tap('cabin-battle'); await h.scrollTo('friends'); await h.tap('friends');
  await until(() => h.app.session === h.app.online.game && h.app.online.connected && !h.app.session.busy);
  await h.render();
  assert.deepEqual(h.wire.sockets.at(-1).sent[0].capabilities, ['emote-v1']);
}
async function choosePoint(h) {
  h.app.tap(...sut.toScreen([1, 0], h.app.getLayout())); await h.render();
  assert.equal(h.app.getButtons().find(item => item.id === 'confirm')?.disabled, false, 'selected point can be confirmed');
}
const gameState = h => plain({ stateHash: h.app.session.stateHash, actions: h.app.session.actions,
  busy: h.app.session.busy, paused: h.app.session.paused, ready: h.app.online.room?.ready,
  sending: h.app.online.sending, pending: h.app.online.pending, error: h.app.online.error,
  roomSeq: h.app.online.room?.seq, roomHash: h.app.online.room?.stateHash, httpRequests: h.wire.requests.length });
const event = (h, extra = {}) => ({ id: '0123456789abcdef', emoji: '👏', player: 'WHITE',
  matchId: h.app.online.room.matchId, ...extra });
async function echo(h, extra = {}) {
  await h.wire.sockets.at(-1).message({ type: 'emote', emote: event(h, extra) }); await h.render();
}
async function confirmSamePoint(h) {
  let action;
  h.app.online.act = async value => { action = plain(value); return true; };
  await h.tap('confirm');
  assert.deepEqual(action, { type: 'move', point: [1, 0] }, 'the prior selected point is still the submitted move');
}

test('local reaction appears immediately, expires after two seconds, and preserves the selected move', async () => {
  const h = harness();
  try {
    await ready(h); await choosePoint(h); const before = gameState(h);
    await h.tap('emote-0'); await h.render();
    assert.ok(h.texts.includes('蓝方 👏'), 'bubble is distinct from the emoji toolbar label');
    assert.deepEqual(gameState(h), before); assert.equal(h.wire.requests.length, 0);
    assert.equal(h.app.getButtons().find(item => item.id === 'confirm').disabled, false);
    await pause(1000); await h.render(); assert.ok(h.texts.some(bubble), 'the reaction remains briefly visible');
    await pause(1100); await h.render(); assert.equal(h.texts.some(bubble), false);
    await h.tap('confirm'); await until(() => h.app.session.actions.length === 1 && !h.app.session.busy);
    assert.deepEqual(plain(h.app.session.actions[0].point), [1, 0]);
  } finally { h.app.dispose(); }
});

test('online reaction waits for server echo; transport success alone never displays a bubble or changes the game', async () => {
  const h = harness();
  try {
    await enter(h); await choosePoint(h); const before = gameState(h);
    await h.tap('emote-0'); await h.render();
    assert.equal(h.texts.some(bubble), false);
    assert.deepEqual(h.wire.sockets.at(-1).sent.at(-1), { type: 'emote', emoji: '👏', matchId: 'a'.repeat(32) });
    assert.deepEqual(gameState(h), before);
    await echo(h); assert.ok(h.texts.includes('红方 👏'));
    assert.deepEqual(gameState(h), before); assert.equal(h.p.messages.length, 0);
    await confirmSamePoint(h);
  } finally { h.app.dispose(); }
});

test('an older server leaves reaction controls disabled while preserving the playable selected move', async () => {
  const h = harness({ capable: false });
  try {
    await enter(h); await choosePoint(h); const before = gameState(h);
    const control = h.app.getButtons().find(item => item.id === 'emote-0');
    assert.equal(control.disabled, true);
    h.app.tap(control.x + control.width / 2, control.y + control.height / 2);
    await pause(10); await h.render();
    assert.equal(h.wire.sockets.at(-1).sent.length, 1); assert.equal(h.texts.some(bubble), false);
    assert.deepEqual(gameState(h), before); await confirmSamePoint(h);
  } finally { h.app.dispose(); }
});

for (const [language, message] of [['zh', '表情发送太快，稍等一下。'], ['en', 'Too many reactions. Try again shortly.']]) {
  test(`${language}: client and server rate feedback stays inline and leaves selection and game state intact`, async () => {
    const h = harness({ language });
    try {
      await enter(h); await choosePoint(h); const before = gameState(h);
      await h.tap('emote-0'); await h.tap('emote-1'); await h.render();
      assert.ok(h.texts.join('').includes(message));
      assert.equal(h.wire.sockets.at(-1).sent.filter(item => item.type === 'emote').length, 1);
      assert.deepEqual(gameState(h), before); assert.deepEqual(h.p.messages, []);
      await h.wire.sockets.at(-1).message({ type: 'emote_error', code: 'EMOTE_RATE_LIMIT' }); await h.render();
      assert.ok(h.texts.join('').includes(message)); assert.deepEqual(gameState(h), before);
      assert.equal(h.app.getButtons().find(item => item.id === 'confirm').disabled, false);
      await pause(2100); await h.render(); assert.equal(h.texts.join('').includes(message), false);
      assert.equal(h.texts.join('').includes('EMOTE_RATE_LIMIT'), false);
      // A later attempt can receive the same server limit code. Expiring its
      // previous notice must not suppress useful feedback for the new attempt.
      await h.tap('emote-0');
      await h.wire.sockets.at(-1).message({ type: 'emote_error', code: 'EMOTE_RATE_LIMIT' }); await h.render();
      assert.ok(h.texts.join('').includes(message), 'repeated server limit still has visible feedback');
      assert.deepEqual(gameState(h), before); await confirmSamePoint(h);
    } finally { h.app.dispose(); }
  });
}

test('rate feedback in the waiting room does not ready a player or change busy/pending flags', async () => {
  for (const busy of [false, true]) {
    const h = harness({ status: 'waiting' });
    try {
      await enter(h); h.app.session.busy = busy; await h.render(); const before = gameState(h);
      const readyDisabled = h.app.getButtons().find(item => item.id === 'room-ready').disabled;
      await h.wire.sockets.at(-1).message({ type: 'emote_error', code: 'EMOTE_RATE_LIMIT' }); await h.render();
      assert.ok(h.texts.join('').includes('表情发送太快，稍等一下。'), 'first server error actually reached the app');
      assert.deepEqual(gameState(h), before, 'feedback preserves the existing busy flag');
      assert.equal(h.app.getButtons().find(item => item.id === 'room-ready').disabled, readyDisabled);
      h.app.session.busy = false;
    } finally { h.app.dispose(); }
  }
});

test('reset, a new online match and backgrounding discard transient reaction displays', async () => {
  const local = harness();
  try {
    await ready(local); await local.tap('emote-0'); await local.render(); assert.ok(local.texts.some(bubble));
    await local.tap('new-game'); await until(() => !local.app.session.busy); await local.render();
    assert.equal(local.texts.some(bubble), false);
    await local.tap('emote-0'); local.p.callbacks.hide(); local.p.callbacks.show(); await local.render();
    assert.equal(local.texts.some(bubble), false);
  } finally { local.app.dispose(); }
  const online = harness();
  try {
    await enter(online); await echo(online); assert.ok(online.texts.some(bubble));
    online.wire.room = { ...online.wire.room, revision: 2, matchId: 'b'.repeat(32) };
    await online.wire.sockets.at(-1).message({ type: 'room', room: plain(online.wire.room) }); await online.render();
    assert.equal(online.texts.some(bubble), false);
    await echo(online); assert.ok(online.texts.some(bubble));
    online.p.callbacks.hide(); online.p.callbacks.show();
    await until(() => online.app.online.connected && !online.app.session.busy); await online.render();
    assert.equal(online.texts.some(bubble), false);
  } finally { online.app.dispose(); }
});

test('late send failure after backgrounding cannot resurrect a reaction or show a modal error', async () => {
  const h = harness();
  try {
    await enter(h); h.wire.holdSend = true; await h.tap('emote-0');
    assert.equal(h.wire.held.length, 1); assert.equal(h.texts.some(bubble), false);
    const oldSocket = h.wire.sockets.at(-1); h.p.callbacks.hide(); h.p.callbacks.show();
    await until(() => h.app.online.connected && !h.app.session.busy); await h.render();
    assert.notEqual(h.wire.sockets.at(-1), oldSocket);
    h.wire.held[0].fail(); await pause(10); await h.render();
    await oldSocket.message({ type: 'emote', emote: event(h) }); await h.render();
    assert.equal(h.texts.some(bubble), false); assert.deepEqual(h.p.messages, []);
    assert.equal(h.app.online.error, null);
    assert.equal(h.texts.join('').includes('NETWORK_ERROR'), false);
    assert.equal(h.texts.join('').includes('表情未发出，请稍后重试。'), false);
    assert.equal(h.texts.join('').includes('Reaction was not sent. Try again shortly.'), false);
  } finally { h.app.dispose(); }
});
