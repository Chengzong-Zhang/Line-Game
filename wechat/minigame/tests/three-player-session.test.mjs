import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, until, plain, fakeWorker, wireClone } from './helpers.mjs';
import { contributionContext } from '../src/training-contribution.js';

const profile = 'three-player-policy-v1';
const players = ['BLACK', 'WHITE', 'PURPLE'];
const roles = (...ais) => Object.fromEntries(players.map(player => [player, ais.includes(player) ? profile : 'human']));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const gameContent = capture => { const value = plain(capture); delete value.session.savedAt; return value; };
const fixture = () => {
  const q = localScheduler(), store = new sut.SaveStore(memoryStorage());
  return { q, store, session: new sut.GameSession(q, store) };
};

test('three-player controllers are explicit and never reinterpret a two-player model or a legacy human save', () => {
  assert.deepEqual(sut.controllerChoices(3), ['human', profile, 'three-player-policy-v2', 'three-player-search-v4-round12',
    'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1']);
  assert.deepEqual(sut.validateControllers(roles('PURPLE'), 3), roles('PURPLE'));
  assert.equal(sut.controllersMode(roles('PURPLE')), 'human');
  assert.deepEqual(sut.presetControllers('ai-duel', 'normal', 3), roles());
  for (const invalid of [{ BLACK: 'human', WHITE: 'human' }, { ...roles(), PURPLE: 'greedy' },
    { ...roles(), BLACK: 'model:unknown' }, { ...roles(), EXTRA: 'human' }]) {
    assert.throws(() => sut.validateControllers(invalid, 3), /INVALID_CONTROLLERS/);
  }
  assert.throws(() => sut.validateControllers({ BLACK: profile, WHITE: 'human' }, 2), /INVALID_CONTROLLERS/);
});

test('each three-player seat can start as AI, make one legal move, then hand control to a human', async () => {
  for (const player of players) {
    const { q, session } = fixture();
    try {
      assert.equal(await session.newGame(5, 'human', 'normal', 3, { controllers: roles(player), startPlayer: player }), true);
      await until(() => session.actions.length === 1 && !session.busy);
      assert.equal(session.actions[0].player, player);
      assert.equal(session.actions[0].type, 'move');
      assert.equal(session.canPlay(), true);
      assert.equal(session.error, null);
      assert.equal(session.stateHash, sut.ruleView(sut.restoreGame(session.settings, session.actions)).stateHash);
    } finally { session.hide(); q.cancel(); }
  }
});

test('two AI seats play consecutively and their settings survive save, library and tutorial return', async () => {
  const { q, session, store } = fixture(); let restored, legacy;
  try {
    await session.newGame(7, 'human', 'normal', 3, { controllers: roles('BLACK', 'WHITE') });
    await until(() => session.actions.length === 2 && !session.busy);
    assert.deepEqual(session.actions.map(action => action.player), ['BLACK', 'WHITE']);
    assert.equal(session.snapshot.currentPlayer, 'PURPLE');
    const hash = session.stateHash;
    restored = new sut.GameSession(q, store);
    assert.equal(await restored.restore(), true);
    assert.deepEqual(restored.controllers, roles('BLACK', 'WHITE'));
    assert.equal(restored.stateHash, hash); assert.equal(restored.paused, true);
    const library = new sut.ReplayLibrary(memoryStorage());
    const id = library.save(restored.capture());
    assert.deepEqual(library.read().entries.find(entry => entry.id === id).payload.controllers, roles('BLACK', 'WHITE'));
    await restored.tutorialLevel(0); await restored.exitTutorial();
    assert.equal(restored.stateHash, hash); assert.deepEqual(restored.controllers, roles('BLACK', 'WHITE'));
    assert.equal(restored.controllerFor('PURPLE'), 'human');
    legacy = new sut.GameSession(q, store);
    assert.equal(await legacy.load({ ...sut.settingsFor(7, 3), rulesVersion: 'territory-v2' }, [],
      { controllers: roles('BLACK', 'WHITE'), paused: true, autoplay: false, save: false }), true);
    assert.deepEqual(contributionContext(legacy).actors, { BLACK: { kind: 'ai', profile: roles('BLACK', 'WHITE').BLACK }, WHITE: { kind: 'ai', profile: roles('BLACK', 'WHITE').WHITE }, PURPLE: { kind: 'human' } }, 'v2 collector preserves each actual AI profile');
  } finally { legacy?.hide(); restored?.hide(); session.hide(); q.cancel(); }
});

test('three AI seats can be paused without a late extra move or losing their save', async () => {
  const { q, session, store } = fixture();
  try {
    await session.newGame(5, 'human', 'normal', 3, { controllers: roles(...players) });
    await until(() => session.actions.length >= 3);
    session.pause(); const actions = plain(session.actions), hash = session.stateHash;
    await delay(40);
    assert.deepEqual(session.actions, actions); assert.equal(session.stateHash, hash);
    assert.equal(session.busy, false); assert.equal(session.paused, true);
    assert.deepEqual(store.read().payload.controllers, roles(...players));
  } finally { session.hide(); q.cancel(); }
});

test('three-player hints use a shared budget, preserve the position and retain usage after restore', async () => {
  const { q, session, store } = fixture(); let restored;
  try {
    await session.newGame(5, 'human', 'normal', 3, { startPlayer: 'PURPLE', controllers: roles(),
      playOptions: { hintEnabled: true, hintMaxCount: 1 } });
    const hash = session.stateHash, snapshot = plain(session.snapshot);
    assert.equal(await session.hint(), true);
    assert.equal(session.stateHash, hash); assert.deepEqual(session.snapshot, snapshot);
    assert.ok(snapshot.legalMoves.some(move => String(move.point) === String(session.hintPoint)));
    assert.equal(session.hintsRemaining, 0);
    assert.equal(await session.hint(), false); assert.equal(session.actions.length, 0);
    restored = new sut.GameSession(q, store); assert.equal(await restored.restore(), true);
    assert.equal(restored.hintsUsed, 1); assert.equal(restored.hintsRemaining, 0);
    assert.equal(restored.settings.startPlayer, 'PURPLE');
  } finally { restored?.hide(); session.hide(); q.cancel(); }
});

test('three-player analysis is read-only; a replay branch can retain all three controllers', async () => {
  const { q, session } = fixture();
  try {
    await session.newGame(5, 'human', 'normal', 3, { controllers: roles('BLACK', 'WHITE') });
    await until(() => session.actions.length === 2 && !session.busy);
    const original = session.capture(), originalHash = session.stateHash;
    await session.replay(1); const replayHash = session.replayStateHash, player = session.snapshot.currentPlayer;
    const analysis = await session.analyzeReplay(profile);
    assert.equal(analysis.profile, profile); assert.equal(analysis.player, player);
    assert.equal(analysis.stateHash, replayHash); assert.equal(analysis.metric, 'policy-score');
    assert.equal(session.stateHash, originalHash); assert.deepEqual(gameContent(session.capture()), gameContent(original));
    const archives = [];
    assert.equal(await session.forkReplay({ keepPlayers: true, archive: saved => archives.push(saved) }), true);
    assert.deepEqual(archives.map(gameContent), [gameContent(original)]); assert.deepEqual(session.controllers, roles('BLACK', 'WHITE'));
    assert.equal(session.stateHash, replayHash); assert.equal(session.actions.length, 1); assert.equal(session.paused, true);
    session.resume(); await until(() => session.actions.length === 2 && !session.busy);
    assert.equal(session.snapshot.currentPlayer, 'PURPLE');
  } finally { session.hide(); q.cancel(); }
});

test('a late three-player AI result cannot act after hide or replacement by a two-player game', async () => {
  for (const boundary of ['hide', 'replace']) {
    const { q, session } = fixture();
    const request = q.request.bind(q); let release;
    q.request = (kind, payload, context, priority) => {
      if (kind !== 'AI') return request(kind, payload, context, priority);
      const result = sut.executeTask({ kind, payload, context });
      return new Promise(resolve => { release = () => resolve(result); });
    };
    try {
      await session.newGame(5, 'human', 'normal', 3, { controllers: roles('BLACK') });
      await until(() => release);
      if (boundary === 'hide') session.hide(); else await session.newGame(7, 'human', 'easy', 2);
      const hash = session.stateHash, settings = plain(session.settings);
      release(); await delay(30);
      assert.equal(session.actions.length, 0); assert.equal(session.stateHash, hash);
      assert.deepEqual(session.settings, settings); assert.equal(session.busy, false);
    } finally { session.hide(); q.cancel(); }
  }
});

test('three-player AI timeout pauses and preserves the save, then an explicit retry can use a fresh worker', async () => {
  let block = true;
  const q = new sut.ComputeScheduler(() => {
    const worker = fakeWorker();
    worker.postMessage = message => {
      if (block && message.kind === 'AI') return;
      setTimeout(async () => {
        if (worker.terminated) return;
        const result = await sut.handleWorkerMessage(wireClone(message));
        if (!worker.terminated) worker.receive(wireClone(result));
      }, 1);
    };
    return worker;
  }, { timeoutMs: 100 });
  const store = new sut.SaveStore(memoryStorage()), session = new sut.GameSession(q, store);
  try {
    await session.newGame(5, 'human', 'normal', 3, { controllers: roles('BLACK') });
    await until(() => session.error === 'COMPUTE_TIMEOUT');
    assert.equal(session.paused, true); assert.equal(session.actions.length, 0);
    assert.deepEqual(store.read().payload.controllers, roles('BLACK'));
    block = false; session.resume(); await until(() => session.actions.length === 1 && !session.busy);
    assert.equal(session.error, null); assert.equal(session.canPlay(), true);
  } finally { session.hide(); q.cancel(); }
});
