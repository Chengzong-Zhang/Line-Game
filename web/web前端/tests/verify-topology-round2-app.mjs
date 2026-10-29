import assert from 'node:assert/strict';
await import('../TopologyGameEngine.js');
const noop = () => {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.location = new URL('http://localhost:8876/');
globalThis.document = { body: { classList: { add: noop, remove: noop, toggle: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.Vue = { ref: value => ({ value }), shallowRef: value => ({ value }), computed: read => ({ get value() { return read(); } }), watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: noop };
globalThis.Worker = class { postMessage() {} terminate() {} };
const { default: App } = await import('../OnlineApp.js');
const app = App.setup();
app.tutorialActive.value = false;
app.handleBoardShapeChange('custom');
assert.equal(app.selectedBoardShape.value, 'custom');
assert.ok(app.selectedTopologyDefinition.value);
const previousHash = app.selectedTopologyHash.value;
app.handleGridSizeChange(5);
assert.equal(app.selectedGridSize.value, 5);
assert.notEqual(app.selectedTopologyHash.value, previousHash);
assert.equal(Math.max(...app.selectedTopologyDefinition.value.vertices.map(v => v.coordinate[0])), 4);
const board = (await import('../BoardCompiler.js')).compileBoard(app.selectedTopologyDefinition.value).value;
const newBlack = board.sampleIds.find(id => !Object.values(board.startingVertices).includes(id));
app.updateTopologyStarts({ mode: 'custom', roots: { BLACK: [board.startingVertices.BLACK, newBlack], WHITE: [board.startingVertices.WHITE] } });
const multiHash = app.selectedTopologyHash.value;
const multi = (await import('../BoardCompiler.js')).compileBoard(app.selectedTopologyDefinition.value).value;
assert.equal(multi.startingRoots.BLACK.length, 2);
app.updateTopologyStarts({ mode: 'default' });
assert.notEqual(app.selectedTopologyHash.value, multiHash);
assert.equal((await import('../BoardCompiler.js')).compileBoard(app.selectedTopologyDefinition.value).value.startingRoots.BLACK.length, 1);
app.selectTopologyPreset('tetrahedron');
const tetra = (await import('../BoardCompiler.js')).compileBoard(app.selectedTopologyDefinition.value).value;
const tetraSpare = tetra.sampleIds.find(id => !Object.values(tetra.startingVertices).includes(id));
app.updateTopologyStarts({ mode: 'custom', roots: { BLACK: [tetra.startingVertices.BLACK, tetraSpare], WHITE: [tetra.startingVertices.WHITE] } });
app.handleGridSizeChange(15);
assert.equal(app.selectedTopologyDefinition.value.topology.preset, 'tetrahedron');
assert.equal((await import('../BoardCompiler.js')).compileBoard(app.selectedTopologyDefinition.value).value.startingRoots.BLACK.length, 1, 'resizing restores clearly announced default starts');
app.handleBoardShapeChange('triangle');
app.handleGridSizeChange(9);
app.handleBoardShapeChange('custom');
assert.equal(Math.max(...app.selectedTopologyDefinition.value.vertices.map(v => v.coordinate[0])), 8);
console.log('verify-topology-round2-app: PASS (actual setup handlers, size identity, multi-root and defaults)');

// Drive the graphic editor through the application's real event handlers:
// close an outer contour and a second inner contour by clicking each start.
const { TopologyGraphicEditor, latticePoint, editorBoundaryEdges } = await import('../TopologyGraphicEditor.js');
app.handleGridSizeChange(5);
const editorProps = { draft: app.topologyDraft.value, language: 'en', gridSize: 5, disabled: false };
const events = [];
const editor = TopologyGraphicEditor.setup(editorProps, { emit(type, payload) {
  events.push(type);
  if (type === 'vertex') app.addTopologyDraftVertex(payload);
  if (type === 'close') app.closeTopologyDraft();
  editorProps.draft = app.topologyDraft.value;
} });
const click = (coordinate) => {
  const [x, y] = latticePoint(coordinate, 5);
  editor.pointer({ type: 'pointerdown', clientX: x, clientY: y, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 300 }) } });
};
for (const vertex of [[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],[0,2],[0,1],[0,0]]) click(vertex);
assert.equal(app.topologyDraft.value.rings.length, 1);
assert.equal(app.topologyDraft.value.closed, true);
assert.equal(app.newTopologyDraftRing(), true);
editorProps.draft = app.topologyDraft.value;
for (const vertex of [[1,1],[2,1],[2,2],[1,2],[1,1]]) click(vertex);
assert.equal(app.topologyDraft.value.rings.length, 2, 'clicking the second ring start closes it without dropping the first ring');
assert.equal(app.topologyDraft.value.closed, true);
assert.equal(events.filter(e => e === 'close').length, 2);
assert.equal(app.deleteTopologyDraftRing(1), true);
assert.equal(app.topologyDraft.value.rings.length, 1);
console.log('verify-topology-round2-editor-path: PASS (pointer closing two contours and deleting the inner contour)');
const edges = editorBoundaryEdges(app.topologyDraft.value);
let paired = false;
for (const left of edges.filter(e => e.coordinates.every(([x]) => x === 0))) {
  for (const right of edges.filter(e => e.coordinates.every(([x]) => x === 4))) {
    for (const endpointMap of [[0,1], [1,0]]) {
      if (app.addTopologyDraftSeam({ edgeOccurrenceA: left.id, edgeOccurrenceB: right.id, endpointMap })) { paired = true; break; }
    }
    if (paired) break;
  }
  if (paired) break;
}
assert.ok(paired, 'a valid seam can be selected on the outer contour: ' + app.topologySetupMessage.value);
assert.equal(app.topologyDraft.value.seamPairs.length, 1);
const preservedSeam = structuredClone(app.topologyDraft.value.seamPairs[0]);
const selectedBeforeDraft = app.selectedTopologyHash.value;
assert.equal(app.newTopologyDraftRing(), true, 'adding a contour after gluing is allowed');
assert.equal(app.selectedTopologyHash.value, selectedBeforeDraft, 'opening a draft leaves the selected board intact');
editorProps.draft = app.topologyDraft.value;
for (const vertex of [[1,1],[2,1],[1,2],[1,1]]) click(vertex);
assert.equal(app.topologyDraft.value.closed, true, app.topologySetupMessage.value);
assert.equal(app.topologyDraft.value.rings.length, 2);
assert.deepEqual(app.topologyDraft.value.seamPairs, [preservedSeam], 'unaffected glued edges survive a new contour');
assert.equal(app.deleteTopologyDraftRing(1), true, 'deleting the inner contour after gluing is allowed');
assert.deepEqual(app.topologyDraft.value.seamPairs, [preservedSeam], 'deleting an unrelated contour preserves the seam');
const selectedBeforeDelete = app.selectedTopologyHash.value;
assert.equal(app.deleteTopologyDraftRing(0), true, 'deleting the remaining glued contour is allowed');
assert.equal(app.topologyDraft.value.seamPairs.length, 0, 'the now-invalid seam is removed');
assert.match(app.topologySetupMessage.value, /seam:1/, 'the removed seam is reported visibly');
assert.equal(app.selectedTopologyHash.value, selectedBeforeDelete, 'empty draft does not replace the selected board');
console.log('verify-topology-round2-seam-path: PASS (continue drawing, preserve seam, and report invalidated seam)');
