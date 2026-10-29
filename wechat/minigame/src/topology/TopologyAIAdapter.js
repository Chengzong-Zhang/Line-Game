import { compareStableIdentifiers } from "./BoardDefinition.js?v=20261029-topology-round5";

/**
 * Pure topology-board adapter for AI callers.
 *
 * This module deliberately does not search or evaluate a position.  It turns
 * the compiled canonical graph into a bounded, JSON-safe request and rejects
 * the legacy fixed-shape model route.  Strength is therefore outside this
 * adapter's contract: callers must explicitly provide a generic graph-aware
 * search implementation.
 */

export const TOPOLOGY_AI_ADAPTER_VERSION = "topology-ai-v1";
export const TOPOLOGY_AI_STATE_VERSION = "topology-ai-state-v1";
export const TOPOLOGY_AI_ROUTE = "topology-generic-search-v1";
export const TOPOLOGY_AI_PASS = "PASS";

const isPlainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function adapterError(code, location, detail = "") {
  return { code, location, detail };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function compiledSamples(board) {
  if (!isPlainObject(board) || typeof board.boardHash !== "string" || !board.boardHash) {
    throw new TypeError("A compiled board with a boardHash is required.");
  }
  if (!Array.isArray(board.sampleIds) || board.sampleIds.length === 0
    || board.sampleIds.some((id) => typeof id !== "string" || !id)) {
    throw new TypeError("Compiled board sampleIds must be non-empty canonical strings.");
  }
  const samples = new Set(board.sampleIds);
  if (samples.size !== board.sampleIds.length) {
    throw new TypeError("Compiled board sampleIds must be unique.");
  }
  if (!isPlainObject(board.sampleAdjacency) && !(board.sampleAdjacency instanceof Map)) {
    throw new TypeError("Compiled board sampleAdjacency is required.");
  }
  return samples;
}

function adjacencyValues(adjacency, id) {
  return adjacency instanceof Map ? adjacency.get(id) ?? [] : adjacency[id] ?? [];
}

function graphFor(board) {
  const samples = compiledSamples(board);
  const graph = new Map();
  for (const id of samples) {
    const values = adjacencyValues(board.sampleAdjacency, id);
    if (!Array.isArray(values)) throw new TypeError("sampleAdjacency." + id + " must be an array.");
    const seen = new Set();
    for (const neighbor of values) {
      if (typeof neighbor !== "string" || !samples.has(neighbor)) {
        throw new TypeError("sampleAdjacency." + id + " references an unknown sample.");
      }
      if (neighbor === id || seen.has(neighbor)) {
        throw new TypeError("sampleAdjacency." + id + " is not a simple graph neighborhood.");
      }
      seen.add(neighbor);
    }
    graph.set(id, [...seen].sort());
  }
  for (const [id, neighbors] of graph) {
    for (const neighbor of neighbors) {
      if (!graph.get(neighbor).includes(id)) {
        throw new TypeError("sampleAdjacency must be symmetric: " + id + " / " + neighbor);
      }
    }
  }
  return { samples, graph };
}

function normalizeCanonicalIds(value, samples, location, { allowPass = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(location + " must be an array.");
  const result = [];
  const seen = new Set();
  for (const id of value) {
    if (id === TOPOLOGY_AI_PASS && allowPass) {
      if (seen.has(id)) throw new TypeError(location + " contains duplicate PASS.");
      seen.add(id);
      result.push(id);
      continue;
    }
    if (typeof id !== "string" || !samples.has(id)) {
      throw new TypeError(location + " contains an unknown canonical vertex.");
    }
    if (seen.has(id)) throw new TypeError(location + " contains duplicate canonical vertices.");
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeCoverage(raw, samples) {
  if (!isPlainObject(raw)) throw new TypeError("coverageByPlayer must be a plain object.");
  const result = {};
  const owners = new Map();
  for (const playerId of Object.keys(raw).sort()) {
    if (typeof playerId !== "string" || !playerId) {
      throw new TypeError("coverageByPlayer has an invalid player identifier.");
    }
    const ids = normalizeCanonicalIds(raw[playerId], samples, "coverageByPlayer." + playerId);
    for (const id of ids) {
      const owner = owners.get(id);
      if (owner && owner !== playerId) {
        throw new TypeError("coverageByPlayer overlaps at " + id);
      }
      owners.set(id, playerId);
    }
    result[playerId] = ids.slice().sort();
  }
  return result;
}

function normalizeLogicalPaths(raw, samples) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new TypeError("logicalPathsByPlayer must be a plain object.");
  const result = {};
  for (const playerId of Object.keys(raw).sort()) {
    if (!Array.isArray(raw[playerId])) throw new TypeError("logicalPathsByPlayer." + playerId + " must be an array.");
    const ids = new Set();
    result[playerId] = raw[playerId].map((path, index) => {
      if (!isPlainObject(path) || typeof path.pathId !== "string" || !path.pathId) {
        throw new TypeError("logicalPathsByPlayer." + playerId + "[" + index + "].pathId is required.");
      }
      if (ids.has(path.pathId)) throw new TypeError("logicalPathsByPlayer." + playerId + " duplicates " + path.pathId);
      ids.add(path.pathId);
      const vertices = normalizeCanonicalIds(path.vertices, samples,
        "logicalPathsByPlayer." + playerId + "[" + index + "].vertices");
      if (vertices.length < 2) throw new TypeError("A logical path needs at least two vertices.");
      return { ...cloneJson(path), vertices };
    }).sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId));
  }
  return result;
}

/**
 * A product-facing capability description.  In particular, no old triangle
 * or hexagon model is allowed to masquerade as a topology-board policy.
 */
export function describeTopologyAI(board) {
  compiledSamples(board);
  const family = board.definition?.topology?.family ?? "unknown";
  return Object.freeze({
    adapterVersion: TOPOLOGY_AI_ADAPTER_VERSION,
    boardHash: board.boardHash,
    topologyFamily: family,
    route: TOPOLOGY_AI_ROUTE,
    requiresGenericGraphSearch: true,
    fixedShapeModelsAllowed: false,
    strengthVerified: false,
  });
}

/** Return finite unweighted graph distances over canonical topology samples. */
export function computeTopologyDistances(board, sourceVertexIds, options = {}) {
  const { samples, graph } = graphFor(board);
  const sources = normalizeCanonicalIds(sourceVertexIds, samples, "sourceVertexIds");
  const blocked = new Set(normalizeCanonicalIds(options.blockedVertexIds ?? [], samples, "blockedVertexIds"));
  const distances = Object.fromEntries([...samples].sort().map((id) => [id, null]));
  const queue = [];
  for (const source of sources) {
    if (blocked.has(source) || distances[source] !== null) continue;
    distances[source] = 0;
    queue.push(source);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const next of graph.get(current)) {
      if (blocked.has(next) || distances[next] !== null) continue;
      distances[next] = distances[current] + 1;
      queue.push(next);
    }
  }
  return distances;
}

/**
 * Produce a deterministic generic-search order.  This is a graph heuristic,
 * not a strength claim: shortest topology distance then local degree then ID.
 */
export function rankTopologyCandidates(board, legalMoveIds, options = {}) {
  const { samples, graph } = graphFor(board);
  const legal = normalizeCanonicalIds(legalMoveIds, samples, "legalMoveIds", { allowPass: true });
  const anchors = normalizeCanonicalIds(options.anchorVertexIds ?? [], samples, "anchorVertexIds");
  const distances = anchors.length ? computeTopologyDistances(board, anchors, {
    blockedVertexIds: options.blockedVertexIds ?? [],
  }) : Object.fromEntries([...samples].map((id) => [id, null]));
  const candidates = legal.filter((id) => id !== TOPOLOGY_AI_PASS).map((vertexId) => ({
    vertexId,
    distance: distances[vertexId],
    degree: graph.get(vertexId).length,
  })).sort((left, right) => {
    const leftDistance = left.distance ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distance ?? Number.POSITIVE_INFINITY;
    return leftDistance - rightDistance
      || right.degree - left.degree
      || compareStableIdentifiers(left.vertexId, right.vertexId);
  });
  if (legal.includes(TOPOLOGY_AI_PASS)) {
    candidates.push({ vertexId: TOPOLOGY_AI_PASS, distance: null, degree: 0, isPass: true });
  }
  return candidates;
}

/** Build a complete plain-JSON topology AI state from canonical identifiers. */
export function buildTopologyAIState(board, state) {
  const samples = compiledSamples(board);
  if (!isPlainObject(state)) throw new TypeError("state must be a plain object.");
  if (typeof state.rulesVersion !== "string" || !state.rulesVersion) {
    throw new TypeError("state.rulesVersion is required.");
  }
  if (!Number.isInteger(state.positionRevision) || state.positionRevision < 0) {
    throw new TypeError("state.positionRevision must be a non-negative integer.");
  }
  if (typeof state.currentPlayer !== "string" || !state.currentPlayer) {
    throw new TypeError("state.currentPlayer is required.");
  }
  const legalMoveIds = normalizeCanonicalIds(state.legalMoveIds ?? [], samples, "state.legalMoveIds", { allowPass: true });
  const coverageByPlayer = normalizeCoverage(state.coverageByPlayer ?? {}, samples);
  const logicalPathsByPlayer = normalizeLogicalPaths(state.logicalPathsByPlayer, samples);
  if (state.historyHashes != null && (!Array.isArray(state.historyHashes)
    || state.historyHashes.some((hash) => typeof hash !== "string" || !hash))) {
    throw new TypeError("state.historyHashes must be an array of non-empty strings.");
  }
  const definition = board.definition ?? null;
  if (!isPlainObject(definition)) throw new TypeError("Compiled board definition is required.");
  return {
    contractVersion: TOPOLOGY_AI_STATE_VERSION,
    boardHash: board.boardHash,
    boardDefinition: cloneJson(definition),
    rulesVersion: state.rulesVersion,
    positionRevision: state.positionRevision,
    currentPlayer: state.currentPlayer,
    legalMoveIds: [...legalMoveIds],
    coverageByPlayer,
    logicalPathsByPlayer,
    historyHashes: [...(state.historyHashes ?? [])].sort(),
  };
}

/**
 * Validate a worker/search request without accepting a legacy fixed-board
 * route.  The result is deliberately data-only so the caller can send stable
 * rejection reasons across main thread, Worker, and server boundaries.
 */
export function validateTopologyAIRequest(board, request, options = {}) {
  const errors = [];
  let samples;
  try {
    samples = compiledSamples(board);
  } catch (error) {
    return { ok: false, errors: [adapterError("INVALID_COMPILED_BOARD", "board", error.message)] };
  }
  if (!isPlainObject(request)) {
    return { ok: false, errors: [adapterError("INVALID_REQUEST", "$", "Expected a plain object.")] };
  }
  if (request.contractVersion !== TOPOLOGY_AI_ADAPTER_VERSION) {
    errors.push(adapterError("UNSUPPORTED_CONTRACT", "contractVersion", TOPOLOGY_AI_ADAPTER_VERSION));
  }
  if (request.boardHash !== board.boardHash) {
    errors.push(adapterError("BOARD_HASH_MISMATCH", "boardHash", String(request.boardHash ?? "")));
  }
  if (typeof request.rulesVersion !== "string" || !request.rulesVersion) {
    errors.push(adapterError("MISSING_RULES_VERSION", "rulesVersion"));
  } else if (options.rulesVersion && request.rulesVersion !== options.rulesVersion) {
    errors.push(adapterError("RULES_VERSION_MISMATCH", "rulesVersion", request.rulesVersion));
  }
  if (!Number.isInteger(request.positionRevision) || request.positionRevision < 0) {
    errors.push(adapterError("INVALID_POSITION_REVISION", "positionRevision"));
  } else if (Number.isInteger(options.positionRevision)
    && request.positionRevision !== options.positionRevision) {
    errors.push(adapterError("POSITION_REVISION_MISMATCH", "positionRevision", String(request.positionRevision)));
  }
  if (typeof request.currentPlayer !== "string" || !request.currentPlayer) {
    errors.push(adapterError("MISSING_CURRENT_PLAYER", "currentPlayer"));
  } else if (options.currentPlayer && request.currentPlayer !== options.currentPlayer) {
    errors.push(adapterError("CURRENT_PLAYER_MISMATCH", "currentPlayer", request.currentPlayer));
  }
  if (request.modelRoute != null && request.modelRoute !== TOPOLOGY_AI_ROUTE) {
    errors.push(adapterError("LEGACY_FIXED_SHAPE_ROUTE", "modelRoute", String(request.modelRoute)));
  }
  let legalMoveIds = null;
  try {
    legalMoveIds = normalizeCanonicalIds(request.legalMoveIds, samples, "legalMoveIds", { allowPass: true });
  } catch (error) {
    errors.push(adapterError("INVALID_LEGAL_MOVES", "legalMoveIds", error.message));
  }
  let state = null;
  try {
    state = buildTopologyAIState(board, request.state);
  } catch (error) {
    errors.push(adapterError("INVALID_TOPOLOGY_STATE", "state", error.message));
  }
  if (state && state.boardHash !== request.boardHash) {
    errors.push(adapterError("STATE_BOARD_HASH_MISMATCH", "state.boardHash", state.boardHash));
  }
  if (state && (state.rulesVersion !== request.rulesVersion
    || state.positionRevision !== request.positionRevision
    || state.currentPlayer !== request.currentPlayer)) {
    errors.push(adapterError("STATE_REQUEST_MISMATCH", "state",
      "rulesVersion, positionRevision and currentPlayer must match the request."));
  }
  if (state && legalMoveIds && JSON.stringify(state.legalMoveIds) !== JSON.stringify(legalMoveIds)) {
    errors.push(adapterError("STATE_LEGAL_MOVES_MISMATCH", "state.legalMoveIds"));
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ...cloneJson(request), legalMoveIds, state }, errors: [] };
}
