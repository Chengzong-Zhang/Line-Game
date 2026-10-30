import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage, plain, localScheduler } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

async function dragOrder(h, player, target) {
  await h.scrollTo(`order-${player}`); await h.render();
  const from = h.app.getButtons().find(button => button.id === `order-${player}`);
  const to = h.app.getButtons().find(button => button.id === `order-${target}`);
  assert.ok(from && to && !from.disabled && !to.disabled);
  const pt = box => ({ clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  h.p.callbacks.start({ touches: [pt(from)] }); h.p.callbacks.end({ touches: [], changedTouches: [pt(from)] });
  await h.render();
  h.p.callbacks.start({ touches: [pt(from)] }); h.p.callbacks.move({ touches: [pt(to)] });
  h.p.callbacks.end({ touches: [], changedTouches: [pt(to)] }); await h.render();
}

const config = { onlineEnabled: true, apiBase: 'https://rooms.invalid' };
const setup = { size: 8, playerCount: 6, boardShape: 'hexagon', mode: 'human', difficulty: 'normal', startPlayer: 'PURPLE',
  startingPointMode: 'random', controllers: { BLACK: 'multiplayer-easy-v1', WHITE: 'human', PURPLE: 'multiplayer-hard-v1',
    GREEN: 'human', ORANGE: 'hex-player-policy-v1', CYAN: 'multiplayer-medium-v1' },
  playOptions: { turnTimerEnabled: true, turnTimeLimitSeconds: 45, hintEnabled: true, hintMaxCount: 4, undoEnabled: true, undoMaxCount: 5 } };
const ready = h => until(() => h.app.session.snapshot && !h.app.session.busy);

test('single creation window reuses all board settings with interleaved humans and AI, including six seats', async () => {
  const storage = memoryStorage(); sut.savePreferences(storage, setup);
  const h = uiHarness({ config, storage }); const created = [];
  h.app.online.enter = async (...args) => { created.push(args); return true; };
  try {
    await ready(h); const local = h.app.session, hash = local.stateHash;
    await h.tap('cabin-battle'); await h.scrollTo('friends');
    assert.equal(h.app.getButtons().some(button => button.id === 'create-ai-room'), false);
    await h.tap('friends'); assert.equal(h.app.getCabin(), 'board');
    assert.equal(created.length, 0);
    await dragOrder(h, 'BLACK', 'GREEN');
    const expectedOrder = ['PURPLE', 'BLACK', 'GREEN', 'ORANGE', 'CYAN', 'WHITE'];
    for (const id of ['player-count', 'controller-WHITE', 'controller-CYAN', 'shape-triangle', 'topology-custom', 'clock-enabled', 'hint-count', 'undo-count']) {
      await h.scrollTo(id); assert.ok(h.app.getButtons().some(button => button.id === id && !button.disabled), id);
    }
    assert.equal(local.stateHash, hash, 'configuring the room retains the local match');
    await h.scrollTo('room-submit'); await h.tap('room-submit'); await until(() => created.length);
    const [kind, settings] = created[0];
    assert.equal(kind, 'create'); assert.equal(settings.playerCount, 6); assert.equal(settings.startPlayer, 'PURPLE');
    assert.deepEqual(settings.turnOrder, expectedOrder);
    assert.equal(settings.gridSize, 8); assert.equal(settings.boardShape, 'hexagon'); assert.equal(settings.botCount, 4);
    assert.deepEqual(Object.keys(settings.playerSetup), sut.playerIds(6));
    assert.equal(settings.playerSetup.BLACK.choice, 'ai-easy'); assert.equal(settings.playerSetup.WHITE.choice, 'human');
    assert.equal(settings.playerSetup.PURPLE.choice, 'ai-hard'); assert.equal(settings.playerSetup.GREEN.choice, 'human');
    assert.equal(settings.playerSetup.CYAN.choice, 'ai-medium');
    assert.equal(settings.startingPointMode, 'random');
    assert.equal(new Set(Object.values(settings.initialPositions).map(point => point.join(','))).size, 6);
    for (const [key, value] of Object.entries(setup.playOptions)) assert.equal(settings[key], value, key);
    assert.equal(local.stateHash, hash);
  } finally { h.app.dispose(); }
});

test('an all-AI local board visibly reserves a human host in the creation draft', async () => {
  const storage = memoryStorage();
  sut.savePreferences(storage, { ...setup, controllers: Object.fromEntries(sut.playerIds(6).map(player => [player, 'multiplayer-easy-v1'])) });
  const h = uiHarness({ config, storage }); let created;
  h.app.online.enter = async (kind, settings) => { created = settings; return true; };
  try {
    await until(() => h.app.session.snapshot); h.app.session.pause(); await h.tap('friends'); await h.render();
    assert.ok(h.texts.some(text => text.includes('已将第一席改为真人')));
    await h.scrollTo('controller-BLACK'); assert.ok(h.texts.some(text => text.includes('蓝方') && text.includes('真人')));
    await h.scrollTo('room-submit'); await h.tap('room-submit'); await until(() => created);
    assert.equal(created.playerSetup.BLACK.choice, 'human'); assert.equal(created.botCount, 5);
    assert.equal(sut.readPreferences(storage).controllers.BLACK, 'multiplayer-easy-v1');
  } finally { h.app.dispose(); }
});

test('live room edits use pending settings and keep the current match and room invitation', async () => {
  const h = uiHarness({ config }); const saved = [];
  const settings = { ...sut.settingsFor(7, 4), boardShape: 'hexagon', startingPointMode: 'default',
    playerSetup: { BLACK: { choice: 'ai-easy' }, WHITE: { choice: 'human' }, PURPLE: { choice: 'ai-hard' }, GREEN: { choice: 'human' } },
    botCount: 2, undoEnabled: true, undoMaxCount: 3 };
  h.app.online.enter = async () => {
    const client = h.app.online;
    await client.game.load(settings, [], { mode: 'human', paused: true, save: false });
    client.active = client.connected = true;
    client.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0, stateHash: client.game.stateHash, actions: [],
      player: 'WHITE', hostPlayer: 'WHITE', status: 'playing', currentPlayer: 'BLACK', settings: plain(settings),
      pendingSettings: { ...plain(settings), gridSize: 9 }, bots: ['BLACK', 'PURPLE'], ready: {}, rematchVotes: {} };
    client.notify(); return true;
  };
  h.app.online.updateSettings = async value => { saved.push(value); h.app.online.room.pendingSettings = value; return true; };
  try {
    await ready(h); await h.tap('friends'); await h.tap('room-submit'); await until(() => h.app.online.room);
    const room = h.app.online.room, game = h.app.session, hash = game.stateHash;
    await h.tap('cabin-board'); await h.scrollTo('board-size');
    assert.ok(h.texts.some(text => text.includes('9')));
    await h.slide('board-size', 10, 5, 15); await h.scrollTo('starts-random'); await h.tap('starts-random'); await h.tap('starts-save');
    assert.equal(saved.length, 0); assert.equal(game.stateHash, hash); assert.equal(game.settings.gridSize, 7);
    await h.scrollTo('room-submit'); await h.tap('room-submit');
    assert.equal(saved.length, 1); assert.equal(saved[0].gridSize, 10); assert.equal(saved[0].playerCount, 4);
    assert.equal(saved[0].playerSetup.WHITE.choice, 'human'); assert.equal(saved[0].playerSetup.PURPLE.choice, 'ai-hard');
    assert.equal(room.code, 'ABCDEFGH'); assert.equal(room.matchId, 'a'.repeat(32));
    assert.equal(game.stateHash, hash); assert.equal(game.settings.gridSize, 7);
    await h.tap('cabin-board'); await h.scrollTo('board-size');
    assert.ok(h.texts.some(text => text.includes('10')), 'reopening shows the saved next-game draft');
  } finally { h.app.dispose(); }
});

test('custom room roots use every configured seat and remain isolated from the local match', async () => {
  const storage = memoryStorage(); sut.savePreferences(storage, setup);
  const h = uiHarness({ config, storage }); let settings;
  h.app.online.enter = async (kind, value) => { settings = value; return true; };
  try {
    await ready(h); const local = h.app.session, hash = local.stateHash;
    await h.tap('friends'); await h.scrollTo('topology-custom'); await h.tap('topology-custom');
    assert.equal(h.app.getScene(), 'board-editor');
    assert.ok(h.app.getButtons().some(button => button.id === 'editor-player-CYAN'));
    const layout = h.app.getEditorLayout();
    assert.ok(layout);
    const original = Object.fromEntries(sut.playerIds(6).map(player => [player, layout.points.find(point => point.owner === player)?.coordinate]));
    assert.ok(Object.values(original).every(point => Array.isArray(point)), 'each color retains an identifiable root');
    const black = layout.points.find(point => point.owner === 'BLACK');
    const point = layout.points.find(candidate => !candidate.owner && !Object.values(original).some(root => root.join(',') === candidate.coordinate.join(',')));
    assert.ok(black && point); h.app.tap(black.x, black.y); await h.render(); h.app.tap(point.x, point.y); await h.render();
    await h.tap('editor-save');
    assert.equal(h.app.getCabin(), 'board');
    assert.equal(local.stateHash, hash);
    await h.scrollTo('room-submit'); await h.tap('room-submit'); await until(() => settings);
    assert.equal(settings.playerCount, 6); assert.equal(settings.startingPointMode, 'custom');
    assert.deepEqual(settings.initialPositions.BLACK, point.coordinate);
    for (const player of sut.playerIds(6).slice(1)) assert.deepEqual(settings.initialPositions[player], original[player]);
    assert.equal(Object.keys(settings.initialPositions).length, 6);
    assert.equal(sut.readPreferences(storage).startingPointMode, 'random', 'room draft does not replace local preferences');
  } finally { h.app.dispose(); }
});

test('room validation and host permissions support every active seat and reject inactive seats', () => {
  const settings = { ...sut.settingsFor(7, 6), boardShape: 'hexagon' };
  const room = { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
    status: 'playing', player: 'CYAN', hostPlayer: 'CYAN', currentPlayer: 'PURPLE', settings,
    actions: [], actionIds: [], stateHash: 'sha256:' + 'f'.repeat(64), ready: {}, members: {}, rematchVotes: {},
    bots: ['BLACK', 'PURPLE'], undo: { usedCount: 0, pending: true, votes: ['CYAN', 'GREEN'] } };
  assert.equal(sut.validateRoom(room), room);
  const client = new sut.OnlineClient({ storage: memoryStorage() }, config, { cancel() {} });
  Object.assign(client, { active: true, room });
  for (const status of ['waiting', 'playing', 'finished']) { room.status = status; assert.equal(client.canEditSettings(), true); }
  room.player = 'WHITE'; assert.equal(client.canEditSettings(), false);
  assert.throws(() => sut.validateRoom({ ...room, currentPlayer: 'INVALID' }), /INVALID_ROOM/);
  assert.throws(() => sut.validateRoom({ ...room, undo: { usedCount: 0, pending: true, votes: ['PURPLE'] } }), /INVALID_ROOM/);
  assert.throws(() => sut.validateRoom({ ...room, settings: { ...settings, playerCount: 2 } }), /INVALID_ROOM/);
});

test('online hints preserve the per-match allowance after authoritative position updates', async () => {
  const scheduler = localScheduler(), client = new sut.OnlineClient({ storage: memoryStorage() }, config, scheduler);
  const settings = { ...sut.settingsFor(5), hintEnabled: true, hintMaxCount: 2 };
  const makeRoom = actions => ({ protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: actions.length + 1,
    seq: actions.length, status: 'playing', player: 'BLACK', currentPlayer: 'BLACK', settings,
    actions, actionIds: actions.map((_, index) => `action-${index}`), stateHash: sut.ruleView(sut.restoreGame(settings, actions)).stateHash,
    ready: {}, members: {}, rematchVotes: {}, bots: [] });
  try {
    client.active = client.connected = true; await client.receive(makeRoom([]));
    assert.equal(await client.hint(), true); assert.equal(client.game.hintsUsed, 1); assert.equal(client.game.paused, true);
    await client.receive(makeRoom([{ type: 'move', player: 'BLACK', point: [1, 0] }, { type: 'move', player: 'WHITE', point: [3, 0] }]));
    assert.equal(client.game.hintsUsed, 1); assert.equal(client.game.hintsRemaining, 1);
    assert.equal(await client.hint(), true); assert.equal(client.game.hintsRemaining, 0);
    assert.equal(await client.hint(), false);
  } finally { client.detach(); scheduler.cancel(); }
});

test('enabling hints in an existing zero-budget room repairs the draft before rendering or saving', async () => {
  const h = uiHarness({ config }), saved = [];
  const settings = { ...sut.settingsFor(7), hintEnabled: false, hintMaxCount: 0, botCount: 0,
    playerSetup: { BLACK: { choice: 'human' }, WHITE: { choice: 'human' } } };
  h.app.online.enter = async () => {
    const client = h.app.online;
    await client.game.load(settings, [], { mode: 'human', paused: true, save: false });
    Object.assign(client, { active: true, connected: true, room: { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0,
      stateHash: client.game.stateHash, actions: [], player: 'BLACK', hostPlayer: 'BLACK', status: 'waiting',
      currentPlayer: 'BLACK', settings: plain(settings), pendingSettings: null, bots: [], ready: {}, rematchVotes: {} } });
    client.notify(); return true;
  };
  h.app.online.updateSettings = async value => { saved.push(value); return true; };
  try {
    await ready(h); await h.tap('friends'); await h.tap('room-submit'); await until(() => h.app.online.room);
    await h.tap('cabin-board'); await h.scrollTo('hint-enabled'); await h.tap('hint-enabled'); await h.render();
    assert.equal(h.app.getButtons().find(button => button.id === 'hint-enabled').disabled, false);
    assert.ok(h.app.getButtons().some(button => button.id === 'hint-count'));
    await h.scrollTo('room-submit'); await h.tap('room-submit');
    assert.equal(saved.length, 1); assert.equal(saved[0].hintEnabled, true); assert.equal(saved[0].hintMaxCount, 1);
    assert.equal(h.app.online.room.settings.hintEnabled, false, 'the room remains authoritative until its acknowledgement');
    assert.equal(h.app.online.room.settings.hintMaxCount, 0);
  } finally { h.app.dispose(); }
});

test('room AI failures and fallback actions are visible and retry preserves the room', async () => {
  const h = uiHarness({ config }); let refreshes = 0;
  h.app.online.enter = async () => {
    const client = h.app.online, settings = { ...sut.settingsFor(7), playerSetup: { BLACK: { choice: 'minimax' }, WHITE: { choice: 'human' } } };
    await client.game.load(settings, [], { mode: 'human', paused: true, save: false });
    Object.assign(client, { active: true, connected: true, room: { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0,
      status: 'playing', player: 'WHITE', hostPlayer: 'WHITE', currentPlayer: 'BLACK', bots: ['BLACK'], actions: [],
      stateHash: client.game.stateHash, settings, ready: {}, rematchVotes: {},
      lastBotResult: { success: false, matchId: 'a'.repeat(32), seq: 0, color: 'BLACK', reason: 'AI_UNAVAILABLE' } } });
    client.notify(); return true;
  };
  h.app.online.refresh = async () => { refreshes++; return true; };
  h.app.online.connect = async () => {};
  try {
    await ready(h); await h.tap('friends'); await h.tap('room-submit'); await until(() => h.app.online.room); await h.render();
    assert.ok(h.texts.some(text => text.includes('AI 暂未完成行动')));
    await h.tap('room-retry'); assert.equal(refreshes, 1); assert.equal(h.app.online.room.code, 'ABCDEFGH');
    h.app.online.room.lastBotResult = { success: true, fallback: true, matchId: 'a'.repeat(32), seq: 0 };
    await h.render(); assert.ok(h.texts.some(text => text.includes('备用合法行动')));
    assert.equal(h.app.getButtons().some(button => button.id === 'room-retry'), false);
  } finally { h.app.dispose(); }
});

test('legacy room without an order shows its own original cycle, not the local next-game order', async () => {
  const storage = memoryStorage();
  sut.savePreferences(storage, { size: 7, playerCount: 4, boardShape: 'hexagon', mode: 'human', difficulty: 'simple',
    startPlayer: 'PURPLE', turnOrder: ['PURPLE', 'BLACK', 'GREEN', 'WHITE'] });
  const h = uiHarness({ config, storage });
  const settings = { ...sut.settingsFor(7, 4, 'WHITE'), boardShape: 'hexagon', botCount: 0,
    playerSetup: Object.fromEntries(sut.playerIds(4).map(player => [player, { choice: 'human' }])) };
  h.app.online.enter = async () => {
    const client = h.app.online; await client.game.load(settings, [], { mode: 'human', paused: true, save: false });
    Object.assign(client, { active: true, connected: true, room: { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0,
      stateHash: client.game.stateHash, actions: [], player: 'BLACK', hostPlayer: 'BLACK', status: 'waiting',
      currentPlayer: 'WHITE', settings: plain(settings), pendingSettings: null, bots: [], ready: {}, rematchVotes: {} } });
    client.notify(); return true;
  };
  try {
    await ready(h); await h.tap('friends'); await h.tap('room-submit'); await until(() => h.app.online.room);
    await h.tap('cabin-board'); await h.scrollTo('order-WHITE');
    const strip = h.app.getButtons().find(button => button.id === 'order-WHITE');
    assert.deepEqual(strip.order, ['WHITE', 'PURPLE', 'GREEN', 'BLACK']);
    assert.deepEqual(sut.readPreferences(storage).turnOrder, ['PURPLE', 'BLACK', 'GREEN', 'WHITE']);
  } finally { h.app.dispose(); }
});
