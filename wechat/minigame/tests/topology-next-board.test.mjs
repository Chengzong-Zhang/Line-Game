import assert from 'node:assert/strict';
import test from 'node:test';
import { uiHarness } from './ui-harness.mjs';
import { sut, memoryStorage, until } from './helpers.mjs';

async function scrollBoardTo(h, id) {
  await h.scrollTo(id);
  // In larger games the order tiles cover the usual scroll gesture's start.
  // The clear margin remains a genuine scroll area, without dragging a tile.
  for (let i = 0; i < 12 && !h.app.getButtons().some(b => b.id === id); i++) {
    h.p.callbacks.start({ touches: [{ clientX: 300, clientY: 760 }] });
    h.p.callbacks.move({ touches: [{ clientX: 300, clientY: 620 }] });
    h.p.callbacks.end({ touches: [], changedTouches: [{ clientX: 300, clientY: 620 }] });
    await h.render();
  }
}

async function startTorus(h) {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  await h.tap('cabin-board'); await scrollBoardTo(h, 'topology-setup'); await h.tap('topology-setup');
  await scrollBoardTo(h, 'topology-torus'); await h.tap('topology-torus'); await scrollBoardTo(h, 'new-game'); await h.tap('new-game');
  await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
}

for (const shape of ['triangle', 'hexagon']) test(`topology game can switch to ${shape} for the next game`, async () => {
  const h = uiHarness();
  try {
    await startTorus(h);
    const oldHash = h.app.session.snapshot.boardHash;
    await h.tap('cabin-board'); await h.scrollTo(`shape-${shape}`); await h.tap(`shape-${shape}`);
    assert.equal(h.app.session.snapshot.boardHash, oldHash, 'editing the draft preserves the current match');
    await h.tap('cabin-close'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'territory-v3' && !h.app.session.busy);
    assert.equal(h.app.session.snapshot.boardShape, shape);
  } finally { h.app.dispose(); }
});

test('topology restart and board setup retain the selected surface', async () => {
  const h = uiHarness();
  try {
    await startTorus(h);
    const hash = h.app.session.snapshot.boardHash;
    await h.tap('cabin-board'); await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => !h.app.session.busy && h.app.session.snapshot?.boardHash === hash);
    await h.tap('new-game'); assert.equal(h.app.getScene(), 'game');
    await until(() => !h.app.session.busy && h.app.session.snapshot?.boardHash === hash);
  } finally { h.app.dispose(); }
});

test('restored topology game can switch to a normal board', async () => {
  const storage = memoryStorage(); let h = uiHarness({ storage });
  try {
    await startTorus(h); const hash = h.app.session.snapshot.boardHash;
    h.app.session.pause(); h.app.session.save(); h.app.dispose();
    h = uiHarness({ storage });
    await until(() => h.app.session.snapshot?.boardHash === hash && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('shape-triangle'); await h.tap('shape-triangle');
    assert.equal(h.app.session.snapshot.boardHash, hash);
    await h.tap('cabin-close'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'territory-v3' && !h.app.session.busy);
    assert.equal(h.app.session.snapshot.boardShape, 'triangle');
  } finally { h.app.dispose(); }
});

test('switching from seven players to topology and back appends the returning player', async () => {
  const storage = memoryStorage(), seventh = sut.PLAYER_ORDER[6];
  sut.savePreferences(storage, { size: 9, mode: 'human', difficulty: 'simple', playerCount: 7,
    boardShape: 'hexagon', startPlayer: seventh, startingPointMode: 'random' });
  const h = uiHarness({ storage });
  try {
    await startTorus(h);
    assert.equal(h.app.session.settings.playerCount, 6);
    assert.ok(sut.PLAYER_ORDER.slice(0, 6).includes(h.app.session.settings.startPlayer));
    assert.equal(h.p.messages.length, 0);
    await h.tap('cabin-board'); await h.scrollTo('shape-hexagon'); await h.tap('shape-hexagon');
    await h.slide('player-count', 7, 2, 15); await h.tap('cabin-close'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'territory-v3' && !h.app.session.busy);
    assert.equal(h.app.session.settings.playerCount, 7);
    assert.equal(h.app.session.settings.startPlayer, sut.PLAYER_ORDER[0]);
    assert.deepEqual(h.app.session.settings.turnOrder, [...sut.PLAYER_ORDER.slice(0, 6), seventh]);
  } finally { h.app.dispose(); }
});

test('adding a topology player keeps existing multiple roots and restores the new game', async () => {
  const storage = memoryStorage(); let h = uiHarness({ storage, platformOverrides: { choose: async () => 0 } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.scrollTo('topology-torus'); await h.tap('topology-torus');
    await h.scrollTo('topology-custom'); await h.tap('topology-custom');
    const point = h.app.getEditorLayout().points.find(p => !p.owner);
    h.app.tap(point.x, point.y); await h.render(); await h.tap('editor-save');
    await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    const before = h.app.session.settings.boardDefinition.startingVertices;
    assert.equal(before.BLACK.length, 2);
    await h.tap('cabin-board'); await h.slide('player-count', 3, 2, 15); await h.tap('cabin-close');
    await h.tap('new-game');
    await until(() => h.app.session.settings?.playerCount === 3 && !h.app.session.busy);
    const settings = h.app.session.settings, hash = h.app.session.snapshot.boardHash;
    assert.deepEqual(settings.boardDefinition.startingVertices.BLACK, before.BLACK);
    assert.deepEqual(settings.boardDefinition.startingVertices.WHITE, before.WHITE);
    assert.ok(settings.boardDefinition.startingVertices.PURPLE);
    assert.equal(settings.boardHash, hash);
    h.app.session.pause(); h.app.session.save(); h.app.dispose();
    h = uiHarness({ storage });
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    assert.equal(h.app.session.settings.playerCount, 3);
    assert.equal(h.app.session.snapshot.boardHash, hash);
    assert.equal(h.app.session.error, null);
  } finally { h.app.dispose(); }
});
