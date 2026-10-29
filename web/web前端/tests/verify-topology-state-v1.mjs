import assert from "node:assert/strict";

import { compileBoard } from "../BoardCompiler.js";
import {
  DEFAULT_TOPOLOGY_STATE_LIMITS,
  TOPOLOGY_STATE_FORMAT,
  TopologyStateError,
  decodeTopologyState,
  encodeTopologyState,
} from "../TopologyStateCodec.js";
import {
  CONCAVE_GAP_DEFINITION,
  copyDefinition,
} from "./fixtures/board-topology-v1-fixtures.mjs";

const compiledResult = compileBoard(CONCAVE_GAP_DEFINITION);
assert.equal(compiledResult.ok, true, JSON.stringify(compiledResult.errors));
const board = compiledResult.value;
const [blackStart, whiteStart] = Object.values(board.startingVertices);
const edgeOccurrence = board.edgeOccurrences[0].id;

const ruleState = {
  stateVersion: 1,
  rulesVersion: "surface-v1",
  currentPlayer: "WHITE",
  startingVertices: { ...board.startingVertices },
  vertexStateById: {
    [blackStart]: { owner: "BLACK", node: true, line: false },
    [whiteStart]: { owner: "WHITE", node: true, line: false },
  },
  logicPaths: [{
    pathId: "path:v1:test-a",
    owner: "BLACK",
    startVertexId: blackStart,
    endVertexId: whiteStart,
    vertices: [blackStart, whiteStart],
    edgeOccurrences: [edgeOccurrence],
    seamCrossings: [],
    directionState: 0,
  }, {
    pathId: "path:v1:test-b",
    owner: "BLACK",
    startVertexId: blackStart,
    endVertexId: whiteStart,
    vertices: [blackStart, whiteStart],
    edgeOccurrences: [edgeOccurrence],
    seamCrossings: [],
    directionState: 3,
  }],
  historyHashes: ["position:0", "position:1"],
  superkoPolicy: "enforce",
  consecutivePasses: 0,
  passHistory: [],
  resignedPlayers: [],
  gameOver: false,
  terminal: null,
  turnCount: 1,
  positionRevision: 1,
};
const beforeBoard = structuredClone(board.definition);
const beforeState = structuredClone(ruleState);
const encoded = encodeTopologyState(board, ruleState);

assert.equal(encoded.format, TOPOLOGY_STATE_FORMAT);
assert.deepEqual(board.definition, beforeBoard, "encoding must not mutate compiled board data");
assert.deepEqual(ruleState, beforeState, "encoding must not mutate caller rule state");
const decoded = decodeTopologyState(encoded);
assert.equal(decoded.boardHash, board.boardHash);
assert.deepEqual(decoded.boardDefinition, board.definition);
assert.deepEqual(decoded.ruleState, ruleState, "round-trip must preserve state exactly");
assert.deepEqual(decoded.ruleState.logicPaths.map((path) => path.pathId),
  ["path:v1:test-a", "path:v1:test-b"], "same-endpoint paths retain separate stable IDs");
assert.ok(Object.isFrozen(decoded.board), "decode rebuilds an immutable compiled board");

const expectCode = (operation, code) => {
  assert.throws(operation, (error) => error instanceof TopologyStateError && error.code === code,
    "expected " + code);
};

const badHash = structuredClone(encoded);
badHash.boardHash = "0".repeat(64);
expectCode(() => decodeTopologyState(badHash), "BOARD_HASH_MISMATCH");

const tamperedDefinition = structuredClone(encoded);
tamperedDefinition.boardDefinition = copyDefinition(tamperedDefinition.boardDefinition);
tamperedDefinition.boardDefinition.topology.preset = "tampered-but-still-valid";
expectCode(() => decodeTopologyState(tamperedDefinition), "BOARD_HASH_MISMATCH");

const tooManyPaths = structuredClone(encoded);
tooManyPaths.ruleState.logicPaths = Array.from({ length: 2 }, () => structuredClone(ruleState.logicPaths[0]));
tooManyPaths.ruleState.logicPaths[1].pathId = "path:v1:other";
expectCode(() => decodeTopologyState(tooManyPaths, { maxLogicPaths: 1 }), "LIMIT_EXCEEDED");

const nonCanonical = structuredClone(encoded);
nonCanonical.boardDefinition.vertices.reverse();
expectCode(() => decodeTopologyState(nonCanonical), "NONCANONICAL_DEFINITION");

const unknownField = structuredClone(encoded);
unknownField.ruleState.extra = true;
expectCode(() => decodeTopologyState(unknownField), "UNEXPECTED_FIELD");

assert.equal(DEFAULT_TOPOLOGY_STATE_LIMITS.maxLogicPaths, 4096);
console.log(JSON.stringify({
  status: "PASS",
  format: TOPOLOGY_STATE_FORMAT,
  coverage: [
    "full canonical state round-trip",
    "multiple same-endpoint path IDs",
    "board hash and definition tamper rejection",
    "state limits and no silent schema repair",
    "caller input immutability",
  ],
}));
