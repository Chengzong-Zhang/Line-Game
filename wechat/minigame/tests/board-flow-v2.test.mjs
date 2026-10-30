import assert from 'node:assert/strict';
import test from 'node:test';
import { uiHarness } from './ui-harness.mjs';
import { memoryStorage, until } from './helpers.mjs';

const ready = h => until(() => h.app.session.snapshot && !h.app.session.busy);
async function boardPanel(h) { if (h.app.getScene() !== 'home') await h.tap('cabin-board'); }
async function visibleTap(h, id) { await h.scrollTo(id); await h.tap(id); }
async function chooseTorus(h) {
  await boardPanel(h); await visibleTap(h, 'topology-setup'); await visibleTap(h, 'topology-torus');
}
async function panelReset(h) {
  await visibleTap(h, 'new-game'); await ready(h);
}
async function openEditor(h) {
  await boardPanel(h); await visibleTap(h, 'topology-custom');
  assert.equal(h.app.getScene(), 'board-editor');
}
async function touch(h, point) {
  assert.ok(point, 'editor coordinate is visible');
  h.p.callbacks.start({ touches: [{ clientX: point.x, clientY: point.y }] });
  h.p.callbacks.end({ touches: [], changedTouches: [{ clientX: point.x, clientY: point.y }] });
  await h.render();
}
async function gridTouch(h, coordinate) {
  const p = h.app.getEditorLayout().gridPoints.find(p => p.coordinate.join(',') === coordinate.join(','));
  await touch(h, p);
}
async function drawLoop(h, corners) { for (const point of [...corners, corners[0]]) await gridTouch(h, point); }

// The tests send the same touch events as the native adapter; they do not
// change the settings object or invoke editor internals to simulate a user.
test('topology expands inline, collapses inline, and has no separate start screen', async () => {
  const h = uiHarness(); try {
    await ready(h); await boardPanel(h); await visibleTap(h, 'topology-setup');
    assert.equal(h.app.getScene(), 'home');
    await h.scrollTo('topology-torus'); assert.ok(h.app.getButtons().some(b => b.id === 'topology-torus'));
    assert.ok(!h.app.getButtons().some(b => b.id === 'topology-start'));
    await visibleTap(h, 'topology-setup'); await h.render();
    assert.equal(h.app.getScene(), 'home'); assert.ok(!h.app.getButtons().some(b => b.id === 'topology-torus'));
  } finally { h.app.dispose(); }
});

test('selecting topology leaves the match unchanged until the panel reset', async () => {
  const h = uiHarness(); try {
    await ready(h); const original = h.app.session, snapshot = JSON.stringify(original.snapshot);
    await chooseTorus(h);
    assert.equal(h.app.session, original); assert.equal(JSON.stringify(h.app.session.snapshot), snapshot);
    await h.tap('cabin-close'); assert.equal(h.app.session, original);
    await boardPanel(h); await panelReset(h);
    assert.equal(h.app.session.snapshot.rulesVersion, 'surface-v1');
    assert.equal(h.app.session.settings.boardDefinition.topology.preset, 'torus');
    await h.render(); assert.ok(h.app.getButtons().some(b => b.id === 'resign'));
    assert.ok(h.app.getButtons().some(b => b.id === 'new-game'));
  } finally { h.app.dispose(); }
});

test('selected topology survives an app restart before the current game resets', async () => {
  const storage = memoryStorage(); let h = uiHarness({ storage }); try {
    await ready(h); const oldVersion = h.app.session.snapshot.rulesVersion;
    await chooseTorus(h); await h.tap('cabin-close'); h.app.dispose();
    h = uiHarness({ storage }); await ready(h);
    assert.equal(h.app.session.snapshot.rulesVersion, oldVersion);
    await boardPanel(h); await panelReset(h);
    assert.equal(h.app.session.snapshot.rulesVersion, 'surface-v1');
    assert.equal(h.app.session.settings.boardDefinition.topology.preset, 'torus');
  } finally { h.app.dispose(); }
});

test('drawing an outer contour and inner hole saves the next board and reset starts it', async () => {
  const h = uiHarness(); try {
    await ready(h); const prior = h.app.session;
    await openEditor(h); await h.tap('editor-tool-contour'); await h.tap('editor-clear');
    await drawLoop(h, [[0,0],[6,0],[6,6],[0,6]]);
    await h.tap('editor-new-boundary');
    await drawLoop(h, [[3,3],[5,3],[5,5],[3,5]]);
    await h.tap('editor-save'); assert.equal(h.app.getScene(), 'home'); assert.equal(h.app.session, prior);
    await openEditor(h);
    assert.equal(h.app.getEditorLayout().contourPoints.length, 2, 'both contours can be reopened for editing');
    await h.tap('editor-cancel');
    await panelReset(h); assert.equal(h.app.session.snapshot.rulesVersion, 'surface-v1');
    const def = h.app.session.settings.boardDefinition;
    assert.ok(!def.faces.some(f => f.id === 'u:3,3'), 'inner triangular face is absent');
    assert.ok(def.faces.some(f => f.id === 'u:1,1'), 'outer region remains playable');
  } finally { h.app.dispose(); }
});

for (const shape of ['triangle', 'hexagon', 'diamond']) test(`${shape} root edit saves as an ordinary game`, async () => {
  const h = uiHarness(); try {
    await ready(h); await boardPanel(h); await visibleTap(h, `shape-${shape}`); await openEditor(h);
    const layout = h.app.getEditorLayout();
    const root = layout.points.find(p => p.owner === 'BLACK');
    const target = layout.points.find(p => p.coordinate[0] === 1 && p.coordinate[1] === (shape === 'hexagon' ? 5 : 1));
    assert.ok(root && target && !target.owner);
    await touch(h, root); await touch(h, target); await h.tap('editor-save');
    assert.equal(h.app.getScene(), 'home'); await panelReset(h);
    assert.equal(h.app.session.snapshot.rulesVersion, 'territory-v3');
    assert.equal(h.app.session.settings.boardShape, shape);
    assert.equal(h.app.session.settings.boardDefinition, undefined);
    assert.deepEqual(h.app.session.snapshot.roots.BLACK, [target.coordinate]);
  } finally { h.app.dispose(); }
});

test('cancelling an edited root preserves the previously selected ordinary layout', async () => {
  const h = uiHarness(); try {
    await ready(h); await boardPanel(h); await visibleTap(h, 'shape-triangle'); await openEditor(h);
    const layout = h.app.getEditorLayout(), root = layout.points.find(p => p.owner === 'BLACK');
    const target = layout.points.find(p => p.coordinate.join(',') === '1,1');
    await touch(h, root); await touch(h, target); await h.tap('editor-cancel');
    assert.equal(h.app.getScene(), 'home'); await panelReset(h);
    assert.equal(h.app.session.settings.boardShape, 'triangle');
    assert.notDeepEqual(h.app.session.snapshot.roots.BLACK, [target.coordinate]);
  } finally { h.app.dispose(); }
});

test('invalid straight edge shows an error and preserves the drawing for correction', async () => {
  const h = uiHarness(); try {
    await ready(h); await openEditor(h); await h.tap('editor-tool-contour'); await h.tap('editor-clear');
    await gridTouch(h, [1,1]); await gridTouch(h, [4,2]);
    assert.ok(h.texts.some(s => /格线|直线|棋盘设置无法使用/.test(s)), `visible error: ${h.texts.join(' ')}`);
    for (const point of [[5,1],[5,5],[1,5],[1,1]]) await gridTouch(h, point);
    await h.tap('editor-save'); assert.equal(h.app.getScene(), 'home'); await panelReset(h);
    assert.equal(h.app.session.snapshot.rulesVersion, 'surface-v1');
    assert.ok(h.app.session.settings.boardDefinition.faces.some(f => f.id === 'u:1,1'));
  } finally { h.app.dispose(); }
});

test('topology game supports resignation and resetting without a topology start page', async () => {
  const h = uiHarness(); try {
    await ready(h); await chooseTorus(h); await panelReset(h);
    assert.equal(h.app.getScene(), 'game'); const hash = h.app.session.snapshot.boardHash;
    await h.tap('resign'); await until(() => h.app.session.snapshot?.gameOver && !h.app.session.busy);
    await h.tap('new-game'); await until(() => h.app.session.snapshot?.boardHash === hash && !h.app.session.snapshot.gameOver && !h.app.session.busy);
    assert.equal(h.app.getScene(), 'game');
  } finally { h.app.dispose(); }
});

test('touch selects, reverses, joins and removes a seam', async () => {
  const h = uiHarness(); try {
    await ready(h); await openEditor(h); await h.tap('editor-tool-contour'); await h.tap('editor-clear');
    await drawLoop(h, [[1,1],[5,1],[5,5],[1,5]]);
    await h.tap('editor-tool-seam');
    const layout = h.app.getEditorLayout();
    for (const edge of [layout.edges[1], layout.edges[3]]) await touch(h, { x: (edge.a.x+edge.b.x)/2, y: (edge.a.y+edge.b.y)/2 });
    await h.tap('editor-seam-direction'); await h.tap('editor-add-seam');
    const joined = h.app.getEditorLayout().seams;
    assert.equal(joined.length, 1); assert.deepEqual(joined[0].endpointMap, [1,0]);
    const edge = joined[0].edges[0]; await touch(h, { x: (edge.a.x+edge.b.x)/2, y: (edge.a.y+edge.b.y)/2 });
    assert.equal(h.app.getEditorLayout().seams.length, 0);
  } finally { h.app.dispose(); }
});

test('touch adds roots for two colours and reset preserves both multi-root lists', async () => {
  const h = uiHarness(); try {
    await ready(h); await chooseTorus(h); await openEditor(h);
    const layout = h.app.getEditorLayout(), free = layout.points.filter(p => !p.owner);
    const black = free[2]; await touch(h, black);
    await h.tap('editor-player-WHITE');
    const next = h.app.getEditorLayout().points.find(p => !p.owner && p.vertexId !== black.vertexId);
    await touch(h, next); await h.tap('editor-save'); assert.equal(h.app.getScene(), 'home');
    await panelReset(h);
    assert.equal(h.app.session.snapshot.rulesVersion, 'surface-v1');
    const roots = h.app.session.settings.boardDefinition.startingVertices;
    assert.equal(roots.BLACK.length, 2); assert.equal(roots.WHITE.length, 2);
  } finally { h.app.dispose(); }
});
