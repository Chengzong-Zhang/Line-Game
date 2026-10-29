export const BOARD_TOPOLOGY_CONTRACT_VERSION = "board-topology-v1";

const vertexId = (x, y) => "v:" + x + "," + y;
const coordinateKey = (coordinate) => coordinate[0] + "," + coordinate[1];
const edgeKey = (left, right) => [left, right].sort().join("|");

export const edgeOccurrenceId = (faceId, sideIndex) => faceId + ":" + sideIndex;

export function makeTriangularPatchDefinition({
  width = 4,
  height = 3,
  excludedCoordinates = [],
  family = "planar",
  startingVertices = null,
} = {}) {
  const excluded = new Set(excludedCoordinates.map(coordinateKey));
  const hasCoordinate = (x, y) => x >= 0 && x <= width && y >= 0 && y <= height
    && !excluded.has(x + "," + y);
  const vertices = [];
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      if (hasCoordinate(x, y)) vertices.push({ id: vertexId(x, y), coordinate: [x, y] });
    }
  }
  const faces = [];
  const addFace = (id, coordinates) => {
    if (coordinates.every(([x, y]) => hasCoordinate(x, y))) {
      faces.push({ id, vertices: coordinates.map(([x, y]) => vertexId(x, y)) });
    }
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      addFace("u:" + x + "," + y, [[x, y], [x + 1, y], [x, y + 1]]);
      addFace("d:" + x + "," + y, [[x + 1, y], [x + 1, y + 1], [x, y + 1]]);
    }
  }
  return {
    schemaVersion: 1,
    coordinateSystem: "triangular-axial-v1",
    topology: {
      family,
      movementStrategy: "simple-rays-v1",
      territoryStrategy: "surface-discrete-v1",
      specialVertexPolicy: "stop",
    },
    vertices,
    faces,
    seamPairs: [],
    startingVertices: startingVertices ?? {
      BLACK: vertexId(0, 0),
      WHITE: vertexId(width, height),
    },
    scoring: { strategy: "canonical-vertices-v1" },
  };
}

export function collectBoundaryOccurrences(definition) {
  const occurrences = new Map();
  for (const face of definition.faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const left = face.vertices[sideIndex];
      const right = face.vertices[(sideIndex + 1) % face.vertices.length];
      const key = edgeKey(left, right);
      const occurrence = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices: [left, right],
      };
      const list = occurrences.get(key) ?? [];
      list.push(occurrence);
      occurrences.set(key, list);
    }
  }
  return [...occurrences.values()].filter((items) => items.length === 1).map((items) => items[0]);
}

export function findBoundaryOccurrence(definition, leftVertexId, rightVertexId) {
  const wanted = edgeKey(leftVertexId, rightVertexId);
  return collectBoundaryOccurrences(definition).find((occurrence) =>
    edgeKey(occurrence.vertices[0], occurrence.vertices[1]) === wanted,
  ) ?? null;
}

export function copyDefinition(definition) {
  return structuredClone(definition);
}

export const CONCAVE_GAP_DEFINITION = makeTriangularPatchDefinition({
  width: 5,
  height: 3,
  excludedCoordinates: [[3, 0]],
  startingVertices: {
    BLACK: vertexId(0, 0),
    WHITE: vertexId(5, 3),
  },
});

const seamBase = makeTriangularPatchDefinition({
  width: 4,
  height: 3,
  startingVertices: {
    BLACK: vertexId(0, 0),
    WHITE: vertexId(4, 3),
  },
});
const firstSeamOccurrence = findBoundaryOccurrence(seamBase, vertexId(0, 0), vertexId(1, 0));
const secondSeamOccurrence = findBoundaryOccurrence(seamBase, vertexId(4, 1), vertexId(4, 2));
if (!firstSeamOccurrence || !secondSeamOccurrence) {
  throw new Error("The frozen topology fixture lost a selected boundary occurrence.");
}

export const NONADJACENT_SAME_DIRECTION_SEAM = {
  ...copyDefinition(seamBase),
  seamPairs: [{
    id: "seam:nonadjacent:same-direction",
    edgeOccurrenceA: firstSeamOccurrence.id,
    edgeOccurrenceB: secondSeamOccurrence.id,
    endpointMap: [0, 1],
  }],
};

export const NONADJACENT_REVERSED_SEAM = {
  ...copyDefinition(seamBase),
  seamPairs: [{
    id: "seam:nonadjacent:reversed",
    edgeOccurrenceA: firstSeamOccurrence.id,
    edgeOccurrenceB: secondSeamOccurrence.id,
    endpointMap: [1, 0],
  }],
};

export const INVALID_SEAM_FIXTURES = {
  self: {
    ...copyDefinition(seamBase),
    seamPairs: [{
      id: "seam:self",
      edgeOccurrenceA: firstSeamOccurrence.id,
      edgeOccurrenceB: firstSeamOccurrence.id,
      endpointMap: [0, 1],
    }],
  },
  duplicate: {
    ...copyDefinition(seamBase),
    seamPairs: [
      {
        id: "seam:first",
        edgeOccurrenceA: firstSeamOccurrence.id,
        edgeOccurrenceB: secondSeamOccurrence.id,
        endpointMap: [0, 1],
      },
      {
        id: "seam:second",
        edgeOccurrenceA: firstSeamOccurrence.id,
        edgeOccurrenceB: findBoundaryOccurrence(seamBase, vertexId(0, 2), vertexId(0, 3)).id,
        endpointMap: [1, 0],
      },
    ],
  },
  endpointMap: {
    ...copyDefinition(seamBase),
    seamPairs: [{
      id: "seam:bad-map",
      edgeOccurrenceA: firstSeamOccurrence.id,
      edgeOccurrenceB: secondSeamOccurrence.id,
      endpointMap: [0, 0],
    }],
  },
};

export const PRESET_EXPECTATIONS = Object.freeze({
  cylinder: { boundaryComponents: 2, eulerCharacteristic: 0, orientable: true },
  mobius: { boundaryComponents: 1, eulerCharacteristic: 0, orientable: false },
  torus: { boundaryComponents: 0, eulerCharacteristic: 0, orientable: true },
  kleinBottle: { boundaryComponents: 0, eulerCharacteristic: 0, orientable: false },
});

export const HAND_EXPECTATIONS = Object.freeze({
  contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
  concaveGap: {
    missingCoordinate: [3, 0],
    blockedCollinearEndpoints: [vertexId(2, 0), vertexId(4, 0)],
  },
  seam: {
    firstOccurrenceId: firstSeamOccurrence.id,
    secondOccurrenceId: secondSeamOccurrence.id,
    endpointMaps: [[0, 1], [1, 0]],
  },
  territory: {
    planarDonut: { withoutEnemy: 7, withCenterEnemy: 6 },
  },
});
