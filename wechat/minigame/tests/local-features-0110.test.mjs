import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, localScheduler, until, plain } from './helpers.mjs';

function harness() {
  const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage());
  const game = new sut.GameSession(scheduler, store);
  return { game, store, stop: () => { game.hide(); scheduler.cancel(); } };
}
async function move(game) { return game.act({ type: 'move', point: game.snapshot.legalMoves[0].point }); }

test('all 2–6 seat and board-shape combinations retain actual random roots across save, replay and tutorial', async () => {
  for (const count of [2, 3, 4, 5, 6]) for (const shape of ['triangle', 'hexagon']) {
    const h = harness(), { game, store } = h;
    try {
      assert.equal(await game.newGame(5, 'human', 'easy', count, { boardShape: shape, startingPointMode: 'random' }), true);
      const roots = plain(game.settings.initialPositions), opening = game.stateHash;
      assert.equal(new Set(Object.values(roots).map(String)).size, count);
      assert.equal(game.snapshot.boardShape, shape);
      if (game.snapshot.legalMoves.length) await move(game);
      const hash = game.stateHash, saved = store.read().payload;
      assert.deepEqual(saved.session.settings.initialPositions, roots);
      assert.equal(await game.load(saved.session.settings, saved.session.actions, { ...saved, autoplay: false }), true);
      assert.equal(game.stateHash, hash);
      await game.replay(0); assert.equal(game.replayStateHash, opening); await game.exitReplay();
      assert.equal(game.stateHash, hash);
      await game.tutorialLevel(0); await game.exitTutorial();
      assert.equal(game.stateHash, hash); assert.deepEqual(game.settings.initialPositions, roots);
    } finally { h.stop(); }
  }
});

test('custom roots validate geometry and duplicates; invalid load leaves original board and history intact', async () => {
  const h = harness(), { game } = h;
  try {
    const roots = { BLACK: [0, 4], WHITE: [8, 4] };
    assert.equal(await game.newGame(5, 'human', 'easy', 2, { boardShape: 'hexagon', startingPointMode: 'custom', initialPositions: roots }), true);
    await move(game); const old = game.stateHash, actions = plain(game.actions);
    for (const bad of [{ BLACK: [0, 0], WHITE: [8, 4] }, { BLACK: [0, 4], WHITE: [0, 4] }]) {
      assert.equal(await game.load({ ...game.settings, initialPositions: bad }, []), false);
      assert.equal(game.stateHash, old); assert.deepEqual(game.actions, actions);
    }
  } finally { h.stop(); }
});

test('undo removes the human move and its AI reply, persists budget, blocks repeat until play, and resets on new game', async () => {
  const h = harness(), { game, store } = h;
  try {
    await game.newGame(5, 'ai-white', 'easy', 2, { playOptions: { undoEnabled: true, undoMaxCount: 2 } });
    const opening = game.stateHash;
    await move(game); await until(() => game.actions.length === 2 && !game.busy);
    assert.equal(game.undoAvailable, true); assert.equal(await game.undo(), true);
    assert.equal(game.stateHash, opening); assert.equal(game.actions.length, 0); assert.equal(game.undoRemaining, 1);
    assert.equal(game.undoAvailable, false);
    const saved = store.read().payload;
    await game.load(saved.session.settings, saved.session.actions, { ...saved, autoplay: false });
    assert.equal(game.undoRemaining, 1); assert.equal(game.undoAvailable, false);
    await game.tutorialLevel(0); assert.equal(game.undoAvailable, false); await game.exitTutorial(); game.resume();
    await move(game); await until(() => game.actions.length === 2 && !game.busy);
    assert.equal(await game.undo(), true); assert.equal(game.undoRemaining, 0);
    await move(game); await until(() => !game.busy); assert.equal(game.undoAvailable, false);
    await game.newGame(5, 'human', 'easy', 2, { playOptions: { undoEnabled: true } });
    assert.equal(game.undoRemaining, 3);
  } finally { h.stop(); }
});

test('undo cancels an in-flight AI reply and rejects late worker output', async () => {
  const h = harness(), { game } = h;
  try {
    await game.newGame(5, 'ai-white', 'easy', 2, { playOptions: { undoEnabled: true } });
    const opening = game.stateHash;
    await move(game); assert.equal(game.busy, true); assert.equal(game.undoAvailable, true);
    assert.equal(await game.undo(), true);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(game.stateHash, opening); assert.equal(game.actions.length, 0); assert.equal(game.busy, false);
  } finally { h.stop(); }
});

test('online mirror forbids local undo even when room settings enable it, without changing settings or hashes', async () => {
  const scheduler = localScheduler();
  const online = new sut.OnlineClient({ storage: memoryStorage() }, {}, scheduler);
  const settings = { ...sut.settingsFor(5), undoEnabled: true, undoMaxCount: 3 };
  const actions = [];
  let expected = sut.executeTask({ kind: 'STATE', payload: { settings, actions } });
  for (let n = 0; n < 2; n++) {
    actions.push({ type: 'move', point: expected.snapshot.legalMoves[0].point });
    expected = sut.executeTask({ kind: 'STATE', payload: { settings, actions } });
  }
  try {
    assert.equal(await online.game.load(settings, actions, { mode: 'human', paused: true, save: false, expectedHash: expected.stateHash }), true);
    assert.equal(online.game.settings.undoEnabled, true);
    assert.equal(online.game.undoRemaining, 0); assert.equal(online.game.undoAvailable, false);
    assert.equal(await online.game.undo(), false);
    assert.equal(online.game.stateHash, expected.stateHash); assert.deepEqual(online.game.actions, actions);
  } finally { online.game.hide(); scheduler.cancel(); }
});

test('multiplayer undo uses actual turn history and stays disabled during replay or after game end', async () => {
  for (const count of [3, 4, 6]) {
    const h = harness(), { game } = h;
    try {
      await game.newGame(5, 'human', 'easy', count, { playOptions: { undoEnabled: true } });
      const opening = game.stateHash;
      for (let n = 0; n < count; n++) await move(game);
      assert.equal(game.undoAvailable, true);
      await game.replay(0); assert.equal(game.undoAvailable, false); await game.exitReplay();
      assert.equal(await game.undo(), true); assert.equal(game.stateHash, opening);
      for (let n = 0; n < count; n++) await game.act({ type: 'skip' });
      assert.equal(game.snapshot.gameOver, true); assert.equal(game.undoAvailable, false);
    } finally { h.stop(); }
  }
});

test('shape-specific touch projection and zoom are reversible for every node, independent of player count', () => {
  const rect = { x: 20, y: 100, width: 280, height: 380 };
  for (const count of [2, 3, 4, 5, 6]) for (const shape of ['triangle', 'hexagon']) for (const size of [5, 15]) {
    const layout = sut.boardLayout(size, rect, count, shape);
    for (const point of sut.getBoardPositions(size, count, shape)) {
      assert.deepEqual(sut.hitPoint(...sut.toScreen(point, layout), layout), point);
      const zoom = sut.focusBoardLayout(size, rect, point, 44, count, shape);
      assert.deepEqual(sut.hitPoint(...sut.toScreen(point, zoom), zoom), point);
      assert.ok(sut.panBoardFocus(point, 2000, -2000, zoom).every(Number.isFinite));
    }
  }
});

test('pending incompatible AI drafts persist while playable saves reject them; corrupt undo data is isolated', () => {
  const storage = memoryStorage(), controllers = { BLACK: 'human', WHITE: 'minimax-2' };
  sut.savePreferences(storage, { size: 5, mode: 'ai-white', difficulty: 'normal', boardShape: 'hexagon',
    startingPointMode: 'random', controllers, playerDrafts: { 4: { mode: 'human', startPlayer: 'BLACK', boardShape: 'broken' } } });
  const draft = sut.readPreferences(storage); assert.deepEqual(draft.controllers, controllers); assert.equal(draft.boardShape, 'hexagon');
  assert.equal(draft.playerDrafts, undefined);
  const settings = { ...sut.settingsFor(5), boardShape: 'hexagon', undoEnabled: true, undoMaxCount: 3 };
  const payload = { session: sut.createLocalGameSession(settings, []), mode: 'human', difficulty: 'easy' };
  assert.throws(() => sut.validateSave({ ...payload, controllers }), /INVALID_CONTROLLERS/);
  for (const undoUsage of [{ usedCount: 4, blockedPlayers: [] }, { usedCount: -1, blockedPlayers: [] }, { usedCount: 1, blockedPlayers: ['PURPLE'] }]) {
    assert.throws(() => sut.validateSave({ ...payload, undoUsage }), /INVALID_UNDO_USAGE/);
  }
});
