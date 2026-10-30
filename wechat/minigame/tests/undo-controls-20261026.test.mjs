import { typeNumber } from './number-keyboard-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, plain, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };

test('local undo repeatedly returns the acting human to before their preceding move, including after restore', async () => {
  for (const count of [2, 3, 6]) {
    const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage()), game = new sut.GameSession(scheduler, store);
    try {
      assert.equal(await game.newGame(9, 'human', 'easy', count, { playOptions: { undoEnabled: true, undoMaxCount: 100 } }), true);
      const hashes = [game.stateHash], actors = [];
      for (let turn = 0; turn < count * 3; turn++) {
        actors.push(game.snapshot.currentPlayer);
        assert.equal(await game.act({ type: 'move', point: game.snapshot.legalMoves[0].point }), true);
        hashes.push(game.stateHash);
      }
      const requester = game.snapshot.currentPlayer;
      let remaining = actors.length, used = 0;
      for (let index = actors.slice(0, remaining).lastIndexOf(requester); index >= 0; index = actors.slice(0, remaining).lastIndexOf(requester)) {
        assert.equal(await game.undo(), true);
        assert.equal(game.actions.length, index);
        assert.equal(game.stateHash, hashes[index], 'full rule state must match the previous own-turn position');
        assert.equal(game.snapshot.currentPlayer, requester);
        remaining = index; used++;
        assert.equal(game.undoRemaining, 100 - used);
        if (used === 1) {
          const saved = plain(store.read().payload);
          assert.equal(await game.load(saved.session.settings, saved.session.actions, { ...saved, autoplay: false }), true);
          assert.equal(game.undoAvailable, actors.slice(0, remaining).includes(requester), 'restoring preserves availability of the next older own move');
        }
      }
      assert.ok(used >= 2, 'the fixture exercises consecutive undos');
      assert.equal(game.undoAvailable, false);
    } finally { game.hide(); scheduler.cancel(); }
  }
});

test('undo settings accept 100 and reject values outside the new limit', () => {
  assert.equal(sut.normalizePlayOptions({ undoMaxCount: 100 }).undoMaxCount, 100);
  for (const undoMaxCount of [0, 101, 1.5]) assert.throws(() => sut.normalizePlayOptions({ undoMaxCount }), /INVALID_PLAY_OPTIONS/);
});

test('board cabin exposes and persists the 100-undo setting', async () => {
  const h = uiHarness();
  try {
    await ready(h); await h.tap('cabin-board'); await h.scrollTo('undo-enabled'); await h.tap('undo-enabled');
    await typeNumber(h, 'undo-count', 100);
    const options = sut.readPreferences(h.p.storage).playOptions;
    assert.equal(options.undoEnabled, true); assert.equal(options.undoMaxCount, 100);
  } finally { h.app.dispose(); }
});

test('online undo mirrors zoom without covering the room number; vote row stays above main controls and emotes', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88]]) {
    const drawnText = [];
    const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 8 }),
      fillText: (value, x, y) => drawnText.push({ text: String(value), x, y }) }, { get: (obj, key) => key in obj ? obj[key] : () => {} });
    const h = uiHarness({ language, width, height, top, canvas: { getContext: () => ctx },
      config: { onlineEnabled: true, apiBase: 'https://test.invalid' } });
    const settings = { ...sut.settingsFor(15), undoEnabled: true, undoMaxCount: 100 }, votes = [];
    h.app.online.enter = async () => {
      const game = h.app.online.game;
      const actions = [];
      for (let turn = 0; turn < 2; turn++) {
        const result = sut.executeTask({ kind: 'STATE', payload: { settings, actions } });
        actions.push({ type: 'move', point: result.snapshot.legalMoves[0].point, player: result.snapshot.currentPlayer });
      }
      await game.load(settings, actions, { mode: 'human', paused: true, save: false });
      h.app.online.active = h.app.online.connected = true;
      h.app.online.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 2, stateHash: game.stateHash,
        status: 'playing', player: 'BLACK', settings, ready: {}, rematchVotes: {}, actions: plain(game.actions),
        undo: { usedCount: 0, pending: false, votes: [] } };
      h.app.online.notify(); return true;
    };
    h.app.online.voteUndo = async accept => { votes.push(accept); return true; };
    try {
      await ready(h); await h.tap('friends'); await h.scrollTo('room-submit'); await h.tap('room-submit'); await until(() => h.app.session === h.app.online.game); await h.render();
      const undo = h.app.getButtons().find(b => b.id === 'undo'), zoom = h.app.getButtons().find(b => b.id === 'board-zoom');
      assert.ok(undo); assert.ok(zoom); assert.equal(undo.y, zoom.y); assert.ok(undo.x + undo.width < zoom.x);
      const room = drawnText.findLast(item => item.text.includes('ABCDEFGH'));
      assert.ok(room); assert.ok(undo.y >= room.y + 16, 'room code remains above the separate board toolbar');
      await h.tap('undo'); assert.deepEqual(votes, [true]);
      h.app.online.room.undo = { usedCount: 0, pending: true, votes: ['WHITE'] }; await h.render();
      const buttons = h.app.getButtons(), accept = buttons.find(b => b.id === 'undo-accept'), reject = buttons.find(b => b.id === 'undo-reject');
      const main = buttons.find(b => b.id === 'room-wait'), emote = buttons.find(b => b.id === 'emote-0');
      assert.ok(accept && reject && main && emote);
      assert.equal(accept.y, reject.y); assert.equal(main.y - accept.y, 54); assert.equal(emote.y - main.y, 56);
      for (const b of buttons) {
        assert.ok(b.y >= 0 && b.y + b.height <= height - 24, b.id);
        if (b !== accept && b !== reject) {
          assert.equal(overlap(accept, b), false, `accept overlaps ${b.id}`);
          assert.equal(overlap(reject, b), false, `reject overlaps ${b.id}`);
        }
      }
      await h.tap('undo-accept'); await h.tap('undo-reject'); assert.deepEqual(votes, [true, true, false]);
    } finally { h.app.dispose(); }
  }
});
