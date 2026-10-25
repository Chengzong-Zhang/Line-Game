import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';
import { drawResult } from '../src/help-ui.js';

const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };

test('7–15 native seats have colors, labels and generic AI only; default roots are rejected', () => {
  for (let count = 7; count <= 15; count++) {
    const players = sut.playerIds(count);
    assert.equal(players.length, count);
    assert.deepEqual(sut.controllerChoices(count), ['human', 'greedy', 'multiplayer-hard-v1']);
    for (const player of players) {
      assert.match(sut.PLAYER_COLORS[player], /^#[a-f0-9]{6}$/i);
      assert.match(sut.PLAYER_CONTRAST_COLORS[player], /^#[a-f0-9]{6}$/i);
      for (const language of ['zh', 'en']) assert.ok(TEXT[language][sut.PLAYER_LABEL_KEYS[player]]);
    }
    assert.throws(() => sut.restoreGame(sut.settingsFor(9, count)));
    const settings = { ...sut.settingsFor(9, count), startingPointMode: 'random',
      initialPositions: sut.randomInitialPositions(9, count) };
    const engine = sut.restoreGame(settings);
    assert.equal(engine.getSnapshot().players.length, count);
    assert.throws(() => sut.validateControllers(Object.fromEntries(players.map(player => [player, 'hex-player-policy-v1'])), settings));
    assert.deepEqual(sut.validateUndoUsage({ usedCount: 1, blockedPlayers: [players.at(-1)] }, { ...settings, undoEnabled: true }),
      { usedCount: 1, blockedPlayers: [players.at(-1)] });
  }
  assert.deepEqual(sut.playerIds(16), []);
});

test('15-player save, replay and native Worker preserve roots, history, seats and actual last player', async () => {
  const scheduler = localScheduler(), storage = memoryStorage(), store = new sut.SaveStore(storage);
  const session = new sut.GameSession(scheduler, store);
  try {
    assert.equal(await session.newGame(9, 'human', 'normal', 15, { startPlayer: 'CORAL' }), true);
    assert.equal(session.settings.startingPointMode, 'random');
    assert.equal(session.snapshot.currentPlayer, 'CORAL');
    assert.equal(await session.act({ type: 'skip' }), true);
    assert.equal(session.snapshot.currentPlayer, 'BLACK');
    const hash = session.stateHash, saved = session.capture();
    assert.equal(await session.load(saved.session.settings, saved.session.actions, { autoplay: false }), true);
    assert.equal(session.stateHash, hash);
    assert.equal(await session.replay(0), true);
    assert.equal(session.snapshot.currentPlayer, 'CORAL');
    await session.exitReplay();
    assert.equal(session.stateHash, hash);
    const engine = sut.restoreGame(saved.session.settings, saved.session.actions);
    const reply = await sut.handleWorkerMessage({ id: 1, kind: 'AI', context: { player: engine.currentPlayer },
      payload: { settings: saved.session.settings, actions: saved.session.actions, profile: 'greedy' } });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.player, 'BLACK');
    assert.equal(reply.result.stateHash, hash);
    assert.ok(engine._evaluateMove(reply.result.moves[0].point, engine.currentPlayer).legal);
  } finally { session.hide(); scheduler.cancel(); }
});

test('15-player Canvas renders all node states and numbered starting nodes in both board shapes', () => {
  for (const boardShape of ['triangle', 'hexagon']) {
    const settings = { ...sut.settingsFor(9, 15), boardShape, startingPointMode: 'random',
      initialPositions: sut.randomInitialPositions(9, 15, Math.random, boardShape) };
    const snapshot = sut.restoreGame(settings).getSnapshot(), badges = [], colors = new Set();
    const ctx = new Proxy({}, {
      get: (_, name) => name === 'fillText' ? value => badges.push(String(value)) : () => {},
      set: (_, name, value) => { if (name === 'fillStyle' || name === 'strokeStyle') { assert.equal(typeof value, 'string'); colors.add(value); } return true; },
    });
    const layout = sut.boardLayout(9, { x: 30, y: 200, width: 260, height: 210 }, 15, boardShape);
    sut.drawBoard(ctx, snapshot, layout);
    assert.deepEqual(badges, Array.from({ length: 15 }, (_, i) => String(i + 1)));
    for (const player of snapshot.players) assert.ok(colors.has(sut.PLAYER_COLORS[player]));
  }
});

test('compact native setup supports fifteen seats, disallows default starts and pages all custom roots', async () => {
  for (const language of ['zh', 'en']) for (const top of [64, 104]) {
    const h = uiHarness({ language, width: 320, height: 568, top });
    try {
      await ready(h); const hash = h.app.session.stateHash;
      await h.tap('cabin-board'); await h.slide('player-count', 15, 2, 15);
      assert.equal(sut.readPreferences(h.p.storage).playerCount, 15);
      assert.equal(sut.readPreferences(h.p.storage).startingPointMode, 'random');
      await h.scrollTo('starter-CORAL'); await h.tap('starter-CORAL');
      await h.scrollTo('starts-default');
      assert.equal(h.app.getButtons().find(b => b.id === 'starts-default').disabled, true);
      await h.scrollTo('starts-custom'); await h.tap('starts-custom');
      for (const player of ['BLACK', 'WHITE', 'PURPLE']) assert.ok(h.app.getButtons().some(b => b.id === `start-seat-${player}`));
      while (!h.app.getButtons().find(b => b.id === 'start-seats-next').disabled) await h.tap('start-seats-next');
      await h.tap('start-seat-CORAL');
      assert.equal(h.app.getButtons().find(b => b.id === 'start-seats-next').disabled, true);
      for (const b of h.app.getButtons()) {
        assert.ok(b.y + b.height <= 544, `${b.id} safe-area footer`);
        assert.ok(b.height >= 36, `${b.id} touch height`);
      }
      await h.tap('starts-save');
      assert.equal(sut.readPreferences(h.p.storage).startingPointMode, 'custom');
      assert.equal(Object.keys(sut.readPreferences(h.p.storage).initialPositions).length, 15);
      assert.equal(h.app.session.stateHash, hash, 'editing does not replace the match');
      await h.tap('cabin-close'); await h.tap('new-game'); await until(() => h.app.session.settings.playerCount === 15 && !h.app.session.busy);
      assert.equal(h.app.session.snapshot.currentPlayer, 'CORAL');
      assert.equal(h.app.session.error, null);
      await h.render();
      assert.ok(h.app.getButtons().some(b => b.id === 'score-prev'));
      while (!h.app.getButtons().find(b => b.id === 'score-prev').disabled) await h.tap('score-prev');
      assert.equal(h.app.getButtons().find(b => b.id === 'score-prev').disabled, true);
      assert.equal(h.texts.some(text => text.includes('undefined')), false);
    } finally { h.app.dispose(); }
  }
});

test('7–15-player native Minimax Worker produces legal actions without loading smaller trained models', async () => {
  for (const count of [7, 15]) {
    const settings = { ...sut.settingsFor(7, count), startingPointMode: 'random',
      initialPositions: sut.randomInitialPositions(7, count) };
    const engine = sut.restoreGame(settings), hash = sut.ruleView(engine).stateHash;
    const reply = await sut.handleWorkerMessage({ id: count, kind: 'AI', context: { player: 'BLACK' },
      payload: { settings, actions: [], profile: 'multiplayer-hard-v1' } });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.modelInfo.id, 'multiplayer-hard-v1');
    assert.equal(reply.result.modelInfo.training, null);
    assert.equal(reply.result.stateHash, hash);
    assert.ok(reply.result.moves.length);
    for (const move of reply.result.moves) assert.ok(move.point === null || engine._evaluateMove(move.point, 'BLACK').legal);
  }
});

test('15-player results paginate all scores on compact phones without hiding controls', () => {
  for (const language of ['zh', 'en']) {
    const result = { winner: 'CORAL', reason: 'territory', rows: sut.playerIds(15).map((player, i) => ({ player, area: i + 1, winner: player === 'CORAL', resigned: false })) };
    const seen = new Set();
    for (let page = 0; page < 4; page++) {
      const boxes = [];
      const ui = { language, metrics: { width: 320, height: 568, bottom: 24 }, top: 104,
        label: key => TEXT[language][key], rect: (x, y, width, height) => boxes.push({ x, y, width, height }),
        text: value => { for (const player of sut.playerIds(15)) if (value === TEXT[language][sut.PLAYER_LABEL_KEYS[player]]) seen.add(player); },
        wrap() {}, button: (id, title, x, y, width, action, options = {}) => boxes.push({ x, y, width, height: options.height || 48 }) };
      drawResult(ui, { result, page, playerLabel: player => TEXT[language][sut.PLAYER_LABEL_KEYS[player]] }, { page() {} });
      for (const box of boxes) assert.ok(box.y + box.height <= 544 && box.x + box.width <= 320);
    }
    assert.equal(seen.size, 15);
  }
});
