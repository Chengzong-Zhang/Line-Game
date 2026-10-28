import { edgeOccurrenceId, undirectedKey } from "./BoardDefinition.js";

const vertexId = (x, y) => "v:" + x + "," + y;

function coordinateKey(coordinate) {
  return coordinate[0] + "," + coordinate[1];
}

function makeRectangularTriangularPatch(width, height, preset) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    throw new Error("Surface presets require integer width and height of at least 3.");
  }
  const vertices = [];
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      vertices.push({ id: vertexId(x, y), coordinate: [x, y] });
    }
  }
  const faces = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      faces.push({
        id: "u:" + x + "," + y,
        vertices: [vertexId(x, y), vertexId(x + 1, y), vertexId(x, y + 1)],
      });
      faces.push({
        id: "d:" + x + "," + y,
        vertices: [vertexId(x + 1, y), vertexId(x + 1, y + 1), vertexId(x, y + 1)],
      });
    }
  }
  return {
    schemaVersion: 1,
    coordinateSystem: "triangular-axial-v1",
    topology: {
      family: "surface",
      preset,
      movementStrategy: "simple-rays-v1",
      territoryStrategy: "surface-discrete-v1",
      specialVertexPolicy: "stop",
    },
    vertices,
    faces,
    seamPairs: [],
    startingVertices: {
      // Keep the defaults distinct after the standard quotient maps and leave
      // each opening with at least one legal connection on the supported
      // minimum preset sizes.  The earlier two interior coordinates could
      // make every first move fall in the opponent's protection zone on a
      // 4×4 closed quotient.
      BLACK: vertexId(0, 0),
      WHITE: vertexId(Math.max(1, width - 1), Math.max(1, height - 1)),
    },
    scoring: { strategy: "canonical-vertices-v1" },
  };
}

function boundaryOccurrences(definition) {
  const byEdge = new Map();
  for (const face of definition.faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const vertices = [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]];
      const key = undirectedKey(vertices[0], vertices[1]);
      const entry = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices,
      };
      const list = byEdge.get(key) ?? [];
      list.push(entry);
      byEdge.set(key, list);
    }
  }
  return [...byEdge.values()].filter((entries) => entries.length === 1).map((entries) => entries[0]);
}

function findBoundaryOccurrence(definition, coordinateA, coordinateB) {
  const wanted = undirectedKey(vertexId(...coordinateA), vertexId(...coordinateB));
  return boundaryOccurrences(definition).find((occurrence) =>
    undirectedKey(occurrence.vertices[0], occurrence.vertices[1]) === wanted,
  );
}

function addPair(definition, id, sourceCoordinates, targetCoordinates, pointMap) {
  const source = findBoundaryOccurrence(definition, sourceCoordinates[0], sourceCoordinates[1]);
  const target = findBoundaryOccurrence(definition, targetCoordinates[0], targetCoordinates[1]);
  if (!source || !target) {
    throw new Error("Preset " + id + " did not find a required boundary occurrence.");
  }
  const targetByCoordinate = new Map(target.vertices.map((id) => [id, target.vertices.indexOf(id)]));
  const endpointMap = source.vertices.map((sourceVertexId) => {
    const sourceCoordinate = sourceVertexId.slice(2).split(",").map(Number);
    const expectedTargetCoordinate = pointMap(sourceCoordinate);
    return targetByCoordinate.get(vertexId(...expectedTargetCoordinate));
  });
  if (!endpointMap.every((value) => value === 0 || value === 1)
    || new Set(endpointMap).size !== 2) {
    throw new Error("Preset " + id + " produced an invalid endpoint map.");
  }
  definition.seamPairs.push({
    id,
    edgeOccurrenceA: source.id,
    edgeOccurrenceB: target.id,
    endpointMap,
  });
}

function addLeftRightPairs(definition, width, height, reversed) {
  for (let y = 0; y < height; y += 1) {
    addPair(definition, "lr:" + y,
      [[0, y], [0, y + 1]],
      [[width, reversed ? height - y - 1 : y], [width, reversed ? height - y : y + 1]],
      ([, sourceY]) => [width, reversed ? height - sourceY : sourceY]);
  }
}

function addTopBottomPairs(definition, width, height, reversed) {
  for (let x = 0; x < width; x += 1) {
    addPair(definition, "tb:" + x,
      [[x, 0], [x + 1, 0]],
      [[reversed ? width - x - 1 : x, height], [reversed ? width - x : x + 1, height]],
      ([sourceX]) => [reversed ? width - sourceX : sourceX, height]);
  }
}

export function createCylinderBoardDefinition(options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const definition = makeRectangularTriangularPatch(width, height, "cylinder");
  addLeftRightPairs(definition, width, height, false);
  return definition;
}

export function createMobiusBoardDefinition(options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const definition = makeRectangularTriangularPatch(width, height, "mobius");
  addLeftRightPairs(definition, width, height, true);
  return definition;
}

export function createTorusBoardDefinition(options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  if (width < 4 || height < 4) {
    throw new Error("Torus presets require width and height of at least 4 for a nondegenerate opening.");
  }
  const definition = makeRectangularTriangularPatch(width, height, "torus");
  addLeftRightPairs(definition, width, height, false);
  addTopBottomPairs(definition, width, height, false);
  return definition;
}

export function createKleinBottleBoardDefinition(options = {}) {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  if (width < 4 || height < 4) {
    throw new Error("Klein bottle presets require width and height of at least 4 for a nondegenerate opening.");
  }
  const definition = makeRectangularTriangularPatch(width, height, "klein-bottle");
  addLeftRightPairs(definition, width, height, true);
  addTopBottomPairs(definition, width, height, false);
  return definition;
}

export function createSurfacePreset(name, options = {}) {
  switch (name) {
    case "cylinder":
      return createCylinderBoardDefinition(options);
    case "mobius":
      return createMobiusBoardDefinition(options);
    case "torus":
      return createTorusBoardDefinition(options);
    case "klein-bottle":
    case "kleinBottle":
      return createKleinBottleBoardDefinition(options);
    default:
      throw new Error("Unsupported surface preset: " + name);
  }
}

export const SURFACE_PRESET_NAMES = Object.freeze([
  "cylinder",
  "mobius",
  "torus",
  "klein-bottle",
]);
