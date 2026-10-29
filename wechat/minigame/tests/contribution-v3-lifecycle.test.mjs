import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage, fakeWorker, wireClone, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TrainingContribution } from '../src/training-contribution.js';

const KEY = 'lifeline-wx-training-contribution-v1';
const PREFERENCES = 'lifeline-wx-preferences-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const saved = storage => JSON.parse(storage.get(KEY) || '{"enabled":false,"queue":[],"received":[]}');

function preferencesStorage({ undo = false } = {}) {
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
  return storage;
}

function storageWithPendingV2() {
  const storage = preferencesStorage();
  const collector = new TrainingContribution({ storage, canRun: () => false, version: 2 });
  const settings = {
    rulesVersion: 'territory-v2', gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
    hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false,
    turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3,
  };
  const context = {
    source: 'local', actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'human' } },
    mixedProfiles: false, hintsEnabled: false,
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

function harness({ storage = preferencesStorage(), holdPost = false, gate = null, service = true } = {}) {
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
        supported_versions: [1, 2, 3],
        consent_policies: { 2: 'anonymous-replay-training-v2', 3: 'anonymous-replay-training-v3' },
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

async function enableContribution(h, { close = true } = {}) {
  await openContribution(h);
  const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
  assert.ok(toggle && !toggle.disabled, 'V3 consent control is available');
  await h.tap('training-contribution');
  await h.render();
  assert.equal(saved(h.storage).enabled, true);
  if (close) await h.tap('cabin-close');
}

async function move(h, index = 0) {
  const before = h.app.session.actions.length;
  const point = h.app.session.snapshot.legalMoves[index].point;
  assert.equal(await h.app.session.act({ type: 'move', point }), true);
  await until(() => h.app.session.actions.length === before + 1 && !h.app.session.busy);
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
  await h.tap('friends');
  await h.tap('room-submit');
}

test('V3 consent stays off when declined or when its board cabin becomes stale', async () => {
  const h = harness();
  try {
    await ready(h);
    h.p.confirm = async () => false;
    await openContribution(h);
    await h.tap('training-contribution');
    assert.equal(saved(h.storage).enabled, false);

    let answer;
    h.p.confirm = () => new Promise(resolve => { answer = resolve; });
    await h.tap('training-contribution');
    await until(() => answer);
    await h.tap('cabin-guide');
    answer(true);
    await pause(30);
    assert.equal(saved(h.storage).enabled, false);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('enabling mid-match never backfills it, while the next complete V3 local match uploads', async () => {
  const h = harness();
  try {
    await ready(h);
    await move(h);
    await enableContribution(h);
    await finish(h);
    await pause(300);
    assert.deepEqual(h.uploads, []);
    await fresh(h);
    await finish(h);
    await until(() => h.uploads.length === 1);
    assert.equal(h.uploads[0].version, 3);
    assert.equal(h.uploads[0].consent_policy, 'anonymous-replay-training-v3');
    assert.equal(h.uploads[0].replay.config.rulesVersion, 'territory-v3');
  } finally { h.app.dispose(); }
});

test('a restored V3 match remains excluded after fresh consent', async () => {
  const storage = preferencesStorage();
  const first = harness({ storage });
  try { await ready(first); await move(first); }
  finally { first.app.dispose(); }

  const h = harness({ storage });
  try {
    await ready(h);
    assert.equal(h.app.session.actions.length, 1);
    await enableContribution(h);
    await finish(h);
    await pause(300);
    assert.deepEqual(h.uploads, []);
  } finally { h.app.dispose(); }
});

test('replay, tutorial and online transitions invalidate V3 contribution tickets', async () => {
  for (const boundary of ['replay', 'tutorial', 'online']) {
    const h = harness();
    try {
      await ready(h);
      await enableContribution(h);
      await fresh(h);
      await move(h);
      const local = h.app.session;
      if (boundary === 'replay') {
        await replayBoundary(h);
        local.resume();
        await h.render();
        await finish(h);
      } else if (boundary === 'tutorial') {
        await tutorialBoundary(h);
        local.resume();
        await h.render();
        await finish(h);
      } else {
        await enterOnline(h);
        await until(() => h.app.session === h.app.online.game);
        local.resume();
        assert.equal(await local.act({ type: 'resign' }), true);
      }
      await pause(300);
      assert.deepEqual(h.uploads, [], boundary);
    } finally { h.app.dispose(); }
  }
});

test('a frozen pending V2 replay retries under v2, then a fresh V3 match uses v3', async () => {
  const h = harness({ storage: storageWithPendingV2() });
  try {
    await ready(h);
    await enableContribution(h, { close: false });
    await until(() => h.uploads.length === 1 && saved(h.storage).queue.length === 0);
    assert.equal(h.uploads[0].version, 2);
    assert.equal(h.uploads[0].consent_policy, 'anonymous-replay-training-v2');
    await fresh(h);
    await finish(h);
    await until(() => h.uploads.length === 2);
    assert.equal(h.uploads[1].version, 3);
    assert.equal(h.uploads[1].consent_policy, 'anonymous-replay-training-v3');
  } finally { h.app.dispose(); }
});

test('an offline V3 outbox survives restart but cannot retry without fresh consent', async () => {
  const storage = preferencesStorage();
  const first = harness({ storage });
  try {
    await ready(first);
    await enableContribution(first);
    first.wire.network({ isConnected: false });
    await fresh(first);
    await finish(first);
    await until(() => saved(storage).queue.length === 1);
    assert.deepEqual(first.uploads, []);
  } finally { first.app.dispose(); }

  const second = harness({ storage });
  try {
    await ready(second);
    await pause(300);
    assert.deepEqual(second.uploads, []);
    await enableContribution(second);
    await until(() => second.uploads.length === 1 && saved(storage).queue.length === 0);
    assert.equal(second.uploads[0].version, 3);
  } finally { second.app.dispose(); }
});

test('six-player hex V3 local games are eligible after explicit consent', async () => {
  const h = harness();
  try {
    await ready(h);
    await h.tap('cabin-board');
    await h.slide('player-count', 6, 2, 15);
    await h.scrollTo('training-contribution');
    await h.tap('training-contribution');
    await h.tap('cabin-close');
    await fresh(h);
    assert.equal(h.app.session.settings.playerCount, 6);
    assert.equal(h.app.session.settings.boardShape, 'hexagon');
    while (!h.app.session.snapshot.gameOver) {
      const before = h.app.session.actions.length;
      assert.equal(await h.app.session.act({ type: 'skip' }), true);
      await until(() => h.app.session.actions.length === before + 1 && !h.app.session.busy);
    }
    await until(() => h.uploads.length === 1);
    assert.equal(h.uploads[0].version, 3);
    assert.equal(h.uploads[0].replay.config.playerCount, 6);
    assert.equal(Object.keys(h.uploads[0].context.actors).length, 6);
  } finally { h.app.dispose(); }
});

test('withdrawing consent aborts an in-flight V3 upload and late success cannot restore it', async () => {
  const h = harness({ holdPost: true });
  try {
    await ready(h);
    await enableContribution(h);
    await fresh(h);
    await finish(h);
    await until(() => h.uploads.length === 1 && h.wire.settle);
    await openContribution(h);
    await h.tap('training-contribution');
    assert.equal(h.wire.aborts, 1);
    assert.equal(saved(h.storage).enabled, false);
    assert.equal(saved(h.storage).queue.length, 0);
    h.wire.settle();
    await pause(50);
    assert.equal(saved(h.storage).enabled, false);
    assert.deepEqual(saved(h.storage).received, []);
  } finally { h.wire.settle?.(); h.app.dispose(); assert.equal(h.wire.listenerStopped, true); }
});

test('a late undo Worker response from an invalidated match cannot enter the V3 outbox', async () => {
  const gate = { holdState: false, held: [] };
  const h = harness({ storage: preferencesStorage({ undo: true }), gate });
  try {
    await ready(h);
    await enableContribution(h);
    await fresh(h);
    await move(h);
    await move(h);
    gate.holdState = true;
    await h.render();
    await h.tap('undo');
    await until(() => gate.held.length === 1);
    gate.holdState = false;
    await fresh(h);
    await gate.held[0]();
    await pause(30);
    assert.equal(h.app.session.actions.length, 0);
    await move(h);
    await finish(h);
    await until(() => h.uploads.length === 1);
    assert.deepEqual(h.uploads[0].context.undo, { enabled: true, maxCount: 3, usedCount: 0 });
  } finally { h.app.dispose(); }
});
