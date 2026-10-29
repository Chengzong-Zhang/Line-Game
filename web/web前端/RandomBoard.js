import { generateRandomSurfaceBoard } from "./RandomSurfaceBoard.js?v=20261029-unified-r1";

const GENERATOR_VERSION = "random-board-v4";
const V3_GENERATOR_VERSION = "random-board-v3";
const LEGACY_GENERATOR_VERSION = "random-board-v1";
const PREVIOUS_GENERATOR_VERSION = "random-board-v2";
const PLAYER_ORDER = Object.freeze(["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"]);

const error = (code, location, detail) => ({ code, location, detail });
const vertexId = (x, y) => "v:" + x + "," + y;
const coordinateKey = (x, y) => x + "," + y;
const edgeKey = (left, right) => left < right ? left + "|" + right : right + "|" + left;

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function hashSeed(seed) {
  const text = typeof seed === "number" ? String(seed) : seed;
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function createPrng(seed) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function normalizeOptions(options = {}) {
  const source = options && typeof options === "object" && !Array.isArray(options) ? options : null;
  if (!source) {
    return { errors: [error("INVALID_OPTIONS", "options", "options must be an object")] };
  }
  const width = source.width ?? (source.gridSize == null ? 7 : source.gridSize - 1);
  const height = source.height ?? (source.gridSize == null ? 6 : source.gridSize - 1);
  const playerCount = source.playerCount ?? 2;
  const roughness = source.roughness ?? 0.45;
  const minimumChannelWidth = source.minimumChannelWidth ?? 2;
  const minStartDistance = source.minStartDistance ?? 2;
  const maxAttempts = source.maxAttempts ?? 24;
  const symmetry = source.symmetry ?? "none";
  const errors = [];

  if (source.gridSize != null && !isIntegerInRange(source.gridSize, 5, 15)) {
    errors.push(error("INVALID_GRID_SIZE", "options.gridSize", "gridSize must be an integer from 5 through 15"));
  }
  if (!isIntegerInRange(width, 2, 48)) {
    errors.push(error("INVALID_WIDTH", "options.width", "width must be an integer from 2 through 48"));
  }
  if (!isIntegerInRange(height, 2, 48)) {
    errors.push(error("INVALID_HEIGHT", "options.height", "height must be an integer from 2 through 48"));
  }
  if (!isIntegerInRange(playerCount, 2, PLAYER_ORDER.length)) {
    errors.push(error("INVALID_PLAYER_COUNT", "options.playerCount", "playerCount must be an integer from 2 through 6"));
  }
  if (typeof roughness !== "number" || !Number.isFinite(roughness) || roughness < 0 || roughness > 1) {
    errors.push(error("INVALID_ROUGHNESS", "options.roughness", "roughness must be a finite number from 0 through 1"));
  }
  if (!Number.isInteger(minimumChannelWidth) || minimumChannelWidth < 1) {
    errors.push(error("INVALID_MINIMUM_CHANNEL_WIDTH", "options.minimumChannelWidth", "minimumChannelWidth must be a positive integer"));
  }
  if (!Number.isInteger(minStartDistance) || minStartDistance < 1) {
    errors.push(error("INVALID_MIN_START_DISTANCE", "options.minStartDistance", "minStartDistance must be a positive integer"));
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 256) {
    errors.push(error("INVALID_MAX_ATTEMPTS", "options.maxAttempts", "maxAttempts must be an integer from 0 through 256"));
  }
  if (!["none", "mirror"].includes(symmetry)) {
    errors.push(error("INVALID_SYMMETRY", "options.symmetry", "symmetry must be none or mirror"));
  }
  if (errors.length) return { errors };
  if (minimumChannelWidth > height) {
    return { errors: [error("IMPOSSIBLE_CONSTRAINT", "options.minimumChannelWidth", "minimumChannelWidth exceeds height")] };
  }

  const minArea = source.minArea ?? width * minimumChannelWidth;
  const maxArea = source.maxArea ?? width * height;
  if (!Number.isInteger(minArea) || minArea < 1) {
    errors.push(error("INVALID_MIN_AREA", "options.minArea", "minArea must be a positive integer"));
  }
  if (!Number.isInteger(maxArea) || maxArea < 1) {
    errors.push(error("INVALID_MAX_AREA", "options.maxArea", "maxArea must be a positive integer"));
  }
  if (!errors.length && minArea > maxArea) {
    errors.push(error("IMPOSSIBLE_CONSTRAINT", "options", "minArea cannot exceed maxArea"));
  }
  if (errors.length) return { errors };

  return {
    value: Object.freeze({
      width,
      height,
      playerCount,
      roughness,
      minimumChannelWidth,
      minStartDistance,
      minArea,
      maxArea,
      maxAttempts,
      symmetry,
    }),
  };
}

function generateHeightProfile(options, random) {
  const span = options.height - options.minimumChannelWidth;
  const maxStep = options.roughness === 0 ? 0 : Math.max(1, Math.ceil(options.roughness * 3));
  const chooseHeight = () => options.minimumChannelWidth + Math.floor(random() * (span + 1));
  const profile = new Array(options.width);
  const halfLength = options.symmetry === "mirror" ? Math.ceil(options.width / 2) : options.width;
  let current = chooseHeight();
  for (let column = 0; column < halfLength; column += 1) {
    if (column > 0 && maxStep > 0 && random() < options.roughness) {
      const delta = 1 + Math.floor(random() * maxStep);
      current += random() < 0.5 ? -delta : delta;
      current = Math.max(options.minimumChannelWidth, Math.min(options.height, current));
    }
    profile[column] = current;
  }
  if (options.symmetry === "mirror") {
    for (let column = 0; column < Math.floor(options.width / 2); column += 1) {
      profile[options.width - 1 - column] = profile[column];
    }
  }
  return profile;
}

function makeFaces(profile) {
  const faces = [];
  const usedCoordinates = new Set();
  const addFace = (id, coordinates) => {
    const vertices = coordinates.map(([x, y]) => vertexId(x, y));
    faces.push({ id, vertices });
    for (const [x, y] of coordinates) usedCoordinates.add(coordinateKey(x, y));
  };
  for (let x = 0; x < profile.length; x += 1) {
    for (let y = 0; y < profile[x]; y += 1) {
      addFace("u:" + x + "," + y, [[x, y], [x + 1, y], [x, y + 1]]);
      addFace("d:" + x + "," + y, [[x + 1, y], [x + 1, y + 1], [x, y + 1]]);
    }
  }
  const vertices = [...usedCoordinates].map((key) => key.split(",").map(Number))
    .sort(([leftX, leftY], [rightX, rightY]) => leftY - rightY || leftX - rightX)
    .map(([x, y]) => ({ id: vertexId(x, y), coordinate: [x, y] }));
  return { vertices, faces };
}

function collectBoundaryVertexIds(faces) {
  const occurrences = new Map();
  for (const face of faces) {
    for (let index = 0; index < face.vertices.length; index += 1) {
      const left = face.vertices[index];
      const right = face.vertices[(index + 1) % face.vertices.length];
      const key = edgeKey(left, right);
      const list = occurrences.get(key) ?? [];
      list.push([left, right]);
      occurrences.set(key, list);
    }
  }
  const ids = new Set();
  for (const list of occurrences.values()) {
    if (list.length !== 1) continue;
    ids.add(list[0][0]);
    ids.add(list[0][1]);
  }
  return [...ids].sort();
}

function axialDistance(left, right) {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
}

function chooseStartingVertices(vertices, faces, options, random) {
  const byId = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  const candidates = collectBoundaryVertexIds(faces);
  if (candidates.length < options.playerCount) return null;
  const selected = [candidates[Math.floor(random() * candidates.length)]];
  while (selected.length < options.playerCount) {
    let bestId = null;
    let bestDistance = -1;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const candidateCoordinate = byId.get(candidate).coordinate;
      const distance = Math.min(...selected.map((id) =>
        axialDistance(candidateCoordinate, byId.get(id).coordinate),
      ));
      if (distance > bestDistance || (distance === bestDistance && candidate < bestId)) {
        bestId = candidate;
        bestDistance = distance;
      }
    }
    if (bestId == null || bestDistance < options.minStartDistance) return null;
    selected.push(bestId);
  }
  return Object.fromEntries(PLAYER_ORDER.slice(0, options.playerCount).map((player, index) => [
    player,
    selected[index],
  ]));
}

function buildDefinition(profile, options, seed, generatorVersion, attempt) {
  const { vertices, faces } = makeFaces(profile);
  const randomForStarts = createPrng(String(seed) + ":starts:" + attempt);
  const startingVertices = chooseStartingVertices(vertices, faces, options, randomForStarts);
  if (!startingVertices) return null;
  const area = profile.reduce((total, height) => total + height, 0);
  const boundaryVertexIds = collectBoundaryVertexIds(faces);
  return {
    definition: {
      schemaVersion: 1,
      coordinateSystem: "triangular-axial-v1",
      topology: {
        family: "planar",
        movementStrategy: generatorVersion === LEGACY_GENERATOR_VERSION ? "simple-rays-v1"
          : generatorVersion === PREVIOUS_GENERATOR_VERSION ? "simple-rays-v2" : "simple-rays-v3",
        territoryStrategy: "surface-discrete-v1",
        specialVertexPolicy: "stop",
      },
      vertices,
      faces,
      seamPairs: [],
      startingVertices,
      scoring: { strategy: "canonical-vertices-v1" },
      generator: {
        generatorVersion,
        seed,
        attempt,
        options: { ...options },
        profile: [...profile],
      },
    },
    stats: {
      attempts: attempt,
      area,
      cells: area,
      vertices: vertices.length,
      faces: faces.length,
      boundaryVertexCount: boundaryVertexIds.length,
      minimumColumnHeight: Math.min(...profile),
      profile: [...profile],
      symmetry: options.symmetry,
    },
  };
}

/**
 * Generate a deterministic, simply connected union of triangular-grid rhombi.
 * The output is a complete BoardDefinition draft; opening a match remains the
 * caller's responsibility.
 */
export function generateBoard(options = {}, seed = "default", generatorVersion = GENERATOR_VERSION) {
  if (![LEGACY_GENERATOR_VERSION, PREVIOUS_GENERATOR_VERSION, V3_GENERATOR_VERSION, GENERATOR_VERSION].includes(generatorVersion)) {
    return {
      ok: false,
      stats: { attempts: 0 },
      errors: [error("UNSUPPORTED_GENERATOR_VERSION", "generatorVersion", "expected random-board-v1 through random-board-v4")],
    };
  }
  if (!(typeof seed === "string" && seed.length > 0) && !(typeof seed === "number" && Number.isSafeInteger(seed))) {
    return {
      ok: false,
      stats: { attempts: 0 },
      errors: [error("INVALID_SEED", "seed", "seed must be a non-empty string or a safe integer")],
    };
  }
  if (generatorVersion === GENERATOR_VERSION) return generateRandomSurfaceBoard(options, seed, createPrng);
  const normalized = normalizeOptions(options);
  if (normalized.errors) {
    return { ok: false, stats: { attempts: 0 }, errors: normalized.errors };
  }
  const settings = normalized.value;
  if (settings.maxAttempts === 0) {
    return {
      ok: false,
      stats: { attempts: 0 },
      errors: [error("ATTEMPT_BUDGET_EXHAUSTED", "options.maxAttempts", "no attempts were permitted")],
    };
  }
  const random = createPrng(String(seed) + ":" + generatorVersion);
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    const profile = generateHeightProfile(settings, random);
    const area = profile.reduce((total, height) => total + height, 0);
    if (area < settings.minArea || area > settings.maxArea) continue;
    const result = buildDefinition(profile, settings, seed, generatorVersion, attempt);
    if (result) return { ok: true, definition: result.definition, stats: result.stats, errors: [] };
  }
  return {
    ok: false,
    stats: { attempts: settings.maxAttempts },
    errors: [error("ATTEMPT_BUDGET_EXHAUSTED", "generator", "no board met the requested constraints")],
  };
}

export const RandomBoardGeneratorVersion = GENERATOR_VERSION;

// Compare shapes independently of face order, winding and generator metadata.
export function randomBoardGeometrySignature(definition) {
  return JSON.stringify((definition?.faces ?? []).map(face => [...face.vertices].sort().join("|")).sort());
}
