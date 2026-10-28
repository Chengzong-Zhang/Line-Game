import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameEngine,
  TopologyRulesVersion,
  createCylinderBoardDefinition,
} from '../src/core.js';
import {
  drawTopologyBoard,
  hitTopologyVertex,
  layoutTopologyBoard,
  layoutTopologyDraft,
  hitTopologyDraftPoint,
  drawTopologyDraft,
} from '../src/topology-board.js';
import {
  addSelectedTopologySeam,
  addTopologyBoundaryVertex,
  closeTopologyBoundary,
  createTopologySetup,
  generateTopologyBoard,
  selectTopologyBoundaryOccurrence,
  toggleTopologySeamDirection,
  topologySetupResult,
  undoTopologyBoundary,
} from '../src/topology-setup.js';

function canvasRecorder() {
  const operations = [];
  return {
    operations,
    beginPath() { operations.push(['beginPath']); },
    moveTo(x, y) { operations.push(['moveTo', x, y]); },
    lineTo(x, y) { operations.push(['lineTo', x, y]); },
    arc(x, y, radius) { operations.push(['arc', x, y, radius]); },
    closePath() { operations.push(['closePath']); },
    fill() { operations.push(['fill', this.fillStyle]); },
    stroke() { operations.push(['stroke', this.strokeStyle]); },
    save() { operations.push(['save']); },
    restore() { operations.push(['restore']); },
    setLineDash(value) { operations.push(['dash', [...value]]); },
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  };
}

function closedLSetup() {
  // This is an axial-grid L shape: every consecutive pair, including the
  // closing pair, is a unit triangular-lattice edge.
  const boundary = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 1]];
  let setup = createTopologySetup();
  for (const coordinate of boundary) {
    const added = addTopologyBoundaryVertex(setup, coordinate);
    assert.equal(added.ok, true, JSON.stringify(added.errors));
    setup = added.setup;
  }
  const closed = closeTopologyBoundary(setup);
  assert.equal(closed.ok, true, JSON.stringify(closed.errors));
  return closed.setup;
}

test('topology Canvas hit testing returns the canonical vertex ID, never a chart-copy ID', () => {
  const engine = new GameEngine({
    boardDefinition: createCylinderBoardDefinition({ width: 4, height: 4 }),
    rulesVersion: TopologyRulesVersion.SURFACE_V1,
    playerCount: 2,
  });
  const snapshot = engine.getSnapshot();
  const layout = layoutTopologyBoard(snapshot, { x: 0, y: 0, width: 420, height: 300 });
  const copy = layout.projected.pointCopies[0];
  const hit = hitTopologyVertex(copy.x, copy.y, layout);
  assert.equal(hit, copy.canonicalVertexId);
  assert.notEqual(hit, copy.id);
  assert.notEqual(hit, copy.sourceVertexId);
  assert.equal(hitTopologyVertex(-100, -100, layout), null);
});

test('topology Canvas draws guides, territory, paths, real boundaries, seams and canonical nodes', () => {
  const engine = new GameEngine({
    boardDefinition: createCylinderBoardDefinition({ width: 4, height: 4 }),
    rulesVersion: TopologyRulesVersion.SURFACE_V1,
    playerCount: 2,
  });
  const snapshot = engine.getSnapshot();
  const [first, second] = snapshot.topology.canonicalVertices.map((vertex) => vertex.id);
  snapshot.territories.BLACK.renderPoints = [first];
  snapshot.boardStates = { [first]: 1 };
  snapshot.legalMoves = [{ vertexId: second }];
  snapshot.topologyPaths = { BLACK: [{ pathId: 'fixture:path', vertices: [first, second], seamCrossings: [] }] };
  const layout = layoutTopologyBoard(snapshot, { x: 0, y: 0, width: 420, height: 300 });
  const ctx = canvasRecorder();
  drawTopologyBoard(ctx, snapshot, layout, { selected: first, hint: second, lastMove: first });
  const strokeColors = ctx.operations.filter(([kind]) => kind === 'stroke').map(([, color]) => color);
  const fillColors = ctx.operations.filter(([kind]) => kind === 'fill').map(([, color]) => color);
  assert.ok(strokeColors.includes('#d8cfbd'), 'guide edges');
  assert.ok(strokeColors.includes('#9f6946'), 'real boundary');
  assert.ok(strokeColors.includes('#8a5a9b'), 'seam arrows');
  assert.ok(strokeColors.includes('#3578d4'), 'logical paths');
  assert.ok(fillColors.includes('#3578d4'), 'territory/node paint');
  assert.ok(ctx.operations.some(([kind]) => kind === 'arc'), 'nodes and affordance rings');
});

test('draft setup closes a lattice L boundary, chooses seams in both directions, and rejects reused edges', () => {
  let setup = closedLSetup();
  assert.ok(setup.draft.boundaryOccurrenceIds.length >= 3);
  const [left, right] = setup.draft.boundaryOccurrenceIds.slice(1, 3);
  setup = selectTopologyBoundaryOccurrence(setup, left).setup;
  setup = selectTopologyBoundaryOccurrence(setup, right).setup;
  const forward = addSelectedTopologySeam(setup);
  assert.equal(forward.ok, true, JSON.stringify(forward.errors));
  assert.deepEqual(forward.setup.draft.seamPairs[0].endpointMap, [0, 1]);
  let reverseSetup = closedLSetup();
  reverseSetup = selectTopologyBoundaryOccurrence(reverseSetup, left).setup;
  reverseSetup = selectTopologyBoundaryOccurrence(reverseSetup, right).setup;
  reverseSetup = toggleTopologySeamDirection(reverseSetup);
  const reverse = addSelectedTopologySeam(reverseSetup);
  assert.equal(reverse.ok, true, JSON.stringify(reverse.errors));
  assert.deepEqual(reverse.setup.draft.seamPairs[0].endpointMap, [1, 0]);
  // A glued occurrence is no longer a real boundary occurrence, so it cannot
  // be selected for a second seam in the first place.
  const rejected = selectTopologyBoundaryOccurrence(forward.setup, left);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors[0].code, 'INVALID_BOUNDARY_OCCURRENCE');
});

test('random setup is deterministic and draft Canvas helpers stay coordinate-only', () => {
  const options = { width: 7, height: 6, playerCount: 2, minimumChannelWidth: 2, maxAttempts: 24 };
  const first = generateTopologyBoard(createTopologySetup(), options, 'wx-topology-fixture');
  const second = generateTopologyBoard(createTopologySetup(), options, 'wx-topology-fixture');
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.equal(topologySetupResult(first.setup).boardHash, topologySetupResult(second.setup).boardHash);
  let draftSetup = createTopologySetup();
  draftSetup = addTopologyBoundaryVertex(draftSetup, [0, 0]).setup;
  draftSetup = addTopologyBoundaryVertex(draftSetup, [1, 0]).setup;
  const undone = undoTopologyBoundary(draftSetup);
  assert.equal(undone.ok, true);
  const layout = layoutTopologyDraft({ path: [[0, 0], [1, 0], [1, 1]], closed: false }, { x: 0, y: 0, width: 240, height: 180 });
  const hit = hitTopologyDraftPoint(layout.points[1].x, layout.points[1].y, layout);
  assert.deepEqual(hit.coordinate, [1, 0]);
  const ctx = canvasRecorder();
  drawTopologyDraft(ctx, { path: [[0, 0], [1, 0], [1, 1]], closed: false }, layout, { selectedIndex: 1 });
  assert.ok(ctx.operations.some(([kind]) => kind === 'arc'));
});

test('invalid atlas input fails before rendering instead of deriving a rule from pixels', () => {
  assert.throws(() => layoutTopologyBoard({ topology: { viewBoard: { pointCopies: [{ canonicalVertexId: 'cv:1' }] } } },
    { x: 0, y: 0, width: 100, height: 100 }), /coordinate/);
});
