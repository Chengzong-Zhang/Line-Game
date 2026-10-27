import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

async function fullLibrary() {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
  for (let i = 0; i < 100; i++) library.save({
    session: sut.createLocalGameSession({ ...sut.settingsFor(5 + i % 11), turnTimeLimitSeconds: 15 + i }, []),
    mode: 'human', difficulty: 'normal',
  });
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal' }));
  return { storage, library, oldest: library.read().entries.at(-1).id };
}

test('a full 100-game library rolls over and the real new-game button still works', async () => {
  const { storage, library, oldest } = await fullLibrary(), h = uiHarness({ storage });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver);
    const previous = h.app.session.settings;
    await h.tap('new-game');
    await until(() => h.app.session.settings !== previous && !h.app.session.busy);
    assert.equal(h.app.session.actions.length, 0);
    assert.equal(library.read().entries.length, 100);
    assert.equal(library.read().entries.some(entry => entry.id === oldest), false);
    assert.equal(h.p.messages.length, 0);
    await h.tap('library'); await h.render();
    assert.ok(h.texts.some(text => text.includes('100/100')));
  } finally { h.app.dispose(); }
});

test('an archive write failure does not block a new game or destroy saved replays', async () => {
  const { storage, library } = await fullLibrary(), before = library.read().entries.map(entry => entry.id), h = uiHarness({ storage });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver);
    const write = storage.set, previous = h.app.session.settings;
    storage.set = (key, value) => { if (key.startsWith('lifeline-wechat-library-')) throw Error('QUOTA'); return write(key, value); };
    await h.tap('new-game'); await until(() => h.app.session.settings !== previous && !h.app.session.busy);
    assert.deepEqual(library.read().entries.map(entry => entry.id), before);
    assert.equal(h.app.session.saveError, false);
    assert.equal(h.app.session.actions.length, 0);
    await h.render(); assert.ok(h.texts.some(text => text.includes('新对局可继续')));
  } finally { h.app.dispose(); }
});
