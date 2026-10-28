export const BOARD_TOPOLOGY_CONTRACT_VERSION = "board-topology-v1";

// Board identifiers travel through browser, Worker, Python-room and replay
// implementations.  Keep their comparison independent of the host locale:
// String#localeCompare can order the same Unicode identifiers differently from
// Python's deterministic sort and would make a boardHash protocol split.
// Identifiers are internal protocol tokens rather than player-facing labels,
// so a compact ASCII grammar is both sufficient and deliberately fail-closed.
const PROTOCOL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:,_-]{0,127}$/;

export function compareStableIdentifiers(left, right) {
  const normalizedLeft = String(left);
  const normalizedRight = String(right);
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function isProtocolIdentifier(value) {
  return typeof value === "string" && PROTOCOL_IDENTIFIER.test(value);
}

function hasProtocolSafeObjectKeys(value) {
  if (value == null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(hasProtocolSafeObjectKeys);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, child]) =>
    isProtocolIdentifier(key) && hasProtocolSafeObjectKeys(child));
}
export const BOARD_DEFINITION_SCHEMA_VERSION = 1;
export const BOARD_HASH_SCHEMA_VERSION = "board-hash-v1";
export const TRIANGULAR_UNIT_DIRECTIONS = Object.freeze([
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]);

export const DEFAULT_BOARD_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxVertices: 1024,
  maxFaces: 2048,
  maxEdgeOccurrences: 4096,
  maxSeamPairs: 512,
  maxStarts: 6,
  maxSamples: 4096,
  coordinateAbs: 32768,
});

const VALID_ENDPOINT_MAPS = new Set(["0,1", "1,0"]);
const VALID_TOPOLOGY_FAMILIES = new Set(["planar", "surface"]);
const isPlainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function edgeOccurrenceId(faceId, sideIndex) {
  return String(faceId) + ":" + sideIndex;
}

export function splitEdgeOccurrenceId(id) {
  if (typeof id !== "string") return null;
  const separator = id.lastIndexOf(":");
  if (separator <= 0) return null;
  const faceId = id.slice(0, separator);
  const sideIndex = Number(id.slice(separator + 1));
  return Number.isInteger(sideIndex) && sideIndex >= 0 ? { faceId, sideIndex } : null;
}

export function undirectedKey(left, right) {
  return String(left) < String(right)
    ? String(left) + "|" + String(right)
    : String(right) + "|" + String(left);
}

export function triangularDirectionIndex(fromCoordinate, toCoordinate) {
  if (!Array.isArray(fromCoordinate) || !Array.isArray(toCoordinate)) return -1;
  const dx = toCoordinate[0] - fromCoordinate[0];
  const dy = toCoordinate[1] - fromCoordinate[1];
  return TRIANGULAR_UNIT_DIRECTIONS.findIndex(([x, y]) => x === dx && y === dy);
}

export function makeBoardError(code, location, detail = "") {
  return { code, location, detail };
}

function addError(errors, code, location, detail = "") {
  errors.push(makeBoardError(code, location, detail));
}

function mergeLimits(limits = {}) {
  const merged = { ...DEFAULT_BOARD_LIMITS };
  if (isPlainObject(limits)) {
    for (const [key, value] of Object.entries(limits)) {
      if (own(merged, key) && Number.isInteger(value) && value > 0) merged[key] = value;
    }
  }
  return merged;
}

function getJsonByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function signedFaceArea(verticesById, face) {
  const [left, right, top] = face.vertices.map((id) => verticesById.get(id).coordinate);
  return (right[0] - left[0]) * (top[1] - left[1])
    - (right[1] - left[1]) * (top[0] - left[0]);
}

function buildOccurrences(faces) {
  const occurrences = [];
  const byId = new Map();
  const byRawEdge = new Map();
  for (const face of faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const vertices = [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]];
      const occurrence = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices,
        rawEdgeKey: undirectedKey(vertices[0], vertices[1]),
      };
      occurrences.push(occurrence);
      byId.set(occurrence.id, occurrence);
      const group = byRawEdge.get(occurrence.rawEdgeKey) ?? [];
      group.push(occurrence);
      byRawEdge.set(occurrence.rawEdgeKey, group);
    }
  }
  return { occurrences, byId, byRawEdge };
}

function findDisconnectedVertexIds(vertexIds, occurrences) {
  if (!vertexIds.length) return vertexIds;
  const adjacency = new Map(vertexIds.map((id) => [id, new Set()]));
  for (const occurrence of occurrences) {
    const [left, right] = occurrence.vertices;
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }
  const reached = new Set([vertexIds[0]]);
  const pending = [vertexIds[0]];
  while (pending.length) {
    const current = pending.pop();
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return vertexIds.filter((id) => !reached.has(id));
}

function normalizeTopology(topology) {
  return {
    family: topology.family,
    movementStrategy: topology.movementStrategy ?? "simple-rays-v1",
    territoryStrategy: topology.territoryStrategy ?? "surface-discrete-v1",
    specialVertexPolicy: topology.specialVertexPolicy ?? "stop",
    ...(typeof topology.preset === "string" ? { preset: topology.preset } : {}),
  };
}

function cloneAndSortDefinition(definition) {
  const clone = {
    schemaVersion: definition.schemaVersion,
    coordinateSystem: definition.coordinateSystem,
    topology: normalizeTopology(definition.topology),
    vertices: definition.vertices.map((vertex) => ({
      id: vertex.id,
      coordinate: [vertex.coordinate[0], vertex.coordinate[1]],
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    faces: definition.faces.map((face) => ({
      id: face.id,
      vertices: [...face.vertices],
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    seamPairs: (definition.seamPairs ?? []).map((pair) => ({
      id: pair.id,
      edgeOccurrenceA: pair.edgeOccurrenceA,
      edgeOccurrenceB: pair.edgeOccurrenceB,
      endpointMap: [...pair.endpointMap],
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    scoring: {
      strategy: definition.scoring?.strategy ?? "canonical-vertices-v1",
      ...(isPlainObject(definition.scoring?.weights)
        ? { weights: Object.fromEntries(Object.entries(definition.scoring.weights)
          .sort(([left], [right]) => compareStableIdentifiers(left, right))) }
        : {}),
    },
  };
  if (isPlainObject(definition.startingVertices)) {
    clone.startingVertices = Object.fromEntries(Object.entries(definition.startingVertices)
      .sort(([left], [right]) => compareStableIdentifiers(left, right)));
  }
  if (isPlainObject(definition.generator)) {
    clone.generator = JSON.parse(stableStringify(definition.generator));
  }
  return clone;
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort(compareStableIdentifiers).map((key) =>
    JSON.stringify(key) + ":" + stableStringify(value[key]),
  ).join(",") + "}";
}

function rightRotate(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

// Browser-compatible synchronous SHA-256. Hashing is intentionally local so
// a board definition has the same identity in Node, browser Workers and mini-app bundles.
export function sha256Hex(message) {
  const bytes = new TextEncoder().encode(String(message));
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const lengthHigh = Math.floor(bitLength / 0x100000000);
  const lengthLow = bitLength >>> 0;
  data[paddedLength - 8] = (lengthHigh >>> 24) & 0xff;
  data[paddedLength - 7] = (lengthHigh >>> 16) & 0xff;
  data[paddedLength - 6] = (lengthHigh >>> 8) & 0xff;
  data[paddedLength - 5] = lengthHigh & 0xff;
  data[paddedLength - 4] = (lengthLow >>> 24) & 0xff;
  data[paddedLength - 3] = (lengthLow >>> 16) & 0xff;
  data[paddedLength - 2] = (lengthLow >>> 8) & 0xff;
  data[paddedLength - 1] = lengthLow & 0xff;

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = (data[start] << 24) | (data[start + 1] << 16)
        | (data[start + 2] << 8) | data[start + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18)
        ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19)
        ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function validateBoardDefinition(raw, limits = {}) {
  const errors = [];
  const resolvedLimits = mergeLimits(limits);
  if (!isPlainObject(raw)) {
    addError(errors, "INVALID_DEFINITION", "$", "Board definition must be a plain JSON object.");
    return { ok: false, errors, limits: resolvedLimits };
  }
  if (getJsonByteLength(raw) > resolvedLimits.maxBytes) {
    addError(errors, "LIMIT_EXCEEDED", "$", "Serialized board definition exceeds maxBytes.");
  }
  if (raw.schemaVersion !== BOARD_DEFINITION_SCHEMA_VERSION) {
    addError(errors, "UNSUPPORTED_SCHEMA", "schemaVersion", "Expected schemaVersion 1.");
  }
  if (raw.coordinateSystem !== "triangular-axial-v1") {
    addError(errors, "UNSUPPORTED_COORDINATE_SYSTEM", "coordinateSystem",
      "Expected triangular-axial-v1.");
  }
  if (!isPlainObject(raw.topology) || !VALID_TOPOLOGY_FAMILIES.has(raw.topology.family)) {
    addError(errors, "INVALID_TOPOLOGY", "topology.family", "Expected planar or surface.");
  }
  if (!Array.isArray(raw.vertices) || raw.vertices.length === 0) {
    addError(errors, "INVALID_VERTICES", "vertices", "At least one vertex is required.");
  } else if (raw.vertices.length > resolvedLimits.maxVertices) {
    addError(errors, "LIMIT_EXCEEDED", "vertices", "Too many vertices.");
  }

  const verticesById = new Map();
  const coordinateIds = new Map();
  if (Array.isArray(raw.vertices)) {
    raw.vertices.forEach((vertex, index) => {
      const location = "vertices[" + index + "]";
      if (!isPlainObject(vertex) || !isProtocolIdentifier(vertex.id)) {
        addError(errors, "INVALID_VERTEX_ID", location + ".id",
          "Vertex id must use the board-topology ASCII identifier grammar.");
        return;
      }
      if (verticesById.has(vertex.id)) {
        addError(errors, "DUPLICATE_VERTEX_ID", location + ".id", vertex.id);
        return;
      }
      if (!Array.isArray(vertex.coordinate) || vertex.coordinate.length !== 2
        || !vertex.coordinate.every(Number.isInteger)
        || vertex.coordinate.some((value) => Math.abs(value) > resolvedLimits.coordinateAbs)) {
        addError(errors, "INVALID_COORDINATE", location + ".coordinate",
          "Coordinate must be two bounded integers.");
        return;
      }
      const key = vertex.coordinate.join(",");
      if (coordinateIds.has(key)) {
        addError(errors, "DUPLICATE_VERTEX_COORDINATE", location + ".coordinate", key);
        return;
      }
      verticesById.set(vertex.id, { id: vertex.id, coordinate: [...vertex.coordinate] });
      coordinateIds.set(key, vertex.id);
    });
  }

  if (!Array.isArray(raw.faces) || raw.faces.length === 0) {
    addError(errors, "INVALID_FACES", "faces", "At least one triangular face is required.");
  } else if (raw.faces.length > resolvedLimits.maxFaces) {
    addError(errors, "LIMIT_EXCEEDED", "faces", "Too many faces.");
  }
  const faces = [];
  const faceIds = new Set();
  const seenFaceVertexSets = new Set();
  if (Array.isArray(raw.faces)) {
    raw.faces.forEach((face, index) => {
      const location = "faces[" + index + "]";
      if (!isPlainObject(face) || !isProtocolIdentifier(face.id)) {
        addError(errors, "INVALID_FACE_ID", location + ".id",
          "Face id must use the board-topology ASCII identifier grammar.");
        return;
      }
      if (faceIds.has(face.id)) {
        addError(errors, "DUPLICATE_FACE_ID", location + ".id", face.id);
        return;
      }
      faceIds.add(face.id);
      if (!Array.isArray(face.vertices) || face.vertices.length !== 3
        || !face.vertices.every((id) => typeof id === "string")) {
        addError(errors, "INVALID_FACE_VERTICES", location + ".vertices",
          "Faces must have exactly three vertex ids.");
        return;
      }
      if (new Set(face.vertices).size !== 3) {
        addError(errors, "DEGENERATE_FACE", location + ".vertices", "Repeated face vertex.");
        return;
      }
      const unknown = face.vertices.find((id) => !verticesById.has(id));
      if (unknown) {
        addError(errors, "UNKNOWN_FACE_VERTEX", location + ".vertices", unknown);
        return;
      }
      const stored = { id: face.id, vertices: [...face.vertices] };
      if (signedFaceArea(verticesById, stored) === 0) {
        addError(errors, "DEGENERATE_FACE", location + ".vertices", "Zero coordinate area.");
        return;
      }
      for (let sideIndex = 0; sideIndex < stored.vertices.length; sideIndex += 1) {
        const from = verticesById.get(stored.vertices[sideIndex]).coordinate;
        const to = verticesById.get(stored.vertices[(sideIndex + 1) % stored.vertices.length]).coordinate;
        if (triangularDirectionIndex(from, to) < 0) {
          addError(errors, "NON_UNIT_TRIANGULAR_EDGE",
            location + ".vertices[" + sideIndex + "]",
            stored.vertices[sideIndex] + "->" + stored.vertices[(sideIndex + 1) % stored.vertices.length]);
        }
      }
      const faceSetKey = [...stored.vertices].sort(compareStableIdentifiers).join("|");
      if (seenFaceVertexSets.has(faceSetKey)) {
        addError(errors, "DUPLICATE_FACE", location + ".vertices", faceSetKey);
        return;
      }
      seenFaceVertexSets.add(faceSetKey);
      faces.push(stored);
    });
  }

  const { occurrences, byId: occurrenceById, byRawEdge } = buildOccurrences(faces);
  if (occurrences.length > resolvedLimits.maxEdgeOccurrences) {
    addError(errors, "LIMIT_EXCEEDED", "faces", "Too many edge occurrences.");
  }
  for (const [rawEdgeKey, group] of byRawEdge) {
    if (group.length > 2) {
      addError(errors, "NON_MANIFOLD_EDGE", "edge:" + rawEdgeKey,
        "A raw edge has " + group.length + " face occurrences.");
    }
  }

  const seamPairs = [];
  const seamIds = new Set();
  const pairedOccurrences = new Set();
  if (raw.seamPairs != null && !Array.isArray(raw.seamPairs)) {
    addError(errors, "INVALID_SEAM_PAIRS", "seamPairs", "Expected an array.");
  }
  if (Array.isArray(raw.seamPairs)) {
    if (raw.seamPairs.length > resolvedLimits.maxSeamPairs) {
      addError(errors, "LIMIT_EXCEEDED", "seamPairs", "Too many seam pairs.");
    }
    raw.seamPairs.forEach((pair, index) => {
      const location = "seamPairs[" + index + "]";
      if (!isPlainObject(pair) || !isProtocolIdentifier(pair.id)) {
        addError(errors, "INVALID_SEAM_ID", location + ".id",
          "Seam id must use the board-topology ASCII identifier grammar.");
        return;
      }
      if (seamIds.has(pair.id)) {
        addError(errors, "DUPLICATE_SEAM_ID", location + ".id", pair.id);
        return;
      }
      seamIds.add(pair.id);
      const left = occurrenceById.get(pair.edgeOccurrenceA);
      const right = occurrenceById.get(pair.edgeOccurrenceB);
      if (!left || !right) {
        addError(errors, "UNKNOWN_EDGE_OCCURRENCE", location,
          String(pair.edgeOccurrenceA) + "," + String(pair.edgeOccurrenceB));
        return;
      }
      if (left.id === right.id) {
        addError(errors, "SELF_SEAM", location, left.id);
        return;
      }
      if (!VALID_ENDPOINT_MAPS.has(Array.isArray(pair.endpointMap) ? pair.endpointMap.join(",") : "")) {
        addError(errors, "INVALID_ENDPOINT_MAP", location + ".endpointMap", "Expected [0,1] or [1,0].");
        return;
      }
      if ((byRawEdge.get(left.rawEdgeKey) ?? []).length !== 1
        || (byRawEdge.get(right.rawEdgeKey) ?? []).length !== 1) {
        addError(errors, "SEAM_REQUIRES_BOUNDARY_EDGE", location,
          "Only raw boundary edge occurrences can be paired.");
        return;
      }
      for (const occurrence of [left.id, right.id]) {
        if (pairedOccurrences.has(occurrence)) {
          addError(errors, "DUPLICATE_SEAM_OCCURRENCE", location, occurrence);
        }
        pairedOccurrences.add(occurrence);
      }
      seamPairs.push({
        id: pair.id,
        edgeOccurrenceA: left.id,
        edgeOccurrenceB: right.id,
        endpointMap: [...pair.endpointMap],
      });
    });
  }

  let startingVertices = undefined;
  if (raw.startingVertices != null) {
    if (!isPlainObject(raw.startingVertices)) {
      addError(errors, "INVALID_STARTING_VERTICES", "startingVertices", "Expected a player-to-vertex object.");
    } else {
      const entries = Object.entries(raw.startingVertices);
      if (entries.length > resolvedLimits.maxStarts) {
        addError(errors, "LIMIT_EXCEEDED", "startingVertices", "Too many starting vertices.");
      }
      const starts = new Set();
      startingVertices = {};
      for (const [player, vertexId] of entries) {
        if (!isProtocolIdentifier(player)) {
          addError(errors, "INVALID_STARTING_PLAYER_ID", "startingVertices." + player,
            "Player id must use the board-topology ASCII identifier grammar.");
          continue;
        }
        if (typeof vertexId !== "string" || !verticesById.has(vertexId)) {
          addError(errors, "UNKNOWN_START_VERTEX", "startingVertices." + player, String(vertexId));
          continue;
        }
        if (starts.has(vertexId)) {
          addError(errors, "DUPLICATE_START_VERTEX", "startingVertices." + player, vertexId);
          continue;
        }
        starts.add(vertexId);
        startingVertices[player] = vertexId;
      }
    }
  }

  let scoring = { strategy: "canonical-vertices-v1" };
  if (raw.scoring != null) {
    if (!isPlainObject(raw.scoring)
      || (raw.scoring.strategy != null && raw.scoring.strategy !== "canonical-vertices-v1")) {
      addError(errors, "INVALID_SCORING", "scoring", "Expected canonical-vertices-v1.");
    } else {
      scoring = { strategy: raw.scoring.strategy ?? "canonical-vertices-v1" };
      if (raw.scoring.weights != null) {
        if (!isPlainObject(raw.scoring.weights)) {
          addError(errors, "INVALID_SAMPLE_WEIGHT", "scoring.weights", "Expected an object.");
        } else {
          scoring.weights = {};
          for (const [vertexId, weight] of Object.entries(raw.scoring.weights)) {
            if (!verticesById.has(vertexId) || !Number.isInteger(weight) || weight <= 0) {
              addError(errors, "INVALID_SAMPLE_WEIGHT", "scoring.weights." + vertexId, String(weight));
            } else {
              scoring.weights[vertexId] = weight;
            }
          }
        }
      }
    }
  }

  if (isPlainObject(raw.generator) && !hasProtocolSafeObjectKeys(raw.generator)) {
    addError(errors, "INVALID_GENERATOR_KEY", "generator",
      "Generator object keys must use the board-topology ASCII identifier grammar.");
  }

  if (verticesById.size === raw.vertices?.length && occurrences.length) {
    const disconnected = findDisconnectedVertexIds([...verticesById.keys()], occurrences);
    if (disconnected.length) {
      addError(errors, "DISCONNECTED_BOARD", "vertices", disconnected.join(","));
    }
  }

  const value = {
    schemaVersion: BOARD_DEFINITION_SCHEMA_VERSION,
    coordinateSystem: "triangular-axial-v1",
    topology: normalizeTopology(isPlainObject(raw.topology) ? raw.topology : { family: "planar" }),
    vertices: [...verticesById.values()],
    faces,
    seamPairs,
    ...(startingVertices ? { startingVertices } : {}),
    scoring,
    ...(isPlainObject(raw.generator) ? { generator: JSON.parse(stableStringify(raw.generator)) } : {}),
  };
  return errors.length
    ? { ok: false, errors, limits: resolvedLimits }
    : { ok: true, value, errors: [], limits: resolvedLimits };
}

export function canonicalizeBoard(definition, limits = {}) {
  const validation = validateBoardDefinition(definition, limits);
  if (!validation.ok) return validation;
  const canonicalDefinition = cloneAndSortDefinition(validation.value);
  const payload = {
    hashSchemaVersion: BOARD_HASH_SCHEMA_VERSION,
    definition: canonicalDefinition,
  };
  return {
    ok: true,
    definition: canonicalDefinition,
    boardHash: sha256Hex(stableStringify(payload)),
    errors: [],
    limits: validation.limits,
  };
}

function isLegacyPoint(point, gridSize, boardShape) {
  const [x, y] = point;
  const radius = gridSize - 1;
  if (x < 0 || y < 0) return false;
  if (boardShape === "hexagon") {
    return x <= 2 * radius && y <= 2 * radius && x + y >= radius && x + y <= 3 * radius;
  }
  return x + y <= radius;
}

function legacyVertexId(x, y) {
  return "v:" + x + "," + y;
}

export function createLegacyBoardDefinition({
  gridSize = 5,
  boardShape = "triangle",
} = {}) {
  if (!Number.isInteger(gridSize) || gridSize < 3 || !["triangle", "hexagon"].includes(boardShape)) {
    throw new Error("Legacy board adapter requires gridSize >= 3 and triangle or hexagon.");
  }
  const radius = gridSize - 1;
  const extent = boardShape === "hexagon" ? 2 * radius : radius;
  const vertices = [];
  for (let y = 0; y <= extent; y += 1) {
    for (let x = 0; x <= extent; x += 1) {
      if (isLegacyPoint([x, y], gridSize, boardShape)) {
        vertices.push({ id: legacyVertexId(x, y), coordinate: [x, y] });
      }
    }
  }
  const faces = [];
  const addFace = (id, coordinates) => {
    if (coordinates.every((point) => isLegacyPoint(point, gridSize, boardShape))) {
      faces.push({ id, vertices: coordinates.map(([x, y]) => legacyVertexId(x, y)) });
    }
  };
  for (let y = 0; y < extent; y += 1) {
    for (let x = 0; x < extent; x += 1) {
      addFace("u:" + x + "," + y, [[x, y], [x + 1, y], [x, y + 1]]);
      addFace("d:" + x + "," + y, [[x + 1, y], [x + 1, y + 1], [x, y + 1]]);
    }
  }
  return {
    schemaVersion: BOARD_DEFINITION_SCHEMA_VERSION,
    coordinateSystem: "triangular-axial-v1",
    topology: {
      family: "planar",
      movementStrategy: "simple-rays-v1",
      territoryStrategy: "surface-discrete-v1",
      specialVertexPolicy: "stop",
      preset: "legacy-" + boardShape,
    },
    vertices,
    faces,
    seamPairs: [],
    scoring: { strategy: "canonical-vertices-v1" },
  };
}
