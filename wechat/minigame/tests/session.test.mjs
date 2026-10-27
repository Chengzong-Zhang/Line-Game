import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, localScheduler, until, plain } from './helpers.mjs';
const savePayload = actions => ({ session: sut.createLocalGameSession(sut.settingsFor(), actions), mode: 'human', difficulty: 'easy' });

test('alternating saves preserve a valid predecessor after torn write and reject version/hash corruption', () => {
  const storage = memoryStorage(), store = new sut.SaveStore(storage);
  store.save(savePayload([])); store.save(savePayload([{ type: 'move', point: [1, 0] }]));
  const latest = store.read().records[0]; storage.map.set(`lifeline-wechat-session-v1-${latest.slot}`, '{truncated');
  assert.equal(store.read().payload.session.actions.length, 0); assert.equal(store.read().damaged.length, 1);
  const next = plain(savePayload([])); next.session.schemaVersion = 9; assert.throws(() => store.save(next), /INVALID_SAVE/);
  storage.set = () => {}; assert.throws(() => store.save(savePayload([])), /SAVE_WRITE_FAILED/);
  assert.equal(store.read().payload.session.actions.length, 0);
});

test('restore retries the previous valid record after a checksummed illegal replay', async () => {
  const storage = memoryStorage(), store = new sut.SaveStore(storage), scheduler = localScheduler();
  try {
    store.save(savePayload([{ type: 'move', point: [1, 0] }]));
    store.save(savePayload([{ type: 'move', point: [99, 99] }]));
    const session = new sut.GameSession(scheduler, store);
    assert.equal(await session.restore(), true); assert.equal(session.actions.length, 1); assert.equal(session.error, 'RECOVERED_BACKUP');
    assert.equal(session.paused, true);
  } finally { scheduler.cancel(); }
});

test('replay, hide/show, bad restore, and every lesson preserve the original game and AI role', async () => {
  const scheduler = localScheduler(), storage = memoryStorage(), session = new sut.GameSession(scheduler, new sut.SaveStore(storage));
  try {
    await session.newGame(7, 'human', 'easy'); assert.equal(await session.act({ type: 'move', point: [1, 0] }), true);
    const hash = session.stateHash, actions = session.capture().session.actions, saved = new Map(storage.map);
    await session.replay(0); assert.equal(session.snapshot.turnCount, 0); assert.equal(session.canPlay(), false);
    assert.equal(await session.act({ type: 'skip' }), false); await session.exitReplay(); assert.equal(session.stateHash, hash);
    for (let index = 0; index < 5; index++) {
      await session.tutorialLevel(index); const lesson = sut.TUTORIAL_LEVELS[index];
      if (lesson.restriction) {
        assert.equal(await session.act({ type: 'move', point: lesson.restriction.point }), false);
        assert.equal(session.tutorial.restrictionObserved, true);
      }
      assert.equal(await session.act(lesson.objective), true); assert.equal(session.tutorial.done, true);
    }
    await session.exitTutorial(); assert.equal(session.stateHash, hash); assert.deepEqual(session.actions, actions);
    assert.deepEqual(storage.map, saved, 'replays and lessons must never overwrite the match save');
    assert.equal(await session.load(sut.settingsFor(), [{ type: 'move', point: [-1, 0] }]), false);
    assert.equal(session.stateHash, hash); assert.deepEqual(session.actions, actions);
    session.hide(); session.show(); assert.equal(session.canPlay(), false); session.resume(); assert.equal(session.canPlay(), true);
  } finally { scheduler.cancel(); }
});

test('AI first/second, canceled turn and per-action restore retain the human side', async () => {
  for (const mode of ['ai-black', 'ai-white']) {
    const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage()), session = new sut.GameSession(scheduler, store);
    try {
      await session.newGame(5, mode, 'easy');
      if (mode === 'ai-white') await session.act({ type: 'move', point: [1, 0] });
      await until(() => !session.busy && !session.isAITurn());
      assert.equal(session.actions.length, mode === 'ai-black' ? 1 : 2);
      const hash = session.stateHash;
      const restored = new sut.GameSession(scheduler, store); assert.equal(await restored.restore(), true);
      assert.equal(restored.mode, mode); assert.equal(restored.stateHash, hash);
      restored.resume(); const move = restored.snapshot.legalMoves[0].point;
      const inFlight = restored.act({ type: 'move', point: move }); restored.hide();
      await inFlight; assert.equal(restored.stateHash, hash); assert.equal(restored.busy, false);
    } finally { scheduler.cancel(); }
  }
});

test('touch transforms are reversible for 5–15 on compact and large displays', () => {
  for (const width of [260, 330, 370]) for (let size = 5; size <= 15; size++) {
    const layout = sut.boardLayout(size, { x: 30, y: 225, width, height: 180 });
    for (let y = 0; y < size; y++) for (let x = 0; x < size - y; x++) {
      const [sx, sy] = sut.toScreen([x, y], layout); assert.deepEqual(sut.hitPoint(sx, sy, layout), [x, y]);
    }
    assert.equal(sut.hitPoint(-10, -10, layout), null);
  }
});

test('navigation and background cancellation cannot expose a historical board as the live match', async () => {
  const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage()), session = new sut.GameSession(scheduler, store);
  try {
    await session.newGame(7, 'human', 'easy'); await session.act({ type: 'move', point: [1, 0] });
    const hash = session.stateHash, board = plain(session.snapshot.boardMatrix);
    await session.replay(0);
    const exiting = session.exitReplay(); session.hide(); await exiting; session.show(); session.resume();
    assert.equal(session.stateHash, hash); assert.deepEqual(session.snapshot.boardMatrix, board);
    const entering = session.tutorialLevel(0); session.hide(); assert.equal(await entering, false);
    assert.equal(session.tutorial, null); assert.equal(session.stateHash, hash);
    session.show(); session.resume(); await session.tutorialLevel(0);
    const leaving = session.exitTutorial(); session.hide(); await leaving; session.show(); session.resume();
    assert.equal(session.stateHash, hash); assert.deepEqual(session.snapshot.boardMatrix, board);
    // A canceled startup restore must not try the second save over a newer game.
    const restore = session.restore(); const newer = session.newGame(9, 'human');
    assert.equal(await restore, false); assert.equal(await newer, true); assert.equal(session.settings.gridSize, 9);
  } finally { scheduler.cancel(); }
});

test('every node on sizes 5–15 is reachable at a usable zoom scale, including board corners', () => {
  const viewport = { x: 30, y: 301, width: 260, height: 98 };
  for (let size = 5; size <= 15; size++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size - y; x++) {
      const layout = sut.focusBoardLayout(size, viewport, [x, y]);
      const [sx, sy] = sut.toScreen([x, y], layout);
      assert.ok(sx >= viewport.x + 22 && sx <= viewport.x + viewport.width - 22);
      assert.ok(sy >= viewport.y + 22 && sy <= viewport.y + viewport.height - 22);
      assert.deepEqual(sut.hitPoint(sx + 12, sy, layout), [x, y]);
      const farPan = sut.panBoardFocus(layout.focus, 10000, -10000, layout);
      assert.ok(farPan[0] >= 0 && farPan[1] >= 0 && farPan[0] + farPan[1] <= size - 1 + 1e-9);
    }
  }
});
