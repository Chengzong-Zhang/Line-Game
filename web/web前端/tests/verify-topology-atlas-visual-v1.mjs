import assert from "node:assert/strict";
import { Renderer } from "../Renderer.js";
import { projectBoard, hitTestBoard } from "../BoardView.js";

const board = {
  pointCopies: [
    { id: "a1", canonicalVertexId: "a", coordinate: [0, 0] },
    { id: "b1", canonicalVertexId: "b", coordinate: [1, 0] },
    { id: "c1", canonicalVertexId: "c", coordinate: [0, 1] },
    { id: "a2", canonicalVertexId: "a", coordinate: [4, 1] },
    { id: "b2", canonicalVertexId: "b", coordinate: [4, 0] },
  ],
  faces: [{ id: "face", copyIds: ["a1", "b1", "c1"] }],
  seamPairs: [{ id: "seam", copyIds: ["a1", "b1", "b2", "a2"], endpointMap: [1, 0] }],
  realBoundarySegments: [], displayEdges: [],
};
const projected = projectBoard(board);
const projection = { viewBoard: board, projected, byCopyId: new Map(projected.pointCopies.map((p) => [p.id, p])), byCanonicalVertex: new Map() };
for (const copy of projected.pointCopies) projection.byCanonicalVertex.set(copy.canonicalVertexId, [...(projection.byCanonicalVertex.get(copy.canonicalVertexId) ?? []), copy]);
const calls = [];
const context = new Proxy({}, { get(target, prop) { return target[prop] ?? ((...args) => calls.push([prop, ...args])); }, set(target, prop, value) { target[prop] = value; return true; } });
const renderer = Object.assign(Object.create(Renderer.prototype), { ctx: context, theme: { background: "white", guideLine: "grey", boardStroke: "black", guidePoint: "grey", outline: "black" }, _getPlayerStyle: (player) => player });
const layout = { cssWidth: 100, cssHeight: 100, scale: 20, guideLineWidth: 1, guidePointRadius: 2, pointRadius: 5, territoryLineWidth: 2 };
renderer._drawTopologyTerritories({ territories: { BLACK: { renderPoints: ["a", "b"] }, WHITE: { renderPoints: ["c"] } } }, projection, layout);
assert.equal(calls.filter(([op]) => op === "closePath").length, 0, "isolated samples have no colored area");
assert.equal(calls.filter(([op]) => op === "fill").length, 0);
calls.length = 0;
renderer._drawTopologyStatic(context, projection, layout);
assert.deepEqual(calls.filter(([op]) => op === "fillText").map((call) => call[1]), ["1", "1"], "both seam sides carry the same number");
assert.equal(hitTestBoard(projected, [0, 0], { radius: 0.1 }), "a");
const second = projection.byCopyId.get("a2");
assert.equal(hitTestBoard(projected, [second.x, second.y], { radius: 0.1 }), "a");
console.log("verify-topology-atlas-visual-v1: PASS (isolated samples unfilled, paired seam labels and canonical hit identity)");
