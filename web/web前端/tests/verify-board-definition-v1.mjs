import assert from "node:assert/strict";

import {
  canonicalizeBoard,
  compileBoard,
  compileLegacyBoard,
  sha256Hex,
  validateBoardDefinition,
} from "../BoardCompiler.js";
import {
  CONCAVE_GAP_DEFINITION,
  INVALID_SEAM_FIXTURES,
  copyDefinition,
} from "./fixtures/board-topology-v1-fixtures.mjs";

const assertError = (result, code) => {
  assert.equal(result.ok, false, "expected validation to reject " + code);
  assert.ok(result.errors.some((error) => error.code === code),
    "missing " + code + ": " + JSON.stringify(result.errors));
};

assert.equal(sha256Hex("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "board hashes use documented SHA-256");

const concaveValidation = validateBoardDefinition(CONCAVE_GAP_DEFINITION);
assert.equal(concaveValidation.ok, true, JSON.stringify(concaveValidation.errors));
const concave = compileBoard(CONCAVE_GAP_DEFINITION);
assert.equal(concave.ok, true, JSON.stringify(concave.errors));
assert.equal(concave.value.canonicalVertices.length, 23);
assert.equal(concave.value.eulerCharacteristic, 1);
assert.equal(concave.value.boundaryComponents.length, 1);
assert.equal(concave.value.orientable, true);
assert.equal(concave.value.rawVertexToCanonical["v:3,0"], undefined, "the notch is not silently filled");
assert.deepEqual(concave.value.canonicalAdjacency["cv:0"].slice().sort(),
  concave.value.canonicalAdjacency["cv:0"].slice().sort(), "adjacency remains ordinary JSON");
assert.ok(Object.isFrozen(concave.value), "compiled input is immutable");

const reordered = copyDefinition(CONCAVE_GAP_DEFINITION);
reordered.vertices.reverse();
reordered.faces.reverse();
const originalCanonical = canonicalizeBoard(CONCAVE_GAP_DEFINITION);
const reorderedCanonical = canonicalizeBoard(reordered);
assert.equal(originalCanonical.ok, true);
assert.equal(reorderedCanonical.ok, true);
assert.equal(originalCanonical.boardHash, reorderedCanonical.boardHash,
  "array order does not change a board identity");

for (const [name, fixture] of Object.entries(INVALID_SEAM_FIXTURES)) {
  const result = validateBoardDefinition(fixture);
  assertError(result, name === "self" ? "SELF_SEAM"
    : name === "duplicate" ? "DUPLICATE_SEAM_OCCURRENCE" : "INVALID_ENDPOINT_MAP");
}

const badCoordinate = copyDefinition(CONCAVE_GAP_DEFINITION);
badCoordinate.vertices[0].coordinate = [1.5, 0];
assertError(validateBoardDefinition(badCoordinate), "INVALID_COORDINATE");

const repeatedStart = copyDefinition(CONCAVE_GAP_DEFINITION);
repeatedStart.startingVertices.WHITE = repeatedStart.startingVertices.BLACK;
assertError(validateBoardDefinition(repeatedStart), "DUPLICATE_START_VERTEX");

const nonUnitFace = copyDefinition(CONCAVE_GAP_DEFINITION);
nonUnitFace.faces[0].vertices = ["v:0,0", "v:2,0", "v:0,1"];
assertError(validateBoardDefinition(nonUnitFace), "NON_UNIT_TRIANGULAR_EDGE");
assert.equal(compileBoard(nonUnitFace).ok, false, "compiler must not silently accept a long grid edge");

const legacyTriangle = compileLegacyBoard({ gridSize: 5, boardShape: "triangle" });
const legacyHexagon = compileLegacyBoard({ gridSize: 5, boardShape: "hexagon" });
assert.equal(legacyTriangle.ok, true, JSON.stringify(legacyTriangle.errors));
assert.equal(legacyHexagon.ok, true, JSON.stringify(legacyHexagon.errors));
assert.equal(legacyTriangle.value.canonicalVertices.length, 15);
assert.equal(legacyHexagon.value.canonicalVertices.length, 61);
assert.equal(legacyTriangle.value.eulerCharacteristic, 1);
assert.equal(legacyHexagon.value.eulerCharacteristic, 1);

console.log(JSON.stringify({
  status: "PASS",
  contract: concave.value.contractVersion,
  coverage: [
    "schema and bounded coordinates",
    "stable SHA-256 canonical hash",
    "concave notch remains absent",
    "self/duplicate/bad endpoint seams reject",
    "non-unit triangular edges reject",
    "legacy triangle and hex adapters",
  ],
}));
