import { BOARD_TOPOLOGY_CONTRACT_VERSION, compareStableIdentifiers, stableStringify } from "./BoardDefinition.js?v=20261029-unified-r1";
import { compileBoard } from "./BoardCompiler.js?v=20261029-unified-r1";

export const TOPOLOGY_STATE_FORMAT = "lifeline-topology-state";
export const TOPOLOGY_STATE_SCHEMA_VERSION = 1;
export const TOPOLOGY_RULE_STATE_VERSION = 1;

// These limits apply in addition to BoardDefinition's parsing limits.  They
// deliberately describe the persisted match, not a renderer or a Worker
// cache.  Callers may pass stricter positive integer values to decode.
export const DEFAULT_TOPOLOGY_STATE_LIMITS = Object.freeze({
  maxStateBytes: 1024 * 1024,
  maxPlayers: 6,
  maxVertexStates: 4096,
  maxLogicPaths: 4096,
  maxPathVertices: 4096,
  maxPathEdgeOccurrences: 4096,
  maxSeamCrossingsPerPath: 4096,
  maxHistoryHashes: 32768,
  maxPassHistory: 32768,
  maxResignedPlayers: 6,
});

const STATE_KEYS = new Set([
  "format",
  "schemaVersion",
  "contractVersion",
  "boardDefinition",
  "boardHash",
  "strategies",
  "ruleState",
]);
const STRATEGY_KEYS = new Set([
  "movementStrategy",
  "territoryStrategy",
  "specialVertexPolicy",
]);
const RULE_STATE_KEYS = new Set([
  "stateVersion",
  "rulesVersion",
  "currentPlayer",
  "startingVertices",
  "vertexStateById",
  "logicPaths",
  "historyHashes",
  "superkoPolicy",
  "consecutivePasses",
  "passHistory",
  "resignedPlayers",
  "gameOver",
  "terminal",
  "turnCount",
  "positionRevision",
]);
const VERTEX_STATE_KEYS = new Set(["owner", "node", "line"]);
const PATH_KEYS = new Set([
  "pathId",
  "owner",
  "startVertexId",
  "endVertexId",
  "vertices",
  "edgeOccurrences",
  "seamCrossings",
  "directionState",
]);
const SEAM_CROSSING_KEYS = new Set([
  "fromEdgeOccurrenceId",
  "toEdgeOccurrenceId",
  "sourceVertexId",
  "targetVertexId",
  "sourceEndpointIndex",
  "targetEndpointIndex",
  "sourceDirectionState",
  "targetDirectionState",
]);
const PASS_ENTRY_KEYS = new Set(["player", "turn"]);

export class TopologyStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TopologyStateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TopologyStateError(code, message);
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("INVALID_OBJECT", label + " must be a plain JSON object.");
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UNEXPECTED_FIELD", label + "." + key + " is not supported by this state schema.");
  }
}

function assertRequiredKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", label + "." + key + " is required.");
  }
}

function assertJsonValue(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_VALUE", label + " contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("NON_JSON_VALUE", label + " contains a cycle.");
    seen.add(value);
    value.forEach((item, index) => assertJsonValue(item, label + "[" + index + "]", seen));
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) fail("NON_JSON_VALUE", label + " must contain only JSON values.");
  if (seen.has(value)) fail("NON_JSON_VALUE", label + " contains a cycle.");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, label + "." + key, seen);
  seen.delete(value);
}

function cloneJson(value, label) {
  assertJsonValue(value, label);
  return JSON.parse(JSON.stringify(value));
}

function stateByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function mergeLimits(limits = {}) {
  const merged = { ...DEFAULT_TOPOLOGY_STATE_LIMITS };
  if (isPlainObject(limits)) {
    for (const key of Object.keys(merged)) {
      if (Number.isInteger(limits[key]) && limits[key] > 0) merged[key] = limits[key];
    }
  }
  return merged;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareStableIdentifiers(left, right)));
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !value.length) fail("INVALID_IDENTIFIER", label + " must be a non-empty string.");
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail("INVALID_INTEGER", label + " must be a non-negative integer.");
  return value;
}

function assertBoundedArray(value, label, maximum) {
  if (!Array.isArray(value)) fail("INVALID_ARRAY", label + " must be an array.");
  if (value.length > maximum) fail("LIMIT_EXCEEDED", label + " exceeds its configured limit.");
  return value;
}

function compileOrThrow(definition, limits) {
  const compiled = compileBoard(definition, limits);
  if (!compiled.ok) {
    const details = compiled.errors.map((error) => error.code + "@" + error.location).join(", ");
    fail("INVALID_BOARD_DEFINITION", "The embedded board definition is invalid: " + details);
  }
  return compiled.value;
}

function canonicalBoardFromInput(board, limits) {
  assertPlainObject(board, "board");
  if (!Object.hasOwn(board, "definition") || !Object.hasOwn(board, "boardHash")) {
    fail("INVALID_COMPILED_BOARD", "board must provide definition and boardHash.");
  }
  const compiled = compileOrThrow(board.definition, limits);
  if (typeof board.boardHash !== "string" || board.boardHash !== compiled.boardHash) {
    fail("BOARD_HASH_MISMATCH", "The compiled board hash does not match its definition.");
  }
  return compiled;
}

function normalizeStrategies(value, boardRules) {
  assertPlainObject(value, "strategies");
  assertOnlyKeys(value, STRATEGY_KEYS, "strategies");
  assertRequiredKeys(value, STRATEGY_KEYS, "strategies");
  const result = {};
  for (const key of STRATEGY_KEYS) {
    assertIdentifier(value[key], "strategies." + key);
    if (value[key] !== boardRules[key]) {
      fail("STRATEGY_MISMATCH", "strategies." + key + " does not match the board definition.");
    }
    result[key] = value[key];
  }
  return result;
}

function canonicalStarts(value, sampleIds, maximumPlayers, label) {
  assertPlainObject(value, label);
  const entries = Object.entries(value);
  if (entries.length > maximumPlayers) fail("LIMIT_EXCEEDED", label + " exceeds maxPlayers.");
  const values = new Set();
  for (const [player, raw] of entries) {
    assertIdentifier(player, label + " player");
    const roots = Array.isArray(raw) ? raw : [raw];
    if (!roots.length || roots.length > 6) fail("INVALID_START_ROOT_COUNT", label + "." + player);
    for (const vertexId of roots) {
      assertIdentifier(vertexId, label + "." + player);
      if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + "." + player + " references " + vertexId);
      if (values.has(vertexId)) fail("DUPLICATE_START_VERTEX", label + " repeats " + vertexId);
      values.add(vertexId);
    }
  }
  return sortedObject(entries);
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function normalizeVertexState(value, sampleIds, limits) {
  assertPlainObject(value, "ruleState.vertexStateById");
  const entries = Object.entries(value);
  if (entries.length > limits.maxVertexStates) {
    fail("LIMIT_EXCEEDED", "ruleState.vertexStateById exceeds maxVertexStates.");
  }
  const result = {};
  for (const [vertexId, state] of entries) {
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", "ruleState.vertexStateById." + vertexId);
    assertPlainObject(state, "ruleState.vertexStateById." + vertexId);
    assertOnlyKeys(state, VERTEX_STATE_KEYS, "ruleState.vertexStateById." + vertexId);
    assertRequiredKeys(state, VERTEX_STATE_KEYS, "ruleState.vertexStateById." + vertexId);
    assertIdentifier(state.owner, "ruleState.vertexStateById." + vertexId + ".owner");
    if (typeof state.node !== "boolean" || typeof state.line !== "boolean") {
      fail("INVALID_VERTEX_STATE", "ruleState.vertexStateById." + vertexId + " needs boolean node and line flags.");
    }
    if (!state.node && !state.line) {
      fail("INVALID_VERTEX_STATE", "ruleState.vertexStateById." + vertexId + " has no node or line coverage.");
    }
    result[vertexId] = { owner: state.owner, node: state.node, line: state.line };
  }
  return sortedObject(Object.entries(result));
}

function normalizeSeamCrossing(value, label, knownOccurrences) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, SEAM_CROSSING_KEYS, label);
  assertRequiredKeys(value, SEAM_CROSSING_KEYS, label);
  for (const key of ["fromEdgeOccurrenceId", "toEdgeOccurrenceId", "sourceVertexId", "targetVertexId"]) {
    assertIdentifier(value[key], label + "." + key);
  }
  if (!knownOccurrences.has(value.fromEdgeOccurrenceId) || !knownOccurrences.has(value.toEdgeOccurrenceId)) {
    fail("UNKNOWN_EDGE_OCCURRENCE", label + " references an edge occurrence outside the board.");
  }
  for (const key of ["sourceEndpointIndex", "targetEndpointIndex", "sourceDirectionState", "targetDirectionState"]) {
    assertNonNegativeInteger(value[key], label + "." + key);
  }
  return {
    fromEdgeOccurrenceId: value.fromEdgeOccurrenceId,
    toEdgeOccurrenceId: value.toEdgeOccurrenceId,
    sourceVertexId: value.sourceVertexId,
    targetVertexId: value.targetVertexId,
    sourceEndpointIndex: value.sourceEndpointIndex,
    targetEndpointIndex: value.targetEndpointIndex,
    sourceDirectionState: value.sourceDirectionState,
    targetDirectionState: value.targetDirectionState,
  };
}

function normalizePath(value, index, sampleIds, knownOccurrences, limits) {
  const label = "ruleState.logicPaths[" + index + "]";
  assertPlainObject(value, label);
  assertOnlyKeys(value, PATH_KEYS, label);
  assertRequiredKeys(value, PATH_KEYS, label);
  const result = {
    pathId: assertIdentifier(value.pathId, label + ".pathId"),
    owner: assertIdentifier(value.owner, label + ".owner"),
    startVertexId: assertIdentifier(value.startVertexId, label + ".startVertexId"),
    endVertexId: assertIdentifier(value.endVertexId, label + ".endVertexId"),
    vertices: [],
    edgeOccurrences: [],
    seamCrossings: [],
    directionState: assertNonNegativeInteger(value.directionState, label + ".directionState"),
  };
  for (const vertexId of [result.startVertexId, result.endVertexId]) {
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + " references " + vertexId);
  }
  const vertices = assertBoundedArray(value.vertices, label + ".vertices", limits.maxPathVertices);
  if (vertices.length < 2) fail("INVALID_LOGIC_PATH", label + ".vertices must include two endpoints.");
  for (const vertexId of vertices) {
    assertIdentifier(vertexId, label + ".vertices");
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + ".vertices references " + vertexId);
    result.vertices.push(vertexId);
  }
  if (result.vertices[0] !== result.startVertexId
    || result.vertices[result.vertices.length - 1] !== result.endVertexId) {
    fail("PATH_ENDPOINT_MISMATCH", label + " endpoints do not match vertices.");
  }
  const occurrences = assertBoundedArray(value.edgeOccurrences, label + ".edgeOccurrences", limits.maxPathEdgeOccurrences);
  for (const occurrenceId of occurrences) {
    assertIdentifier(occurrenceId, label + ".edgeOccurrences");
    if (!knownOccurrences.has(occurrenceId)) fail("UNKNOWN_EDGE_OCCURRENCE", label + ".edgeOccurrences references " + occurrenceId);
    result.edgeOccurrences.push(occurrenceId);
  }
  const crossings = assertBoundedArray(value.seamCrossings, label + ".seamCrossings", limits.maxSeamCrossingsPerPath);
  result.seamCrossings = crossings.map((crossing, crossingIndex) =>
    normalizeSeamCrossing(crossing, label + ".seamCrossings[" + crossingIndex + "]", knownOccurrences));
  return result;
}

function normalizePassHistory(value, limits) {
  const entries = assertBoundedArray(value, "ruleState.passHistory", limits.maxPassHistory);
  return entries.map((entry, index) => {
    const label = "ruleState.passHistory[" + index + "]";
    assertPlainObject(entry, label);
    assertOnlyKeys(entry, PASS_ENTRY_KEYS, label);
    assertRequiredKeys(entry, PASS_ENTRY_KEYS, label);
    return {
      player: assertIdentifier(entry.player, label + ".player"),
      turn: assertNonNegativeInteger(entry.turn, label + ".turn"),
    };
  });
}

function normalizeRuleState(value, compiledBoard, limits) {
  assertPlainObject(value, "ruleState");
  assertOnlyKeys(value, RULE_STATE_KEYS, "ruleState");
  assertRequiredKeys(value, RULE_STATE_KEYS, "ruleState");
  if (value.stateVersion !== TOPOLOGY_RULE_STATE_VERSION) {
    fail("UNSUPPORTED_RULE_STATE", "ruleState.stateVersion is unsupported.");
  }
  assertIdentifier(value.rulesVersion, "ruleState.rulesVersion");
  if (typeof value.currentPlayer !== "string" && value.currentPlayer !== null) {
    fail("INVALID_CURRENT_PLAYER", "ruleState.currentPlayer must be a player id or null.");
  }
  if (value.currentPlayer !== null) assertIdentifier(value.currentPlayer, "ruleState.currentPlayer");
  const sampleIds = new Set(compiledBoard.sampleIds);
  const starts = canonicalStarts(value.startingVertices, sampleIds, limits.maxPlayers, "ruleState.startingVertices");
  const expectedStarts = Object.fromEntries(Object.entries(compiledBoard.startingRoots ?? compiledBoard.startingVertices)
    .map(([player, value]) => {
      const roots = Array.isArray(value) ? value : [value];
      return [player, Array.isArray(compiledBoard.definition.startingVertices?.[player]) ? roots : roots[0]];
    }));
  if (!sameJson(starts, expectedStarts)) {
    fail("STARTING_VERTICES_MISMATCH", "ruleState.startingVertices does not match the embedded board.");
  }
  const vertexStateById = normalizeVertexState(value.vertexStateById, sampleIds, limits);
  const occurrenceIds = new Set((compiledBoard.edgeOccurrences ?? []).map((occurrence) => occurrence.id));
  const rawPaths = assertBoundedArray(value.logicPaths, "ruleState.logicPaths", limits.maxLogicPaths);
  const pathIds = new Set();
  const logicPaths = rawPaths.map((path, index) => {
    const normalized = normalizePath(path, index, sampleIds, occurrenceIds, limits);
    if (pathIds.has(normalized.pathId)) fail("DUPLICATE_PATH_ID", "ruleState.logicPaths repeats " + normalized.pathId);
    pathIds.add(normalized.pathId);
    return normalized;
  });
  const historyHashes = assertBoundedArray(value.historyHashes, "ruleState.historyHashes", limits.maxHistoryHashes);
  const historySet = new Set();
  for (const hash of historyHashes) {
    assertIdentifier(hash, "ruleState.historyHashes");
    if (historySet.has(hash)) fail("DUPLICATE_HISTORY_HASH", "ruleState.historyHashes repeats " + hash);
    historySet.add(hash);
  }
  if (value.superkoPolicy !== "enforce") {
    fail("INVALID_SUPERKO_POLICY", "ruleState.superkoPolicy must be enforce.");
  }
  const consecutivePasses = assertNonNegativeInteger(value.consecutivePasses, "ruleState.consecutivePasses");
  const passHistory = normalizePassHistory(value.passHistory, limits);
  const resignedPlayers = assertBoundedArray(value.resignedPlayers, "ruleState.resignedPlayers", limits.maxResignedPlayers);
  const resignedSet = new Set();
  for (const player of resignedPlayers) {
    assertIdentifier(player, "ruleState.resignedPlayers");
    if (resignedSet.has(player)) fail("DUPLICATE_RESIGNED_PLAYER", "ruleState.resignedPlayers repeats " + player);
    resignedSet.add(player);
  }
  if (typeof value.gameOver !== "boolean") fail("INVALID_GAME_OVER", "ruleState.gameOver must be boolean.");
  if (value.terminal !== null) assertPlainObject(value.terminal, "ruleState.terminal");
  if (value.gameOver && value.terminal === null) {
    fail("MISSING_TERMINAL", "A finished game must carry a terminal summary.");
  }
  if (!value.gameOver && value.terminal !== null) {
    fail("UNEXPECTED_TERMINAL", "An unfinished game cannot carry a terminal summary.");
  }
  const terminal = value.terminal === null ? null : cloneJson(value.terminal, "ruleState.terminal");
  return {
    stateVersion: TOPOLOGY_RULE_STATE_VERSION,
    rulesVersion: value.rulesVersion,
    currentPlayer: value.currentPlayer,
    startingVertices: starts,
    vertexStateById,
    logicPaths,
    historyHashes: [...historyHashes],
    superkoPolicy: "enforce",
    consecutivePasses,
    passHistory,
    resignedPlayers: [...resignedPlayers],
    gameOver: value.gameOver,
    terminal,
    turnCount: assertNonNegativeInteger(value.turnCount, "ruleState.turnCount"),
    positionRevision: assertNonNegativeInteger(value.positionRevision, "ruleState.positionRevision"),
  };
}

function stateDocumentFromCompiledBoard(compiledBoard, ruleState, limits) {
  const strategies = {
    movementStrategy: compiledBoard.rules.movementStrategy,
    territoryStrategy: compiledBoard.rules.territoryStrategy,
    specialVertexPolicy: compiledBoard.rules.specialVertexPolicy,
  };
  const normalizedRuleState = normalizeRuleState(ruleState, compiledBoard, limits);
  return {
    format: TOPOLOGY_STATE_FORMAT,
    schemaVersion: TOPOLOGY_STATE_SCHEMA_VERSION,
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    boardDefinition: cloneJson(compiledBoard.definition, "board.definition"),
    boardHash: compiledBoard.boardHash,
    strategies,
    ruleState: normalizedRuleState,
  };
}

function assertDocumentEnvelope(document, limits) {
  assertPlainObject(document, "topology state");
  assertOnlyKeys(document, STATE_KEYS, "topology state");
  assertRequiredKeys(document, STATE_KEYS, "topology state");
  if (document.format !== TOPOLOGY_STATE_FORMAT) fail("UNSUPPORTED_FORMAT", "Unsupported topology state format.");
  if (document.schemaVersion !== TOPOLOGY_STATE_SCHEMA_VERSION) {
    fail("UNSUPPORTED_STATE_SCHEMA", "Unsupported topology state schema version.");
  }
  if (document.contractVersion !== BOARD_TOPOLOGY_CONTRACT_VERSION) {
    fail("UNSUPPORTED_CONTRACT", "Topology contract version is unsupported.");
  }
  if (stateByteLength(document) > limits.maxStateBytes) {
    fail("LIMIT_EXCEEDED", "Topology state exceeds maxStateBytes.");
  }
}

function parseStateInput(json) {
  if (typeof json === "string") {
    try {
      return JSON.parse(json);
    } catch {
      fail("INVALID_JSON", "Topology state text is not valid JSON.");
    }
  }
  return json;
}

/**
 * Encode a compiled board plus explicit topology rule state into a pure JSON
 * document.  The function recompiles the supplied definition before emitting
 * anything, so a forged compiled object cannot be persisted.
 */
export function encodeTopologyState(board, ruleState, limits = {}) {
  const resolvedLimits = mergeLimits(limits);
  const compiledBoard = canonicalBoardFromInput(board, limits);
  const document = stateDocumentFromCompiledBoard(compiledBoard, ruleState, resolvedLimits);
  if (stateByteLength(document) > resolvedLimits.maxStateBytes) {
    fail("LIMIT_EXCEEDED", "Topology state exceeds maxStateBytes.");
  }
  return cloneJson(document, "topology state");
}

/**
 * Decode in isolation.  No caller-owned engine or state is mutated: the
 * returned CompiledBoard was rebuilt from the complete embedded definition.
 */
export function decodeTopologyState(json, limits = {}) {
  const resolvedLimits = mergeLimits(limits);
  const input = parseStateInput(json);
  assertDocumentEnvelope(input, resolvedLimits);
  const definitionClone = cloneJson(input.boardDefinition, "boardDefinition");
  const compiledBoard = compileOrThrow(definitionClone, limits);
  if (input.boardHash !== compiledBoard.boardHash) {
    fail("BOARD_HASH_MISMATCH", "Stored boardHash does not match the embedded definition.");
  }
  if (!sameJson(input.boardDefinition, compiledBoard.definition)) {
    fail("NONCANONICAL_DEFINITION", "Stored boardDefinition is not canonical; it cannot be silently rewritten.");
  }
  const strategies = normalizeStrategies(input.strategies, compiledBoard.rules);
  const ruleState = normalizeRuleState(input.ruleState, compiledBoard, resolvedLimits);
  return {
    format: TOPOLOGY_STATE_FORMAT,
    schemaVersion: TOPOLOGY_STATE_SCHEMA_VERSION,
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    board: compiledBoard,
    boardDefinition: cloneJson(compiledBoard.definition, "compiled definition"),
    boardHash: compiledBoard.boardHash,
    strategies,
    ruleState,
  };
}
