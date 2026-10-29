import assert from "node:assert/strict";
import { generateBoard } from "../RandomBoard.js";
const RandomBoardGeneratorVersion = "random-board-v1";

const stableJson = (value) => {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
};

const independentDigest = (value) => {
  let hash = 0x811c9dc5;
  const text = stableJson(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const undirectedEdge = (left, right) => [left, right].sort().join("|");
const parseCoordinate = (id) => id.slice(2).split(",").map(Number);

function assertSimplePlanarBoard(definition, expectedPlayerCount) {
  assert.equal(definition.schemaVersion, 1);
  assert.equal(definition.coordinateSystem, "triangular-axial-v1");
  assert.deepEqual(definition.topology, {
    family: "planar",
    movementStrategy: "simple-rays-v1",
    territoryStrategy: "surface-discrete-v1",
    specialVertexPolicy: "stop",
  });
  assert.deepEqual(definition.seamPairs, []);
  const vertices = new Map();
  const coordinates = new Set();
  for (const vertex of definition.vertices) {
    assert.match(vertex.id, /^v:-?\d+,-?\d+$/);
    assert.equal(vertices.has(vertex.id), false, "vertex IDs must be unique");
    assert.equal(Array.isArray(vertex.coordinate), true);
    assert.equal(vertex.coordinate.length, 2);
    assert.equal(vertex.coordinate.every(Number.isInteger), true);
    assert.deepEqual(parseCoordinate(vertex.id), vertex.coordinate, "ID and coordinate agree");
    const coordinate = vertex.coordinate.join(",");
    assert.equal(coordinates.has(coordinate), false, "coordinates must be unique");
    vertices.set(vertex.id, vertex.coordinate);
    coordinates.add(coordinate);
  }
  assert.ok(vertices.size > 0);

  const edgeOccurrences = new Map();
  const faceNeighbors = new Map();
  for (const face of definition.faces) {
    assert.equal(Array.isArray(face.vertices), true);
    assert.equal(face.vertices.length, 3);
    assert.equal(new Set(face.vertices).size, 3, "face must not repeat a vertex");
    for (const id of face.vertices) assert.ok(vertices.has(id), "face vertex must exist");
    const [a, b, c] = face.vertices.map((id) => vertices.get(id));
    const signedDoubleArea = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.notEqual(signedDoubleArea, 0, "face must be non-degenerate");
    faceNeighbors.set(face.id, new Set());
    for (let index = 0; index < 3; index += 1) {
      const edge = undirectedEdge(face.vertices[index], face.vertices[(index + 1) % 3]);
      const uses = edgeOccurrences.get(edge) ?? [];
      uses.push(face.id);
      edgeOccurrences.set(edge, uses);
    }
  }
  assert.equal(new Set(definition.faces.map((face) => face.id)).size, definition.faces.length);
  for (const [edge, uses] of edgeOccurrences) {
    assert.ok(uses.length >= 1 && uses.length <= 2, "edge incidence must be 1 or 2: " + edge);
    if (uses.length === 2) {
      faceNeighbors.get(uses[0]).add(uses[1]);
      faceNeighbors.get(uses[1]).add(uses[0]);
    }
  }

  const visitedFaces = new Set();
  const stack = [definition.faces[0].id];
  while (stack.length) {
    const face = stack.pop();
    if (visitedFaces.has(face)) continue;
    visitedFaces.add(face);
    for (const neighbor of faceNeighbors.get(face)) stack.push(neighbor);
  }
  assert.equal(visitedFaces.size, definition.faces.length, "the generated faces form one region");

  const boundaryAdjacency = new Map();
  for (const [edge, uses] of edgeOccurrences) {
    if (uses.length !== 1) continue;
    const [left, right] = edge.split("|");
    const leftSet = boundaryAdjacency.get(left) ?? new Set();
    const rightSet = boundaryAdjacency.get(right) ?? new Set();
    leftSet.add(right);
    rightSet.add(left);
    boundaryAdjacency.set(left, leftSet);
    boundaryAdjacency.set(right, rightSet);
  }
  assert.ok(boundaryAdjacency.size >= 3);
  for (const neighbors of boundaryAdjacency.values()) {
    assert.equal(neighbors.size, 2, "the boundary is a simple closed grid curve");
  }
  const [firstBoundaryVertex] = boundaryAdjacency.keys();
  const visitedBoundary = new Set();
  const boundaryStack = [firstBoundaryVertex];
  while (boundaryStack.length) {
    const id = boundaryStack.pop();
    if (visitedBoundary.has(id)) continue;
    visitedBoundary.add(id);
    for (const neighbor of boundaryAdjacency.get(id)) boundaryStack.push(neighbor);
  }
  assert.equal(visitedBoundary.size, boundaryAdjacency.size, "there is exactly one boundary loop");
  const eulerCharacteristic = vertices.size - edgeOccurrences.size + definition.faces.length;
  assert.equal(eulerCharacteristic, 1, "the generated region is a disk and has no hole");

  const starts = Object.entries(definition.startingVertices);
  assert.equal(starts.length, expectedPlayerCount);
  assert.equal(new Set(starts.map(([, id]) => id)).size, expectedPlayerCount);
  for (const [, id] of starts) {
    assert.ok(vertices.has(id));
    assert.ok(boundaryAdjacency.has(id), "starting positions are on the playable boundary");
  }
}

const baseOptions = Object.freeze({
  width: 7,
  height: 6,
  roughness: 0.65,
  playerCount: 4,
  minArea: 16,
  maxArea: 42,
  minimumChannelWidth: 2,
  maxAttempts: 24,
});

const alpha = generateBoard(baseOptions, "alpha", RandomBoardGeneratorVersion);
const alphaAgain = generateBoard(baseOptions, "alpha", RandomBoardGeneratorVersion);
assert.equal(alpha.ok, true);
assert.deepEqual(alphaAgain, alpha, "the same seed, version and parameters must reproduce exactly");
assertSimplePlanarBoard(alpha.definition, 4);
assert.equal(alpha.stats.area, 16);
assert.deepEqual(alpha.stats.profile, [4, 2, 2, 2, 2, 2, 2]);
assert.equal(independentDigest(alpha.definition), "7115e96c", "the frozen alpha fixture detects generator drift");

const beta = generateBoard(baseOptions, "beta", RandomBoardGeneratorVersion);
assert.equal(beta.ok, true);
assertSimplePlanarBoard(beta.definition, 4);
assert.notDeepEqual(beta.definition, alpha.definition, "different seeds should not collapse to the same default board");
assert.deepEqual(beta.stats.profile, [4, 2, 3, 2, 4, 3, 5]);
assert.equal(independentDigest(beta.definition), "fca98cd0", "the frozen beta fixture detects generator drift");

const originalRandom = Math.random;
try {
  Math.random = () => {
    throw new Error("generateBoard must not read Math.random");
  };
  assert.deepEqual(generateBoard(baseOptions, "alpha", RandomBoardGeneratorVersion), alpha);
} finally {
  Math.random = originalRandom;
}

const mirror = generateBoard({
  width: 8,
  height: 7,
  roughness: 0.8,
  playerCount: 2,
  minimumChannelWidth: 2,
  minArea: 16,
  maxArea: 56,
  symmetry: "mirror",
}, "mirror-7", RandomBoardGeneratorVersion);
assert.equal(mirror.ok, true);
assertSimplePlanarBoard(mirror.definition, 2);
assert.deepEqual(mirror.stats.profile, [...mirror.stats.profile].reverse(), "mirror option mirrors the height profile");
assert.ok(mirror.stats.minimumColumnHeight >= 2);

const noAttempts = generateBoard(baseOptions, "alpha", RandomBoardGeneratorVersion);
const zeroAttempt = generateBoard({ ...baseOptions, maxAttempts: 0 }, "alpha", RandomBoardGeneratorVersion);
assert.equal(noAttempts.ok, true);
assert.equal(zeroAttempt.ok, false);
assert.equal(zeroAttempt.definition, undefined);
assert.deepEqual(zeroAttempt.errors.map(({ code }) => code), ["ATTEMPT_BUDGET_EXHAUSTED"]);

const impossibleStarts = generateBoard({
  width: 2,
  height: 2,
  playerCount: 6,
  minimumChannelWidth: 2,
  minStartDistance: 100,
  maxAttempts: 3,
}, "too-far", RandomBoardGeneratorVersion);
assert.equal(impossibleStarts.ok, false);
assert.equal(impossibleStarts.definition, undefined);
assert.deepEqual(impossibleStarts.errors.map(({ code }) => code), ["ATTEMPT_BUDGET_EXHAUSTED"]);

for (const invalid of [
  [baseOptions, "", RandomBoardGeneratorVersion, "INVALID_SEED"],
  [{ ...baseOptions, width: 1 }, "alpha", RandomBoardGeneratorVersion, "INVALID_WIDTH"],
  [{ ...baseOptions, minimumChannelWidth: 9 }, "alpha", RandomBoardGeneratorVersion, "IMPOSSIBLE_CONSTRAINT"],
  [{ ...baseOptions, minArea: 43, maxArea: 42 }, "alpha", RandomBoardGeneratorVersion, "IMPOSSIBLE_CONSTRAINT"],
  [baseOptions, "alpha", "random-board-v0", "UNSUPPORTED_GENERATOR_VERSION"],
]) {
  const [options, seed, version, expectedCode] = invalid;
  const result = generateBoard(options, seed, version);
  assert.equal(result.ok, false);
  assert.equal(result.definition, undefined);
  assert.equal(result.errors[0].code, expectedCode);
}

console.log(JSON.stringify({
  status: "PASS",
  contract: "board-topology-v1",
  generator: RandomBoardGeneratorVersion,
  frozenSeeds: {
    alpha: independentDigest(alpha.definition),
    beta: independentDigest(beta.definition),
  },
  coverage: [
    "determinism",
    "different seeds",
    "independent topology checks",
    "single simple boundary",
    "no-hole Euler check",
    "seeded starts",
    "mirror constraint",
    "bounded failure",
    "invalid input",
  ],
}));
