import { createLegacyBoardDefinition, edgeOccurrenceId, undirectedKey } from "./BoardDefinition.js?v=20261029-topology-round5";

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
      movementStrategy: "simple-rays-v3",
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
  const width = options.width ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const height = options.height ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const definition = makeRectangularTriangularPatch(width, height, "cylinder");
  addLeftRightPairs(definition, width, height, false);
  return definition;
}

export function createMobiusBoardDefinition(options = {}) {
  const width = options.width ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const height = options.height ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const definition = makeRectangularTriangularPatch(width, height, "mobius");
  addLeftRightPairs(definition, width, height, true);
  return definition;
}

export function createTorusBoardDefinition(options = {}) {
  const width = options.width ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const height = options.height ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  if (width < 4 || height < 4) {
    throw new Error("Torus presets require width and height of at least 4 for a nondegenerate opening.");
  }
  const definition = makeRectangularTriangularPatch(width, height, "torus");
  addLeftRightPairs(definition, width, height, false);
  addTopBottomPairs(definition, width, height, false);
  return definition;
}

export function createKleinBottleBoardDefinition(options = {}) {
  const width = options.width ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  const height = options.height ?? (options.gridSize == null ? 4 : options.gridSize - 1);
  if (width < 4 || height < 4) {
    throw new Error("Klein bottle presets require width and height of at least 4 for a nondegenerate opening.");
  }
  const definition = makeRectangularTriangularPatch(width, height, "klein-bottle");
  addLeftRightPairs(definition, width, height, true);
  addTopBottomPairs(definition, width, height, false);
  return definition;
}

// A tetrahedral net: four equal triangular patches inside one larger triangle.
// The three outer corners glue together; each of the other corners is a pole.
export function createTetrahedronBoardDefinition(options = {}) {
  const gridSize = options.gridSize ?? 5;
  if (!Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15) throw new Error("gridSize must be 5 through 15.");
  const m = Math.floor((gridSize - 1) / 2), extent = 2 * m;
  const definition = createLegacyBoardDefinition({ gridSize: extent + 1, boardShape: "triangle" });
  definition.topology = { ...definition.topology, family: "surface", preset: "tetrahedron", movementStrategy: "simple-rays-v3" };
  definition.startingVertices = { BLACK: vertexId(0, 0), WHITE: vertexId(m, m) };
  for (let i = 0; i < m; i += 1) {
    addPair(definition, "tetra:top:" + i, [[i, 0], [i + 1, 0]], [[extent - i, 0], [extent - i - 1, 0]], ([x]) => [extent - x, 0]);
    addPair(definition, "tetra:left:" + i, [[0, i], [0, i + 1]], [[0, extent - i], [0, extent - i - 1]], ([, y]) => [0, extent - y]);
    addPair(definition, "tetra:diagonal:" + i, [[extent - i, i], [extent - i - 1, i + 1]], [[i, extent - i], [i + 1, extent - i - 1]], ([x, y]) => [y, x]);
  }
  return definition;
}

// Three triangular sectors joined along their two radial sides. Their common
// centre is a degree-three pole; the outer three sides remain a real boundary.
export function createConeBoardDefinition(options = {}) {
  const gridSize = options.gridSize ?? 5;
  if (!Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15) throw new Error("gridSize must be 5 through 15.");
  const r = Math.floor((gridSize - 1) / 2);
  const vertices = [], faces = [];
  const contains = (x, y) => y >= 0 && y <= r && x >= 0 && x + y <= 2 * r;
  for (let y = 0; y <= r; y += 1) for (let x = 0; x <= 2 * r; x += 1) {
    if (contains(x, y)) vertices.push({ id: vertexId(x, y), coordinate: [x, y] });
  }
  const addFace = (id, points) => {
    if (points.every(([x, y]) => contains(x, y))) faces.push({ id, vertices: points.map(([x, y]) => vertexId(x, y)) });
  };
  for (let y = 0; y < r; y += 1) for (let x = 0; x < 2 * r; x += 1) {
    addFace("u:" + x + "," + y, [[x,y],[x+1,y],[x,y+1]]);
    addFace("d:" + x + "," + y, [[x+1,y],[x+1,y+1],[x,y+1]]);
  }
  const definition = {
    schemaVersion: 1, coordinateSystem: "triangular-axial-v1",
    topology: { family: "surface", preset: "cone", movementStrategy: "simple-rays-v3", territoryStrategy: "surface-discrete-v1", specialVertexPolicy: "stop" },
    vertices, faces, seamPairs: [],
    startingVertices: { BLACK: vertexId(r, 0), WHITE: vertexId(r, r) },
    scoring: { strategy: "canonical-vertices-v1" },
  };
  for (let i = 0; i < r; i += 1) {
    addPair(definition, "cone:radial:" + i,
      [[r-i,0],[r-i-1,0]], [[r+i,0],[r+i+1,0]], ([x]) => [2*r-x,0]);
  }
  return definition;
}

// The tetrahedral triangulation is radially projected to a sphere by the 3D
// viewer. Its combinatorics are a closed sphere, not a collapsed pole grid.
export function createSphereBoardDefinition(options = {}) {
  const definition = createTetrahedronBoardDefinition(options);
  definition.topology.preset = "sphere";
  return definition;
}

export function createSurfacePreset(name, options = {}) {
  if (options.gridSize != null && (!Number.isInteger(options.gridSize) || options.gridSize < 5 || options.gridSize > 15)) throw new Error("gridSize must be 5 through 15.");
  switch (name) {
    case "cone":
      return createConeBoardDefinition(options);
    case "sphere":
      return createSphereBoardDefinition(options);
    case "tetrahedron":
      return createTetrahedronBoardDefinition(options);
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
  "cone",
  "sphere",
  "tetrahedron",
  "cylinder",
  "mobius",
  "torus",
  "klein-bottle",
]);
