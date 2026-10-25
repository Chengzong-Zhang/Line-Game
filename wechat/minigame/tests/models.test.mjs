import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { sut, memoryStorage, localScheduler, fakeWorker, until, plain } from './helpers.mjs';
import { MODEL_CATALOG } from '../src/model-catalog.js';
import { uiHarness } from './ui-harness.mjs';

const rawFor = async entry => { const data = await fs.readFile(new URL(`../${entry.sourcePath}`, import.meta.url)); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); };
const entry = MODEL_CATALOG.find(model => model.id === 'dqn-all-sizes-e2000');
const policy2 = MODEL_CATALOG.find(model => model.id === 'ppo-all-sizes-e2000');
const policy3 = MODEL_CATALOG.find(model => model.id === 'sac-all-sizes-e2000');
const stableCapture = session => { const value = plain(session.capture()); delete value.session.savedAt; return value; };
function filePlatform() {
  const calls = [];
  return { calls, loadSubpackage: async (name, progress) => { calls.push(name); progress(60); },
    readAsset: asset => rawFor(MODEL_CATALOG.find(model => model.assetPath === asset)) };
}

test('all 17 models persist as independent controllers; public replay stays free of model bytes', async () => {
  const storage = memoryStorage(), store = new sut.SaveStore(storage), scheduler = localScheduler();
  const session = new sut.GameSession(scheduler, store);
  try {
    for (const model of MODEL_CATALOG) {
      const controllers = { BLACK: 'human', WHITE: model.profile };
      assert.deepEqual(sut.validateControllers(controllers), controllers);
      assert.equal(await session.newGame(5, 'ai-white', 'normal', 2, { controllers }), true);
      assert.deepEqual(store.read().payload.controllers, controllers);
      const replay = await scheduler.request('EXPORT_REPLAY', { settings: session.settings, actions: [] }, session.context());
      assert.equal(JSON.stringify(replay).includes('model:'), false);
    }
    assert.throws(() => sut.validateControllers({ BLACK: entry.profile, WHITE: 'human' }, 3), /INVALID_CONTROLLERS/);
    assert.throws(() => sut.validateControllers({ BLACK: 'model:unknown', WHITE: 'human' }), /INVALID_CONTROLLERS/);
  } finally { session.hide(); }
});

test('model loader verifies every byte, bounds its cache to two models and retries failed reads', async () => {
  const platform = filePlatform(), assets = new sut.ModelAssets(platform), progress = [];
  await assets.load(entry.profile, undefined, value => progress.push(value));
  await assets.load(entry.profile); assert.equal(platform.calls.length, 1); assert.deepEqual(progress, [60]);
  await assets.load(policy2.profile); await assets.load(policy3.profile);
  assert.equal(assets.cache.size, 2); assert.equal(assets.cache.has(entry.id), false);
  const correct = platform.readAsset;
  platform.readAsset = async () => { const data = await rawFor(entry); new Uint8Array(data)[100] ^= 1; return data; };
  await assert.rejects(assets.load(entry.profile), /MODEL_INTEGRITY/);
  assert.equal(assets.cache.has(entry.id), false);
  platform.readAsset = correct; await assets.load(entry.profile); assert.equal(assets.cache.has(entry.id), true);
  assets.clear(); assert.equal(assets.cache.size, 0);
});

test('background or new-game cancellation rejects a late model load before reading, caching or applying', async () => {
  let release, reads = 0;
  const platform = { loadSubpackage: () => new Promise(resolve => { release = resolve; }),
    readAsset: async () => { reads++; return rawFor(entry); } };
  const scheduler = localScheduler(), storage = memoryStorage();
  const models = new sut.ModelAssets(platform), session = new sut.GameSession(scheduler, new sut.SaveStore(storage), () => {}, { models });
  try {
    await session.newGame(5, 'ai-black', 'normal', 2, { controllers: { BLACK: entry.profile, WHITE: 'human' } });
    await until(() => release); session.hide(); release();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reads, 0); assert.equal(models.cache.size, 0); assert.equal(session.actions.length, 0);
    session.show(); await session.newGame(5, 'human'); const snapshot = plain(session.snapshot);
    assert.equal(session.actions.length, 0); assert.deepEqual(session.snapshot, snapshot);
  } finally { session.hide(); }
});

test('a model opponent actually plays and retains its profile through save and restore', async () => {
  const platform = filePlatform(), storage = memoryStorage(), scheduler = localScheduler();
  const session = new sut.GameSession(scheduler, new sut.SaveStore(storage), () => {}, { models: new sut.ModelAssets(platform) });
  try {
    await session.newGame(5, 'ai-black', 'normal', 2, { controllers: { BLACK: entry.profile, WHITE: 'human' } });
    await until(() => session.actions.length === 1 && !session.busy);
    assert.equal(session.error, null); assert.equal(session.snapshot.currentPlayer, 'WHITE');
    session.pause(); const hash = session.stateHash;
    assert.equal(await session.restore(), true); assert.equal(session.stateHash, hash);
    assert.equal(session.controllerFor('BLACK'), entry.profile);
  } finally { session.hide(); }
});

test('neural PUCT pass becomes a legal skip rather than a move with a null coordinate', async () => {
  const scheduler = localScheduler(), actual = scheduler.request.bind(scheduler);
  scheduler.request = (kind, payload, context, priority) => kind === 'AI'
    ? Promise.resolve({ moves: [{ point: null, type: 'pass' }], stateHash: sut.ruleView(sut.restoreGame(payload.settings, payload.actions)).stateHash, player: 'BLACK' })
    : actual(kind, payload, context, priority);
  const session = new sut.GameSession(scheduler, new sut.SaveStore(memoryStorage()));
  try {
    await session.newGame(5, 'ai-black'); await until(() => !session.busy);
    assert.equal(session.error, null); assert.equal(session.actions[0].type, 'skip');
    assert.equal(session.snapshot.currentPlayer, 'WHITE');
  } finally { session.hide(); }
});

test('replay analysis uses exactly the displayed prefix, preserves the live game and consumes no hint', async () => {
  const scheduler = localScheduler(), session = new sut.GameSession(scheduler, new sut.SaveStore(memoryStorage()), () => {}, { models: new sut.ModelAssets(filePlatform()) });
  try {
    await session.newGame(5, 'human'); await session.act({ type: 'move', point: [1, 0] }); await session.act({ type: 'move', point: [2, 0] });
    const original = stableCapture(session), liveHash = session.stateHash;
    await session.replay(1); const displayed = plain(session.snapshot);
    const expected = sut.ruleView(sut.restoreGame(session.settings, session.actions.slice(0, 1))).stateHash;
    const result = await session.analyzeReplay(entry.profile);
    assert.equal(result.stateHash, expected); assert.equal(result.cursor, 1); assert.equal(result.metric, 'prior');
    assert.equal(result.moves.length, 3); assert.deepEqual(session.snapshot, displayed);
    assert.deepEqual(stableCapture(session), original); assert.equal(session.hintsUsed, 0);
    await session.exitReplay(); assert.equal(session.stateHash, liveHash);
  } finally { session.hide(); }
});

test('native model adapters report failures and never retain a late progress callback', async () => {
  let options, notify;
  const platform = sut.createWxPlatform({ createCanvas() {}, loadSubpackage(opts) { options = opts; return { onProgressUpdate(fn) { notify = fn; } }; },
    getFileSystemManager: () => ({ readFile: opts => opts.fail({}) }) });
  const values = [], loading = platform.loadSubpackage('ai-dqn', value => values.push(value));
  notify({ progress: 30 }); options.success(); await loading; notify({ progress: 90 });
  assert.deepEqual(values, [30]); await assert.rejects(platform.readAsset(entry.assetPath), /MODEL_READ_FAILED/);
});

test('model payloads with wrong identifiers, sizes or hashes fail without a silent fallback', async () => {
  const raw = await rawFor(entry), corrupt = raw.slice(0); new Uint8Array(corrupt)[0] ^= 1;
  for (const model of [{ id: 'wrong', raw }, { id: entry.id, raw: raw.slice(0, 16) }, { id: entry.id, raw: corrupt }]) {
    const response = await sut.handleWorkerMessage({ id: 1, context: { epoch: 1 }, kind: 'AI',
      payload: { settings: sut.settingsFor(5), actions: [], profile: entry.profile, model } });
    assert.equal(response.ok, false); assert.equal(response.error, 'MODEL_INTEGRITY');
  }
});

test('leaving replay terminates a running production model Worker and discards the analysis', async () => {
  const instances = [], started = [];
  const scheduler = new sut.ComputeScheduler(() => {
    const thread = new Worker(new URL('./cancellable-worker-thread.mjs', import.meta.url)), exited = once(thread, 'exit');
    let deliver;
    thread.on('message', message => message.started ? started.push(message.kind) : deliver?.(message));
    instances.push({ thread, exited });
    return { postMessage: message => thread.postMessage(message), onMessage: fn => { deliver = fn; },
      onError: fn => thread.on('error', fn), terminate: () => thread.terminate() };
  });
  const session = new sut.GameSession(scheduler, new sut.SaveStore(memoryStorage()), () => {}, { models: new sut.ModelAssets(filePlatform()) });
  try {
    await session.newGame(15, 'human'); await session.replay(0); const hash = session.stateHash;
    const analysis = session.analyzeReplay(MODEL_CATALOG[0].profile);
    await until(() => started.includes('ANALYZE')); await session.exitReplay();
    assert.equal(await analysis, null); await Promise.all(instances.map(instance => instance.exited));
    assert.equal(session.actions.length, 0); assert.equal(session.stateHash, hash); assert.equal(session.replayIndex, null);
  } finally { session.hide(); await Promise.all(instances.map(instance => instance.exited)); }
});

for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64], ['zh', 430, 932, 88]]) {
  test(`model selection, read-only analysis and comparison fit and work: ${language} ${width}`, async () => {
    const h = uiHarness({ language, width, height, top }), { app, p, tap, render } = h;
    Object.assign(p, filePlatform());
    const geometry = () => {
      const buttons = app.getButtons();
      for (const button of buttons) assert.ok(button.x >= 0 && button.y >= (button.id === 'account-avatar' ? top - 40 : top) && button.x + button.width <= width && button.y + button.height <= height - 24, `Bounds ${button.id}`);
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i], b = buttons[j];
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `Overlap ${a.id} ${b.id}`);
      }
      assert.equal(h.texts.includes('undefined'), false);
    };
    try {
      await render(); await tap('cabin-board'); await h.scrollTo('controller-WHITE'); p.choose = async () => 5; await tap('controller-WHITE');
      assert.equal(app.getScene(), 'models'); await render(); geometry(); await tap('models-policy');
      await tap(`model-${entry.id}`); assert.equal(app.getScene(), 'home'); await render(); geometry();
      await tap('cabin-close'); await tap('new-game'); await until(() => app.session.canPlay());
      await app.session.act({ type: 'move', point: [1, 0] }); await until(() => !app.session.busy);
      assert.equal(app.session.actions.length, 2);
      const original = stableCapture(app.session);
      await app.session.replay(0); await render(); await tap('replay-analyzeReplay');
      await until(() => !app.session.busy); await render(); geometry();
      p.choose = async () => 4; await tap('analysis-choose'); await tap('models-policy'); await tap(`model-${entry.id}`);
      await until(() => !app.session.busy); await render(); geometry(); await tap('analysis-compare');
      assert.equal(p.messages.length, 1); assert.ok(p.messages[0].includes('DQN'));
      await tap('analysis-move-0'); assert.equal(app.session.replayIndex, 0);
      assert.ok(app.session.hintPoint); assert.equal(app.getScene(), 'game');
      assert.deepEqual(stableCapture(app.session), original);
      await app.session.replay(1); assert.equal(app.session.hintPoint, null);
    } finally { app.dispose(); }
  });
}
