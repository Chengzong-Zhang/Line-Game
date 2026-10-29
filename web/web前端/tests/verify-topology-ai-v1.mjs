import assert from "node:assert/strict";

import { compileBoard } from "../BoardCompiler.js";
import {
  buildTopologyAIState,
  computeTopologyDistances,
  describeTopologyAI,
  rankTopologyCandidates,
  TOPOLOGY_AI_ADAPTER_VERSION,
  TOPOLOGY_AI_PASS,
  TOPOLOGY_AI_ROUTE,
  validateTopologyAIRequest,
} from "../TopologyAIAdapter.js";
import { createTorusBoardDefinition } from "../BoardPresets.js";
import { CONCAVE_GAP_DEFINITION } from "./fixtures/board-topology-v1-fixtures.mjs";

const compile = (definition) => {
  const result = compileBoard(definition);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.value;
};

const concave = compile(CONCAVE_GAP_DEFINITION);
const profile = describeTopologyAI(concave);
assert.equal(profile.route, TOPOLOGY_AI_ROUTE);
assert.equal(profile.fixedShapeModelsAllowed, false);
assert.equal(profile.strengthVerified, false);

const blackStart = concave.startingVertices.BLACK;
const whiteStart = concave.startingVertices.WHITE;
const distances = computeTopologyDistances(concave, [blackStart]);
assert.equal(distances[blackStart], 0);
assert.ok(Object.values(distances).some((distance) => Number.isInteger(distance) && distance > 0));
assert.equal(distances[concave.rawVertexToCanonical["v:3,0"]], undefined,
  "the concave notch is absent rather than a far-away graph node");

const legal = [whiteStart, blackStart, TOPOLOGY_AI_PASS];
const rankedOnce = rankTopologyCandidates(concave, legal, { anchorVertexIds: [blackStart] });
const rankedTwice = rankTopologyCandidates(concave, legal, { anchorVertexIds: [blackStart] });
assert.deepEqual(rankedOnce, rankedTwice, "candidate ordering is deterministic");
assert.equal(rankedOnce.at(-1).vertexId, TOPOLOGY_AI_PASS, "PASS is explicit and last");
assert.equal(rankedOnce[0].vertexId, blackStart, "topological distance precedes coordinate assumptions");

const torus = compile(createTorusBoardDefinition());
const torusSamples = torus.sampleIds.slice().sort();
const topologyState = buildTopologyAIState(torus, {
  rulesVersion: "surface-v1",
  positionRevision: 7,
  currentPlayer: "BLACK",
  legalMoveIds: [torusSamples[0], torusSamples[1], TOPOLOGY_AI_PASS],
  coverageByPlayer: { BLACK: [torusSamples[2]], WHITE: [torusSamples[3]] },
  logicalPathsByPlayer: {
    BLACK: [{ pathId: "path:wrapped", vertices: [torusSamples[2], torusSamples[4]] }],
  },
  historyHashes: ["h:two", "h:one"],
});
assert.equal(topologyState.boardHash, torus.boardHash);
assert.equal(topologyState.historyHashes[0], "h:one");
assert.deepEqual(JSON.parse(JSON.stringify(topologyState)), topologyState,
  "AI state contains only plain JSON data");

const request = {
  contractVersion: TOPOLOGY_AI_ADAPTER_VERSION,
  boardHash: torus.boardHash,
  rulesVersion: "surface-v1",
  positionRevision: 7,
  currentPlayer: "BLACK",
  modelRoute: TOPOLOGY_AI_ROUTE,
  legalMoveIds: [...topologyState.legalMoveIds],
  state: topologyState,
};
const accepted = validateTopologyAIRequest(torus, request, {
  rulesVersion: "surface-v1",
  positionRevision: 7,
  currentPlayer: "BLACK",
});
assert.equal(accepted.ok, true, JSON.stringify(accepted.errors));

const badHash = validateTopologyAIRequest(torus, { ...request, boardHash: "different" });
assert.equal(badHash.ok, false);
assert.ok(badHash.errors.some((error) => error.code === "BOARD_HASH_MISMATCH"));
const missingRevision = validateTopologyAIRequest(torus, (() => {
  const copy = { ...request };
  delete copy.positionRevision;
  return copy;
})());
assert.equal(missingRevision.ok, false);
assert.ok(missingRevision.errors.some((error) => error.code === "INVALID_POSITION_REVISION"));
const badMoves = validateTopologyAIRequest(torus, { ...request, legalMoveIds: ["not-a-canonical-sample"] });
assert.equal(badMoves.ok, false);
assert.ok(badMoves.errors.some((error) => error.code === "INVALID_LEGAL_MOVES"));
const legacyRoute = validateTopologyAIRequest(torus, { ...request, modelRoute: "hex-neural-v4" });
assert.equal(legacyRoute.ok, false);
assert.ok(legacyRoute.errors.some((error) => error.code === "LEGACY_FIXED_SHAPE_ROUTE"));
assert.throws(() => buildTopologyAIState(torus, {
  ...topologyState,
  coverageByPlayer: { BLACK: [torusSamples[2]], WHITE: [torusSamples[2]] },
}), /overlaps/);

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "concave and closed-surface graph adapters",
    "canonical graph distance and stable candidate order",
    "explicit PASS and JSON-only state",
    "board hash, revision, player and legal-move request guards",
    "legacy fixed-shape route rejection",
  ],
}));
