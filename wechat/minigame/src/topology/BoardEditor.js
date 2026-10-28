export const BOARD_EDITOR_CONTRACT_VERSION = "board-topology-v1";

export const BoardEditorError = Object.freeze({
  BOARD_CLOSED: "BOARD_CLOSED",
  BOARD_NOT_CLOSED: "BOARD_NOT_CLOSED",
  DEGENERATE_BOUNDARY: "DEGENERATE_BOUNDARY",
  DUPLICATE_SEAM_ID: "DUPLICATE_SEAM_ID",
  DUPLICATE_SEAM_OCCURRENCE: "DUPLICATE_SEAM_OCCURRENCE",
  EMPTY_INTERIOR: "EMPTY_INTERIOR",
  INVALID_BOUNDARY_OCCURRENCE: "INVALID_BOUNDARY_OCCURRENCE",
  INVALID_COORDINATE: "INVALID_COORDINATE",
  INVALID_ENDPOINT_MAP: "INVALID_ENDPOINT_MAP",
  NON_LATTICE_EDGE: "NON_LATTICE_EDGE",
  OPEN_BOUNDARY: "OPEN_BOUNDARY",
  SELF_INTERSECTION: "SELF_INTERSECTION",
  SELF_SEAM: "SELF_SEAM",
  SELF_TOUCH: "SELF_TOUCH",
});

const LATTICE_DIRECTIONS = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
]);

const cloneCoordinate = (coordinate) => [coordinate[0], coordinate[1]];
const coordinateKey = (coordinate) => coordinate[0] + "," + coordinate[1];
const sameCoordinate = (left, right) => left[0] === right[0] && left[1] === right[1];

function cloneSeamPair(pair) {
  return {
    id: pair.id,
    edgeOccurrenceA: pair.edgeOccurrenceA,
    edgeOccurrenceB: pair.edgeOccurrenceB,
    endpointMap: [...pair.endpointMap],
  };
}

function cloneDraft(draft, changes = {}) {
  return {
    contractVersion: BOARD_EDITOR_CONTRACT_VERSION,
    topology: { ...draft.topology },
    scoring: { ...draft.scoring },
    path: draft.path.map(cloneCoordinate),
    closed: draft.closed,
    seamPairs: draft.seamPairs.map(cloneSeamPair),
    boundaryOccurrenceIds: [...draft.boundaryOccurrenceIds],
    candidateDefinition: draft.candidateDefinition ? structuredClone(draft.candidateDefinition) : null,
    ...changes,
  };
}

function failure(code, detail, draft) {
  return { ok: false, code, detail, draft };
}

function success(draft, extra = {}) {
  return { ok: true, draft, ...extra };
}

function isIntegerCoordinate(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length === 2
    && Number.isInteger(coordinate[0])
    && Number.isInteger(coordinate[1]);
}

function areLatticeNeighbors(left, right) {
  if (!isIntegerCoordinate(left) || !isIntegerCoordinate(right)) return false;
  const dx = right[0] - left[0];
  const dy = right[1] - left[1];
  return LATTICE_DIRECTIONS.some(([x, y]) => x === dx && y === dy);
}

function axialToPlane(coordinate) {
  return [coordinate[0] + coordinate[1] * 0.5, coordinate[1] * Math.sqrt(3) / 2];
}

function signedArea(path) {
  let twiceArea = 0;
  for (let index = 0; index < path.length; index += 1) {
    const [x1, y1] = axialToPlane(path[index]);
    const [x2, y2] = axialToPlane(path[(index + 1) % path.length]);
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point, start, end) {
  const epsilon = 1e-9;
  return Math.abs(orientation(start, end, point)) <= epsilon
    && point[0] <= Math.max(start[0], end[0]) + epsilon
    && point[0] + epsilon >= Math.min(start[0], end[0])
    && point[1] <= Math.max(start[1], end[1]) + epsilon
    && point[1] + epsilon >= Math.min(start[1], end[1]);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const a = axialToPlane(firstStart);
  const b = axialToPlane(firstEnd);
  const c = axialToPlane(secondStart);
  const d = axialToPlane(secondEnd);
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  const epsilon = 1e-9;
  if (((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon))
    && ((third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon))) {
    return true;
  }
  return (Math.abs(first) <= epsilon && pointOnSegment(c, a, b))
    || (Math.abs(second) <= epsilon && pointOnSegment(d, a, b))
    || (Math.abs(third) <= epsilon && pointOnSegment(a, c, d))
    || (Math.abs(fourth) <= epsilon && pointOnSegment(b, c, d));
}

function wouldCrossExistingPath(path, start, end, ignoredSegmentIndexes = new Set()) {
  for (let index = 0; index + 1 < path.length; index += 1) {
    if (ignoredSegmentIndexes.has(index)) continue;
    if (segmentsIntersect(start, end, path[index], path[index + 1])) return true;
  }
  return false;
}

function pointInPolygon(point, boundary) {
  let inside = false;
  const [x, y] = point;
  for (let current = 0, previous = boundary.length - 1; current < boundary.length; previous = current, current += 1) {
    const [currentX, currentY] = axialToPlane(boundary[current]);
    const [previousX, previousY] = axialToPlane(boundary[previous]);
    const crossesHorizontalRay = (currentY > y) !== (previousY > y);
    if (crossesHorizontalRay && x < (previousX - currentX) * (y - currentY) / (previousY - currentY) + currentX) {
      inside = !inside;
    }
  }
  return inside;
}

function faceCenter(coordinates) {
  const plane = coordinates.map(axialToPlane);
  return [
    plane.reduce((total, point) => total + point[0], 0) / plane.length,
    plane.reduce((total, point) => total + point[1], 0) / plane.length,
  ];
}

function makeVertexId(x, y) {
  return "v:" + x + "," + y;
}

function buildCandidateDefinition(draft) {
  const boundary = draft.path;
  const minX = Math.min(...boundary.map(([x]) => x));
  const maxX = Math.max(...boundary.map(([x]) => x));
  const minY = Math.min(...boundary.map(([, y]) => y));
  const maxY = Math.max(...boundary.map(([, y]) => y));
  const faces = [];
  const usedCoordinates = new Map();
  const addFace = (id, coordinates) => {
    if (!pointInPolygon(faceCenter(coordinates), boundary)) return;
    for (const coordinate of coordinates) usedCoordinates.set(coordinateKey(coordinate), cloneCoordinate(coordinate));
    faces.push({ id, vertices: coordinates.map(([x, y]) => makeVertexId(x, y)) });
  };
  for (let y = minY - 1; y <= maxY; y += 1) {
    for (let x = minX - 1; x <= maxX; x += 1) {
      addFace("u:" + x + "," + y, [[x, y], [x + 1, y], [x, y + 1]]);
      addFace("d:" + x + "," + y, [[x + 1, y], [x + 1, y + 1], [x, y + 1]]);
    }
  }
  const vertices = [...usedCoordinates.values()]
    .sort((left, right) => left[1] - right[1] || left[0] - right[0])
    .map(([x, y]) => ({ id: makeVertexId(x, y), coordinate: [x, y] }));
  return {
    schemaVersion: 1,
    coordinateSystem: "triangular-axial-v1",
    topology: { ...draft.topology },
    vertices,
    faces,
    seamPairs: draft.seamPairs.map(cloneSeamPair),
    scoring: { ...draft.scoring },
    editorBoundary: boundary.map(cloneCoordinate),
  };
}

function endpointMapIsValid(endpointMap) {
  return Array.isArray(endpointMap)
    && endpointMap.length === 2
    && ((endpointMap[0] === 0 && endpointMap[1] === 1)
      || (endpointMap[0] === 1 && endpointMap[1] === 0));
}

export function createBoardDraft(options = {}) {
  const topology = {
    family: options.topology?.family ?? "planar",
    movementStrategy: options.topology?.movementStrategy ?? "simple-rays-v1",
    territoryStrategy: options.topology?.territoryStrategy ?? "surface-discrete-v1",
    specialVertexPolicy: options.topology?.specialVertexPolicy ?? "stop",
  };
  const scoring = { strategy: options.scoring?.strategy ?? "canonical-vertices-v1" };
  const boundaryOccurrenceIds = [...new Set(options.boundaryOccurrenceIds ?? [])];
  return {
    contractVersion: BOARD_EDITOR_CONTRACT_VERSION,
    topology,
    scoring,
    path: [],
    closed: false,
    seamPairs: [],
    boundaryOccurrenceIds,
    candidateDefinition: null,
  };
}

export function addBoundaryVertex(draft, coordinate) {
  const next = cloneDraft(draft);
  if (next.closed) return failure(BoardEditorError.BOARD_CLOSED, "Reopen or cancel the draft before editing its boundary.", draft);
  if (!isIntegerCoordinate(coordinate)) {
    return failure(BoardEditorError.INVALID_COORDINATE, "A lattice coordinate must contain two integers.", draft);
  }
  const candidate = cloneCoordinate(coordinate);
  if (!next.path.length) {
    next.path.push(candidate);
    return success(next);
  }
  const previous = next.path[next.path.length - 1];
  if (!areLatticeNeighbors(previous, candidate)) {
    return failure(BoardEditorError.NON_LATTICE_EDGE, "Boundary steps must follow one unit triangular-lattice edge.", draft);
  }
  if (next.path.some((point) => sameCoordinate(point, candidate))) {
    return failure(BoardEditorError.SELF_TOUCH, "A simple boundary cannot revisit a lattice vertex.", draft);
  }
  if (wouldCrossExistingPath(next.path, previous, candidate, new Set([next.path.length - 2]))) {
    return failure(BoardEditorError.SELF_INTERSECTION, "The new boundary edge intersects an earlier edge.", draft);
  }
  next.path.push(candidate);
  return success(next);
}

export function undoBoundaryVertex(draft) {
  if (draft.closed) return failure(BoardEditorError.BOARD_CLOSED, "A closed draft cannot be undone without creating a new draft.", draft);
  const next = cloneDraft(draft);
  next.path.pop();
  return success(next);
}

export function cancelBoardDraft(draft) {
  return success(createBoardDraft({
    topology: draft.topology,
    scoring: draft.scoring,
    boundaryOccurrenceIds: draft.boundaryOccurrenceIds,
  }));
}

export function closeBoundaryDraft(draft) {
  if (draft.closed) return failure(BoardEditorError.BOARD_CLOSED, "The boundary is already closed.", draft);
  if (draft.path.length < 3 || Math.abs(signedArea(draft.path)) < 1e-9) {
    return failure(BoardEditorError.DEGENERATE_BOUNDARY, "A board boundary needs at least three non-collinear vertices.", draft);
  }
  const first = draft.path[0];
  const last = draft.path[draft.path.length - 1];
  if (!areLatticeNeighbors(last, first)) {
    return failure(BoardEditorError.OPEN_BOUNDARY, "The final lattice vertex must be adjacent to the first one.", draft);
  }
  const ignored = new Set([0, draft.path.length - 2]);
  if (wouldCrossExistingPath(draft.path, last, first, ignored)) {
    return failure(BoardEditorError.SELF_INTERSECTION, "Closing the boundary would intersect an earlier edge.", draft);
  }
  const next = cloneDraft(draft, { closed: true });
  const candidateDefinition = buildCandidateDefinition(next);
  if (!candidateDefinition.faces.length) {
    return failure(BoardEditorError.EMPTY_INTERIOR, "The closed lattice loop does not contain a playable triangular face.", draft);
  }
  next.candidateDefinition = candidateDefinition;
  return success(next, { definition: structuredClone(candidateDefinition) });
}

export function addSeamPair(draft, seamPair) {
  if (!draft.closed || !draft.candidateDefinition) {
    return failure(BoardEditorError.BOARD_NOT_CLOSED, "Close and compile a boundary before selecting seam edges.", draft);
  }
  const next = cloneDraft(draft);
  const pair = seamPair ?? {};
  if (typeof pair.id !== "string" || !pair.id.length
    || typeof pair.edgeOccurrenceA !== "string" || typeof pair.edgeOccurrenceB !== "string") {
    return failure(BoardEditorError.INVALID_BOUNDARY_OCCURRENCE, "A seam pair needs stable occurrence identifiers.", draft);
  }
  if (pair.edgeOccurrenceA === pair.edgeOccurrenceB) {
    return failure(BoardEditorError.SELF_SEAM, "A boundary occurrence cannot be glued to itself.", draft);
  }
  if (!endpointMapIsValid(pair.endpointMap)) {
    return failure(BoardEditorError.INVALID_ENDPOINT_MAP, "endpointMap must be [0,1] or [1,0].", draft);
  }
  const allowed = new Set(next.boundaryOccurrenceIds);
  if (!allowed.has(pair.edgeOccurrenceA) || !allowed.has(pair.edgeOccurrenceB)) {
    return failure(BoardEditorError.INVALID_BOUNDARY_OCCURRENCE, "Both selected edges must be current boundary occurrences.", draft);
  }
  if (next.seamPairs.some((existing) => existing.id === pair.id)) {
    return failure(BoardEditorError.DUPLICATE_SEAM_ID, "Each seam pair requires a unique identifier.", draft);
  }
  const usedOccurrences = new Set(next.seamPairs.flatMap((existing) => [
    existing.edgeOccurrenceA,
    existing.edgeOccurrenceB,
  ]));
  if (usedOccurrences.has(pair.edgeOccurrenceA) || usedOccurrences.has(pair.edgeOccurrenceB)) {
    return failure(BoardEditorError.DUPLICATE_SEAM_OCCURRENCE, "A boundary occurrence can participate in only one seam pair.", draft);
  }
  next.seamPairs.push(cloneSeamPair(pair));
  next.candidateDefinition.seamPairs = next.seamPairs.map(cloneSeamPair);
  return success(next, { definition: structuredClone(next.candidateDefinition) });
}

export function getBoundaryPath(draft) {
  return draft.path.map(cloneCoordinate);
}
