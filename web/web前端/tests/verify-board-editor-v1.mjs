import assert from "node:assert/strict";
import {
  BoardEditorError,
  addBoundaryVertex,
  addSeamPair,
  cancelBoardDraft,
  closeBoundaryDraft,
  createBoardDraft,
  getBoundaryPath,
  undoBoundaryVertex,
} from "../BoardEditor.js";
import { hitTestBoard, projectBoard, projectPath } from "../BoardView.js";
import {
  CONCAVE_GAP_DEFINITION,
  collectBoundaryOccurrences,
} from "./fixtures/board-topology-v1-fixtures.mjs";

let draft = createBoardDraft();
assert.equal(draft.contractVersion, "board-topology-v1");
assert.equal(addBoundaryVertex(draft, [0.5, 0]).code, BoardEditorError.INVALID_COORDINATE);
for (const coordinate of [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]) {
  const result = addBoundaryVertex(draft, coordinate);
  assert.equal(result.ok, true, JSON.stringify(result));
  draft = result.draft;
}
const originalPath = getBoundaryPath(draft);
assert.equal(addBoundaryVertex(draft, [1, 0]).ok, true, "a contour may revisit a lattice vertex");
assert.equal(addBoundaryVertex(draft, [4, 0]).code, BoardEditorError.NON_LATTICE_EDGE);
const undone = undoBoundaryVertex(draft);
assert.equal(undone.ok, true);
assert.deepEqual(getBoundaryPath(undone.draft).at(-1), [0, 2]);
assert.deepEqual(getBoundaryPath(draft), originalPath, "undo must not mutate the earlier draft");
const closed = closeBoundaryDraft(draft);
assert.equal(closed.ok, true, JSON.stringify(closed));
assert.equal(closed.definition.schemaVersion, 1);
assert.ok(closed.definition.faces.length > 0);
assert.ok(closed.definition.vertices.every((vertex) => Array.isArray(vertex.coordinate)));
assert.equal(addBoundaryVertex(closed.draft, [0, 0]).code, BoardEditorError.BOARD_CLOSED);
assert.equal(closeBoundaryDraft(createBoardDraft()).code, BoardEditorError.DEGENERATE_BOUNDARY);
const canceled = cancelBoardDraft(closed.draft);
assert.equal(canceled.ok, true);
assert.equal(canceled.draft.path.length, 0);
assert.equal(canceled.draft.seamPairs.length, 0);

const occurrences = collectBoundaryOccurrences(CONCAVE_GAP_DEFINITION);
assert.ok(occurrences.length >= 4);
const seamDraft = {
  ...closed.draft,
  boundaryOccurrenceIds: occurrences.map((occurrence) => occurrence.id),
};
const first = occurrences[0].id;
const second = occurrences.find((occurrence) => occurrence.id !== first).id;
const paired = addSeamPair(seamDraft, {
  id: "editor:pair:1",
  edgeOccurrenceA: first,
  edgeOccurrenceB: second,
  endpointMap: [1, 0],
});
assert.equal(paired.ok, true, JSON.stringify(paired));
assert.equal(paired.definition.seamPairs.length, 1);
assert.equal(addSeamPair(paired.draft, {
  id: "editor:self",
  edgeOccurrenceA: first,
  edgeOccurrenceB: first,
  endpointMap: [0, 1],
}).code, BoardEditorError.SELF_SEAM);
assert.equal(addSeamPair(paired.draft, {
  id: "editor:reuse",
  edgeOccurrenceA: first,
  edgeOccurrenceB: occurrences[2].id,
  endpointMap: [0, 1],
}).code, BoardEditorError.DUPLICATE_SEAM_OCCURRENCE);
assert.equal(addSeamPair(paired.draft, {
  id: "editor:bad-map",
  edgeOccurrenceA: occurrences[2].id,
  edgeOccurrenceB: occurrences[3].id,
  endpointMap: [0, 0],
}).code, BoardEditorError.INVALID_ENDPOINT_MAP);

const mockBoard = {
  atlas: {
    pointCopies: [
      { id: "a:left", canonicalVertexId: "a", coordinate: [0, 0], chartId: "left" },
      { id: "b:left", canonicalVertexId: "b", coordinate: [1, 0], chartId: "left" },
      { id: "b:right", canonicalVertexId: "b", coordinate: [10, 0], chartId: "right" },
      { id: "c:right", canonicalVertexId: "c", coordinate: [11, 0], chartId: "right" },
      { id: "d:right", canonicalVertexId: "d", coordinate: [12, 0], chartId: "right" },
    ],
  },
  realBoundarySegments: [
    { id: "boundary:left", fromCopyId: "a:left", toCopyId: "b:left" },
  ],
  seamPairs: [
    {
      id: "seam:1",
      edgeOccurrenceA: "f:0",
      edgeOccurrenceB: "g:2",
      endpointMap: [1, 0],
      copyIds: ["b:left", "b:right"],
    },
  ],
};
const projected = projectBoard(mockBoard, {
  projectCoordinate: (coordinate) => coordinate,
});
assert.equal(projected.pointCopies.length, 5);
assert.equal(projected.boundarySegments.length, 1);
assert.equal(projected.seamMarkers[0].anchors.length, 2);
assert.equal(hitTestBoard(projected, [0.1, 0], { radius: 0.2 }), "a");
assert.equal(hitTestBoard(projected, [50, 50], { radius: 1 }), null);
assert.equal(hitTestBoard(projected, [10, 0], { radius: 0.1 }), "b", "a display copy resolves to canonical b");
const drawSegments = projectPath(mockBoard, {
  pathId: "path:split",
  vertices: ["a", "b", "c", "d"],
  copyIds: ["a:left", "b:left", "c:right", "d:right"],
  seamCrossings: [{
    id: "seam:1",
    afterVertexIndex: 1,
    exitCopyId: "b:left",
    entryCopyId: "c:right",
  }],
}, { projectCoordinate: (coordinate) => coordinate });
assert.equal(drawSegments.length, 2);
assert.deepEqual(drawSegments[0].copyIds, ["a:left", "b:left"]);
assert.deepEqual(drawSegments[1].copyIds, ["c:right", "d:right"]);
assert.ok(drawSegments.every((segment) =>
  !segment.copyIds.includes("b:left") || !segment.copyIds.includes("c:right"),
), "a seam crossing must not become a long canvas chord");

console.log(JSON.stringify({
  status: "PASS",
  contract: "board-topology-v1",
  coverage: [
    "lattice editing, undo and cancellation",
    "simple-boundary and seam validation",
    "candidate board generation",
    "canonical copy hit testing",
    "real-boundary and seam projection",
    "seam-split path projection",
  ],
}));
