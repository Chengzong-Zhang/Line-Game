// V3 is the product default, while the contribution outbox remains V2-only.
// These integration cases preserve the lifecycle and stale-result coverage
// that existed before the V3 exclusion contract replaced positive V2 UI flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage, fakeWorker, wireClone, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TrainingContribution } from '../src/training-contribution.js';

const KEY = 'lifeline-wx-training-contribution-v1';
const PREFERENCES = 'lifeline-wx-preferences-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const saved = storage => JSON.parse(storage.get(KEY) || '{"enabled":false,"queue":[],"received":[]}');

function storageWithPendingV2({ undo = false } = {}) {
  const storage = memoryStorage();
  storage.set(PREFERENCES, JSON.stringify({
    size: 5,
    mode: 'human',
    difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'human' },
    playOptions: {
      hintEnabled: false,
      hintMaxCount: 3,
      turnTimerEnabled: false,
      turnTimeLimitSeconds: 60,
      undoEnabled: undo,
      undoMaxCount: 3,
    },
  }));
  const collector = new TrainingContribution({ storage, canRun: () => false });
  const settings = {
    rulesVersion: 'territory-v2',
    gridSize: 5,
    playerCount: 2,
    startPlayer: 'BLACK',
    hintEnabled: false,
    hintMaxCount: 3,
    turnTimerEnabled: false,
    turnTimeLimitSeconds: 60,
    undoEnabled: false,
    undoMaxCount: 3,
  };
  const context = {
    source: 'local',
    actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'human' } },
    mixedProfiles: false,
    hintsEnabled: false,
    undo: { enabled: false, maxCount: 3, usedCount: 0 },
  };
  collector.setEnabled(true);
  const ticket = collector.beginMatch({ settings, context, source: 'local', actionCount: 0 });
  assert.ok(ticket);
  assert.equal(collector.captureCompletedMatch(ticket, {
    settings,
    actions: [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }],
    context,
    source: 'local',
    terminal: true,
  }), true);
  collector.dispose();
  assert.equal(saved(storage).queue.length, 1);
  return storage;
}

function harness({ storage = storageWithPendingV2(), holdPost = false, gate = null, service = true } = {}) {
  const uploads = [], requests = [], wire = { aborts: 0, settle: null, network: null, listenerStopped: false };
  const platformOverrides = {
    onNetworkStatusChange: callback => {
      wire.network = callback;
      return () => { wire.listenerStopped = true; };
    },
    contributionRequest: request => {
      requests.push(plain(request));
      if (request.method === 'GET') return { promise: Promise.resolve({ status: 200, data: {
        enabled: true,
        supported_versions: [1, 2],
        consent_policies: { 2: 'anonymous-replay-training-v2' },
      } }), abort() {} };
      uploads.push(plain(request.data));
      const response = { status: 200, data: { game_id: 'a'.repeat(64), status: 'awaiting_review' } };
      return {
        promise: holdPost ? new Promise(resolve => { wire.settle = () => resolve(response); }) : Promise.resolve(response),
        abort: () => { wire.aborts++; },
      };
    },
  };
  if (!service) delete platformOverrides.contributionRequest;
  if (gate) platformOverrides.createWorker = () => {
    const worker = fakeWorker();
    worker.postMessage = message => {
      const copied = wireClone(message);
      if (gate.failState && copied.kind === 'STATE') {
        gate.failState = false;
        setTimeout(() => worker.receive({ id: copied.id, context: copied.context, ok: false, error: 'FIXTURE_UNDO_FAILURE' }), 1);
        return;
      }
      const deliver = async () => worker.receive(wireClone(await sut.handleWorkerMessage(copied)));
      if (gate.holdState && copied.kind === 'STATE') gate.held.push(deliver);
      else setTimeout(() => { if (!worker.terminated) void deliver(); }, 1);
    };
    return worker;
  };
  const h = uiHarness({ storage, config: service
    ? { onlineEnabled: true, apiBase: 'https://fixture.invalid' }
    : { onlineEnabled: true }, platformOverrides });
  return Object.assign(h, { storage, uploads, requests, wire });
}

async function ready(h) {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  await h.render();
  assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
}

async function openContribution(h) {
  if (h.app.getCabin() !== 'board') await h.tap('cabin-board');
  await h.scrollTo('training-contribution');
  await h.render();
}

async function enablePending(h, { close = true } = {}) {
  await openContribution(h);
  const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
  assert.ok(toggle && !toggle.disabled, 'pending V2 data keeps its consent control available');
  await h.tap('training-contribution');
  await h.render();
  assert.ok(h.texts.some(text => /授权开|consent on/i.test(text)));
  if (close) await h.tap('cabin-close');
}

async function move(h, index = 0) {
  const before = h.app.session.actions.length;
  const point = h.app.session.snapshot.legalMoves[index].point;
  assert.equal(await h.app.session.act({ type: 'move', point }), true);
  await until(() => h.app.session.actions.length === before + 1 && !h.app.session.busy);
  return point;
}

async function finish(h) {
  if (h.app.getCabin() === 'board') await h.tap('cabin-close');
  await h.render();
  await h.tap('resign');
  await until(() => h.app.session.snapshot.gameOver && !h.app.session.busy);
}

async function fresh(h) {
  if (h.app.getCabin() === 'board') await h.tap('cabin-close');
  const previous = h.app.session.settings;
  await h.render();
  await h.tap('new-game');
  await until(() => h.app.session.settings !== previous && !h.app.session.busy && !h.app.session.actions.length);
  assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
}

async function replayBoundary(h) {
  await h.tap('cabin-board');
  await h.scrollTo('replay-mode');
  await h.tap('replay-mode');
  await h.tap('replay-current');
  await until(() => h.app.session.replayIndex === 0 && !h.app.session.busy);
  await h.tap('exit-replay');
  await until(() => h.app.session.replayIndex === null && !h.app.session.busy);
}

async function tutorialBoundary(h) {
  await h.tap('cabin-tutorial');
  await h.tap('lesson-0');
  await until(() => h.app.session.tutorial && !h.app.session.busy);
  await h.tap('lesson-exit');
  await until(() => !h.app.session.tutorial && !h.app.session.busy);
}

async function enterOnline(h) {
  h.app.online.enter = async () => {
    const client = h.app.online;
    await client.game.load(sut.settingsFor(5), [], { mode: 'human', paused: true, save: false });
    client.active = client.connected = true;
    client.room = {
      code: 'ABCDEFGH', matchId: 'b'.repeat(32), seq: 0, status: 'playing', player: 'BLACK',
      stateHash: client.game.stateHash, settings: client.game.settings, ready: {}, rematchVotes: {},
    };
    client.notify();
    return true;
  };
  await h.tap('cabin-battle');
  await h.scrollTo('friends');
  await h.tap('friends'); await h.tap('room-submit');
}

test('pending V2 retry consent stays off when declined or when its board cabin becomes stale', async () => {
  const h = harness();
  try {
    await ready(h);
    h.p.confirm = async () => false;
    await openContribution(h);
    await h.tap('training-contribution');
    await h.render();
    assert.ok(h.texts.some(text => /授权关|consent off/i.test(text)));
    assert.equal(saved(h.storage).queue.length, 1);
    assert.deepEqual(h.uploads, []);

    let answer;
    h.p.confirm = () => new Promise(resolve => { answer = resolve; });
    await h.tap('training-contribution');
    await until(() => answer);
    await h.tap('cabin-guide');
    answer(true);
    await pause(30);
    assert.equal(saved(h.storage).queue.length, 1);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('enabling legacy retry never backfills the current V3 match or admits a later V3 match', async () => {
  const h = harness();
  try {
    await ready(h);
    await move(h);
    await enablePending(h, { close: false });
    await until(() => h.uploads.length === 1 && saved(h.storage).queue.length === 0);
    assert.equal(h.uploads[0].replay.config.rulesVersion, 'territory-v2');
    await h.tap('cabin-close');
    await finish(h);
    await pause(300);
    assert.equal(h.uploads.length, 1);
    await fresh(h);
    await move(h);
    await finish(h);
    await pause(300);
    assert.equal(h.uploads.length, 1);
    assert.ok(h.uploads.every(payload => payload.replay.config.rulesVersion === 'territory-v2'));
  } finally { h.app.dispose(); }
});

test('a restored V3 match remains excluded after fresh legacy retry consent', async () => {
  const storage = storageWithPendingV2();
  const first = harness({ storage });
  try { await ready(first); await move(first); }
  finally { first.app.dispose(); }

  const h = harness({ storage });
  try {
    await ready(h);
    assert.equal(h.app.session.actions.length, 1);
    h.wire.network({ isConnected: false });
    await enablePending(h);
    await finish(h);
    await pause(80);
    assert.equal(saved(storage).queue.length, 1);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('entering and leaving replay cannot turn a V3 local match into a contribution', async () => {
  const h = harness();
  try {
    await ready(h);
    h.wire.network({ isConnected: false });
    await enablePending(h);
    await fresh(h);
    await move(h);
    await replayBoundary(h);
    h.app.session.resume();
    await h.render();
    await finish(h);
    assert.equal(saved(h.storage).queue.length, 1);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('tutorial, imported replay and online transitions cannot turn a V3 match into a contribution', async () => {
  for (const boundary of ['tutorial', 'import', 'online']) {
    const h = harness();
    try {
      await ready(h);
      h.wire.network({ isConnected: false });
      await enablePending(h);
      await fresh(h);
      await move(h);
      const local = h.app.session;
      if (boundary === 'tutorial') {
        await tutorialBoundary(h);
        local.resume();
        await h.render();
        await finish(h);
      } else if (boundary === 'import') {
        h.clipboard = JSON.stringify(await sut.createReplayDocument(local.settings, local.actions, sut.checksum));
        await h.tap('cabin-board');
        await h.scrollTo('replay-mode');
        await h.tap('replay-mode');
        await h.tap('library');
        await h.tap('import-replay');
        await until(() => h.p.calls.read === 1 && h.p.messages.length > 0);
        await h.tap('home');
        local.resume();
        await h.render();
        await finish(h);
      } else {
        await enterOnline(h);
        await until(() => h.app.session === h.app.online.game);
        local.resume();
        assert.equal(await local.act({ type: 'resign' }), true);
      }
      await pause(60);
      assert.equal(saved(h.storage).queue.length, 1, boundary);
      assert.deepEqual(h.uploads, [], boundary);
    } finally { h.app.dispose(); }
  }
});

test('a legacy V2 pending record survives guide, tutorial and replay transitions until explicit offline clearing', async () => {
  const h = harness({ service: false });
  try {
    await ready(h);
    await move(h);
    await h.tap('cabin-guide');
    await h.tap('cabin-close');
    assert.equal(saved(h.storage).queue.length, 1);
    await tutorialBoundary(h);
    assert.equal(saved(h.storage).queue.length, 1);
    await replayBoundary(h);
    assert.equal(saved(h.storage).queue.length, 1);
    await openContribution(h);
    await h.tap('training-contribution');
    assert.equal(saved(h.storage).queue.length, 0);
    assert.equal(saved(h.storage).enabled, false);
  } finally { h.app.dispose(); }
});

test('starting and playing a new V3 game preserves a legacy V2 pending record without blocking play', async () => {
  const h = harness({ service: false });
  try {
    await ready(h);
    await fresh(h);
    await move(h);
    assert.equal(h.app.session.actions.length, 1);
    assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
    assert.equal(saved(h.storage).queue.length, 1);
  } finally { h.app.dispose(); }
});

test('a legacy V2 pending record retries when the network returns while V3 remains excluded', async () => {
  const h = harness();
  try {
    await ready(h);
    h.wire.network({ isConnected: false });
    await enablePending(h, { close: false });
    await pause(350);
    assert.deepEqual(h.uploads, []);
    assert.equal(saved(h.storage).queue.length, 1);
    h.wire.network({ isConnected: true });
    await until(() => h.uploads.length === 1 && saved(h.storage).queue.length === 0);
    assert.equal(h.uploads[0].replay.config.rulesVersion, 'territory-v2');
    await h.tap('cabin-close');
    await finish(h);
    await pause(300);
    assert.equal(h.uploads.length, 1);
  } finally { h.app.dispose(); assert.equal(h.wire.listenerStopped, true); }
});

test('six-player hex V3 games keep legacy retry available but never add a V3 record', async () => {
  const h = harness();
  try {
    await ready(h);
    h.wire.network({ isConnected: false });
    await h.tap('cabin-board');
    await h.slide('player-count', 6, 2, 6);
    await h.scrollTo('training-contribution');
    await h.tap('training-contribution');
    await h.tap('cabin-close');
    await fresh(h);
    assert.equal(h.app.session.settings.playerCount, 6);
    assert.equal(h.app.session.settings.boardShape, 'hexagon');
    for (let turn = 0; turn < 6 && !h.app.session.snapshot.gameOver; turn++) {
      const before = h.app.session.actions.length;
      assert.equal(await h.app.session.act({ type: 'skip' }), true);
      await until(() => h.app.session.actions.length === before + 1 && !h.app.session.busy);
    }
    assert.equal(h.app.session.snapshot.gameOver, true);
    assert.equal(saved(h.storage).queue.length, 1);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('withdrawing legacy retry aborts an in-flight upload and late success cannot restore consent or queue', async () => {
  const h = harness({ holdPost: true });
  try {
    await ready(h);
    await enablePending(h, { close: false });
    await until(() => h.uploads.length === 1 && h.wire.settle);
    await h.tap('training-contribution');
    assert.equal(h.wire.aborts, 1);
    assert.equal(saved(h.storage).enabled, false);
    assert.equal(saved(h.storage).queue.length, 0);
    h.wire.settle();
    await pause(50);
    assert.equal(saved(h.storage).enabled, false);
    assert.equal(saved(h.storage).queue.length, 0);
    assert.deepEqual(saved(h.storage).received, []);
  } finally { h.wire.settle?.(); h.app.dispose(); }
});

test('undo after legacy retry consent leaves only the old V2 record for fresh, restored and replayed V3 matches', async () => {
  for (const state of ['fresh', 'restored', 'replayed']) {
    const storage = storageWithPendingV2({ undo: true });
    if (state === 'restored') {
      const first = harness({ storage });
      try { await ready(first); await move(first); await move(first); }
      finally { first.app.dispose(); }
    }
    const h = harness({ storage });
    try {
      await ready(h);
      h.wire.network({ isConnected: false });
      await enablePending(h);
      if (state !== 'restored') { await fresh(h); await move(h); await move(h); }
      if (state === 'replayed') await replayBoundary(h);
      h.app.session.resume();
      await h.render();
      const used = h.app.session.undoUsage.usedCount;
      await h.tap('undo');
      await until(() => !h.app.session.busy && h.app.session.undoUsage.usedCount === used + 1);
      await finish(h);
      assert.equal(saved(storage).queue.length, 1, state);
      assert.deepEqual(h.uploads, [], state);
    } finally { h.app.dispose(); }
  }
});

test('failed and late undo Worker responses cannot add or label V3 contribution records', async () => {
  const failureGate = { failState: false, holdState: false, held: [] };
  const failed = harness({ storage: storageWithPendingV2({ undo: true }), gate: failureGate });
  try {
    await ready(failed);
    failed.wire.network({ isConnected: false });
    await enablePending(failed);
    await fresh(failed);
    await move(failed);
    await move(failed);
    const actions = plain(failed.app.session.actions);
    failureGate.failState = true;
    await failed.render();
    await failed.tap('undo');
    await until(() => !failed.app.session.busy);
    assert.deepEqual(plain(failed.app.session.actions), actions);
    assert.equal(failed.app.session.undoUsage.usedCount, 0);
    assert.equal(saved(failed.storage).queue.length, 1);
  } finally { failed.app.dispose(); }

  const lateGate = { failState: false, holdState: false, held: [] };
  const late = harness({ storage: storageWithPendingV2({ undo: true }), gate: lateGate });
  try {
    await ready(late);
    late.wire.network({ isConnected: false });
    await enablePending(late);
    await fresh(late);
    await move(late);
    await move(late);
    lateGate.holdState = true;
    await late.render();
    await late.tap('undo');
    await until(() => lateGate.held.length === 1);
    lateGate.holdState = false;
    await fresh(late);
    await lateGate.held[0]();
    await pause(30);
    assert.equal(late.app.session.actions.length, 0);
    assert.equal(late.app.session.undoUsage.usedCount, 0);
    await move(late);
    await finish(late);
    assert.equal(saved(late.storage).queue.length, 1);
    assert.deepEqual(late.uploads, []);
  } finally { late.app.dispose(); }
});
