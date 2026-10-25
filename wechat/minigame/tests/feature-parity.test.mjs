import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { sut, memoryStorage, localScheduler, until, plain, wireClone } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const payload = (settings = sut.settingsFor(5), actions = [{ type: 'move', point: [1, 0] }]) => ({
  session: sut.createLocalGameSession(settings, actions), mode: 'human', difficulty: 'easy',
});

test('Web and Mini Game replay encoders are identical; both import two/three-player completed games', async () => {
  for (const players of [2, 3]) {
    const settings = sut.settingsFor(5, players);
    const actions = [{ type: 'move', point: [1, 0] }, ...Array.from({ length: players }, () => ({ type: 'skip' }))];
    const web = await sut.createReplayDocument(settings, actions);
    const native = await sut.executeTask({ kind: 'EXPORT_REPLAY', payload: { settings, actions } });
    assert.deepEqual(native, web);
    assert.equal((await sut.validateReplayDocument(native)).success, true);
    const imported = await sut.executeTask({ kind: 'IMPORT_REPLAY', payload: { text: JSON.stringify(web) } });
    assert.equal(imported.stateHash, web.integrity.finalStateHash);
    assert.equal(imported.snapshot.gameOver, true);
    assert.equal(imported.settings.playerCount, players);
    for (const mutation of [d => d.actions[0].point = [9, 9], d => d.schemaVersion = 99,
      d => d.integrity.finalStateHash = 'tampered', d => d.actions.reverse(), d => d.config.rulesVersion = 'territory-v1']) {
      const bad = plain(web); mutation(bad);
      await assert.rejects(async () => sut.executeTask({ kind: 'IMPORT_REPLAY', payload: { text: JSON.stringify(bad) } }));
    }
  }
  for (const text of ['{broken', 'x'.repeat(2 * 1024 * 1024 + 1), '{}', 'null']) {
    await assert.rejects(async () => sut.executeTask({ kind: 'IMPORT_REPLAY', payload: { text } }));
  }
});

test('actual production Worker exports/imports without crypto, TextEncoder or DOM', async () => {
  let receive; const messages = [];
  const context = vm.createContext({ worker: { onMessage: fn => { receive = fn; }, postMessage: m => messages.push(wireClone(m)) } });
  vm.runInContext(await fs.readFile(new URL('../dist/workers/index.js', import.meta.url), 'utf8'), context);
  const settings = sut.settingsFor(5, 3), actions = [{ type: 'move', point: [1, 0] }];
  receive(wireClone({ id: 1, context: { epoch: 1 }, kind: 'EXPORT_REPLAY', payload: { settings, actions } }));
  await until(() => messages.length === 1); assert.equal(messages[0].ok, true);
  const doc = messages[0].result; assert.equal((await sut.validateReplayDocument(doc)).success, true);
  receive(wireClone({ id: 2, context: { epoch: 1 }, kind: 'IMPORT_REPLAY', payload: { text: JSON.stringify(doc) } }));
  await until(() => messages.length === 2); assert.equal(messages[1].ok, true);
  assert.equal(messages[1].result.stateHash, doc.integrity.finalStateHash);
});

test('three-player sessions retain Purple, replay, restore and terminal outcomes; rooms stay two-player', async () => {
  const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage()), session = new sut.GameSession(scheduler, store);
  try {
    assert.equal(await session.newGame(5, 'ai-duel', 'easy', 3), true);
    assert.equal(session.mode, 'human'); assert.equal(session.isAITurn(), false);
    await session.act({ type: 'move', point: [1, 0] }); await session.act({ type: 'move', point: [0, 2] });
    assert.equal(session.snapshot.currentPlayer, 'PURPLE');
    await session.act({ type: 'move', point: [3, 1] }); const hash = session.stateHash;
    await session.replay(2); assert.equal(session.snapshot.currentPlayer, 'PURPLE');
    await session.exitReplay(); assert.equal(session.stateHash, hash);
    const restored = new sut.GameSession(scheduler, store); assert.equal(await restored.restore(), true);
    assert.equal(restored.stateHash, hash); assert.equal(restored.settings.playerCount, 3);
    assert.equal(restored.mode, 'human'); restored.resume();
    await restored.act({ type: 'resign', player: 'BLACK' }); await restored.act({ type: 'resign', player: 'WHITE' });
    assert.equal(restored.snapshot.winner, 'PURPLE');
    await assert.rejects(async () => sut.executeTask({ kind: 'HINT', payload: { settings: sut.settingsFor(5, 3), actions: [] } }), /INVALID_CONTROLLERS/);
    const room = { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
      status: 'playing', player: 'BLACK', currentPlayer: 'BLACK', actions: [], actionIds: [],
      stateHash: `sha256:${'a'.repeat(64)}`, ready: {}, members: {}, rematchVotes: {}, settings: sut.settingsFor(5, 3) };
    assert.throws(() => sut.validateRoom(room), /INVALID_ROOM/);
  } finally { session.hide(); scheduler.cancel(); }
});

test('AI observation pauses without late moves and reaches a bounded terminal game after resume', async () => {
  const scheduler = localScheduler(), session = new sut.GameSession(scheduler, new sut.SaveStore(memoryStorage()));
  try {
    await session.newGame(5, 'ai-duel', 'easy');
    await until(() => session.actions.length >= 2); session.hide();
    const count = session.actions.length; await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(session.actions.length, count); assert.equal(session.canPlay(), false);
    session.show(); session.resume();
    await until(() => session.snapshot.gameOver, 20000);
    assert.ok(session.actions.length < 100); assert.equal(session.busy, false);
    assert.equal(session.actions.every(action => ['move', 'skip'].includes(action.type)), true);
  } finally { session.hide(); scheduler.cancel(); }
});

test('replay library deduplicates, deletes only the selected entry and preserves a failed write', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
  const first = library.save(payload()); library.save(payload());
  assert.equal(library.read().entries.length, 1);
  for (let i = 0; i < 19; i++) library.save({ ...payload(sut.settingsFor(5 + i % 10)), mode: i < 10 ? 'ai-white' : 'ai-black' });
  assert.equal(library.read().entries.length, 20);
  library.save({ ...payload(), mode: 'ai-duel' });
  assert.equal(library.read().entries.length, 21);
  library.remove(first); assert.equal(library.read().entries.length, 20);
  assert.equal(library.read().entries.some(entry => entry.id === first), false);
  const previous = library.read();
  storage.set = () => {}; assert.throws(() => library.save(payload()), /SAVE_WRITE_FAILED/);
  assert.deepEqual(library.read().entries, previous.entries);
});

test('new scenes fit safe areas, persist settings, select all lessons and expose no undefined translations', async () => {
  assert.deepEqual(Object.keys(TEXT.zh).sort(), Object.keys(TEXT.en).sort());
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const h = uiHarness({ width, height, top, language }), { app, p, tap, render } = h;
    const check = () => {
      const buttons = app.getButtons();
      for (const b of buttons) {
        assert.ok(b.x >= 0 && b.x + b.width <= width, b.id);
        assert.ok(b.y >= (b.id === 'account-avatar' ? top - 40 : top - 2) && b.y + b.height <= height - 24, `${language} ${b.id}: ${b.y + b.height}`);
        for (const other of buttons) if (b !== other) assert.equal(b.x < other.x + other.width && b.x + b.width > other.x && b.y < other.y + other.height && b.y + b.height > other.y, false, `${b.id}/${other.id}`);
      }
      assert.equal(h.texts.includes('undefined'), false);
    };
    try {
      await render(); check(); assert.deepEqual(p.calls, { read: 0, write: 0 });
      await tap('cabin-board'); check(); await h.slide('player-count', 3, 2, 6); await h.slide('board-size', 8, 5, 15);
      const preferences = sut.readPreferences(p.storage);
      assert.equal(preferences.size, 8); assert.equal(preferences.mode, 'three-human'); assert.equal(preferences.difficulty, 'normal');
      assert.equal(preferences.playerDrafts[2].mode, 'ai-white'); assert.equal(preferences.playerDrafts[3].mode, 'three-human');
      await tap('cabin-close'); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy); await render(); check();
      assert.equal(app.session.settings.playerCount, 3); assert.ok(h.texts.some(text => text.startsWith(TEXT[language].purple)));
      await tap('cabin-tutorial'); check(); await h.scrollTo('lesson-4'); assert.ok(app.getButtons().some(b => b.id === 'lesson-4')); await h.scrollTo('lesson-0');
      await tap('lesson-0'); await until(() => app.session.tutorial?.index === 0);
      await app.session.act(sut.TUTORIAL_LEVELS[0].objective);
      assert.deepEqual(JSON.parse(p.storage.get('lifeline-wx-lessons-v1')), [0]);
      await tap('cabin-board'); await tap('library'); check(); assert.deepEqual(p.calls, { read: 0, write: 0 });
    } finally { app.dispose(); }
  }
});

test('library UI exports/imports without replacing current game, rejects bad input and opens a replay safely', async () => {
  const h = uiHarness(), { app, p, tap, render } = h;
  try {
    await render(); await app.session.newGame(5, 'human'); await app.session.act({ type: 'move', point: [1, 0] });
    const hash = app.session.stateHash; await tap('library'); await tap('save-replay');
    assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 1);
    await tap('export-replay'); await until(() => p.calls.write === 1);
    assert.equal((await sut.validateReplayDocument(JSON.parse(h.clipboard))).success, true);
    await until(() => !app.getButtons().find(b => b.id === 'import-replay').disabled);
    const importedDoc = await sut.createReplayDocument(sut.settingsFor(5, 3), []); h.clipboard = JSON.stringify(importedDoc);
    await tap('import-replay'); await until(() => new sut.ReplayLibrary(p.storage).read().entries.length === 2);
    assert.equal(app.session.stateHash, hash);
    await until(() => !app.getButtons().find(b => b.id === 'import-replay').disabled);
    h.clipboard = '{broken'; const before = p.messages.length; await tap('import-replay');
    await until(() => p.messages.length > before);
    assert.equal(app.session.stateHash, hash); assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 2);
    await render(); p.choose = async () => 0;
    const entry = new sut.ReplayLibrary(p.storage).read().entries.find(e => e.payload.session.settings.playerCount === 3);
    await tap(`saved-${entry.id}`); await until(() => app.getScene() === 'game' && !app.session.busy && app.session.replayIndex === 0);
    assert.equal(app.session.settings.playerCount, 3);
    assert.equal(new sut.ReplayLibrary(p.storage).read().entries.some(e => e.payload.session.actions.length === 1), true);
  } finally { app.dispose(); }
});

test('navigation and backgrounding cancel pending clipboard import before any library or game mutation', async () => {
  for (const cancel of ['home', 'hide']) {
    const h = uiHarness(), { app, p, tap, render } = h;
    let release;
    try {
      await render(); await app.session.newGame(5, 'human');
      const hash = app.session.stateHash;
      const source = JSON.stringify(await sut.createReplayDocument(sut.settingsFor(5, 3), []));
      p.readClipboard = () => new Promise(resolve => { release = resolve; });
      await tap('library'); await tap('import-replay'); await until(() => release);
      if (cancel === 'home') await tap('home'); else p.callbacks.hide();
      release(source); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 0); assert.equal(app.session.stateHash, hash);
      assert.equal(p.calls.write, 0);
    } finally { release?.(''); app.dispose(); }
  }
});

test('backgrounding the first STATE leaves a visible recovery instead of a permanent empty board', async () => {
  const h = uiHarness({ workerDelay: 100 }), { app, p, tap, render } = h;
  try {
    await until(() => app.session.busy);
    p.callbacks.hide(); p.callbacks.show();
    await render();
    assert.equal(app.session.snapshot, null);
    assert.ok(app.getButtons().some(b => b.id === 'load-retry'));
    p.workerDelay = 1;
    await tap('load-retry'); await until(() => app.session.snapshot && !app.session.busy);
    assert.ok(app.session.snapshot);
  } finally { app.dispose(); }
});
