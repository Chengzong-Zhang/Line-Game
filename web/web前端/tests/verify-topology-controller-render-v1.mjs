import assert from "node:assert/strict";

// GameEngine deliberately has no static dependency on its topology sibling so
// legacy data-URL regression harnesses remain self-contained.  Register the
// product factory before constructing a quotient-board match in this test.
await import("../TopologyGameEngine.js");
// Renderer obtains the atlas projector from the startup-installed runtime.
// Load that sibling explicitly here, just as the product bootstrap must.
await import("../BoardView.js");

const [{ default: GameEngine, PointState }, { Renderer }, { GameController }, presets, fixtures] = await Promise.all([
  import("../GameEngine.js"),
  import("../Renderer.js"),
  import("../GameController.js"),
  import("../BoardPresets.js"),
  import("./fixtures/board-topology-v1-fixtures.mjs"),
]);

const { createMobiusBoardDefinition } = presets;
const { CONCAVE_GAP_DEFINITION } = fixtures;

/*
 * Integration contract introduced by this test
 * --------------------------------------------
 * Renderer.render(snapshot) must branch on snapshot.isTopologyBoard before
 * invoking the triangle/hexagon layout/data collectors.  After a topology
 * render it must expose:
 *
 *   getTopologyHitVertexId(x, y) -> canonical vertex id | null
 *
 * and the existing getPointPixelCoordinates(canonicalVertexId) must work for
 * the current topology snapshot.  GameController._findNearestGridPoint must
 * use that hit path for a topology engine and return the canonical string,
 * not attempt to clone it as a coordinate pair.  These deliberately small
 * APIs keep the DOM-facing controller independent of the atlas internals.
 */

function createRecordingContext(operations) {
  const state = { strokeStyle: "", fillStyle: "", lineWidth: 1, currentPoint: null };
  const record = (name, ...args) => operations.push({
    name,
    args,
    strokeStyle: state.strokeStyle,
    fillStyle: state.fillStyle,
    lineWidth: state.lineWidth,
  });
  const target = {
    beginPath() { state.currentPoint = null; record("beginPath"); },
    closePath() { record("closePath"); },
    moveTo(x, y) { state.currentPoint = [x, y]; record("moveTo", x, y); },
    lineTo(x, y) {
      const from = state.currentPoint;
      state.currentPoint = [x, y];
      record("lineTo", x, y, from);
    },
    arc(...args) { record("arc", ...args); },
    fill() { record("fill"); },
    stroke() { record("stroke"); },
    clearRect(...args) { record("clearRect", ...args); },
    fillRect(...args) { record("fillRect", ...args); },
    save() { record("save"); },
    restore() { record("restore"); },
    setTransform(...args) { record("setTransform", ...args); },
    setLineDash(...args) { record("setLineDash", ...args); },
    fillText(...args) { record("fillText", ...args); },
    measureText() { return { width: 0 }; },
  };
  return new Proxy(target, {
    get(value, property) {
      if (property in value) return value[property];
      return (...args) => record(String(property), ...args);
    },
    set(_value, property, value) {
      if (property === "strokeStyle" || property === "fillStyle" || property === "lineWidth") {
        state[property] = value;
      }
      return true;
    },
  });
}

function makeTopologyRenderer(operations) {
  const context = createRecordingContext(operations);
  const theme = new Proxy({
    background: "BACKGROUND",
    boardFill: "BOARD_FILL",
    boardStroke: "BOARD_STROKE",
    guideLine: "GUIDE",
    guidePoint: "GUIDE_POINT",
    outline: "OUTLINE",
    blueNode: "BLUE_NODE",
    blueLine: "TOPOLOGY_BLACK_PATH",
    blueTerritoryFill: "BLUE_TERRITORY_FILL",
    blueTerritoryStroke: "BLUE_TERRITORY_STROKE",
    redNode: "RED_NODE",
    redLine: "RED_LINE",
    redTerritoryFill: "RED_TERRITORY_FILL",
    redTerritoryStroke: "RED_TERRITORY_STROKE",
    legalMoveFill: "LEGAL_FILL",
    legalMoveStroke: "LEGAL_STROKE",
  }, { get: (value, property) => value[property] ?? "STYLE_" + String(property) });
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    canvas: { width: 800, height: 600 },
    ctx: context,
    theme,
    minCssWidth: 220,
    minCssHeight: 180,
    defaultCssWidth: 800,
    defaultCssHeight: 600,
    paddingRatio: 0.025,
    topInset: 0,
    _lastMeasuredWidth: 800,
    _lastMeasuredHeight: 600,
    _lastMeasuredDpr: 1,
    _staticCtx: null,
    _hintCtx: null,
    _staticLayerKey: "",
    _lastRenderFingerprint: "",
    _renderCaches: new Map(),
    _territoryPaths: new Map(),
    _boardPaths: new Map(),
    _pendingRafHandle: null,
    cacheBoardPaths: false,
    cacheTerritoryPaths: false,
    hintPoint: null,
    layout: null,
    lastSnapshot: null,
  });
  return renderer;
}

// Keep the legacy assertion independent from the topology branch: a normal
// triangle still uses the established coordinate layout and coordinate input.
const legacyEngine = new GameEngine({ gridSize: 5, playerCount: 2 });
const legacyRenderer = makeTopologyRenderer([]);
const legacyLayout = legacyRenderer._computeLayout(legacyEngine.getSnapshot());
// _computeLayout is intentionally pure; install the returned layout just as
// render() would before using the public coordinate conversion helper.
legacyRenderer.layout = legacyLayout;
assert.equal(legacyLayout.boardShape, "triangle");
assert.deepEqual(legacyRenderer.getPointPixelCoordinates([0, 0]), {
  x: legacyRenderer._gridToPixel(0, 0, legacyLayout)[0],
  y: legacyRenderer._gridToPixel(0, 0, legacyLayout)[1],
});

assert.equal(typeof Renderer.prototype.getTopologyHitVertexId, "function",
  "Topology renderer integration is missing: implement getTopologyHitVertexId(x, y) after render(snapshot).");

const concaveEngine = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
const concaveSnapshot = concaveEngine.getSnapshot();
const concaveOperations = [];
const concaveRenderer = makeTopologyRenderer(concaveOperations);
let legacyLayoutCalls = 0;
for (const name of ["_computeLayout", "_collectBoardData", "_getValidPoints"]) {
  concaveRenderer[name] = () => {
    legacyLayoutCalls += 1;
    throw new Error("LEGACY_LAYOUT_CALLED_FOR_TOPOLOGY:" + name);
  };
}
concaveRenderer.render(concaveSnapshot, { _immediate: true, skipResize: true, force: true });
assert.equal(legacyLayoutCalls, 0, "A topology snapshot must not enter the triangle/hexagon layout path.");

const concaveVertexId = concaveSnapshot.topology.pointCopies[0].canonicalVertexId;
const concavePixel = concaveRenderer.getPointPixelCoordinates(concaveVertexId);
assert.equal(concaveRenderer.getTopologyHitVertexId(concavePixel.x, concavePixel.y), concaveVertexId,
  "A topology hit must return the canonical vertex identity, not an atlas coordinate/copy.");
assert.equal(concaveRenderer.getTopologyHitVertexId(-10_000, -10_000), null,
  "A click outside a topology board must be rejected rather than snapping to a legal point.");

// Selecting a quotient vertex highlights all of its atlas copies without
// inventing any seam-spanning rule edges.
const inspectEngine = new GameEngine({ boardDefinition: createMobiusBoardDefinition({ gridSize: 5 }) });
const inspectSnapshot = inspectEngine.getSnapshot();
const inspectMultiplicities = new Map();
for (const copy of inspectSnapshot.topology.pointCopies) inspectMultiplicities.set(copy.canonicalVertexId, (inspectMultiplicities.get(copy.canonicalVertexId) ?? 0) + 1);
const inspectId = [...inspectMultiplicities].find(([, count]) => count > 1)?.[0];
assert.ok(inspectId);
const inspectOps = [];
const inspectRenderer = makeTopologyRenderer(inspectOps);
inspectRenderer.render({ ...inspectSnapshot, inspectionOverlay: { selectedPoint: inspectId } }, { _immediate: true, skipResize: true, force: true });
const selectedStrokes = inspectOps.filter(op => op.name === 'stroke' && op.strokeStyle === 'rgba(218, 151, 36, 0.98)');
assert.equal(selectedStrokes.length, inspectMultiplicities.get(inspectId), 'every canonical copy receives a selection ring');
const selectionLines = inspectOps.filter(op => op.name === 'lineTo' && op.strokeStyle === 'rgba(218, 151, 36, 0.98)');
assert.equal(selectionLines.length, 0, 'selection adds no connecting line');

const concaveController = Object.assign(Object.create(GameController.prototype), {
  engine: concaveEngine,
  options: { engine: {} },
  _validGridPoints: concaveEngine.getValidPositions(),
  renderer: concaveRenderer,
});
assert.equal(concaveController._findNearestGridPoint(concavePixel.x, concavePixel.y), concaveVertexId,
  "Controller hit testing must retain the canonical topology vertex ID.");
assert.equal(concaveController._findNearestGridPoint(-10_000, -10_000), null,
  "Controller must not turn an off-board topology click into a move.");

// A canonical ID must survive the actual controller-to-engine handoff, not
// only the hit-test helper.  This deliberately uses the real topology engine;
// legacy controllers used clonePoint(point), which turns "cv:12" into an
// invalid coordinate pair.
const actionEngine = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
const actionVertexId = actionEngine.getLegalMoves()[0].vertexId;
const actionFeedback = [];
const actionController = Object.assign(Object.create(GameController.prototype), {
  engine: actionEngine,
  _setLastAction(action) { this.lastAction = action; },
  _syncSnapshot() {},
  _emitActionFeedback(feedback) { actionFeedback.push(feedback); },
  _buildGameState(snapshot) { return snapshot; },
});
const actionResult = actionController._applyMove(actionVertexId, actionEngine.getCurrentPlayer());
assert.equal(actionResult.success, true, "Controller must forward a canonical topology ID unchanged to GameEngine.");
assert.equal(actionResult.point, actionVertexId);
assert.equal(actionController.lastAction.point, actionVertexId);
assert.equal(actionFeedback.at(-1).point, actionVertexId);

// Browser canvases are often displayed at a CSS size different from the
// renderer's logical canvas size.  Exercise the actual controller pointer
// route for every initial legal move through such a scaled DOM rectangle.  A
// correct atlas marker must round-trip to the same canonical vertex ID rather
// than become a nearby coordinate or a missed click.
const scaledRect = { left: 120, top: 80, width: 400, height: 300 };
for (const expectedVertexId of concaveEngine.getLegalMoves().map((move) => move.vertexId)) {
  const scaledEngine = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
  const scaledRenderer = makeTopologyRenderer([]);
  scaledRenderer.render(scaledEngine.getSnapshot(), { _immediate: true, skipResize: true, force: true });
  const marker = scaledRenderer.getPointPixelCoordinates(expectedVertexId);
  const feedback = [];
  const scaledController = Object.assign(Object.create(GameController.prototype), {
    engine: scaledEngine,
    renderer: scaledRenderer,
    canvas: {
      getBoundingClientRect: () => scaledRect,
      style: {},
      setAttribute() {},
    },
    multiplayerEnabled: false,
    readOnlyMode: false,
    _setLastAction(action) { this.lastAction = action; },
    _syncSnapshot() {},
    _emitActionFeedback(entry) { feedback.push(entry); },
    _buildGameState(snapshot) { return snapshot; },
  });
  const result = scaledController._processPointer(
    scaledRect.left + marker.x * scaledRect.width / scaledRenderer.layout.cssWidth,
    scaledRect.top + marker.y * scaledRect.height / scaledRenderer.layout.cssHeight,
  );
  assert.equal(result.success, true, `CSS-scaled click must accept legal topology marker ${expectedVertexId}.`);
  assert.equal(result.point, expectedVertexId);
  assert.equal(scaledController.lastAction.point, expectedVertexId);
  assert.equal(feedback.at(-1).point, expectedVertexId);
}

// The topology used here is a real Mobius preset.  The path display metadata
// supplies two chart segments separated by a seam; a renderer must never draw
// the artificial atlas chord between copy:left:b and copy:right:c.
const mobiusEngine = new GameEngine({ boardDefinition: createMobiusBoardDefinition() });
const mobiusSnapshot = mobiusEngine.getSnapshot();
const seamSnapshot = {
  ...mobiusSnapshot,
  topology: {
    ...mobiusSnapshot.topology,
    // The renderer consumes the frozen atlas under viewBoard; retain a tiny
    // synthetic chart so the seam chord assertion is geometrically obvious.
    viewBoard: {
      pointCopies: [
        { id: "copy:left:a", canonicalVertexId: "cv:5", coordinate: [0, 0], chartId: "left" },
        { id: "copy:left:b", canonicalVertexId: "cv:0", coordinate: [1, 0], chartId: "left" },
        { id: "copy:right:c", canonicalVertexId: "cv:4", coordinate: [100, 0], chartId: "right" },
        { id: "copy:right:d", canonicalVertexId: "cv:15", coordinate: [101, 0], chartId: "right" },
      ],
      realBoundarySegments: [],
      seamPairs: [{ id: "mobius-seam", copyIds: ["copy:left:b", "copy:right:c"] }],
      displayEdges: [],
    },
  },
  boardStates: {
    ...mobiusSnapshot.boardStates,
    "cv:5": PointState.BLACK_NODE,
    "cv:0": PointState.BLACK_LINE,
    "cv:4": PointState.BLACK_LINE,
    "cv:15": PointState.BLACK_NODE,
  },
  topologyPaths: {
    ...mobiusSnapshot.topologyPaths,
    BLACK: [{
      pathId: "path:mobius-seam-projection",
      vertices: ["cv:5", "cv:0", "cv:4", "cv:15"],
      copyIds: ["copy:left:a", "copy:left:b", "copy:right:c", "copy:right:d"],
      edgeOccurrences: [],
      seamCrossings: [{
        id: "mobius-seam",
        afterVertexIndex: 1,
        exitCopyId: "copy:left:b",
        entryCopyId: "copy:right:c",
      }],
    }],
  },
};
const seamOperations = [];
const seamRenderer = makeTopologyRenderer(seamOperations);
for (const name of ["_computeLayout", "_collectBoardData", "_getValidPoints"]) {
  seamRenderer[name] = () => {
    throw new Error("LEGACY_LAYOUT_CALLED_FOR_TOPOLOGY:" + name);
  };
}
seamRenderer.render(seamSnapshot, { _immediate: true, skipResize: true, force: true });

const topologyPathSegments = seamOperations
  .filter((operation) => operation.name === "lineTo" && operation.strokeStyle === "TOPOLOGY_BLACK_PATH")
  .map((operation) => ({ from: operation.args[2], to: operation.args.slice(0, 2) }));
assert.ok(topologyPathSegments.length >= 2,
  "A cross-seam logical path must render its two chart-local segments.");
for (const segment of topologyPathSegments) {
  assert.ok(segment.from, "A path segment must begin with moveTo rather than inheriting another drawing path.");
  assert.ok(Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1])
    < Math.max(32, seamRenderer.layout.scale * 2.5),
  "A seam crossing must not become one long atlas chord.");
}

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "legacy triangle layout remains coordinate-based",
    "concave topology bypasses legacy layout",
    "canonical topology hit and off-board rejection",
    "controller retains canonical vertex IDs",
    "CSS-scaled canvas pointer retains canonical topology IDs",
    "Mobius seam path is chart-segmented without a long chord",
  ],
}));

// The two-pane display changes only the atlas projection and hit testing.
const { generateBoard } = await import('../RandomBoard.js');
const doubleBoard = generateBoard({ gridSize: 7, playerCount: 2 }, 'chart-7', 'random-board-v4');
assert.equal(doubleBoard.definition.generator.category, 'double-torus');
const doubleEngine = new GameEngine({ boardDefinition: doubleBoard.definition, playerCount: 2 });
const doubleSnapshot = doubleEngine.getSnapshot();
const doubleState = JSON.stringify(doubleEngine.encodeTopologyState());
const chartRenderer = makeTopologyRenderer([]);
chartRenderer.render(doubleSnapshot, { _immediate: true, skipResize: true, force: true });
const allCopies = chartRenderer._getTopologyProjection(doubleSnapshot, chartRenderer.layout).projected.pointCopies;
assert.ok(allCopies.some(c => c.sourceVertexId.startsWith('back:')) && allCopies.some(c => !c.sourceVertexId.startsWith('back:')));
for (const chart of ['front', 'back', 'front']) {
  chartRenderer.setTopologyChart(chart);
  const projection = chartRenderer._getTopologyProjection(doubleSnapshot, chartRenderer.layout);
  assert.ok(projection.projected.pointCopies.length > 0);
  assert.ok(projection.projected.pointCopies.every(c => c.sourceVertexId.startsWith('back:') === (chart === 'back')));
  const point = projection.projected.pointCopies.find(c => projection.projected.pointCopies.filter(other => Math.hypot(c.x-other.x,c.y-other.y) < 1).length === 1);
  assert.equal(chartRenderer.getTopologyHitVertexId(point.x, point.y), point.canonicalVertexId);
}
chartRenderer.setTopologyChart('both');
assert.equal(chartRenderer._getTopologyProjection(doubleSnapshot, chartRenderer.layout).projected.pointCopies.length, allCopies.length);
assert.equal(JSON.stringify(doubleEngine.encodeTopologyState()), doubleState, 'switching panes never changes game rules or position');

// Real moves create local paths, including a seam-crossing opportunity. Both
// panes must remain drawable after repeated state changes and keep every hit canonical.
for (let step = 0; step < 8; step++) {
  const choices = doubleEngine.getLegalMoves();
  if (!choices.length) break;
  assert.equal(doubleEngine.playMove(choices[Math.floor(choices.length / 2)].vertexId).success, true);
}
const movedDoubleSnapshot = doubleEngine.getSnapshot();
const movedState = JSON.stringify(doubleEngine.encodeTopologyState());
chartRenderer.render(movedDoubleSnapshot, { _immediate: true, skipResize: true, force: true });
for (const chart of ['front', 'back', 'both', 'front']) {
  chartRenderer.setTopologyChart(chart);
  const projection = chartRenderer._getTopologyProjection(movedDoubleSnapshot, chartRenderer.layout);
  for (const paths of Object.values(movedDoubleSnapshot.topologyPaths)) for (const path of paths) {
    const segments = projection.runtime.projectPath(projection.viewBoard, path, { scale: chartRenderer.layout.scale, offset: [chartRenderer.layout.offsetX, chartRenderer.layout.offsetY] });
    const visible = segments.filter(segment => segment.copyIds.every(id => projection.visibleCopyIds.has(id)));
    assert.ok(visible.every(segment => segment.copyIds.every(id => projection.byCopyId.has(id))), 'visible path endpoints belong to the selected pane');
  }
}
assert.equal(JSON.stringify(doubleEngine.encodeTopologyState()), movedState);
console.log('PASS double-torus chart switching, canonical hits, visible paths and immutable state');

// A random sphere is also an explicitly mapped front/back atlas; the older
// one-piece sphere preset must keep its original layout and remain unsliced.
const { createDoubleSphereBoardDefinition } = await import('../RandomSurfaceBoard.js');
const doubledSphere = new GameEngine({ boardDefinition: createDoubleSphereBoardDefinition({ gridSize: 7 }), playerCount: 2 });
const sphereSnapshot = doubledSphere.getSnapshot();
const sphereState = JSON.stringify(doubledSphere.encodeTopologyState());
const sphereRenderer = makeTopologyRenderer([]);
sphereRenderer.render(sphereSnapshot, { _immediate: true, skipResize: true, force: true });
const wholeSphere = sphereRenderer._getTopologyProjection(sphereSnapshot, sphereRenderer.layout).projected.pointCopies.length;
for (const chart of ['front', 'back', 'front', 'both']) {
  sphereRenderer.setTopologyChart(chart);
  const projection = sphereRenderer._getTopologyProjection(sphereSnapshot, sphereRenderer.layout);
  assert.ok(projection.projected.pointCopies.length > 0);
  if (chart !== 'both') {
    assert.ok(projection.projected.pointCopies.every(c => c.sourceVertexId.startsWith('back:') === (chart === 'back')));
    const point = projection.projected.pointCopies[0];
    assert.equal(sphereRenderer.getTopologyHitVertexId(point.x, point.y), point.canonicalVertexId);
  } else assert.equal(projection.projected.pointCopies.length, wholeSphere);
}
assert.equal(JSON.stringify(doubledSphere.encodeTopologyState()), sphereState);
const oldSphere = new GameEngine({ boardDefinition: presets.createSurfacePreset('sphere', { gridSize: 7 }), playerCount: 2 }).getSnapshot();
sphereRenderer.setTopologyChart('front');
sphereRenderer.render(oldSphere, { _immediate: true, skipResize: true, force: true });
assert.equal(sphereRenderer._getTopologyProjection(oldSphere, sphereRenderer.layout).chart, 'both');
console.log('PASS double-sphere chart switching and canonical hits; legacy sphere unchanged');
