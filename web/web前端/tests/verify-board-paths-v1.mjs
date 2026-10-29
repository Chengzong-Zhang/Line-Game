import assert from "node:assert/strict";

import { compileBoard } from "../BoardCompiler.js";
import {
  enumerateConnections,
  indexConnectionCoverage,
  RayStopReason,
  traceRay,
} from "../BoardPaths.js";
import { createTorusBoardDefinition } from "../BoardPresets.js";
import {
  CONCAVE_GAP_DEFINITION,
  NONADJACENT_REVERSED_SEAM,
  findBoundaryOccurrence,
  makeTriangularPatchDefinition,
} from "./fixtures/board-topology-v1-fixtures.mjs";

const compile = (definition) => {
  const result = compileBoard(definition);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.value;
};

const emptyPosition = { coverageByPlayer: {} };

// A collinear ray whose next lattice coordinate is absent must stop at the
// notch. It must not scan farther along the coordinate axis and reconnect at
// the later in-board point.
const concave = compile(CONCAVE_GAP_DEFINITION);
const notchStart = concave.rawVertexToCanonical["v:2,0"];
const laterCollinearVertex = concave.rawVertexToCanonical["v:4,0"];
const notchTrace = traceRay(concave, emptyPosition, notchStart, {
  directionIndex: 0,
  atlasVertexId: "v:2,0",
});
assert.equal(notchTrace.stopReason, RayStopReason.REAL_BOUNDARY);
assert.deepEqual(notchTrace.vertices, [notchStart]);
assert.equal(notchTrace.vertices.includes(laterCollinearVertex), false,
  "a missing lattice point cannot be silently skipped by a ray");

// A reversed non-adjacent seam uses the endpoint map and target-face side.
// The first traversed vertex after the seam is the target triangle's interior
// vertex, rather than a coordinate-axis reflection on the source patch.
const reversedSeam = compile(NONADJACENT_REVERSED_SEAM);
const seamTransition = reversedSeam.directionTransitions.find((transition) =>
  transition.fromEdgeOccurrenceId === "u:0,0:0");
assert.ok(seamTransition);
const seamTrace = traceRay(reversedSeam, emptyPosition,
  reversedSeam.rawVertexToCanonical["v:0,0"], {
    directionIndex: 4,
    atlasVertexId: "v:0,0",
  });
assert.equal(seamTrace.seamCrossings.length, 1);
assert.deepEqual(seamTrace.seamCrossings[0], {
  fromEdgeOccurrenceId: "u:0,0:0",
  toEdgeOccurrenceId: "d:3,1:0",
  sourceVertexId: "v:0,0",
  targetVertexId: "v:4,2",
  sourceEndpointIndex: 0,
  targetEndpointIndex: 1,
  sourceDirectionState: 4,
  targetDirectionState: 3,
});
assert.equal(seamTrace.vertices[1],
  reversedSeam.rawVertexToCanonical[seamTransition.targetFaceSide.interiorVertexId],
  "a seam exit must enter the paired target face interior");

// Closed boards can contain a ray cycle. A ray records its direction/copy
// state and terminates before it can spin indefinitely.
const legacyTorusDefinition = createTorusBoardDefinition();
legacyTorusDefinition.topology.movementStrategy = "simple-rays-v2";
const torus = compile(legacyTorusDefinition);
const torusStart = torus.rawVertexToCanonical["v:1,1"];
const cyclicTrace = traceRay(torus, emptyPosition, torusStart, {
  directionIndex: 0,
  atlasVertexId: "v:1,1",
});
assert.equal(cyclicTrace.stopReason, RayStopReason.REPEATED_STATE);
assert.ok(cyclicTrace.steps > 0);
assert.ok(cyclicTrace.steps <= torus.sampleIds.length * 6 + torus.directionTransitions.length * 2,
  "the compiled-board traversal budget bounds a closed-surface ray");

// The same pair of canonical endpoints can have more than one legal ray on a
// quotient board. These are independent logical paths with stable identities.
const newVertexId = torus.rawVertexToCanonical["v:1,1"];
const existingVertexId = torus.rawVertexToCanonical["v:0,1"];
const connectionPosition = { coverageByPlayer: { BLACK: [existingVertexId] } };
const connections = enumerateConnections(torus, connectionPosition, newVertexId, "BLACK");
const sameEndpointPaths = connections.filter((connection) =>
  connection.endVertexId === existingVertexId);
assert.ok(sameEndpointPaths.length >= 2,
  "the fixture must retain at least two paths to the same canonical endpoint");
assert.equal(new Set(sameEndpointPaths.map((connection) => connection.pathId)).size,
  sameEndpointPaths.length, "same-endpoint paths need distinct stable IDs");
assert.ok(sameEndpointPaths.some((connection) => connection.seamCrossings.length > 0),
  "at least one retained path crosses a seam");
assert.deepEqual(enumerateConnections(torus, connectionPosition, newVertexId, "BLACK"), connections,
  "path IDs and ordering are deterministic for the same immutable inputs");
const coverage = indexConnectionCoverage(sameEndpointPaths);
assert.ok(coverage.byVertexId[existingVertexId].length >= 2,
  "coverage keeps all paths rather than collapsing paths with matching endpoints");

// A legal seam can merge two distinct chart copies into a special vertex.
// Without an atlas copy, direction 0 has no unique continuation and must stop
// rather than guessing a branch. This exercises generated topology metadata,
// rather than injecting a special-vertex flag into an otherwise planar board.
const generatedSpecialDefinition = makeTriangularPatchDefinition({ width: 4, height: 3 });
const generatedSpecialFirstEdge = findBoundaryOccurrence(
  generatedSpecialDefinition, "v:0,0", "v:1,0",
);
const generatedSpecialSecondEdge = findBoundaryOccurrence(
  generatedSpecialDefinition, "v:1,0", "v:2,0",
);
assert.ok(generatedSpecialFirstEdge && generatedSpecialSecondEdge);
generatedSpecialDefinition.seamPairs = [{
  id: "seam:generated-special",
  edgeOccurrenceA: generatedSpecialFirstEdge.id,
  edgeOccurrenceB: generatedSpecialSecondEdge.id,
  endpointMap: [1, 0],
}];
const generatedSpecialBoard = compile(generatedSpecialDefinition);
const generatedSpecialVertexId = generatedSpecialBoard.rawVertexToCanonical["v:0,0"];
assert.equal(generatedSpecialVertexId,
  generatedSpecialBoard.rawVertexToCanonical["v:2,0"],
  "the reversed endpoint map identifies the two outer endpoint copies");
assert.equal(generatedSpecialBoard.specialVertices.find((vertex) =>
  vertex.id === generatedSpecialVertexId)?.stopOnAmbiguousContinuation, true,
"a seam-created nonregular vertex is explicitly marked special");
const specialTrace = traceRay(generatedSpecialBoard, emptyPosition, generatedSpecialVertexId, {
  directionIndex: 0,
});
assert.equal(specialTrace.stopReason, RayStopReason.SPECIAL_VERTEX);
assert.equal(specialTrace.steps, 0);

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "concave no-jump ray",
    "reversed nonadjacent seam enters target face",
    "closed-surface ray cycle terminates",
    "same-endpoint multiple path identities",
    "generated special-vertex stop policy",
  ],
}));
