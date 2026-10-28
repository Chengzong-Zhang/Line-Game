import {
  compareStableIdentifiers,
  edgeOccurrenceId,
  makeBoardError,
  splitEdgeOccurrenceId,
  TRIANGULAR_UNIT_DIRECTIONS,
  triangularDirectionIndex,
  undirectedKey,
} from "./BoardDefinition.js?v=20261027-topology-multistart-release1";

export class UnionFind {
  constructor(ids = []) {
    this.parent = new Map(ids.map((id) => [id, id]));
    this.rank = new Map(ids.map((id) => [id, 0]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent == null) throw new Error("Unknown union-find id: " + id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return leftRoot;
    const leftRank = this.rank.get(leftRoot) ?? 0;
    const rightRank = this.rank.get(rightRoot) ?? 0;
    if (leftRank < rightRank || (leftRank === rightRank && String(leftRoot) > String(rightRoot))) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.parent.set(rightRoot, leftRoot);
    if (leftRank === rightRank) this.rank.set(leftRoot, leftRank + 1);
    return leftRoot;
  }
}

function rawEdgeKey(left, right) {
  return undirectedKey(left, right);
}

function makeOccurrences(definition) {
  const byId = new Map();
  const byRawEdge = new Map();
  for (const face of definition.faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const occurrence = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices: [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]],
      };
      occurrence.rawEdgeKey = rawEdgeKey(occurrence.vertices[0], occurrence.vertices[1]);
      byId.set(occurrence.id, occurrence);
      const group = byRawEdge.get(occurrence.rawEdgeKey) ?? [];
      group.push(occurrence);
      byRawEdge.set(occurrence.rawEdgeKey, group);
    }
  }
  return { byId, byRawEdge };
}

function makeOccurrenceUnion(byRawEdge, definition) {
  const ids = [...byRawEdge.values()].flat().map((occurrence) => occurrence.id);
  const unionFind = new UnionFind(ids);
  for (const occurrences of byRawEdge.values()) {
    if (occurrences.length === 2) unionFind.union(occurrences[0].id, occurrences[1].id);
  }
  for (const pair of definition.seamPairs ?? []) {
    unionFind.union(pair.edgeOccurrenceA, pair.edgeOccurrenceB);
  }
  return unionFind;
}

function canonicalVertexGroups(vertexUnion, vertices) {
  const groups = new Map();
  for (const vertex of vertices) {
    const root = vertexUnion.find(vertex.id);
    const group = groups.get(root) ?? [];
    group.push(vertex.id);
    groups.set(root, group);
  }
  const orderedGroups = [...groups.values()]
    .map((ids) => ids.sort(compareStableIdentifiers))
    .sort((left, right) => compareStableIdentifiers(left[0], right[0]));
  const rawToCanonical = new Map();
  const canonicalVertices = orderedGroups.map((sourceVertexIds, index) => {
    const id = "cv:" + index;
    for (const sourceId of sourceVertexIds) rawToCanonical.set(sourceId, id);
    return { id, sourceVertexIds };
  });
  return { rawToCanonical, canonicalVertices };
}

function directionIndex(coordinatesById, fromVertexId, toVertexId) {
  const from = coordinatesById.get(fromVertexId);
  const to = coordinatesById.get(toVertexId);
  if (!from || !to) return -1;
  return triangularDirectionIndex(from, to);
}

function endpointMapInverse(endpointMap) {
  const inverse = new Array(endpointMap.length);
  endpointMap.forEach((targetIndex, sourceIndex) => {
    inverse[targetIndex] = sourceIndex;
  });
  return inverse;
}

function oppositeDirection(direction) {
  return direction < 0 ? -1 : (direction + 3) % TRIANGULAR_UNIT_DIRECTIONS.length;
}

function faceSideForOccurrence(occurrence, facesById, coordinatesById) {
  const face = facesById.get(occurrence.faceId);
  const interiorVertexId = face.vertices[(occurrence.sideIndex + 2) % face.vertices.length];
  const [leftVertexId, rightVertexId] = occurrence.vertices;
  const left = coordinatesById.get(leftVertexId);
  const right = coordinatesById.get(rightVertexId);
  const interior = coordinatesById.get(interiorVertexId);
  const signedSide = (right[0] - left[0]) * (interior[1] - left[1])
    - (right[1] - left[1]) * (interior[0] - left[0]);
  const endpointInteriorDirections = [
    directionIndex(coordinatesById, leftVertexId, interiorVertexId),
    directionIndex(coordinatesById, rightVertexId, interiorVertexId),
  ];
  return {
    faceId: occurrence.faceId,
    edgeOccurrenceId: occurrence.id,
    orientedVertices: [...occurrence.vertices],
    interiorVertexId,
    faceSide: signedSide > 0 ? "left" : signedSide < 0 ? "right" : "degenerate",
    endpointInteriorDirections,
    endpointExitDirections: endpointInteriorDirections.map(oppositeDirection),
  };
}

function createDirectionTransition(source, target, endpointMap, coordinatesById, facesById) {
  const sourceFaceSide = faceSideForOccurrence(source, facesById, coordinatesById);
  const targetFaceSide = faceSideForOccurrence(target, facesById, coordinatesById);
  const endpointTransport = endpointMap.map((targetEndpointIndex, sourceEndpointIndex) => ({
    sourceEndpointIndex,
    targetEndpointIndex,
    sourceExitDirectionIndex: sourceFaceSide.endpointExitDirections[sourceEndpointIndex],
    targetEntryDirectionIndex: targetFaceSide.endpointInteriorDirections[targetEndpointIndex],
  }));
  return {
    fromEdgeOccurrenceId: source.id,
    toEdgeOccurrenceId: target.id,
    endpointMap: [...endpointMap],
    transportKind: "endpoint-face-side-v1",
    sourceFaceSide,
    targetFaceSide,
    endpointTransport,
  };
}

function connectedComponents(nodes, adjacency) {
  const unseen = new Set(nodes);
  const components = [];
  while (unseen.size) {
    const start = unseen.values().next().value;
    unseen.delete(start);
    const component = [start];
    const queue = [start];
    while (queue.length) {
      const current = queue.pop();
      for (const next of adjacency.get(current) ?? []) {
        if (unseen.delete(next)) {
          component.push(next);
          queue.push(next);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function analyzeOrientability(edgeClasses) {
  const adjacency = new Map();
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 2) continue;
    const [left, right] = edgeClass.occurrences;
    const sameDirection = left.canonicalVertices[0] === right.canonicalVertices[0]
      && left.canonicalVertices[1] === right.canonicalVertices[1];
    const factor = sameDirection ? -1 : 1;
    const leftEdges = adjacency.get(left.faceId) ?? [];
    leftEdges.push({ faceId: right.faceId, factor });
    adjacency.set(left.faceId, leftEdges);
    const rightEdges = adjacency.get(right.faceId) ?? [];
    rightEdges.push({ faceId: left.faceId, factor });
    adjacency.set(right.faceId, rightEdges);
  }
  const orientation = new Map();
  for (const faceId of adjacency.keys()) {
    if (orientation.has(faceId)) continue;
    orientation.set(faceId, 1);
    const queue = [faceId];
    while (queue.length) {
      const current = queue.pop();
      for (const relation of adjacency.get(current) ?? []) {
        const expected = orientation.get(current) * relation.factor;
        if (orientation.has(relation.faceId)) {
          if (orientation.get(relation.faceId) !== expected) return false;
        } else {
          orientation.set(relation.faceId, expected);
          queue.push(relation.faceId);
        }
      }
    }
  }
  return true;
}

function analyzeVertexLinks(canonicalVertices, faces, edgeClassByOccurrence, rawToCanonical) {
  const links = new Map(canonicalVertices.map((vertex) => [vertex.id, new Map()]));
  for (const face of faces) {
    for (let corner = 0; corner < face.vertices.length; corner += 1) {
      const canonicalVertexId = rawToCanonical.get(face.vertices[corner]);
      const previousOccurrenceId = edgeOccurrenceId(face.id, (corner + face.vertices.length - 1) % face.vertices.length);
      const nextOccurrenceId = edgeOccurrenceId(face.id, corner);
      const previousEdgeClassId = edgeClassByOccurrence.get(previousOccurrenceId);
      const nextEdgeClassId = edgeClassByOccurrence.get(nextOccurrenceId);
      const graph = links.get(canonicalVertexId);
      const previousNeighbors = graph.get(previousEdgeClassId) ?? [];
      previousNeighbors.push(nextEdgeClassId);
      graph.set(previousEdgeClassId, previousNeighbors);
      const nextNeighbors = graph.get(nextEdgeClassId) ?? [];
      nextNeighbors.push(previousEdgeClassId);
      graph.set(nextEdgeClassId, nextNeighbors);
    }
  }
  const results = [];
  for (const vertex of canonicalVertices) {
    const graph = links.get(vertex.id);
    const nodes = [...graph.keys()];
    if (!nodes.length) {
      results.push({ id: vertex.id, manifold: false, kind: "empty" });
      continue;
    }
    const adjacency = new Map(nodes.map((node) => [node, new Set(graph.get(node))]));
    const components = connectedComponents(nodes, adjacency);
    const degrees = nodes.map((node) => (graph.get(node) ?? []).length);
    const oneDegreeCount = degrees.filter((degree) => degree === 1).length;
    const legalDegrees = degrees.every((degree) => degree === 1 || degree === 2);
    const kind = components.length === 1 && legalDegrees
      ? (oneDegreeCount === 0 ? "cycle" : oneDegreeCount === 2 ? "path" : "branched")
      : "disconnected";
    results.push({
      id: vertex.id,
      manifold: kind === "cycle" || kind === "path",
      kind,
      incidentEdgeClassCount: nodes.length,
      components: components.length,
    });
  }
  return results;
}

export function analyzeBoardTopology(definition) {
  const errors = [];
  const vertexIds = definition.vertices.map((vertex) => vertex.id);
  const coordinatesById = new Map(definition.vertices.map((vertex) => [vertex.id, vertex.coordinate]));
  const facesById = new Map(definition.faces.map((face) => [face.id, face]));
  const { byId: occurrenceById, byRawEdge } = makeOccurrences(definition);
  const vertexUnion = new UnionFind(vertexIds);
  const seamPairsByOccurrence = new Map();
  for (const pair of definition.seamPairs ?? []) {
    const left = occurrenceById.get(pair.edgeOccurrenceA);
    const right = occurrenceById.get(pair.edgeOccurrenceB);
    if (!left || !right) {
      errors.push(makeBoardError("UNKNOWN_EDGE_OCCURRENCE", "seamPairs." + pair.id,
        "Pair references an occurrence that is absent from the face set."));
      continue;
    }
    vertexUnion.union(left.vertices[0], right.vertices[pair.endpointMap[0]]);
    vertexUnion.union(left.vertices[1], right.vertices[pair.endpointMap[1]]);
    seamPairsByOccurrence.set(left.id, { pair, other: right, endpointMap: pair.endpointMap });
    seamPairsByOccurrence.set(right.id, {
      pair,
      other: left,
      endpointMap: endpointMapInverse(pair.endpointMap),
    });
  }

  const { rawToCanonical, canonicalVertices } = canonicalVertexGroups(vertexUnion, definition.vertices);
  const occurrenceUnion = makeOccurrenceUnion(byRawEdge, definition);
  const edgeClassGroups = new Map();
  for (const occurrence of occurrenceById.values()) {
    const root = occurrenceUnion.find(occurrence.id);
    const group = edgeClassGroups.get(root) ?? [];
    group.push(occurrence);
    edgeClassGroups.set(root, group);
  }
  const edgeClassByOccurrence = new Map();
  const edgeClasses = [...edgeClassGroups.values()]
    .map((occurrences) => occurrences.sort((left, right) => compareStableIdentifiers(left.id, right.id)))
    .sort((left, right) => compareStableIdentifiers(left[0].id, right[0].id))
    .map((occurrences, index) => {
      const id = "ce:" + index;
      const mapped = occurrences.map((occurrence) => ({
        ...occurrence,
        canonicalVertices: occurrence.vertices.map((vertexId) => rawToCanonical.get(vertexId)),
      }));
      for (const occurrence of mapped) edgeClassByOccurrence.set(occurrence.id, id);
      return { id, occurrences: mapped };
    });

  const canonicalAdjacency = new Map(canonicalVertices.map((vertex) => [vertex.id, new Set()]));
  for (const edgeClass of edgeClasses) {
    const [left, right] = edgeClass.occurrences[0].canonicalVertices;
    edgeClass.canonicalVertices = [left, right];
    if (left === right) {
      errors.push(makeBoardError("DEGENERATE_QUOTIENT_EDGE", "edgeClasses." + edgeClass.id,
        "A glued edge has identical canonical endpoints."));
      continue;
    }
    canonicalAdjacency.get(left).add(right);
    canonicalAdjacency.get(right).add(left);
  }

  const realBoundaryEdgeClassIds = edgeClasses
    .filter((edgeClass) => edgeClass.occurrences.length === 1)
    .map((edgeClass) => edgeClass.id);
  const realBoundaryVertexIds = new Set();
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 1) continue;
    edgeClass.canonicalVertices.forEach((vertexId) => realBoundaryVertexIds.add(vertexId));
  }
  const boundaryAdjacency = new Map([...realBoundaryVertexIds].map((id) => [id, new Set()]));
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 1 || edgeClass.canonicalVertices[0] === edgeClass.canonicalVertices[1]) continue;
    const [left, right] = edgeClass.canonicalVertices;
    boundaryAdjacency.get(left).add(right);
    boundaryAdjacency.get(right).add(left);
  }
  const boundaryComponents = connectedComponents([...realBoundaryVertexIds], boundaryAdjacency);
  const vertexLinks = analyzeVertexLinks(canonicalVertices, definition.faces, edgeClassByOccurrence, rawToCanonical);
  for (const link of vertexLinks) {
    if (!link.manifold) {
      errors.push(makeBoardError("NON_MANIFOLD_VERTEX_LINK", "canonicalVertices." + link.id,
        "Vertex link is " + link.kind + "."));
    }
  }

  const specialVertices = vertexLinks
    .filter((link) => link.manifold && (link.kind !== "cycle" || link.incidentEdgeClassCount !== 6))
    .map((link) => ({ ...link, stopOnAmbiguousContinuation: true }));
  const directionTransitions = [];
  const seenTransitions = new Set();
  for (const [occurrenceId, seam] of seamPairsByOccurrence) {
    const key = occurrenceId + ">" + seam.other.id;
    if (!seenTransitions.has(key)) {
      seenTransitions.add(key);
      directionTransitions.push(createDirectionTransition(
        occurrenceById.get(occurrenceId), seam.other, seam.endpointMap, coordinatesById, facesById,
      ));
    }
  }

  const orientable = analyzeOrientability(edgeClasses);
  const eulerCharacteristic = canonicalVertices.length - edgeClasses.length + definition.faces.length;
  const occurrenceRecords = [...occurrenceById.values()].map((occurrence) => ({
    ...occurrence,
    canonicalVertices: occurrence.vertices.map((vertexId) => rawToCanonical.get(vertexId)),
    edgeClassId: edgeClassByOccurrence.get(occurrence.id),
    ...(seamPairsByOccurrence.has(occurrence.id)
      ? { seamPairId: seamPairsByOccurrence.get(occurrence.id).pair.id }
      : {}),
  })).sort((left, right) => compareStableIdentifiers(left.id, right.id));

  return {
    ok: errors.length === 0,
    errors,
    canonicalVertices,
    rawToCanonical,
    edgeClasses,
    edgeClassByOccurrence,
    edgeOccurrences: occurrenceRecords,
    canonicalAdjacency,
    realBoundaryEdgeClassIds,
    realBoundaryVertexIds: [...realBoundaryVertexIds].sort(),
    boundaryComponents: boundaryComponents.map((component) => component.sort()),
    eulerCharacteristic,
    orientable,
    vertexLinks,
    specialVertices,
    directionTransitions,
  };
}

export const TRIANGULAR_DIRECTION_VECTORS = TRIANGULAR_UNIT_DIRECTIONS;

export function transportExitIntoTargetFace(transition, sourceEndpointIndex, sourceDirectionIndex) {
  const rule = transition?.endpointTransport?.find((entry) =>
    entry.sourceEndpointIndex === sourceEndpointIndex
      && entry.sourceExitDirectionIndex === sourceDirectionIndex,
  );
  return rule
    ? {
      targetEndpointIndex: rule.targetEndpointIndex,
      directionState: rule.targetEntryDirectionIndex,
    }
    : null;
}

export function directionTransitionTargetsTargetFaceInterior(transition) {
  if (!transition || transition.transportKind !== "endpoint-face-side-v1"
    || !transition.sourceFaceSide || !transition.targetFaceSide
    || !Array.isArray(transition.endpointTransport)) return false;
  return transition.endpointTransport.every((rule) =>
    rule.sourceExitDirectionIndex === oppositeDirection(
      transition.sourceFaceSide.endpointInteriorDirections[rule.sourceEndpointIndex],
    ) && rule.targetEntryDirectionIndex
      === transition.targetFaceSide.endpointInteriorDirections[rule.targetEndpointIndex],
  );
}

export function directionTransitionIsInverse(forward, backward) {
  if (!directionTransitionTargetsTargetFaceInterior(forward)
    || !directionTransitionTargetsTargetFaceInterior(backward)) return false;
  if (forward.toEdgeOccurrenceId !== backward.fromEdgeOccurrenceId
    || forward.fromEdgeOccurrenceId !== backward.toEdgeOccurrenceId) return false;
  return forward.endpointTransport.every((rule) => {
    const inverse = backward.endpointTransport.find((candidate) =>
      candidate.sourceEndpointIndex === rule.targetEndpointIndex
        && candidate.targetEndpointIndex === rule.sourceEndpointIndex,
    );
    return inverse != null
      && rule.sourceExitDirectionIndex === oppositeDirection(inverse.targetEntryDirectionIndex)
      && rule.targetEntryDirectionIndex === oppositeDirection(inverse.sourceExitDirectionIndex);
  });
}

export function occurrenceExists(definition, occurrenceId) {
  const parsed = splitEdgeOccurrenceId(occurrenceId);
  return parsed != null && definition.faces.some((face) =>
    face.id === parsed.faceId && parsed.sideIndex < face.vertices.length,
  );
}
