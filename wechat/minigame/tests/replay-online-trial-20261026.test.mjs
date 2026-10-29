import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, plain, localScheduler, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const settings = sut.settingsFor(7);
const actions = [{ type: 'move', player: 'BLACK', point: [1, 0] },
  { type: 'move', player: 'WHITE', point: [5, 0] }];
const config = { onlineEnabled: true, apiBase: 'https://test.invalid' };
const roomFor = (game, extra = {}) => ({ protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32),
  revision: 1, seq: actions.length, status: 'playing', player: 'BLACK', currentPlayer: game.snapshot.currentPlayer,
  settings: game.settings, actions: plain(actions), actionIds: ['action-one', 'action-two'],
  stateHash: game.stateHash, ready: { BLACK: true, WHITE: true }, members: {}, rematchVotes: {}, ...extra });

test('room broadcasts preserve a frozen replay and apply the latest verified room on exit', async () => {
  const q = localScheduler(), online = new sut.OnlineClient({ storage: memoryStorage() }, config, q);
  try {
    online.active = true;
    await online.game.load(settings, actions, { mode: 'human', paused: true, save: false });
    online.room = roomFor(online.game);
    await online.game.replay(1);
    const hash = online.game.replayStateHash, snapshot = plain(online.game.snapshot);
    assert.equal(await online.receive({ ...online.room, revision: 2, undo: { usedCount: 0, pending: true, votes: ['WHITE'] } }), true);
    assert.equal(online.game.replayIndex, 1);
    assert.equal(online.game.replayStateHash, hash);
    assert.deepEqual(online.game.snapshot, snapshot);
    assert.equal(online.room.revision, 1, 'live state stays bound to the frozen replay until exit');
    const nextActions = [...actions, { type: 'skip', player: 'BLACK' }];
    const next = sut.ruleView(sut.restoreGame(settings, nextActions));
    assert.equal(await online.receive({ ...online.room, revision: 3, seq: 3, actions: nextActions,
      actionIds: ['action-one', 'action-two', 'action-three'], stateHash: next.stateHash, currentPlayer: next.snapshot.currentPlayer }), true);
    assert.equal(online.game.replayIndex, 1);
    assert.equal(await online.game.exitReplay(), true);
    assert.equal(online.game.replayIndex, null);
    assert.equal(online.room.revision, 3);
    assert.equal(online.game.stateHash, next.stateHash);
  } finally { online.detach(); q.cancel(); }
});

for (const previousState of ['ordinary', 'hint', 'tutorial']) test(`online replay trial preserves both originals with previous local state = ${previousState}, without room commands`, async () => {
  const h = uiHarness({ config }), { app, tap, scrollTo, render } = h;
  let commands = 0;
  app.online.enter = async () => {
    await app.online.game.load(settings, actions, { mode: 'human', paused: true, save: false });
    app.online.active = app.online.connected = true; app.online.room = roomFor(app.online.game);
    app.online.notify(); return true;
  };
  app.online.command = app.online.act = async () => { commands++; throw Error('Trial must stay local'); };
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await app.session.load(settings, actions.slice(0, 1), { mode: 'human', paused: false });
    if (previousState === 'hint') { await app.session.hint(); assert.ok(app.session.hintPoint); }
    if (previousState === 'tutorial') { await app.session.tutorialLevel(0); assert.ok(app.session.tutorial); }
    await tap('cabin-battle'); await scrollTo('friends'); await tap('friends'); await scrollTo('room-submit'); await tap('room-submit');
    await until(() => app.online.room);
    const roomBefore = plain(app.online.room), source = app.session;
    await tap('cabin-board'); await scrollTo('replay-mode'); await tap('replay-mode');
    await tap('replay-current'); await until(() => app.session.replayIndex === 0 && !app.session.busy);
    await app.session.replay(1); const prefixHash = app.session.replayStateHash;
    await render(); await tap('replay-branchReplay'); await tap('branch-start');
    await until(() => app.session !== source && app.getScene() === 'game' && !app.session.busy);
    assert.equal(app.online.active, false); assert.equal(app.session.canPlay(), true);
    assert.equal(app.session.hintPoint, null); assert.equal(app.session.tutorial, null); assert.equal(app.session.savedGame, null);
    assert.equal(app.session.hintsUsed, 0);
    assert.equal(app.session.stateHash, prefixHash); assert.equal(app.session.replayIndex, null);
    assert.deepEqual(app.session.actions, actions.slice(0, 1));
    assert.deepEqual(app.online.room, roomBefore);
    const originals = new sut.ReplayLibrary(h.p.storage).read().entries;
    assert.ok(originals.some(entry => JSON.stringify(entry.payload.session.actions)
      === JSON.stringify(sut.createLocalGameSession(settings, actions.slice(0, 1)).actions)), 'The preceding local game is archived even when a lesson was open');
    assert.ok(originals.some(entry => JSON.stringify(entry.payload.session.actions)
      === JSON.stringify(sut.createLocalGameSession(settings, actions).actions)));
    const point = app.session.snapshot.legalMoves[0].point;
    assert.equal(await app.session.act({ type: 'move', point }), true);
    assert.deepEqual(app.online.room, roomBefore); assert.equal(commands, 0);
    const restore = new sut.GameSession(localScheduler(), new sut.SaveStore(h.p.storage));
    try { assert.equal(await restore.restore(), true); assert.equal(restore.stateHash, app.session.stateHash); }
    finally { restore.hide(); }
  } finally { app.dispose(); }
});

for (const keepAI of [false, true]) test(`AI replay trial starts usable with keep AI = ${keepAI}`, async () => {
  const h = uiHarness(), { app, tap } = h;
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await app.session.load(settings, actions, { mode: 'ai-white', controllers: { BLACK: 'human', WHITE: 'greedy' }, paused: true });
    await app.session.replay(1);
    await tap('replay-branchReplay');
    if (keepAI) await tap('branch-keep');
    await tap('branch-start');
    await until(() => app.getScene() === 'game' && !app.session.busy && (!keepAI || app.session.actions.length === 2));
    assert.equal(app.session.replayIndex, null); assert.equal(app.session.paused, false);
    assert.equal(app.session.canPlay(), true);
    assert.equal(app.session.controllerFor('WHITE'), keepAI ? 'greedy' : 'human');
    const point = app.session.snapshot.legalMoves[0].point;
    assert.equal(await app.session.act({ type: 'move', point }), true);
  } finally { app.dispose(); }
});

test('returning to the online board during branch verification cancels its local save and archive', async () => {
  const h = uiHarness({ config }), { app, p, tap, scrollTo, render } = h;
  app.online.enter = async () => {
    await app.online.game.load(settings, actions, { mode: 'human', paused: true, save: false });
    app.online.active = app.online.connected = true; app.online.room = roomFor(app.online.game);
    app.online.notify(); return true;
  };
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await app.session.load(settings, actions, { mode: 'human', paused: true });
    await tap('cabin-battle'); await scrollTo('friends'); await tap('friends'); await scrollTo('room-submit'); await tap('room-submit');
    await tap('cabin-board'); await scrollTo('replay-mode'); await tap('replay-mode'); await tap('replay-current');
    await until(() => !app.session.busy); await app.session.replay(1); await render(); await tap('replay-branchReplay');
    const source = app.session, saveBefore = plain(new sut.SaveStore(p.storage).read().payload), roomBefore = plain(app.online.room);
    p.workerDelay = 120; await tap('branch-start'); assert.equal(source.busy, true);
    await tap('home'); await until(() => !source.busy);
    assert.equal(app.getScene(), 'game'); assert.equal(app.session, source); assert.equal(app.online.active, true);
    assert.equal(source.replayIndex, 1);
    assert.deepEqual(new sut.SaveStore(p.storage).read().payload, saveBefore);
    assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 0);
    assert.deepEqual(app.online.room, roomBefore);
  } finally { app.dispose(); }
});

test('failed local branch write leaves the room and previous local game unchanged', async () => {
  const q = localScheduler(), storage = memoryStorage();
  const source = new sut.GameSession(q, { save() {}, read: () => ({ records: [], damaged: [] }) });
  const target = new sut.GameSession(q, new sut.SaveStore(storage));
  try {
    await target.load(settings, [], { mode: 'human', paused: true });
    await source.load(settings, actions, { mode: 'human', paused: true });
    await source.replay(1);
    const before = { source: plain(source.actions), hash: source.replayStateHash, target: plain(target.actions), targetHash: target.stateHash };
    target.store.save = () => { throw Error('SAVE_WRITE_FAILED'); };
    assert.equal(await source.forkReplay({ target, archive() {} }), false);
    assert.equal(source.replayIndex, 1); assert.equal(source.replayStateHash, before.hash);
    assert.deepEqual(source.actions, before.source);
    assert.equal(target.stateHash, before.targetHash); assert.deepEqual(target.actions, before.target);
  } finally { source.hide(); target.hide(); q.cancel(); }
});

