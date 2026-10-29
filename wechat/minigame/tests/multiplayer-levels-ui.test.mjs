import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const levels = ['multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'];
const legacy = ['three-player-policy-v1', 'three-player-policy-v2', 'three-player-search-v4-round12',
  'hex-player-policy-v1', 'hex-player-search-v5'];
const nativeShape = count => count === 3 ? 'triangle' : 'hexagon';
const roles = (count, profile) => Object.fromEntries(sut.playerIds(count).map((player, i) => [player, i ? profile : 'human']));
const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };

test('three Web difficulty profiles cover 3–6 players, 5–15, and only supported shapes without exposing ultimate', () => {
  const allProfiles = new Set([...sut.CONTROLLER_CHOICES, ...sut.MULTIPLAYER_AI_CATALOG.map(item => item.profile)]);
  assert.equal(allProfiles.size - 1, 29, '26 existing AI plus exactly 3 additions; human is excluded');
  for (const profile of legacy) assert.ok(allProfiles.has(profile));
  assert.equal(sut.MODEL_CATALOG.length, 17);
  assert.equal(sut.MULTIPLAYER_LEVEL_CATALOG[0].metric, 'policy-score');
  for (const item of sut.MULTIPLAYER_LEVEL_CATALOG.slice(1)) assert.equal(item.metric, 'search-score');
  for (const count of [3, 4, 5, 6]) for (const shape of ['triangle', 'hexagon']) for (let size = 5; size <= 15; size++) {
    const settings = { playerCount: count, boardShape: shape, gridSize: size, rulesVersion: 'territory-v2' };
    const choices = sut.controllerChoices(settings), native = shape === nativeShape(count);
    assert.deepEqual(choices.filter(profile => profile.startsWith('multiplayer-')),
      native ? levels : [levels[0], levels[2]]);
    for (const profile of [levels[0], levels[2], ...(native ? [levels[1]] : [])])
      assert.deepEqual(sut.validateControllers(roles(count, profile), settings), roles(count, profile));
    if (!native) assert.throws(() => sut.validateControllers(roles(count, levels[1]), settings), /INVALID_CONTROLLERS/);
    assert.equal(choices.includes('multiplayer-ultimate-v1'), false);
    assert.throws(() => sut.validateControllers(roles(count, 'multiplayer-ultimate-v1'), settings), /INVALID_CONTROLLERS/);
    assert.equal(sut.defaultAIProfile(settings), !native ? 'greedy' : count >= 4 ? 'hex-player-policy-v1'
      : [5, 7, 9].includes(size) ? 'three-player-search-v4-round12' : 'three-player-policy-v1');
  }
  for (const shape of ['triangle', 'hexagon']) {
    const settings = { playerCount: 2, boardShape: shape, gridSize: 7 };
    assert.deepEqual(sut.controllerChoices(settings), shape === 'triangle' ? sut.CONTROLLER_CHOICES : ['human', 'greedy']);
    for (const profile of levels) assert.throws(() => sut.validateControllers(roles(2, profile), settings), /INVALID_CONTROLLERS/);
  }
});

test('active and per-count preferences preserve new and legacy seats, including an incompatible Medium draft', () => {
  const storage = memoryStorage(), drafts = {};
  for (const count of [3, 4, 5, 6]) {
    drafts[count] = { mode: count === 3 ? 'three-human' : 'human', startPlayer: sut.playerIds(count).at(-1),
      boardShape: nativeShape(count), controllers: roles(count, levels[(count - 3) % 3]) };
  }
  drafts[3].controllers.BLACK = 'three-player-policy-v2';
  drafts[4].controllers.BLACK = 'hex-player-policy-v1';
  drafts[5].controllers.BLACK = 'hex-player-search-v5';
  // Incompatible size/shape drafts are saved for explicit correction, never
  // changed into a different AI just because the game has been restarted.
  drafts[4].boardShape = 'triangle';
  const value = { size: 15, difficulty: 'normal', playerCount: 4, ...drafts[4], playerDrafts: drafts };
  sut.savePreferences(storage, value);
  const restored = sut.readPreferences(storage);
  assert.deepEqual(restored.controllers, value.controllers);
  assert.deepEqual(restored.playerDrafts, drafts);
  assert.throws(() => sut.validateControllers(restored.controllers, { playerCount: 4, boardShape: 'triangle', gridSize: 15 }), /INVALID_CONTROLLERS/);
  sut.savePreferences(storage, restored);
  assert.deepEqual(sut.readPreferences(storage), restored);
});

test('both mobile languages expose and save every new level through the existing board cabin', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88]]) {
    const h = uiHarness({ language, width, height, top });
    try {
      await ready(h); const activeHash = h.app.session.stateHash;
      await h.tap('cabin-board');
      for (const count of [3, 6]) {
        await h.slide('player-count', count, 2, 15);
        for (const profile of levels) {
          let offered;
          h.p.choose = async labels => { offered = labels; return labels.indexOf(TEXT[language][`controller-${profile}`]); };
          await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
          assert.ok(offered.includes(TEXT[language][`controller-${profile}`]));
          assert.equal(sut.readPreferences(h.p.storage).controllers.WHITE, profile);
          assert.equal(h.app.session.stateHash, activeHash, 'editing the draft must not change the active game');
          assert.equal(h.app.getScene(), 'home'); assert.equal(h.app.getCabin(), 'board');
          assert.ok(!h.texts.includes('undefined'));
        }
      }
    } finally { h.app.dispose(); }
  }
});

test('shape changes retain Medium, reject a new incompatible game, and require an explicit supported choice', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage });
  try {
    await ready(h); const activeHash = h.app.session.stateHash;
    await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15);
    h.p.choose = async labels => labels.indexOf(TEXT.zh['controller-multiplayer-medium-v1']);
    await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
    await h.scrollTo('shape-hexagon'); await h.tap('shape-hexagon');
    assert.equal(sut.readPreferences(storage).controllers.WHITE, levels[1]);
    await h.tap('cabin-close'); await h.tap('new-game'); await h.render();
    assert.equal(h.app.session.stateHash, activeHash);
    assert.ok(h.p.messages.includes(TEXT.zh.incompatiblePlayers));
    await h.tap('cabin-board');
    let offered;
    h.p.choose = async labels => { offered = labels; return labels.indexOf(TEXT.zh['controller-multiplayer-hard-v1']); };
    await h.scrollTo('controller-WHITE'); await h.tap('controller-WHITE');
    assert.ok(!offered.includes(TEXT.zh['controller-multiplayer-medium-v1']));
    assert.ok(offered.includes(TEXT.zh['controller-multiplayer-easy-v1']));
    assert.equal(sut.readPreferences(storage).controllers.WHITE, levels[2]);
    assert.equal(h.app.session.stateHash, activeHash);
  } finally { h.app.dispose(); }
});

test('saved new levels and old policies survive application restart without being converted to another profile', async () => {
  const storage = memoryStorage(), controllers = { BLACK: 'human', WHITE: levels[2], PURPLE: 'three-player-policy-v1' };
  sut.savePreferences(storage, { size: 5, mode: 'three-human', difficulty: 'normal', playerCount: 3,
    boardShape: 'triangle', controllers, startPlayer: 'BLACK' });
  for (let restart = 0; restart < 2; restart++) {
    const h = uiHarness({ storage });
    try {
      await ready(h);
      assert.deepEqual(plain(h.app.session.controllers), controllers);
      assert.equal(h.app.session.snapshot.currentPlayer, 'BLACK');
      assert.equal(h.app.session.actions.length, 0);
      assert.deepEqual(sut.readPreferences(storage).controllers, controllers);
    } finally { h.app.dispose(); }
  }
});
