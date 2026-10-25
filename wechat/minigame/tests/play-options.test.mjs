import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, localScheduler, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const timed = { turnTimerEnabled: true, turnTimeLimitSeconds: 15, hintEnabled: true, hintMaxCount: 1 };
function manualTime() {
  let now = 0, seq = 0; const tasks = new Map(), canceled = [];
  return { now: () => now, schedule: (fn, delay) => { const id = ++seq; tasks.set(id, { fn, at: now + delay }); return id; },
    cancel: id => { if (tasks.has(id)) canceled.push(tasks.get(id).fn); tasks.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        tasks.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    }, get canceled() { return canceled; }, get pending() { return tasks.size; } };
}
function sessionHarness() {
  const q = localScheduler(), storage = memoryStorage(), clock = manualTime();
  const store = new sut.SaveStore(storage), session = new sut.GameSession(q, store, () => {}, { clock });
  return { session, q, storage, store, clock, stop: () => { session.hide(); q.cancel(); } };
}

test('human clock expiry commits exactly one legal pass and refreshes the next turn for two/three players', async () => {
  for (const players of [2, 3]) {
    const h = sessionHarness(), { session, clock } = h;
    try {
      await session.newGame(5, 'human', 'easy', players, { playOptions: timed });
      clock.advance(14999); assert.equal(session.actions.length, 0);
      clock.advance(1); clock.advance(50000);
      await until(() => session.actions.length === 1 && !session.busy);
      assert.equal(session.actions[0].type, 'skip'); assert.equal(session.actions[0].player, 'BLACK');
      assert.equal(session.snapshot.currentPlayer, 'WHITE'); assert.equal(session.clock.remaining(), 15000);
      const exact = sut.executeTask({ kind: 'STATE', payload: { settings: session.settings, actions: session.actions } });
      assert.equal(session.stateHash, exact.stateHash);
      for (let i = 1; i < players; i++) { clock.advance(15000); await until(() => session.actions.length === i + 1 && !session.busy); }
      assert.equal(session.snapshot.gameOver, true); assert.equal(clock.pending, 0);
    } finally { h.stop(); }
  }
});

test('pause/background/save restore preserves remaining duration without counting offline time or reviving retired ticks', async () => {
  const h = sessionHarness(), { session, clock, q, store } = h; let restored;
  try {
    await session.newGame(5, 'human', 'easy', 2, { playOptions: timed });
    clock.advance(5200); session.hide();
    assert.equal(session.clock.remaining(), 9800); assert.equal(store.read().payload.progress.remainingMs, 9800);
    clock.advance(100000); clock.canceled.forEach(fn => fn());
    assert.equal(session.actions.length, 0); assert.equal(clock.pending, 0);
    restored = new sut.GameSession(q, store, () => {}, { clock }); assert.equal(await restored.restore(), true);
    assert.equal(restored.clock.remaining(), 9800); assert.equal(restored.clock.running, false);
    clock.advance(20000); assert.equal(restored.actions.length, 0);
    restored.resume(); clock.advance(9799); assert.equal(restored.actions.length, 0);
    clock.advance(1); await until(() => restored.actions.length === 1 && !restored.busy);
    assert.equal(restored.actions[0].player, 'BLACK');
  } finally { restored?.hide(); h.stop(); }
});

test('hint computation, replay and every tutorial preserve the clock and hint budget of the original match', async () => {
  const h = sessionHarness(), { session, clock, storage } = h;
  try {
    await session.newGame(5, 'human', 'easy', 2, { playOptions: timed }); clock.advance(4000);
    const hint = session.hint(); clock.advance(60000); assert.equal(await hint, true);
    assert.equal(session.hintsRemaining, 0); assert.equal(session.clock.remaining(), 11000);
    const hash = session.stateHash, original = session.capture(), saved = new Map(storage.map);
    await session.replay(0); clock.advance(100000); assert.equal(session.actions.length, 0);
    await session.exitReplay(); assert.equal(session.clock.remaining(), 11000);
    for (let i = 0; i < 5; i++) { await session.tutorialLevel(i); clock.advance(100000); await session.exitTutorial(); }
    const after = session.capture(); after.session.savedAt = original.session.savedAt;
    assert.equal(session.stateHash, hash); assert.deepEqual(after, original); assert.deepEqual(storage.map, saved);
    session.resume(); assert.equal(await session.hint(), false); assert.equal(session.error, 'HINT_LIMIT');
    assert.equal(session.clock.remaining(), 11000);
  } finally { h.stop(); }
});

test('AI turns and AI observation never run the human clock; canceling an expired pass cannot replace a new match', async () => {
  const h = sessionHarness(), { session, clock, q } = h;
  try {
    await session.newGame(5, 'ai-black', 'easy', 2, { playOptions: timed });
    assert.equal(session.clock.running, false); clock.advance(30000);
    await until(() => session.actions.length === 1 && !session.busy);
    assert.equal(session.snapshot.currentPlayer, 'WHITE'); assert.equal(session.clock.running, true);
    await session.newGame(5, 'ai-duel', 'easy', 2, { playOptions: timed });
    await until(() => session.actions.length >= 2); assert.equal(session.clock.running, false); session.pause();
    await session.newGame(5, 'human', 'easy', 2, { playOptions: timed });
    clock.advance(15000); assert.equal(session.busy, true);
    await session.newGame(7, 'human');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(session.settings.gridSize, 7); assert.equal(session.actions.length, 0); assert.equal(clock.pending, 0);
  } finally { h.stop(); }
});

test('hint limit persists through save/library and successful hints alone consume it; disabled hints never compute', async () => {
  const h = sessionHarness(), { session, store, q, storage } = h; let restored;
  try {
    await session.newGame(5, 'human', 'easy', 2, { playOptions: { hintMaxCount: 1 } });
    assert.equal(await session.hint(), true); const hash = session.stateHash;
    assert.equal(session.hintsRemaining, 0); assert.equal(await session.hint(), false); assert.equal(session.stateHash, hash);
    const library = new sut.ReplayLibrary(storage), id = library.save(session.capture());
    restored = new sut.GameSession(q, store); assert.equal(await restored.restore(), true); assert.equal(restored.hintsRemaining, 0);
    const record = library.read().entries.find(item => item.id === id).payload;
    await restored.load(record.session.settings, record.session.actions, { ...record, paused: true }); assert.equal(restored.hintsRemaining, 0);
    await session.newGame(5, 'human', 'easy', 2, { playOptions: { hintEnabled: false } });
    const epoch = session.epoch; assert.equal(await session.hint(), false); assert.equal(session.epoch, epoch);
    assert.equal(session.error, 'HINT_DISABLED');
    await session.newGame(5, 'human'); const pending = session.hint(); session.hide(); await pending;
    assert.equal(session.hintsUsed, 0); assert.equal(session.hintsRemaining, 3);
  } finally { restored?.hide(); h.stop(); }
});

test('invalid timer/progress data cannot replace a live match, and torn options saves fall back to the predecessor', async () => {
  const h = sessionHarness(), { session, q, store, storage } = h;
  try {
    await session.newGame(5, 'human'); const hash = session.stateHash;
    for (const invalid of [{ turnTimerEnabled: 'yes' }, { turnTimeLimitSeconds: 14 }, { turnTimeLimitSeconds: 201 },
      { hintEnabled: 1 }, { hintMaxCount: 0 }, { hintMaxCount: 11 }]) {
      assert.equal(await session.load({ ...sut.settingsFor(5), ...invalid }, []), false);
      assert.equal(session.stateHash, hash);
    }
    for (const progress of [{ remainingMs: -1, hintsUsed: 0 }, { remainingMs: Infinity, hintsUsed: 0 }, { remainingMs: 0, hintsUsed: 9 }, {}]) {
      assert.throws(() => sut.validateSave({ ...session.capture(), progress }), /INVALID_PLAY_PROGRESS/);
    }
    await session.newGame(5, 'human', 'easy', 2, { playOptions: timed }); session.hide();
    const latest = store.read().records[0]; storage.set(`lifeline-wechat-session-v1-${latest.slot}`, '{torn');
    assert.ok(store.read().payload); assert.equal(store.read().damaged.length, 1);
    assert.deepEqual(sut.readPreferences(memoryStorage()), { size: 7, mode: 'ai-white', difficulty: 'normal' });
  } finally { h.stop(); }
});

test('public Web replay preserves timer and hint settings but not private progress or expired deadlines', async () => {
  const h = sessionHarness(), { session } = h;
  try {
    await session.newGame(5, 'human', 'easy', 2, { playOptions: timed }); await session.hint();
    const doc = await sut.executeTask({ kind: 'EXPORT_REPLAY', payload: { settings: session.settings, actions: session.actions } });
    const imported = await sut.executeTask({ kind: 'IMPORT_REPLAY', payload: { text: JSON.stringify(doc) } });
    assert.equal(imported.settings.turnTimerEnabled, true); assert.equal(imported.settings.turnTimeLimitSeconds, 15);
    assert.equal(imported.settings.hintMaxCount, 1); assert.equal(doc.progress, undefined);
    const result = await sut.validateReplayDocument(doc); assert.equal(result.success, true);
  } finally { h.stop(); }
});

test('clock settings fit both languages on three screen sizes and persist without changing the current game', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const h = uiHarness({ language, width, height, top }), { app, p, tap, render } = h;
    try {
      await render(); await tap('new-game'); await until(() => app.session.canPlay()); const original = app.session.stateHash;
      await tap('cabin-board'); await h.scrollTo('clock-enabled'); await render();
      const buttons = app.getButtons();
      for (const a of buttons) {
        assert.ok(a.y >= (a.id === 'account-avatar' ? top - 40 : top) && a.x >= 0 && a.x + a.width <= width && a.y + a.height <= height - 24, a.id);
        for (const b of buttons) if (a !== b) assert.equal(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y, false, `${a.id}/${b.id}`);
      }
      await tap('clock-enabled'); await h.slide('clock-duration', 15, 15, 200); await h.slide('hint-count', 1, 1, 10);
      const options = sut.readPreferences(p.storage).playOptions; assert.deepEqual(options, { ...timed, undoEnabled: false, undoMaxCount: 3 });
      assert.equal(app.session.stateHash, original); assert.equal(app.session.settings.turnTimerEnabled, false);
      await tap('cabin-close'); await tap('new-game'); await until(() => app.session.canPlay()); await render();
      assert.equal(app.session.settings.turnTimerEnabled, true); assert.equal(app.session.hintsRemaining, 1);
      assert.ok(h.texts.some(text => text.includes(TEXT[language].clockRemaining))); assert.equal(h.texts.includes('undefined'), false);
      assert.ok(app.getButtons().some(item => item.id === 'hint' && !item.disabled));
    } finally { app.dispose(); }
  }
});

test('native confirmations hold the clock and stale resignation/reset replies do not change the match', async () => {
  const h = uiHarness(), { app, p, tap, render } = h; let reply;
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await app.session.newGame(5, 'human', 'easy', 2, { playOptions: timed }); await render();
    p.confirm = () => new Promise(resolve => { reply = resolve; }); await tap('resign');
    assert.equal(app.session.clock.running, false); p.callbacks.hide(); p.callbacks.show(); reply(true);
    await new Promise(r => setTimeout(r, 20)); assert.equal(app.session.actions.length, 0); assert.equal(app.session.clockHolds, 0);
    app.session.resume(); await app.session.act({ type: 'move', point: [1, 0] }); await render();
    await tap('new-game'); await until(() => app.session.clockHolds === 1); p.callbacks.hide(); p.callbacks.show(); reply(true);
    await new Promise(r => setTimeout(r, 20)); assert.equal(app.session.actions.length, 1); assert.equal(app.session.clockHolds, 0);
    await tap('cabin-board'); await h.scrollTo('clock-enabled'); await tap('clock-enabled');
    const before = app.session.stateHash; await h.slide('clock-duration', 200, 15, 200);
    assert.equal(sut.readPreferences(p.storage).playOptions.turnTimeLimitSeconds, 200);
    assert.equal(app.session.settings.turnTimeLimitSeconds, 15, 'draft slider never mutates the current clock');
    assert.equal(app.session.stateHash, before);
  } finally { reply?.(null); app.dispose(); }
});

test('friend sessions never auto-pass locally even if supplied a timed-room setting', async () => {
  const q = localScheduler(), clock = manualTime(), client = new sut.OnlineClient({ storage: memoryStorage() }, {}, q);
  try {
    const game = client.game; game.clock.now = clock.now; game.clock.schedule = clock.schedule; game.clock.cancel = clock.cancel;
    await game.newGame(5, 'human', 'easy', 2, { playOptions: timed });
    assert.equal(game.clock.running, false); clock.advance(100000); assert.equal(game.actions.length, 0);
  } finally { client.detach(); q.cancel(); }
});

test('existing friend-room disabled hints with zero budget still validate and reconstruct in the production Worker', async () => {
  const settings = { ...sut.settingsFor(7), hintEnabled: false, hintMaxCount: 0 };
  assert.equal(sut.validateSettings(settings), settings);
  const result = sut.executeTask({ kind: 'STATE', payload: { settings, actions: [] } });
  assert.equal(result.snapshot.gridSize, 7);
  const q = localScheduler(), client = new sut.OnlineClient({ storage: memoryStorage() }, {}, q);
  try {
    client.active = true;
    assert.equal(await client.receive({ protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1,
      seq: 0, status: 'waiting', player: 'BLACK', currentPlayer: 'BLACK', actions: [], actionIds: [],
      stateHash: result.stateHash, ready: {}, members: {}, rematchVotes: {}, settings }), true);
    assert.equal(client.game.hintsRemaining, 0); assert.equal(client.game.clock.running, false);
  } finally { client.detach(); q.cancel(); }
});
