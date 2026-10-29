/** Exact finite cellular homology over F_2. Derived diagnostics, not scoring. */
export const TOPOLOGY_ALGEBRA_VERSION = 'topology-algebra-f2-v1';
const cache = new WeakMap();

function fail(message) { throw new TypeError(`Invalid compiled chain complex: ${message}`); }
function pivot(vector) { let result = -1; for (const row of vector) if (row > result) result = row; return result; }
function toggle(vector, row) { if (vector.has(row)) vector.delete(row); else vector.add(row); }
function add(target, source) { for (const row of source) toggle(target, row); }

/** Sparse column elimination; repeated incidences cancel over F_2. */
function basisFor(columns) {
  const basis = new Map();
  for (const column of columns) {
    const vector = new Set(column);
    while (vector.size) {
      const row = pivot(vector);
      if (!basis.has(row)) { basis.set(row, vector); break; }
      add(vector, basis.get(row));
    }
  }
  return basis;
}

function reduce(input, basis) {
  const vector = new Set(input);
  while (vector.size) {
    const row = pivot(vector);
    if (!basis.has(row)) return vector;
    add(vector, basis.get(row));
  }
  return vector;
}

function chainData(board, relativeBoundary = false) {
  if (!board || !Array.isArray(board.canonicalVertices) || !Array.isArray(board.edgeClasses)
      || !Array.isArray(board.definition?.faces)) fail('canonical vertices, edge classes and faces are required');
  let variants = cache.get(board);
  if (variants?.has(relativeBoundary)) return variants.get(relativeBoundary);
  const removedVertices = new Set(relativeBoundary ? board.realBoundarySampleIds : []);
  const removedEdges = new Set(relativeBoundary ? board.realBoundaryEdgeClassIds : []);
  const vertexIds = board.canonicalVertices.map(v => v.id).filter(id => !removedVertices.has(id));
  const edges = board.edgeClasses.filter(edge => !removedEdges.has(edge.id));
  const vertexIndex = new Map(vertexIds.map((id, i) => [id, i]));
  const allVertices = new Set(board.canonicalVertices.map(v => v.id));
  const edgeIndex = new Map(edges.map((edge, i) => [edge.id, i]));
  const occurrenceEdge = new Map();
  for (const edge of board.edgeClasses) for (const occurrence of edge.occurrences) {
    const key = `${occurrence.faceId}\0${occurrence.sideIndex}`;
    if (occurrenceEdge.has(key)) fail('a face side belongs to multiple edge classes');
    occurrenceEdge.set(key, edge.id);
  }
  const d1 = edges.map(edge => {
    if (!Array.isArray(edge.canonicalVertices) || edge.canonicalVertices.length !== 2) fail('edge endpoints');
    const vector = new Set();
    for (const id of edge.canonicalVertices) {
      if (!allVertices.has(id)) fail('unknown edge endpoint');
      if (vertexIndex.has(id)) toggle(vector, vertexIndex.get(id));
    }
    return vector;
  });
  const d2 = [], chainFailures = [];
  for (const face of board.definition.faces) {
    const vector = new Set(), boundaryBoundary = new Set();
    for (let side = 0; side < face.vertices.length; side += 1) {
      const edgeId = occurrenceEdge.get(`${face.id}\0${side}`);
      if (edgeId == null) fail(`missing face side ${face.id}/${side}`);
      if (!edgeIndex.has(edgeId)) continue;
      const index = edgeIndex.get(edgeId);
      toggle(vector, index);
      add(boundaryBoundary, d1[index]);
    }
    d2.push(vector);
    if (boundaryBoundary.size) chainFailures.push(face.id);
  }
  const d1Basis = basisFor(d1), d2Basis = basisFor(d2);
  const data = { vertexIds, edges, edgeIndex, d1, d2, d1Basis, d2Basis, chainFailures };
  // Compiled boards are immutable. Avoid stale caching for mutable test/input data.
  if (Object.isFrozen(board)) {
    if (!variants) { variants = new Map(); cache.set(board, variants); }
    variants.set(relativeBoundary, data);
  }
  return data;
}

function surfaceData(board, connected, eulerCharacteristic) {
  const boundaryDegrees = new Map();
  const degrees = new Map(board.canonicalVertices.map(vertex => [vertex.id, 0]));
  let regularEdges = true;
  for (const edge of board.edgeClasses) {
    regularEdges &&= edge.occurrences.length === 1 || edge.occurrences.length === 2;
    for (const vertex of edge.canonicalVertices) {
      degrees.set(vertex, (degrees.get(vertex) ?? 0) + 1);
      if (edge.occurrences.length === 1) boundaryDegrees.set(vertex, (boundaryDegrees.get(vertex) ?? 0) + 1);
    }
  }
  const boundaryRegular = [...boundaryDegrees.values()].every(degree => degree === 2);
  const triangular = board.definition.faces.every(face => face.vertices.length === 3);
  const manifold = triangular && regularEdges && boundaryRegular
    && board.vertexLinks?.length === board.canonicalVertices.length
    && board.vertexLinks.every(link => link.manifold && (link.kind === 'cycle' || link.kind === 'path'));
  const boundaryCount = board.boundaryComponents?.length ?? 0;
  let genus = null, crosscaps = null;
  if (manifold && connected) {
    const defect = 2 - boundaryCount - eulerCharacteristic;
    if (board.orientable && defect >= 0 && defect % 2 === 0) genus = defect / 2;
    if (!board.orientable && defect >= 1) crosscaps = defect;
  }
  const degreeDefect = [...degrees].reduce((sum, [id, degree]) =>
    sum + (boundaryDegrees.has(id) ? 4 : 6) - degree, 0);
  return {
    manifold: Boolean(manifold), connected, orientable: Boolean(board.orientable),
    boundaryCount, genus, crosscaps, boundaryRegular,
    degreeDefect,
    degreeIdentityVerified: Boolean(manifold && degreeDefect === 6 * eulerCharacteristic),
  };
}

/**
 * The same endpoint pair may identify several distinct 1-cells. Never replace
 * edgeClasses with simple sample adjacency here. relativeBoundary computes
 * H_*(K, boundary K; F_2), not ordinary homology of a board with its rim erased.
 */
export function analyzeBoardAlgebra(board, { relativeBoundary = false } = {}) {
  const data = chainData(board, relativeBoundary);
  const counts = [data.vertexIds.length, data.edges.length, data.d2.length];
  const ranks = [data.d1Basis.size, data.d2Basis.size];
  const betti = [counts[0] - ranks[0], counts[1] - ranks[0] - ranks[1], counts[2] - ranks[1]];
  const eulerCharacteristic = counts[0] - counts[1] + counts[2];
  const absolute = relativeBoundary ? analyzeBoardAlgebra(board) : null;
  return {
    version: TOPOLOGY_ALGEBRA_VERSION, field: 'F2', relativeBoundary,
    cellCounts: counts, boundaryRanks: ranks, betti,
    chainCondition: data.chainFailures.length === 0,
    chainFailureFaceIds: [...data.chainFailures],
    eulerCharacteristic,
    eulerIdentityVerified: betti[0] - betti[1] + betti[2] === eulerCharacteristic,
    surface: absolute?.surface ?? surfaceData(board, betti[0] === 1, eulerCharacteristic),
  };
}

/** Test an edge chain modulo 2; null-homology does not imply contractibility. */
export function analyzeEdgeCycle(board, edgeClassIds, { relativeBoundary = false } = {}) {
  const data = chainData(board, relativeBoundary);
  if (data.chainFailures.length) fail('boundary squared is nonzero');
  const allEdges = new Map(board.edgeClasses.map(edge => [edge.id, edge]));
  const vector = new Set(), boundary = new Set();
  const support = new Set();
  for (const id of edgeClassIds) {
    if (!allEdges.has(id)) fail(`unknown edge ${id}`);
    if (support.has(id)) support.delete(id); else support.add(id);
    if (!data.edgeIndex.has(id)) continue;
    const index = data.edgeIndex.get(id);
    toggle(vector, index); add(boundary, data.d1[index]);
  }
  const cycle = boundary.size === 0;
  const nullHomologous = cycle ? reduce(vector, data.d2Basis).size === 0 : null;
  // Separation theorem applies only to one embedded circle on a connected
  // closed surface. Do not infer it for an arbitrary chain or a complex.
  const adjacency = new Map();
  for (const id of support) for (const [left, right] of [allEdges.get(id).canonicalVertices,
    [...allEdges.get(id).canonicalVertices].reverse()]) {
    if (!adjacency.has(left)) adjacency.set(left, []);
    adjacency.get(left).push(right);
  }
  const visited = new Set(), pending = adjacency.size ? [adjacency.keys().next().value] : [];
  for (let i = 0; i < pending.length; i += 1) {
    const current = pending[i];
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) if (!visited.has(next)) pending.push(next);
  }
  const embeddedCircle = adjacency.size > 0 && visited.size === adjacency.size
    && [...adjacency.values()].every(neighbors => neighbors.length === 2);
  const { surface } = analyzeBoardAlgebra(board);
  const canClassifySeparation = !relativeBoundary && cycle && embeddedCircle
    && surface.manifold && surface.connected && surface.boundaryCount === 0;
  return {
    version: TOPOLOGY_ALGEBRA_VERSION, field: 'F2', relativeBoundary,
    cycle, nullHomologous, embeddedCircle,
    separating: canClassifySeparation ? nullHomologous : null,
    boundaryVertexIds: data.vertexIds.filter((_, i) => boundary.has(i)),
  };
}
