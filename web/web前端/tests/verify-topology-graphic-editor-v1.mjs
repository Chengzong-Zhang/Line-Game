import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addBoundaryVertex, addSeamPair, closeBoundaryDraft, createBoardDraft, undoBoundaryVertex } from "../BoardEditor.js";
import { compileBoard } from "../BoardCompiler.js";
import { generateBoard, randomBoardGeometrySignature } from "../RandomBoard.js";
import { TopologyGraphicEditor, latticePoint, editorPointFromClient, nearestEditorVertex, nearestEditorEdge,
  editorBoundaryEdges, createSeamSelection, chooseSeamEdge, chooseSeamDirection } from "../TopologyGraphicEditor.js";

const rect = { left: 40, top: 70, width: 240, height: 150 };
const client = point => ({ clientX: rect.left + point[0] * rect.width / 480, clientY: rect.top + point[1] * rect.height / 300 });
for (const vertex of [[0, 0], [3, 2], [8, 8]]) {
  const point = latticePoint(vertex), pos = client(point);
  assert.deepEqual(nearestEditorVertex(editorPointFromClient(pos.clientX, pos.clientY, rect)), vertex);
}
assert.equal(editorPointFromClient(1, 2, { ...rect, width: 0 }), null);

// Run the component's actual pointer handlers, including pointer capture and
// scaled touch coordinates, with a synchronous parent implementing the API.
globalThis.Vue = { ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }), watch: () => {} };
const props = { draft: createBoardDraft(), language: "zh", disabled: false, message: "" };
const events = [];
const emit = (name, value) => {
  events.push([name, value]);
  if (name === "vertex") { const result = addBoundaryVertex(props.draft, value); assert.equal(result.ok, true, result.detail); props.draft = result.draft; }
  if (name === "close") {
    const result = closeBoundaryDraft(props.draft); assert.equal(result.ok, true, result.detail);
    const compiled = compileBoard(result.definition); assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
    props.draft = { ...result.draft, boundaryOccurrenceIds: compiled.value.edgeClasses.filter(e => e.occurrences.length === 1).map(e => e.occurrences[0].id) };
  }
};
const ui = TopologyGraphicEditor.setup(props, { emit });
const element = { getBoundingClientRect: () => rect, setPointerCapture() {} };
function down(point) { ui.start({ ...client(point), type: "pointerdown", pointerId: 4, currentTarget: element }); ui.stop({ pointerId: 4 }); }
for (const vertex of [[0,0],[1,0],[2,0],[3,0],[3,1],[3,2],[3,3],[2,3],[1,3],[0,3],[0,2],[0,1],[0,0]]) down(latticePoint(vertex));
assert.equal(props.draft.closed, true);
assert.equal(events.at(-1)[0], "close");
const edges = editorBoundaryEdges(props.draft);
assert.equal(edges.length, 12);
const midpoint = edge => { const [a,b] = edge.coordinates.map(latticePoint); return [(a[0]+b[0])/2,(a[1]+b[1])/2]; };
assert.equal(nearestEditorEdge(midpoint(edges[0]), edges).id, edges[0].id);

let compatible;
for (const a of edges) for (const b of edges) for (const map of [[0,1],[1,0]]) {
  if (a.id === b.id || compatible) continue;
  const result = addSeamPair(props.draft, { id: "seam:1", edgeOccurrenceA: a.id, edgeOccurrenceB: b.id, endpointMap: map });
  if (result.ok && compileBoard(result.definition).ok) compatible = { a, b, map, result };
}
assert.ok(compatible, "the drawn boundary must support a valid seam");
ui.setMode("glue");
assert.equal(ui.currentDirectionEdge.value, undefined, "direction controls are disabled until an edge is selected");
down(midpoint(compatible.a));
assert.equal(ui.selection.value.stage, "first-direction");
assert.equal(ui.currentDirectionEdge.value.id, compatible.a.id, "first edge enables the reserved direction controls");
ui.direction(1);
assert.equal(ui.selection.value.stage, "second-edge");
assert.equal(ui.currentDirectionEdge.value, undefined, "controls disable again while choosing the second edge");
down(midpoint(compatible.b));
assert.equal(ui.currentDirectionEdge.value.id, compatible.b.id, "second edge re-enables the same controls");
ui.direction(compatible.map[0] === 0 ? 1 : -1);
assert.deepEqual(events.at(-1), ["seam", { edgeOccurrenceA: compatible.a.id, edgeOccurrenceB: compatible.b.id, endpointMap: compatible.map }]);
const compiled = compileBoard(compatible.result.definition).value;
const aa = compiled.edgeClasses.find(e => e.occurrences.some(o => o.id === compatible.a.id)).occurrences;
const a = aa.find(o => o.id === compatible.a.id), b = aa.find(o => o.id === compatible.b.id);
assert.equal(a.canonicalVertices[0], b.canonicalVertices[compatible.map[0]]);
assert.equal(a.canonicalVertices[1], b.canonicalVertices[compatible.map[1]]);
assert.equal(chooseSeamEdge(createSeamSelection(), compatible.a, new Set([compatible.a.id])).ok, false);
assert.equal(chooseSeamDirection(createSeamSelection(), 1).ok, false);
const undonePair = undoBoundaryVertex(compatible.result.draft); assert.equal(undonePair.draft.seamPairs.length, 0);
const reopened = undoBoundaryVertex(undonePair.draft); assert.equal(reopened.draft.closed, false);
props.draft = createBoardDraft();
ui.setMode("draw");
ui.start({ ...client(latticePoint([1, 1])), type: "pointerdown", pointerId: 7, currentTarget: element });
ui.start({ ...client(latticePoint([1, 2])), type: "pointerdown", pointerId: 8, currentTarget: element });
ui.move({ ...client(latticePoint([1, 2])), type: "pointermove", pointerId: 8, currentTarget: element });
ui.stop({ pointerId: 8 });
ui.move({ ...client(latticePoint([2, 1])), type: "pointermove", pointerId: 7, currentTarget: element });
ui.stop({ pointerId: 7 });
ui.move({ ...client(latticePoint([3, 1])), type: "pointermove", pointerId: 7, currentTarget: element });
assert.deepEqual(props.draft.path, [[1, 1], [2, 1]], "second touch must not change or cancel the active pointer; cancellation must stop it");

const first = generateBoard({}, "replay-seed");
assert.equal(first.ok, true);
assert.deepEqual(generateBoard({}, first.definition.generator.seed).definition, first.definition);
assert.equal(randomBoardGeometrySignature(first.definition), randomBoardGeometrySignature(compileBoard(first.definition).value.definition), "canonical sorting must not make an unchanged shape appear new");
const app = readFileSync(new URL("../OnlineApp.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const template = TopologyGraphicEditor.template;
const toolbar = template.indexOf('class="topology-editor-direction-bar"');
const canvas = template.indexOf('class="topology-editor-canvas"');
const status = template.indexOf('role="status"');
assert.ok(toolbar >= 0 && toolbar < canvas && canvas < status, "the direction bar must occupy a stable position above the canvas and status below it");
assert.doesNotMatch(template.slice(template.lastIndexOf("<div", toolbar), toolbar), /v-if/);
assert.match(css, /\.topology-editor-direction-bar\s*\{[^}]*height:\s*44px/);
assert.match(css, /\.topology-editor-canvas\s*\{[^}]*max-width:\s*560px/);
assert.match(app, /crypto\?\.getRandomValues/);
assert.match(app, /topologyGeometrySignature\(generated\.definition\) === topologyGeometrySignature\(selectedTopologyDefinition\.value\)/);
assert.match(app, /definition\?\.seamPairs/);
assert.match(app, /event\.data\.modelInfo\?\.route !== TOPOLOGY_AI_ROUTE/);
assert.match(app, /TopologySurfacePreview v-if="gameState\.isTopologyBoard/);
console.log(JSON.stringify({ status: "PASS", coverage: ["scaled pointer input", "draw and close", "edge direction selection", "canonical seam endpoints", "undo and reopen", "seed replay", "surface and AI route wiring"] }));
