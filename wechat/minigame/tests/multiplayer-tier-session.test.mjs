import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { createWxPlatform } from '../src/platform.js';
import { TEXT } from '../src/i18n.js';
import { contributionContext } from '../src/training-contribution.js';

const roles = count => Object.fromEntries(sut.playerIds(count).map(player => [player, 'human']));
const nativeChoices = callback => createWxPlatform({ createCanvas: () => ({}), showActionSheet: callback }).choose;

test('native paged AI picker selects the last new tier, then starts a real AI turn in both languages', async () => {
  for (const language of ['zh', 'en']) {
    const sheets = [], target = sut.controllerLabel('multiplayer-hard-v1', TEXT[language]);
    const choose = nativeChoices(options => {
      sheets.push(options.itemList);
      assert.ok(options.itemList.length <= 6);
      let index = options.itemList.indexOf(target);
      if (index < 0) index = options.itemList.indexOf(`${TEXT[language].nextPage} ›`);
      assert.ok(index >= 0, 'The selected tier must remain reachable in the actual native menu');
      options.success({ tapIndex: index });
    });
    const h = uiHarness({ language, platformOverrides: { choose } });
    try {
      await until(() => h.app.session.canPlay());
      await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15);
      await h.slide('board-size', 5, 5, 15); await h.scrollTo('controller-BLACK');
      await h.tap('controller-BLACK');
      await until(() => sut.readPreferences(h.p.storage).controllers?.BLACK === 'multiplayer-hard-v1');
      assert.equal(sheets.length, 2);
      await h.tap('cabin-close'); await h.tap('new-game');
      await until(() => h.app.session.actions.length === 1 && !h.app.session.busy, 15000);
      assert.equal(h.app.session.controllers.BLACK, 'multiplayer-hard-v1');
      assert.equal(h.app.session.actions[0].player, 'BLACK');
      assert.equal(h.app.session.snapshot.currentPlayer, 'WHITE');
      assert.equal(h.app.session.error, null);
      assert.equal(h.app.session.stateHash, sut.ruleView(sut.restoreGame(h.app.session.settings, h.app.session.actions)).stateHash);
    } finally { h.app.dispose(); }
  }
});

test('backgrounding during a native AI picker cannot open its next page or change saved player settings', async () => {
  let pending, sheets = 0;
  const h = uiHarness({ platformOverrides: { choose: nativeChoices(options => { pending = options; sheets++; }) } });
  try {
    await until(() => h.app.session.canPlay());
    await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15); await h.scrollTo('controller-BLACK');
    const before = plain(sut.readPreferences(h.p.storage));
    await h.tap('controller-BLACK'); assert.ok(pending);
    h.p.callbacks.hide();
    pending.success({ tapIndex: pending.itemList.indexOf('下一页 ›') });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sheets, 1);
    assert.deepEqual(sut.readPreferences(h.p.storage), before);
  } finally { h.app.dispose(); }
});

test('three different new AI seats play in order and retain exact identities through save and replay', async () => {
  const q = localScheduler(), store = new sut.SaveStore(memoryStorage());
  const session = new sut.GameSession(q, store); let restored;
  const controllers = { ...roles(4), BLACK: 'multiplayer-easy-v1', WHITE: 'multiplayer-medium-v1', PURPLE: 'multiplayer-hard-v1' };
  try {
    assert.equal(await session.newGame(5, 'human', 'normal', 4, { controllers }), true);
    await until(() => session.actions.length === 3 && !session.busy, 20000);
    assert.equal(session.error, null); assert.equal(session.canPlay(), true);
    assert.deepEqual(session.actions.map(action => action.player), ['BLACK', 'WHITE', 'PURPLE']);
    const hash = session.stateHash, actions = plain(session.actions);
    assert.deepEqual(store.read().payload.controllers, controllers);
    // The independent v3 contract preserves each actual controller without
    // silently placing this territory-v3 game in the frozen v2 dataset.
    assert.deepEqual(contributionContext(session), {
      source: 'local',
      actors: {
        BLACK: { kind: 'ai', profile: 'multiplayer-easy-v1' },
        WHITE: { kind: 'ai', profile: 'multiplayer-medium-v1' },
        PURPLE: { kind: 'ai', profile: 'multiplayer-hard-v1' },
        GREEN: { kind: 'human' },
      },
      mixedProfiles: false,
      hintsEnabled: true,
      undo: { enabled: false, maxCount: 3, usedCount: 0 },
    });
    await session.replay(1); await session.exitReplay();
    assert.equal(session.stateHash, hash); assert.deepEqual(session.actions, actions);
    assert.deepEqual(session.controllers, controllers);
    const library = new sut.ReplayLibrary(memoryStorage()), id = library.save(session.capture());
    assert.deepEqual(library.read().entries.find(entry => entry.id === id).payload.controllers, controllers);
    restored = new sut.GameSession(q, store); assert.equal(await restored.restore(), true);
    assert.deepEqual(restored.controllers, controllers); assert.equal(restored.stateHash, hash);
    assert.equal(restored.paused, true);
  } finally { restored?.hide(); session.hide(); q.cancel(); }
});
