import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, plain, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

test('diamond geometry projects and hits every node while zoom focus stays inside the rhombus', () => {
  for (const size of [5, 15]) for (const count of [2, 3, 6, 15]) {
    const radius = size - 1, rect = { x: 30, y: 180, width: 260, height: 210 };
    const positions = sut.getBoardPositions(size, count, 'diamond');
    assert.equal(positions.length, size * size);
    assert.deepEqual(sut.getBoardVertices(size, count, 'diamond'),
      [[0, 0], [radius, 0], [radius, radius], [0, radius]]);
    const layout = sut.boardLayout(size, rect, count, 'diamond');
    assert.equal(layout.boardShape, 'diamond');
    assert.equal(layout.verticalSign, -1);
    for (const point of positions) {
      const pixel = sut.toScreen(point, layout);
      assert.deepEqual(sut.hitPoint(...pixel, layout), point);
      assert.ok(pixel[0] >= rect.x - 1e-8 && pixel[0] <= rect.x + rect.width + 1e-8);
      assert.ok(pixel[1] >= rect.y - 1e-8 && pixel[1] <= rect.y + rect.height + 1e-8);
    }
    const corners = sut.getBoardVertices(size, count, 'diamond').map(point => sut.toScreen(point, layout));
    for (const [index, corner] of corners.entries()) assert.deepEqual(sut.hitPoint(...corner, layout),
      sut.getBoardVertices(size, count, 'diamond')[index]);
    const ys = corners.map(point => point[1]);
    assert.ok(Math.abs(Math.min(...ys) - rect.y - (rect.y + rect.height - Math.max(...ys))) < 1e-8,
      'diamond is vertically centered without changing triangle layout');
    assert.deepEqual(sut.focusBoardLayout(size, rect, [-100, 1000], 44, count, 'diamond').focus, [0, radius]);
    for (const [dx, dy] of [[10000, 0], [-10000, 0], [0, 10000], [0, -10000]]) {
      const zoom = sut.focusBoardLayout(size, rect, [radius / 2, radius / 2], 44, count, 'diamond');
      const focus = sut.panBoardFocus(zoom.focus, dx, dy, zoom);
      assert.ok(focus.every(value => value >= 0 && value <= radius));
    }
  }
});

test('diamond defaults use the two acute vertices and 3+ players require persisted random or custom roots', () => {
  for (const size of [5, 15]) {
    const radius = size - 1;
    const duel = new sut.GameEngine({ ...sut.settingsFor(size, 2), boardShape: 'diamond' });
    assert.deepEqual(plain(duel.initialPositions), { BLACK: [0, 0], WHITE: [radius, radius] });
    assert.deepEqual(plain(duel.getSnapshot().initialPositions), { BLACK: [0, 0], WHITE: [radius, radius] });
  }
  const missing = { ...sut.settingsFor(5, 3, 'BLACK', 'diamond'), boardShape: 'diamond' };
  assert.throws(() => sut.validateSettings(missing), /random or custom/i);
  assert.throws(() => sut.validateSettings({ ...missing, startingPointMode: 'default' }), /random or custom/i);
  const roots = sut.randomInitialPositions(5, 3, () => 0.25, 'diamond');
  const valid = { ...missing, startingPointMode: 'random', initialPositions: roots };
  assert.equal(sut.validateSettings(valid), valid);
  const storage = memoryStorage();
  sut.savePreferences(storage, { size: 5, mode: 'three-human', difficulty: 'simple', playerCount: 3,
    boardShape: 'diamond', startingPointMode: 'default' });
  assert.equal(sut.readPreferences(storage).startingPointMode, 'random');
  sut.savePreferences(storage, { size: 5, mode: 'three-human', difficulty: 'simple', playerCount: 3,
    boardShape: 'diamond', startingPointMode: 'custom', initialPositions: roots });
  assert.deepEqual(sut.readPreferences(storage).initialPositions, roots);
});

test('diamond AI menus expose only safe generic profiles for each player-count range', () => {
  const duel = { playerCount: 2, gridSize: 7, boardShape: 'diamond' };
  assert.deepEqual(sut.normalControllerChoices(duel), ['human', 'minimax-2', 'minimax-3', 'minimax-4']);
  assert.deepEqual(sut.experimentControllerChoices(duel), []);
  assert.equal(sut.defaultAIProfile(duel), 'minimax-2');
  for (const count of [3, 4, 5, 6]) {
    const settings = { playerCount: count, gridSize: 7, boardShape: 'diamond' };
    assert.deepEqual(sut.normalControllerChoices(settings),
      ['human', 'greedy', 'multiplayer-hard-v1']);
    assert.ok(!sut.controllerChoices(settings).includes('multiplayer-easy-v1'));
    assert.ok(!sut.controllerChoices(settings).includes('multiplayer-medium-v1'));
  }
  const large = { playerCount: 15, gridSize: 7, boardShape: 'diamond' };
  assert.equal(sut.defaultAIProfile(large), 'multiplayer-hard-v1');
  assert.deepEqual(sut.normalControllerChoices(large), ['human', 'greedy', 'multiplayer-hard-v1']);
});

test('diamond Worker executes every exposed generic AI family without changing the position', async () => {
  const duelSettings = { ...sut.settingsFor(5, 2, 'BLACK', 'diamond'), boardShape: 'diamond' };
  const duel = sut.restoreGame(duelSettings), duelHash = sut.ruleView(duel).stateHash;
  for (const profile of ['minimax-2', 'minimax-3', 'minimax-4']) {
    const reply = await sut.handleWorkerMessage({ id: profile, kind: 'AI', context: { player: 'BLACK' },
      payload: { settings: duelSettings, actions: [], profile } });
    assert.equal(reply.ok, true, `${profile}: ${reply.error}`);
    assert.equal(reply.result.stateHash, duelHash);
    assert.ok(reply.result.moves.length, profile);
    for (const move of reply.result.moves)
      assert.ok(move.point === null || duel._evaluateMove(move.point, 'BLACK').legal, profile);
  }

  const multiplayerRoots = sut.randomInitialPositions(5, 3, () => 0.25, 'diamond');
  const multiplayerSettings = { ...sut.settingsFor(5, 3, 'BLACK', 'diamond'), boardShape: 'diamond',
    startingPointMode: 'random', initialPositions: multiplayerRoots };
  const multiplayer = sut.restoreGame(multiplayerSettings), multiplayerHash = sut.ruleView(multiplayer).stateHash;
  const easy = await sut.handleWorkerMessage({ id: 'diamond-easy', kind: 'AI', context: { player: 'BLACK' },
    payload: { settings: multiplayerSettings, actions: [], profile: 'greedy' } });
  assert.equal(easy.ok, true, easy.error); assert.equal(easy.result.stateHash, multiplayerHash);
  assert.deepEqual(easy.result.modelInfo,
    { strategy: 'greedy', runtime_policy: 'generic-rule-greedy', trained_model: false });
  for (const move of easy.result.moves)
    assert.ok(move.point === null || multiplayer._evaluateMove(move.point, 'BLACK').legal);
  assert.equal((await sut.handleWorkerMessage({ id: 'trained-easy', kind: 'AI', context: { player: 'BLACK' },
    payload: { settings: multiplayerSettings, actions: [], profile: 'multiplayer-easy-v1' } })).error,
  'INVALID_CONTROLLERS');
  const hard = await sut.handleWorkerMessage({ id: 'diamond-hard', kind: 'AI', context: { player: 'BLACK' },
    payload: { settings: multiplayerSettings, actions: [], profile: 'multiplayer-hard-v1' } });
  assert.equal(hard.ok, true, hard.error); assert.equal(hard.result.stateHash, multiplayerHash);
  assert.equal(hard.result.modelInfo.runtime_policy, 'generic-multiplayer-minimax');
  assert.equal(hard.result.modelInfo.trained_model, false);
  assert.equal(hard.result.modelInfo.evidenceTier, 'rule-search');
  for (const move of hard.result.moves)
    assert.ok(move.point === null || multiplayer._evaluateMove(move.point, 'BLACK').legal);

  const roots = sut.randomInitialPositions(5, 7, () => 0.25, 'diamond');
  const largeSettings = { ...sut.settingsFor(5, 7, 'BLACK', 'diamond'), boardShape: 'diamond',
    startingPointMode: 'random', initialPositions: roots };
  const large = sut.restoreGame(largeSettings), largeHash = sut.ruleView(large).stateHash;
  const reply = await sut.handleWorkerMessage({ id: 'large-hard', kind: 'AI', context: { player: 'BLACK' },
    payload: { settings: largeSettings, actions: [], profile: 'multiplayer-hard-v1' } });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.result.stateHash, largeHash);
  assert.equal(reply.result.modelInfo.runtime_policy, 'generic-multiplayer-minimax');
  assert.equal(reply.result.modelInfo.trained_model, false);
  assert.equal(reply.result.modelInfo.evidenceTier, 'rule-search');
  assert.ok(reply.result.moves.length);
  for (const move of reply.result.moves)
    assert.ok(move.point === null || large._evaluateMove(move.point, 'BLACK').legal);
});

test('diamond custom roots survive moves, undo, save, restore and replay', async () => {
  const scheduler = localScheduler(), store = new sut.SaveStore(memoryStorage());
  const game = new sut.GameSession(scheduler, store);
  const roots = { BLACK: [0, 0], WHITE: [4, 4], PURPLE: [0, 4] };
  try {
    assert.equal(await game.newGame(5, 'human', 'simple', 3, { boardShape: 'diamond',
      startingPointMode: 'custom', initialPositions: roots, playOptions: { undoEnabled: true, undoMaxCount: 3 } }), true);
    const opening = game.stateHash;
    assert.equal(game.settings.boardShape, 'diamond');
    assert.deepEqual(game.settings.initialPositions, roots);
    for (let index = 0; index < 3; index++) {
      assert.equal(await game.act({ type: 'move', point: game.snapshot.legalMoves[0].point }), true);
    }
    assert.equal(await game.undo(), true);
    assert.equal(game.stateHash, opening);
    assert.deepEqual(game.settings.initialPositions, roots);
    assert.equal(await game.act({ type: 'move', point: game.snapshot.legalMoves[0].point }), true);
    const liveHash = game.stateHash, saved = store.read().payload;
    assert.equal(saved.session.settings.boardShape, 'diamond');
    assert.deepEqual(saved.session.settings.initialPositions, roots);
    const restored = new sut.GameSession(scheduler, store);
    assert.equal(await restored.restore(), true);
    assert.equal(restored.stateHash, liveHash);
    assert.deepEqual(restored.settings.initialPositions, roots);
    assert.equal(await restored.replay(0), true);
    assert.equal(restored.replayStateHash, opening);
    assert.equal(await restored.exitReplay(), true);
    assert.equal(restored.stateHash, liveHash);
    restored.hide();
  } finally { game.hide(); scheduler.cancel(); }
});

test('board cabin selects diamond, normalizes 3-player roots once, and allows v4 contribution', async () => {
  const h = uiHarness({ config: { apiBase: 'https://example.invalid', onlineEnabled: false },
    platformOverrides: { contributionRequest: async () => ({}) } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render();
    await h.tap('cabin-board');
    for (const id of ['shape-triangle', 'shape-diamond', 'shape-hexagon'])
      assert.ok(h.app.getButtons().some(button => button.id === id));
    await h.scrollTo('shape-diamond'); await h.tap('shape-diamond');
    assert.equal(sut.readPreferences(h.p.storage).boardShape, 'diamond');
    await h.slide('player-count', 3, 2, 15);
    await h.scrollTo('shape-diamond'); await h.tap('shape-diamond');
    const draft = sut.readPreferences(h.p.storage);
    assert.equal(draft.playerCount, 3); assert.equal(draft.boardShape, 'diamond');
    assert.equal(draft.startingPointMode, 'random');
    await h.scrollTo('starts-default'); await h.render();
    assert.equal(h.app.getButtons().find(button => button.id === 'starts-default').disabled, true);
    await h.scrollTo('training-contribution'); await h.render();
    assert.equal(h.app.getButtons().find(button => button.id === 'training-contribution').disabled, false);
    assert.ok(h.texts.some(value => /菱形棋盘 3–15 人仅支持随机或自定义起点/.test(value)));
    await h.tap('cabin-close'); await h.tap('new-game');
    await until(() => h.app.session.settings.boardShape === 'diamond' && h.app.session.settings.playerCount === 3
      && h.app.session.snapshot && !h.app.session.busy);
    assert.equal(h.app.session.settings.startingPointMode, 'random');
    assert.equal(Object.keys(h.app.session.settings.initialPositions).length, 3);
    assert.deepEqual(h.app.session.snapshot.initialPositions, h.app.session.settings.initialPositions);
  } finally { h.app.dispose(); }
});

test('diamond custom-root drafts are cleared when side length changes or an old player draft no longer fits', async () => {
  const roots = { BLACK: [0, 0], WHITE: [14, 14], PURPLE: [0, 14] };
  const activeStorage = memoryStorage();
  sut.savePreferences(activeStorage, { size: 15, mode: 'three-human', difficulty: 'simple', playerCount: 3,
    boardShape: 'diamond', startingPointMode: 'custom', initialPositions: roots });
  const active = uiHarness({ storage: activeStorage });
  try {
    await until(() => active.app.session.snapshot && !active.app.session.busy); await active.render();
    await active.tap('cabin-board'); await active.scrollTo('board-size'); await active.slide('board-size', 5, 5, 15);
    const draft = sut.readPreferences(activeStorage);
    assert.equal(draft.boardShape, 'diamond'); assert.equal(draft.startingPointMode, 'random');
    assert.equal(draft.initialPositions, undefined);
  } finally { active.app.dispose(); }

  const inactiveStorage = memoryStorage();
  sut.savePreferences(inactiveStorage, { size: 15, mode: 'ai-white', difficulty: 'simple', playerCount: 2,
    boardShape: 'triangle', startingPointMode: 'default', playerDrafts: { 3: { mode: 'three-human',
      startPlayer: 'BLACK', controllers: null, boardShape: 'diamond', startingPointMode: 'custom', initialPositions: roots } } });
  const inactive = uiHarness({ storage: inactiveStorage });
  try {
    await until(() => inactive.app.session.snapshot && !inactive.app.session.busy); await inactive.render();
    await inactive.tap('cabin-board'); await inactive.scrollTo('board-size'); await inactive.slide('board-size', 5, 5, 15);
    await inactive.slide('player-count', 3, 2, 15);
    let draft = sut.readPreferences(inactiveStorage);
    assert.equal(draft.boardShape, 'diamond'); assert.equal(draft.startingPointMode, 'random');
    assert.equal(draft.initialPositions, undefined);
    await inactive.slide('player-count', 2, 2, 15); await inactive.slide('player-count', 3, 2, 15);
    draft = sut.readPreferences(inactiveStorage);
    assert.equal(draft.boardShape, 'diamond'); assert.equal(draft.startingPointMode, 'random');
    assert.equal(draft.initialPositions, undefined);
  } finally { inactive.app.dispose(); }
});

test('diamond room creation synchronizes one random opening and preserves two-player Minimax identity', async () => {
  const config = { onlineEnabled: true, apiBase: 'https://rooms.invalid' };
  for (const scenario of [
    { playerCount: 3, mode: 'three-human', startingPointMode: 'random',
      controllers: { BLACK: 'human', WHITE: 'greedy', PURPLE: 'multiplayer-hard-v1' } },
    { playerCount: 2, mode: 'ai-white', startingPointMode: 'default',
      controllers: { BLACK: 'human', WHITE: 'minimax-4' } },
  ]) {
    const storage = memoryStorage();
    sut.savePreferences(storage, { size: 5, difficulty: 'hard', boardShape: 'diamond', ...scenario });
    const h = uiHarness({ config, storage }); let created;
    h.app.online.enter = async (kind, settings) => { created = { kind, settings }; return true; };
    try {
      await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render();
      await h.tap('friends');
      await h.scrollTo('room-submit'); await h.tap('room-submit'); await until(() => created);
      assert.equal(created.kind, 'create');
      assert.equal(created.settings.boardShape, 'diamond');
      assert.equal(created.settings.playerCount, scenario.playerCount);
      if (scenario.playerCount === 3) {
        assert.equal(created.settings.startingPointMode, 'random');
        assert.equal(Object.keys(created.settings.initialPositions).length, 3);
        assert.equal(new Set(Object.values(created.settings.initialPositions).map(String)).size, 3);
        assert.deepEqual(Object.values(created.settings.playerSetup).map(player => player.choice),
          ['human', 'greedy', 'ai-hard']);
      } else {
        assert.equal(created.settings.startingPointMode, 'default');
        assert.equal(created.settings.initialPositions, undefined);
        assert.equal(created.settings.playerSetup.WHITE.choice, 'minimax');
        assert.equal(created.settings.playerSetup.WHITE.depth, 4);
      }
      assert.equal(sut.validateSettings(created.settings), created.settings);
    } finally { h.app.dispose(); }
  }
});
