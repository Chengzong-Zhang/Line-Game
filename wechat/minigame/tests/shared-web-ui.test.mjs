import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const frontend = process.env.LIFELINE_WEB_TEST_ROOT
  ? pathToFileURL(path.resolve(process.env.LIFELINE_WEB_TEST_ROOT) + path.sep)
  : new URL('../../../web/web前端/', import.meta.url);
const { default: GameEngine } = await import(new URL('GameEngine.js', frontend));
const { default: GameController } = await import(new URL('GameController.js', frontend));
const { canonicalize, serializeRuleState } = await import(new URL('ReplayCodec.js', frontend));
const { default: CrossPlatformNetwork } = await import(new URL('CrossPlatformNetwork.js', frontend));

// Run real Web handlers and controller guards; only the Vue scheduler, DOM and
// transport are fixtures. This is not a browser layout or real-service claim.
const noop = () => {}, values = new Map(), unmounts = [], watchers = [], wire = [];
let fetchMode = 'disabled', linkedResolve, room;
let emoteCapability = false;
globalThis.location = new URL('http://localhost:8000/');
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = globalThis.removeEventListener = noop;
globalThis.Vue = {
  ref: value => ({ value }), shallowRef: value => ({ value }),
  computed: read => ({ get value() { return read(); } }),
  watch: (source, callback) => watchers.push({ source, callback }),
  nextTick: async () => {}, onMounted: noop, onBeforeUnmount: callback => unmounts.push(callback),
};
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  wire.push({ url, body });
  if (fetchMode === 'offline') throw new Error('NETWORK_ERROR');
  if (fetchMode === 'disabled') return { ok: false, json: async () => ({ detail: 'ONLINE_NOT_CONFIGURED' }) };
  if (url.endsWith('/status')) return { ok: true, json: async () => ({ enabled: true, webLogin: true, webAuthMode: 'legacy-jwt' }) };
  if (url.endsWith('/account/link-code')) {
    if (fetchMode === 'delayed-link') return new Promise(resolve => { linkedResolve = resolve; });
    return { ok: true, json: async () => ({ code: 'FIXTURE-LINK-CODE', expiresIn: 300 }) };
  }
  if (url.endsWith('/login/web')) return { ok: true, json: async () => ({ token: 'fixture-shared-token', expiresIn: 3600, protocol: 1, account: { uid: 'fixture-user' } }) };
  if (url.endsWith('/ready')) room = { ...room, revision: room.revision + 1, status: 'playing', ready: { BLACK: true, WHITE: true } };
  return { ok: true, json: async () => room };
};
class FixtureSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    FixtureSocket.instances.push(this);
    this.url = url; this.readyState = 0; this.handlers = new Map();
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(type, handler) { const set = this.handlers.get(type) || new Set(); set.add(handler); this.handlers.set(type, set); }
  emit(type, payload) { for (const handler of this.handlers.get(type) || []) handler(payload); }
  send(raw) {
    const payload = JSON.parse(raw); wire.push({ socket: this.url, payload });
    let response;
    if (payload.protocol === 1) response = { type: 'room', room, ...(emoteCapability ? { capabilities: ['emote-v1'] } : {}) };
    else if (payload.type === 'ping') response = this.url.includes('/api/wechat/') ? { type: 'pong' } : { type: 'PONG' };
    else if (payload.type === 'create_room' || payload.type === 'join_room') response = {
      type: payload.type === 'create_room' ? 'ROOM_CREATED' : 'ROOM_JOINED',
      roomId: payload.roomId || '2345', playerId: 'legacy-player', color: 'BLACK', yourColor: 'BLACK',
      status: 'WAITING', matchPhase: 'WAITING_FOR_PLAYERS', players: [],
      settings: { gridSize: 7, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2' },
    };
    if (response) queueMicrotask(() => this.emit('message', { data: JSON.stringify(response) }));
  }
  close(code = 1000) { this.readyState = 3; queueMicrotask(() => this.emit('close', { code, reason: 'fixture', wasClean: true })); }
}
globalThis.WebSocket = FixtureSocket;
const { default: App } = await import(new URL('OnlineApp.js', frontend));

function mount() {
  values.clear(); wire.length = 0; watchers.length = 0; unmounts.length = 0;
  FixtureSocket.instances.length = 0; emoteCapability = false;
  values.set('triaxis-auth', JSON.stringify({ token: 'fixture-web-token', username: 'fixture-user' }));
  const app = App.setup();
  app.tutorialActive.value = false; // Network actions occur after leaving onboarding.
  return app;
}
function cleanup() { for (const dispose of unmounts.splice(0)) dispose(); }
function freshRoom() {
  const settings = { gridSize: 7, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2' };
  const engine = new GameEngine(settings), snapshot = engine.getSnapshot();
  return {
    protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
    actions: [], actionIds: [], player: 'BLACK', currentPlayer: 'BLACK', status: 'waiting',
    settings, ready: { BLACK: false, WHITE: false }, members: { BLACK: true, WHITE: false },
    rematchVotes: { BLACK: false, WHITE: false }, gameOver: false, winner: snapshot.winner,
    scores: { BLACK: snapshot.territories.BLACK.area, WHITE: snapshot.territories.WHITE.area },
    stateHash: `sha256:${createHash('sha256').update(canonicalize(serializeRuleState(engine))).digest('hex')}`,
  };
}

async function attachController(app) {
  const settings = { gridSize: 7, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2', hintEnabled: false };
  const controller = Object.assign(Object.create(GameController.prototype), {
    canvas: { style: {}, setAttribute: noop }, options: { engine: settings }, engine: new GameEngine(settings),
    renderer: { invalidate: noop, render: noop, clearHintPoint: noop }, _engineEpoch: 0,
    _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, multiplayerEnabled: false,
    localPlayer: null, roomReady: false, opponentConnected: false, networkManager: null,
    lastAction: null, _networkUnsubscribers: [], _authoritativeSnapshotValid: true,
    stateChangeListener: app.handleStateChange,
  });
  app.tutorialActive.value = true;
  app.handleControllerReady(controller); await app.skipTutorial();
  return controller;
}

test('failed shared authentication rolls back transport mode and actual Web buttons can create and join legacy rooms', async () => {
  fetchMode = 'disabled'; const app = mount();
  try {
    await app.handleCreateSharedRoom();
    assert.match(app.networkError.value, /尚未启用|not enabled/);
    assert.equal(app.session.value.shared, false);
    await app.handleCreateRoom();
    assert.equal(app.session.value.roomId, '2345'); assert.equal(app.session.value.shared, false);
    assert.ok(wire.some(item => item.payload?.type === 'create_room'));
    await app.handleLeaveRoom();
    app.roomIdInput.value = '3456'; await app.handleJoinRoom();
    assert.equal(app.session.value.roomId, '3456');
    assert.ok(wire.some(item => item.payload?.type === 'join_room' && item.payload.roomId === '3456'));
  } finally { cleanup(); }
});

test('legacy mode cannot silently replace an active shared room', () => {
  const network = new CrossPlatformNetwork({ storage: {} });
  network.sharedActive = true; network.roomId = 'ABCDEFGH';
  assert.throws(() => network.selectLegacy(), /LEAVE_ROOM_FIRST/);
  assert.equal(network.sharedActive, true); assert.equal(network.roomId, 'ABCDEFGH');
  network.roomId = null; network.selectLegacy(); assert.equal(network.sharedActive, false);
  network.disconnect();
});

test('8-character code joins through real Web handlers and offline logout still removes local account and room context', async () => {
  fetchMode = 'online'; room = freshRoom(); const app = mount();
  try {
    app.roomIdInput.value = ' abcdefgh '; await app.handleJoinRoom();
    assert.equal(app.session.value.roomId, 'ABCDEFGH'); assert.equal(app.session.value.shared, true);
    assert.equal(app.session.value.connected, true);
    assert.ok(wire.some(item => item.url?.endsWith('/rooms/join') && item.body.code === 'ABCDEFGH'));
    fetchMode = 'offline'; await app.handleLogout();
    assert.equal(app.auth.value.token, null); assert.equal(app.session.value.roomId, null);
    assert.equal(app.authBusy.value, false); assert.equal(app.session.value.connected, false);
    for (const watcher of watchers) if (watcher.source === app.auth) watcher.callback(app.auth.value);
    assert.equal(values.has('triaxis-auth'), false);
  } finally { cleanup(); }
});

test('shared resign guard follows server turn permissions while completed rematches and legacy resign remain available', () => {
  const controller = Object.assign(Object.create(GameController.prototype), {
    multiplayerEnabled: true, _authoritativeSnapshotValid: true, roomReady: true,
    opponentConnected: true, localPlayer: 'BLACK',
    networkManager: { serverAuthoritative: true, canAct: () => false, isConnected: () => true, sendReset() {} },
  });
  assert.equal(controller._getResetLockReason({ gameOver: false }), 'NOT_YOUR_TURN');
  assert.equal(controller._getResetLockReason({ gameOver: true }), null);
  controller.networkManager.canAct = () => true;
  assert.equal(controller._getResetLockReason({ gameOver: false }), null);
  controller.networkManager.serverAuthoritative = false; controller.networkManager.canAct = () => false;
  assert.equal(controller._getResetLockReason({ gameOver: false }), null);
});

test('a one-time link-code response from the old Web account cannot populate the new account panel', async () => {
  fetchMode = 'delayed-link'; const app = mount();
  try {
    const pending = app.handleLinkWechat();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof linkedResolve, 'function');
    app.auth.value = { token: 'fixture-other-web-token', username: 'second-user' };
    linkedResolve({ ok: true, json: async () => ({ code: 'OLD-ACCOUNT-CODE', expiresIn: 300 }) });
    await pending;
    assert.equal(app.accountLinkCode.value, ''); assert.equal(app.accountLinkError.value, '');
    assert.equal(app.accountLinkBusy.value, false);
  } finally { cleanup(); }
});

test('resuming a playing shared room refreshes visible skip/resign guards after the socket is accepted', async () => {
  fetchMode = 'online'; room = freshRoom();
  room.status = 'playing'; room.members.WHITE = true; room.ready.BLACK = room.ready.WHITE = true;
  const app = mount();
  try {
    const controller = await attachController(app);
    app.roomIdInput.value = 'ABCDEFGH'; await app.handleJoinRoom();
    assert.equal(app.session.value.connected, true);
    assert.equal(controller._getInteractionLockReason(), null, 'the live network permits this turn');
    assert.equal(app.gameState.value.skipLocked, false, 'the displayed skip button must match the accepted connection');
    assert.equal(app.gameState.value.resetLocked, false, 'the displayed resign button must match the accepted connection');
  } finally { cleanup(); }
});

test('the final ready response unlocks Web controls after its command finishes', async () => {
  fetchMode = 'online'; room = freshRoom(); room.members.WHITE = true; room.ready.WHITE = true;
  const app = mount();
  try {
    const controller = await attachController(app);
    app.roomIdInput.value = 'ABCDEFGH'; await app.handleJoinRoom();
    await app.handleToggleReady(true);
    assert.equal(app.roomStatus.value, 'inProgress');
    assert.equal(controller._getInteractionLockReason(), null);
    assert.equal(app.gameState.value.skipLocked, false);
    assert.equal(app.gameState.value.resetLocked, false);
  } finally { cleanup(); }
});

test('the manual connect button restores a disconnected shared-room socket instead of only authenticating', async () => {
  fetchMode = 'online'; room = freshRoom();
  room.status = 'playing'; room.members.WHITE = true; room.ready.BLACK = room.ready.WHITE = true;
  const app = mount();
  try {
    const controller = await attachController(app);
    app.roomIdInput.value = 'ABCDEFGH'; await app.handleJoinRoom();
    controller.networkManager.shared.socket.close(1006);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.networkManager.isConnected(), false);
    await app.handleConnect();
    assert.equal(controller.networkManager.isConnected(), true, 'Connect must restore a socket for the current room');
    assert.equal(app.session.value.connected, true);
    assert.equal(app.gameState.value.skipLocked, false);
  } finally { cleanup(); }
});

test('production multiplayer and Bot room creation retain the current settings draft', async context => {
  fetchMode = 'online'; room = freshRoom(); const app = mount();
  try {
    if (!app.selectedRoomBotCount) return context.skip('This older frontend does not have production Bot seats.');
    app.selectedPlayerCount.value = 6; app.selectedGridSize.value = 13;
    app.selectedStartPlayer.value = 'GREEN'; app.selectedRoomBotCount.value = 3;
    await app.handleCreateRoom();
    const request = wire.find(item => item.payload?.type === 'create_room').payload;
    assert.equal(request.settings.playerCount, 6); assert.equal(request.settings.botCount, 3);
    assert.equal(request.settings.gridSize, 13); assert.equal(request.settings.startPlayer, 'GREEN');
    assert.equal(app.session.value.shared, false);
  } finally { cleanup(); }
});

test('production shared-room creation keeps one AI seat when a multiplayer AI draft is selected', async context => {
  fetchMode = 'online'; room = freshRoom(); const app = mount();
  try {
    if (!app.selectedRoomBotCount) return context.skip('This older frontend does not have independent settings drafts.');
    app.selectedPlayerCount.value = 6; app.selectedGridSize.value = 13;
    app.selectedRoomBotCount.value = 3; app.selectedStartPlayer.value = 'GREEN';
    await app.handleCreateSharedRoom();
    const request = wire.find(item => item.url?.endsWith('/rooms'));
    assert.deepEqual(request.body, { playerCount: 2, boardShape: 'triangle', gridSize: 13, startPlayer: 'BLACK', rulesVersion: 'territory-v3', turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: false, hintMaxCount: 1, undoEnabled: false, undoMaxCount: 3, botCount: 1 });
    assert.equal(app.session.value.shared, true);
    assert.equal(app.roomInfo.value.settings.playerCount, 2);
    assert.equal(app.roomInfo.value.settings.botCount || 0, 0);
  } finally { cleanup(); }
});

test('shared emotes stay disabled with an old server and while disconnected', async () => {
  fetchMode = 'online'; room = freshRoom(); const app = mount();
  try {
    app.roomIdInput.value = 'ABCDEFGH'; await app.handleJoinRoom();
    assert.equal(app.chatEmojiDisabled.value, true);
    await app.handleChatEmoji({ content: '👏' });
    assert.equal(app.chatEmojiBursts.value.length, 0);
    assert.equal(wire.some(item => item.payload?.type === 'emote'), false);
    FixtureSocket.instances.at(-1).close(1006);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.chatEmojiDisabled.value, true);
  } finally { cleanup(); }
});

test('shared emotes show only the confirmed server echo and rate-limit errors leave gameplay connected', async () => {
  fetchMode = 'online'; room = freshRoom(); const app = mount(); emoteCapability = true;
  try {
    app.roomIdInput.value = 'ABCDEFGH'; await app.handleJoinRoom();
    assert.equal(app.chatEmojiDisabled.value, false);
    await app.handleChatEmoji({ content: '👏' });
    assert.equal(app.chatEmojiBursts.value.length, 0, 'socket send must not pretend that the server accepted it');
    assert.deepEqual(wire.find(item => item.payload?.type === 'emote').payload,
      { type: 'emote', emoji: '👏', matchId: room.matchId });
    const socket = FixtureSocket.instances.at(-1);
    const frame = { type: 'emote', emote: { id: '1234567890abcdef', emoji: '👏', player: 'BLACK', matchId: room.matchId } };
    socket.emit('message', { data: JSON.stringify(frame) });
    assert.equal(app.chatEmojiBursts.value.length, 1, 'own server echo is displayed exactly once');
    socket.emit('message', { data: JSON.stringify(frame) });
    assert.equal(app.chatEmojiBursts.value.length, 1);
    await app.handleChatEmoji({ content: '🤝' });
    assert.match(app.networkError.value, /太快|too quickly/);
    assert.equal(wire.filter(item => item.payload?.type === 'emote').length, 1);
    app.language.value = 'en';
    socket.emit('message', { data: JSON.stringify({ type: 'emote_error', code: 'EMOTE_RATE_LIMIT' }) });
    assert.match(app.networkError.value, /too quickly/);
    assert.equal(app.session.value.connected, true);
    socket.close(1006); await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.chatEmojiDisabled.value, true);
    await app.handleChatEmoji({ content: '👏' });
    assert.equal(wire.filter(item => item.payload?.type === 'emote').length, 1);
  } finally { cleanup(); }
});

test('local emotes remain immediate without a room', async () => {
  const app = mount();
  try {
    assert.equal(app.chatEmojiDisabled.value, false);
    await app.handleChatEmoji({ content: '👏' });
    assert.equal(app.chatEmojiBursts.value.length, 1);
    assert.equal(wire.some(item => item.payload?.type === 'emote'), false);
  } finally { cleanup(); }
});
