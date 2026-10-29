import { compareStableIdentifiers } from "./BoardDefinition.js?v=20261029-unified-r1";
import { buildTopologyTerritoryDisplay } from "./TerritoryDisplay.js?v=20261029-unified-r1";
import { expandPathEdgeOccurrences } from "./BoardPathProjection.js?v=20261029-unified-r1";

export const BOARD_VIEW_CONTRACT_VERSION = "board-topology-v1";

const cloneCoordinate = (coordinate) => [coordinate[0], coordinate[1]];

function axialToPlane(coordinate) {
  return [coordinate[0] + coordinate[1] * 0.5, coordinate[1] * Math.sqrt(3) / 2];
}

function getPointCopies(board) {
  const copies = board?.pointCopies ?? board?.atlas?.pointCopies ?? [];
  if (!Array.isArray(copies)) throw new TypeError("Compiled board pointCopies must be an array.");
  return copies;
}

function makeProjector(viewOptions = {}) {
  const scale = Number.isFinite(viewOptions.scale) ? viewOptions.scale : 1;
  const offset = Array.isArray(viewOptions.offset) && viewOptions.offset.length === 2
    ? viewOptions.offset
    : [0, 0];
  const customProjector = typeof viewOptions.projectCoordinate === "function"
    ? viewOptions.projectCoordinate
    : null;
  return (coordinate, pointCopy) => {
    const raw = customProjector ? customProjector(coordinate, pointCopy) : axialToPlane(coordinate);
    return {
      x: raw[0] * scale + offset[0],
      y: raw[1] * scale + offset[1],
    };
  };
}

function normalizePointCopies(board, viewOptions) {
  const project = makeProjector(viewOptions);
  const ids = new Set();
  return getPointCopies(board).map((copy, index) => {
    if (!copy || typeof copy.canonicalVertexId !== "string" || !Array.isArray(copy.coordinate)) {
      throw new TypeError("Every atlas point copy needs canonicalVertexId and coordinate.");
    }
    const id = copy.id ?? "copy:" + index;
    if (ids.has(id)) throw new TypeError("Atlas point copy identifiers must be unique.");
    ids.add(id);
    return {
      id,
      canonicalVertexId: copy.canonicalVertexId,
      // A source vertex identifies the concrete atlas copy.  It is display
      // metadata only: rules and hit tests still return canonical IDs.
      sourceVertexId: typeof copy.sourceVertexId === "string" ? copy.sourceVertexId : null,
      chartId: copy.chartId ?? "chart:0",
      coordinate: cloneCoordinate(copy.coordinate),
      ...project(copy.coordinate, copy),
    };
  });
}

function indexCopies(pointCopies) {
  const byId = new Map();
  const byCanonicalVertex = new Map();
  const bySourceVertex = new Map();
  for (const copy of pointCopies) {
    byId.set(copy.id, copy);
    const list = byCanonicalVertex.get(copy.canonicalVertexId) ?? [];
    list.push(copy);
    byCanonicalVertex.set(copy.canonicalVertexId, list);
    if (copy.sourceVertexId) bySourceVertex.set(copy.sourceVertexId, copy);
  }
  for (const copies of byCanonicalVertex.values()) copies.sort((left, right) =>
    compareStableIdentifiers(left.id, right.id));
  return { byId, byCanonicalVertex, bySourceVertex };
}

function resolveCopy(index, canonicalVertexId, requestedCopyId = null) {
  const copy = requestedCopyId ? index.byId.get(requestedCopyId) : index.byCanonicalVertex.get(canonicalVertexId)?.[0];
  if (!copy) throw new TypeError("Path or segment references an atlas copy that is not present.");
  if (canonicalVertexId && copy.canonicalVertexId !== canonicalVertexId) {
    throw new TypeError("Atlas copy does not represent the requested canonical vertex.");
  }
  return copy;
}

function projectSegments(board, index) {
  const sourceSegments = board?.realBoundarySegments ?? board?.boundarySegments ?? [];
  if (!Array.isArray(sourceSegments)) throw new TypeError("Compiled board boundary segments must be an array.");
  return sourceSegments.map((segment, position) => {
    const endpoints = segment.copyIds ?? [];
    const fromId = segment.fromCopyId ?? endpoints[0] ?? null;
    const toId = segment.toCopyId ?? endpoints[1] ?? null;
    const from = resolveCopy(index, segment.fromCanonicalVertexId ?? null, fromId);
    const to = resolveCopy(index, segment.toCanonicalVertexId ?? null, toId);
    return {
      id: segment.id ?? "boundary:" + position,
      fromCopyId: from.id,
      toCopyId: to.id,
      fromCanonicalVertexId: from.canonicalVertexId,
      toCanonicalVertexId: to.canonicalVertexId,
      from: [from.x, from.y],
      to: [to.x, to.y],
    };
  });
}

function projectSeamMarkers(board, index) {
  const markers = board?.seamMarkers ?? board?.seamPairs ?? [];
  if (!Array.isArray(markers)) throw new TypeError("Compiled board seam markers must be an array.");
  return markers.map((marker, position) => {
    const copyIds = marker.copyIds ?? [];
    const anchors = copyIds.map((copyId) => {
      const copy = resolveCopy(index, null, copyId);
      return {
        copyId: copy.id,
        canonicalVertexId: copy.canonicalVertexId,
        point: [copy.x, copy.y],
      };
    });
    return {
      id: marker.id ?? "seam:" + position,
      edgeOccurrenceA: marker.edgeOccurrenceA ?? null,
      edgeOccurrenceB: marker.edgeOccurrenceB ?? null,
      endpointMap: marker.endpointMap ? [...marker.endpointMap] : null,
      label: marker.label ?? marker.id ?? "seam:" + position,
      anchors,
    };
  });
}

export function projectBoard(board, viewOptions = {}) {
  const pointCopies = normalizePointCopies(board, viewOptions);
  const index = indexCopies(pointCopies);
  return {
    contractVersion: BOARD_VIEW_CONTRACT_VERSION,
    pointCopies,
    boundarySegments: projectSegments(board, index),
    seamMarkers: projectSeamMarkers(board, index),
  };
}

export function hitTestBoard(projectedBoard, point, options = {}) {
  if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  const radius = Number.isFinite(options.radius) && options.radius >= 0 ? options.radius : 16;
  const radiusSquared = radius * radius;
  let nearest = null;
  for (const copy of projectedBoard?.pointCopies ?? []) {
    const distanceSquared = (copy.x - point[0]) ** 2 + (copy.y - point[1]) ** 2;
    if (distanceSquared > radiusSquared) continue;
    if (!nearest || distanceSquared < nearest.distanceSquared
      || (distanceSquared === nearest.distanceSquared
        && compareStableIdentifiers(copy.id, nearest.copy.id) < 0)) {
      nearest = { copy, distanceSquared };
    }
  }
  return nearest?.copy.canonicalVertexId ?? null;
}

export function projectPath(board, connection, viewOptions = {}) {
  const projected = projectBoard(board, viewOptions);
  const index = indexCopies(projected.pointCopies);
  const vertices = connection?.vertices ?? connection?.vertexIds ?? [];
  if (!Array.isArray(vertices) || vertices.length < 2) return [];
  // Actual traced paths retain the atlas edge occurrences traversed. Drawing
  // those concrete local edges avoids choosing the wrong canonical copy near
  // a seam; a seam crossing itself is an identification, never a long chord.
  if (Array.isArray(connection.edgeOccurrences) && connection.edgeOccurrences.length) {
    const edges = new Map((board.displayEdges ?? []).map((edge) => [edge.id, edge]));
    return expandPathEdgeOccurrences(board, connection.edgeOccurrences).map((id) => {
      const edge = edges.get("guide:" + id) ?? edges.get(id);
      const copyIds = edge?.copyIds ?? [edge?.fromCopyId, edge?.toCopyId];
      if (!edge || copyIds.length !== 2 || copyIds.some((copyId) => !index.byId.has(copyId))) {
        throw new TypeError("A path edge occurrence is missing from the atlas.");
      }
      const copies = copyIds.map((copyId) => index.byId.get(copyId));
      return { pathId: connection.pathId ?? null, sourceVertexIds: copies.map((copy) => copy.canonicalVertexId), copyIds, points: copies.map((copy) => [copy.x, copy.y]), seamAfter: null };
    });
  }
  const crossingsByIndex = new Map();
  let nextSearchIndex = 0;
  for (const crossing of connection?.seamCrossings ?? []) {
    let edgeIndex = crossing.afterVertexIndex ?? crossing.edgeIndex;
    if (!Number.isInteger(edgeIndex) && typeof crossing.sourceVertexId === "string") {
      const sourceCopy = index.bySourceVertex.get(crossing.sourceVertexId);
      if (sourceCopy) {
        edgeIndex = -1;
        for (let indexAfter = nextSearchIndex; indexAfter < vertices.length - 1; indexAfter += 1) {
          if (vertices[indexAfter] === sourceCopy.canonicalVertexId) {
            edgeIndex = indexAfter;
            nextSearchIndex = indexAfter + 1;
            break;
          }
        }
      }
    }
    if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= vertices.length - 1) {
      throw new TypeError("A seam crossing must identify an edge of the logical path.");
    }
    if (crossingsByIndex.has(edgeIndex)) throw new TypeError("A logical edge can cross at most one seam in one step.");
    crossingsByIndex.set(edgeIndex, crossing);
  }
  const copyIds = connection?.copyIds ?? [];
  const copyFor = (vertexId, preferredCopyId) => resolveCopy(index, vertexId, preferredCopyId);
  const sourceCopyFor = (sourceVertexId) => index.bySourceVertex.get(sourceVertexId) ?? null;
  let current = [copyFor(vertices[0], copyIds[0] ?? null)];
  const drawSegments = [];
  const appendCurrent = (seamAfter = null) => {
    if (current.length < 2) return;
    drawSegments.push({
      pathId: connection.pathId ?? null,
      sourceVertexIds: current.map((copy) => copy.canonicalVertexId),
      copyIds: current.map((copy) => copy.id),
      points: current.map((copy) => [copy.x, copy.y]),
      seamAfter,
    });
  };
  for (let edgeIndex = 0; edgeIndex < vertices.length - 1; edgeIndex += 1) {
    const crossing = crossingsByIndex.get(edgeIndex);
    if (!crossing) {
      current.push(copyFor(vertices[edgeIndex + 1], copyIds[edgeIndex + 1] ?? null));
      continue;
    }
    const exit = crossing.exitCopyId
      ? copyFor(vertices[edgeIndex], crossing.exitCopyId)
      : sourceCopyFor(crossing.sourceVertexId) ?? current[current.length - 1];
    if (exit.canonicalVertexId !== vertices[edgeIndex]) {
      throw new TypeError("A seam exit copy does not match the logical path.");
    }
    current[current.length - 1] = exit;
    appendCurrent(crossing.id ?? crossing.seamPairId ?? null);
    // A seam target is an atlas boundary copy.  The next logical vertex can
    // be the target face's interior point, so it need not share the target's
    // canonical ID.  Starting a new segment from this concrete copy prevents
    // a false chord across the unfolded chart.
    const entry = crossing.entryCopyId
      ? copyFor(vertices[edgeIndex + 1], crossing.entryCopyId)
      : sourceCopyFor(crossing.targetVertexId)
        ?? copyFor(vertices[edgeIndex + 1], copyIds[edgeIndex + 1] ?? null);
    current = [entry];
  }
  appendCurrent(null);
  return drawSegments;
}

// Renderer intentionally has no static relative import here: a number of
// legacy regression harnesses load it via a data URL.  Product startup loads
// this module once, and the synchronous registry keeps the topology-only
// rendering path available without changing legacy module resolution.
const TOPOLOGY_BOARD_VIEW_RUNTIME = Symbol.for("lifeline.topology-board-view-runtime.v1");
Object.defineProperty(globalThis, TOPOLOGY_BOARD_VIEW_RUNTIME, {
  value: Object.freeze({ projectBoard, projectPath, hitTestBoard, buildTopologyTerritoryDisplay }),
  configurable: true,
  writable: true,
});
