import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, plain, fakeWorker, wireClone } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = async h => {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  await h.render();
};
const openRules = async h => {
  await h.tap('cabin-guide'); await h.tap('guide-rules-essential');
  assert.equal(h.app.getScene(), 'reader');
};
const returnFromHeader = async h => {
  assert.notEqual(h.app.getScene(), 'game');
  await h.tap(h.app.getScene() === 'home' ? 'cabin-close' : 'home'); await h.render();
};

async function roomFor(actions = [], revision = actions.length + 1) {
  const settings = sut.settingsFor(7);
  const computed = await sut.handleWorkerMessage({
    id: revision, kind: 'STATE', payload: { settings, actions }, context: {},
  });
  assert.equal(computed.ok, true);
  return {
    protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision, seq: actions.length,
    settings, actions: plain(actions), actionIds: actions.map((_, i) => `fixture-action-${i}`),
    status: computed.result.snapshot.gameOver ? 'finished' : 'playing',
    player: 'BLACK', currentPlayer: computed.result.snapshot.currentPlayer,
    stateHash: computed.result.stateHash, ready: { BLACK: true, WHITE: true },
    members: { BLACK: true, WHITE: true }, rematchVotes: {},
  };
}

// Real OnlineClient and GameSession; only platform HTTP/socket/Worker delivery
// are fixtures. A held Worker response makes the navigation race deterministic.
async function onlineHarness(actions = []) {
  const room = await roomFor(actions), gate = { holdState: false, release: null };
  const wire = { requests: [], closeCalls: 0, socket: null };
  const h = uiHarness({
    config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' },
    platformOverrides: {
      login: async () => 'fixture-code',
      choose: async () => 0,
      request: async options => {
        wire.requests.push(plain(options));
        if (options.url.endsWith('/login')) return {
          protocol: 1, token: 'fixture-token', expiresIn: 3600, account: { uid: 'fixture-account' },
        };
        if (options.url.endsWith('/rooms')) return plain(room);
        throw new Error(`Unexpected fixture request: ${options.url}`);
      },
      connectSocket() {
        const callbacks = {};
        const socket = {
          closed: false,
          onOpen(fn) { setTimeout(() => { if (!socket.closed) fn(); }, 0); },
          onMessage(fn) { callbacks.message = fn; },
          onClose(fn) { callbacks.close = fn; },
          onError(fn) { callbacks.error = fn; },
          send() {
            setTimeout(() => {
              if (!socket.closed) callbacks.message?.({ data: JSON.stringify({ type: 'room', room }) });
            }, 0);
          },
          close() { wire.closeCalls++; socket.closed = true; },
        };
        wire.socket = socket; return socket;
      },
      createWorker() {
        const worker = fakeWorker();
        worker.postMessage = message => {
          const copied = wireClone(message);
          const deliver = async () => {
            if (worker.terminated) return;
            const response = await sut.handleWorkerMessage(copied);
            if (!worker.terminated) worker.receive(wireClone(response));
          };
          if (gate.holdState && message.kind === 'STATE') {
            gate.holdState = false; gate.release = deliver;
          } else void deliver();
        };
        return worker;
      },
    },
  });
  await ready(h);
  const local = h.app.session;
  await h.tap('cabin-battle'); await h.tap('friends'); await h.tap('room-submit');
  await until(() => h.app.online.connected && !h.app.online.receiving && !h.app.session.busy);
  await h.render();
  return { h, local, gate, wire };
}

for (const panel of ['settings', 'guide']) {
  test(`top return from local ${panel} preserves the active match and paused clock`, async () => {
    const h = uiHarness();
    try {
      await ready(h);
      const session = h.app.session;
      await session.load({ ...sut.settingsFor(7), turnTimerEnabled: true, turnTimeLimitSeconds: 60 },
        [{ type: 'move', player: 'BLACK', point: [1, 0] }],
        { mode: 'human', paused: true, progress: { remainingMs: 43000, hintsUsed: 2 } });
      session.resume(); await h.render();
      const hash = session.stateHash, actions = plain(session.actions), settings = plain(session.settings);
      if (panel === 'settings') {
        await h.tap('cabin-board'); await h.slide('board-size', 8, 5, 15);
      } else await openRules(h);
      const remaining = session.clock.remaining();
      await returnFromHeader(h);
      assert.equal(h.app.getScene(), 'game');
      assert.equal(h.app.getCabin(), null);
      assert.equal(h.app.session, session);
      assert.equal(session.stateHash, hash);
      assert.deepEqual(session.actions, actions);
      assert.deepEqual(session.settings, settings, 'draft changes do not replace the active match');
      assert.equal(session.hintsUsed, 2);
      if (panel === 'settings') {
        assert.ok(session.clock.remaining() <= remaining && remaining - session.clock.remaining() < 1000);
        assert.equal(session.clock.running, true, 'closing the settings cabin explicitly resumes play');
      } else {
        assert.equal(session.clock.remaining(), remaining); assert.equal(session.clock.running, false);
        assert.equal(session.paused, true, 'return from the reader stays paused');
        assert.ok(h.app.getButtons().some(button => button.id === 'pause-resume' && !button.disabled));
        await h.tap('pause-resume');
      }
      assert.equal(session.canPlay(), true);
    } finally { h.app.dispose(); }
  });
}

test('top return keeps the tutorial progress and its saved original game', async () => {
  const h = uiHarness();
  try {
    await ready(h);
    await h.app.session.newGame(7, 'human');
    await h.app.session.act({ type: 'move', point: [1, 0] });
    const originalHash = h.app.session.stateHash;
    await h.tap('cabin-tutorial'); await h.tap('lesson-1');
    await until(() => h.app.session.tutorial?.index === 1 && !h.app.session.busy);
    await h.app.session.act(sut.TUTORIAL_LEVELS[1].objective);
    const session = h.app.session, tutorial = session.tutorial;
    assert.equal(tutorial.done, true);
    const tutorialHash = session.stateHash, saved = plain(session.savedGame);
    await openRules(h); await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session, session);
    assert.equal(session.tutorial, tutorial);
    assert.equal(session.stateHash, tutorialHash);
    assert.deepEqual(session.savedGame, saved);
    assert.equal(session.savedGame.stateHash, originalHash);
    assert.ok(h.app.getButtons().some(button => button.id === 'lesson-next'));
  } finally { h.app.dispose(); }
});

test('top return from local replay tools keeps cursor, displayed position and full log', async () => {
  const h = uiHarness();
  try {
    await ready(h);
    const session = h.app.session;
    await session.load(sut.settingsFor(7), [
      { type: 'move', player: 'BLACK', point: [1, 0] },
      { type: 'move', player: 'WHITE', point: [5, 0] },
    ], { mode: 'human', paused: true });
    const originalHash = session.stateHash, actions = plain(session.actions);
    await session.replay(1); await h.render();
    const replayHash = session.replayStateHash, snapshot = plain(session.snapshot);
    await h.tap('replay-options'); await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(session.replayIndex, 1);
    assert.equal(session.replayStateHash, replayHash);
    assert.equal(session.stateHash, originalHash);
    assert.deepEqual(session.snapshot, snapshot);
    assert.deepEqual(session.actions, actions);
    assert.equal(session.replayPlaying, false);
    assert.ok(h.app.getButtons().some(button => button.id === 'exit-replay'));
  } finally { h.app.dispose(); }
});

test('top return during an incoming online verification preserves the room socket and commits the update', async () => {
  const { h, local, gate, wire } = await onlineHarness();
  try {
    const client = h.app.online, session = client.game, socket = client.socket, life = client.lifecycle;
    await openRules(h);
    const next = await roomFor([{ type: 'move', player: 'BLACK', point: [1, 0] }]);
    gate.holdState = true;
    const pending = client.receive(next);
    await until(() => gate.release && session.busy);
    await returnFromHeader(h);
    await gate.release();
    assert.equal(await pending, true, 'returning must not cancel room state verification');
    await h.render();
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session, session);
    assert.notEqual(h.app.session, local);
    assert.equal(client.socket, socket);
    assert.equal(client.lifecycle, life);
    assert.equal(client.connected, true);
    assert.equal(client.active, true);
    assert.equal(wire.closeCalls, 0);
    assert.equal(client.room.seq, 1);
    assert.equal(client.room.stateHash, next.stateHash);
    assert.equal(session.stateHash, next.stateHash);
    assert.equal(client.error, null);
  } finally { gate.release?.(); h.app.dispose(); }
});

test('top return from online result and replay tools retains the finished room and replay cursor', async () => {
  const { h, wire } = await onlineHarness([
    { type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' },
  ]);
  try {
    const client = h.app.online, room = client.room, socket = client.socket, session = client.game;
    const hash = session.stateHash;
    await h.tap('result-detail'); await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session, session);
    assert.equal(client.room, room);
    assert.equal(client.socket, socket);
    assert.equal(session.stateHash, hash);
    await h.tap('replay');
    await until(() => session.replayIndex === 0 && !session.busy);
    await h.render(); await h.tap('replay-options');
    const replayHash = session.replayStateHash;
    await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(session.replayIndex, 0);
    assert.equal(session.replayStateHash, replayHash);
    assert.equal(client.room, room);
    assert.equal(client.socket, socket);
    assert.equal(client.active, true);
    assert.equal(client.connected, true);
    assert.equal(wire.closeCalls, 0);
  } finally { h.app.dispose(); }
});

test('top return invalidates a privacy deletion prompt even if the reader is reopened', async () => {
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' } });
  let confirm, deletions = 0;
  try {
    await ready(h);
    h.p.confirm = () => new Promise(resolve => { confirm = resolve; });
    h.app.online.deleteAccount = async () => { deletions++; return true; };
    await h.tap('cabin-battle'); await h.scrollTo('account-privacy'); await h.tap('account-privacy'); await h.tap('delete-account');
    assert.equal(typeof confirm, 'function');
    await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    await h.tap('cabin-battle'); await h.scrollTo('account-privacy'); await h.tap('account-privacy');
    confirm(true); await sleep(20);
    assert.equal(deletions, 0);
    assert.equal(h.app.getScene(), 'reader');
  } finally { h.app.dispose(); }
});

test('top return cancels pending file work without replacing the active match or leaving a busy library', async () => {
  const h = uiHarness();
  let readClipboard;
  try {
    await ready(h);
    const session = h.app.session, hash = session.stateHash;
    h.p.readClipboard = () => new Promise(resolve => { readClipboard = resolve; });
    await h.tap('library'); await h.tap('import-replay');
    assert.equal(typeof readClipboard, 'function');
    await returnFromHeader(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session, session);
    readClipboard('not a replay'); await sleep(20);
    assert.equal(session.stateHash, hash);
    assert.equal(new sut.ReplayLibrary(h.p.storage).read().entries.length, 0);
    assert.deepEqual(h.p.messages, [], 'cancelled input does not produce a late error dialog');
    await h.tap('library');
    assert.equal(h.app.getButtons().find(button => button.id === 'import-replay')?.disabled, false);
  } finally { h.app.dispose(); }
});
