import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const ready = async h => {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  await h.render();
};

test('first launch opens a playable board without account or start screen, and AI responds', async () => {
  let requests = 0, logins = 0;
  const h = uiHarness({ platformOverrides: { request: async () => { requests++; }, login: async () => { logins++; } } });
  try {
    await ready(h);
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session.canPlay(), true);
    for (const id of ['confirm', 'skip', 'resign', 'hint', 'cabin-board', 'cabin-battle', 'cabin-guide', 'cabin-tutorial'])
      assert.ok(h.app.getButtons().find(b => b.id === id), id);
    h.app.tap(...sut.toScreen([1, 0], h.app.getLayout()));
    await h.render(); await h.tap('confirm');
    await until(() => h.app.session.actions.length === 2 && !h.app.session.busy);
    assert.equal(h.app.session.snapshot.currentPlayer, 'BLACK');
    assert.equal(logins, 0); assert.equal(requests, 0);
  } finally { h.app.dispose(); }
});

test('four cabin sheets retain the current match, hide underlying controls and return to a playable board', async () => {
  const h = uiHarness();
  try {
    await ready(h);
    const hash = h.app.session.stateHash;
    for (const cabin of ['board', 'battle', 'guide', 'tutorial']) {
      await h.tap(`cabin-${cabin}`); await h.render();
      assert.equal(h.app.getCabin(), cabin);
      assert.equal(h.app.getLayout(), null, 'sheet blocks board input');
      assert.equal(h.app.getButtons().some(b => b.id === 'confirm'), false);
      assert.equal(h.app.session.stateHash, hash);
      await h.tap('cabin-close'); await h.render();
      assert.equal(h.app.getCabin(), null);
      assert.ok(h.app.getLayout()); assert.equal(h.app.session.canPlay(), true);
    }
  } finally { h.app.dispose(); }
});

test('guide cabin opens the migrated Web essentials and returns without changing the match', async () => {
  const h = uiHarness();
  try {
    await ready(h); const hash = h.app.session.stateHash;
    await h.tap('cabin-guide'); await h.tap('guide-rules-essential');
    assert.equal(h.app.getScene(), 'reader');
    await h.tap('reader-next'); await h.tap('reader-back'); await h.tap('cabin-close');
    assert.equal(h.app.getScene(), 'game'); assert.equal(h.app.session.stateHash, hash);
  } finally { h.app.dispose(); }
});

test('visible pass and resign act on the same game; stale resign confirmation is discarded', async () => {
  const h = uiHarness();
  try {
    await ready(h); await h.app.session.newGame(5, 'human'); await h.render();
    await h.tap('skip'); await until(() => !h.app.session.busy); await h.render();
    assert.equal(h.app.session.actions[0].type, 'skip');
    let confirm;
    h.p.confirm = () => new Promise(resolve => { confirm = resolve; });
    await h.tap('resign'); await until(() => confirm);
    await h.tap('cabin-guide'); confirm(true); await h.render();
    assert.equal(h.app.session.actions.length, 1, 'navigation invalidates pending resignation');
    await h.tap('cabin-close');
    h.p.confirm = async () => true;
    await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver);
    assert.equal(h.app.session.actions[1].type, 'resign');
  } finally { h.app.dispose(); }
});

test('safe-area layout keeps cabin and core controls on compact and large phones in both languages', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const h = uiHarness({ language, width, height, top });
    const check = () => {
      const buttons = h.app.getButtons();
      for (const b of buttons) {
        assert.ok(b.x >= 0 && b.x + b.width <= width, `${language}/${width}/${b.id}: horizontal`);
        assert.ok(b.y >= (b.id === 'account-avatar' ? top - 40 : top) && b.y + b.height <= height - 24, `${language}/${width}/${b.id}: safe area`);
        assert.ok(b.height >= 36, `${b.id}: touch target`);
      }
      for (const [i, a] of buttons.entries()) for (const b of buttons.slice(i + 1))
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
          `${language}/${width}: ${a.id} overlaps ${b.id}`);
    };
    try {
      await ready(h); check();
      for (const cabin of ['board', 'battle', 'guide', 'tutorial']) {
        await h.tap(`cabin-${cabin}`); await h.render(); check(); await h.tap('cabin-close');
      }
    } finally { h.app.dispose(); }
  }
});

test('launch resumes validated saved moves, and a corrupt save is not replaced automatically', async () => {
  const storage = memoryStorage(), first = uiHarness({ storage });
  try {
    await ready(first); await first.app.session.newGame(5, 'human');
    await first.app.session.act({ type: 'move', point: [1, 0] });
  } finally { first.app.dispose(); }
  const saved = [...storage.map.entries()].filter(([key]) => key.startsWith('lifeline-wechat-session-v1-'));
  const restored = uiHarness({ storage });
  try {
    await ready(restored); assert.equal(restored.app.session.actions.length, 1);
    assert.equal(restored.app.session.canPlay(), true);
  } finally { restored.app.dispose(); }
  assert.ok(saved.length > 0);
  for (const [key] of saved) storage.set(key, '{invalid');
  const before = new Map(storage.map), damaged = uiHarness({ storage });
  try {
    await until(() => damaged.app.session.error); await damaged.render();
    assert.equal(damaged.app.session.snapshot, null);
    for (const [key, value] of before) assert.equal(storage.get(key), value);
    assert.ok(damaged.app.getButtons().some(b => b.id === 'load-retry'));
  } finally { damaged.app.dispose(); }
});

test('friend-game cabins preserve the authoritative room and reject stale direct-action confirmations', async () => {
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://test.invalid' },
    platformOverrides: { choose: async () => 0, share() {} } });
  let sends = 0, confirmation;
  h.app.online.enter = async () => {
    const client = h.app.online;
    await client.game.load(sut.settingsFor(7), [], { mode: 'human', paused: true, save: false });
    client.active = client.connected = true;
    client.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0, stateHash: client.game.stateHash,
      status: 'playing', player: 'BLACK', settings: client.game.settings, ready: {}, rematchVotes: {} };
    client.notify(); return true;
  };
  h.app.online.act = async () => { sends++; return true; };
  try {
    await ready(h); await h.tap('cabin-battle'); await h.tap('friends'); await h.tap('room-submit');
    await until(() => h.app.online.room); await h.render();
    const hash = h.app.session.stateHash;
    await h.tap('cabin-board'); await h.render();
    for (const id of ['player-count', 'controller-BLACK', 'controller-WHITE', 'starter-BLACK']) {
      await h.scrollTo(id);
      assert.equal(h.app.getButtons().find(b => b.id === id)?.disabled, false, id);
    }
    await h.tap('cabin-close');
    h.p.confirm = () => new Promise(resolve => { confirmation = resolve; });
    await h.tap('resign'); await until(() => confirmation);
    await h.tap('cabin-guide'); confirmation(true); await h.render();
    assert.equal(sends, 0); assert.equal(h.app.session.stateHash, hash);
    await h.tap('cabin-close'); await h.tap('skip');
    assert.equal(sends, 1);
  } finally { h.app.dispose(); }
});


test('single stage places four cabins above scores and keeps the 1-2-1 action row and emoji row', async () => {
  const h = uiHarness();
  try {
    await ready(h); const all = h.app.getButtons(), by = id => all.find(b => b.id === id);
    assert.equal(all.some(b => ['home', 'game-menu'].includes(b.id)), false, 'no legacy tool cabin');
    const tabs = ['board', 'battle', 'guide', 'tutorial'].map(key => by(`cabin-${key}`));
    assert.ok(tabs.every(b => b.y === tabs[0].y && b.width === tabs[0].width));
    const resign = by('resign'), confirm = by('confirm'), reset = by('new-game');
    assert.equal(resign.y, confirm.y); assert.equal(reset.y, confirm.y);
    assert.equal(confirm.width, resign.width * 2); assert.equal(reset.width, resign.width);
    assert.ok(by('emote-0').y > confirm.y + confirm.height);
    assert.ok(by('account-avatar').x + by('account-avatar').width < 390 - 102);
  } finally { h.app.dispose(); }
});

test('sliding settings keeps the active position, applies only on reset, and exposes all three player seats', async () => {
  const h = uiHarness({ width: 320, height: 568, top: 64 });
  try {
    await ready(h); const hash = h.app.session.stateHash;
    await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15);
    await h.scrollTo('controller-PURPLE');
    assert.equal(h.app.getButtons().find(b => b.id === 'controller-PURPLE').disabled, false);
    await h.slide('board-size', 10, 5, 15);
    assert.equal(h.app.session.stateHash, hash); assert.equal(h.app.session.settings.playerCount, 2);
    assert.equal(h.app.getButtons().some(b => ['friends', 'account', 'library', 'display-open'].includes(b.id)), false);
    await h.tap('cabin-close'); await h.tap('new-game'); await until(() => !h.app.session.busy);
    assert.equal(h.app.session.settings.playerCount, 3); assert.equal(h.app.session.settings.gridSize, 10);
    await h.render(); assert.ok(h.texts.some(value => value.startsWith('紫方')));
  } finally { h.app.dispose(); }
});

test('terminology switch changes on-board copy without changing the underlying rules or position', async () => {
  const h = uiHarness();
  try {
    await ready(h); const hash = h.app.session.stateHash;
    await h.tap('cabin-board'); await h.tap('terminology'); await h.tap('cabin-close'); await h.render();
    assert.ok(h.texts.includes('确认部署')); assert.equal(h.app.session.stateHash, hash);
    assert.equal(sut.readPreferences(h.p.storage).terminology, 'war');
  } finally { h.app.dispose(); }
});

test('three-player hint settings remain usable and switching player count preserves the configured hint budget', async () => {
  for (const language of ['zh', 'en']) {
    const h = uiHarness({ language, width: 320, height: 568, top: 64 });
    try {
      await ready(h); const hash = h.app.session.stateHash;
      await h.tap('cabin-board'); await h.slide('hint-count', 7, 1, 10);
      const before = sut.readPreferences(h.p.storage).playOptions;
      assert.equal(before.hintEnabled, true); assert.equal(before.hintMaxCount, 7);
      await h.slide('player-count', 3, 2, 15); await h.scrollTo('hint-enabled');
      const toggle = h.app.getButtons().find(button => button.id === 'hint-enabled');
      assert.equal(toggle?.disabled, false);
      h.app.tap(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2); await h.render();
      assert.equal(sut.readPreferences(h.p.storage).playOptions.hintEnabled, false);
      await h.tap('hint-enabled');
      await h.scrollTo('hint-count');
      const count = h.app.getButtons().find(button => button.id === 'hint-count');
      assert.equal(count?.disabled, false);
      assert.deepEqual(sut.readPreferences(h.p.storage).playOptions, before);
      await h.slide('player-count', 2, 2, 15); await h.scrollTo('hint-enabled');
      assert.equal(h.app.getButtons().find(button => button.id === 'hint-enabled')?.disabled, false);
      await h.scrollTo('hint-count');
      assert.equal(h.app.getButtons().find(button => button.id === 'hint-count')?.disabled, false);
      assert.deepEqual(sut.readPreferences(h.p.storage).playOptions, before);
      assert.equal(h.app.session.stateHash, hash, 'draft changes preserve the running game');
    } finally { h.app.dispose(); }
  }
});
