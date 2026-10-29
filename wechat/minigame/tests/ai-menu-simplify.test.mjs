import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

test('ordinary choices show only supported levels while old model IDs remain valid', () => {
  const two = { playerCount: 2, boardShape: 'triangle', gridSize: 7 };
  const diamond = { playerCount: 2, boardShape: 'diamond', gridSize: 7 };
  const three = { playerCount: 3, boardShape: 'triangle', gridSize: 7 };
  const hex = { playerCount: 4, boardShape: 'hexagon', gridSize: 7 };
  assert.deepEqual(sut.normalControllerChoices(two), ['human', 'minimax-2', 'minimax-3', 'minimax-4']);
  assert.deepEqual(sut.normalControllerChoices({ ...two, boardShape: 'hexagon' }), ['human', 'greedy']);
  assert.deepEqual(sut.controllerChoices(diamond), ['human', 'minimax-2', 'minimax-3', 'minimax-4']);
  assert.deepEqual(sut.normalControllerChoices(diamond), ['human', 'minimax-2', 'minimax-3', 'minimax-4']);
  assert.deepEqual(sut.experimentControllerChoices(diamond), []);
  for (const settings of [three, hex]) {
    assert.deepEqual(sut.normalControllerChoices(settings),
      ['human', 'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1']);
    assert.ok(!sut.normalControllerChoices(settings).includes('multiplayer-ultimate-v1'));
  }
  assert.deepEqual(sut.normalControllerChoices({ ...three, boardShape: 'hexagon' }),
    ['human', 'multiplayer-easy-v1', 'multiplayer-hard-v1']);
  assert.deepEqual(sut.normalControllerChoices({ ...three, boardShape: 'diamond' }),
    ['human', 'greedy', 'multiplayer-hard-v1']);
  assert.ok(!sut.controllerChoices({ ...three, boardShape: 'diamond' }).includes('multiplayer-easy-v1'));
  assert.deepEqual(sut.experimentControllerChoices(three),
    ['three-player-policy-v1', 'three-player-policy-v2', 'three-player-search-v4-round12']);
  assert.deepEqual(sut.experimentControllerChoices(hex), ['hex-player-policy-v1', 'hex-player-search-v5']);
  assert.equal(sut.experimentControllerChoices(two).filter(profile => profile.startsWith('model:')).length, 17);
  assert.deepEqual(sut.validateControllers({ BLACK: 'human', WHITE: 'model:dqn-all-sizes-e2000' }, two),
    { BLACK: 'human', WHITE: 'model:dqn-all-sizes-e2000' });
  assert.deepEqual(sut.validateControllers({ BLACK: 'human', WHITE: 'three-player-policy-v1', PURPLE: 'human' }, three),
    { BLACK: 'human', WHITE: 'three-player-policy-v1', PURPLE: 'human' });
});

test('new search levels preserve legacy saved modes and nonstandard-board fallback', () => {
  for (const [difficulty, profile] of [['simple', 'minimax-2'], ['medium', 'minimax-3'], ['hard', 'minimax-4']]) {
    assert.equal(sut.presetControllers('ai-white', difficulty).WHITE, profile);
    const storage = memoryStorage();
    sut.savePreferences(storage, { size: 7, mode: 'ai-white', difficulty });
    assert.equal(sut.readPreferences(storage).difficulty, difficulty);
  }
  assert.equal(sut.presetControllers('ai-white', 'easy').WHITE, 'greedy');
  assert.equal(sut.presetControllers('ai-white', 'normal').WHITE, 'minimax-2');
  assert.equal(sut.presetControllers('ai-white', 'hard', { playerCount: 2, boardShape: 'hexagon' }).WHITE, 'greedy');
  for (const [difficulty, profile] of [['simple', 'minimax-2'], ['medium', 'minimax-3'], ['hard', 'minimax-4']]) {
    assert.equal(sut.presetControllers('ai-white', difficulty, { playerCount: 2, boardShape: 'diamond' }).WHITE, profile);
  }
  assert.equal(sut.defaultAIProfile({ playerCount: 2, boardShape: 'diamond', gridSize: 7 }), 'minimax-2');
  assert.equal(sut.defaultAIProfile({ playerCount: 3, boardShape: 'diamond', gridSize: 7 }), 'greedy');
  assert.equal(sut.defaultAIProfile({ playerCount: 15, boardShape: 'diamond', gridSize: 7 }), 'multiplayer-hard-v1');
  const old = memoryStorage();
  sut.savePreferences(old, { size: 7, mode: 'ai-white', difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'minimax-4' } });
  assert.equal(sut.readPreferences(old).difficulty, 'hard');
  assert.equal(sut.readPreferences(old).controllers.WHITE, 'minimax-4');
  const legacy = memoryStorage();
  legacy.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 7, mode: 'ai-white', difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'model:dqn-all-sizes-e2000' },
    playerDrafts: { 3: { mode: 'three-human', startPlayer: 'BLACK', boardShape: 'triangle',
      controllers: { BLACK: 'human', WHITE: 'three-player-policy-v1', PURPLE: 'three-player-search-v4-round12' } } } }));
  const migrated = sut.readPreferences(legacy);
  assert.equal(migrated.difficulty, 'medium');
  assert.equal(migrated.controllers.WHITE, 'minimax-3');
  assert.equal(migrated.playerDrafts[3].controllers.WHITE, 'multiplayer-medium-v1');
  assert.equal(migrated.playerDrafts[3].controllers.PURPLE, 'multiplayer-medium-v1');
  const corrected = memoryStorage();
  sut.savePreferences(corrected, { size: 7, mode: 'three-human', difficulty: 'simple', playerCount: 3,
    boardShape: 'diamond', startingPointMode: 'random', initialPositions: {
      BLACK: [0, 0], WHITE: [6, 6], PURPLE: [0, 6],
    }, controllers: { BLACK: 'human', WHITE: 'multiplayer-easy-v1', PURPLE: 'multiplayer-hard-v1' } });
  assert.deepEqual(sut.readPreferences(corrected).controllers,
    { BLACK: 'human', WHITE: 'greedy', PURPLE: 'multiplayer-hard-v1' });
});

test('two-player new-game picker reaches the AI lab without listing model IDs as ordinary choices', async () => {
  const h = uiHarness();
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render();
    await h.tap('cabin-board'); await h.scrollTo('controller-WHITE');
    let offered;
    h.p.choose = async labels => { offered = labels; return labels.indexOf(TEXT.zh.moreModels); };
    await h.tap('controller-WHITE'); await h.render();
    assert.deepEqual(offered, ['human', 'minimax-2', 'minimax-3', 'minimax-4']
      .map(profile => TEXT.zh[`controller-${profile}`]).concat(TEXT.zh.moreModels));
    assert.equal(h.app.getScene(), 'models');
    await h.tap('models-policy'); await h.tap('model-dqn-all-sizes-e2000');
    assert.equal(h.app.getScene(), 'home');
    assert.equal(sut.readPreferences(h.p.storage).controllers.WHITE, 'model:dqn-all-sizes-e2000');
    assert.equal(JSON.parse(h.p.storage.get('lifeline-wx-preferences-v1')).aiMenuVersion, 2);
  } finally { h.app.dispose(); }
});

test('two-player hexagon offers only Easy and restores the three search levels on triangle', async () => {
  const h = uiHarness();
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render();
    await h.tap('cabin-board'); await h.scrollTo('shape-hexagon'); await h.tap('shape-hexagon');
    let offered; h.p.choose = async labels => { offered = labels; return -1; };
    await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
    assert.deepEqual(offered, [TEXT.zh['controller-human'], TEXT.zh['controller-greedy']]);
    assert.equal(sut.readPreferences(h.p.storage).difficulty, 'simple');
    assert.equal(sut.presetControllers('ai-white', 'simple', { playerCount: 2, boardShape: 'hexagon' }).WHITE, 'greedy');
    await h.scrollTo('shape-triangle'); await h.tap('shape-triangle');
    await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
    assert.deepEqual(offered, ['human', 'minimax-2', 'minimax-3', 'minimax-4']
      .map(profile => TEXT.zh[`controller-${profile}`]).concat(TEXT.zh.moreModels));
  } finally { h.app.dispose(); }
});

test('ordinary mini-game seat picker keeps old multiplayer models in its lab and analysis lists it once', async () => {
  const h = uiHarness();
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render();
    await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15);
    let offered;
    h.p.choose = async labels => { offered = labels; return -1; };
    await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
    assert.deepEqual(offered, ['human', 'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1']
      .map(profile => TEXT.zh[`controller-${profile}`]).concat(TEXT.zh.moreModels));
    await h.tap('cabin-close');
    await h.app.session.newGame(5, 'human', 'medium', 3, { boardShape: 'triangle' });
    await h.app.session.act({ type: 'move', point: h.app.session.snapshot.legalMoves[0].point });
    await h.app.session.replay(0); await h.render();
    await h.tap('replay-analyzeReplay'); await until(() => !h.app.session.busy); await h.render();
    h.p.choose = async labels => { offered = labels; return labels.indexOf(TEXT.zh.moreModels); };
    await h.tap('analysis-choose'); await h.render();
    assert.equal(offered.length, sut.replayAnalysisChoices(h.app.session.settings).length);
    assert.equal(new Set(offered).size, offered.length, 'analysis lists each model once');
    assert.equal(h.app.getScene(), 'analysis');
    for (const id of ['three-player-policy-v1', 'three-player-policy-v2', 'three-player-search-v4-round12'])
      assert.equal(offered.filter(label => label === TEXT.zh[`controller-${id}`]).length, 1);
  } finally { h.app.dispose(); }
});
