import {
  compareStableIdentifiers,
  sha256Hex,
  TRIANGULAR_UNIT_DIRECTIONS,
  triangularDirectionIndex,
  undirectedKey,
} from "./BoardDefinition.js?v=20261029-topology-round5";

export const PATH_RULE_VERSION = "simple-rays-v1";
export const RayStopReason = Object.freeze({
  REAL_BOUNDARY: "REAL_BOUNDARY",
  BLOCKED: "BLOCKED",
  REPEATED_STATE: "REPEATED_STATE",
  SPECIAL_VERTEX: "SPECIAL_VERTEX",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  NO_CONTINUATION: "NO_CONTINUATION",
});

function pathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function coordinateKey(coordinate) {
  return coordinate[0] + "," + coordinate[1];
}

function rawEdgeKey(left, right) {
  return undirectedKey(left, right);
}

// Isometrically unfold the glued triangles. Map the source edge tangent to
// its endpoint-mapped target tangent; map the source exterior to the target
// interior. Direction indices increase cyclically by 60 degrees.
function unfoldedDirection(index, transition, directionIndex) {
  const source = transition.sourceFaceSide;
  const target = transition.targetFaceSide;
  const coordinate = id => index.rawCoordinates.get(id);
  const s0 = coordinate(source.orientedVertices[0]);
  const s1 = coordinate(source.orientedVertices[1]);
  const t0 = coordinate(target.orientedVertices[transition.endpointMap[0]]);
  const t1 = coordinate(target.orientedVertices[transition.endpointMap[1]]);
  const si = coordinate(source.interiorVertexId);
  const ti = coordinate(target.interiorVertexId);
  const tangent = (a, b) => triangularDirectionIndex(a, b);
  const side = (a, b, p) => Math.sign((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]));
  const s = tangent(s0, s1), t = tangent(t0, t1);
  const orientation = side(s0, s1, si) === side(t0, t1, ti) ? -1 : 1;
  return ((t + orientation * (directionIndex - s)) % 6 + 6) % 6;
}

function deepCloneCoverage(position) {
  return Object.fromEntries(Object.entries(position.coverageByPlayer)
    .map(([playerId, vertexIds]) => [playerId, [...vertexIds]]));
}

/**
 * Position is deliberately independent from GameEngine:
 *
 * {
 *   coverageByPlayer: {
 *     BLACK: ["cv:0", "cv:4"],
 *     WHITE: ["cv:2"]
 *   }
 * }
 *
 * Every listed identifier is a canonical vertex/sample ID. A value represents
 * all node/line coverage of that player, so an overlap is invalid upstream state.
 */
export function normalizeTopologyPosition(board, position) {
  if (!isPlainObject(position) || !isPlainObject(position.coverageByPlayer)) {
    throw pathError("INVALID_POSITION", "Position requires a coverageByPlayer object.");
  }
  const sampleIds = new Set(board.sampleIds ?? []);
  const ownerByVertexId = new Map();
  const normalized = {};
  for (const [playerId, coverage] of Object.entries(position.coverageByPlayer)) {
    if (typeof playerId !== "string" || !Array.isArray(coverage)) {
      throw pathError("INVALID_POSITION", "Each player coverage must be an array.");
    }
    const seen = new Set();
    normalized[playerId] = [];
    for (const vertexId of coverage) {
      if (typeof vertexId !== "string" || !sampleIds.has(vertexId)) {
        throw pathError("UNKNOWN_POSITION_VERTEX", "Unknown canonical vertex: " + vertexId);
      }
      if (seen.has(vertexId)) {
        throw pathError("DUPLICATE_POSITION_COVERAGE", "Duplicate coverage for " + vertexId);
      }
      seen.add(vertexId);
      const existingOwner = ownerByVertexId.get(vertexId);
      if (existingOwner && existingOwner !== playerId) {
        throw pathError("POSITION_OVERLAP", "Multiple players cover " + vertexId);
      }
      ownerByVertexId.set(vertexId, playerId);
      normalized[playerId].push(vertexId);
    }
  }
  return { position: { coverageByPlayer: normalized }, ownerByVertexId };
}

function normalizeDirectionState(directionState) {
  const value = Number.isInteger(directionState)
    ? { directionIndex: directionState }
    : directionState;
  if (!isPlainObject(value) || !Number.isInteger(value.directionIndex)
    || value.directionIndex < 0 || value.directionIndex >= TRIANGULAR_UNIT_DIRECTIONS.length) {
    throw pathError("INVALID_DIRECTION_STATE", "directionState must be 0..5 or an object with directionIndex.");
  }
  if (value.atlasVertexId != null && typeof value.atlasVertexId !== "string") {
    throw pathError("INVALID_DIRECTION_STATE", "atlasVertexId must be a source vertex id.");
  }
  if (value.maxSteps != null && (!Number.isInteger(value.maxSteps) || value.maxSteps < 1)) {
    throw pathError("INVALID_DIRECTION_STATE", "maxSteps must be a positive integer.");
  }
  return {
    directionIndex: value.directionIndex,
    atlasVertexId: value.atlasVertexId ?? null,
    maxSteps: value.maxSteps ?? null,
  };
}

const traversalIndexCache = new WeakMap();

function buildTraversalIndex(board) {
  if (!board?.definition || !Array.isArray(board.definition.vertices)
    || !Array.isArray(board.definition.faces) || !board.rawVertexToCanonical) {
    throw pathError("INVALID_COMPILED_BOARD", "A compiled board-definition-v1 board is required.");
  }
  const cached = traversalIndexCache.get(board);
  if (cached) return cached;
  const rawCoordinates = new Map();
  const rawVertexByCoordinate = new Map();
  for (const vertex of board.definition.vertices) {
    rawCoordinates.set(vertex.id, vertex.coordinate);
    rawVertexByCoordinate.set(coordinateKey(vertex.coordinate), vertex.id);
  }
  const rawAdjacency = new Map(board.definition.vertices.map((vertex) => [vertex.id, new Set()]));
  const rawEdgeOccurrences = new Map();
  for (const occurrence of board.edgeOccurrences ?? []) {
    const [left, right] = occurrence.vertices;
    rawAdjacency.get(left)?.add(right);
    rawAdjacency.get(right)?.add(left);
    const key = rawEdgeKey(left, right);
    const values = rawEdgeOccurrences.get(key) ?? [];
    values.push(occurrence.id);
    rawEdgeOccurrences.set(key, values);
  }
  for (const values of rawEdgeOccurrences.values()) values.sort();
  const rawCopiesByCanonical = new Map();
  for (const [rawVertexId, canonicalVertexId] of Object.entries(board.rawVertexToCanonical)) {
    const values = rawCopiesByCanonical.get(canonicalVertexId) ?? [];
    values.push(rawVertexId);
    rawCopiesByCanonical.set(canonicalVertexId, values);
  }
  for (const values of rawCopiesByCanonical.values()) values.sort();
  const seamExits = new Map();
  for (const transition of board.directionTransitions ?? []) {
    for (const rule of transition.endpointTransport ?? []) {
      const sourceRawVertexId = transition.sourceFaceSide?.orientedVertices?.[rule.sourceEndpointIndex];
      const targetRawVertexId = transition.targetFaceSide?.orientedVertices?.[rule.targetEndpointIndex];
      if (!sourceRawVertexId || !targetRawVertexId) continue;
      const key = sourceRawVertexId + "|" + rule.sourceExitDirectionIndex;
      const values = seamExits.get(key) ?? [];
      values.push({
        transition,
        rule,
        sourceRawVertexId,
        targetRawVertexId,
      });
      seamExits.set(key, values);
    }
  }
  const index = {
    rawCoordinates,
    rawVertexByCoordinate,
    rawAdjacency,
    rawEdgeOccurrences,
    rawCopiesByCanonical,
    seamExits,
    realBoundary: new Set(board.realBoundarySampleIds ?? []),
    specialVertices: new Set((board.specialVertices ?? []).map((vertex) => vertex.id)),
    stopOnEntry: new Set((board.specialVertices ?? []).filter(v => !v.manifold || (v.kind === "cycle" && v.incidentEdgeClassCount !== 6)).map(v => v.id)),
  };
  // Compiled boards are immutable. Do not cache caller-created mutable boards.
  if (Object.isFrozen(board)) traversalIndexCache.set(board, index);
  return index;
}

export function transportDirectionAcrossSeam(board, transition, directionIndex) {
  if (!Number.isInteger(directionIndex) || directionIndex < 0 || directionIndex >= 6) {
    throw pathError("INVALID_DIRECTION_STATE", "directionIndex must be 0..5.");
  }
  return unfoldedDirection(buildTraversalIndex(board), transition, directionIndex);
}

function regularStep(index, rawVertexId, directionIndex) {
  const coordinate = index.rawCoordinates.get(rawVertexId);
  const [dx, dy] = TRIANGULAR_UNIT_DIRECTIONS[directionIndex];
  const nextRawVertexId = index.rawVertexByCoordinate.get(coordinateKey([coordinate[0] + dx, coordinate[1] + dy]));
  if (!nextRawVertexId || !index.rawAdjacency.get(rawVertexId)?.has(nextRawVertexId)) return null;
  const occurrenceIds = index.rawEdgeOccurrences.get(rawEdgeKey(rawVertexId, nextRawVertexId)) ?? [];
  return { nextRawVertexId, occurrenceIds };
}

function continuationKind(index, rawVertexId, directionIndex) {
  const direct = regularStep(index, rawVertexId, directionIndex);
  if (direct) return { kind: "regular", ...direct };
  const exits = index.seamExits.get(rawVertexId + "|" + directionIndex) ?? [];
  if (exits.length === 1) return { kind: "seam", ...exits[0] };
  if (exits.length > 1) return { kind: "ambiguous-seam" };
  return { kind: "none" };
}

function selectInitialRawCopy(board, index, canonicalVertexId, direction) {
  if (direction.atlasVertexId != null) {
    if (board.rawVertexToCanonical[direction.atlasVertexId] !== canonicalVertexId) {
      throw pathError("INVALID_ATLAS_VERTEX", "atlasVertexId is not a copy of " + canonicalVertexId);
    }
    return direction.atlasVertexId;
  }
  const copies = index.rawCopiesByCanonical.get(canonicalVertexId) ?? [];
  const candidates = copies.filter((rawVertexId) =>
    continuationKind(index, rawVertexId, direction.directionIndex).kind !== "none",
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 && copies.length === 1) return copies[0];
  if (candidates.length === 0 && copies.length > 1) {
    throw pathError("AMBIGUOUS_ATLAS_COPY", "No direction-selectable atlas copy exists for " + canonicalVertexId);
  }
  throw pathError("AMBIGUOUS_ATLAS_COPY",
    "Multiple atlas copies could continue; provide directionState.atlasVertexId.");
}

function defaultStepBudget(board) {
  return Math.max(1, (board.sampleIds?.length ?? 1) * TRIANGULAR_UNIT_DIRECTIONS.length
    + (board.directionTransitions?.length ?? 0) * 2);
}

function stopResult({
  vertices,
  edgeOccurrences,
  seamCrossings,
  stopReason,
  steps,
  blockedVertexId = null,
  blockedByPlayerId = null,
}) {
  return {
    vertices,
    edgeOccurrences,
    seamCrossings,
    stopReason,
    steps,
    ...(blockedVertexId ? { blockedVertexId } : {}),
    ...(blockedByPlayerId ? { blockedByPlayerId } : {}),
  };
}

/**
 * Trace a single directed ray without mutating board or position. Vertex ids
 * are canonical; directionState may optionally select an atlas copy.
 */
export function traceRay(board, position, fromVertexId, directionState) {
  const normalizedPosition = normalizeTopologyPosition(board, position);
  const direction = normalizeDirectionState(directionState);
  if (!(board.sampleIds ?? []).includes(fromVertexId)) {
    throw pathError("UNKNOWN_START_VERTEX", "Unknown canonical start: " + fromVertexId);
  }
  const index = buildTraversalIndex(board);
  const maxSteps = direction.maxSteps ?? defaultStepBudget(board);
  let rawVertexId;
  try {
    rawVertexId = selectInitialRawCopy(board, index, fromVertexId, direction);
  } catch (error) {
    if (error?.code === "AMBIGUOUS_ATLAS_COPY") {
      return stopResult({
        vertices: [fromVertexId],
        edgeOccurrences: [],
        seamCrossings: [],
        stopReason: RayStopReason.SPECIAL_VERTEX,
        steps: 0,
      });
    }
    throw error;
  }
  let canonicalVertexId = fromVertexId;
  let currentDirection = direction.directionIndex;
  const vertices = [canonicalVertexId];
  const edgeOccurrences = [];
  const seamCrossings = [];
  const visitedStates = new Set();
  let steps = 0;

  while (steps < maxSteps) {
    const stateKey = canonicalVertexId + "|" + rawVertexId + "|" + currentDirection;
    if (visitedStates.has(stateKey)) {
      return stopResult({ vertices, edgeOccurrences, seamCrossings,
        stopReason: RayStopReason.REPEATED_STATE, steps });
    }
    visitedStates.add(stateKey);
    const continuation = continuationKind(index, rawVertexId, currentDirection);
    if (continuation.kind === "regular") {
      steps += 1;
      rawVertexId = continuation.nextRawVertexId;
      canonicalVertexId = board.rawVertexToCanonical[rawVertexId];
      edgeOccurrences.push(...continuation.occurrenceIds);
      vertices.push(canonicalVertexId);
      const owner = normalizedPosition.ownerByVertexId.get(canonicalVertexId);
      if (owner) {
        return stopResult({ vertices, edgeOccurrences, seamCrossings,
          stopReason: RayStopReason.BLOCKED, steps,
          blockedVertexId: canonicalVertexId, blockedByPlayerId: owner });
      }
      if (index.stopOnEntry.has(canonicalVertexId)) {
        return stopResult({ vertices, edgeOccurrences, seamCrossings,
          stopReason: RayStopReason.SPECIAL_VERTEX, steps });
      }
      continue;
    }
    if (continuation.kind === "seam") {
      steps += 1;
      const { transition, rule, sourceRawVertexId, targetRawVertexId } = continuation;
      seamCrossings.push({
        fromEdgeOccurrenceId: transition.fromEdgeOccurrenceId,
        toEdgeOccurrenceId: transition.toEdgeOccurrenceId,
        sourceVertexId: sourceRawVertexId,
        targetVertexId: targetRawVertexId,
        sourceEndpointIndex: rule.sourceEndpointIndex,
        targetEndpointIndex: rule.targetEndpointIndex,
        sourceDirectionState: rule.sourceExitDirectionIndex,
        targetDirectionState: rule.targetEntryDirectionIndex,
      });
      rawVertexId = targetRawVertexId;
      canonicalVertexId = board.rawVertexToCanonical[rawVertexId];
      currentDirection = board.definition.topology.movementStrategy === "simple-rays-v3"
        ? unfoldedDirection(index, transition, currentDirection) : rule.targetEntryDirectionIndex;
      seamCrossings[seamCrossings.length - 1].targetDirectionState = currentDirection;
      continue;
    }
    if (continuation.kind === "ambiguous-seam") {
      return stopResult({ vertices, edgeOccurrences, seamCrossings,
        stopReason: RayStopReason.SPECIAL_VERTEX, steps });
    }
    if (index.realBoundary.has(canonicalVertexId)) {
      return stopResult({ vertices, edgeOccurrences, seamCrossings,
        stopReason: RayStopReason.REAL_BOUNDARY, steps });
    }
    if (index.specialVertices.has(canonicalVertexId)) {
      return stopResult({ vertices, edgeOccurrences, seamCrossings,
        stopReason: RayStopReason.SPECIAL_VERTEX, steps });
    }
    return stopResult({ vertices, edgeOccurrences, seamCrossings,
      stopReason: RayStopReason.NO_CONTINUATION, steps });
  }
  return stopResult({ vertices, edgeOccurrences, seamCrossings,
    stopReason: RayStopReason.BUDGET_EXCEEDED, steps });
}

function reverseSeamCrossingKey(crossing) {
  return crossing.toEdgeOccurrenceId + ">" + crossing.fromEdgeOccurrenceId
    + "@" + crossing.targetVertexId + ":" + crossing.sourceVertexId;
}

function pathFingerprint(connection) {
  const forward = [
    connection.vertices.join(">"),
    connection.edgeOccurrences.join(","),
    connection.seamCrossings.map((crossing) =>
      crossing.fromEdgeOccurrenceId + ">" + crossing.toEdgeOccurrenceId
        + "@" + crossing.sourceVertexId + ":" + crossing.targetVertexId).join(","),
  ].join("|");
  const reverse = [
    [...connection.vertices].reverse().join(">"),
    [...connection.edgeOccurrences].reverse().join(","),
    [...connection.seamCrossings].reverse().map(reverseSeamCrossingKey).join(","),
  ].join("|");
  return forward < reverse ? forward : reverse;
}

// Atlas occurrences on a paired seam (and the two face occurrences of an
// interior edge) represent the same physical edge. Keep the full edge-class
// sequence and canonical vertices: endpoints alone would collapse genuinely
// different routes around a cylinder. Seam transport before the first edge is
// merely a choice of atlas copy, not a second physical path.
const edgeClassIndexCache = new WeakMap();
export function physicalPathKey(board, connection) {
  let classByOccurrence = edgeClassIndexCache.get(board);
  if (!classByOccurrence) {
    classByOccurrence = new Map();
    for (const edgeClass of board.edgeClasses ?? []) {
      for (const occurrence of edgeClass.occurrences ?? []) classByOccurrence.set(occurrence.id, edgeClass.id);
    }
    if (Object.isFrozen(board)) edgeClassIndexCache.set(board, classByOccurrence);
  }
  const classes = [];
  for (const occurrenceId of connection.edgeOccurrences ?? []) {
    const id = classByOccurrence.get(occurrenceId) ?? occurrenceId;
    if (classes[classes.length - 1] !== id) classes.push(id);
  }
  const vertices = connection.vertices ?? [];
  const forward = JSON.stringify([vertices, classes]);
  const reverse = JSON.stringify([[...vertices].reverse(), [...classes].reverse()]);
  return forward < reverse ? forward : reverse;
}

function pendingPlacementPosition(position, playerId, newVertexId) {
  const coverageByPlayer = deepCloneCoverage(position);
  const coverage = coverageByPlayer[playerId] ?? [];
  if (!coverage.includes(newVertexId)) coverage.push(newVertexId);
  coverageByPlayer[playerId] = coverage;
  return { coverageByPlayer };
}

/**
 * Enumerate every simple directed ray from a pending move that reaches an
 * already-covered own vertex. Different seam routes remain distinct pathIds;
 * exact reverse duplicates collapse to one connection.
 */
export function enumerateConnections(board, position, newVertexId, playerId, options = {}) {
  if (typeof playerId !== "string" || !playerId) {
    throw pathError("INVALID_PLAYER", "playerId must be a non-empty string.");
  }
  const normalizedPosition = normalizeTopologyPosition(board, position);
  if (!(board.sampleIds ?? []).includes(newVertexId)) {
    throw pathError("UNKNOWN_START_VERTEX", "Unknown canonical start: " + newVertexId);
  }
  if (normalizedPosition.ownerByVertexId.has(newVertexId)) return [];
  const connections = [];
  const fingerprints = new Set();
  // Only nodes are logical endpoints. Friendly lines and intermediate nodes do
  // not block a connection; every enemy element does. Keep the legacy API's
  // coverage-only meaning for callers which do not provide node identities.
  const ownTargets = position.nodesByPlayer?.[playerId]
    ?? normalizedPosition.position.coverageByPlayer[playerId] ?? [];
  const copies = board.canonicalVertices.find((vertex) => vertex.id === newVertexId)?.sourceVertexIds ?? [];
  for (const target of ownTargets) {
    if (target === newVertexId) continue;
    if (!normalizedPosition.position.coverageByPlayer[playerId]?.includes(target)) {
      throw pathError("INVALID_POSITION", "A node must be covered by its owner: " + target);
    }
    const coverageByPlayer = Object.fromEntries(Object.entries(normalizedPosition.position.coverageByPlayer)
      .map(([owner, coverage]) => [owner, owner === playerId ? [target] : [...coverage]]));
    const pending = pendingPlacementPosition({ coverageByPlayer }, playerId, newVertexId);
    for (const atlasVertexId of copies) {
      for (let directionIndex = 0; directionIndex < TRIANGULAR_UNIT_DIRECTIONS.length; directionIndex += 1) {
        const trace = traceRay(board, pending, newVertexId, { directionIndex, atlasVertexId });
        if (trace.stopReason !== RayStopReason.BLOCKED
          || trace.blockedByPlayerId !== playerId
          || trace.blockedVertexId !== target) continue;
        const connection = {
          startVertexId: newVertexId,
          endVertexId: trace.blockedVertexId,
          vertices: [...trace.vertices],
          edgeOccurrences: [...trace.edgeOccurrences],
          seamCrossings: trace.seamCrossings.map((crossing) => ({ ...crossing })),
          directionState: directionIndex,
        };
        const fingerprint = pathFingerprint(connection);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        connection.pathId = "path:v1:" + sha256Hex(fingerprint).slice(0, 24);
        connections.push(connection);
      }
    }
  }
  connections.sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId));
  const strategy = board.definition.topology.movementStrategy;
  if ((strategy !== "simple-rays-v2" && strategy !== "simple-rays-v3") || options.geometryOnly) return connections;
  // Version 2 prevents a new line from crossing an existing friendly line or
  // passing through another friendly node. The placement itself may be on a
  // line, including an enemy line being cut; only the interior is restricted.
  const covered = new Set(normalizedPosition.position.coverageByPlayer[playerId] ?? []);
  const selected = [];
  const occupied = new Set();
  const interiors = new Set();
  const physicalPaths = new Set();
  for (const connection of connections) {
    const tail = connection.vertices.slice(1);
    const inner = connection.vertices.slice(1, -1);
    if (new Set(connection.vertices).size !== connection.vertices.length) continue;
    if (inner.some(id => covered.has(id))) continue;
    // Multiple rays from the same placement can wrap and meet again on a
    // quotient. Resolve them deterministically without creating a crossing.
    if (inner.some(id => occupied.has(id)) || interiors.has(connection.endVertexId)) continue;
    const physicalKey = strategy === "simple-rays-v3" ? physicalPathKey(board, connection) : null;
    if (physicalKey != null && physicalPaths.has(physicalKey)) continue;
    selected.push(connection);
    if (physicalKey != null) physicalPaths.add(physicalKey);
    for (const id of tail) occupied.add(id);
    for (const id of inner) interiors.add(id);
  }
  return selected;
}

export function indexConnectionCoverage(connections) {
  const byVertexId = {};
  const byEdgeOccurrenceId = {};
  for (const connection of connections) {
    for (const vertexId of connection.vertices) {
      const values = byVertexId[vertexId] ?? [];
      values.push(connection.pathId);
      byVertexId[vertexId] = values;
    }
    for (const edgeOccurrenceId of connection.edgeOccurrences) {
      const values = byEdgeOccurrenceId[edgeOccurrenceId] ?? [];
      values.push(connection.pathId);
      byEdgeOccurrenceId[edgeOccurrenceId] = values;
    }
  }
  for (const values of Object.values(byVertexId)) values.sort();
  for (const values of Object.values(byEdgeOccurrenceId)) values.sort();
  return { byVertexId, byEdgeOccurrenceId };
}
