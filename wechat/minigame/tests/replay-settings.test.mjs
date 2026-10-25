import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { sut, localScheduler, memoryStorage, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const setup = (size = 5, players = 2) => sut.settingsFor(size, players);
const actions = [{ type: 'move', point: [1, 0] }, { type: 'move', point: [0, 2] }, { type: 'move', point: [3, 1] }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mixed player roles and chosen starter drive the correct AI, with compatible save/library/tutor restore', async () => {
  const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage());
  const session = new sut.GameSession(scheduler, store), profiles = [];
  const request = scheduler.request.bind(scheduler);
  scheduler.request = (kind, payload, ...rest) => { if (kind === 'AI') profiles.push(payload.profile); return request(kind, payload, ...rest); };
  const controllers = { BLACK: 'human', WHITE: 'greedy' };
  try {
    await session.newGame(5, 'human', 'normal', 2, { controllers, startPlayer: 'WHITE' });
    await until(() => session.actions.length === 1 && !session.busy);
    assert.equal(session.snapshot.currentPlayer, 'BLACK'); assert.equal(session.canPlay(), true);
    assert.deepEqual(profiles, ['greedy']); assert.equal(session.mode, 'ai-white');
    assert.equal(session.settings.startPlayer, 'WHITE'); assert.deepEqual(store.read().payload.controllers, controllers);
    const hash = session.stateHash;
    const restored = new sut.GameSession(scheduler, store); assert.equal(await restored.restore(), true);
    assert.equal(restored.stateHash, hash); assert.deepEqual(restored.controllers, controllers);
    await restored.tutorialLevel(0); await restored.exitTutorial();
    assert.deepEqual(restored.controllers, controllers); assert.equal(restored.settings.startPlayer, 'WHITE');
    const library = new sut.ReplayLibrary(memoryStorage());
    const old = { session: sut.createLocalGameSession(setup(), []), mode: 'human', difficulty: 'normal' };
    const oldId = library.save(old); assert.equal(library.read().entries[0].id, oldId);
    library.save({ ...old, controllers: { BLACK: 'human', WHITE: 'greedy' } });
    library.save({ ...old, controllers: { BLACK: 'human', WHITE: 'minimax-3' } });
    assert.equal(library.read().entries.length, 3, 'Different role configurations must not overwrite each other');
    assert.equal(await restored.newGame(5, 'human', 'easy', 3, { startPlayer: 'PURPLE' }), true);
    assert.equal(restored.snapshot.currentPlayer, 'PURPLE'); assert.equal(restored.controllers, null);
  } finally { session.hide(); scheduler.cancel(); }
});

test('legacy preferences retain defaults; malformed player configuration cannot replace a live game or save', async () => {
  const storage = memoryStorage();
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 9, mode: 'ai-black', difficulty: 'easy' }));
  assert.deepEqual(sut.readPreferences(storage), { size: 9, mode: 'ai-black', difficulty: 'easy' });
  const q = localScheduler(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  try {
    await session.newGame(5, 'human'); const hash = session.stateHash;
    for (const controllers of [{ BLACK: 'human' }, { BLACK: 'minimax-99', WHITE: 'human' }, { BLACK: 'human', WHITE: 'human', PURPLE: 'greedy' }, []]) {
      assert.equal(await session.load(setup(), [], { controllers }), false);
      assert.equal(session.stateHash, hash);
      assert.throws(() => sut.validateSave({ ...session.capture(), controllers }), /INVALID_CONTROLLERS/);
    }
    assert.throws(() => sut.validateControllers({ BLACK: 'human', WHITE: 'human' }, 3), /INVALID_CONTROLLERS/);
  } finally { session.hide(); q.cancel(); }
});

test('production thread supports Greedy and Minimax 2/3/4, rejects unknown profiles and preserves the position', async () => {
  const worker = new Worker(new URL('./worker-thread.mjs', import.meta.url));
  try {
    const settings = setup(), prefix = [{ type: 'move', point: [1, 0] }];
    const before = sut.executeTask({ kind: 'STATE', payload: { settings, actions: prefix } });
    for (const profile of ['greedy', 'minimax-2', 'minimax-3', 'minimax-4']) {
      const response = once(worker, 'message');
      worker.postMessage({ id: profile, kind: 'AI', payload: { settings, actions: prefix, profile }, context: {} });
      const [result] = await response;
      assert.equal(result.ok, true, profile); assert.equal(result.result.stateHash, before.stateHash);
      assert.ok(before.snapshot.legalMoves.some(move => String(move.point) === String(result.result.moves[0]?.point)), profile);
    }
    const response = once(worker, 'message');
    worker.postMessage({ id: 9, kind: 'AI', payload: { settings, actions: prefix, profile: 'minimax-99' }, context: {} });
    assert.equal((await response)[0].error, 'INVALID_CONTROLLERS');
  } finally { await worker.terminate(); }
});

test('AI observation selects each side profile independently, including a non-default starter', async () => {
  const q = localScheduler(), session = new sut.GameSession(q, new sut.SaveStore(memoryStorage())), profiles = [];
  const request = q.request.bind(q);
  q.request = (kind, payload, ...rest) => {
    if (kind === 'AI') profiles.push({ profile: payload.profile, count: payload.actions.length });
    return request(kind, payload, ...rest);
  };
  try {
    await session.newGame(5, 'human', 'easy', 2, { startPlayer: 'WHITE', controllers: { BLACK: 'greedy', WHITE: 'minimax-2' } });
    await until(() => profiles.length >= 2); session.pause();
    assert.deepEqual(profiles.slice(0, 2), [{ profile: 'minimax-2', count: 0 }, { profile: 'greedy', count: 1 }]);
    const count = session.actions.length; await sleep(20); assert.equal(session.actions.length, count);
  } finally { session.hide(); q.cancel(); }
});

test('step inspector matches Web effects for all lessons including cut and terminal; no live state or storage changes', async () => {
  const q = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  try {
    for (const lesson of sut.TUTORIAL_LEVELS) {
      const settings = { ...setup(lesson.gridSize), startPlayer: lesson.startPlayer }, log = [...lesson.prefix, lesson.objective];
      await session.load(settings, log, { mode: 'human', paused: true });
      const original = plain(session.snapshot), hash = session.stateHash, saved = new Map(storage.map);
      const document = await sut.createReplayDocument(settings, log);
      await session.replay(log.length);
      const info = await session.inspectReplay();
      assert.deepEqual(info.effects, document.actions.at(-1).effects);
      assert.equal(info.stateHash, document.integrity.finalStateHash);
      if (lesson.id === 'L3-cut-and-clear') assert.ok(info.effects.capturedPoints.length > 0);
      if (lesson.id === 'L5-settle-score') assert.equal(info.effects.gameEnded, true);
      assert.deepEqual(storage.map, saved); assert.equal(session.stateHash, hash);
      await session.replay(0); const initial = await session.inspectReplay();
      assert.equal(initial.action, null); assert.equal(initial.effects.capturedPoints.length, 0);
      await session.exitReplay(); assert.deepEqual(session.snapshot, original); assert.deepEqual(storage.map, saved);
    }
  } finally { session.hide(); q.cancel(); }
});

test('replay autoplay advances in order, ends cleanly and keeps original log/save/hash; invalid seek is inert', async () => {
  const q = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(q, new sut.SaveStore(storage));
  try {
    await session.load(setup(5, 3), actions, { mode: 'human', paused: true });
    const before = session.capture(), hash = session.stateHash, saved = new Map(storage.map);
    for (const value of [NaN, Infinity, 1.5, '2']) assert.equal(await session.replay(value), false);
    assert.equal(session.replayIndex, null);
    await session.replay(0); session.replayInterval = 5;
    const cursors = [];
    session.onChange = () => { if (session.replayIndex !== null && !session.busy && cursors.at(-1) !== session.replayIndex) cursors.push(session.replayIndex); };
    assert.equal(session.startReplayPlayback(), true);
    await until(() => !session.replayPlaying && session.replayIndex === actions.length);
    assert.deepEqual(cursors, [0, 1, 2, 3]); assert.equal(session.replayTimer, null);
    assert.deepEqual(session.capture().session.actions, before.session.actions); assert.equal(session.stateHash, hash);
    assert.deepEqual(storage.map, saved);
    await session.exitReplay(); assert.equal(session.stateHash, hash); assert.equal(session.canPlay(), false);
  } finally { session.hide(); q.cancel(); }
});

test('canceled replay seek keeps cursor and displayed board in sync; hide/new game prevents delayed playback and inspection', async () => {
  const h = uiHarness(), { app, p, render } = h;
  try {
    await render(); await app.session.load(setup(5, 3), actions, { mode: 'human', paused: true });
    await app.session.replay(0); const snapshot = plain(app.session.snapshot);
    p.workerDelay = 80; app.session.replayInterval = 5; app.session.startReplayPlayback();
    await until(() => app.session.busy); p.callbacks.hide(); p.callbacks.show();
    await sleep(110);
    assert.equal(app.session.replayIndex, 0); assert.deepEqual(app.session.snapshot, snapshot);
    assert.equal(app.session.replayPlaying, false); assert.equal(app.session.replayTimer, null);
    const inspect = app.session.inspectReplay();
    p.workerDelay = 1;
    await app.session.newGame(7, 'human');
    assert.equal(await inspect, null);
    await sleep(100); assert.equal(app.session.settings.gridSize, 7); assert.equal(app.session.replayIndex, null);
    assert.equal(app.session.actions.length, 0);
  } finally { app.dispose(); }
});

test('player and replay UI works in both languages on three sizes; jump/inspect is read-only and all buttons fit', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const h = uiHarness({ language, width, height, top }), { app, p, render, tap } = h;
    const geometry = () => {
      const buttons = app.getButtons();
      for (const a of buttons) {
        assert.ok(a.x >= 0 && a.y >= (a.id === 'account-avatar' ? top - 40 : top - 2) && a.x + a.width <= width && a.y + a.height <= height - 24, a.id);
        for (const b of buttons) if (a !== b) assert.equal(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y, false, `${a.id}/${b.id}`);
      }
      assert.equal(h.texts.includes('undefined'), false);
    };
    try {
      await render(); await tap('cabin-board'); geometry(); await h.scrollTo('controller-WHITE'); geometry();
      p.choose = async () => 1; await tap('controller-BLACK'); p.choose = async () => 0; await tap('controller-WHITE');
      await tap('starter-WHITE'); await tap('cabin-close'); await tap('new-game'); await until(() => app.session.canPlay()); await render(); geometry();
      assert.equal(app.session.snapshot.currentPlayer, 'WHITE'); assert.equal(app.session.settings.startPlayer, 'WHITE');
      assert.deepEqual(app.session.controllers, { BLACK: 'greedy', WHITE: 'human' });
      const prefs = sut.readPreferences(p.storage); assert.equal(prefs.startPlayer, 'WHITE'); assert.deepEqual(prefs.controllers, app.session.controllers);
      await app.session.load(setup(5, 3), actions, { mode: 'human', paused: true }); await app.session.replay(0); await render(); geometry();
      p.input = async () => '2'; await tap('replay-options'); await tap('tool-jumpReplay'); await until(() => app.session.replayIndex === 2 && !app.session.busy);
      await render(); const board = plain(app.session.snapshot), hash = app.session.stateHash;
      await tap('replay-inspectReplay'); await until(() => p.messages.some(m => m.startsWith(TEXT[language].inspectReadOnly)));
      assert.deepEqual(app.session.snapshot, board); assert.equal(app.session.stateHash, hash);
      p.input = async () => '-1'; await tap('replay-options'); await tap('tool-jumpReplay'); await until(() => p.messages.includes(TEXT[language].invalidReplayStep));
      assert.equal(app.session.replayIndex, 2);
      await tap('tool-firstReplay'); await until(() => app.session.replayIndex === 0 && !app.session.busy); await render();
      app.session.replayInterval = 10; await tap('replay-play'); await until(() => !app.session.replayPlaying && app.session.replayIndex === 3);
      await render(); geometry();
    } finally { app.dispose(); }
  }
});

test('late player-selection and replay-jump dialogs cannot apply after backgrounding', async () => {
  const h = uiHarness(), { app, p, tap, render } = h; let release;
  try {
    await render(); await tap('cabin-board');
    p.choose = () => new Promise(resolve => { release = resolve; });
    await tap('controller-BLACK'); p.callbacks.hide(); p.callbacks.show(); release(4); await sleep(10);
    assert.equal(sut.readPreferences(p.storage).controllers, undefined);
    await tap('cabin-close'); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy);
    await app.session.load(setup(5, 3), actions, { mode: 'human', paused: true }); await app.session.replay(0); await render();
    p.choose = async () => 2; p.input = () => new Promise(resolve => { release = resolve; });
    await tap('replay-options'); await tap('tool-jumpReplay'); p.callbacks.hide(); p.callbacks.show(); release('3'); await sleep(20);
    assert.equal(app.session.replayIndex, 0);
  } finally { release?.(null); app.dispose(); }
});

function nativeThreadScheduler(timeoutMs = 15000) {
  const instances = [], started = [];
  const q = new sut.ComputeScheduler(() => {
    const thread = new Worker(new URL('./cancellable-worker-thread.mjs', import.meta.url));
    let deliver;
    thread.on('message', message => message.started ? started.push(message.kind) : deliver?.(message));
    const instance = { thread, exited: once(thread, 'exit'),
      onMessage: fn => { deliver = fn; }, onError: fn => thread.on('error', fn),
      postMessage: message => thread.postMessage(message), terminate: () => thread.terminate() };
    instances.push(instance); return instance;
  }, { timeoutMs });
  return { q, instances, started };
}

test('backgrounding kills an actually started 15-board deep AI thread and cannot apply its result', async () => {
  const { q, instances, started } = nativeThreadScheduler();
  const session = new sut.GameSession(q, new sut.SaveStore(memoryStorage()));
  try {
    await session.newGame(15, 'ai-black', 'normal', 2, { controllers: { BLACK: 'minimax-4', WHITE: 'human' } });
    await until(() => started.includes('AI'));
    const hash = session.stateHash; session.hide();
    await Promise.all(instances.map(instance => instance.exited));
    assert.equal(session.stateHash, hash); assert.equal(session.actions.length, 0); assert.equal(session.busy, false);
    session.show(); assert.equal(await session.newGame(5, 'human'), true);
    assert.equal(session.settings.gridSize, 5); assert.equal(session.canPlay(), true);
  } finally { session.hide(); q.cancel(); await Promise.all(instances.map(instance => instance.exited)); }
});

test('deep AI timeout terminates the native test thread and a fresh Worker still responds', async () => {
  const { q, instances, started } = nativeThreadScheduler(500);
  try {
    await assert.rejects(q.request('AI', { settings: setup(15), actions: [], profile: 'minimax-4' }, { epoch: 1 }), /COMPUTE_TIMEOUT/);
    assert.ok(started.includes('AI'));
    await instances[0].exited;
    const result = await q.request('STATE', { settings: setup(5), actions: [] }, { epoch: 2 });
    assert.equal(result.snapshot.gridSize, 5);
  } finally { q.cancel(); await Promise.all(instances.map(instance => instance.exited)); }
});
