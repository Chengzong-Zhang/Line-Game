import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, plain, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };
const seeded = () => {
  let seed = 1729, calls = 0;
  return { random: () => { calls++; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }, count: () => calls };
};

for (const mode of ['classic', 'fixed-double', 'relocate', 'add']) test(`${mode}: random preview and shuffle match the next game exactly, then redraw`, async () => {
  const storage = memoryStorage(), rng = seeded();
  sut.savePreferences(storage, { size: 7, mode: 'human', difficulty: 'simple', playerCount: 2, rootMode: mode });
  let h = uiHarness({ storage, config: { startRandom: rng.random } });
  try {
    await ready(h); const oldHash = h.app.session.stateHash;
    await h.tap('cabin-board');
    assert.equal(h.app.getButtons().some(button => ['root-classic', 'root-fixed-double', 'root-relocate'].includes(button.id)), false);
    await h.scrollTo('starts-random'); await h.tap('starts-random');
    assert.equal(h.app.getScene(), 'starts');
    const first = h.app.getStartPreview();
    await h.tap('starts-shuffle'); const preview = h.app.getStartPreview();
    assert.notDeepEqual(preview, first); assert.equal(h.app.session.stateHash, oldHash);
    await h.tap('starts-save'); await h.tap('cabin-close');
    const beforeStart = rng.count(); await h.tap('new-game'); await until(() => !h.app.session.busy);
    assert.deepEqual(plain(h.app.session.snapshot.roots), preview);
    assert.equal(rng.count(), beforeStart, 'starting a prepared layout must not draw again');
    await h.app.session.replay(0); await h.app.session.exitReplay();
    assert.equal(rng.count(), beforeStart, 'replay must not draw');
    const firstSettings = plain(h.app.session.settings);
    h.app.session.pause(); h.app.session.save(); h.app.dispose();
    const beforeRestore = rng.count(); h = uiHarness({ storage, config: { startRandom: rng.random } }); await ready(h);
    assert.deepEqual(plain(h.app.session.snapshot.roots), preview);
    assert.deepEqual(plain(h.app.session.settings), firstSettings);
    assert.equal(rng.count(), beforeRestore, 'restore must not draw');
    await h.tap('new-game'); await until(() => !h.app.session.busy);
    assert.ok(rng.count() > beforeRestore, 'the next new game draws fresh roots');
    assert.notDeepEqual(plain(h.app.session.snapshot.roots), preview);
  } finally { h.app.dispose(); }
});

test('changing shape invalidates an accepted random preview', async () => {
  const storage = memoryStorage(), rng = seeded();
  sut.savePreferences(storage, { size: 7, mode: 'human', difficulty: 'simple', playerCount: 2 });
  const h = uiHarness({ storage, config: { startRandom: rng.random } });
  try {
    await ready(h); await h.tap('cabin-board'); await h.scrollTo('starts-random'); await h.tap('starts-random');
    const preview = h.app.getStartPreview(); await h.tap('starts-save');
    await h.scrollTo('shape-diamond'); await h.tap('shape-diamond');
    await h.tap('cabin-close'); const before = rng.count(); await h.tap('new-game'); await until(() => !h.app.session.busy);
    assert.ok(rng.count() > before); assert.equal(h.app.session.settings.boardShape, 'diamond');
    assert.notDeepEqual(plain(h.app.session.snapshot.roots), preview);
  } finally { h.app.dispose(); }
});

test('legacy room setup submits exactly the fixed-double roots shown in its preview', async () => {
  const rng = seeded(), storage = memoryStorage();
  sut.savePreferences(storage, { size: 7, mode: 'human', difficulty: 'simple', playerCount: 2, rootMode: 'fixed-double' });
  const h = uiHarness({ storage, config: { onlineEnabled: true, apiBase: 'https://test.invalid', startRandom: rng.random } });
  let submitted;
  h.app.online.enter = async (kind, settings) => { submitted = settings; return true; };
  try {
    await ready(h); await h.tap('cabin-battle'); await h.scrollTo('friends'); await h.tap('friends');
    // Legacy fixed-double settings remain readable without exposing the removed mode button.
    await h.scrollTo('starts-random'); await h.tap('starts-random'); await h.tap('starts-shuffle');
    const preview = h.app.getStartPreview(); await h.tap('starts-save');
    const before = rng.count(); await h.scrollTo('room-submit'); await h.tap('room-submit');
    await until(() => submitted);
    assert.equal(rng.count(), before);
    assert.deepEqual(plain(submitted.initialRoots), preview);
    assert.equal(submitted.rootMode, 'fixed-double');
  } finally { h.app.dispose(); }
});
