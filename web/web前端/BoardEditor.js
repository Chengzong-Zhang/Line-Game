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
    rings: (draft.rings ?? (draft.closed ? [draft.path] : [])).map(ring => ring.map(cloneCoordinate)),
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
  const rings = draft.rings;
  const boundary = rings.flat();
  const minX = Math.min(...boundary.map(([x]) => x));
  const maxX = Math.max(...boundary.map(([x]) => x));
  const minY = Math.min(...boundary.map(([, y]) => y));
  const maxY = Math.max(...boundary.map(([, y]) => y));
  const faces = [];
  const usedCoordinates = new Map();
  const addFace = (id, coordinates) => {
    // Unit edges never cross a triangle interior. Parity at the barycenter
    // therefore selects exact atomic faces, including holes and self-touching loops.
    if (rings.reduce((parity, ring) => parity ^ Number(pointInPolygon(faceCenter(coordinates), ring)), 0) === 0) return;
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
    editorBoundaries: rings.map(ring => ring.map(cloneCoordinate)),
  };
}

function boundaryOccurrenceIds(definition) {
  const edges = new Map();
  for (const face of definition.faces) for (let side = 0; side < 3; side += 1) {
    const endpoints = [face.vertices[side], face.vertices[(side + 1) % 3]].sort();
    const key = endpoints.join("|");
    const group = edges.get(key) ?? [];
    group.push(`${face.id}:${side}`); edges.set(key, group);
  }
  return [...edges.values()].filter(group => group.length === 1).map(group => group[0]).sort();
}

// A contour edit may turn a former boundary into an interior edge (or remove
// it). Keep every unaffected pair and report exactly which pairs were lost.
function reconcileSeams(draft, definition) {
  const allowed = new Set(boundaryOccurrenceIds(definition));
  const occurrence = (board, id) => {
    const split = id.lastIndexOf(':');
    const face = board?.faces?.find(item => item.id === id.slice(0, split));
    const side = Number(id.slice(split + 1));
    return face && Number.isInteger(side) && side >= 0 && side < 3
      ? [face.vertices[side], face.vertices[(side + 1) % 3]] : null;
  };
  const newEdges = new Map([...allowed].map(id => {
    const ends = occurrence(definition, id);
    return [ends.slice().sort().join('|'), { id, ends }];
  }));
  const mapEdge = id => {
    const old = occurrence(draft.candidateDefinition, id);
    if (!old) return null;
    const next = newEdges.get(old.slice().sort().join('|'));
    return next ? { id: next.id, flip: next.ends[0] !== old[0] } : null;
  };
  const kept = [], removedSeams = [];
  for (const pair of draft.seamPairs) {
    const a = mapEdge(pair.edgeOccurrenceA), b = mapEdge(pair.edgeOccurrenceB);
    if (!a || !b) { removedSeams.push(pair.id); continue; }
    const endpointMap = [0, 1].map(i => pair.endpointMap[a.flip ? 1 - i : i] ^ Number(b.flip));
    kept.push({ ...pair, edgeOccurrenceA: a.id, edgeOccurrenceB: b.id, endpointMap });
  }
  draft.seamPairs = kept;
  definition.seamPairs = draft.seamPairs.map(cloneSeamPair);
  draft.boundaryOccurrenceIds = [...allowed].sort();
  return removedSeams;
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
    movementStrategy: options.topology?.movementStrategy ?? "simple-rays-v3",
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
    rings: [],
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
  next.path.push(candidate);
  return success(next);
}

export function undoBoundaryVertex(draft) {
  if (draft.closed) {
    if (draft.seamPairs.length) {
      const next = cloneDraft(draft);
      next.seamPairs.pop();
      next.candidateDefinition.seamPairs = next.seamPairs.map(cloneSeamPair);
      return success(next, { definition: structuredClone(next.candidateDefinition) });
    }
    const rings = (draft.rings ?? [draft.path]).map(ring => ring.map(cloneCoordinate));
    const path = rings.pop() ?? [];
    return success(cloneDraft(draft, { path, rings, closed: false, candidateDefinition: null, boundaryOccurrenceIds: [] }));
  }
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
  if (draft.path.length < 3) {
    return failure(BoardEditorError.DEGENERATE_BOUNDARY, "A board boundary needs at least three non-collinear vertices.", draft);
  }
  const first = draft.path[0];
  const last = draft.path[draft.path.length - 1];
  if (!areLatticeNeighbors(last, first)) {
    return failure(BoardEditorError.OPEN_BOUNDARY, "The final lattice vertex must be adjacent to the first one.", draft);
  }
  const next = cloneDraft(draft, { closed: true, rings: [...(draft.rings ?? []), draft.path.map(cloneCoordinate)] });
  const candidateDefinition = buildCandidateDefinition(next);
  if (!candidateDefinition.faces.length) {
    return failure(BoardEditorError.EMPTY_INTERIOR, "The closed lattice loop does not contain a playable triangular face.", draft);
  }
  const removedSeams = reconcileSeams(next, candidateDefinition);
  next.candidateDefinition = candidateDefinition;
  return success(next, { definition: structuredClone(candidateDefinition), removedSeams });
}

export function startBoundaryRing(draft) {
  if (!draft.closed) return failure(BoardEditorError.BOARD_NOT_CLOSED, "Close the current contour first.", draft);
  return success(cloneDraft(draft, { path: [], closed: false, boundaryOccurrenceIds: [] }));
}

export function deleteBoundaryRing(draft, index) {
  const rings = (draft.rings ?? []).map(ring => ring.map(cloneCoordinate));
  if (!Number.isInteger(index) || index < 0 || index >= rings.length) return failure("INVALID_RING", "Contour does not exist.", draft);
  rings.splice(index, 1);
  if (!draft.closed) return success(cloneDraft(draft, { rings }));
  if (!rings.length) return success(cloneDraft(draft, { rings, path: [], closed: false, seamPairs: [], candidateDefinition: null, boundaryOccurrenceIds: [] }), { removedSeams: draft.seamPairs.map(pair => pair.id) });
  const next = cloneDraft(draft, { rings, path: rings[rings.length - 1].map(cloneCoordinate), boundaryOccurrenceIds: [] });
  const candidateDefinition = buildCandidateDefinition(next);
  if (!candidateDefinition.faces.length) return failure(BoardEditorError.EMPTY_INTERIOR, "Deleting this contour leaves no faces.", draft);
  const removedSeams = reconcileSeams(next, candidateDefinition);
  next.candidateDefinition = candidateDefinition;
  return success(next, { definition: structuredClone(candidateDefinition), removedSeams });
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
