import {
  BOARD_TOPOLOGY_CONTRACT_VERSION,
  canonicalizeBoard,
  compareStableIdentifiers,
  createLegacyBoardDefinition,
  makeBoardError,
  sha256Hex,
  validateBoardDefinition,
} from "./BoardDefinition.js?v=20261029-topology-round5";
import { analyzeBoardTopology } from "./BoardTopology.js?v=20261029-topology-round5";

function deepFreeze(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function mapAdjacencyToObject(adjacency) {
  return Object.fromEntries([...adjacency.entries()]
    .sort(([left], [right]) => compareStableIdentifiers(left, right))
    .map(([vertexId, neighbors]) => [vertexId, [...neighbors].sort()]));
}

function canonicalStartingVertices(definition, rawToCanonical) {
  const errors = [];
  const result = {};
  const occupied = new Set();
  for (const [player, rawValue] of Object.entries(definition.startingVertices ?? {})) {
    const roots = [];
    for (const rawVertexId of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      const canonicalVertexId = rawToCanonical.get(rawVertexId);
      if (!canonicalVertexId) {
        errors.push(makeBoardError("UNKNOWN_START_VERTEX", "startingVertices." + player, rawVertexId));
      } else if (occupied.has(canonicalVertexId)) {
        errors.push(makeBoardError("DUPLICATE_START_VERTEX", "startingVertices." + player, canonicalVertexId));
      } else {
        occupied.add(canonicalVertexId);
        roots.push(canonicalVertexId);
      }
    }
    result[player] = roots;
  }
  return { errors, value: result };
}

function sampleWeights(definition, canonicalVertices) {
  const errors = [];
  const weights = {};
  const rawWeights = definition.scoring?.weights ?? {};
  for (const canonicalVertex of canonicalVertices) {
    const sourceWeights = canonicalVertex.sourceVertexIds
      .map((rawVertexId) => rawWeights[rawVertexId] ?? 1);
    if (new Set(sourceWeights).size > 1) {
      errors.push(makeBoardError("CONFLICTING_CANONICAL_WEIGHT",
        "scoring.weights." + canonicalVertex.id,
        canonicalVertex.sourceVertexIds.join(",")));
      continue;
    }
    weights[canonicalVertex.id] = sourceWeights[0];
  }
  return { errors, value: weights };
}

function renderCanonicalVertices(definition, topology) {
  const coordinatesById = new Map(definition.vertices.map((vertex) => [vertex.id, vertex.coordinate]));
  return topology.canonicalVertices.map((vertex) => ({
    id: vertex.id,
    sourceVertexIds: [...vertex.sourceVertexIds],
    atlasCoordinates: vertex.sourceVertexIds.map((sourceVertexId) => [...coordinatesById.get(sourceVertexId)]),
  }));
}

function buildCompiledBoard(definition, boardHash, topology) {
  const starts = canonicalStartingVertices(definition, topology.rawToCanonical);
  const weights = sampleWeights(definition, topology.canonicalVertices);
  const errors = [...topology.errors, ...starts.errors, ...weights.errors];
  if (errors.length) return { ok: false, errors };

  const canonicalVertices = renderCanonicalVertices(definition, topology);
  const rawVertexToCanonical = Object.fromEntries([...topology.rawToCanonical.entries()]
    .sort(([left], [right]) => compareStableIdentifiers(left, right)));
  const sampleAdjacency = mapAdjacencyToObject(topology.canonicalAdjacency);
  const samples = canonicalVertices.map((vertex) => ({
    id: vertex.id,
    weight: weights.value[vertex.id],
  }));
  const compiled = {
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    schemaVersion: definition.schemaVersion,
    rules: {
      movementStrategy: definition.topology.movementStrategy,
      territoryStrategy: definition.topology.territoryStrategy,
      specialVertexPolicy: definition.topology.specialVertexPolicy,
    },
    definition,
    boardHash,
    canonicalVertices,
    rawVertexToCanonical,
    canonicalAdjacency: sampleAdjacency,
    sampleIds: samples.map((sample) => sample.id),
    sampleWeights: weights.value,
    sampleAdjacency,
    realBoundarySampleIds: [...topology.realBoundaryVertexIds],
    startingVertices: Object.fromEntries(Object.entries(starts.value).map(([player, roots]) => [player, roots[0]])),
    startingRoots: starts.value,
    edgeOccurrences: topology.edgeOccurrences,
    edgeClasses: topology.edgeClasses.map((edgeClass) => ({
      id: edgeClass.id,
      canonicalVertices: [...edgeClass.canonicalVertices],
      occurrences: edgeClass.occurrences.map((occurrence) => ({
        id: occurrence.id,
        faceId: occurrence.faceId,
        sideIndex: occurrence.sideIndex,
        vertices: [...occurrence.vertices],
        canonicalVertices: [...occurrence.canonicalVertices],
      })),
    })),
    realBoundaryEdgeClassIds: [...topology.realBoundaryEdgeClassIds],
    boundaryComponents: topology.boundaryComponents.map((component) => [...component]),
    eulerCharacteristic: topology.eulerCharacteristic,
    orientable: topology.orientable,
    vertexLinks: topology.vertexLinks.map((link) => ({ ...link })),
    specialVertices: topology.specialVertices.map((vertex) => ({ ...vertex })),
    directionTransitions: topology.directionTransitions.map((transition) => ({
      ...transition,
      endpointMap: [...transition.endpointMap],
      directionMap: transition.directionMap ? [...transition.directionMap] : null,
    })),
    atlas: {
      pointCopies: canonicalVertices.flatMap((vertex) => vertex.atlasCoordinates.map((coordinate, index) => ({
        canonicalVertexId: vertex.id,
        sourceVertexId: vertex.sourceVertexIds[index],
        coordinate: [...coordinate],
      }))),
    },
  };
  return { ok: true, value: deepFreeze(compiled), errors: [] };
}

export function compileBoard(definition, limits = {}) {
  const canonicalized = canonicalizeBoard(definition, limits);
  if (!canonicalized.ok) return canonicalized;
  return buildCompiledBoard(canonicalized.definition, canonicalized.boardHash,
    analyzeBoardTopology(canonicalized.definition));
}

export function compileBoardOrThrow(definition, limits = {}) {
  const result = compileBoard(definition, limits);
  if (result.ok) return result.value;
  const summary = result.errors.map((error) => error.code + "@" + error.location).join(", ");
  throw new Error("Board compilation failed: " + summary);
}

export function compileLegacyBoard(options = {}) {
  return compileBoard(createLegacyBoardDefinition(options));
}

export {
  canonicalizeBoard,
  createLegacyBoardDefinition,
  sha256Hex,
  validateBoardDefinition,
};
