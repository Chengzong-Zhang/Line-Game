import assert from "node:assert/strict";

import { compileBoard, validateBoardDefinition } from "../BoardCompiler.js";
import {
  directionTransitionIsInverse,
  directionTransitionTargetsTargetFaceInterior,
  transportExitIntoTargetFace,
} from "../BoardTopology.js";
import { triangularDirectionIndex } from "../BoardDefinition.js";
import {
  CONCAVE_GAP_DEFINITION,
  HAND_EXPECTATIONS,
  NONADJACENT_REVERSED_SEAM,
  NONADJACENT_SAME_DIRECTION_SEAM,
  PRESET_EXPECTATIONS,
  copyDefinition,
  findBoundaryOccurrence,
  makeTriangularPatchDefinition,
} from "./fixtures/board-topology-v1-fixtures.mjs";
import {
  createCylinderBoardDefinition,
  createKleinBottleBoardDefinition,
  createMobiusBoardDefinition,
  createTorusBoardDefinition,
} from "../BoardPresets.js";

const compile = (definition) => {
  const result = compileBoard(definition);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.value;
};

const concave = compile(CONCAVE_GAP_DEFINITION);
const [left, right] = HAND_EXPECTATIONS.concaveGap.blockedCollinearEndpoints;
assert.equal(concave.rawVertexToCanonical["v:3,0"], undefined);
assert.notEqual(concave.rawVertexToCanonical[left], undefined);
assert.notEqual(concave.rawVertexToCanonical[right], undefined);
assert.equal(concave.sampleAdjacency[concave.rawVertexToCanonical[left]]
  .includes(concave.rawVertexToCanonical[right]), false,
  "a concave gap does not acquire a jump edge");

for (const definition of [NONADJACENT_SAME_DIRECTION_SEAM, NONADJACENT_REVERSED_SEAM]) {
  const compiled = compile(definition);
  assert.equal(compiled.directionTransitions.length, 2);
  assert.ok(directionTransitionIsInverse(compiled.directionTransitions[0], compiled.directionTransitions[1])
    || directionTransitionIsInverse(compiled.directionTransitions[1], compiled.directionTransitions[0]),
  "seam direction transports are mutual inverses");
  const seamClasses = compiled.edgeClasses.filter((edgeClass) =>
    edgeClass.occurrences.some((occurrence) =>
      occurrence.id === HAND_EXPECTATIONS.seam.firstOccurrenceId
      || occurrence.id === HAND_EXPECTATIONS.seam.secondOccurrenceId));
  assert.equal(seamClasses.length, 1);
  assert.equal(seamClasses[0].occurrences.length, 2);
}

const coordinateForVertex = (definition, vertexId) =>
  definition.vertices.find((vertex) => vertex.id === vertexId).coordinate;
const interiorVertexForOccurrence = (definition, occurrence) => {
  const face = definition.faces.find((candidate) => candidate.id === occurrence.faceId);
  return face.vertices[(occurrence.sideIndex + 2) % face.vertices.length];
};
const makeParallelSeam = (reversed) => {
  const definition = makeTriangularPatchDefinition({ width: 4, height: 3 });
  const source = findBoundaryOccurrence(definition, "v:1,0", "v:2,0");
  const target = findBoundaryOccurrence(definition, "v:1,3", "v:2,3");
  assert.ok(source && target);
  const endpointMap = source.vertices.map((sourceVertexId) => {
    const [x] = coordinateForVertex(definition, sourceVertexId);
    const wanted = "v:" + (reversed ? 3 - x : x) + ",3";
    return target.vertices.indexOf(wanted);
  });
  definition.seamPairs = [{
    id: reversed ? "parallel:reversed" : "parallel:same",
    edgeOccurrenceA: source.id,
    edgeOccurrenceB: target.id,
    endpointMap,
  }];
  return { definition, source, target, endpointMap };
};

for (const reversed of [false, true]) {
  const { definition, source, target, endpointMap } = makeParallelSeam(reversed);
  const compiled = compile(definition);
  const transition = compiled.directionTransitions.find((item) => item.fromEdgeOccurrenceId === source.id);
  assert.ok(transition, "source seam transition exists");
  assert.deepEqual(transition.endpointMap, endpointMap);
  assert.equal(transition.sourceFaceSide.faceId, source.faceId);
  assert.equal(transition.targetFaceSide.faceId, target.faceId);
  assert.equal(transition.sourceFaceSide.edgeOccurrenceId, source.id);
  assert.equal(transition.targetFaceSide.edgeOccurrenceId, target.id);
  assert.ok(directionTransitionTargetsTargetFaceInterior(transition),
    "a source-side exit must enter the paired target face interior");
  const targetInteriorVertexId = interiorVertexForOccurrence(definition, target);
  for (const rule of transition.endpointTransport) {
    const transported = transportExitIntoTargetFace(
      transition, rule.sourceEndpointIndex, rule.sourceExitDirectionIndex,
    );
    assert.deepEqual(transported, {
      targetEndpointIndex: rule.targetEndpointIndex,
      directionState: rule.targetEntryDirectionIndex,
    });
    const expectedEntry = triangularDirectionIndex(
      coordinateForVertex(definition, target.vertices[rule.targetEndpointIndex]),
      coordinateForVertex(definition, targetInteriorVertexId),
    );
    assert.equal(rule.targetEntryDirectionIndex, expectedEntry,
      "parallel " + (reversed ? "reversed" : "same") + " glue enters target face, not its outside");
  }
}

const presets = {
  cylinder: createCylinderBoardDefinition,
  mobius: createMobiusBoardDefinition,
  torus: createTorusBoardDefinition,
  kleinBottle: createKleinBottleBoardDefinition,
};
for (const [name, factory] of Object.entries(presets)) {
  const compiled = compile(factory());
  const expected = PRESET_EXPECTATIONS[name];
  assert.equal(compiled.boundaryComponents.length, expected.boundaryComponents, name + " boundary components");
  assert.equal(compiled.eulerCharacteristic, expected.eulerCharacteristic, name + " Euler characteristic");
  assert.equal(compiled.orientable, expected.orientable, name + " orientability");
  assert.ok(compiled.edgeClasses.every((edgeClass) => edgeClass.occurrences.length === 1
    || edgeClass.occurrences.length === 2), name + " keeps one or two face incidences per edge");
}

const nonManifold = copyDefinition(CONCAVE_GAP_DEFINITION);
nonManifold.vertices.push(
  { id: "v:extra-a", coordinate: [6, 0] },
  { id: "v:extra-b", coordinate: [6, 1] },
);
nonManifold.faces.push(
  { id: "extra:a", vertices: ["v:0,0", "v:0,1", "v:extra-a"] },
  { id: "extra:b", vertices: ["v:0,0", "v:0,1", "v:extra-b"] },
);
const rejected = compileBoard(nonManifold);
assert.equal(rejected.ok, false);
assert.ok(rejected.errors.some((error) => error.code === "NON_MANIFOLD_EDGE"),
  JSON.stringify(rejected.errors));

// Edge incidence alone is insufficient for a manifold: this raw board keeps
// at most two faces per edge, but its two retained triangles meet at the
// center only through a disconnected vertex link (a butterfly vertex).
const disconnectedVertexLink = makeTriangularPatchDefinition({ width: 4, height: 4 });
const butterflyCenter = "v:2,2";
const butterflyFaces = new Set(["d:1,1", "d:2,1"]);
disconnectedVertexLink.faces = disconnectedVertexLink.faces.filter((face) =>
  !face.vertices.includes(butterflyCenter) || butterflyFaces.has(face.id));
const usedVertexIds = new Set(disconnectedVertexLink.faces.flatMap((face) => face.vertices));
disconnectedVertexLink.vertices = disconnectedVertexLink.vertices.filter((vertex) =>
  usedVertexIds.has(vertex.id));
disconnectedVertexLink.startingVertices = { BLACK: "v:2,1", WHITE: "v:3,1" };
const edgeIncidences = new Map();
for (const face of disconnectedVertexLink.faces) {
  for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
    const edge = [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]]
      .sort().join("|");
    edgeIncidences.set(edge, (edgeIncidences.get(edge) ?? 0) + 1);
  }
}
assert.ok([...edgeIncidences.values()].every((count) => count <= 2),
  "the butterfly fixture must not fail through a three-face edge");
assert.equal(validateBoardDefinition(disconnectedVertexLink).ok, true,
  "schema validation accepts the raw faces so topology analysis owns the rejection");
const disconnectedLinkCompiled = compileBoard(disconnectedVertexLink);
assert.equal(disconnectedLinkCompiled.ok, true, JSON.stringify(disconnectedLinkCompiled.errors));
assert.ok(disconnectedLinkCompiled.value.vertexLinks.some(link => !link.manifold && link.kind === "disconnected"));
assert.ok(disconnectedLinkCompiled.value.specialVertices.some(link => !link.manifold));

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "concave no-jump topology",
    "nonadjacent seam and reversed endpoint map",
    "inverse plus face-side direction transports",
    "parallel same/reversed seam exits enter target face interiors",
    "cylinder/mobius/torus/klein invariants",
    "non-manifold edge rejection",
    "disconnected butterfly vertex-link classification",
  ],
}));
