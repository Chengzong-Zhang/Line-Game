import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };
const profile = 'three-player-policy-v1';
const stableCapture = session => {
  const saved = session.capture(); delete saved.session.savedAt; return JSON.stringify(saved);
};
async function choose(h, player, index) {
  h.p.choose = async () => index; await h.scrollTo(`controller-${player}`); await h.tap(`controller-${player}`);
}

test('two- and three-player controller drafts stay separate, persist across restart and preserve Purple on reset', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage }); let second;
  try {
    await ready(h); const hash = h.app.session.stateHash;
    await h.tap('cabin-board'); await choose(h, 'BLACK', 1); await choose(h, 'WHITE', 0); await h.tap('starter-WHITE');
    const two = { BLACK: 'greedy', WHITE: 'human' };
    await h.slide('player-count', 3, 2, 6); await choose(h, 'BLACK', 1); await choose(h, 'PURPLE', 1); await h.tap('starter-PURPLE');
    const three = { BLACK: profile, WHITE: 'human', PURPLE: profile };
    assert.deepEqual(sut.readPreferences(storage).controllers, three);
    assert.equal(sut.readPreferences(storage).mode, 'three-human');
    await h.slide('player-count', 2, 2, 6);
    assert.deepEqual(sut.readPreferences(storage).controllers, two); assert.equal(sut.readPreferences(storage).startPlayer, 'WHITE');
    await h.slide('player-count', 3, 2, 6);
    assert.deepEqual(sut.readPreferences(storage).controllers, three); assert.equal(sut.readPreferences(storage).startPlayer, 'PURPLE');
    assert.equal(h.app.session.stateHash, hash, 'editing drafts never replaces the running game');
    h.app.dispose(); second = uiHarness({ storage }); await ready(second);
    await second.tap('cabin-board');
    await second.slide('player-count', 2, 2, 6); assert.deepEqual(sut.readPreferences(storage).controllers, two);
    await second.slide('player-count', 3, 2, 6); assert.deepEqual(sut.readPreferences(storage).controllers, three);
    await second.tap('cabin-close'); await second.tap('new-game');
    await until(() => second.app.session.settings.playerCount === 3 && second.app.session.actions.length >= 2 && !second.app.session.busy);
    assert.deepEqual(second.app.session.controllers, three); assert.equal(second.app.session.settings.startPlayer, 'PURPLE');
    assert.deepEqual(second.app.session.actions.map(action => action.player), ['PURPLE', 'BLACK']);
    assert.equal(second.app.session.snapshot.currentPlayer, 'WHITE'); assert.equal(second.app.session.canPlay(), true);
    await second.app.session.replay(1); const branchHash = second.app.session.replayStateHash;
    await second.render(); await second.tap('replay-branchReplay');
    await second.tap('branch-keep'); await second.tap('branch-start');
    await until(() => second.app.getScene() === 'game' && second.app.session.replayIndex === null);
    assert.deepEqual(second.app.session.controllers, three); assert.equal(second.app.session.stateHash, branchHash);
    assert.equal(second.app.session.actions.length, 1); assert.equal(second.app.session.paused, true);
  } finally { h.app.dispose(); second?.app.dispose(); }
});

test('each three-player seat offers compatible AI versions; delayed two-player choices cannot leak across count changes', async () => {
  const h = uiHarness(); let finish;
  try {
    await ready(h); await h.tap('cabin-board');
    h.p.choose = () => new Promise(resolve => { finish = resolve; });
    await h.tap('controller-BLACK');
    await h.slide('player-count', 3, 2, 6); await h.slide('player-count', 2, 2, 6);
    finish(4); await h.render();
    assert.equal(sut.readPreferences(h.p.storage).controllers, undefined);
    await h.slide('player-count', 3, 2, 6);
    for (const player of ['BLACK', 'WHITE', 'PURPLE']) {
      let offered;
      h.p.choose = async labels => { offered = labels; return 1; };
      await h.scrollTo(`controller-${player}`); await h.tap(`controller-${player}`);
      assert.deepEqual(offered, ['human', profile, 'three-player-policy-v2', 'three-player-search-v4-round12',
        'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'].map(item => TEXT.zh[`controller-${item}`]));
      assert.equal(sut.readPreferences(h.p.storage).controllers[player], profile);
      assert.equal(h.app.getScene(), 'home', 'three-player selection never opens the two-player model catalogue');
    }
  } finally { finish?.(-1); h.app.dispose(); }
});

test('one, two and three AI seats configured through the cabin execute their own turns and can be paused', async () => {
  for (const seats of [['WHITE'], ['WHITE', 'PURPLE'], ['BLACK', 'WHITE', 'PURPLE']]) {
    const h = uiHarness();
    try {
      await ready(h); await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 6); await h.slide('board-size', 5, 5, 15);
      for (const player of seats) await choose(h, player, 1);
      await h.tap('cabin-close'); await h.tap('new-game');
      await until(() => h.app.session.settings.playerCount === 3 && (h.app.session.canPlay() || h.app.session.actions.length >= 3));
      if (!seats.includes('BLACK')) {
        const move = h.app.session.snapshot.legalMoves[0].point;
        await h.app.session.act({ type: 'move', point: move });
        await until(() => h.app.session.actions.length === seats.length + 1 && !h.app.session.busy);
        assert.deepEqual(h.app.session.actions.map(action => action.player), ['BLACK', 'WHITE', ...(seats.length === 2 ? ['PURPLE'] : [])]);
      } else {
        h.app.session.pause(); const count = h.app.session.actions.length;
        await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(h.app.session.actions.length, count);
        assert.ok(count >= 3); assert.equal(h.app.session.paused, true);
      }
      assert.equal(h.app.session.error, null);
      for (const player of seats) assert.equal(h.app.session.controllerFor(player), profile);
    } finally { h.app.dispose(); }
  }
});

test('three-player hints and replay analysis use the dedicated strategy without changing the live game', async () => {
  for (const language of ['zh', 'en']) {
    const h = uiHarness({ language, width: 320, height: 568, top: 64 });
    try {
      await ready(h); await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 6); await h.slide('board-size', 5, 5, 15);
      await h.tap('cabin-close'); await h.tap('new-game'); await until(() => h.app.session.canPlay());
      const hash = h.app.session.stateHash;
      await h.tap('hint'); await until(() => !h.app.session.busy && h.app.session.hintPoint);
      assert.equal(h.app.session.hintsUsed, 1); assert.equal(h.app.session.stateHash, hash);
      await h.app.session.act({ type: 'move', point: [...h.app.session.hintPoint] });
      const live = stableCapture(h.app.session);
      await h.app.session.replay(0); await h.render(); await h.tap('replay-analyzeReplay');
      await until(() => !h.app.session.busy); await h.render();
      assert.ok(h.app.getButtons().some(button => button.id === 'analysis-move-0'));
      assert.ok(h.texts.includes(TEXT[language]['controller-three-player-search-v4-round12']));
      assert.equal(h.texts.some(text => /\d+(?:\.\d+)?%/.test(text)), false, 'raw three-player scores are never formatted as probabilities');
      assert.ok(h.texts.join(' ').includes(language === 'zh' ? '搜索评估' : 'Search score'));
      let offered; h.p.choose = async labels => { offered = labels; return 0; };
      await h.tap('analysis-choose'); await until(() => !h.app.session.busy); await h.render();
      assert.deepEqual(offered, [profile, 'three-player-policy-v2', 'three-player-search-v4-round12',
        'multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'].map(item => TEXT[language][`controller-${item}`]));
      assert.ok(h.texts.join(' ').includes(language === 'zh' ? '策略评分' : 'Policy score'));
      assert.equal(h.app.getScene(), 'analysis'); assert.equal(h.texts.includes('undefined'), false);
      await h.tap('analysis-move-0'); assert.equal(h.app.getScene(), 'game'); assert.equal(h.app.session.replayIndex, 0);
      assert.equal(stableCapture(h.app.session), live); assert.equal(h.app.session.hintsUsed, 1);
      await h.app.session.exitReplay(); assert.equal(stableCapture(h.app.session), live);
    } finally { h.app.dispose(); }
  }
});

test('a damaged inactive player draft does not discard valid active preferences', () => {
  const storage = memoryStorage();
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 9, mode: 'three-human', difficulty: 'normal', startPlayer: 'PURPLE',
    controllers: { BLACK: 'human', WHITE: profile, PURPLE: profile }, playerDrafts: {
      2: { mode: 'ai-white', startPlayer: 'WHITE', controllers: { BLACK: profile, WHITE: 'human' } },
      3: { mode: 'three-human', startPlayer: 'PURPLE', controllers: { BLACK: 'human', WHITE: profile, PURPLE: profile } },
    } }));
  const result = sut.readPreferences(storage);
  assert.equal(result.size, 9); assert.equal(result.startPlayer, 'PURPLE'); assert.equal(result.controllers.PURPLE, profile);
  assert.equal(result.playerDrafts[2], undefined); assert.equal(result.playerDrafts[3].controllers.WHITE, profile);
});
