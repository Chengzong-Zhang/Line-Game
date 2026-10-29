import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestMoveTracker } from '../src/latest-moves.js';
import { sut, localScheduler, memoryStorage, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const options = { display: { ...sut.DEFAULT_DISPLAY, territories: false, legalMoves: false, coordinates: false } };
function drawing(snapshot, lastMoves, display = options.display) {
  const calls = [], styles = {};
  const ctx = new Proxy({}, {
    get: (_, name) => (...args) => calls.push({ name, args, styles: { ...styles } }),
    set: (_, name, value) => { styles[name] = value; return true; },
  });
  const layout = sut.boardLayout(snapshot.gridSize, { x: 20, y: 100, width: 320, height: 280 }, snapshot.players.length, snapshot.boardShape);
  sut.drawBoard(ctx, snapshot, layout, { lastMoves, display });
  return calls.filter(call => call.name === 'fillRect' && call.styles.fillStyle === '#fffef9');
}

test('all seats retain their own latest move; initial roots, replaced moves and display-off stay unmarked', () => {
  for (const playerCount of [2, 3, 6, 15]) {
    const gridSize = 15, boardShape = playerCount >= 4 ? 'hexagon' : 'triangle';
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const settings = { ...sut.settingsFor(gridSize, playerCount), boardShape,
      ...(playerCount > 6 ? { startingPointMode: 'random', initialPositions: sut.randomInitialPositions(gridSize, playerCount, random, boardShape) } : {}) };
    const engine = new sut.GameEngine(settings), tracker = createLatestMoveTracker(), actions = [], expected = {};
    assert.deepEqual(tracker(settings, actions, engine.getSnapshot()), {});
    for (let index = 0; index < playerCount; index++) {
      const player = engine.currentPlayer, root = engine.initialPositions[player];
      const distance = point => (point[0] - root[0]) ** 2 + (point[1] - root[1]) ** 2;
      const point = engine.getLegalMoves().filter(move => !move.isAttack).sort((a, b) => distance(a.point) - distance(b.point))[0].point;
      assert.equal(engine.playMove(point).success, true);
      actions.push({ type: 'player_move', point }); expected[player] = point;
    }
    const snapshot = engine.getSnapshot(), before = JSON.stringify({ snapshot, actions, settings });
    const marks = tracker(settings, actions, snapshot);
    assert.deepEqual(marks, expected);
    assert.equal(drawing(snapshot, marks).length, playerCount);
    assert.equal(drawing(snapshot, marks, { ...options.display, lastMove: false }).length, 0);
    marks.BLACK[0] += 100;
    assert.deepEqual(tracker(settings, actions, snapshot), expected, 'returned points cannot mutate the cache');
    assert.equal(JSON.stringify({ snapshot, actions, settings }), before);
  }
});

test('PASS and resignation clear only that seat, including actorless saves and non-default starters', () => {
  const settings = { ...sut.settingsFor(7, 3), startPlayer: 'PURPLE' };
  const engine = new sut.GameEngine(settings), tracker = createLatestMoveTracker(), actions = [];
  for (let index = 0; index < 3; index++) {
    const point = engine.getLegalMoves()[0].point;
    actions.push({ type: 'move', point }); assert.equal(engine.playMove(point).success, true);
  }
  const all = tracker(settings, actions, engine.getSnapshot());
  assert.equal(Object.keys(all).length, 3);
  actions.push({ type: 'player_skip' }); assert.equal(engine.skipTurn().success, true);
  assert.deepEqual(tracker(settings, actions, engine.getSnapshot()), { BLACK: all.BLACK, WHITE: all.WHITE });
  actions.push({ type: 'player_resign', color: 'WHITE' }); assert.equal(engine.resignPlayer('WHITE').success, true);
  assert.deepEqual(tracker(settings, actions, engine.getSnapshot()), { BLACK: all.BLACK });
  const newPoint = engine.getLegalMoves()[0].point;
  actions.push({ type: 'move', point: newPoint }); assert.equal(engine.playMove(newPoint).success, true);
  assert.deepEqual(tracker(settings, actions, engine.getSnapshot()), { BLACK: newPoint });
});

test('captured latest nodes disappear without falling back to older nodes; automatic PASS also clears a surviving latest node', () => {
  const cut = sut.TUTORIAL_LEVELS.find(level => level.id === 'L3-cut-and-clear');
  const settings = { ...sut.settingsFor(cut.gridSize), startPlayer: cut.startPlayer }, actions = [...cut.prefix];
  const tracker = createLatestMoveTracker();
  const before = sut.restoreGame(settings, actions).getSnapshot();
  assert.deepEqual(tracker(settings, actions, before), { WHITE: [1, 4] });
  const after = sut.restoreGame(settings, [...actions, cut.objective]).getSnapshot();
  assert.deepEqual(tracker(settings, [...actions, cut.objective], after), { BLACK: [3, 2] });
  const restoredCoordinate = JSON.parse(JSON.stringify(after));
  restoredCoordinate.boardMatrix[4][1] = 3;
  assert.deepEqual(tracker(settings, [...actions, cut.objective], restoredCoordinate), { BLACK: [3, 2] },
    'later occupancy of the removed latest coordinate cannot revive its old marker');
  const settleSettings = sut.settingsFor(5);
  const settleActions = [[1, 0], [2, 0], [0, 3], [2, 2], [0, 4], [1, 1], [2, 1], [1, 2], [0, 2], [0, 4]]
    .map(point => ({ type: 'move', point }));
  const engine = sut.restoreGame(settleSettings, settleActions), snapshot = engine.getSnapshot();
  assert.equal(snapshot.gameOver, true); assert.equal(snapshot.consecutiveSkips, 2);
  assert.deepEqual(tracker(settleSettings, settleActions, snapshot), {});
  assert.equal(snapshot.boardMatrix[4][0], 3, 'White latest node survives; its automatic PASS is what clears it');
});

test('rewinds, branches and same-length replacement rebuild the exact shown prefix', () => {
  const settings = sut.settingsFor(5), actions = [
    { type: 'player_move', point: [1, 0] }, { type: 'player_move', point: [3, 0] },
    { type: 'player_move', point: [0, 2] }, { type: 'player_skip' },
  ];
  const tracker = createLatestMoveTracker();
  const check = (cursor, expected, log = actions) => {
    const snapshot = sut.restoreGame(settings, log.slice(0, cursor)).getSnapshot();
    assert.deepEqual(tracker(settings, log, snapshot, cursor), expected);
  };
  check(4, { BLACK: [0, 2] }); check(2, { BLACK: [1, 0], WHITE: [3, 0] }); check(0, {});
  check(3, { BLACK: [0, 2], WHITE: [3, 0] });
  check(2, { WHITE: [3, 0] }, [{ type: 'skip' }, actions[1]]);
  check(2, { BLACK: [1, 0] }, [actions[0], { type: 'skip' }]);
});

test('native app renders every side through AI waiting, save restore, replay seeking and undo', async () => {
  const storage = memoryStorage(), drawn = [], styles = {};
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal', controllers: { BLACK: 'human', WHITE: 'human' },
    playOptions: { undoEnabled: true, undoMaxCount: 3 } }));
  const ctx = new Proxy({ measureText: text => ({ width: String(text).length * 8 }) }, {
    get: (target, name) => name in target ? target[name] : (...args) => {
      if (name === 'fillRect' && styles.fillStyle === '#fffef9') drawn.push(args);
    }, set: (_, name, value) => { styles[name] = value; return true; },
  });
  const h = uiHarness({ storage, canvas: { getContext: () => ctx } });
  const count = async expected => { drawn.length = 0; await h.render(); assert.equal(drawn.length, expected); };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    const session = h.app.session;
    await count(0);
    assert.equal(await session.act({ type: 'move', point: [1, 0] }), true);
    assert.equal(await session.act({ type: 'move', point: [3, 0] }), true);
    await count(2);
    session.busy = true; await count(2); session.busy = false;
    assert.equal(await session.restore(), true); await count(2);
    assert.equal(await session.replay(1), true); await count(1);
    assert.equal(await session.replay(0), true); await count(0);
    assert.equal(await session.exitReplay(), true); await count(2);
    session.resume(); assert.equal(await session.undo(), true); await count(0);
    assert.equal(await session.load(sut.settingsFor(5), [{ type: 'player_move', point: [1, 0] }, { type: 'player_skip' }], { mode: 'human', paused: true }), true);
    await count(1);
  } finally { h.app.dispose(); }
});

test('authoritative room reconnect and online undo recover marks from the complete actorless log', async () => {
  const scheduler = localScheduler(), tracker = createLatestMoveTracker();
  const client = new sut.OnlineClient({ storage: memoryStorage() }, {}, scheduler);
  const settings = sut.settingsFor(5), actions = [{ type: 'move', point: [1, 0] }, { type: 'move', point: [3, 0] }, { type: 'skip' }];
  const room = (log, revision) => {
    const result = sut.executeTask({ kind: 'STATE', payload: { settings, actions: log } });
    return { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision, seq: log.length, settings, actions: log,
      actionIds: log.map((_, index) => `fixture-${index}`), stateHash: result.stateHash, status: 'playing',
      currentPlayer: result.snapshot.currentPlayer, player: 'BLACK', ready: {}, members: {}, rematchVotes: {} };
  };
  try {
    client.active = true;
    assert.equal(await client.receive(room(actions, 4)), true);
    assert.deepEqual(tracker(client.game.settings, client.game.actions, client.game.snapshot), { WHITE: [3, 0] });
    client.game.actions = []; client.game.snapshot = null; client.room = null;
    assert.equal(await client.receive(room(actions, 4)), true);
    assert.deepEqual(tracker(client.game.settings, client.game.actions, client.game.snapshot), { WHITE: [3, 0] });
    assert.equal(await client.receive(room(actions.slice(0, 2), 5)), true);
    assert.deepEqual(tracker(client.game.settings, client.game.actions, client.game.snapshot), { BLACK: [1, 0], WHITE: [3, 0] });
  } finally { client.detach(); scheduler.cancel(); }
});
