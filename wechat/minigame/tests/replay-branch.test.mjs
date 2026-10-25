import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, plain, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const actions = [{ type: 'move', point: [1, 0] }, { type: 'skip' }];
const stable = session => { const p = session.capture(); delete p.session.savedAt; return plain(p); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('branch replays the complete prefix, preserves original including cut and settlement, and roundtrips through public Web replay', async () => {
  const q = localScheduler(), storage = memoryStorage(), store = new sut.SaveStore(storage);
  const session = new sut.GameSession(q, store), library = new sut.ReplayLibrary(storage);
  try {
    for (const level of sut.TUTORIAL_LEVELS) {
      const settings = { ...sut.settingsFor(level.gridSize), startPlayer: level.startPlayer };
      const log = [...level.prefix, level.objective];
      assert.equal(await session.load(settings, log, { mode: 'human', paused: true }), true);
      const full = stable(session), originalHash = session.stateHash;
      await session.replay(level.prefix.length);
      const prefixHash = session.replayStateHash, prefixSnapshot = plain(session.snapshot);
      assert.equal(await session.forkReplay({ archive: payload => library.save(payload) }), true);
      assert.equal(session.stateHash, prefixHash); assert.equal(session.replayIndex, null);
      assert.deepEqual(session.snapshot, prefixSnapshot); assert.deepEqual(session.actions, level.prefix);
      assert.equal(session.paused, true); assert.equal(session.hintsUsed, 0);
      const original = library.read().entries[0].payload; delete original.session.savedAt;
      assert.deepEqual(original, full); assert.equal(sut.ruleView(sut.restoreGame(settings, original.session.actions)).stateHash, originalHash);
      const restored = new sut.GameSession(q, store); assert.equal(await restored.restore(), true);
      assert.equal(restored.stateHash, prefixHash);
      session.resume(); assert.equal(await session.act(level.objective), true); session.pause();
      assert.equal(session.stateHash, originalHash, 'Identical continuation retains all history-dependent rules');
      const document = await sut.executeTask({ kind: 'EXPORT_REPLAY', payload: { settings, actions: session.actions } });
      const imported = await sut.executeTask({ kind: 'IMPORT_REPLAY', payload: { text: JSON.stringify(document) } });
      assert.equal(imported.stateHash, originalHash);
      restored.hide();
    }
  } finally { session.hide(); q.cancel(); }
});

test('branch keeps or replaces configured AI safely, resets clock/hints and never starts AI until explicit resume', async () => {
  const q = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  const library = new sut.ReplayLibrary(storage), settings = { ...sut.settingsFor(5), turnTimerEnabled: true };
  const controllers = { BLACK: 'greedy', WHITE: 'minimax-2' };
  try {
    await session.load(settings, actions.slice(0, 2), { controllers, mode: 'ai-duel', progress: { remainingMs: 17000, hintsUsed: 2 }, paused: true });
    await session.replay(1); const hash = session.replayStateHash;
    assert.equal(await session.forkReplay({ keepPlayers: true, archive: payload => library.save(payload) }), true);
    assert.deepEqual(session.controllers, controllers); assert.equal(session.mode, 'ai-duel'); assert.equal(session.stateHash, hash);
    assert.equal(session.hintsRemaining, 3); assert.equal(session.clock.remaining(), 60000); assert.equal(session.clock.running, false);
    await sleep(30); assert.equal(session.actions.length, 1);
    const restored = new sut.GameSession(q, session.store); await restored.restore();
    assert.equal(restored.stateHash, hash); assert.deepEqual(restored.controllers, controllers); restored.hide();
    await session.replay(1); assert.equal(await session.forkReplay({ archive: payload => library.save(payload) }), true);
    assert.equal(session.mode, 'human'); assert.equal(session.controllers, null);
    session.resume(); assert.equal(session.canPlay(), true); assert.equal(session.clock.running, true);
    assert.equal(library.read().entries.some(entry => entry.payload.progress?.hintsUsed === 2), true);
  } finally { session.hide(); q.cancel(); }
});

test('three-player branch retains starter, resignation history, turn order and valid continuation', async () => {
  const q = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  const settings = sut.settingsFor(5, 3, 'PURPLE');
  const log = [{ type: 'skip', player: 'PURPLE' }, { type: 'resign', player: 'BLACK' }, { type: 'move', player: 'WHITE', point: [0, 2] }];
  try {
    await session.load(settings, log, { mode: 'human', paused: true });
    await session.replay(2); const snapshot = plain(session.snapshot), hash = session.replayStateHash;
    const library = new sut.ReplayLibrary(storage);
    assert.equal(await session.forkReplay({ archive: payload => library.save(payload) }), true);
    assert.equal(session.settings.startPlayer, 'PURPLE'); assert.equal(session.stateHash, hash); assert.deepEqual(session.snapshot, snapshot);
    session.resume(); assert.equal(await session.act(log[2]), true);
    assert.equal(session.stateHash, sut.ruleView(sut.restoreGame(settings, log)).stateHash);
  } finally { session.hide(); q.cancel(); }
});

test('branch rejects final positions and preserves original on verification/archive/save failures', async () => {
  const q = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  try {
    await session.load(sut.settingsFor(5), [{ type: 'resign', player: 'BLACK' }], { mode: 'human', paused: true });
    await session.replay(1); const saves = new Map(storage.map);
    assert.equal(await session.forkReplay({ archive: () => assert.fail('must not archive') }), false);
    assert.deepEqual(storage.map, saves);
    await session.exitReplay(); await session.load(sut.settingsFor(5), actions.slice(0, 2), { mode: 'human', paused: true });
    await session.replay(1); const before = stable(session), snapshot = plain(session.snapshot), originalSave = new Map(storage.map);
    const hash = session.replayStateHash;
    session.replayStateHash = 'wrong';
    assert.equal(await session.forkReplay({ archive: () => assert.fail('must verify before archiving') }), false);
    assert.equal(session.error, 'STATE_MISMATCH'); session.replayStateHash = hash;
    assert.equal(await session.forkReplay({ archive: () => { throw Error('LIBRARY_FULL'); } }), false);
    assert.equal(session.error, 'LIBRARY_FULL'); assert.deepEqual(storage.map, originalSave);
    let preserved; const realSave = session.store.save;
    session.store.save = () => { throw Error('SAVE_WRITE_FAILED'); };
    assert.equal(await session.forkReplay({ archive: payload => { preserved = payload; } }), false);
    assert.equal(session.error, 'SAVE_WRITE_FAILED'); assert.deepEqual(preserved.session.actions, before.session.actions);
    assert.deepEqual(stable(session), before); assert.deepEqual(session.snapshot, snapshot); assert.equal(session.replayIndex, 1);
    assert.deepEqual(storage.map, originalSave); session.store.save = realSave;
    const library = new sut.ReplayLibrary(storage);
    for (let i = 0; i < 100; i++) library.save({ session: sut.createLocalGameSession({ ...sut.settingsFor(5 + i % 11), turnTimeLimitSeconds: 15 + i }, []), mode: 'human', difficulty: 'normal' });
    const oldest = library.read().entries.at(-1).id;
    assert.equal(await session.forkReplay({ archive: payload => library.save(payload) }), true);
    assert.equal(session.error, null); assert.equal(library.read().entries.length, 100);
    assert.equal(library.read().entries.some(entry => entry.id === oldest), false);
    assert.deepEqual(session.actions, actions.slice(0, 1));
  } finally { session.hide(); q.cancel(); }
});

test('hiding or starting another game during branch verification discards late results without any archive/write', async () => {
  const h = uiHarness(), { app, p } = h;
  try {
    await sleep(10); await app.session.load(sut.settingsFor(5), actions.slice(0, 2), { mode: 'human', paused: true });
    await app.session.replay(1); const saved = new Map(p.storage.map), before = stable(app.session);
    p.workerDelay = 70;
    const pending = app.session.forkReplay({ archive: () => assert.fail('late archive') });
    p.callbacks.hide(); p.callbacks.show(); assert.equal(await pending, false); await sleep(90);
    assert.deepEqual(p.storage.map, saved); assert.deepEqual(stable(app.session), before); assert.equal(app.session.replayIndex, 1);
    const second = app.session.forkReplay({ archive: () => assert.fail('old game archive') });
    await app.session.newGame(6, 'human'); assert.equal(await second, false);
    assert.equal(app.session.settings.gridSize, 6); assert.equal(app.session.actions.length, 0);
  } finally { app.dispose(); }
});

test('display settings are optional, survive restart and never enter the public game state', () => {
  const storage = memoryStorage(); assert.deepEqual(sut.readDisplay(storage), sut.DEFAULT_DISPLAY);
  storage.set('lifeline-wx-display-v1', '{broken'); assert.deepEqual(sut.readDisplay(storage), sut.DEFAULT_DISPLAY);
  assert.deepEqual(sut.normalizeDisplay({ legalMoves: false, coordinates: 'yes', unexpected: true }), { ...sut.DEFAULT_DISPLAY, legalMoves: false });
  const p = { ...sut.DEFAULT_DISPLAY, coordinates: true, highContrast: true, territories: false };
  sut.saveDisplay(storage, p); assert.deepEqual(sut.readDisplay(storage), p);
  const broken = { get: () => '', set() {} }; assert.throws(() => sut.saveDisplay(broken, p), /SAVE_WRITE_FAILED/);
});

test('board display choices and inspected effects alter only pixels, keep target markers and avoid dense coordinate clutter', () => {
  const lesson = sut.TUTORIAL_LEVELS.find(level => level.id === 'L3-cut-and-clear');
  const result = sut.executeTask({ kind: 'REPLAY_STEP', payload: { settings: { ...sut.settingsFor(lesson.gridSize), startPlayer: lesson.startPlayer }, actions: [...lesson.prefix, lesson.objective], cursor: lesson.prefix.length + 1 } });
  const snapshot = result.snapshot, before = plain(snapshot), operations = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => operations.push([key, ...args]), set: (target, key, value) => { operations.push([key, value]); target[key] = value; return true; } });
  const layout = sut.boardLayout(snapshot.gridSize, { x: 24, y: 40, width: 600, height: 600 });
  sut.drawBoard(ctx, snapshot, layout, { effects: result.effects, target: [1, 0], display: { ...sut.DEFAULT_DISPLAY, coordinates: true, highContrast: true } });
  assert.ok(operations.some(op => op[0] === 'fillText' && op[1] === '0,0'));
  assert.ok(operations.some(op => op[0] === 'setLineDash' && op[1].length === 2));
  assert.ok(operations.some(op => op[0] === 'strokeStyle' && op[1] === '#b7382e'));
  operations.length = 0;
  sut.drawBoard(ctx, snapshot, { ...layout, spacing: 20 }, { target: [1, 0], lastMove: [1, 0], display: { territories: false, legalMoves: false, lastMove: false, coordinates: true, highContrast: false } });
  assert.equal(operations.some(op => op[0] === 'fillText' && /^\d+,\d+$/.test(String(op[1]))), false);
  assert.deepEqual(operations.filter(op => op[0] === 'fillText').map(op => op[1]), ['1', '2'], 'Root badges remain visible when dense coordinates are hidden');
  assert.equal(operations.some(op => op[0] === 'strokeRect'), false);
  assert.equal(operations.some(op => op[0] === 'fillStyle' && String(op[1]).endsWith('25')), false);
  assert.ok(operations.some(op => op[0] === 'strokeStyle' && op[1] === '#cda04d'), 'Teaching/selected markers remain visible');
  assert.deepEqual(snapshot, before);
});

for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64], ['zh', 430, 932, 88]]) {
  test(`Canvas replay tools, branch and display flow: ${language} ${width}x${height}`, async () => {
    const h = uiHarness({ language, width, height, top }), { app, p, tap, render } = h;
    const geometry = () => {
      const buttons = app.getButtons();
      for (const b of buttons) assert.ok(b.x >= 0 && b.y >= (b.id === 'account-avatar' ? top - 40 : top) && b.x + b.width <= width && b.y + b.height <= height - 24, b.id);
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i], b = buttons[j];
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id}/${b.id}`);
      }
      assert.equal(h.texts.includes('undefined'), false);
    };
    try {
      await render(); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy);
      const lesson = sut.TUTORIAL_LEVELS.find(level => level.id === 'L3-cut-and-clear'), settings = { ...sut.settingsFor(lesson.gridSize), startPlayer: lesson.startPlayer };
      await app.session.load(settings, [...lesson.prefix, lesson.objective], { mode: 'human', paused: true });
      const hash = app.session.stateHash, original = stable(app.session);
      await app.session.replay(app.session.actions.length); await render(); await render(); geometry();
      await tap('replay-inspectReplay'); await until(() => p.messages.some(m => m.startsWith(TEXT[language].inspectReadOnly)));
      await render(); assert.ok(h.texts.some(text => TEXT[language].inspectionMarks.includes(text)), 'Overlay legend');
      assert.equal(app.session.stateHash, hash);
      await tap('display-open'); await render(); geometry(); await tap('display-highContrast'); await tap('display-coordinates');
      assert.equal(sut.readDisplay(p.storage).highContrast, true); assert.equal(sut.readDisplay(p.storage).coordinates, true);
      assert.deepEqual(stable(app.session), original); await tap('display-back'); await tap('home');
      await app.session.replay(1); await render(); await tap('replay-branchReplay'); await render(); geometry();
      const prefixHash = app.session.replayStateHash;
      await tap('branch-start'); await until(() => app.getScene() === 'game'); await render(); geometry();
      assert.equal(app.session.actions.length, 1); assert.equal(app.session.stateHash, prefixHash); assert.equal(app.session.paused, true);
      assert.equal(app.session.replayIndex, null); assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 1);
      assert.deepEqual(new sut.ReplayLibrary(p.storage).read().entries[0].payload.session.actions, original.session.actions);
      await tap('pause-resume'); assert.equal(app.session.canPlay(), true);
    } finally { app.dispose(); }
  });
}
