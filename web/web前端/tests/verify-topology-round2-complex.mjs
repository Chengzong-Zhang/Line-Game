import assert from "node:assert/strict";
import { addBoundaryVertex, closeBoundaryDraft, createBoardDraft, startBoundaryRing, deleteBoundaryRing } from "../BoardEditor.js";
import { compileBoard } from "../BoardCompiler.js";
import { canonicalizeBoard, createLegacyBoardDefinition } from "../BoardDefinition.js";
import { createSurfacePreset } from "../BoardPresets.js";
import { traceRay, enumerateConnections, RayStopReason } from "../BoardPaths.js";
import { generateBoard } from "../RandomBoard.js";
import { TopologyGraphicEditor, latticePoint, nearestEditorVertex } from "../TopologyGraphicEditor.js";
import "../TopologyGameEngine.js";
import { GameEngine } from "../GameEngine.js";
const compile = definition => { const r = compileBoard(definition); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.value; };
function ring(draft, coords) {
  for (const coordinate of coords) { const r = addBoundaryVertex(draft, coordinate); assert.equal(r.ok, true, JSON.stringify(r)); draft = r.draft; }
  const r = closeBoundaryDraft(draft); assert.equal(r.ok, true, JSON.stringify(r)); return r.draft;
}
const outer = [[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],[0,2],[0,1]];
const inner = [[1,1],[2,1],[3,1],[3,2],[3,3],[2,3],[1,3],[1,2]];
let hole = ring(createBoardDraft(), outer);
hole = ring(startBoundaryRing(hole).draft, inner);
assert.equal(hole.candidateDefinition.faces.length, 24);
let holeBoard = compile(hole.candidateDefinition);
assert.equal(holeBoard.eulerCharacteristic, 0);
assert.equal(holeBoard.boundaryComponents.length, 2);
const deleted = deleteBoundaryRing(hole, 1); assert.equal(deleted.ok, true); assert.equal(deleted.definition.faces.length, 32);
assert.equal(deleted.draft.boundaryOccurrenceIds.length, 16);
assert.deepEqual(deleted.draft.boundaryOccurrenceIds, compile(deleted.definition).edgeClasses.filter(e => e.occurrences.length === 1).map(e => e.occurrences[0].id).sort());
let multi = ring(createBoardDraft(), [[0,0],[1,0],[0,1]]);
multi = ring(startBoundaryRing(multi).draft, [[3,3],[4,3],[3,4]]);
assert.equal(multi.candidateDefinition.faces.length, 2); assert.equal(compile(multi.candidateDefinition).eulerCharacteristic, 2);
const figure8 = ring(createBoardDraft(), [[2,1],[1,2],[1,1],[0,1],[1,0],[1,1]]);
assert.equal(figure8.candidateDefinition.faces.length, 2);
const pinched = compile(figure8.candidateDefinition);
assert.equal(pinched.eulerCharacteristic, 1);
assert.ok(pinched.vertexLinks.some(v => !v.manifold && v.kind === "disconnected"));
for (const n of [5,9,15]) {
  for (const name of ["cylinder", "mobius", "torus", "klein-bottle", "tetrahedron"]) {
    const board = compile(createSurfacePreset(name, { gridSize: n }));
    assert.ok(board.definition.vertices.every(v => v.coordinate.every(x => x >= 0 && x < n)));
    if (name !== "tetrahedron") assert.equal(Math.max(...board.definition.vertices.map(v => v.coordinate[0])), n-1);
    else {
      assert.equal(board.eulerCharacteristic, 2); assert.equal(board.boundaryComponents.length, 0);
      assert.equal(board.vertexLinks.filter(v => v.kind === "cycle" && v.incidentEdgeClassCount === 3).length, 4);
      for (const pair of board.definition.seamPairs) {
        const a = board.edgeOccurrences.find(x => x.id === pair.edgeOccurrenceA), b = board.edgeOccurrences.find(x => x.id === pair.edgeOccurrenceB);
        assert.equal(a.canonicalVertices[0], b.canonicalVertices[pair.endpointMap[0]]);
        assert.equal(a.canonicalVertices[1], b.canonicalVertices[pair.endpointMap[1]]);
      }
      const engine = new GameEngine({boardDefinition: board.definition});
      const move = engine.getLegalMoves()[0]; assert.ok(move, "tetrahedron must have an opening"); assert.equal(engine.playMove(move.vertexId).success, true);
      const pole = board.rawVertexToCanonical["v:0,0"], neighbor = board.rawVertexToCanonical["v:1,0"];
      const inbound = traceRay(board, {coverageByPlayer:{}}, neighbor, {directionIndex:3, atlasVertexId:"v:1,0"});
      assert.equal(inbound.vertices.at(-1), pole); assert.equal(inbound.stopReason, RayStopReason.SPECIAL_VERTEX);
      const position = {coverageByPlayer:{BLACK:[neighbor]}};
      assert.ok(enumerateConnections(board, position, pole, "BLACK").some(p => p.endVertexId === neighbor));
      assert.ok(enumerateConnections(board, {coverageByPlayer:{BLACK:[pole]}}, neighbor, "BLACK").some(p => p.endVertexId === pole));
    }
  }
  const random = generateBoard({ gridSize:n }, "size-proof"); assert.equal(random.ok, true, JSON.stringify(random.errors));
  assert.ok(random.definition.vertices.every(v => v.coordinate.every(x => x >= 0 && x < n)));
  assert.deepEqual(nearestEditorVertex(latticePoint([n-1,n-1], n), 10, n), [n-1,n-1]);
}
// Exercise the pointer interface with an actual self-touch, closing only at the
// starting vertex. This can be drawn without invoking model methods directly.
globalThis.Vue = { ref: value => ({value}), computed: fn => ({get value() { return fn(); }}), watch: () => {} };
const props = {draft:createBoardDraft(), gridSize:9, language:"zh", disabled:false};
const emit = (name, value) => {
  if (name === "vertex") { const r = addBoundaryVertex(props.draft, value); assert.equal(r.ok, true); props.draft = r.draft; }
  if (name === "close") { const r = closeBoundaryDraft(props.draft); assert.equal(r.ok, true); props.draft = r.draft; }
};
const ui = TopologyGraphicEditor.setup(props, {emit});
const element = {getBoundingClientRect:()=>({left:0,top:0,width:480,height:300}),setPointerCapture(){}};
for (const vertex of [[2,1],[1,2],[1,1],[0,1],[1,0],[1,1],[2,1]]) {
  const [clientX,clientY] = latticePoint(vertex,9);
  ui.start({clientX,clientY,type:"pointerdown",pointerId:1,currentTarget:element}); ui.stop({pointerId:1});
}
assert.equal(props.draft.closed,true); assert.equal(props.draft.candidateDefinition.faces.length,2);
assert.ok(compile(props.draft.candidateDefinition).vertexLinks.some(v=>!v.manifold));
const legacy = createLegacyBoardDefinition({gridSize:5});
const firstHash = canonicalizeBoard(legacy).boardHash;
const old = structuredClone(legacy); old.startingVertices = {BLACK:"v:0,0",WHITE:"v:4,0"};
const oldBoard = compile(old); assert.deepEqual(oldBoard.startingRoots.BLACK, [oldBoard.startingVertices.BLACK]);
const multiRoot = structuredClone(old); multiRoot.startingVertices.BLACK = ["v:0,1","v:0,0"];
const cb = compile(multiRoot); assert.equal(cb.startingRoots.BLACK.length,2); assert.equal(cb.startingVertices.BLACK,cb.startingRoots.BLACK[0]);
const reordered = structuredClone(multiRoot); reordered.startingVertices.BLACK.reverse();
assert.equal(canonicalizeBoard(multiRoot).boardHash, canonicalizeBoard(reordered).boardHash);
assert.equal(canonicalizeBoard(legacy).boardHash, firstHash);
const duplicate = structuredClone(multiRoot); duplicate.startingVertices.BLACK = ["v:0,0","v:0,0"];
assert.equal(compileBoard(duplicate).ok,false);
const duplicateAfterGlue = createSurfacePreset("cylinder", {gridSize:5}); duplicateAfterGlue.startingVertices = {BLACK:["v:0,0","v:4,0"]};
assert.equal(compileBoard(duplicateAfterGlue).ok,false);
console.log(JSON.stringify({status:"PASS",coverage:["even-odd holes", "disconnected components", "self-intersection and link classification", "5/9/15 presets random canvas", "tetrahedron Euler links seam correspondence and pole entry/exit", "multi-root compatibility and canonical duplicate rejection"]}));
