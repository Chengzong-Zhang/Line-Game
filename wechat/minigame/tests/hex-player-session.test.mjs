import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, until, plain, fakeWorker, wireClone } from './helpers.mjs';
import { contributionContext, TrainingContribution } from '../src/training-contribution.js';

const profile = 'hex-player-policy-v1';
const players = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
const roles = (count, ...ais) => Object.fromEntries(players.slice(0, count).map(player => [player, ais.includes(player) ? profile : 'human']));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = capture => { const value = plain(capture); delete value.session.savedAt; return value; };
const fixture = () => {
  const q = localScheduler(), store = new sut.SaveStore(memoryStorage());
  return { q, store, session: new sut.GameSession(q, store) };
};

test('4–6 player controllers match every seat exactly and reject strategies for other geometries', () => {
  for (const count of [4, 5, 6]) {
    assert.deepEqual(sut.playerIds(count), players.slice(0, count));
    assert.deepEqual(sut.controllerChoices(count), ['human', profile,
      'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1']);
    assert.deepEqual(sut.presetControllers('ai-duel', 'normal', count), roles(count));
    assert.deepEqual(sut.validateControllers(roles(count, players[count - 1]), count), roles(count, players[count - 1]));
    assert.equal(sut.controllersMode(roles(count, players[count - 1])), 'human');
    const missing = roles(count); delete missing[players[count - 1]];
    for (const invalid of [missing, { ...roles(count), EXTRA: 'human' },
      { ...roles(count), BLACK: 'greedy' }, { ...roles(count), BLACK: 'three-player-policy-v1' },
      { ...roles(count), BLACK: 'model:unknown' }]) assert.throws(() => sut.validateControllers(invalid, count), /INVALID_CONTROLLERS/);
  }
  for (const count of [2, 3]) assert.throws(() => sut.validateControllers({ ...sut.presetControllers('human', 'easy', count), BLACK: profile }, count), /INVALID_CONTROLLERS/);
  for (const count of [0, 1, 3.5, 16, '4']) {
    assert.deepEqual(sut.playerIds(count), []); assert.deepEqual(sut.controllerChoices(count), []);
    assert.throws(() => sut.validateControllers({}, count), /INVALID_CONTROLLERS/);
  }
});

test('every seat of four, five and six players can start as hex AI and then hand control to a human', async () => {
  for (const count of [4, 5, 6]) for (const player of players.slice(0, count)) {
    const { q, session } = fixture();
    try {
      assert.equal(await session.newGame(5, 'human', 'normal', count, { startPlayer: player, controllers: roles(count, player) }), true);
      await until(() => session.actions.length === 1 && !session.busy);
      assert.equal(session.actions[0].player, player); assert.equal(session.actions[0].type, 'move');
      assert.equal(session.canPlay(), true); assert.equal(session.error, null);
      assert.equal(session.stateHash, sut.ruleView(sut.restoreGame(session.settings, session.actions)).stateHash);
      assert.equal(session.snapshot.players.length, count);
    } finally { session.hide(); q.cancel(); }
  }
});

test('all six AI seats can be paused and saved without a late extra action', async () => {
  const { q, session, store } = fixture();
  try {
    await session.newGame(5, 'human', 'normal', 6, { controllers: roles(6, ...players) });
    await until(() => session.actions.length >= 6);
    session.pause(); const actions = plain(session.actions), hash = session.stateHash;
    await delay(30);
    assert.deepEqual(session.actions, actions); assert.equal(session.stateHash, hash);
    assert.equal(session.paused, true); assert.equal(session.busy, false);
    assert.deepEqual(store.read().payload.controllers, roles(6, ...players));
  } finally { session.hide(); q.cancel(); }
});

test('hex roles, hints and original state survive save, library, tutorial and replay branch for each count', async () => {
  for (const count of [4, 5, 6]) {
    const { q, session, store } = fixture(); let restored;
    try {
      const last = players[count - 1], controllers = roles(count, 'BLACK', 'WHITE');
      await session.newGame(5, 'human', 'normal', count, { startPlayer: last, controllers,
        playOptions: { hintEnabled: true, hintMaxCount: 1 } });
      assert.equal(session.canPlay(), true);
      const initial = session.stateHash;
      assert.equal(await session.hint(), true); assert.equal(session.stateHash, initial);
      assert.equal(session.hintsRemaining, 0);
      await session.act({ type: 'move', point: session.hintPoint });
      await until(() => session.actions.length === 3 && !session.busy);
      assert.deepEqual(session.actions.map(action => action.player), [last, 'BLACK', 'WHITE']);
      assert.equal(session.snapshot.currentPlayer, 'PURPLE');
      restored = new sut.GameSession(q, store); assert.equal(await restored.restore(), true);
      assert.equal(restored.stateHash, session.stateHash); assert.deepEqual(restored.controllers, controllers);
      assert.equal(restored.hintsUsed, 1); assert.equal(restored.hintsRemaining, 0);
      const library = new sut.ReplayLibrary(memoryStorage()), savedId = library.save(restored.capture());
      assert.deepEqual(library.read().entries.find(entry => entry.id === savedId).payload.controllers, controllers);
      const original = content(restored.capture()), hash = restored.stateHash;
      await restored.tutorialLevel(0); await restored.exitTutorial();
      assert.deepEqual(content(restored.capture()), original); assert.equal(restored.stateHash, hash);
      await restored.replay(2); const branchHash = restored.replayStateHash;
      const analysis = await restored.analyzeReplay(profile);
      assert.equal(analysis.profile, profile); assert.equal(analysis.player, 'WHITE');
      assert.equal(analysis.metric, 'policy-score'); assert.equal(analysis.stateHash, branchHash);
      assert.equal(restored.stateHash, hash); assert.deepEqual(content(restored.capture()), original);
      const archives = [];
      assert.equal(await restored.forkReplay({ keepPlayers: true, archive: value => archives.push(content(value)) }), true);
      assert.deepEqual(archives, [original]); assert.deepEqual(restored.controllers, controllers);
      assert.equal(restored.stateHash, branchHash); assert.equal(restored.actions.length, 2);
      assert.equal(restored.hintsUsed, 0); assert.equal(restored.paused, true);
      restored.resume(); await until(() => restored.actions.length === 3 && !restored.busy);
      assert.equal(restored.snapshot.currentPlayer, 'PURPLE');
    } finally { restored?.hide(); session.hide(); q.cancel(); }
  }
});

test('hex sessions without controllers stay human in v2 anonymous training metadata', async () => {
  for (const count of [4, 5, 6]) {
    const { q, session } = fixture();
    try {
      await session.load({ ...sut.settingsFor(5, count), boardShape: 'hexagon', rulesVersion: 'territory-v2' }, [],
        { mode: 'human', paused: false, save: false });
      assert.equal(session.mode, 'human'); assert.equal(session.isAITurn(), false); assert.equal(session.canPlay(), true);
      assert.deepEqual(Object.values(contributionContext(session).actors), Array.from({ length: count }, () => ({ kind: 'human' })));
      let sent = 0;
      const collector = new TrainingContribution({ storage: memoryStorage(), request: () => { sent++; }, origin: 'https://lifelinegame.cn', version: 2 });
      collector.setEnabled(true);
      assert.ok(collector.beginMatch({ settings: session.settings, context: contributionContext(session), source: 'local', actionCount: 0 }));
      assert.equal(sent, 0); assert.equal(collector.snapshot().status, 'ready');
      collector.setEnabled(false);
    } finally { session.hide(); q.cancel(); }
  }
});

test('a late hex result cannot act after hide or replacement by another geometry', async () => {
  for (const boundary of ['hide', 2, 3]) {
    const { q, session } = fixture(); const request = q.request.bind(q); let release;
    q.request = (kind, payload, context, priority) => {
      if (kind !== 'AI') return request(kind, payload, context, priority);
      const result = sut.executeTask({ kind, payload, context });
      return new Promise(resolve => { release = () => resolve(result); });
    };
    try {
      await session.newGame(5, 'human', 'normal', 6, { controllers: roles(6, 'CYAN'), startPlayer: 'CYAN' });
      await until(() => release);
      if (boundary === 'hide') session.hide(); else await session.newGame(7, 'human', 'easy', boundary);
      const hash = session.stateHash, settings = plain(session.settings);
      release(); await delay(20);
      assert.equal(session.actions.length, 0); assert.equal(session.stateHash, hash);
      assert.deepEqual(session.settings, settings); assert.equal(session.busy, false);
    } finally { session.hide(); q.cancel(); }
  }
});

test('hex AI timeout retains all six controllers and an explicit retry replaces the worker', async () => {
  let block = true;
  const q = new sut.ComputeScheduler(() => {
    const worker = fakeWorker(); worker.postMessage = message => {
      if (block && message.kind === 'AI') return;
      setTimeout(async () => {
        if (worker.terminated) return;
        const result = await sut.handleWorkerMessage(wireClone(message));
        if (!worker.terminated) worker.receive(wireClone(result));
      }, 1);
    }; return worker;
  }, { timeoutMs: 100 });
  const store = new sut.SaveStore(memoryStorage()), session = new sut.GameSession(q, store);
  try {
    await session.newGame(5, 'human', 'normal', 6, { controllers: roles(6, 'CYAN'), startPlayer: 'CYAN' });
    await until(() => session.error === 'COMPUTE_TIMEOUT');
    assert.equal(session.paused, true); assert.equal(session.actions.length, 0);
    assert.deepEqual(store.read().payload.controllers, roles(6, 'CYAN'));
    block = false; session.resume(); await until(() => session.actions.length === 1 && !session.busy);
    assert.equal(session.error, null); assert.equal(session.snapshot.currentPlayer, 'BLACK'); assert.equal(session.canPlay(), true);
  } finally { session.hide(); q.cancel(); }
});
