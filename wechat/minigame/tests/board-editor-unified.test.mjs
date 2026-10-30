import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyBoardDefinition, getBoardPositions } from '../src/core.js';
import { topologyStartingRoots } from '../src/topology/TopologyStartingPoints.js';
import { createTopologySetup, createTopologyEditorLegacyDefinition, extendTopologyBoundary, startTopologyBoundaryRing, deleteTopologyBoundaryRing,
  changeTopologyStarts, setTopologyRootAtVertex, selectTopologyBoundaryOccurrence, addSelectedTopologySeam,
  removeTopologySeam, topologySetupResult, topologyEditorRootsByCoordinate } from '../src/topology-setup.js';
import { layoutBoardEditor, hitTestBoardEditor, renderBoardEditor } from '../src/board-editor-ui.js';

function rectangle(setup, x, y, w, h) {
  for (const point of [[x,y], [x+w,y], [x+w,y+h], [x,y+h]]) {
    const result = extendTopologyBoundary(setup, point); assert.equal(result.ok, true, JSON.stringify(result.errors)); setup = result.setup;
  }
  const result = extendTopologyBoundary(setup, [x,y], { close: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.setup;
}

test('multiple contours preserve prior board until closure and warn on lost roots', () => {
  let setup = rectangle(createTopologySetup(), 0, 0, 6, 6);
  setup = changeTopologyStarts(setup, { mode: 'default', playerCount: 2 }).setup;
  const before = setup.boardHash, roots = topologyEditorRootsByCoordinate(setup);
  setup.requiredPlayers = ['BLACK', 'WHITE'];
  setup = startTopologyBoundaryRing(setup).setup;
  assert.equal(topologySetupResult(setup).ok, false);
  setup = rectangle(setup, 2, 2, 2, 2);
  assert.equal(setup.draft.rings.length, 2);
  assert.deepEqual(topologyEditorRootsByCoordinate(setup), roots);
  assert.notEqual(setup.boardHash, before);
  setup = deleteTopologyBoundaryRing(setup, 0).setup;
  assert.ok(setup.warnings.some(e => e.code === 'REMOVED_ROOT'));
  assert.equal(topologySetupResult(setup).errors[0].code, 'MISSING_START_ROOT');
});

test('ordinary board adapters retain exact shape coordinates and multi-root ownership', () => {
  for (const boardShape of ['triangle', 'hexagon', 'diamond']) {
    const roots = { BLACK: [[0, 4], [1, 3]], WHITE: [[4, 0]] };
    const definition = createTopologyEditorLegacyDefinition({ gridSize: 5, boardShape, playerCount: 2, initialRoots: roots });
    const expected = getBoardPositions(5, 2, boardShape).map(c => c.join(',')).sort();
    assert.deepEqual(definition.vertices.map(v => v.coordinate.join(',')).sort(), expected);
    const setup = createTopologySetup({ definition });
    assert.equal(setup.geometryChanged, false);
    assert.deepEqual(topologyEditorRootsByCoordinate(setup), roots);
  }
});

test('deleting a contour reports invalidated seams and supports separate islands', () => {
  let setup = rectangle(createTopologySetup(), 0, 0, 4, 4);
  setup = startTopologyBoundaryRing(setup).setup;
  setup = rectangle(setup, 6, 0, 3, 3);
  const firstRingEdge = setup.draft.boundaryOccurrenceIds.filter(id => id.includes('0,')).slice(0, 2);
  assert.equal(firstRingEdge.length, 2);
  for (const id of firstRingEdge) setup = selectTopologyBoundaryOccurrence(setup, id).setup;
  const joined = addSelectedTopologySeam(setup);
  assert.equal(joined.ok, true, JSON.stringify(joined.errors));
  const removed = deleteTopologyBoundaryRing(joined.setup, 0);
  assert.equal(removed.ok, true, JSON.stringify(removed.errors));
  assert.ok(removed.setup.warnings.some(e => e.code === 'REMOVED_SEAM'));
  assert.equal(removed.setup.draft.rings.length, 1);
});

test('invalid contour retains valid configuration; removal and root changes use canonical IDs', () => {
  let setup = rectangle(createTopologySetup(), 0, 0, 5, 5);
  setup = changeTopologyStarts(setup, { mode: 'default', playerCount: 2 }).setup;
  const hash = setup.boardHash;
  setup = startTopologyBoundaryRing(setup).setup;
  const bad = extendTopologyBoundary(setup, [1, 1]);
  const invalid = extendTopologyBoundary(bad.setup, [3, 2]);
  assert.equal(invalid.ok, false); assert.equal(invalid.setup.boardHash, hash);
  assert.deepEqual(invalid.setup.draft.path, [[1,1]]);
  setup = createTopologySetup({ definition: setup.definition });
  let roots = topologyStartingRoots(setup.compiled);
  assert.equal(setTopologyRootAtVertex(setup, 'BLACK', roots.BLACK[0]).errors[0].code, 'LAST_START_ROOT');
  assert.equal(setTopologyRootAtVertex(setup, 'BLACK', roots.WHITE[0]).errors[0].code, 'DUPLICATE_START_VERTEX');
  const free = setup.compiled.sampleIds.find(id => !Object.values(roots).flat().includes(id));
  setup = setTopologyRootAtVertex(setup, 'BLACK', free).setup;
  assert.equal(topologyStartingRoots(setup.compiled).BLACK.length, 2);
  setup = setTopologyRootAtVertex(setup, 'BLACK', free).setup;
  assert.equal(topologyStartingRoots(setup.compiled).BLACK.length, 1);
  setup = setTopologyRootAtVertex(setup, 'BLACK', free, { moveFrom: roots.BLACK[0] }).setup;
  assert.deepEqual(topologyStartingRoots(setup.compiled).BLACK, [free]);
  assert.equal(setup.geometryChanged, false);
  assert.equal(topologyEditorRootsByCoordinate(setup).BLACK.length, 1);
});

test('loaded shape supports chart hits, seam selection and graphical removal without native structuredClone', () => {
  const original = globalThis.structuredClone; globalThis.structuredClone = undefined;
  try {
    let setup = createTopologySetup({ definition: createLegacyBoardDefinition({ gridSize: 5, boardShape: 'hexagon' }) });
    setup = changeTopologyStarts(setup, { mode: 'default', playerCount: 2 }).setup;
    assert.ok(setup.draft.rings.length);
    const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, stroke(){}, arc(){}, fill(){} };
    let layout = renderBoardEditor(ctx, { x: 0, y: 0, width: 400, height: 400 }, setup, {gridSize: 9});
    const p = layout.points.find(point => point.owner === 'BLACK');
    assert.equal(hitTestBoardEditor(layout, p.x, p.y, 'root').vertexId, p.vertexId);
    const edge = layout.edges[0], mx = (edge.a.x + edge.b.x)/2, my = (edge.a.y + edge.b.y)/2;
    assert.equal(hitTestBoardEditor(layout, mx, my, 'seam').occurrenceId, edge.id);
    for (const e of layout.edges.slice(0, 2)) setup = selectTopologyBoundaryOccurrence(setup, e.id).setup;
    const joined = addSelectedTopologySeam(setup); assert.equal(joined.ok, true, JSON.stringify(joined.errors)); setup = joined.setup;
    layout = layoutBoardEditor(setup, { x: 0, y: 0, width: 400, height: 400 }, {gridSize:9});
    const se = layout.seams[0].edges[0];
    const hit = hitTestBoardEditor(layout, (se.a.x+se.b.x)/2, (se.a.y+se.b.y)/2, 'seam');
    assert.equal(hit.type, 'seam');
    assert.equal(removeTopologySeam(setup, hit.seamId).ok, true);
  } finally { globalThis.structuredClone = original; }
});
