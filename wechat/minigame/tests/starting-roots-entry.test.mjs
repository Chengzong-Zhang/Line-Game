import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, localScheduler, plain, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };

test('board cabin starts fixed double with Web roots and restores the exact random opening', async () => {
  const storage = memoryStorage();
  let h = uiHarness({ storage });
  try {
    await ready(h);
    await h.tap('cabin-board');
    await h.scrollTo('root-fixed-double'); await h.tap('root-fixed-double');
    await h.scrollTo('starts-random'); await h.tap('starts-random'); await h.tap('starts-save');
    assert.equal(sut.readPreferences(storage).rootMode, 'fixed-double');
    await h.tap('cabin-close'); await h.tap('new-game');
    await until(() => !h.app.session.busy && h.app.session.settings.rootMode === 'fixed-double');
    const settings = plain(h.app.session.settings), snapshot = plain(h.app.session.snapshot);
    assert.deepEqual(plain(sut.resolveInitialRoots(settings.gridSize, 2, settings.initialRoots, settings.boardShape, 'fixed-double')), settings.initialRoots);
    assert.equal(snapshot.roots.BLACK.length, 2); assert.equal(snapshot.roots.WHITE.length, 2);
    h.app.session.pause(); h.app.session.save(); h.app.dispose();
    h = uiHarness({ storage }); await ready(h);
    assert.deepEqual(plain(h.app.session.settings.initialRoots), settings.initialRoots);
    assert.deepEqual(plain(h.app.session.snapshot.roots), snapshot.roots);
  } finally { h.app.dispose(); }
});

test('add root action is reachable from the board controls and survives restoration', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage });
  try {
    await ready(h);
    await h.app.session.newGame(5, 'human', 'simple', 2, { rootMode: 'add' });
    for (let turn = 0; turn < 80 && !h.app.session.snapshot.legalRootActions?.length; turn++) {
      const move = h.app.session.snapshot.legalMoves[0];
      assert.ok(move, 'a legal move is available before the root action');
      assert.equal(await h.app.session.act({ type: 'move', point: move.point ?? move }), true);
    }
    const action = h.app.session.snapshot.legalRootActions[0];
    assert.ok(action, 'root action becomes available');
    const actor = h.app.session.snapshot.currentPlayer;
    await h.render(); await h.tap('root-action');
    h.app.tap(...sut.toScreen(action.point, h.app.getLayout())); await h.render();
    await h.tap('confirm'); await until(() => !h.app.session.busy && h.app.session.actions.at(-1)?.type === 'root_add');
    assert.equal(h.app.session.snapshot.roots[actor].length, 2);
    assert.equal(h.app.session.snapshot.rootActionsRemaining[actor].add, 0);
    h.app.session.pause(); h.app.session.save();
    assert.doesNotThrow(() => sut.validateSave(h.app.session.capture()));
    const restored = new sut.GameSession(localScheduler(), new sut.SaveStore(storage));
    const saved = new sut.SaveStore(storage).read().records[0].payload;
    assert.equal(await restored.load(saved.session.settings, saved.session.actions, { ...saved, save: false, autoplay: false, paused: true }), true, restored.error);
    assert.equal(await restored.restore(), true, restored.error);
    assert.deepEqual(plain(restored.snapshot.roots), plain(h.app.session.snapshot.roots));
    assert.equal(restored.snapshot.rootActionsRemaining[actor].add, 0);
    restored.resume();
    const next = restored.snapshot.legalMoves[0];
    assert.ok(next);
    assert.equal(await restored.act({ type: 'move', point: next.point ?? next }), true);
  } finally { h.app.dispose(); }
});
