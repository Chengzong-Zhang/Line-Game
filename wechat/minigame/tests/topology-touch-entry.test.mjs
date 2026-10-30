import assert from 'node:assert/strict';
import test from 'node:test';
import { uiHarness } from './ui-harness.mjs';
import { memoryStorage, until } from './helpers.mjs';
import { createTopologySetup, useTopologyPreset, changeTopologyStarts } from '../src/topology-setup.js';

test('native-style touch draws a grid boundary, starts it and restores it without TextEncoder', async () => {
  const encoder = globalThis.TextEncoder, storage = memoryStorage();
  let h;
  try {
    globalThis.TextEncoder = undefined;
    h = uiHarness({ storage });
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-custom'); await h.tap('topology-custom');
    await h.tap('editor-tool-contour'); await h.tap('editor-clear');
    const touch = async coordinate => {
      const point = h.app.getEditorLayout().gridPoints.find(p => p.coordinate.join(',') === coordinate.join(','));
      assert.ok(point && point.y > 150 && point.y < 760, 'the selected grid point is visibly inside the editor');
      h.p.callbacks.start({ touches: [{ clientX: point.x, clientY: point.y }] });
      h.p.callbacks.end({ touches: [], changedTouches: [{ clientX: point.x, clientY: point.y }] });
      await h.render();
    };
    for (const coordinate of [[1, 1], [4, 1], [4, 4], [1, 4], [1, 1]]) await touch(coordinate);
    assert.equal(h.app.getEditorLayout().contourPoints.length, 1);
    await h.tap('editor-save'); await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    const hash = h.app.session.snapshot.boardHash;
    assert.ok(h.app.session.snapshot.legalMoves.length > 0);
    h.app.dispose();
    h = uiHarness({ storage });
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    assert.equal(h.app.session.snapshot.boardHash, hash);
    assert.deepEqual(h.p.messages, []);
  } finally { h?.app.dispose(); globalThis.TextEncoder = encoder; }
});

test('one-tap random surfaces use different seeds for successive new games', async () => {
  const h = uiHarness();
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-random'); await h.tap('topology-random');
    await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    const seed = h.app.session.settings.boardDefinition.generator.seed;
    await h.tap('cabin-board'); await h.scrollTo('topology-random'); await h.tap('topology-random');
    await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.settings.boardDefinition?.generator?.seed !== seed && !h.app.session.busy);
    assert.notEqual(h.app.session.settings.boardDefinition.generator.seed, seed);
  } finally { h.app.dispose(); }
});

test('resetting a topology layout restores the selected surface defaults after a shuffle', () => {
  const original = useTopologyPreset(createTopologySetup(), 'double-torus', { gridSize: 9, playerCount: 2 }).setup;
  const shuffled = changeTopologyStarts(original, { mode: 'random', playerCount: 2, random: () => 0.4 });
  assert.equal(shuffled.ok, true);
  assert.notDeepEqual(shuffled.setup.definition.startingVertices, original.definition.startingVertices);
  const reset = changeTopologyStarts(shuffled.setup, { mode: 'default', playerCount: 2 });
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.setup.definition, original.definition);
});
